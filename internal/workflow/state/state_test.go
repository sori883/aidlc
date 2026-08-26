package state

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/risk"
)

func TestInitializeReadAndValidate(t *testing.T) {
	t.Parallel()
	projectDir, recordDir, policyRef := stateFixture(t)
	plan, err := workflowplan.Initial("intent-1", "vnext-graph-1", policyRef)
	if err != nil {
		t.Fatal(err)
	}
	initialized, err := Initialize(context.Background(), projectDir, recordDir, InitializeOptions{IntentID: "intent-1", CatalogVersion: "vnext-catalog-1", GraphVersion: "vnext-graph-1", PolicySnapshot: policyRef, Plan: plan, CreatedAt: "2026-08-25T00:00:00.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	if initialized.State.CurrentStage != contract.Stage00 || initialized.State.Status != Parked {
		t.Fatalf("state = %+v", initialized.State)
	}
	if err := Validate(projectDir, recordDir); err != nil {
		t.Fatal(err)
	}
	summary, err := os.ReadFile(SummaryPath(recordDir))
	if err != nil || !strings.Contains(string(summary), "> ST-00: execute") {
		t.Fatalf("summary = %q, %v", summary, err)
	}
}

func TestDecodeRejectsAIPersistedDecisionAuthority(t *testing.T) {
	t.Parallel()
	_, _, policyRef := stateFixture(t)
	plan, err := workflowplan.Initial("intent-1", "vnext-graph-1", policyRef)
	if err != nil {
		t.Fatal(err)
	}
	plan.StageDecisions[0].DecisionAuthority = "ai"
	if err := plan.Validate(); err == nil {
		t.Fatal("Plan accepted AI decision authority")
	}
}

func TestDecodeRejectsExplicitNullOptionalFields(t *testing.T) {
	t.Parallel()
	content := []byte(`{"schema_version":1,"workflow":"vnext","intent_id":"intent-1","catalog_version":"catalog-1","graph_version":"graph-1","plan_revision":1,"policy_snapshot":{"artifact":"effective-policy","version":1,"source_of_truth":"policy.json","sha256":"sha256:` + strings.Repeat("a", 64) + `"},"current_stage":"ST-00","status":"parked","parked_reason":null,"created_at":"2026-08-25T00:00:00.000Z","updated_at":"2026-08-25T00:00:00.000Z"}`)
	if _, err := Decode(content); err == nil {
		t.Fatal("Decode() accepted explicit null parked_reason")
	}
}

func TestStoreRejectsMismatchedPlanBeforeWrite(t *testing.T) {
	t.Parallel()
	projectDir, recordDir, policyRef := stateFixture(t)
	plan, err := workflowplan.Initial("intent-1", "vnext-graph-1", policyRef)
	if err != nil {
		t.Fatal(err)
	}
	initialized, err := Initialize(context.Background(), projectDir, recordDir, InitializeOptions{IntentID: "intent-1", CatalogVersion: "vnext-catalog-1", GraphVersion: "vnext-graph-1", PolicySnapshot: policyRef, Plan: plan, CreatedAt: "2026-08-25T00:00:00.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(StatePath(recordDir))
	if err != nil {
		t.Fatal(err)
	}
	bad := initialized.State
	bad.PlanRevision = 2
	if err := Store(context.Background(), projectDir, recordDir, bad, plan); err == nil {
		t.Fatal("Store() accepted mismatched revision")
	}
	after, err := os.ReadFile(StatePath(recordDir))
	if err != nil || string(after) != string(before) {
		t.Fatal("Store() changed State after validation failure")
	}
}

func stateFixture(t *testing.T) (string, string, contract.ArtifactReference) {
	t.Helper()
	projectDir := t.TempDir()
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "intent-1")
	if err := os.MkdirAll(filepath.Join(recordDir, "artifacts"), 0o755); err != nil {
		t.Fatal(err)
	}
	policyContent := []byte("{}\n")
	policyPath := filepath.Join(recordDir, "effective-policy-r1.json")
	if err := os.WriteFile(policyPath, policyContent, 0o644); err != nil {
		t.Fatal(err)
	}
	policyRef := contract.ArtifactReference{Artifact: "effective-policy", Version: 1, SourceOfTruth: "aidlc/spaces/default/intents/intent-1/effective-policy-r1.json", SHA256: digest.Bytes(policyContent)}
	if _, err := risk.Initialize(context.Background(), projectDir, recordDir, "intent-1", risk.Options{CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir, policyRef
}
