package doctor

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/risk"
	"github.com/sori883/aidlc/internal/workflow/state"
)

func TestCheckAndLimitedRepair(t *testing.T) {
	projectDir, recordDir := fixture(t)
	report := Check(projectDir, coreDir(t))
	if !report.Healthy {
		t.Fatalf("healthy report = %+v", report)
	}
	if err := os.WriteFile(state.SummaryPath(recordDir), []byte("stale\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	report = Check(projectDir, coreDir(t))
	if !report.Healthy || !hasCode(report, "VNEXT_STATE_SUMMARY_STALE") {
		t.Fatalf("stale report = %+v", report)
	}
	repaired, err := Repair(context.Background(), projectDir, coreDir(t))
	if err != nil {
		t.Fatal(err)
	}
	if !repaired.Healthy || hasCode(repaired, "VNEXT_STATE_SUMMARY_STALE") {
		t.Fatalf("repaired report = %+v", repaired)
	}
}

func fixture(t *testing.T) (string, string) {
	t.Helper()
	projectDir := t.TempDir()
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "intent-1")
	if err := os.MkdirAll(filepath.Join(recordDir, "artifacts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "aidlc", "active-space"), []byte("default\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "active-intent"), []byte("intent-1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	content := []byte("{}\n")
	if err := os.WriteFile(filepath.Join(projectDir, "aidlc", "policy.json"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	policyRef := contract.ArtifactReference{Artifact: "effective-policy", Version: 1, SourceOfTruth: "aidlc/policy.json", SHA256: digest.Bytes(content)}
	if _, err := risk.Initialize(context.Background(), projectDir, recordDir, "intent-1", risk.Options{CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	plan, err := workflowplan.Initial("intent-1", "vnext-10-stage-graph-v1", policyRef)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := state.Initialize(context.Background(), projectDir, recordDir, state.InitializeOptions{IntentID: "intent-1", CatalogVersion: "vnext-stage-catalog-v1", GraphVersion: "vnext-10-stage-graph-v1", PolicySnapshot: policyRef, Plan: plan, CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if _, err := audit.Append(context.Background(), projectDir, recordDir, audit.WorkflowStarted, []audit.Field{{Name: "Workflow", Value: "vNext"}}, nil); err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir
}

func hasCode(report Report, code string) bool {
	for _, finding := range report.Findings {
		if finding.Code == code {
			return true
		}
	}
	return false
}

func coreDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "core"))
}
