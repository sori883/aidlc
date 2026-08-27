package hookaudit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/workspace"
)

func TestRecordWritesRedactedApplyPatchMetadata(t *testing.T) {
	t.Parallel()
	projectDir, born := hookFixture(t)
	input := hookJSON(t, map[string]any{
		"session_id":      "thr-001",
		"turn_id":         "turn-001",
		"cwd":             projectDir,
		"hook_event_name": "PostToolUse",
		"tool_name":       "apply_patch",
		"tool_use_id":     "call-001",
		"prompt":          "SECRET PROMPT",
		"tool_input": map[string]any{
			"command": "*** Begin Patch\n*** Add File: src/new.go\n+SECRET PATCH\n*** Update File: ../outside.txt\n*** Delete File: /tmp/private.txt\n*** End Patch",
		},
		"tool_response": map[string]any{"output": "SECRET TOOL OUTPUT"},
	})
	clock := func() time.Time { return time.Date(2026, 8, 27, 1, 2, 3, 456789000, time.UTC) }
	result, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{Harness: "codex", Clock: clock})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Recorded || result.Sequence != 1 || result.Kind != ToolAfter {
		t.Fatalf("result = %+v", result)
	}
	content, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"SECRET PROMPT", "SECRET PATCH", "SECRET TOOL OUTPUT", "/tmp/private.txt", "../outside.txt"} {
		if strings.Contains(string(content), secret) {
			t.Fatalf("Hook Journal leaked %q: %s", secret, content)
		}
	}
	var entry Entry
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(content))), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.Timestamp != "2026-08-27T01:02:03.456Z" || entry.IntentID != born.UUID || entry.Stage != "ST-00" || entry.StateStatus != "parked" {
		t.Fatalf("entry identity = %+v", entry)
	}
	if len(entry.Paths) != 1 || entry.Paths[0] != "src/new.go" || entry.ExcludedPathCount != 2 || entry.Redaction != RedactionPolicy {
		t.Fatalf("entry paths/redaction = %+v", entry)
	}

	status, err := Inspect(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Active || status.Entries != 1 || status.UniqueEvents != 1 || status.DuplicateEvents != 0 || status.Latest == nil || status.Latest.EventID != result.EventID {
		t.Fatalf("status = %+v", status)
	}
}

func TestRecordSuppressesStableDuplicateDelivery(t *testing.T) {
	t.Parallel()
	projectDir, _ := hookFixture(t)
	input := hookJSON(t, map[string]any{
		"session_id": "thr-duplicate", "turn_id": "turn-duplicate",
		"cwd": projectDir, "hook_event_name": "PreToolUse",
		"tool_name": "Bash", "tool_use_id": "call-duplicate",
		"tool_input": map[string]any{"command": "do not persist me"},
	})
	first, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Recorded || second.Recorded || second.Reason != "duplicate_delivery" || first.EventID != second.EventID {
		t.Fatalf("first = %+v, second = %+v", first, second)
	}
	status, err := Inspect(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if status.Entries != 1 || status.UniqueEvents != 1 {
		t.Fatalf("status = %+v", status)
	}
}

func TestCompactSessionStartRemainsObservable(t *testing.T) {
	t.Parallel()
	projectDir, _ := hookFixture(t)
	input := hookJSON(t, map[string]any{
		"session_id": "thr-compact", "cwd": projectDir,
		"hook_event_name": "SessionStart", "source": "compact",
	})
	first, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Recorded || !second.Recorded || first.EventID == second.EventID {
		t.Fatalf("first = %+v, second = %+v", first, second)
	}
}

func TestRecordWithoutActiveIntentIsNoOp(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	if _, err := workspace.Initialize(projectDir, filepath.Join(repositoryRoot(t), "core", "memory")); err != nil {
		t.Fatal(err)
	}
	input := hookJSON(t, map[string]any{
		"session_id": "thr-unbound", "cwd": projectDir,
		"hook_event_name": "SessionStart", "source": "startup",
	})
	result, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Recorded || result.Reason != "no_active_vnext_intent" {
		t.Fatalf("result = %+v", result)
	}
}

func TestRecordRejectsOutsideCWDAndUnsupportedEvent(t *testing.T) {
	t.Parallel()
	projectDir, _ := hookFixture(t)
	tests := []map[string]any{
		{"session_id": "thr-outside", "cwd": t.TempDir(), "hook_event_name": "SessionStart", "source": "startup"},
		{"session_id": "thr-unknown", "cwd": projectDir, "hook_event_name": "UnknownEvent"},
		{"session_id": "thr-human", "turn_id": "turn-human", "cwd": projectDir, "hook_event_name": "UserPromptSubmit"},
	}
	for _, value := range tests {
		if _, err := Record(context.Background(), projectDir, strings.NewReader(hookJSON(t, value)), RecordOptions{}); err == nil {
			t.Fatalf("Record() accepted invalid input: %+v", value)
		}
	}
}

func TestRecordAcceptsEquivalentSymlinkedCWD(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require Windows developer mode")
	}
	projectDir, _ := hookFixture(t)
	nested := filepath.Join(projectDir, "nested")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "project-alias")
	if err := os.Symlink(projectDir, alias); err != nil {
		t.Fatal(err)
	}
	input := hookJSON(t, map[string]any{
		"session_id": "thr-alias", "cwd": filepath.Join(alias, "nested"),
		"hook_event_name": "SessionStart", "source": "startup",
	})
	result, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Recorded {
		t.Fatalf("result = %+v", result)
	}
}

