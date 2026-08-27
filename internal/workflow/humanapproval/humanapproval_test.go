package humanapproval

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
)

const (
	gateOpenedAt   = "2026-08-27T01:00:00.000Z"
	gatePreparedAt = "2026-08-27T01:01:00.000Z"
	gateObservedAt = "2026-08-27T01:02:00.000Z"
)

func TestHumanApprovalLifecycleIsExactOneTimeAndPromptRedacted(t *testing.T) {
	projectDir, recordDir, subjectRef, reviewRef := approvalFixture(t)
	opened := openFixture(t, projectDir, recordDir, subjectRef, reviewRef)

	differentReview := writeFixtureRef(t, projectDir, recordDir, "other-review.html", "human-review", []byte("different review\n"))
	replacement := fixtureOptions(subjectRef, differentReview)
	if _, err := Open(context.Background(), projectDir, recordDir, replacement); err == nil || !strings.Contains(err.Error(), "different Review Freeze") {
		t.Fatalf("Open() replaced a pending Freeze: %v", err)
	}

	ordinary, err := Capture(context.Background(), projectDir, recordDir, "codex", "session-1", "turn-1", "please continue", gateObservedAt)
	if err != nil || ordinary.Matched {
		t.Fatalf("ordinary Capture() = %+v, %v", ordinary, err)
	}

	proposal := ActionProposal{
		SchemaVersion: 1, Artifact: "human-action-proposal", Version: 1,
		IntentID: "intent-1", Scope: string(contract.Stage04), SubjectSHA256: subjectRef.SHA256,
		Action: "approve-architecture-policy", Reason: "The reviewed architecture satisfies the policy gate.",
		Parameters: json.RawMessage(`{"acknowledgements":[]}`), ProposedBy: "ai",
	}
	prepared, err := Prepare(context.Background(), projectDir, recordDir, proposal, gatePreparedAt)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.Confirmation != Confirmation(opened.Freeze, prepared.EnvelopeReference) {
		t.Fatalf("confirmation = %q", prepared.Confirmation)
	}

	wrong := strings.TrimSuffix(prepared.Confirmation, opened.Freeze.ConfirmationCode) + "confirm-wrong"
	if captured, err := Capture(context.Background(), projectDir, recordDir, "codex", "session-1", "turn-1", wrong, gateObservedAt); err == nil || !captured.Matched {
		t.Fatalf("Capture() accepted a modified code: %+v, %v", captured, err)
	}

	captured, err := Capture(context.Background(), projectDir, recordDir, "codex", "session-1", "turn-1", prepared.Confirmation, gateObservedAt)
	if err != nil || captured.ReceiptReference == nil || captured.Receipt == nil {
		t.Fatalf("Capture() = %+v, %v", captured, err)
	}
	duplicate, err := Capture(context.Background(), projectDir, recordDir, "codex", "session-1", "turn-1", prepared.Confirmation, gateObservedAt)
	if err != nil || duplicate.ReceiptReference == nil || *duplicate.ReceiptReference != *captured.ReceiptReference {
		t.Fatalf("idempotent Capture() = %+v, %v", duplicate, err)
	}
	if _, err := Capture(context.Background(), projectDir, recordDir, "codex", "other-session", "turn-1", prepared.Confirmation, gateObservedAt); err == nil {
		t.Fatal("Capture() accepted a second authority source for one pending Envelope")
	}

	receiptBytes, err := os.ReadFile(filepath.Join(projectDir, filepath.FromSlash(captured.ReceiptReference.SourceOfTruth)))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"/aidlc-confirm", opened.Freeze.ConfirmationCode, `"prompt"`, "please continue"} {
		if strings.Contains(string(receiptBytes), forbidden) {
			t.Fatalf("Human Input Receipt persisted prompt material %q: %s", forbidden, receiptBytes)
		}
	}

	if _, err := ValidateProof(projectDir, recordDir, captured.ReceiptReference.SHA256, "intent-1", string(contract.Stage04), "graph-1", 2); err == nil {
		t.Fatal("ValidateProof() accepted a stale Plan revision")
	}
	proof, err := ValidateProof(projectDir, recordDir, captured.ReceiptReference.SHA256, "intent-1", string(contract.Stage04), "graph-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := proof.Require(string(contract.Stage04), proposal.Action, subjectRef.SHA256); err != nil {
		t.Fatal(err)
	}
	if err := proof.Require(string(contract.Stage04), "request-revision", subjectRef.SHA256); err == nil {
		t.Fatal("Proof authorized an action outside its Envelope")
	}
	var parameters struct {
		Acknowledgements []json.RawMessage `json:"acknowledgements"`
	}
	if err := proof.Parameters(&parameters); err != nil || parameters.Acknowledgements == nil {
		t.Fatalf("Proof.Parameters() = %+v, %v", parameters, err)
	}

	resolution, resolutionRef, err := Resolve(context.Background(), projectDir, recordDir, proof, nil, "approved", "")
	if err != nil || resolution.ReceiptRef != *captured.ReceiptReference || resolutionRef.SHA256 == "" {
		t.Fatalf("Resolve() = %+v, %+v, %v", resolution, resolutionRef, err)
	}
	if _, _, err := Resolve(context.Background(), projectDir, recordDir, proof, nil, "approved", ""); err == nil {
		t.Fatal("Resolve() replayed a consumed Human Input Receipt")
	}
	if _, err := ValidateProof(projectDir, recordDir, captured.ReceiptReference.SHA256, "intent-1", string(contract.Stage04), "graph-1", 1); err == nil {
		t.Fatal("ValidateProof() accepted a consumed Human Input Receipt")
	}
	current, _, _, err := ReadCurrent(projectDir, recordDir)
	if err != nil || current.Status != StatusResolved || current.ResolutionRef == nil {
		t.Fatalf("resolved Current = %+v, %v", current, err)
	}

	second := openFixture(t, projectDir, recordDir, subjectRef, reviewRef)
	if second.Freeze.FreezeID == opened.Freeze.FreezeID {
		t.Fatal("a resolved Freeze was reused as a new decision cycle")
	}
	if _, err := Capture(context.Background(), projectDir, recordDir, "codex", "session-2", "turn-2", prepared.Confirmation, gateObservedAt); err == nil {
		t.Fatal("Capture() accepted a confirmation from an earlier Freeze")
	}
}

