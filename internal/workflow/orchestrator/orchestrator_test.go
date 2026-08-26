package orchestrator

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/workflow/directive"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/risk"
	"github.com/sori883/aidlc/internal/workflow/state"
)

func TestUnavailableRuntimeIsParkedByCore(t *testing.T) {
	t.Parallel()
	projectDir := orchestratorFixture(t)
	result, err := Resolve(context.Background(), projectDir, coreDir(t), Registry{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != directive.Parked || result.Stage == nil || *result.Stage != contract.Stage00 || result.DecisionAuthority != "core" {
		t.Fatalf("directive = %+v", result)
	}
}

func TestHandlerCannotInventRoute(t *testing.T) {
	t.Parallel()
	projectDir := orchestratorFixture(t)
	handler := HandlerFunc(func(context.Context, string, state.Snapshot) (directive.Core, error) {
		from, to := contract.Stage00, contract.Stage09
		return directive.Core{SchemaVersion: 1, Kind: directive.Advanced, Workflow: "vnext", Reason: "Invent route.", GraphVersion: "vnext-10-stage-graph-v1", PlanRevision: 1, DecisionAuthority: "core", CompletedStage: &from, Stage: &to, Evidence: []contract.ArtifactReference{evidenceRef(t, projectDir)}}, nil
	})
	if _, err := Resolve(context.Background(), projectDir, coreDir(t), Registry{contract.Stage00: handler}); err == nil {
		t.Fatal("Resolve() accepted an invented route")
	}
}

func orchestratorFixture(t *testing.T) string {
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
	policyRef := evidenceRef(t, projectDir)
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
	return projectDir
}

func evidenceRef(t *testing.T, projectDir string) contract.ArtifactReference {
	t.Helper()
	content := []byte("{}\n")
	path := filepath.Join(projectDir, "aidlc", "policy.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	return contract.ArtifactReference{Artifact: "effective-policy", Version: 1, SourceOfTruth: "aidlc/policy.json", SHA256: digest.Bytes(content)}
}

func coreDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "core"))
}
