package hookapproval

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	"github.com/sori883/aidlc/internal/workspace"
)

func TestCodexReceiptAndStopHooksEnforcePendingFreeze(t *testing.T) {
	projectDir, born, prepared := approvalHookFixture(t)
	stopInput := hookInput(t, map[string]any{
		"session_id": "session-1", "turn_id": "turn-stop", "cwd": projectDir, "hook_event_name": "Stop",
	})
	pending, err := Freeze(context.Background(), projectDir, strings.NewReader(stopInput), Options{Harness: "codex"})
	if err != nil || !pending.Pending || !strings.Contains(pending.StopReason, humanapproval.ScopeRisk) {
		t.Fatalf("Freeze() pending = %+v, %v", pending, err)
	}
	stopResponse, err := MarshalFreezeResponse(pending)
	if err != nil || !strings.Contains(string(stopResponse), `"continue":false`) {
		t.Fatalf("MarshalFreezeResponse() = %s, %v", stopResponse, err)
	}

	ordinaryInput := hookInput(t, map[string]any{
		"session_id": "session-1", "turn_id": "turn-ordinary", "cwd": projectDir,
		"hook_event_name": "UserPromptSubmit", "prompt": "Please explain the review.",
	})
	ordinary, err := Capture(context.Background(), projectDir, strings.NewReader(ordinaryInput), Options{Harness: "codex"})
	if err != nil || ordinary.Matched {
		t.Fatalf("ordinary Capture() = %+v, %v", ordinary, err)
	}
	if output, err := MarshalCaptureResponse(ordinary); err != nil || output != nil {
		t.Fatalf("ordinary response = %q, %v", output, err)
	}

	confirmationInput := hookInput(t, map[string]any{
		"session_id": "session-1", "turn_id": "turn-confirm", "cwd": projectDir,
		"hook_event_name": "UserPromptSubmit", "prompt": prepared.Confirmation,
	})
	captured, err := Capture(context.Background(), projectDir, strings.NewReader(confirmationInput), Options{
		Harness: "codex", Clock: func() time.Time { return time.Date(2026, 8, 27, 2, 2, 0, 0, time.UTC) },
	})
	if err != nil || !captured.Matched || captured.ReceiptSHA256 == "" || !strings.Contains(captured.AdditionalContext, "human-gate apply") {
		t.Fatalf("confirmation Capture() = %+v, %v", captured, err)
	}
	captureResponse, err := MarshalCaptureResponse(captured)
	if err != nil || !strings.Contains(string(captureResponse), `"hookEventName":"UserPromptSubmit"`) || !strings.Contains(string(captureResponse), captured.ReceiptSHA256) {
		t.Fatalf("MarshalCaptureResponse() = %s, %v", captureResponse, err)
	}

	proof, err := humanapproval.ValidateProof(projectDir, born.RecordDir, captured.ReceiptSHA256, born.UUID, humanapproval.ScopeRisk, born.State.GraphVersion, born.State.PlanRevision)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := humanapproval.Resolve(context.Background(), projectDir, born.RecordDir, proof, nil, "dismissed", ""); err != nil {
		t.Fatal(err)
	}
	resolved, err := Freeze(context.Background(), projectDir, strings.NewReader(stopInput), Options{Harness: "codex"})
	if err != nil || resolved.Pending {
		t.Fatalf("Freeze() resolved = %+v, %v", resolved, err)
	}
	resolvedResponse, err := MarshalFreezeResponse(resolved)
	if err != nil || string(resolvedResponse) != "{}\n" {
		t.Fatalf("resolved response = %q, %v", resolvedResponse, err)
	}
}

func TestCodexReceiptHookBlocksMalformedStaleAndOutsideConfirmations(t *testing.T) {
	projectDir, _, prepared := approvalHookFixture(t)
	values := []map[string]any{
		{"session_id": "session-bad", "turn_id": "turn-bad", "cwd": projectDir, "hook_event_name": "UserPromptSubmit", "prompt": prepared.Confirmation + " "},
		{"session_id": "session-outside", "turn_id": "turn-outside", "cwd": t.TempDir(), "hook_event_name": "UserPromptSubmit", "prompt": prepared.Confirmation},
	}
	for _, value := range values {
		result, err := Capture(context.Background(), projectDir, strings.NewReader(hookInput(t, value)), Options{Harness: "codex"})
		if err == nil {
			t.Fatalf("Capture() accepted invalid confirmation: %+v, %+v", value, result)
		}
	}
	failure := string(MarshalCaptureFailureResponse())
	if !strings.Contains(failure, `"decision":"block"`) || strings.Contains(failure, prepared.Confirmation) {
		t.Fatalf("capture failure response = %s", failure)
	}
}

func TestStopHookFailsClosedWhenPendingStateCannotBeVerified(t *testing.T) {
	projectDir, born, _ := approvalHookFixture(t)
	currentPath := humanapproval.CurrentPath(born.RecordDir)
	if err := os.WriteFile(currentPath, []byte("not-json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	input := hookInput(t, map[string]any{
		"session_id": "session-1", "turn_id": "turn-stop", "cwd": projectDir, "hook_event_name": "Stop",
	})
	result, err := Freeze(context.Background(), projectDir, strings.NewReader(input), Options{Harness: "codex"})
	if err == nil || !result.Pending {
		t.Fatalf("Freeze() did not fail closed: %+v, %v", result, err)
	}
	failure := string(MarshalFreezeFailureResponse())
	if !strings.Contains(failure, `"continue":false`) || !strings.Contains(failure, "could not be validated") {
		t.Fatalf("freeze failure response = %s", failure)
	}
}

func approvalHookFixture(t *testing.T) (string, intent.BornWithState, humanapproval.PrepareResult) {
	t.Helper()
	projectDir := t.TempDir()
	root := hookRepositoryRoot(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(root, "core", "memory")); err != nil {
		t.Fatal(err)
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, filepath.Join(root, "core"), "Human Approval Hook", "default", intent.BirthWorkflowOptions{
		Identity: intent.Options{
			Clock: func() time.Time { return time.Date(2026, 8, 27, 2, 0, 0, 0, time.UTC) },
			UUID:  func() (string, error) { return "0198e7d0-0000-7000-8000-000000000004", nil },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	opened, err := humanapproval.Open(context.Background(), projectDir, born.RecordDir, humanapproval.OpenOptions{
		IntentID: born.UUID, Scope: humanapproval.ScopeRisk,
		SubjectRef: born.State.PolicySnapshot, ReviewRef: born.State.PolicySnapshot,
		GraphVersion: born.State.GraphVersion, PlanRevision: born.State.PlanRevision,
		AllowedActions: []string{"dismiss-risk"}, OpenedAt: "2026-08-27T02:00:30.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	parameters, err := json.Marshal(map[string]any{"risk_id": "risk-1"})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := humanapproval.Prepare(context.Background(), projectDir, born.RecordDir, humanapproval.ActionProposal{
		SchemaVersion: 1, Artifact: "human-action-proposal", Version: 1,
		IntentID: born.UUID, Scope: humanapproval.ScopeRisk, SubjectSHA256: opened.Freeze.SubjectRef.SHA256,
		Action: "dismiss-risk", Reason: "The risk is accepted for this test.", Parameters: parameters, ProposedBy: "ai",
	}, "2026-08-27T02:01:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, born, prepared
}

func hookRepositoryRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}

func hookInput(t *testing.T, value map[string]any) string {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}
