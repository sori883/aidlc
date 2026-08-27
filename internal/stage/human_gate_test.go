package stage_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	"github.com/sori883/aidlc/internal/workflow/state"
)

func humanProof(t *testing.T, projectDir, action, reason string, parameters any, at string) humanapproval.Proof {
	t.Helper()
	snapshot, err := state.Resume(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	current, freeze, _, err := humanapproval.ReadCurrent(projectDir, snapshot.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	content, err := json.Marshal(parameters)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := humanapproval.Prepare(context.Background(), projectDir, snapshot.RecordDir, humanapproval.ActionProposal{
		SchemaVersion: 1, Artifact: "human-action-proposal", Version: 1,
		IntentID: freeze.IntentID, Scope: freeze.Scope, SubjectSHA256: freeze.SubjectRef.SHA256,
		Action: action, Reason: reason, Parameters: content, ProposedBy: "ai",
	}, at)
	if err != nil {
		t.Fatal(err)
	}
	sessionID := fmt.Sprintf("test-%s-%s", freeze.FreezeID, action)
	captured, err := humanapproval.Capture(context.Background(), projectDir, snapshot.RecordDir, "codex", sessionID, "turn-1", prepared.Confirmation, at)
	if err != nil || captured.ReceiptReference == nil {
		t.Fatalf("capture Human Receipt = %+v, %v", captured, err)
	}
	proof, err := humanapproval.ValidateProof(projectDir, snapshot.RecordDir, captured.ReceiptReference.SHA256, snapshot.State.IntentID, current.Scope, snapshot.State.GraphVersion, snapshot.State.PlanRevision)
	if err != nil {
		t.Fatal(err)
	}
	return proof
}
