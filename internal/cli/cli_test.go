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
)

func TestVersionHelpAndValidationOutputsMatchBaseline(t *testing.T) {
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

func TestInvalidCommandsFailWithoutStdout(t *testing.T) {
	t.Parallel()

	tests := [][]string{
		{"--version", "extra"},
		{"graph", "nope"},
		{"delegation", "show", "ST-99"},
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
