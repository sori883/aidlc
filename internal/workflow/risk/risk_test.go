package risk

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/workflow/humanapproval"
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
	_, subjectRef, _, err := ReadCurrent(projectDir, recordDir)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := humanapproval.Open(context.Background(), projectDir, recordDir, humanapproval.OpenOptions{IntentID: "intent-1", Scope: humanapproval.ScopeRisk, SubjectRef: subjectRef, ReviewRef: subjectRef, GraphVersion: "test-graph", PlanRevision: 1, AllowedActions: []string{string(Dismiss), string(Resolve), string(SetSeverity)}, OpenedAt: "2026-08-25T00:00:30.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	parameters, _ := json.Marshal(DecisionParameters{DecisionID: "risk-decision-1", RiskID: "account-lockout", Severity: &medium, EvidenceRefs: []contract.ArtifactReference{}})
	prepared, err := humanapproval.Prepare(context.Background(), projectDir, recordDir, humanapproval.ActionProposal{SchemaVersion: 1, Artifact: "human-action-proposal", Version: 1, IntentID: "intent-1", Scope: humanapproval.ScopeRisk, SubjectSHA256: subjectRef.SHA256, Action: string(SetSeverity), Reason: "The impact is constrained.", Parameters: parameters, ProposedBy: "ai"}, "2026-08-25T00:00:40.000Z")
	if err != nil {
		t.Fatal(err)
	}
	captured, err := humanapproval.Capture(context.Background(), projectDir, recordDir, "codex", "session-risk", "turn-risk", prepared.Confirmation, "2026-08-25T00:01:00.000Z")
	if err != nil || captured.ReceiptReference == nil {
		t.Fatalf("capture = %+v, %v", captured, err)
	}
	proof, err := humanapproval.ValidateProof(projectDir, recordDir, captured.ReceiptReference.SHA256, "intent-1", humanapproval.ScopeRisk, opened.Freeze.GraphVersion, opened.Freeze.PlanRevision)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Decide(context.Background(), projectDir, recordDir, proof)
	if err != nil {
		t.Fatal(err)
	}
	register := result.Register
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
