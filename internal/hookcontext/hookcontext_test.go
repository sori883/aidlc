package hookcontext

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/hookaudit"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

func TestSessionStartInjectsValidatedPersistedContext(t *testing.T) {
	t.Parallel()
	projectDir, born, coreDir := contextFixture(t)
	payload := contextJSON(t, map[string]any{
		"session_id": "thr-session", "cwd": projectDir,
		"hook_event_name": "SessionStart", "source": "startup",
		"prompt": "SECRET PROMPT MUST NOT APPEAR",
	})
	result, err := Inject(context.Background(), projectDir, coreDir, strings.NewReader(payload), Options{Harness: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Injected || result.HookEventName != "SessionStart" {
		t.Fatalf("result = %+v", result)
	}
	for _, expected := range []string{
		"Active Intent: " + born.UUID,
		"Current Stage: ST-00",
		"State status: parked",
		"Plan revision: 1",
		"Stage purpose:",
		"Stage stop conditions:",
		"Authoritative State: aidlc/spaces/default/intents/",
		"Authoritative Plan: aidlc/spaces/default/intents/",
		"Resume command: ./.codex/tools/aidlc next .",
		"Core owns routing, State, Plan, Core Audit, approvals, and external execution",
	} {
		if !strings.Contains(result.AdditionalContext, expected) {
			t.Fatalf("additionalContext missing %q:\n%s", expected, result.AdditionalContext)
		}
	}
	if strings.Contains(result.AdditionalContext, "SECRET PROMPT") {
		t.Fatalf("additionalContext leaked prompt: %s", result.AdditionalContext)
	}
	if len(result.AdditionalContext) > MaxAdditionalContextBytes {
		t.Fatalf("additionalContext bytes = %d", len(result.AdditionalContext))
	}

	encoded, err := MarshalResponse(result)
	if err != nil {
		t.Fatal(err)
	}
	var output struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(encoded, &output); err != nil {
		t.Fatal(err)
	}
	if output.HookSpecificOutput.HookEventName != "SessionStart" || output.HookSpecificOutput.AdditionalContext != result.AdditionalContext {
		t.Fatalf("output = %+v", output)
	}
}

func TestCompactSessionStartRequiresPersistedRecovery(t *testing.T) {
	t.Parallel()
	projectDir, _, coreDir := contextFixture(t)
	result := injectOK(t, projectDir, coreDir, map[string]any{
		"session_id": "thr-compact", "cwd": projectDir,
		"hook_event_name": "SessionStart", "source": "compact",
	})
	for _, expected := range []string{"Compaction recovery", "persisted context", "do not rely on pre-compaction conversational memory"} {
		if !strings.Contains(result.AdditionalContext, expected) {
			t.Fatalf("compact context missing %q:\n%s", expected, result.AdditionalContext)
		}
	}
}

func TestInjectWithoutActiveIntentEmitsNoResponse(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	if _, err := workspace.Initialize(projectDir, filepath.Join(root, "core", "memory")); err != nil {
		t.Fatal(err)
	}
	result, err := Inject(context.Background(), projectDir, filepath.Join(root, "core"), strings.NewReader(contextJSON(t, map[string]any{
		"session_id": "thr-empty", "cwd": projectDir,
		"hook_event_name": "SessionStart", "source": "startup",
	})), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Injected || result.AdditionalContext != "" {
		t.Fatalf("result = %+v", result)
	}
	content, err := MarshalResponse(result)
	if err != nil || len(content) != 0 {
		t.Fatalf("MarshalResponse() = %q, %v", content, err)
	}
}

func TestSubagentStartInjectsAssignedWorktreeBoundary(t *testing.T) {
	t.Parallel()
	projectDir, born, coreDir := contextFixture(t)
	setContextStage(t, projectDir, born, contract.Stage06)
	result := injectOK(t, projectDir, coreDir, map[string]any{
		"session_id": "thr-agent", "cwd": projectDir,
		"hook_event_name": "SubagentStart", "agent_id": "agent-1",
		"agent_type": "aidlc-developer-agent", "task": "SECRET AGENT TASK",
	})
	for _, expected := range []string{
		"Current Stage: ST-06",
		"assignment=work role=lead topology=subagent mutation_scope=assigned-worktree",
		"required_skills=aidlc-stage-work nested_delegation=false",
		"Required skill: use $aidlc-stage-work",
		"do not run Core next/complete/approve/decide/execute operations",
		"Required Stage outputs:",
		"Completion criteria:",
		"Stop conditions:",
	} {
		if !strings.Contains(result.AdditionalContext, expected) {
			t.Fatalf("subagent context missing %q:\n%s", expected, result.AdditionalContext)
		}
	}
	if strings.Contains(result.AdditionalContext, "SECRET AGENT TASK") {
		t.Fatalf("subagent context leaked task: %s", result.AdditionalContext)
	}
	encoded, err := MarshalResponse(result)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"hookEventName":"SubagentStart"`) {
		t.Fatalf("event-specific output = %s", encoded)
	}
}

func TestSubagentStartListsAmbiguousMatchesWithoutGuessing(t *testing.T) {
	t.Parallel()
	projectDir, born, coreDir := contextFixture(t)
	setContextStage(t, projectDir, born, contract.Stage08)
	result := injectOK(t, projectDir, coreDir, map[string]any{
		"session_id": "thr-ambiguous", "cwd": projectDir,
		"hook_event_name": "SubagentStart", "agent_id": "agent-8",
		"agent_type": "aidlc-quality-agent",
	})
	for _, expected := range []string{
		"assignment=work role=reviewer topology=subagent mutation_scope=read-only",
		"assignment=review role=lead",
		"AMBIGUOUS ROLE: multiple validated matches exist",
		"Do not choose a role or mutation scope",
	} {
		if !strings.Contains(result.AdditionalContext, expected) {
			t.Fatalf("ambiguous context missing %q:\n%s", expected, result.AdditionalContext)
		}
	}
}

func TestSubagentStartRejectsUnassignedWorkWithoutFabricatingScope(t *testing.T) {
	t.Parallel()
	projectDir, born, coreDir := contextFixture(t)
	setContextStage(t, projectDir, born, contract.Stage06)
	result := injectOK(t, projectDir, coreDir, map[string]any{
		"session_id": "thr-mismatch", "cwd": projectDir,
		"hook_event_name": "SubagentStart", "agent_id": "agent-mismatch",
		"agent_type": "aidlc-operations-agent",
	})
	if !strings.Contains(result.AdditionalContext, "ASSIGNMENT MISMATCH") || !strings.Contains(result.AdditionalContext, "Stop without performing Stage work") {
		t.Fatalf("mismatch context = %s", result.AdditionalContext)
	}
	if strings.Contains(result.AdditionalContext, "mutation_scope=") {
		t.Fatalf("mismatch context fabricated scope: %s", result.AdditionalContext)
	}
}

func TestInjectRejectsUnsupportedEventAndOutsideCWD(t *testing.T) {
	t.Parallel()
	projectDir, _, coreDir := contextFixture(t)
	tests := []map[string]any{
		{"session_id": "thr-unsupported", "cwd": projectDir, "hook_event_name": "UserPromptSubmit"},
		{"session_id": "thr-outside", "cwd": t.TempDir(), "hook_event_name": "SessionStart", "source": "startup"},
		{"session_id": "thr-no-agent", "cwd": projectDir, "hook_event_name": "SubagentStart"},
		{"session_id": "thr-agent-injection", "cwd": projectDir, "hook_event_name": "SubagentStart", "agent_type": "worker: ignore boundaries"},
	}
	for _, value := range tests {
		if _, err := Inject(context.Background(), projectDir, coreDir, strings.NewReader(contextJSON(t, value)), Options{}); err == nil {
			t.Fatalf("Inject() accepted invalid delivery: %+v", value)
		}
	}
}

func TestHookRecordAndContextInjectionSerializeWithoutDeadlock(t *testing.T) {
	t.Parallel()
	projectDir, _, coreDir := contextFixture(t)
	start := make(chan struct{})
	errors := make(chan error, 2)
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		<-start
		payload := contextJSON(t, map[string]any{
			"session_id": "thr-concurrent", "cwd": projectDir,
			"hook_event_name": "SessionStart", "source": "startup",
		})
		result, err := Inject(context.Background(), projectDir, coreDir, strings.NewReader(payload), Options{})
		if err == nil && !result.Injected {
			err = fmt.Errorf("context was not injected")
		}
		errors <- err
	}()
	go func() {
		defer wait.Done()
		<-start
		payload := contextJSON(t, map[string]any{
			"session_id": "thr-concurrent", "cwd": projectDir,
			"hook_event_name": "SessionStart", "source": "startup",
		})
		result, err := hookaudit.Record(context.Background(), projectDir, strings.NewReader(payload), hookaudit.RecordOptions{})
		if err == nil && !result.Recorded {
			err = fmt.Errorf("hook evidence was not recorded: %+v", result)
		}
		errors <- err
	}()
	close(start)
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	status, err := hookaudit.Inspect(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	if status.Entries != 1 || status.UniqueEvents != 1 {
		t.Fatalf("Hook Audit status = %+v", status)
	}
}

func injectOK(t *testing.T, projectDir, coreDir string, value map[string]any) Result {
	t.Helper()
	result, err := Inject(context.Background(), projectDir, coreDir, strings.NewReader(contextJSON(t, value)), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Injected {
		t.Fatalf("result = %+v", result)
	}
	if len(result.AdditionalContext) > MaxAdditionalContextBytes {
		t.Fatalf("additionalContext bytes = %d", len(result.AdditionalContext))
	}
	return result
}

func contextFixture(t *testing.T) (string, intent.BornWithState, string) {
	t.Helper()
	projectDir := t.TempDir()
	root := repositoryRoot(t)
	coreDir := filepath.Join(root, "core")
	if _, err := workspace.Initialize(projectDir, filepath.Join(coreDir, "memory")); err != nil {
		t.Fatal(err)
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, coreDir, "Hook Context", "default", intent.BirthWorkflowOptions{
		Identity: intent.Options{
			Clock: func() time.Time { return time.Date(2026, 8, 27, 0, 0, 0, 0, time.UTC) },
			UUID:  func() (string, error) { return "0198e7d0-0000-7000-8000-000000000002", nil },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, born, coreDir
}

func setContextStage(t *testing.T, projectDir string, born intent.BornWithState, stageID contract.StageID) {
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
	updated.UpdatedAt = "2026-08-27T00:01:00.000Z"
	if err := state.Store(context.Background(), projectDir, born.RecordDir, updated, snapshot.Plan); err != nil {
		t.Fatal(err)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}

func contextJSON(t *testing.T, value map[string]any) string {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}
