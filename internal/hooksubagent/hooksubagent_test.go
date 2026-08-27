package hooksubagent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/platform/digest"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st05buildcontract"
	"github.com/sori883/aidlc/internal/stage/st06build"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

func TestValidProposalResultCreatesImmutableReceipt(t *testing.T) {
	projectDir, born, coreDir := subagentFixture(t)
	setSubagentStage(t, projectDir, born, contract.Stage01)
	content := []byte("{\"orientation\":true}\n")
	if err := os.MkdirAll(filepath.Join(projectDir, "proposals"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "proposals", "orient.json"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	stageResult := StageResult{
		SchemaVersion: 1, AgentName: "aidlc-system-analyst-agent", StageID: contract.Stage01,
		AssignmentKind: "work", Role: "lead", Status: "completed", MutationScope: "proposal-only",
		Outputs:       []Output{{Path: "proposals/orient.json", Status: "added", SHA256: pointer(digest.Bytes(content))}},
		ReviewedPaths: []ReviewedPath{}, Checks: []string{"proposal JSON inspected"}, Skills: []string{"aidlc-stage-work"}, UnresolvedQuestions: []string{},
	}
	input := subagentJSON(t, projectDir, "agent-1", stageResult.AgentName, false, marker(t, stageResult))
	result, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(input), Options{Clock: fixedSubagentClock})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != Accepted || result.ReceiptReference == nil || result.Attempts != 0 {
		t.Fatalf("Validate() = %#v", result)
	}
	response, err := MarshalResponse(result)
	if err != nil || string(response) != "{}\n" {
		t.Fatalf("MarshalResponse() = %q, %v", response, err)
	}
	current, receipt, err := Inspect(projectDir, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if receipt.AgentType != stageResult.AgentName || receipt.ResultSHA256 == "" || current.ReceiptReference != *result.ReceiptReference {
		t.Fatalf("Receipt = %#v current=%#v", receipt, current)
	}
	inventory, err := InspectAll(projectDir)
	if err != nil || !inventory.Present || inventory.ValidReceipts != 1 || len(inventory.AgentIDs) != 1 || inventory.AgentIDs[0] != "agent-1" {
		t.Fatalf("InspectAll() = %#v, %v", inventory, err)
	}
	repeated, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(input), Options{Clock: fixedSubagentClock})
	if err != nil || repeated.ReceiptReference == nil || *repeated.ReceiptReference != *result.ReceiptReference {
		t.Fatalf("repeated = %#v, %v", repeated, err)
	}
	if runtime.GOOS != "windows" {
		receiptPath := filepath.Join(projectDir, filepath.FromSlash(current.ReceiptReference.SourceOfTruth))
		receiptContent, readErr := os.ReadFile(receiptPath)
		if readErr != nil {
			t.Fatal(readErr)
		}
		outsideReceipt := filepath.Join(t.TempDir(), "receipt.json")
		if err := os.WriteFile(outsideReceipt, receiptContent, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(receiptPath); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsideReceipt, receiptPath); err != nil {
			t.Fatal(err)
		}
		if _, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(input), Options{Clock: fixedSubagentClock}); err == nil {
			t.Fatal("symlinked immutable delegation Receipt unexpectedly accepted")
		}
		if _, _, err := Inspect(projectDir, "agent-1"); err == nil {
			t.Fatal("Inspect unexpectedly accepted a symlinked delegation Receipt")
		}
	}
}

func TestInvalidResultGetsOneContinuationThenReleases(t *testing.T) {
	projectDir, born, coreDir := subagentFixture(t)
	setSubagentStage(t, projectDir, born, contract.Stage01)
	firstInput := subagentJSON(t, projectDir, "agent-loop", "aidlc-system-analyst-agent", false, "ordinary prose without marker")
	first, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(firstInput), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != Continue || first.Attempts != 1 || first.ReasonCode != "result-marker-missing" {
		t.Fatalf("first = %#v", first)
	}
	response, err := MarshalResponse(first)
	if err != nil || !strings.Contains(string(response), `"decision":"block"`) || !strings.Contains(string(response), "AIDLC_STAGE_RESULT") {
		t.Fatalf("first response = %s, %v", response, err)
	}
	secondInput := subagentJSON(t, projectDir, "agent-loop", "aidlc-system-analyst-agent", true, "still invalid")
	second, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(secondInput), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != Released || second.Attempts != 2 {
		t.Fatalf("second = %#v", second)
	}
	response, err = MarshalResponse(second)
	if err != nil || !strings.Contains(string(response), `"continue":false`) || !strings.Contains(string(response), "unvalidated") {
		t.Fatalf("second response = %s, %v", response, err)
	}
	if _, _, err := Inspect(projectDir, "agent-loop"); err == nil {
		t.Fatal("invalid result unexpectedly created a Receipt")
	}
}

