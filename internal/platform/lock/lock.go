// Package lock implements the cross-process AI-DLC Workspace lock.
package lock

import (
	"context"
	"crypto/md5" // Compatibility-only lock identity; not a security digest.
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const (
	workspaceSentinel = "__workspace__"
	defaultStale      = 10 * time.Minute
	unstampedGrace    = 5 * time.Second
)

// Options controls bounded acquisition retries.
type Options struct {
	MaxRetries int
	NoRetry    bool
	Retry      time.Duration
	Stale      time.Duration
}

// Handle proves ownership of one lock directory.
type Handle struct {
	Dir   string
	Token string
}

type owner struct {
	PID          int    `json:"pid"`
	AcquiredAtMS int64  `json:"acquiredAtMs"`
	Token        string `json:"token"`
}

type contextKey struct{}

type held struct {
	identity string
	handle   Handle
}

// Dir returns the stable cross-platform lock path.
func Dir(projectDir string) (string, error) {
	absolute, err := filepath.Abs(projectDir)
	if err != nil {
		return "", fmt.Errorf("resolve Project directory: %w", err)
	}
	identity := filepath.Clean(absolute) + "\x00" + workspaceSentinel
	digest := md5.Sum([]byte(identity))
	return filepath.Join(os.TempDir(), ".aidlc-audit-"+hex.EncodeToString(digest[:])[:8]+".lock"), nil
}

// Acquire exclusively creates and stamps the Workspace lock.
func Acquire(ctx context.Context, projectDir string, options Options) (Handle, error) {
	lockDir, err := Dir(projectDir)
	if err != nil {
		return Handle{}, err
	}
	retry := options.Retry
	if retry <= 0 {
		retry = 100 * time.Millisecond
	}
	stale := options.Stale
	if stale <= 0 {
		stale = defaultStale
	}
	maxRetries := options.MaxRetries
	if options.NoRetry {
		maxRetries = 0
	} else if maxRetries == 0 {
		maxRetries = 50
	} else if maxRetries < 0 {
		return Handle{}, fmt.Errorf("lock max retries cannot be negative")
	}
	for attempt := 0; attempt <= maxRetries; attempt++ {
		token, err := randomToken()
		if err != nil {
			return Handle{}, err
		}
		if err := os.Mkdir(lockDir, 0o700); err == nil {
			current := owner{PID: os.Getpid(), AcquiredAtMS: time.Now().UnixMilli(), Token: token}
			content, marshalErr := json.Marshal(current)
			if marshalErr != nil {
				_ = os.Remove(lockDir)
				return Handle{}, marshalErr
			}
			if writeErr := os.WriteFile(filepath.Join(lockDir, "owner.json"), content, 0o600); writeErr != nil {
				_ = os.RemoveAll(lockDir)
				return Handle{}, fmt.Errorf("stamp Workspace lock: %w", writeErr)
			}
			return Handle{Dir: lockDir, Token: token}, nil
		} else if !errors.Is(err, fs.ErrExist) {
			return Handle{}, fmt.Errorf("create Workspace lock: %w", err)
		}
		if reaped, err := tryReap(lockDir, stale); err != nil {
			return Handle{}, err
		} else if reaped {
			continue
		}
		if attempt < maxRetries {
			timer := time.NewTimer(retry)
			select {
			case <-ctx.Done():
				timer.Stop()
				return Handle{}, fmt.Errorf("acquire Workspace lock: %w", ctx.Err())
			case <-timer.C:
			}
		}
	}
	return Handle{}, fmt.Errorf("failed to acquire workspace lock: %s", lockDir)
}

// Release removes a lock only when its token still matches.
func Release(handle Handle) error {
	current, ok := readOwner(handle.Dir)
	if !ok || current.Token != handle.Token {
		return nil
	}
	if err := os.RemoveAll(handle.Dir); err != nil {
		return fmt.Errorf("release Workspace lock: %w", err)
	}
	return nil
}

// With runs one mutation under the lock. Nested calls are reentrant only when
// they receive the context passed to operation, so unrelated goroutines remain
// serialized by the filesystem lock.
func With(ctx context.Context, projectDir string, options Options, operation func(context.Context) error) (resultErr error) {
	lockDir, err := Dir(projectDir)
	if err != nil {
		return err
	}
	if existing, ok := ctx.Value(contextKey{}).(held); ok && existing.identity == lockDir {
		return operation(ctx)
	}
	handle, err := Acquire(ctx, projectDir, options)
	if err != nil {
		return err
	}
	operationContext := context.WithValue(ctx, contextKey{}, held{identity: lockDir, handle: handle})
	defer func() {
		if releaseErr := Release(handle); resultErr == nil {
			resultErr = releaseErr
		}
	}()
	return operation(operationContext)
}

// Exists reports whether a Workspace lock directory currently exists.
func Exists(projectDir string) bool {
	lockDir, err := Dir(projectDir)
	if err != nil {
		return false
	}
	info, err := os.Stat(lockDir)
	return err == nil && info.IsDir()
}

func randomToken() (string, error) {
	content := make([]byte, 16)
	if _, err := rand.Read(content); err != nil {
		return "", fmt.Errorf("generate lock token: %w", err)
	}
	return hex.EncodeToString(content), nil
}

func readOwner(lockDir string) (owner, bool) {
	content, err := os.ReadFile(filepath.Join(lockDir, "owner.json"))
	if err != nil {
		return owner{}, false
	}
	var value owner
	if err := json.Unmarshal(content, &value); err != nil || value.PID <= 0 || value.AcquiredAtMS <= 0 || value.Token == "" {
		return owner{}, false
	}
	return value, true
}

func tryReap(lockDir string, stale time.Duration) (bool, error) {
	judged, stamped := readOwner(lockDir)
	if stamped {
		if time.Since(time.UnixMilli(judged.AcquiredAtMS)) <= stale {
			return false, nil
		}
	} else {
		info, err := os.Stat(lockDir)
		if err != nil {
			return false, nil
		}
		if time.Since(info.ModTime()) <= unstampedGrace {
			return false, nil
		}
	}
	token, err := randomToken()
	if err != nil {
		return false, err
	}
	moved := fmt.Sprintf("%s.dead.%d-%s", lockDir, os.Getpid(), token)
	if err := os.Rename(lockDir, moved); err != nil {
		return false, nil
	}
	movedOwner, movedStamped := readOwner(moved)
	if stamped != movedStamped || (stamped && movedOwner != judged) {
		if err := os.Rename(moved, lockDir); err != nil {
			_ = os.RemoveAll(moved)
		}
		return false, nil
	}
	if err := os.RemoveAll(moved); err != nil {
		return false, fmt.Errorf("remove stale Workspace lock: %w", err)
	}
	return true, nil
}
