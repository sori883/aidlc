package cli

import (
	"bytes"
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
	"github.com/sori883/aidlc/internal/workflow/risk"
	"github.com/sori883/aidlc/internal/workflow/state"
)

func TestVersionHelpAndValidationOutputsMatchProductionContract(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "version", args: []string{"--version"}, want: "aidlc 1.0.0\n"},
		{
			name: "help",
			args: []string{"help"},
			want: "aidlc <noun> <command> [args]\n\n" +
				"Common commands:\n" +
				"  aidlc next [args]       resolve the next Workflow action\n" +
				"  aidlc install [options] install AI-DLC into a Project\n" +
				"  aidlc update [options]  safely update an installed Project\n" +
				"  aidlc doctor check      diagnose the active Workspace\n" +
				"  aidlc state resume      show the persisted resume point\n" +
				"  aidlc --help            show this help\n" +
				"  aidlc --version         show the AI-DLC version\n",
		},
		{
			name: "graph validate",
			args: []string{"graph", "validate"},
			want: `{"valid":true,"workflow":"vnext","catalog_version":"vnext-stage-catalog-v1","graph_version":"vnext-10-stage-graph-v1"}` + "\n",
		},
		{
			name: "delegation validate",
			args: []string{"delegation", "validate"},
			want: "{\n" +
				"  \"valid\": true,\n" +
				"  \"schema_version\": 1,\n" +
				"  \"catalog_version\": \"1.0.0\",\n" +
				"  \"stage_count\": 10\n" +
				"}\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			code := RunWithOptions(test.args, &stdout, &stderr, Options{CoreDir: repositoryCoreDir(t)})
			if code != 0 {
				t.Fatalf("RunWithOptions() code = %d, stderr = %q", code, stderr.String())
			}
			if got := stdout.String(); got != test.want {
				t.Fatalf("stdout = %q, want %q", got, test.want)
			}
			if stderr.Len() != 0 {
				t.Fatalf("stderr = %q, want empty", stderr.String())
			}
		})
	}
}

