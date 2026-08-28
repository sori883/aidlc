package bundle

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/platform/jsonx"
)

func TestDistributedExplanatoryHTMLHelper(t *testing.T) {
	root := repositoryRoot(t)
	agent := readRepositoryFile(t, root, ".codex/agents/explanatory-html-writer.toml")
	for _, marker := range []string{
		`name = "explanatory_html_writer"`,
		`sandbox_mode = "workspace-write"`,
		"$explanatory-html",
		"assets/explanation-template.html",
		"source of truth",
		"mobile and desktop",
		"Runtime, Contract, canonical JSON",
	} {
		if !strings.Contains(agent, marker) {
			t.Fatalf("explanatory HTML agent is missing %q", marker)
		}
	}
	if strings.Contains(agent, "\nmodel =") {
		t.Fatal("explanatory HTML agent must inherit the parent model")
	}

	skill := readRepositoryFile(t, root, ".agents/skills/explanatory-html/SKILL.md")
	for _, marker := range []string{
		"name: explanatory-html",
		"explanatory HTML",
		"source of truth",
		"single-file HTML",
		"assets/explanation-template.html",
		"390px",
		"scrollWidth <= clientWidth",
		"escape",
		"Runtime, Contract, or canonical JSON",
	} {
		if !strings.Contains(strings.ToLower(skill), strings.ToLower(marker)) {
			t.Fatalf("explanatory HTML skill is missing %q", marker)
		}
	}
	if strings.Contains(strings.ToUpper(skill), "TODO") || strings.Contains(strings.ToUpper(skill), "PLACEHOLDER") {
		t.Fatal("explanatory HTML skill contains an unfinished placeholder")
	}

	template := readRepositoryFile(t, root, ".agents/skills/explanatory-html/assets/explanation-template.html")
	for _, marker := range []string{
		"<!doctype html>",
		`<html lang="ja">`,
		`<meta name="viewport"`,
		"@media(max-width:680px)",
		"@media print",
		"data-explanation-role",
	} {
		if !strings.Contains(template, marker) {
			t.Fatalf("explanatory HTML template is missing %q", marker)
		}
	}
	metadata := readRepositoryFile(t, root, ".agents/skills/explanatory-html/agents/openai.yaml")
	for _, marker := range []string{"説明HTML", "$explanatory-html", "allow_implicit_invocation: true"} {
		if !strings.Contains(metadata, marker) {
			t.Fatalf("explanatory HTML metadata is missing %q", marker)
		}
	}

	files, err := Files(root, binaryPaths())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		".codex/agents/explanatory-html-writer.toml",
		".agents/skills/explanatory-html/SKILL.md",
		".agents/skills/explanatory-html/assets/explanation-template.html",
		".agents/skills/explanatory-html/agents/openai.yaml",
	} {
		fileByPath(t, files, path)
	}

	for _, legacy := range []string{
		".codex/agents/beginner-html-writer.toml",
		".agents/skills/beginner-html/SKILL.md",
	} {
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(legacy))); err == nil {
			t.Fatalf("legacy beginner HTML path remains: %s", legacy)
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}

	harnessInstructions := readRepositoryFile(t, root, "harness/codex/AGENTS.md")
	for _, marker := range []string{"explanatory_html_writer", "Explanatory HTML delegation", "must not replace"} {
		if !strings.Contains(harnessInstructions, marker) {
			t.Fatalf("installed project is missing explanatory HTML routing %q", marker)
		}
	}
	conductorSkill := readRepositoryFile(t, root, "harness/codex/skills/aidlc/SKILL.md")
	for _, marker := range []string{"$explanatory-html", "explanatory_html_writer", "supplementary"} {
		if !strings.Contains(conductorSkill, marker) {
			t.Fatalf("Conductor Skill is missing explanatory HTML routing %q", marker)
		}
	}
}

