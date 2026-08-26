package plan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
)

func TestInitialUsesCoreSafeDefaultForAllStages(t *testing.T) {
	t.Parallel()
	_, policyRef := evidenceFixture(t)
	value, err := Initial("intent-1", "vnext-graph-1", policyRef)
	if err != nil {
		t.Fatal(err)
	}
	if len(value.StageDecisions) != 10 {
		t.Fatalf("stage decisions = %d", len(value.StageDecisions))
	}
	for _, decision := range value.StageDecisions {
		if decision.Disposition != contract.Execute || decision.DecisionAuthority != "core" {
			t.Fatalf("unsafe initial decision = %+v", decision)
		}
	}
}

func TestReviseRejectsUnverifiedAndUndeclaredReuse(t *testing.T) {
	t.Parallel()
	projectDir, policyRef := evidenceFixture(t)
	current, err := Initial("intent-1", "vnext-graph-1", policyRef)
	if err != nil {
		t.Fatal(err)
	}
	evidence := writeEvidence(t, projectDir, "unknown", "artifacts/unknown.json")
	proposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: "p1", StageID: contract.Stage01, Disposition: contract.Reuse, Reason: "Reuse verified work.", Evidence: []contract.ArtifactReference{evidence}, ProposedBy: contract.ProposerAI}
	stageContract := contract.StageContract{SchemaVersion: 1, StageID: contract.Stage01, Name: "Orient", Purpose: "Orient the work.", Inputs: []contract.ArtifactRequirement{}, Outputs: []string{"system-map"}, CompletionCriteria: []string{"Complete."}, StopConditions: []string{"Stop."}, HumanDecisions: []contract.HumanDecisionKind{}, Verifiers: []string{"verify"}}
	if _, err := Revise(current, []contract.StageDispositionProposal{proposal}, RevisionOptions{ProjectDir: projectDir, StageContracts: []contract.StageContract{stageContract}}); err == nil {
		t.Fatal("Revise() accepted undeclared reuse Evidence")
	}
}

func TestRevisePersistsOnlyCoreAuthority(t *testing.T) {
	t.Parallel()
	projectDir, policyRef := evidenceFixture(t)
	current, err := Initial("intent-1", "vnext-graph-1", policyRef)
	if err != nil {
		t.Fatal(err)
	}
	proposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: "p1", StageID: contract.Stage03, Disposition: contract.Execute, Reason: "Requirements changed.", Evidence: []contract.ArtifactReference{}, ProposedBy: contract.ProposerAI}
	revised, err := Revise(current, []contract.StageDispositionProposal{proposal}, RevisionOptions{ProjectDir: projectDir})
	if err != nil {
		t.Fatal(err)
	}
	if revised.Revision != 2 || revised.StageDecisions[3].DecisionAuthority != "core" || revised.StageDecisions[3].ProposalRef == nil {
		t.Fatalf("revised = %+v", revised.StageDecisions[3])
	}
}

func evidenceFixture(t *testing.T) (string, contract.ArtifactReference) {
	t.Helper()
	projectDir := t.TempDir()
	return projectDir, writeEvidence(t, projectDir, "effective-policy", "artifacts/policy.json")
}

func writeEvidence(t *testing.T, projectDir, artifact, relative string) contract.ArtifactReference {
	t.Helper()
	content := []byte("{}\n")
	path := filepath.Join(projectDir, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	return contract.ArtifactReference{Artifact: artifact, Version: 1, SourceOfTruth: strings.TrimPrefix(filepath.ToSlash(relative), "/"), SHA256: digest.Bytes(content)}
}