func TestSecondInvalidAttemptReleasesEvenWithoutStopFlag(t *testing.T) {
	projectDir, born, coreDir := subagentFixture(t)
	setSubagentStage(t, projectDir, born, contract.Stage01)
	input := subagentJSON(t, projectDir, "agent-cap", "aidlc-system-analyst-agent", false, "invalid")
	if result, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(input), Options{}); err != nil || result.Status != Continue {
		t.Fatalf("first = %#v, %v", result, err)
	}
	result, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(input), Options{})
	if err != nil || result.Status != Released || result.Attempts != 2 {
		t.Fatalf("second = %#v, %v", result, err)
	}
}

func TestReadOnlyReviewBindsReviewedBytes(t *testing.T) {
	projectDir, born, coreDir := subagentFixture(t)
	setSubagentStage(t, projectDir, born, contract.Stage07)
	path := filepath.Join(born.RecordDir, "artifacts", "candidate-review.json")
	content := []byte("{\"candidate\":true}\n")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	relative, _ := filepath.Rel(projectDir, path)
	stageResult := StageResult{
		SchemaVersion: 1, AgentName: "aidlc-quality-agent", StageID: contract.Stage07,
		AssignmentKind: "review", Role: "lead", Status: "ready", MutationScope: "read-only",
		Outputs: []Output{}, ReviewedPaths: []ReviewedPath{{Path: filepath.ToSlash(relative), SHA256: digest.Bytes(content)}},
		Checks: []string{"candidate contract reviewed"}, Skills: []string{"aidlc-stage-work"}, UnresolvedQuestions: []string{},
	}
	result, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(subagentJSON(t, projectDir, "agent-review", stageResult.AgentName, false, marker(t, stageResult))), Options{})
	if err != nil || result.Status != Accepted {
		t.Fatalf("Validate() = %#v, %v", result, err)
	}
	stageResult.ReviewedPaths[0].SHA256 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	failed, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(subagentJSON(t, projectDir, "agent-review-tamper", stageResult.AgentName, false, marker(t, stageResult))), Options{})
	if err != nil || failed.Status != Continue || failed.ReasonCode != "review-digest-mismatch" {
		t.Fatalf("tampered = %#v, %v", failed, err)
	}
}

func TestWorkAssignmentReviewerIsImplicitlyReadOnly(t *testing.T) {
	projectDir, born, coreDir := subagentFixture(t)
	setSubagentStage(t, projectDir, born, contract.Stage03)
	path := filepath.Join(projectDir, "proposals", "requirements.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := []byte("{\"requirements\":[]}\n")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	value := StageResult{
		SchemaVersion: 1, AgentName: "aidlc-quality-agent", StageID: contract.Stage03,
		AssignmentKind: "work", Role: "reviewer", Status: "ready", MutationScope: "read-only",
		Outputs: []Output{}, ReviewedPaths: []ReviewedPath{{Path: "proposals/requirements.json", SHA256: digest.Bytes(content)}},
		Checks: []string{"requirements reviewed"}, Skills: []string{"aidlc-stage-work"}, UnresolvedQuestions: []string{},
	}
	result, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(subagentJSON(t, projectDir, "agent-work-reviewer", value.AgentName, false, marker(t, value))), Options{})
	if err != nil || result.Status != Accepted {
		t.Fatalf("Validate() = %#v, %v", result, err)
	}
}