func TestDelegationGuideCoversCanonicalAssignments(t *testing.T) {
	root := repositoryRoot(t)
	html := readRepositoryFile(t, root, "docs/aidlc-vnext-agent-delegation-guide.html")
	for _, marker := range []string{
		`<html lang="ja">`,
		`name="viewport"`,
		"vnext-stage-delegation.json",
		"Conductor",
		"Core",
		"人間",
		"aidlc-stage-work",
		"@media (max-width:",
	} {
		if !strings.Contains(html, marker) {
			t.Fatalf("delegation guide is missing %q", marker)
		}
	}

	var catalog struct {
		Stages []struct {
			StageID        string `json:"stage_id"`
			WorkAssignment *struct {
				LeadAgent string `json:"lead_agent"`
			} `json:"work_assignment"`
			ReviewAssignment *struct {
				LeadAgent string `json:"lead_agent"`
			} `json:"review_assignment"`
		} `json:"stages"`
	}
	if err := json.Unmarshal([]byte(readRepositoryFile(t, root, "core/aidlc-common/data/vnext-stage-delegation.json")), &catalog); err != nil {
		t.Fatal(err)
	}
	for _, stage := range catalog.Stages {
		if !strings.Contains(html, stage.StageID) {
			t.Fatalf("delegation guide is missing stage %s", stage.StageID)
		}
		for _, assignment := range []*struct {
			LeadAgent string `json:"lead_agent"`
		}{stage.WorkAssignment, stage.ReviewAssignment} {
			if assignment != nil && !strings.Contains(html, assignment.LeadAgent) {
				t.Fatalf("delegation guide is missing lead agent %s", assignment.LeadAgent)
			}
		}
	}
	if strings.Contains(strings.ToUpper(html), "TODO") || strings.Contains(strings.ToUpper(html), "PLACEHOLDER") {
		t.Fatal("delegation guide contains an unfinished placeholder")
	}
}

func TestFilesRenderNativeCodexProject(t *testing.T) {
	paths := binaryPaths()
	files, err := Files(repositoryRoot(t), paths)
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]File{}
	for _, file := range files {
		byPath[file.Path] = file
		if strings.HasSuffix(file.Path, ".ts") {
			t.Fatalf("TypeScript leaked into Go bundle: %s", file.Path)
		}
		if strings.HasSuffix(file.Path, ".md") && strings.Contains(string(file.Content), "run --cwd .codex") {
			t.Fatalf("legacy Runtime command leaked into %s", file.Path)
		}
	}
	launcher, ok := byPath[LauncherPath]
	if !ok || !launcher.Executable || !strings.Contains(string(launcher.Content), "aidlc-linux-arm64") {
		t.Fatalf("launcher = %+v", launcher)
	}
	for _, required := range []string{"AGENTS.md", ".codex/hooks.json", ".agents/skills/aidlc/SKILL.md", ".codex/agents/aidlc-developer-agent.toml", ".codex/aidlc-common/data/vnext-stage-catalog.json"} {
		if _, ok := byPath[required]; !ok {
			t.Fatalf("missing bundle path %s", required)
		}
	}
	layout, err := DecodeLayout(byPath[LayoutManifestPath].Content)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		if !contains(layout.Files, path) {
			t.Fatalf("layout does not declare binary %s", path)
		}
	}
}

