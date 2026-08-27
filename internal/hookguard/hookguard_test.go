package hookguard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/hookaudit"
	"github.com/sori883/aidlc/internal/intent"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st05buildcontract"
	"github.com/sori883/aidlc/internal/stage/st06build"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

func TestGuardDeniesCoreOwnedPatchAndRecordsOnlyMetadata(t *testing.T) {
	t.Parallel()
	projectDir, born := guardFixture(t)
	relative, err := filepath.Rel(projectDir, state.StatePath(born.RecordDir))
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(state.StatePath(born.RecordDir))
	if err != nil {
		t.Fatal(err)
	}
	secret := "SECRET PATCH BODY"
	result, err := Guard(context.Background(), projectDir, strings.NewReader(guardJSON(t, projectDir, "apply_patch", "call-protected", "*** Begin Patch\n*** Update File: "+filepath.ToSlash(relative)+"\n@@\n-}\n+"+secret+"\n*** End Patch")), Options{Clock: fixedClock})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Denied || result.ReasonCode != "core_owned_path" || result.AuditFailed {
		t.Fatalf("result = %+v", result)
	}
	content, err := MarshalResponse(result)
	if err != nil {
		t.Fatal(err)
	}
	assertDenyShape(t, content)
	for _, forbidden := range []string{"allow", "updatedInput", secret} {
		if bytes.Contains(content, []byte(forbidden)) {
			t.Fatalf("deny response contains %q: %s", forbidden, content)
		}
	}
	after, err := os.ReadFile(state.StatePath(born.RecordDir))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("Guard changed Core State")
	}
	status, err := hookaudit.Inspect(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if status.Entries != 1 || status.Latest == nil || status.Latest.Kind != hookaudit.GuardDenied || status.Latest.Reason != "core_owned_path" {
		t.Fatalf("Hook Journal status = %+v", status)
	}
	entries, err := os.ReadDir(status.JournalDir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("Hook Journal files = %v err=%v", entries, err)
	}
	journal, err := os.ReadFile(filepath.Join(status.JournalDir, entries[0].Name()))
	if err == nil && bytes.Contains(journal, []byte(secret)) {
		t.Fatalf("Hook Journal leaked patch body: %s", journal)
	}
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestGuardAllowsProposalPatchAndReadOnlyBash(t *testing.T) {
	t.Parallel()
	projectDir, born := guardFixture(t)
	proposal := guardJSON(t, projectDir, "apply_patch", "call-proposal", "*** Begin Patch\n*** Add File: proposal.json\n+{}\n*** End Patch")
	result, err := Guard(context.Background(), projectDir, strings.NewReader(proposal), Options{})
	if err != nil || result.Denied {
		t.Fatalf("proposal result = %+v err=%v", result, err)
	}
	relative, _ := filepath.Rel(projectDir, state.StatePath(born.RecordDir))
	read := guardJSON(t, projectDir, "Bash", "call-read", "cat "+filepath.ToSlash(relative))
	result, err = Guard(context.Background(), projectDir, strings.NewReader(read), Options{})
	if err != nil || result.Denied {
		t.Fatalf("read result = %+v err=%v", result, err)
	}
}

func TestGuardDeniesDirectManagedBashMutation(t *testing.T) {
	t.Parallel()
	projectDir, born := guardFixture(t)
	relative, _ := filepath.Rel(projectDir, state.SummaryPath(born.RecordDir))
	input := guardJSON(t, projectDir, "Bash", "call-rm", "rm "+filepath.ToSlash(relative)+" # SECRET COMMAND")
	result, err := Guard(context.Background(), projectDir, strings.NewReader(input), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Denied || result.ReasonCode != "core_owned_path" || strings.Contains(result.Reason, "SECRET") {
		t.Fatalf("result = %+v", result)
	}
	rootInput := guardJSON(t, projectDir, "Bash", "call-rm-root", "rm -rf -- aidlc")
	result, err = Guard(context.Background(), projectDir, strings.NewReader(rootInput), Options{})
	if err != nil || !result.Denied || result.ReasonCode != "core_owned_path" {
		t.Fatalf("managed root result = %+v err=%v", result, err)
	}
	aliasInput := guardJSON(t, projectDir, "Bash", "call-rm-alias", "rm /tmp/alias/project/aidlc/spaces/default/state.json")
	result, err = Guard(context.Background(), projectDir, strings.NewReader(aliasInput), Options{})
	if err != nil || !result.Denied || result.ReasonCode != "core_owned_path" {
		t.Fatalf("managed path alias result = %+v err=%v", result, err)
	}
}

func TestGuardDeniesDirectHumanAuthorityHookInvocation(t *testing.T) {
	t.Parallel()
	projectDir, _ := guardFixture(t)
	for index, command := range []string{
		"./.codex/tools/aidlc hook receipt . codex",
		".codex/tools/aidlc hook freeze . codex",
		".codex/tools/aidlc hook subagent . --harness codex",
	} {
		input := guardJSON(t, projectDir, "Bash", "call-authority-hook", command)
		result, err := Guard(context.Background(), projectDir, strings.NewReader(input), Options{})
		if err != nil || !result.Denied || result.ReasonCode != "hook_handler_invocation" {
			t.Fatalf("command %d result = %+v err=%v", index, result, err)
		}
	}
}

func TestGuardRejectsMalformedAndSymlinkedPatchPaths(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require Windows developer mode")
	}
	projectDir, _ := guardFixture(t)
	malformed := guardJSON(t, projectDir, "apply_patch", "call-malformed", "*** Begin Patch\n*** End Patch")
	result, err := Guard(context.Background(), projectDir, strings.NewReader(malformed), Options{})
	if err != nil || !result.Denied || result.ReasonCode != "invalid_patch" {
		t.Fatalf("malformed result = %+v err=%v", result, err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(projectDir, "escape")); err != nil {
		t.Fatal(err)
	}
	symlinked := guardJSON(t, projectDir, "apply_patch", "call-symlink", "*** Begin Patch\n*** Add File: escape/private.txt\n+secret\n*** End Patch")
	result, err = Guard(context.Background(), projectDir, strings.NewReader(symlinked), Options{})
	if err != nil || !result.Denied || result.ReasonCode != "invalid_patch" {
		t.Fatalf("symlink result = %+v err=%v", result, err)
	}
}

func TestGuardWithoutActiveIntentIsNoOp(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	if _, err := workspace.Initialize(projectDir, filepath.Join(repositoryRoot(t), "core", "memory")); err != nil {
		t.Fatal(err)
	}
	input := guardJSON(t, projectDir, "apply_patch", "call-no-active", "*** Begin Patch\n*** Add File: aidlc/anything.json\n+{}\n*** End Patch")
	result, err := Guard(context.Background(), projectDir, strings.NewReader(input), Options{})
	if err != nil || result.Denied {
		t.Fatalf("result = %+v err=%v", result, err)
	}
	content, err := MarshalResponse(result)
	if err != nil || len(content) != 0 {
		t.Fatalf("response = %q err=%v", content, err)
	}
}

func TestGuardFailsClosedForInvalidActiveIntentPointer(t *testing.T) {
	t.Parallel()
	projectDir, born := guardFixture(t)
	pointer := filepath.Join(filepath.Dir(born.RecordDir), "active-intent")
	if err := os.WriteFile(pointer, []byte("../invalid\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	input := guardJSON(t, projectDir, "apply_patch", "call-invalid-active", "*** Begin Patch\n*** Add File: proposal.json\n+{}\n*** End Patch")
	if _, err := Guard(context.Background(), projectDir, strings.NewReader(input), Options{}); err == nil {
		t.Fatal("Guard treated an invalid active Intent pointer as no active Intent")
	}
}

func TestST06AllowsOnlyCurrentBoltTargetsViaApplyPatch(t *testing.T) {
	t.Parallel()
	projectDir, born := guardFixture(t)
	worktree := configureST06(t, projectDir, born)
	allowed := guardJSON(t, worktree, "apply_patch", "call-st06-allowed", "*** Begin Patch\n*** Add File: src/new.go\n+package src\n*** End Patch")
	result, err := Guard(context.Background(), projectDir, strings.NewReader(allowed), Options{})
	if err != nil || result.Denied {
		t.Fatalf("allowed result = %+v err=%v", result, err)
	}
	outside := guardJSON(t, worktree, "apply_patch", "call-st06-outside", "*** Begin Patch\n*** Add File: README.md\n+outside\n*** End Patch")
	result, err = Guard(context.Background(), projectDir, strings.NewReader(outside), Options{})
	if err != nil || !result.Denied || result.ReasonCode != "st06_target_scope" {
		t.Fatalf("outside result = %+v err=%v", result, err)
	}
	bash := guardJSON(t, worktree, "Bash", "call-st06-bash", "gofmt -w src/new.go")
	result, err = Guard(context.Background(), projectDir, strings.NewReader(bash), Options{})
	if err != nil || !result.Denied || result.ReasonCode != "st06_bash_mutation" {
		t.Fatalf("Bash result = %+v err=%v", result, err)
	}
}

func TestGuardInvalidDeliveryReturnsErrorForCLIFailClosedResponse(t *testing.T) {
	t.Parallel()
	projectDir, _ := guardFixture(t)
	if _, err := Guard(context.Background(), projectDir, strings.NewReader(`{"hook_event_name":"PostToolUse"}`), Options{}); err == nil {
		t.Fatal("Guard accepted invalid delivery")
	}
	content := MarshalFailureResponse()
	assertDenyShape(t, content)
	if bytes.Contains(content, []byte("PostToolUse")) {
		t.Fatalf("failure response leaked input: %s", content)
	}
}

func TestConcurrentAuditAndGuardRecordDistinctRedactedEvidence(t *testing.T) {
	t.Parallel()
	projectDir, born := guardFixture(t)
	relative, err := filepath.Rel(projectDir, state.StatePath(born.RecordDir))
	if err != nil {
		t.Fatal(err)
	}
	secret := "SECRET CONCURRENT PATCH"
	input := guardJSON(t, projectDir, "apply_patch", "call-concurrent", "*** Begin Patch\n*** Update File: "+filepath.ToSlash(relative)+"\n@@\n-old\n+"+secret+"\n*** End Patch")
	var wait sync.WaitGroup
	failures := make(chan error, 2)
	wait.Add(2)
	go func() {
		defer wait.Done()
		result, guardErr := Guard(context.Background(), projectDir, strings.NewReader(input), Options{})
		if guardErr == nil && !result.Denied {
			guardErr = errors.New("Guard did not deny protected concurrent patch")
		}
		failures <- guardErr
	}()
	go func() {
		defer wait.Done()
		_, auditErr := hookaudit.Record(context.Background(), projectDir, strings.NewReader(input), hookaudit.RecordOptions{})
		failures <- auditErr
	}()
	wait.Wait()
	close(failures)
	for current := range failures {
		if current != nil {
			t.Fatal(current)
		}
	}
	status, err := hookaudit.Inspect(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if status.Entries != 2 || status.UniqueEvents != 2 || status.DuplicateEvents != 0 {
		t.Fatalf("status = %+v", status)
	}
	entries, err := os.ReadDir(status.JournalDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		content, readErr := os.ReadFile(filepath.Join(status.JournalDir, entry.Name()))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if bytes.Contains(content, []byte(secret)) {
			t.Fatalf("concurrent Hook evidence leaked patch body: %s", content)
		}
	}
}

func configureST06(t *testing.T, projectDir string, born intent.BornWithState) string {
	t.Helper()
	snapshot, err := state.Read(born.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.State.CurrentStage = contract.Stage06
	snapshot.State.Status = state.Ready
	snapshot.State.ParkedReason = nil
	snapshot.State.UpdatedAt = "2026-08-27T00:01:00.000Z"
	if err := state.Store(context.Background(), projectDir, born.RecordDir, snapshot.State, snapshot.Plan); err != nil {
		t.Fatal(err)
	}
	worktree := filepath.Join(st06build.RootDir(born.RecordDir), "worktrees", "repo-1", "bolt-001", "attempt-000001")
	if err := os.MkdirAll(filepath.Join(worktree, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	boltID := "BOLT-001"
	session := st06build.Session{
		SchemaVersion: 1, Artifact: "build-session", Version: 1,
		SessionID: "build-session-1", IntentID: born.UUID, StageID: contract.Stage06,
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

func guardFixture(t *testing.T) (string, intent.BornWithState) {
	t.Helper()
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(root, "core", "memory")); err != nil {
		t.Fatal(err)
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, filepath.Join(root, "core"), "Hook Guard", "default", intent.BirthWorkflowOptions{
		Identity: intent.Options{
			Clock: func() time.Time { return time.Date(2026, 8, 27, 0, 0, 0, 0, time.UTC) },
			UUID:  func() (string, error) { return "0198e7d0-0000-7000-8000-000000000003", nil },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, born
}

func guardJSON(t *testing.T, cwd, tool, toolUseID, command string) string {
	t.Helper()
	content, err := json.Marshal(map[string]any{
		"session_id": "thr-guard", "turn_id": "turn-guard", "cwd": cwd,
		"hook_event_name": "PreToolUse", "tool_name": tool, "tool_use_id": toolUseID,
		"tool_input": map[string]any{"command": command},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func assertDenyShape(t *testing.T, content []byte) {
	t.Helper()
	var output map[string]any
	if err := json.Unmarshal(content, &output); err != nil {
		t.Fatal(err)
	}
	if len(output) != 1 {
		t.Fatalf("response = %s", content)
	}
	specific, ok := output["hookSpecificOutput"].(map[string]any)
	if !ok || len(specific) != 3 || specific["hookEventName"] != "PreToolUse" || specific["permissionDecision"] != "deny" {
		t.Fatalf("response = %s", content)
	}
}

func fixedClock() time.Time {
	return time.Date(2026, 8, 27, 2, 3, 4, 567000000, time.UTC)
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}
