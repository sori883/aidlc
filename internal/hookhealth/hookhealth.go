// Package hookhealth records metadata-only handler heartbeat evidence. It is
// separate from lifecycle Hook Journal rows and from Sensor fire evidence.
package hookhealth

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/workflow/state"
)

const SchemaVersion = 1

var allowedHandlers = map[string]bool{
	"audit": true, "context": true, "guard": true, "human-receipt": true,
	"review-freeze": true, "sensor": true, "subagent": true,
}

var allowedEvents = map[string]bool{
	"SessionStart": true, "SessionEnd": true, "UserPromptSubmit": true,
	"SubagentStart": true, "SubagentStop": true, "PreToolUse": true,
	"PostToolUse": true, "PermissionRequest": true, "PreCompact": true,
	"PostCompact": true, "Stop": true,
}

// Observation is one handler invocation result. It intentionally has no field
// for Hook input, prompts, commands, patches, output, or transcripts.
type Observation struct {
	Handler     string
	SourceEvent string
	Succeeded   bool
	Outcome     string
	FailureCode string
	Clock       func() time.Time
}

// Entry is the current aggregate for one Handler and event pair.
type Entry struct {
	Handler         string `json:"handler"`
	SourceEvent     string `json:"source_event"`
	Invocations     int    `json:"invocations"`
	Successes       int    `json:"successes"`
	Failures        int    `json:"failures"`
	LastOutcome     string `json:"last_outcome"`
	LastFailureCode string `json:"last_failure_code,omitempty"`
	LastObservedAt  string `json:"last_observed_at"`
}

type ledger struct {
	SchemaVersion int              `json:"schema_version"`
	Entries       map[string]Entry `json:"entries"`
}

// Status is the deterministic diagnostic view of the heartbeat ledger.
type Status struct {
	Present bool    `json:"present"`
	Entries []Entry `json:"entries"`
}

// Record appends no authority-bearing evidence; it only updates aggregate
// heartbeat counts for an active vNext Intent.
func Record(ctx context.Context, projectDir string, observation Observation) error {
	if !allowedHandlers[observation.Handler] || !allowedEvents[observation.SourceEvent] {
		return fmt.Errorf("invalid Hook health handler or event")
	}
	if err := bounded(observation.Outcome, "outcome"); err != nil {
		return err
	}
	if observation.FailureCode != "" {
		if err := bounded(observation.FailureCode, "failure code"); err != nil {
			return err
		}
	}
	projectRoot, err := realDirectory(projectDir)
	if err != nil {
		return err
	}
	return lock.With(ctx, projectRoot, lock.Options{MaxRetries: 60, Retry: 25 * time.Millisecond}, func(context.Context) error {
		inspection, inspectErr := state.InspectActive(projectRoot)
		if inspectErr != nil || inspection.Kind != state.InspectionVNext {
			return nil
		}
		value, err := read(inspection.RecordDir)
		if err != nil {
			return err
		}
		key := observation.Handler + "\x00" + observation.SourceEvent
		entry := value.Entries[key]
		entry.Handler = observation.Handler
		entry.SourceEvent = observation.SourceEvent
		entry.Invocations++
		if observation.Succeeded {
			entry.Successes++
			entry.LastFailureCode = ""
		} else {
			entry.Failures++
			entry.LastFailureCode = observation.FailureCode
		}
		entry.LastOutcome = observation.Outcome
		entry.LastObservedAt = iso(now(observation.Clock))
		value.Entries[key] = entry
		return write(inspection.RecordDir, value)
	})
}

// Inspect reads a heartbeat ledger by active Intent record directory.
func Inspect(recordDir string) (Status, error) {
	path := Path(recordDir)
	if _, err := os.Lstat(path); err != nil {
		if os.IsNotExist(err) {
			return Status{Entries: []Entry{}}, nil
		}
		return Status{}, err
	}
	value, err := read(recordDir)
	if err != nil {
		return Status{}, err
	}
	status := Status{Present: true, Entries: make([]Entry, 0, len(value.Entries))}
	for _, entry := range value.Entries {
		status.Entries = append(status.Entries, entry)
	}
	sort.Slice(status.Entries, func(i, j int) bool {
		return status.Entries[i].Handler+"\x00"+status.Entries[i].SourceEvent < status.Entries[j].Handler+"\x00"+status.Entries[j].SourceEvent
	})
	return status, nil
}

// Path returns the current heartbeat ledger path.
func Path(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "hook-health", "current.json")
}

func read(recordDir string) (ledger, error) {
	path := Path(recordDir)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return ledger{SchemaVersion: SchemaVersion, Entries: map[string]Entry{}}, nil
	}
	if err != nil {
		return ledger{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return ledger{}, fmt.Errorf("Hook health ledger must be a regular non-symlink file")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return ledger{}, err
	}
	value, err := jsonx.Decode[ledger](content)
	if err != nil {
		return ledger{}, fmt.Errorf("Hook health ledger: %w", err)
	}
	if value.SchemaVersion != SchemaVersion || value.Entries == nil {
		return ledger{}, fmt.Errorf("Hook health ledger has invalid schema identity")
	}
	for key, entry := range value.Entries {
		if key != entry.Handler+"\x00"+entry.SourceEvent || !allowedHandlers[entry.Handler] || !allowedEvents[entry.SourceEvent] || entry.Invocations < 1 || entry.Successes < 0 || entry.Failures < 0 || entry.Successes+entry.Failures != entry.Invocations {
			return ledger{}, fmt.Errorf("Hook health ledger contains an invalid entry")
		}
	}
	return value, nil
}

func write(recordDir string, value ledger) error {
	if _, err := fsx.EnsureDirUnder(recordDir, "artifacts/hook-health", 0o755); err != nil {
		return err
	}
	content, err := jsonx.MarshalCanonical(value)
	if err != nil {
		return err
	}
	return fsx.AtomicWriteFile(Path(recordDir), content, 0o644)
}

func realDirectory(path string) (string, error) {
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
		return "", fmt.Errorf("Hook health Project must be a real directory")
	}
	return absolute, nil
}

func bounded(value, name string) error {
	if value == "" || len(value) > 128 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("Hook health %s is invalid", name)
	}
	return nil
}

func now(clock func() time.Time) time.Time {
	if clock != nil {
		return clock()
	}
	return time.Now()
}

func iso(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
