// Package hookturn observes Codex human turns without adding them to the
// persistent Hook Journal.
package hookturn

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/sori883/aidlc/internal/platform/fsx"
)

const maxInputBytes = 1 << 20

// Options controls the Codex adapter and permits isolated runtime paths in
// tests. RuntimeDir defaults to the operating-system temporary directory.
type Options struct {
	Harness    string
	RuntimeDir string
	Clock      func() time.Time
}

// ObserveResult identifies the marker updated for one human turn. The marker
// is an empty, non-audit control file whose path contains digests only.
type ObserveResult struct {
	Observed   bool
	MarkerPath string
}

type codexInput struct {
	SessionID     string `json:"session_id"`
	TurnID        string `json:"turn_id"`
	CWD           string `json:"cwd"`
	HookEventName string `json:"hook_event_name"`
}

// Observe validates one UserPromptSubmit delivery and atomically touches an
// empty session-scoped marker. Prompt text is neither decoded into a field nor
// persisted.
func Observe(_ context.Context, projectDir string, input io.Reader, options Options) (ObserveResult, error) {
	projectRoot, err := realDirectory(projectDir, "Hook project")
	if err != nil {
		return ObserveResult{}, err
	}
	if options.Harness == "" {
		options.Harness = "codex"
	}
	if options.Harness != "codex" {
		return ObserveResult{}, fmt.Errorf("unsupported Human Turn Hook harness: %s", options.Harness)
	}
	delivery, err := decodeCodex(input)
	if err != nil {
		return ObserveResult{}, err
	}
	if delivery.HookEventName != "UserPromptSubmit" {
		return ObserveResult{}, fmt.Errorf("unsupported Human Turn Hook event: %s", delivery.HookEventName)
	}
	if err := validateDelivery(projectRoot, delivery); err != nil {
		return ObserveResult{}, err
	}
	runtimeDir := options.RuntimeDir
	if runtimeDir == "" {
		runtimeDir = os.TempDir()
	}
	runtimeRoot, err := realDirectory(runtimeDir, "Human Turn runtime")
	if err != nil {
		return ObserveResult{}, err
	}
	path, err := markerPath(runtimeRoot, projectRoot, delivery.SessionID)
	if err != nil {
		return ObserveResult{}, err
	}
	if info, statErr := os.Lstat(path); statErr == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return ObserveResult{}, fmt.Errorf("Human Turn marker must be a regular non-symlink file")
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return ObserveResult{}, statErr
	}
	if err := fsx.AtomicWriteFile(path, nil, 0o600); err != nil {
		return ObserveResult{}, fmt.Errorf("write Human Turn marker: %w", err)
	}
	if options.Clock != nil {
		observedAt := options.Clock()
		if err := os.Chtimes(path, observedAt, observedAt); err != nil {
			return ObserveResult{}, fmt.Errorf("timestamp Human Turn marker: %w", err)
		}
	}
	return ObserveResult{Observed: true, MarkerPath: path}, nil
}

func decodeCodex(input io.Reader) (codexInput, error) {
	limited := &io.LimitedReader{R: input, N: maxInputBytes + 1}
	content, err := io.ReadAll(limited)
	if err != nil {
		return codexInput{}, fmt.Errorf("read Codex hook input: %w", err)
	}
	if len(content) == 0 || len(content) > maxInputBytes {
		return codexInput{}, fmt.Errorf("Codex hook input must contain one JSON object no larger than %d bytes", maxInputBytes)
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	var value codexInput
	if err := decoder.Decode(&value); err != nil {
		return codexInput{}, fmt.Errorf("decode Codex hook input: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return codexInput{}, fmt.Errorf("Codex hook input must contain exactly one JSON object")
	}
	return value, nil
}

func validateDelivery(projectRoot string, value codexInput) error {
	for field, text := range map[string]string{"session_id": value.SessionID, "turn_id": value.TurnID} {
		if err := metadata(text, field, 256); err != nil {
			return err
		}
	}
	if value.SessionID == "" {
		return fmt.Errorf("Codex Hook session_id is required")
	}
	if value.CWD == "" {
		return nil
	}
	absolute, err := filepath.Abs(value.CWD)
	if err != nil {
		return err
	}
	absolute, err = filepath.EvalSymlinks(filepath.Clean(absolute))
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(projectRoot, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return fmt.Errorf("Codex Hook cwd is outside the Project")
	}
	return nil
}

func metadata(value, name string, maximum int) error {
	if len(value) > maximum {
		return fmt.Errorf("Codex hook %s is too long", name)
	}
	for _, current := range value {
		if current == '\x00' || current == '\r' || current == '\n' || unicode.IsControl(current) {
			return fmt.Errorf("Codex hook %s contains a control character", name)
		}
	}
	return nil
}

func markerPath(runtimeRoot, projectRoot, sessionID string) (string, error) {
	base := filepath.Join(runtimeRoot, ".aidlc-human-turns")
	if err := ensurePrivateDirectory(base); err != nil {
		return "", err
	}
	projectDigest := sha256.Sum256([]byte(projectRoot))
	projectDirectory := filepath.Join(base, hex.EncodeToString(projectDigest[:]))
	if err := ensurePrivateDirectory(projectDirectory); err != nil {
		return "", err
	}
	sessionDigest := sha256.Sum256([]byte(sessionID))
	return filepath.Join(projectDirectory, hex.EncodeToString(sessionDigest[:])), nil
}

func ensurePrivateDirectory(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !os.IsExist(err) {
		return fmt.Errorf("create Human Turn runtime directory: %w", err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Human Turn runtime path must be a real directory: %s", path)
	}
	return nil
}

func realDirectory(path, label string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	absolute, err = filepath.EvalSymlinks(filepath.Clean(absolute))
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%s must be a real directory", label)
	}
	return absolute, nil
}