func TestReadCurrentRejectsArtifactTamperingAndCrossBinding(t *testing.T) {
	t.Run("envelope bytes", func(t *testing.T) {
		projectDir, recordDir, subjectRef, reviewRef := approvalFixture(t)
		openFixture(t, projectDir, recordDir, subjectRef, reviewRef)
		prepared := prepareFixture(t, projectDir, recordDir, subjectRef)
		path := filepath.Join(projectDir, filepath.FromSlash(prepared.EnvelopeReference.SourceOfTruth))
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(content, ' '), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := ReadCurrent(projectDir, recordDir); err == nil {
			t.Fatal("ReadCurrent() accepted modified immutable Envelope bytes")
		}
	})

	t.Run("receipt action", func(t *testing.T) {
		projectDir, recordDir, subjectRef, reviewRef := approvalFixture(t)
		opened := openFixture(t, projectDir, recordDir, subjectRef, reviewRef)
		prepared := prepareFixture(t, projectDir, recordDir, subjectRef)
		current, _, freezeRef, err := ReadCurrent(projectDir, recordDir)
		if err != nil {
			t.Fatal(err)
		}
		forged := Receipt{
			SchemaVersion: 1, Artifact: "human-input-receipt", Version: 1,
			ReceiptID: "receipt-cross-binding", IntentID: "intent-1", Scope: string(contract.Stage04),
			FreezeRef: freezeRef, EnvelopeRef: prepared.EnvelopeReference, Action: "request-revision",
			Harness: "codex", SessionID: "session-cross", TurnID: "turn-cross", ObservedAt: gateObservedAt,
		}
		forgedRef, _, err := writeCanonicalImmutable(projectDir, ReceiptPath(recordDir, opened.Freeze.FreezeID, forged.ReceiptID), forged.Artifact, 1, forged)
		if err != nil {
			t.Fatal(err)
		}
		current.ReceiptRef = &forgedRef
		current.UpdatedAt = gateObservedAt
		if err := writeCurrent(projectDir, recordDir, current); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := ReadCurrent(projectDir, recordDir); err == nil || !strings.Contains(err.Error(), "does not bind") {
			t.Fatalf("ReadCurrent() accepted cross-bound Receipt: %v", err)
		}
	})
}