func TestRecordCoversSupportedCodexLifecycleEvents(t *testing.T) {
	t.Parallel()
	projectDir, _ := hookFixture(t)
	tests := []struct {
		event string
		kind  Kind
		extra map[string]any
	}{
		{event: "SessionStart", kind: SessionStarted, extra: map[string]any{"source": "startup"}},
		{event: "SessionEnd", kind: SessionEnded, extra: map[string]any{"reason": "other"}},
		{event: "SubagentStart", kind: SubagentStarted, extra: map[string]any{"turn_id": "turn-agent-start", "agent_id": "agent-1", "agent_type": "worker"}},
		{event: "SubagentStop", kind: SubagentStopped, extra: map[string]any{"turn_id": "turn-agent-stop", "agent_id": "agent-1", "agent_type": "worker"}},
		{event: "PreToolUse", kind: ToolBefore, extra: map[string]any{"turn_id": "turn-tool-before", "tool_name": "Bash", "tool_use_id": "tool-before"}},
		{event: "PostToolUse", kind: ToolAfter, extra: map[string]any{"turn_id": "turn-tool-after", "tool_name": "Bash", "tool_use_id": "tool-after"}},
		{event: "PermissionRequest", kind: PermissionRequested, extra: map[string]any{"turn_id": "turn-permission", "tool_name": "Bash", "tool_use_id": "tool-permission"}},
		{event: "PreCompact", kind: CompactionStarted, extra: map[string]any{"turn_id": "turn-compact-before", "trigger": "auto"}},
		{event: "PostCompact", kind: CompactionCompleted, extra: map[string]any{"turn_id": "turn-compact-after", "trigger": "auto"}},
		{event: "Stop", kind: StopObserved, extra: map[string]any{"turn_id": "turn-stop"}},
	}
	for index, test := range tests {
		value := map[string]any{
			"session_id": fmt.Sprintf("thr-lifecycle-%d", index),
			"cwd":        projectDir, "hook_event_name": test.event,
		}
		for name, field := range test.extra {
			value[name] = field
		}
		result, err := Record(context.Background(), projectDir, strings.NewReader(hookJSON(t, value)), RecordOptions{})
		if err != nil {
			t.Fatalf("%s: %v", test.event, err)
		}
		if !result.Recorded || result.Kind != test.kind || result.Sequence != index+1 {
			t.Fatalf("%s result = %+v", test.event, result)
		}
	}
}

func TestRecordRejectsSymlinkHookJournal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require Windows developer mode")
	}
	projectDir, born := hookFixture(t)
	outside := t.TempDir()
	journalDir := filepath.Join(born.RecordDir, "hook-audit")
	if err := os.Symlink(outside, journalDir); err != nil {
		t.Fatal(err)
	}
	input := hookJSON(t, map[string]any{
		"session_id": "thr-symlink", "cwd": projectDir,
		"hook_event_name": "SessionStart", "source": "startup",
	})
	if _, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{}); err == nil {
		t.Fatal("Record() followed a Hook Journal directory symlink")
	}
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("outside directory was modified: %v", entries)
	}
}

func TestConcurrentRecordsUseMonotonicCloneSequence(t *testing.T) {
	t.Parallel()
	projectDir, _ := hookFixture(t)
	const count = 6
	errors := make(chan error, count)
	var wait sync.WaitGroup
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			input := hookJSON(t, map[string]any{
				"session_id": "thr-concurrent", "turn_id": fmt.Sprintf("turn-%d", index),
				"cwd": projectDir, "hook_event_name": "PreToolUse",
				"tool_name": "Bash", "tool_use_id": fmt.Sprintf("tool-%d", index),
			})
			_, err := Record(context.Background(), projectDir, strings.NewReader(input), RecordOptions{})
			errors <- err
		}(index)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	status, err := Inspect(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if status.Entries != count || status.UniqueEvents != count {
		t.Fatalf("status = %+v", status)
	}
	entries, err := readEntries(status.JournalDir)
	if err != nil {
		t.Fatal(err)
	}
	sequences := make([]int, 0, len(entries.values))
	for _, entry := range entries.values {
		sequences = append(sequences, entry.Sequence)
	}
	sortInts(sequences)
	for index, sequence := range sequences {
		if sequence != index+1 {
			t.Fatalf("sequences = %v", sequences)
		}
	}
}

func hookFixture(t *testing.T) (string, intent.BornWithState) {
	t.Helper()
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(root, "core", "memory")); err != nil {
		t.Fatal(err)
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, filepath.Join(root, "core"), "Hook Audit", "default", intent.BirthWorkflowOptions{
		Identity: intent.Options{
			Clock: func() time.Time { return time.Date(2026, 8, 27, 0, 0, 0, 0, time.UTC) },
			UUID:  func() (string, error) { return "0198e7d0-0000-7000-8000-000000000001", nil },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, born
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}

func hookJSON(t *testing.T, value map[string]any) string {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func sortInts(values []int) {
	for left := 0; left < len(values); left++ {
		for right := left + 1; right < len(values); right++ {
			if values[right] < values[left] {
				values[left], values[right] = values[right], values[left]
			}
		}
	}
}