func TestAssignmentAndProtectedPathMismatchAreRejected(t *testing.T) {
	projectDir, born, coreDir := subagentFixture(t)
	setSubagentStage(t, projectDir, born, contract.Stage01)
	statePath, _ := filepath.Rel(projectDir, state.StatePath(born.RecordDir))
	stateBytes, err := os.ReadFile(state.StatePath(born.RecordDir))
	if err != nil {
		t.Fatal(err)
	}
	value := StageResult{
		SchemaVersion: 1, AgentName: "aidlc-system-analyst-agent", StageID: contract.Stage01,
		AssignmentKind: "work", Role: "lead", Status: "completed", MutationScope: "proposal-only",
		Outputs:       []Output{{Path: filepath.ToSlash(statePath), Status: "modified", SHA256: pointer(digest.Bytes(stateBytes))}},
		ReviewedPaths: []ReviewedPath{}, Checks: []string{"checked"}, Skills: []string{"aidlc-stage-work"}, UnresolvedQuestions: []string{},
	}
	result, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(subagentJSON(t, projectDir, "agent-protected", value.AgentName, false, marker(t, value))), Options{})
	if err != nil || result.Status != Continue || result.ReasonCode != "proposal-protected-path" {
		t.Fatalf("protected = %#v, %v", result, err)
	}
	value.AgentName = "aidlc-product-agent"
	result, err = Validate(context.Background(), projectDir, coreDir, strings.NewReader(subagentJSON(t, projectDir, "agent-wrong", value.AgentName, false, marker(t, value))), Options{})
	if err != nil || result.ReasonCode != "assignment-mismatch" {
		t.Fatalf("assignment = %#v, %v", result, err)
	}
}