func TestActionProposalRejectsTrailingJSON(t *testing.T) {
	value := ActionProposal{
		SchemaVersion: 1, Artifact: "human-action-proposal", Version: 1,
		IntentID: "intent-1", Scope: string(contract.Stage04), SubjectSHA256: "sha256:" + strings.Repeat("a", 64),
		Action: "request-revision", Reason: "Revise it.", Parameters: json.RawMessage(`{} {}`), ProposedBy: "ai",
	}
	if err := value.Validate(); err == nil {
		t.Fatal("ActionProposal.Validate() accepted trailing JSON")
	}
	if err := (Proof{}).Require(string(contract.Stage04), "request-revision", value.SubjectSHA256); err == nil {
		t.Fatal("manufactured zero Proof authorized a Human action")
	}
}

func TestOpenFailsClosedWhenGateArtifactDigestChanged(t *testing.T) {
	projectDir, recordDir, subjectRef, reviewRef := approvalFixture(t)
	subjectPath := filepath.Join(projectDir, filepath.FromSlash(subjectRef.SourceOfTruth))
	if err := os.WriteFile(subjectPath, []byte("{\"subject\":false}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(context.Background(), projectDir, recordDir, fixtureOptions(subjectRef, reviewRef)); err == nil || !strings.Contains(err.Error(), "subject Sensor failed: artifact_sha256_mismatch") {
		t.Fatalf("Open() did not fail closed: %v", err)
	}
	if _, err := os.Lstat(CurrentPath(recordDir)); !os.IsNotExist(err) {
		t.Fatalf("Human Gate Current exists after failed Sensor: %v", err)
	}
	entries, err := audit.ReadOrdered(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Event != string(audit.SensorFired) || entries[1].Event != string(audit.SensorFailed) {
		t.Fatalf("Audit entries = %#v", entries)
	}
}

func approvalFixture(t *testing.T) (string, string, contract.ArtifactReference, contract.ArtifactReference) {
	t.Helper()
	projectDir := t.TempDir()
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "intent-1")
	if err := os.MkdirAll(filepath.Join(recordDir, "artifacts"), 0o755); err != nil {
		t.Fatal(err)
	}
	subjectRef := writeFixtureRef(t, projectDir, recordDir, "subject.json", "architecture-proposal", []byte("{\"subject\":true}\n"))
	reviewRef := writeFixtureRef(t, projectDir, recordDir, "review.html", "architecture-policy-review", []byte("<html>review</html>\n"))
	return projectDir, recordDir, subjectRef, reviewRef
}

func writeFixtureRef(t *testing.T, projectDir, recordDir, name, artifact string, content []byte) contract.ArtifactReference {
	t.Helper()
	path := filepath.Join(recordDir, "artifacts", name)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	value, err := reference(projectDir, path, artifact, 1, content)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func fixtureOptions(subjectRef, reviewRef contract.ArtifactReference) OpenOptions {
	return OpenOptions{
		IntentID: "intent-1", Scope: string(contract.Stage04), SubjectRef: subjectRef, ReviewRef: reviewRef,
		GraphVersion: "graph-1", PlanRevision: 1,
		AllowedActions: []string{"approve-architecture-policy", "request-revision"}, OpenedAt: gateOpenedAt,
	}
}

func openFixture(t *testing.T, projectDir, recordDir string, subjectRef, reviewRef contract.ArtifactReference) OpenResult {
	t.Helper()
	value, err := Open(context.Background(), projectDir, recordDir, fixtureOptions(subjectRef, reviewRef))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func prepareFixture(t *testing.T, projectDir, recordDir string, subjectRef contract.ArtifactReference) PrepareResult {
	t.Helper()
	value, err := Prepare(context.Background(), projectDir, recordDir, ActionProposal{
		SchemaVersion: 1, Artifact: "human-action-proposal", Version: 1,
		IntentID: "intent-1", Scope: string(contract.Stage04), SubjectSHA256: subjectRef.SHA256,
		Action: "approve-architecture-policy", Reason: "Approved after review.", Parameters: json.RawMessage(`{}`), ProposedBy: "ai",
	}, gatePreparedAt)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
