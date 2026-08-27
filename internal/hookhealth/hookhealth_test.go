package hookhealth

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/workspace"
)

func TestRecordSeparatesHandlerEventAndOutcome(t *testing.T) {
	projectDir, recordDir := healthFixture(t)
	clock := func() time.Time { return time.Date(2026, 8, 28, 4, 5, 6, 0, time.UTC) }
	if err := Record(context.Background(), projectDir, Observation{Handler: "sensor", SourceEvent: "PostToolUse", Succeeded: true, Outcome: "no-match", Clock: clock}); err != nil {
		t.Fatal(err)
	}
	if err := Record(context.Background(), projectDir, Observation{Handler: "sensor", SourceEvent: "PostToolUse", Succeeded: false, Outcome: "handler-failed", FailureCode: "invalid-input", Clock: clock}); err != nil {
		t.Fatal(err)
	}
	if err := Record(context.Background(), projectDir, Observation{Handler: "audit", SourceEvent: "PostToolUse", Succeeded: true, Outcome: "recorded", Clock: clock}); err != nil {
		t.Fatal(err)
	}
	status, err := Inspect(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Present || len(status.Entries) != 2 {
		t.Fatalf("Inspect() = %#v", status)
	}
	sensor := status.Entries[1]
	if sensor.Handler != "sensor" || sensor.Invocations != 2 || sensor.Successes != 1 || sensor.Failures != 1 || sensor.LastFailureCode != "invalid-input" {
		t.Fatalf("Sensor entry = %#v", sensor)
	}
}

func TestConcurrentRecordPreservesCounts(t *testing.T) {
	projectDir, recordDir := healthFixture(t)
	const count = 8
	var wait sync.WaitGroup
	errors := make(chan error, count)
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			errors <- Record(context.Background(), projectDir, Observation{Handler: "guard", SourceEvent: "PreToolUse", Succeeded: true, Outcome: "allowed"})
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	status, err := Inspect(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Entries) != 1 || status.Entries[0].Invocations != count || status.Entries[0].Successes != count {
		t.Fatalf("Inspect() = %#v", status)
	}
}

func TestInspectRejectsTamperedLedger(t *testing.T) {
	projectDir, recordDir := healthFixture(t)
	if err := Record(context.Background(), projectDir, Observation{Handler: "context", SourceEvent: "SessionStart", Succeeded: true, Outcome: "injected"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(recordDir), []byte(`{"schema_version":1,"entries":{}} trailing`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(recordDir); err == nil {
		t.Fatal("tampered ledger unexpectedly accepted")
	}
}

func TestInspectRejectsSymlinkedLedger(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is not generally available on Windows")
	}
	projectDir, recordDir := healthFixture(t)
	if err := Record(context.Background(), projectDir, Observation{Handler: "context", SourceEvent: "SessionStart", Succeeded: true, Outcome: "injected"}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(Path(recordDir))
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "current.json")
	if err := os.WriteFile(outside, content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(Path(recordDir)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, Path(recordDir)); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(recordDir); err == nil {
		t.Fatal("symlinked Hook health ledger unexpectedly accepted")
	}
}

func TestNoActiveIntentIsNoop(t *testing.T) {
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(root, "core", "memory")); err != nil {
		t.Fatal(err)
	}
	if err := Record(context.Background(), projectDir, Observation{Handler: "audit", SourceEvent: "SessionStart", Succeeded: true, Outcome: "recorded"}); err != nil {
		t.Fatal(err)
	}
}

func healthFixture(t *testing.T) (string, string) {
	t.Helper()
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	coreDir := filepath.Join(root, "core")
	if _, err := workspace.Initialize(projectDir, filepath.Join(coreDir, "memory")); err != nil {
		t.Fatal(err)
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, coreDir, "Hook Health", "default", intent.BirthWorkflowOptions{Identity: intent.Options{
		Clock: func() time.Time { return time.Date(2026, 8, 28, 0, 0, 0, 0, time.UTC) },
		UUID:  func() (string, error) { return "0198ed00-0000-7000-8000-000000000003", nil },
	}})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, born.RecordDir
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}
