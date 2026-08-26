package risk

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/workflow/policy"
)

func TestAIAddsAndRaisesButCannotReduceRisk(t *testing.T) {
	t.Parallel()
	projectDir, recordDir := riskFixture(t)
	if _, err := Initialize(context.Background(), projectDir, recordDir, "intent-1", Options{CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	proposal := Proposal{SchemaVersion: 1, Artifact: "intent-risk-proposal", Version: 1, ProposalID: "risk-proposal-1", IntentID: "intent-1", BaseRevision: 1, Risks: []Seed{{RiskID: "account-lockout", Severity: policy.Medium, Statement: "A user could be locked out.", EvidenceRefs: []contract.ArtifactReference{}}}, Reason: "Authentication changes.", ProposedBy: "ai", ProposedAt: "2026-08-25T00:01:00.000Z"}
	added, err := Propose(context.Background(), projectDir, recordDir, proposal, "")
	if err != nil {
		t.Fatal(err)
	}
	if added.Revision != 2 || added.Risks[0].Severity != policy.Medium {
		t.Fatalf("added = %+v", added)
	}
	proposal.ProposalID, proposal.BaseRevision, proposal.Risks[0].Severity = "risk-proposal-2", 2, policy.High
	if _, err := Propose(context.Background(), projectDir, recordDir, proposal, ""); err != nil {
		t.Fatal(err)
	}
	proposal.ProposalID, proposal.BaseRevision, proposal.Risks[0].Severity = "risk-proposal-3", 3, policy.Low
	if _, err := Propose(context.Background(), projectDir, recordDir, proposal, ""); err == nil {
		t.Fatal("Propose() accepted severity reduction")
	}
}

func TestOnlyHumanDecisionReducesRisk(t *testing.T) {
	t.Parallel()
	projectDir, recordDir := riskFixture(t)
	if _, err := Initialize(context.Background(), projectDir, recordDir, "intent-1", Options{Risks: []Seed{{RiskID: "account-lockout", Severity: policy.High, Statement: "A user could be locked out.", EvidenceRefs: []contract.ArtifactReference{}}}, CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	medium := policy.Medium
	decision := Decision{SchemaVersion: 1, Artifact: "intent-risk-decision", Version: 1, DecisionID: "risk-decision-1", IntentID: "intent-1", RiskID: "account-lockout", Action: SetSeverity, Severity: &medium, EvidenceRefs: []contract.ArtifactReference{}, Reason: "The impact is constrained.", DecidedBy: "human", DecidedAt: "2026-08-25T00:01:00.000Z"}
	register, err := Decide(context.Background(), projectDir, recordDir, decision, "")
	if err != nil {
		t.Fatal(err)
	}
	if register.Risks[0].Severity != policy.Medium || register.Risks[0].Status != Active {
		t.Fatalf("register = %+v", register)
	}
	if err := ValidateArtifacts(projectDir, recordDir, "intent-1"); err != nil {
		t.Fatal(err)
	}
}

func TestDecisionRejectsAIAuthority(t *testing.T) {
	t.Parallel()
	content := []byte(`{"schema_version":1,"artifact":"intent-risk-decision","version":1,"decision_id":"d1","intent_id":"i1","risk_id":"r1","action":"dismiss","severity":null,"evidence_refs":[],"reason":"no","decided_by":"ai","decided_at":"2026-08-25T00:00:00.000Z"}`)
	if _, err := DecodeDecision(content); err == nil {
		t.Fatal("DecodeDecision() accepted AI authority")
	}
}

func TestValidationRejectsCurrentThatPinsAnOlderRevision(t *testing.T) {
	t.Parallel()
	projectDir, recordDir := riskFixture(t)
	first, err := Initialize(context.Background(), projectDir, recordDir, "intent-1", Options{CreatedAt: "2026-08-25T00:00:00.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	proposal := Proposal{SchemaVersion: 1, Artifact: "intent-risk-proposal", Version: 1, ProposalID: "risk-proposal-1", IntentID: "intent-1", BaseRevision: 1, Risks: []Seed{{RiskID: "new-risk", Severity: policy.Low, Statement: "A new risk exists.", EvidenceRefs: []contract.ArtifactReference{}}}, Reason: "New evidence.", ProposedBy: "ai", ProposedAt: "2026-08-25T00:01:00.000Z"}
	if _, err := Propose(context.Background(), projectDir, recordDir, proposal, ""); err != nil {
		t.Fatal(err)
	}
	_, _, current, err := ReadCurrent(projectDir, recordDir)
	if err != nil {
		t.Fatal(err)
	}
	current.RegisterRef = first.RegisterReference
	content, err := jsonx.MarshalCanonical(current)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(CurrentPath(recordDir), content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateArtifacts(projectDir, recordDir, "intent-1"); err == nil {
		t.Fatal("ValidateArtifacts() accepted Current pointing to an older revision")
	}
}

func TestInitializeRejectsSymlinkRiskRoot(t *testing.T) {
	t.Parallel()
	projectDir, recordDir := riskFixture(t)
	outside := t.TempDir()
	artifacts := filepath.Join(recordDir, "artifacts")
	if err := os.MkdirAll(artifacts, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(artifacts, "risks")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := Initialize(context.Background(), projectDir, recordDir, "intent-1", Options{CreatedAt: "2026-08-25T00:00:00.000Z"}); err == nil {
		t.Fatal("Initialize() accepted a symlink Risk root")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("Initialize() changed symlink target: %v, %v", entries, err)
	}
}

func riskFixture(t *testing.T) (string, string) {
	t.Helper()
	projectDir := t.TempDir()
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "intent-1")
	if err := os.MkdirAll(recordDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir
}
