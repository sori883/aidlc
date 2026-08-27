package hooksensor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/sensor"
	"github.com/sori883/aidlc/internal/workspace"
)

func TestObserveFiresMatchingPostToolUseSensors(t *testing.T) {
	projectDir, born := hookSensorFixture(t)
	if err := os.WriteFile(filepath.Join(projectDir, "main.go"), []byte("package   main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := Observe(context.Background(), projectDir, strings.NewReader(sensorJSON(t, projectDir, "tool-1", "*** Begin Patch\n*** Add File: main.go\n+package   main\n*** End Patch")), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Observed || result.Stage != "ST-00" || result.Matched != 1 || result.Fired != 1 || result.Failed != 1 || result.Deduplicated != 0 {
		t.Fatalf("Observe() = %#v", result)
	}
	status, err := sensor.Inspect(born.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Entries) != 1 || len(status.Observations) != 1 || status.Observations[0].Matched != 1 || status.Observations[0].Fired != 1 {
		t.Fatalf("Sensor status = %#v", status)
	}
}

func TestObserveRecordsNoMatchAndDeduplicates(t *testing.T) {
	projectDir, born := hookSensorFixture(t)
	if err := os.WriteFile(filepath.Join(projectDir, "README.md"), []byte("readme\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	noMatch, err := Observe(context.Background(), projectDir, strings.NewReader(sensorJSON(t, projectDir, "tool-readme", "*** Begin Patch\n*** Add File: README.md\n+readme\n*** End Patch")), Options{})
	if err != nil || noMatch.Matched != 0 || noMatch.Fired != 0 {
		t.Fatalf("no-match = %#v, err=%v", noMatch, err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "value.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	payload := sensorJSON(t, projectDir, "tool-json", "*** Begin Patch\n*** Add File: value.json\n+{}\n*** End Patch")
	first, err := Observe(context.Background(), projectDir, strings.NewReader(payload), Options{})
	if err != nil || first.Fired != 1 {
		t.Fatalf("first = %#v, err=%v", first, err)
	}
	second, err := Observe(context.Background(), projectDir, strings.NewReader(payload), Options{})
	if err != nil || second.Fired != 0 || second.Deduplicated != 1 {
		t.Fatalf("second = %#v, err=%v", second, err)
	}
	status, err := sensor.Inspect(born.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Observations) != 1 || status.Observations[0].ObservationID != "tool-json" {
		t.Fatalf("status = %#v", status)
	}
}

func TestObserveSkipsDeletedMatchingFile(t *testing.T) {
	projectDir, born := hookSensorFixture(t)
	result, err := Observe(context.Background(), projectDir, strings.NewReader(sensorJSON(t, projectDir, "tool-delete", "*** Begin Patch\n*** Delete File: removed.json\n*** End Patch")), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Matched != 1 || result.Fired != 0 || result.Failed != 0 {
		t.Fatalf("Observe() = %#v", result)
	}
	status, err := sensor.Inspect(born.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Entries) != 0 || len(status.Observations) != 1 {
		t.Fatalf("status = %#v", status)
	}
}

func TestObserveRejectsWrongEventAndPathEscape(t *testing.T) {
	projectDir, _ := hookSensorFixture(t)
	wrong := strings.Replace(sensorJSON(t, projectDir, "tool-wrong", "*** Begin Patch\n*** Add File: value.json\n+{}\n*** End Patch"), "PostToolUse", "PreToolUse", 1)
	if _, err := Observe(context.Background(), projectDir, strings.NewReader(wrong), Options{}); err == nil {
		t.Fatal("wrong event unexpectedly accepted")
	}
	escape := sensorJSON(t, projectDir, "tool-escape", "*** Begin Patch\n*** Add File: ../outside.json\n+{}\n*** End Patch")
	if _, err := Observe(context.Background(), projectDir, strings.NewReader(escape), Options{}); err == nil {
		t.Fatal("path escape unexpectedly accepted")
	}
}

func TestObserveWithoutActiveIntentIsNoOp(t *testing.T) {
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(root, "core", "memory")); err != nil {
		t.Fatal(err)
	}
	result, err := Observe(context.Background(), projectDir, strings.NewReader(sensorJSON(t, projectDir, "tool-empty", "*** Begin Patch\n*** Add File: value.json\n+{}\n*** End Patch")), Options{})
	if err != nil || !result.Observed || result.Stage != "" || result.Fired != 0 {
		t.Fatalf("Observe() = %#v, err=%v", result, err)
	}
}

func hookSensorFixture(t *testing.T) (string, intent.BornWithState) {
	t.Helper()
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(root, "core", "memory")); err != nil {
		t.Fatal(err)
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, filepath.Join(root, "core"), "Sensor Hook", "default", intent.BirthWorkflowOptions{Identity: intent.Options{
		Clock: func() time.Time { return time.Date(2026, 8, 28, 0, 0, 0, 0, time.UTC) },
		UUID:  func() (string, error) { return "0198ed00-0000-7000-8000-000000000001", nil },
	}})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, born
}

func sensorJSON(t *testing.T, cwd, toolUseID, command string) string {
	t.Helper()
	content, err := json.Marshal(map[string]any{
		"session_id": "thr-sensor", "turn_id": "turn-sensor", "cwd": cwd,
		"hook_event_name": "PostToolUse", "tool_name": "apply_patch", "tool_use_id": toolUseID,
		"tool_input": map[string]any{"command": command},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}