func TestCodexHookAuditContextAndGuardWiringPreserveAuthorityBoundaries(t *testing.T) {
	root := repositoryRoot(t)
	content := readRepositoryFile(t, root, "harness/codex/hooks.json")
	var configuration struct {
		Description string `json:"description"`
		Hooks       map[string][]struct {
			Matcher  string `json:"matcher"`
			Handlers []struct {
				Type                   string `json:"type"`
				Command                string `json:"command"`
				CommandWindows         string `json:"commandWindows"`
				Timeout                int    `json:"timeout"`
				AdditionalContextLimit int    `json:"additionalContextLimit"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(content), &configuration); err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"PermissionRequest", "PostCompact", "PostToolUse", "PreCompact",
		"PreToolUse", "SessionEnd", "SessionStart", "Stop",
		"SubagentStart", "SubagentStop", "UserPromptSubmit",
	}
	actual := make([]string, 0, len(configuration.Hooks))
	for event, groups := range configuration.Hooks {
		actual = append(actual, event)
		wantGroups := 1
		if event == "PreToolUse" || event == "PostToolUse" || event == "SubagentStop" {
			wantGroups = 2
		}
		if len(groups) != wantGroups {
			t.Fatalf("%s groups = %+v", event, groups)
		}
		recorders := 0
		injectors := 0
		guards := 0
		receipts := 0
		freezes := 0
		sensors := 0
		subagents := 0
		turns := 0
		for _, group := range groups {
			for _, handler := range group.Handlers {
				if handler.Type != "command" || (handler.Timeout != 3 && handler.Timeout != 5) || !strings.Contains(handler.Command, ".codex/tools/aidlc") || !strings.Contains(handler.CommandWindows, "aidlc.exe") {
					t.Fatalf("%s handler = %+v", event, handler)
				}
				for _, required := range []string{"distribution-manifest.json", "root=$PWD", "Get-Location", "Split-Path -Parent"} {
					if !strings.Contains(handler.Command+handler.CommandWindows, required) {
						t.Fatalf("%s handler does not use ancestor Project discovery: %+v", event, handler)
					}
				}
				if strings.Contains(handler.Command+handler.CommandWindows, "git rev-parse") {
					t.Fatalf("%s handler still depends on Git root discovery: %+v", event, handler)
				}
				switch {
				case strings.Contains(handler.Command, "hook record") && strings.Contains(handler.CommandWindows, "hook record"):
					recorders++
					if handler.AdditionalContextLimit != 0 {
						t.Fatalf("%s recorder has additionalContextLimit: %+v", event, handler)
					}
				case strings.Contains(handler.Command, "hook turn") && strings.Contains(handler.CommandWindows, "hook turn"):
					turns++
					if event != "UserPromptSubmit" || handler.AdditionalContextLimit != 0 {
						t.Fatalf("%s turn = %+v", event, handler)
					}
				case strings.Contains(handler.Command, "hook inject") && strings.Contains(handler.CommandWindows, "hook inject"):
					injectors++
					if handler.AdditionalContextLimit != 12000 {
						t.Fatalf("%s injector = %+v", event, handler)
					}
				case strings.Contains(handler.Command, "hook guard") && strings.Contains(handler.CommandWindows, "hook guard"):
					guards++
					if event != "PreToolUse" || group.Matcher != "^(Bash|apply_patch)$" || handler.AdditionalContextLimit != 0 {
						t.Fatalf("%s guard = %+v matcher=%q", event, handler, group.Matcher)
					}
				case strings.Contains(handler.Command, "hook receipt") && strings.Contains(handler.CommandWindows, "hook receipt"):
					receipts++
					if event != "UserPromptSubmit" || handler.AdditionalContextLimit != 2000 {
						t.Fatalf("%s receipt = %+v", event, handler)
					}
				case strings.Contains(handler.Command, "hook freeze") && strings.Contains(handler.CommandWindows, "hook freeze"):
					freezes++
					if event != "Stop" || handler.AdditionalContextLimit != 0 {
						t.Fatalf("%s freeze = %+v", event, handler)
					}
				case strings.Contains(handler.Command, "hook sensor") && strings.Contains(handler.CommandWindows, "hook sensor"):
					sensors++
					if event != "PostToolUse" || group.Matcher != "^apply_patch$" || handler.Timeout != 5 || handler.AdditionalContextLimit != 0 {
						t.Fatalf("%s sensor = %+v matcher=%q", event, handler, group.Matcher)
					}
				case strings.Contains(handler.Command, "hook subagent") && strings.Contains(handler.CommandWindows, "hook subagent"):
					subagents++
					if event != "SubagentStop" || group.Matcher != "^aidlc-.*-agent$" || handler.Timeout != 5 || handler.AdditionalContextLimit != 0 {
						t.Fatalf("%s subagent = %+v matcher=%q", event, handler, group.Matcher)
					}
				default:
					t.Fatalf("%s contains an unknown handler: %+v", event, handler)
				}
			}
		}
		wantRecorders := 1
		wantTurns := 0
		if event == "UserPromptSubmit" {
			wantRecorders = 0
			wantTurns = 1
		}
		if recorders != wantRecorders {
			t.Fatalf("%s recorder count = %d, want %d", event, recorders, wantRecorders)
		}
		if turns != wantTurns {
			t.Fatalf("%s turn count = %d, want %d", event, turns, wantTurns)
		}
		wantInjectors := 0
		if event == "SessionStart" || event == "SubagentStart" {
			wantInjectors = 1
		}
		if injectors != wantInjectors {
			t.Fatalf("%s injector count = %d, want %d", event, injectors, wantInjectors)
		}
		wantGuards := 0
		if event == "PreToolUse" {
			wantGuards = 1
		}
		if guards != wantGuards {
			t.Fatalf("%s guard count = %d, want %d", event, guards, wantGuards)
		}
		wantReceipts := 0
		if event == "UserPromptSubmit" {
			wantReceipts = 1
		}
		if receipts != wantReceipts {
			t.Fatalf("%s receipt count = %d, want %d", event, receipts, wantReceipts)
		}
		wantFreezes := 0
		if event == "Stop" {
			wantFreezes = 1
		}
		if freezes != wantFreezes {
			t.Fatalf("%s freeze count = %d, want %d", event, freezes, wantFreezes)
		}
		wantSensors := 0
		if event == "PostToolUse" {
			wantSensors = 1
		}
		if sensors != wantSensors {
			t.Fatalf("%s sensor count = %d, want %d", event, sensors, wantSensors)
		}
		wantSubagents := 0
		if event == "SubagentStop" {
			wantSubagents = 1
		}
		if subagents != wantSubagents {
			t.Fatalf("%s subagent count = %d, want %d", event, subagents, wantSubagents)
		}
	}
	sort.Strings(actual)
	if strings.Join(actual, ",") != strings.Join(expected, ",") {
		t.Fatalf("Hook events = %v, want %v", actual, expected)
	}
	if got := configuration.Hooks["PreToolUse"][0].Matcher; got != "^(Bash|apply_patch|spawn_agent|request_user_input|update_plan)$" {
		t.Fatalf("PreToolUse matcher = %q", got)
	}
	if got := configuration.Hooks["PostToolUse"][0].Matcher; got != "^(Bash|apply_patch|spawn_agent|request_user_input|update_plan)$" {
		t.Fatalf("PostToolUse matcher = %q", got)
	}
	if got := configuration.Hooks["PostToolUse"][1].Matcher; got != "^apply_patch$" {
		t.Fatalf("PostToolUse Sensor matcher = %q", got)
	}
	if got := configuration.Hooks["SubagentStop"][1].Matcher; got != "^aidlc-.*-agent$" {
		t.Fatalf("SubagentStop result matcher = %q", got)
	}
	for _, forbidden := range []string{"permissionDecision", "updatedInput", "continue-workflow", "state-transition-guard"} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("Hook wiring contains an authority-changing field %q", forbidden)
		}
	}
}

func TestCodexHookAncestorLocatorFindsNonGitProjectFromNestedWorktree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX locator test")
	}
	root := repositoryRoot(t)
	content := readRepositoryFile(t, root, "harness/codex/hooks.json")
	var configuration struct {
		Hooks map[string][]struct {
			Handlers []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(content), &configuration); err != nil {
		t.Fatal(err)
	}
	guardCommand := configuration.Hooks["PreToolUse"][1].Handlers[0].Command
	project := filepath.Join(t.TempDir(), "project with spaces")
	nested := filepath.Join(project, "aidlc", "spaces", "default", "intents", "intent-1", "artifacts", "build", "worktrees", "repo-1", "bolt-001", "attempt-000001")
	if err := os.MkdirAll(filepath.Join(project, ".codex", "tools"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".codex", "distribution-manifest.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := "#!/bin/sh\nprintf '%s\\n' \"$*\"\n"
	if err := os.WriteFile(filepath.Join(project, ".codex", "tools", "aidlc"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("sh", "-c", guardCommand)
	command.Dir = nested
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	want := "hook guard " + project + " --harness codex\n"
	if string(output) != want {
		t.Fatalf("locator output = %q, want %q", output, want)
	}
}

func TestWriteMigratesSchemaOneProjectLayout(t *testing.T) {
	files, err := Files(repositoryRoot(t), binaryPaths())
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(filepath.Join(out, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := LayoutManifest{Format: LayoutFormat, SchemaVersion: 1, Files: []string{"AGENTS.md"}}
	content, err := jsonx.MarshalCanonical(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, filepath.FromSlash(LayoutManifestPath)), content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "AGENTS.md"), []byte("legacy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Write(out, files); err != nil {
		t.Fatal(err)
	}
	if result, err := Check(out, files); err != nil || !result.Valid {
		t.Fatalf("migrated check = %+v, %v", result, err)
	}
}

func TestWriteAndCheckDetectDriftAndSymlinkAncestors(t *testing.T) {
	files, err := Files(repositoryRoot(t), binaryPaths())
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "project")
	if err := Write(out, files); err != nil {
		t.Fatal(err)
	}
	if result, err := Check(out, files); err != nil || !result.Valid {
		t.Fatalf("check = %+v, %v", result, err)
	}
	if err := os.WriteFile(filepath.Join(out, "AGENTS.md"), []byte("tampered\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if result, err := Check(out, files); err != nil || result.Valid || !contains(result.Stale, "AGENTS.md") {
		t.Fatalf("tamper check = %+v, %v", result, err)
	}
	if err := Write(out, files); err != nil {
		t.Fatal(err)
	}
	layoutFile := fileByPath(t, files, LayoutManifestPath)
	layout, err := DecodeLayout(layoutFile.Content)
	if err != nil {
		t.Fatal(err)
	}
	layout.Files = append(layout.Files, ".codex/obsolete.txt")
	sort.Strings(layout.Files)
	manifestBytes, err := jsonx.MarshalCanonical(layout)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, filepath.FromSlash(LayoutManifestPath)), manifestBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, ".codex", "obsolete.txt"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Write(out, files); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, ".codex", "obsolete.txt")); !os.IsNotExist(err) {
		t.Fatalf("orphaned generated file remains: %v", err)
	}

	unmanaged := t.TempDir()
	if err := os.WriteFile(filepath.Join(unmanaged, "user.txt"), []byte("owned\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Write(unmanaged, files); err == nil {
		t.Fatal("bundle writer overwrote an unmanaged directory")
	}

	unsafeRoot := t.TempDir()
	if err := os.Symlink(t.TempDir(), filepath.Join(unsafeRoot, ".codex")); err != nil {
		t.Fatal(err)
	}
	if err := Write(unsafeRoot, files); err == nil {
		t.Fatal("bundle write accepted a symlink ancestor")
	}
}

func fileByPath(t *testing.T, files []File, path string) File {
	t.Helper()
	for _, file := range files {
		if file.Path == path {
			return file
		}
	}
	t.Fatalf("missing file %s", path)
	return File{}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func readRepositoryFile(t *testing.T, root, path string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func binaryPaths() []string {
	return []string{
		".codex/tools/bin/aidlc-darwin-amd64",
		".codex/tools/bin/aidlc-darwin-arm64",
		".codex/tools/bin/aidlc-linux-amd64",
		".codex/tools/bin/aidlc-linux-arm64",
		".codex/tools/aidlc.exe",
	}
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