func TestDelegationShowMatchesCanonicalFieldOrder(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := RunWithOptions(
		[]string{"delegation", "show", "ST-05", "work"},
		&stdout,
		&stderr,
		Options{CoreDir: repositoryCoreDir(t)},
	)
	if code != 0 {
		t.Fatalf("RunWithOptions() code = %d, stderr = %q", code, stderr.String())
	}
	want := "{\n" +
		"  \"topology\": \"mob\",\n" +
		"  \"lead_agent\": \"aidlc-build-planner-agent\",\n" +
		"  \"support_agents\": [\n" +
		"    \"aidlc-developer-agent\"\n" +
		"  ],\n" +
		"  \"reviewer_agent\": \"aidlc-quality-agent\",\n" +
		"  \"reviewer_max_iterations\": 2,\n" +
		"  \"required_skills\": [\n" +
		"    \"aidlc-stage-work\"\n" +
		"  ],\n" +
		"  \"optional_skill_policy\": \"task-matched\",\n" +
		"  \"mutation_scope\": \"proposal-only\",\n" +
		"  \"nested_delegation\": false\n" +
		"}\n"
	if got := stdout.String(); got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestWorkspaceInitIsIdempotentAndPreservesFiles(t *testing.T) {
	t.Parallel()

	projectDir := t.TempDir()
	options := Options{CoreDir: repositoryCoreDir(t)}
	var firstOut bytes.Buffer
	var firstErr bytes.Buffer
	if code := RunWithOptions([]string{"workspace", "init", projectDir}, &firstOut, &firstErr, options); code != 0 {
		t.Fatalf("first init code = %d, stderr = %q", code, firstErr.String())
	}
	if !strings.Contains(firstOut.String(), "(8 files created, 0 preserved).") {
		t.Fatalf("first init stdout = %q", firstOut.String())
	}
	orgPath := filepath.Join(projectDir, "aidlc", "spaces", "default", "memory", "org.md")
	if err := os.WriteFile(orgPath, []byte("# User rules\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var secondOut bytes.Buffer
	var secondErr bytes.Buffer
	if code := RunWithOptions([]string{"workspace", "init", projectDir}, &secondOut, &secondErr, options); code != 0 {
		t.Fatalf("second init code = %d, stderr = %q", code, secondErr.String())
	}
	if !strings.Contains(secondOut.String(), "(0 files created, 8 preserved).") {
		t.Fatalf("second init stdout = %q", secondOut.String())
	}
	if got, err := os.ReadFile(orgPath); err != nil || string(got) != "# User rules\n" {
		t.Fatalf("org.md = %q, %v", got, err)
	}
}

func TestSpaceRoutesMatchBaseline(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	options := Options{CoreDir: repositoryCoreDir(t)}
	runOK := func(args []string) string {
		t.Helper()
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := RunWithOptions(args, &stdout, &stderr, options); code != 0 {
			t.Fatalf("RunWithOptions(%q) code=%d stderr=%q", args, code, stderr.String())
		}
		return stdout.String()
	}
	runOK([]string{"workspace", "init", projectDir})
	if got, want := runOK([]string{"space", "list", projectDir, "--json"}), `{"active":"default","spaces":[{"name":"default","active":true}]}`+"\n"; got != want {
		t.Fatalf("initial list = %q, want %q", got, want)
	}
	if got, want := runOK([]string{"space", "create", projectDir, "Team A"}), "Space created: team-a\n"; got != want {
		t.Fatalf("create = %q, want %q", got, want)
	}
	if got, want := runOK([]string{"space", "switch", projectDir, "Team A"}), "Active space → team-a\n"; got != want {
		t.Fatalf("switch = %q, want %q", got, want)
	}
	if got, want := runOK([]string{"space", "list", projectDir}), "Spaces:\n  default\n* team-a\n"; got != want {
		t.Fatalf("list = %q, want %q", got, want)
	}
}

func TestIntentListAndSwitchRoutesMatchBaseline(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	options := Options{CoreDir: repositoryCoreDir(t)}
	runOK := func(args []string) string {
		t.Helper()
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := RunWithOptions(args, &stdout, &stderr, options); code != 0 {
			t.Fatalf("RunWithOptions(%q) code=%d stderr=%q", args, code, stderr.String())
		}
		return stdout.String()
	}
	runOK([]string{"workspace", "init", projectDir})
	if got, want := runOK([]string{"intent", "list", projectDir, "--json"}), `{"active":null,"space":"default","intents":[]}`+"\n"; got != want {
		t.Fatalf("empty list = %q, want %q", got, want)
	}
	born, err := intent.BirthRecord(context.Background(), projectDir, "Payment API", "default", []string{"app"}, intent.Options{
		Clock: func() time.Time { return time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC) },
		UUID:  func() (string, error) { return "0198e26a-0000-7000-8000-000000000001", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"active":"260826-payment-api","space":"default","intents":[{"uuid":"0198e26a-0000-7000-8000-000000000001","slug":"payment-api","status":"in-flight","repos":["app"],"dirName":"260826-payment-api","active":true}]}` + "\n"
	if got := runOK([]string{"intent", "list", projectDir, "--json"}); got != wantJSON {
		t.Fatalf("list = %q, want %q", got, wantJSON)
	}
	if got, want := runOK([]string{"intent", "switch", projectDir, born.DirName}), "Active intent → 260826-payment-api (space: default)\n"; got != want {
		t.Fatalf("switch = %q, want %q", got, want)
	}
}

func TestStage4WorkflowCoreRoutes(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	options := Options{CoreDir: repositoryCoreDir(t)}
	runOK := func(args []string) string {
		t.Helper()
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := RunWithOptions(args, &stdout, &stderr, options); code != 0 {
			t.Fatalf("RunWithOptions(%q) code=%d stderr=%q stdout=%q", args, code, stderr.String(), stdout.String())
		}
		return stdout.String()
	}
	runOK([]string{"workspace", "init", projectDir})
	birthOutput := runOK([]string{"intent", "birth", projectDir, "Payment API"})
	var born struct {
		State struct {
			CurrentStage string `json:"current_stage"`
			Status       string `json:"status"`
		} `json:"state"`
		Plan struct {
			StageDecisions []json.RawMessage `json:"stage_decisions"`
		} `json:"plan"`
	}
	if err := json.Unmarshal([]byte(birthOutput), &born); err != nil {
		t.Fatal(err)
	}
	if born.State.CurrentStage != "ST-00" || born.State.Status != "parked" || len(born.Plan.StageDecisions) != 10 {
		t.Fatalf("born = %+v", born)
	}
	if got, want := runOK([]string{"state", "check", projectDir}), "{\"valid\":true,\"workflow\":\"vnext\"}\n"; got != want {
		t.Fatalf("state check = %q, want %q", got, want)
	}
	var next struct {
		Kind              string `json:"kind"`
		Stage             string `json:"stage"`
		DecisionAuthority string `json:"decision_authority"`
	}
	if err := json.Unmarshal([]byte(runOK([]string{"next", projectDir})), &next); err != nil {
		t.Fatal(err)
	}
	if next.Kind != "advanced" || next.Stage != "ST-01" || next.DecisionAuthority != "core" {
		t.Fatalf("next = %+v", next)
	}
	var report struct {
		Healthy bool `json:"healthy"`
	}
	if err := json.Unmarshal([]byte(runOK([]string{"doctor", "check", projectDir})), &report); err != nil {
		t.Fatal(err)
	}
	if !report.Healthy {
		t.Fatal("doctor reported unhealthy Stage 4 Intent")
	}
}

func TestHookTurnDoesNotAddPersistentAuditEntry(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	runtimeDir := t.TempDir()
	options := Options{CoreDir: repositoryCoreDir(t), HookRuntimeDir: runtimeDir}
	runOK := func(args []string) string {
		t.Helper()
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := RunWithOptions(args, &stdout, &stderr, options); code != 0 {
			t.Fatalf("RunWithOptions(%q) code=%d stderr=%q", args, code, stderr.String())
		}
		return stdout.String()
	}
	runOK([]string{"workspace", "init", projectDir})
	runOK([]string{"intent", "birth", projectDir, "Hook CLI"})

	payload, err := json.Marshal(map[string]any{
		"session_id": "thr-cli", "turn_id": "turn-cli", "cwd": projectDir,
		"hook_event_name": "UserPromptSubmit", "prompt": "must not be persisted",
	})
	if err != nil {
		t.Fatal(err)
	}
	var turnOut bytes.Buffer
	var turnErr bytes.Buffer
	turnOptions := options
	turnOptions.Stdin = bytes.NewReader(payload)
	if code := RunWithOptions([]string{"hook", "turn", projectDir, "--harness", "codex"}, &turnOut, &turnErr, turnOptions); code != 0 {
		t.Fatalf("hook turn code=%d stderr=%q", code, turnErr.String())
	}
	if turnOut.Len() != 0 || turnErr.Len() != 0 {
		t.Fatalf("hook turn stdout=%q stderr=%q", turnOut.String(), turnErr.String())
	}
	var receiptOut bytes.Buffer
	var receiptErr bytes.Buffer
	receiptOptions := options
	receiptOptions.Stdin = bytes.NewReader(payload)
	if code := RunWithOptions([]string{"hook", "receipt", projectDir, "--harness", "codex"}, &receiptOut, &receiptErr, receiptOptions); code != 0 {
		t.Fatalf("hook receipt code=%d stderr=%q", code, receiptErr.String())
	}
	if receiptOut.Len() != 0 || receiptErr.Len() != 0 {
		t.Fatalf("ordinary hook receipt stdout=%q stderr=%q", receiptOut.String(), receiptErr.String())
	}
	markerCount := 0
	if err := filepath.WalkDir(runtimeDir, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			markerCount++
			content, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if len(content) != 0 || strings.Contains(path, "thr-cli") || strings.Contains(path, "turn-cli") {
				t.Fatalf("marker path=%q content=%q", path, content)
			}
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if markerCount != 1 {
		t.Fatalf("marker count = %d", markerCount)
	}

	var status struct {
		Active       bool `json:"active"`
		Entries      int  `json:"entries"`
		UniqueEvents int  `json:"unique_events"`
		Latest       *struct {
			Kind      string `json:"kind"`
			SessionID string `json:"session_id"`
		} `json:"latest"`
		HandlerHealth struct {
			Present bool `json:"present"`
			Entries []struct {
				Handler     string `json:"handler"`
				SourceEvent string `json:"source_event"`
				Invocations int    `json:"invocations"`
			} `json:"entries"`
		} `json:"handler_health"`
	}
	if err := json.Unmarshal([]byte(runOK([]string{"hook", "status", projectDir})), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Active || status.Entries != 0 || status.UniqueEvents != 0 || status.Latest != nil {
		t.Fatalf("hook status = %+v", status)
	}
	if status.HandlerHealth.Present || len(status.HandlerHealth.Entries) != 0 {
		t.Fatalf("hook health = %+v", status.HandlerHealth)
	}
}

func TestHookInjectRouteEmitsEventSpecificContext(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	options := Options{CoreDir: repositoryCoreDir(t)}
	runOK := func(args []string) string {
		t.Helper()
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := RunWithOptions(args, &stdout, &stderr, options); code != 0 {
			t.Fatalf("RunWithOptions(%q) code=%d stderr=%q", args, code, stderr.String())
		}
		return stdout.String()
	}
	runOK([]string{"workspace", "init", projectDir})
	runOK([]string{"intent", "birth", projectDir, "Hook Context CLI"})

	payload, err := json.Marshal(map[string]any{
		"session_id": "thr-inject-cli", "cwd": projectDir,
		"hook_event_name": "SessionStart", "source": "startup",
		"prompt": "SECRET CLI PROMPT",
	})
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	injectOptions := options
	injectOptions.Stdin = bytes.NewReader(payload)
	code := RunWithOptions([]string{"hook", "inject", projectDir, "--harness", "codex"}, &stdout, &stderr, injectOptions)
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("hook inject code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var output struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatal(err)
	}
	if output.HookSpecificOutput.HookEventName != "SessionStart" || !strings.Contains(output.HookSpecificOutput.AdditionalContext, "Current Stage: ST-00") {
		t.Fatalf("hook output = %+v", output)
	}
	if strings.Contains(output.HookSpecificOutput.AdditionalContext, "SECRET CLI PROMPT") {
		t.Fatalf("Hook context leaked prompt: %s", output.HookSpecificOutput.AdditionalContext)
	}
}

func TestHookGuardRouteDeniesProtectedPatchAndFailsClosed(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	options := Options{CoreDir: repositoryCoreDir(t)}
	runOK := func(args []string) {
		t.Helper()
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := RunWithOptions(args, &stdout, &stderr, options); code != 0 {
			t.Fatalf("RunWithOptions(%q) code=%d stderr=%q", args, code, stderr.String())
		}
	}
	runOK([]string{"workspace", "init", projectDir})
	runOK([]string{"intent", "birth", projectDir, "Hook Guard CLI"})
	inspection, err := state.InspectActive(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(projectDir, state.StatePath(inspection.RecordDir))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"session_id": "thr-guard-cli", "turn_id": "turn-guard-cli", "cwd": projectDir,
		"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "tool_use_id": "call-guard-cli",
		"tool_input": map[string]any{"command": "*** Begin Patch\n*** Update File: " + filepath.ToSlash(relative) + "\n@@\n-secret\n+SECRET CLI PATCH\n*** End Patch"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	guardOptions := options
	guardOptions.Stdin = bytes.NewReader(payload)
	if code := RunWithOptions([]string{"hook", "guard", projectDir, "--harness", "codex"}, &stdout, &stderr, guardOptions); code != 0 || stderr.Len() != 0 {
		t.Fatalf("hook guard code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), `"permissionDecision":"deny"`) || strings.Contains(stdout.String(), "SECRET CLI PATCH") || strings.Contains(stdout.String(), "updatedInput") {
		t.Fatalf("hook guard stdout=%q", stdout.String())
	}

	stdout.Reset()
	stderr.Reset()
	guardOptions.Stdin = strings.NewReader("not-json SECRET INVALID INPUT")
	if code := RunWithOptions([]string{"hook", "guard", projectDir, "--harness", "codex"}, &stdout, &stderr, guardOptions); code != 0 || stderr.Len() != 0 {
		t.Fatalf("fail-closed guard code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), `"permissionDecision":"deny"`) || strings.Contains(stdout.String(), "SECRET INVALID INPUT") {
		t.Fatalf("fail-closed stdout=%q", stdout.String())
	}
}

func TestHumanGateCLIRoundTripRequiresCodexReceipt(t *testing.T) {
	projectDir := t.TempDir()
	workingDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	gateProjectArg, err := filepath.Rel(workingDir, projectDir)
	if err != nil {
		t.Fatal(err)
	}
	options := Options{CoreDir: repositoryCoreDir(t)}
	runOK := func(args []string, stdin []byte) string {
		t.Helper()
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		callOptions := options
		if stdin != nil {
			callOptions.Stdin = bytes.NewReader(stdin)
		}
		if code := RunWithOptions(args, &stdout, &stderr, callOptions); code != 0 {
			t.Fatalf("RunWithOptions(%q) code=%d stdout=%q stderr=%q", args, code, stdout.String(), stderr.String())
		}
		return stdout.String()
	}
	runOK([]string{"workspace", "init", projectDir}, nil)
	riskFile := filepath.Join(t.TempDir(), "risks.json")
	if err := os.WriteFile(riskFile, []byte(`[{"risk_id":"risk-1","severity":"high","statement":"A human must explicitly dismiss this test risk.","evidence_refs":[]}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	var born intent.BornWithState
	if err := json.Unmarshal([]byte(runOK([]string{"intent", "birth", projectDir, "Human Gate CLI", "--risk-file", riskFile}, nil)), &born); err != nil {
		t.Fatal(err)
	}
	_, subjectRef, _, err := risk.ReadCurrent(projectDir, born.RecordDir)
	if err != nil {
		t.Fatal(err)
	}
	proposalPath := filepath.Join(t.TempDir(), "human-action.json")
	proposal := humanapproval.ActionProposal{
		SchemaVersion: 1, Artifact: "human-action-proposal", Version: 1,
		IntentID: born.UUID, Scope: humanapproval.ScopeRisk, SubjectSHA256: subjectRef.SHA256,
		Action: string(risk.Dismiss), Reason: "The reviewer explicitly accepts this test risk.",
		Parameters: json.RawMessage(`{"decision_id":"dismiss-risk-1","risk_id":"risk-1","evidence_refs":[]}`), ProposedBy: "ai",
	}
	proposalBytes, err := json.Marshal(proposal)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(proposalPath, proposalBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	var prepared humanapproval.PrepareResult
	if err := json.Unmarshal([]byte(runOK([]string{"human-gate", "prepare", gateProjectArg, proposalPath}, nil)), &prepared); err != nil {
		t.Fatal(err)
	}
	if prepared.Confirmation == "" || !strings.HasPrefix(prepared.Confirmation, "/aidlc-confirm ") {
		t.Fatalf("prepared = %+v", prepared)
	}

	stopPayload, _ := json.Marshal(map[string]any{
		"session_id": "session-cli-gate", "turn_id": "turn-stop-before", "cwd": projectDir, "hook_event_name": "Stop",
	})
	if output := runOK([]string{"hook", "freeze", projectDir, "--harness", "codex"}, stopPayload); !strings.Contains(output, `"continue":false`) {
		t.Fatalf("pending Stop output = %q", output)
	}
	confirmationPayload, _ := json.Marshal(map[string]any{
		"session_id": "session-cli-gate", "turn_id": "turn-confirm", "cwd": projectDir,
		"hook_event_name": "UserPromptSubmit", "prompt": prepared.Confirmation,
	})
	receiptOutput := runOK([]string{"hook", "receipt", projectDir, "--harness", "codex"}, confirmationPayload)
	if !strings.Contains(receiptOutput, "human-gate apply") {
		t.Fatalf("receipt Hook output = %q", receiptOutput)
	}
	current, _, _, err := humanapproval.ReadCurrent(projectDir, born.RecordDir)
	if err != nil || current.ReceiptRef == nil {
		t.Fatalf("current Receipt = %+v, %v", current, err)
	}
	applyOutput := runOK([]string{"human-gate", "apply", gateProjectArg, current.ReceiptRef.SHA256}, nil)
	if !strings.Contains(applyOutput, `"action": "dismiss"`) || !strings.Contains(applyOutput, `"status": "dismissed"`) {
		t.Fatalf("apply output = %q", applyOutput)
	}
	register, _, _, err := risk.ReadCurrent(projectDir, born.RecordDir)
	if err != nil || len(register.Risks) != 1 || register.Risks[0].Status != risk.Dismissed {
		t.Fatalf("Risk after apply = %+v, %v", register, err)
	}
	if output := runOK([]string{"hook", "freeze", projectDir, "--harness", "codex"}, stopPayload); output != "{}\n" {
		t.Fatalf("resolved Stop output = %q", output)
	}

	var replayOut bytes.Buffer
	var replayErr bytes.Buffer
	if code := RunWithOptions([]string{"human-gate", "apply", gateProjectArg, current.ReceiptRef.SHA256}, &replayOut, &replayErr, options); code == 0 || replayOut.Len() != 0 || !strings.Contains(replayErr.String(), "no pending") {
		t.Fatalf("replay code=%d stdout=%q stderr=%q", code, replayOut.String(), replayErr.String())
	}
	var directOut bytes.Buffer
	var directErr bytes.Buffer
	if code := RunWithOptions([]string{"intent", "risk", "decide", projectDir, "legacy.json"}, &directOut, &directErr, options); code == 0 || directOut.Len() != 0 || !strings.Contains(directErr.String(), "Direct human Risk decisions are disabled") {
		t.Fatalf("legacy code=%d stdout=%q stderr=%q", code, directOut.String(), directErr.String())
	}
	var doctorReport struct {
		Healthy bool `json:"healthy"`
	}
	if err := json.Unmarshal([]byte(runOK([]string{"doctor", "check", gateProjectArg}, nil)), &doctorReport); err != nil || !doctorReport.Healthy {
		t.Fatalf("relative-path Doctor report = %+v, %v", doctorReport, err)
	}
}

func TestInvalidCommandsFailWithoutStdout(t *testing.T) {
	t.Parallel()

	tests := [][]string{
		{"--version", "extra"},
		{"graph", "nope"},
		{"delegation", "show", "ST-99"},
		{"hook", "inject", "."},
		{"hook", "guard", "."},
		{"hook", "record", "."},
		{"hook", "status"},
		{"workspace", "init", "one", "two"},
		{"doctor", "check"},
	}
	for _, args := range tests {
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := RunWithOptions(args, &stdout, &stderr, Options{CoreDir: repositoryCoreDir(t)}); code == 0 {
			t.Fatalf("RunWithOptions(%q) succeeded", args)
		}
		if stdout.Len() != 0 {
			t.Fatalf("RunWithOptions(%q) stdout = %q, want empty", args, stdout.String())
		}
		if stderr.Len() == 0 {
			t.Fatalf("RunWithOptions(%q) stderr is empty", args)
		}
	}
}

func repositoryCoreDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "core"))
}
