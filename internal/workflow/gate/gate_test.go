package gate

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/workflow/policy"
	"github.com/sori883/aidlc/internal/workflow/risk"
)

func TestResolveAndAcknowledgeCurrentRisk(t *testing.T) {
	t.Parallel()
	projectDir, recordDir, policyRef := gateFixture(t)
	if _, err := risk.Initialize(context.Background(), projectDir, recordDir, "intent-1", risk.Options{Risks: []risk.Seed{{RiskID: "account-lockout", Severity: policy.High, Statement: "A user could be locked out.", EvidenceRefs: []contract.ArtifactReference{}}}, CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	resolved, err := Resolve(projectDir, recordDir, contract.Stage08, policyRef, "2026-08-25T00:01:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.Set.Requirements) != 1 || resolved.Set.Requirements[0].RequirementID != "project-high-release:account-lockout" {
		t.Fatalf("requirements = %+v", resolved.Set.Requirements)
	}
	acknowledgements := []Acknowledgement{{RequirementID: resolved.Set.Requirements[0].RequirementID, Acknowledged: true, Reason: "Reviewed the remaining risk."}}
	if err := ValidateAcknowledgements(projectDir, recordDir, resolved.Set, acknowledgements, true); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAcknowledgements(projectDir, recordDir, resolved.Set, nil, true); err == nil {
		t.Fatal("ValidateAcknowledgements() accepted a missing acknowledgement")
	}
}

func TestRequirementBecomesStaleWhenRiskRevisionChanges(t *testing.T) {
	t.Parallel()
	projectDir, recordDir, policyRef := gateFixture(t)
	if _, err := risk.Initialize(context.Background(), projectDir, recordDir, "intent-1", risk.Options{CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	resolved, err := Resolve(projectDir, recordDir, contract.Stage08, policyRef, "2026-08-25T00:01:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	proposal := risk.Proposal{SchemaVersion: 1, Artifact: "intent-risk-proposal", Version: 1, ProposalID: "add-risk", IntentID: "intent-1", BaseRevision: 1, Risks: []risk.Seed{{RiskID: "new-risk", Severity: policy.Low, Statement: "A new risk exists.", EvidenceRefs: []contract.ArtifactReference{}}}, Reason: "New evidence.", ProposedBy: "ai", ProposedAt: "2026-08-25T00:02:00.000Z"}
	if _, err := risk.Propose(context.Background(), projectDir, recordDir, proposal, ""); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAcknowledgements(projectDir, recordDir, resolved.Set, []Acknowledgement{}, true); err == nil {
		t.Fatal("ValidateAcknowledgements() accepted a stale Risk reference")
	}
}

func TestRenderReviewEscapesUntrustedText(t *testing.T) {
	set := RequirementSet{SchemaVersion: 1, Artifact: "human-gate-requirements", Version: 1, IntentID: "intent-1", StageID: contract.Stage08, EffectivePolicyRef: ref("effective-policy"), RiskRegisterRef: ref("intent-risk-register"), Requirements: []Requirement{{RequirementID: "rule:risk", RuleID: "rule", RiskID: "risk", Severity: policy.High, RiskStatement: "<script>alert(1)</script>", Statement: "Review & decide."}}, CreatedAt: "2026-08-25T00:00:00.000Z"}
	content, err := RenderReviewHTML(set, "<subject>")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(content, "<script>") || !strings.Contains(content, "&lt;script&gt;") || !strings.Contains(content, "&lt;subject&gt;") {
		t.Fatal("RenderReviewHTML() did not escape untrusted text")
	}
}

func gateFixture(t *testing.T) (string, string, contract.ArtifactReference) {
	t.Helper()
	projectDir := t.TempDir()
	memoryDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "memory")
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "intent-1")
	if err := os.MkdirAll(memoryDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(recordDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "aidlc", "active-space"), []byte("default\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, layer := range policy.OrderedLayers {
		if err := os.WriteFile(filepath.Join(memoryDir, string(layer)+".md"), []byte("# "+string(layer)+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		rules := `[]`
		if layer == policy.Project {
			rules = `[{"rule_id":"project-high-release","minimum_severity":"high","stage_ids":["ST-08"],"acknowledgement":"Review the remaining high risk."}]`
		}
		content := `{"schema_version":1,"artifact":"human-gate-policy-source","layer":"` + string(layer) + `","rules":` + rules + `}`
		if err := os.WriteFile(filepath.Join(memoryDir, string(layer)+"-policy.json"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	written, err := policy.Write(projectDir, recordDir, "intent-1", policy.BuildOptions{CreatedAt: "2026-08-25T00:00:00.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir, written.Reference
}

func ref(artifact string) contract.ArtifactReference {
	return contract.ArtifactReference{Artifact: artifact, Version: 1, SourceOfTruth: "artifacts/example.json", SHA256: "sha256:" + strings.Repeat("a", 64)}
}