func TestAssignedWorktreeResultMustRemainInCurrentBoltTargets(t *testing.T) {
	projectDir, born, coreDir := subagentFixture(t)
	setSubagentStage(t, projectDir, born, contract.Stage06)
	worktree := configureSubagentST06(t, projectDir, born)
	if err := os.MkdirAll(filepath.Join(worktree, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	content := []byte("package src\n")
	if err := os.WriteFile(filepath.Join(worktree, "src", "new.go"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	relative, _ := filepath.Rel(projectDir, filepath.Join(worktree, "src", "new.go"))
	value := StageResult{
		SchemaVersion: 1, AgentName: "aidlc-developer-agent", StageID: contract.Stage06,
		AssignmentKind: "work", Role: "lead", Status: "completed", MutationScope: "assigned-worktree",
		Outputs:       []Output{{Path: filepath.ToSlash(relative), Status: "added", SHA256: pointer(digest.Bytes(content))}},
		ReviewedPaths: []ReviewedPath{}, Checks: []string{"go test target"}, Skills: []string{"aidlc-stage-work"}, UnresolvedQuestions: []string{},
	}
	result, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(subagentJSON(t, worktree, "agent-build", value.AgentName, false, marker(t, value))), Options{})
	if err != nil || result.Status != Accepted {
		t.Fatalf("inside target = %#v, %v", result, err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("outside\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside, _ := filepath.Rel(projectDir, filepath.Join(worktree, "README.md"))
	value.Outputs = []Output{{Path: filepath.ToSlash(outside), Status: "added", SHA256: pointer(digest.Bytes([]byte("outside\n")))}}
	result, err = Validate(context.Background(), projectDir, coreDir, strings.NewReader(subagentJSON(t, worktree, "agent-build-outside", value.AgentName, false, marker(t, value))), Options{})
	if err != nil || result.Status != Continue || result.ReasonCode != "worktree-target-mismatch" {
		t.Fatalf("outside target = %#v, %v", result, err)
	}
}

func TestMalformedDeliveryUsesFailOpenResponse(t *testing.T) {
	projectDir, _, coreDir := subagentFixture(t)
	if _, err := Validate(context.Background(), projectDir, coreDir, strings.NewReader(`{"hook_event_name":"Stop"}`), Options{}); err == nil {
		t.Fatal("malformed delivery unexpectedly accepted")
	}
	if got := string(MarshalFailureResponse()); got != "{}\n" {
		t.Fatalf("MarshalFailureResponse() = %q", got)
	}
}

func TestWithoutActiveIntentIsNoop(t *testing.T) {
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(root, "core", "memory")); err != nil {
		t.Fatal(err)
	}
	input := subagentJSON(t, projectDir, "agent-empty", "aidlc-system-analyst-agent", false, "invalid")
	result, err := Validate(context.Background(), projectDir, filepath.Join(root, "core"), strings.NewReader(input), Options{})
	if err != nil || result.Status != Noop {
		t.Fatalf("Validate() = %#v, %v", result, err)
	}
}

func subagentFixture(t *testing.T) (string, intent.BornWithState, string) {
	t.Helper()
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	coreDir := filepath.Join(root, "core")
	if _, err := workspace.Initialize(projectDir, filepath.Join(coreDir, "memory")); err != nil {
		t.Fatal(err)
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, coreDir, "Subagent Hook", "default", intent.BirthWorkflowOptions{Identity: intent.Options{
		Clock: func() time.Time { return time.Date(2026, 8, 28, 0, 0, 0, 0, time.UTC) },
		UUID:  func() (string, error) { return "0198ed00-0000-7000-8000-000000000002", nil },
	}})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, born, coreDir
}

func setSubagentStage(t *testing.T, projectDir string, born intent.BornWithState, stageID contract.StageID) {
	t.Helper()
	snapshot, err := state.Read(born.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	updated := snapshot.State
	updated.CurrentStage = stageID
	updated.Status = state.Ready
	updated.ParkedReason = nil
	updated.NotBefore = nil
	updated.Deadline = nil
	updated.UpdatedAt = "2026-08-28T00:01:00.000Z"
	if err := state.Store(context.Background(), projectDir, born.RecordDir, updated, snapshot.Plan); err != nil {
		t.Fatal(err)
	}
}

func configureSubagentST06(t *testing.T, projectDir string, born intent.BornWithState) string {
	t.Helper()
	boltID := "bolt-001"
	worktree := filepath.Join(born.RecordDir, "artifacts", "build", "worktrees", "repo-1", boltID, "attempt-000001", "tree")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	session := st06build.Session{
		SchemaVersion: 1, Artifact: "build-session", Version: 1,
		SessionID: "session-build", IntentID: born.UUID, StageID: contract.Stage06,
		Disposition: contract.Execute, Status: "active", CurrentBoltID: &boltID,
	}
	if _, _, err := stageruntime.WriteCanonical(projectDir, st06build.SessionPath(born.RecordDir), "build-session", 1, session, false); err != nil {
		t.Fatal(err)
	}
	request := st06build.WorkRequest{
		SchemaVersion: 1, Artifact: "bolt-work-request", Version: 1,
		SessionID: session.SessionID, IntentID: born.UUID, StageID: contract.Stage06,
		Bolt:    st05buildcontract.Bolt{BoltID: boltID, Targets: []st05buildcontract.Target{{SourceID: "source-1", Path: "src"}}},
		Attempt: 1, SourceWorkspaces: []st06build.SourceWorkspace{{SourceID: "source-1", WorktreePath: worktree}}, RequestedOutput: "repository-changes",
	}
	if _, _, err := stageruntime.WriteCanonical(projectDir, st06build.WorkRequestPath(born.RecordDir, boltID), "bolt-work-request", 1, request, false); err != nil {
		t.Fatal(err)
	}
	return worktree
}

func subagentJSON(t *testing.T, cwd, agentID, agentType string, stopActive bool, message string) string {
	t.Helper()
	content, err := json.Marshal(map[string]any{
		"session_id": "session-subagent", "turn_id": "turn-subagent", "cwd": cwd,
		"hook_event_name": "SubagentStop", "agent_id": agentID, "agent_type": agentType,
		"agent_transcript_path": filepath.Join(cwd, ".codex", "transcripts", agentID+".jsonl"),
		"stop_hook_active":      stopActive, "last_assistant_message": message,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func marker(t *testing.T, value StageResult) string {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return "Completed assigned work.\n" + markerPrefix + string(content)
}

func pointer(value string) *string { return &value }

func fixedSubagentClock() time.Time {
	return time.Date(2026, 8, 28, 3, 4, 5, 678000000, time.UTC)
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}
