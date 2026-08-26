package bundle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/platform/jsonx"
)

func TestDevelopmentOnlyBeginnerHTMLHelper(t *testing.T) {
	root := repositoryRoot(t)
	agent := readRepositoryFile(t, root, ".codex/agents/beginner-html-writer.toml")
	for _, marker := range []string{
		`name = "beginner_html_writer"`,
		`sandbox_mode = "workspace-write"`,
		"$beginner-html",
		"source of truth",
		"mobile and desktop",
		"Runtime, Contract, canonical JSON",
	} {
		if !strings.Contains(agent, marker) {
			t.Fatalf("beginner HTML agent is missing %q", marker)
		}
	}
	if strings.Contains(agent, "\nmodel =") {
		t.Fatal("beginner HTML agent must inherit the parent model")
	}

	skill := readRepositoryFile(t, root, ".agents/skills/beginner-html/SKILL.md")
	for _, marker := range []string{
		"name: beginner-html",
		"beginner-facing HTML documentation",
		"source of truth",
		"single-file HTML",
		"390px",
		"scrollWidth <= clientWidth",
		"escape",
		"Runtime, Contract, or canonical JSON",
	} {
		if !strings.Contains(strings.ToLower(skill), strings.ToLower(marker)) {
			t.Fatalf("beginner HTML skill is missing %q", marker)
		}
	}
	if strings.Contains(strings.ToUpper(skill), "TODO") || strings.Contains(strings.ToUpper(skill), "PLACEHOLDER") {
		t.Fatal("beginner HTML skill contains an unfinished placeholder")
	}

	for _, excluded := range []string{
		"harness/codex/agents/beginner-html-writer.toml",
		"harness/codex/skills/beginner-html/SKILL.md",
	} {
		if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(excluded))); err == nil {
			t.Fatalf("development-only helper leaked into harness: %s", excluded)
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	harnessInstructions := readRepositoryFile(t, root, "harness/codex/AGENTS.md")
	for _, marker := range []string{"beginner_html_writer", "Beginner-facing HTML delegation"} {
		if strings.Contains(harnessInstructions, marker) {
			t.Fatalf("installed project routes to development-only helper: %s", marker)
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
