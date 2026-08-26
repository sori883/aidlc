package bundle

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/platform/jsonx"
)

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
		if strings.HasSuffix(file.Path, ".md") && strings.Contains(string(file.Content), "bun run --cwd .codex aidlc") {
			t.Fatalf("Bun Runtime command leaked into %s", file.Path)
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
