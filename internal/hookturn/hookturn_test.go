package hookturn

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestObserveWritesEmptyDigestNamedSessionMarker(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	runtimeDir := t.TempDir()
	firstTime := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	input := turnJSON(t, map[string]any{
		"session_id": "session-secret", "turn_id": "turn-secret", "cwd": projectDir,
		"hook_event_name": "UserPromptSubmit", "prompt": "this simple question must not be persisted",
	})
	first, err := Observe(context.Background(), projectDir, strings.NewReader(input), Options{
		RuntimeDir: runtimeDir, Clock: func() time.Time { return firstTime },
	})
	if err != nil {
		t.Fatal(err)
	}
	canonicalRuntime, err := filepath.EvalSymlinks(runtimeDir)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Observed || !strings.HasPrefix(first.MarkerPath, canonicalRuntime+string(filepath.Separator)) {
		t.Fatalf("Observe() = %+v", first)
	}
	content, err := os.ReadFile(first.MarkerPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(content) != 0 || strings.Contains(first.MarkerPath, "secret") || strings.Contains(first.MarkerPath, "question") {
		t.Fatalf("marker path=%q content=%q", first.MarkerPath, content)
	}
	info, err := os.Stat(first.MarkerPath)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(firstTime) || info.Mode().Perm() != 0o600 {
		t.Fatalf("marker info = mode %o, mtime %s", info.Mode().Perm(), info.ModTime())
	}

	secondTime := firstTime.Add(time.Minute)
	second, err := Observe(context.Background(), projectDir, strings.NewReader(turnJSON(t, map[string]any{
		"session_id": "session-secret", "turn_id": "another-turn", "cwd": projectDir,
		"hook_event_name": "UserPromptSubmit", "prompt": "another question",
	})), Options{RuntimeDir: runtimeDir, Clock: func() time.Time { return secondTime }})
	if err != nil {
		t.Fatal(err)
	}
	if second.MarkerPath != first.MarkerPath {
		t.Fatalf("marker path changed: %q != %q", second.MarkerPath, first.MarkerPath)
	}
	info, err = os.Stat(second.MarkerPath)
	if err != nil || !info.ModTime().Equal(secondTime) {
		t.Fatalf("updated marker mtime = %v, %v", info, err)
	}
}

func TestObserveRejectsInvalidBoundaryInput(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	runtimeDir := t.TempDir()
	tests := []struct {
		name    string
		harness string
		value   map[string]any
	}{
		{name: "wrong harness", harness: "other", value: map[string]any{"session_id": "session", "cwd": projectDir, "hook_event_name": "UserPromptSubmit"}},
		{name: "wrong event", value: map[string]any{"session_id": "session", "cwd": projectDir, "hook_event_name": "Stop"}},
		{name: "missing session", value: map[string]any{"cwd": projectDir, "hook_event_name": "UserPromptSubmit"}},
		{name: "outside cwd", value: map[string]any{"session_id": "session", "cwd": t.TempDir(), "hook_event_name": "UserPromptSubmit"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Observe(context.Background(), projectDir, strings.NewReader(turnJSON(t, test.value)), Options{
				Harness: test.harness, RuntimeDir: runtimeDir,
			})
			if err == nil {
				t.Fatal("Observe() accepted invalid input")
			}
		})
	}
}

func TestObserveRejectsSymlinkMarker(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	runtimeDir := t.TempDir()
	input := turnJSON(t, map[string]any{
		"session_id": "session", "cwd": projectDir, "hook_event_name": "UserPromptSubmit",
	})
	observed, err := Observe(context.Background(), projectDir, strings.NewReader(input), Options{RuntimeDir: runtimeDir})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(observed.MarkerPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(t.TempDir(), "target"), observed.MarkerPath); err != nil {
		t.Fatal(err)
	}
	_, err = Observe(context.Background(), projectDir, strings.NewReader(input), Options{RuntimeDir: runtimeDir})
	if err == nil {
		t.Fatal("Observe() accepted a symlink marker")
	}
}

func turnJSON(t *testing.T, value map[string]any) string {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}
