package st00bootstrap

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

func TestExecutePersistsCanonicalReceiptAndAdvances(t *testing.T) {
	projectDir, coreDir, born := fixture(t, []string{"app"})
	result, err := Execute(context.Background(), projectDir, coreDir, Options{CreatedAt: "2026-08-26T00:00:01.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Execution != "executed" || result.Receipt.IntentID != born.UUID || result.State.CurrentStage != contract.Stage01 {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Receipt.Checks[4].Evidence, "Go "+runtime.Version()) {
		t.Fatalf("runtime evidence = %q", result.Receipt.Checks[4].Evidence)
	}
	content, err := os.ReadFile(ReceiptPath(born.RecordDir))
	if err != nil || !strings.HasSuffix(string(content), "\n") {
		t.Fatalf("receipt = %q, %v", content, err)
	}
	if _, _, err := VerifyAt(projectDir, born.RecordDir); err != nil {
		t.Fatal(err)
	}
}

func TestExecuteResumesWithoutDuplicateCompletion(t *testing.T) {
	projectDir, coreDir, born := fixture(t, nil)
	first, err := Execute(context.Background(), projectDir, coreDir, Options{CreatedAt: "2026-08-26T00:00:01.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := state.Read(born.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	reason := "Recovering an interrupted ST-00 route commit."
	snapshot.State.CurrentStage = contract.Stage00
	snapshot.State.Status = state.Parked
	snapshot.State.ParkedReason = &reason
	snapshot.State.UpdatedAt = "2026-08-26T00:00:02.000Z"
	if err := state.Store(context.Background(), projectDir, born.RecordDir, snapshot.State, snapshot.Plan); err != nil {
		t.Fatal(err)
	}
	second, err := Execute(context.Background(), projectDir, coreDir, Options{CreatedAt: "2026-08-26T00:00:03.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	if second.Execution != "reused" || second.Reference != first.Reference {
		t.Fatalf("second = %+v", second)
	}
	entries, err := audit.ReadOrdered(born.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if entry.Event == string(audit.StageCompleted) && entry.Fields["Stage"] == "ST-00" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("ST-00 completion count = %d", count)
	}
}

func TestExecuteFailsClosedForTamperAndMissingRepository(t *testing.T) {
	t.Run("policy tamper", func(t *testing.T) {
		projectDir, coreDir, born := fixture(t, nil)
		content, err := os.ReadFile(born.PolicyPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(born.PolicyPath, append(content, ' '), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Execute(context.Background(), projectDir, coreDir, Options{}); err == nil || !strings.Contains(strings.ToLower(err.Error()), "sha256") {
			t.Fatalf("Execute error = %v", err)
		}
		if _, err := os.Stat(ReceiptPath(born.RecordDir)); !os.IsNotExist(err) {
			t.Fatalf("Receipt exists after failure: %v", err)
		}
	})
	t.Run("missing repository", func(t *testing.T) {
		projectDir, coreDir, born := fixture(t, []string{"missing-app"})
		if _, err := Execute(context.Background(), projectDir, coreDir, Options{}); err == nil || !strings.Contains(err.Error(), "Repository root does not exist") {
			t.Fatalf("Execute error = %v", err)
		}
		if _, err := os.Stat(ReceiptPath(born.RecordDir)); !os.IsNotExist(err) {
			t.Fatalf("Receipt exists after failure: %v", err)
		}
	})
}

func TestDecodeReceiptRejectsUnknownFieldsAndCheckReordering(t *testing.T) {
	projectDir, coreDir, _ := fixture(t, nil)
	result, err := Execute(context.Background(), projectDir, coreDir, Options{CreatedAt: "2026-08-26T00:00:01.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	content := []byte(`{"schema_version":1,"artifact":"bootstrap-receipt","version":1,"unknown":true}`)
	if _, err := DecodeReceipt(content); err == nil {
		t.Fatal("DecodeReceipt accepted an unknown field")
	}
	result.Receipt.Checks[0], result.Receipt.Checks[4] = result.Receipt.Checks[4], result.Receipt.Checks[0]
	if err := result.Receipt.Validate(); err == nil || !strings.Contains(err.Error(), "fixed check order") {
		t.Fatalf("Validate error = %v", err)
	}
}

func fixture(t *testing.T, repos []string) (string, string, intent.BornWithState) {
	t.Helper()
	projectDir := t.TempDir()
	coreDir := testCoreDir(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(coreDir, "memory")); err != nil {
		t.Fatal(err)
	}
	for _, repository := range repos {
		if repository == "missing-app" {
			continue
		}
		if err := os.MkdirAll(filepath.Join(projectDir, repository), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, coreDir, "bootstrap test", "default", intent.BirthWorkflowOptions{
		Repos: repos,
		Identity: intent.Options{
			Clock: func() time.Time { return time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC) },
			UUID:  func() (string, error) { return "0198e26a-0000-7000-8000-000000000001", nil },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, coreDir, born
}

func testCoreDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "core"))
}
