package runtimepath

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveCoreDirSupportsSourceAndInstalledLayouts(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	sourceCore := filepath.Join(root, "source", "core")
	seedCoreDir(t, sourceCore)
	got, err := ResolveCoreDir("", filepath.Join(root, "source"), func(string) string { return "" })
	if err != nil {
		t.Fatalf("ResolveCoreDir(source) error = %v", err)
	}
	if got != sourceCore {
		t.Fatalf("ResolveCoreDir(source) = %q, want %q", got, sourceCore)
	}

	installedCore := filepath.Join(root, "project", ".codex")
	seedCoreDir(t, installedCore)
	executable := filepath.Join(installedCore, "tools", "bin", "aidlc-darwin-arm64")
	got, err = ResolveCoreDir(executable, t.TempDir(), func(string) string { return "" })
	if err != nil {
		t.Fatalf("ResolveCoreDir(installed) error = %v", err)
	}
	if got != installedCore {
		t.Fatalf("ResolveCoreDir(installed) = %q, want %q", got, installedCore)
	}
}

func seedCoreDir(t *testing.T, root string) {
	t.Helper()
	for _, name := range []string{
		"vnext-stage-catalog.json",
		"vnext-stage-graph.json",
		"vnext-stage-delegation.json",
	} {
		path := filepath.Join(root, "aidlc-common", "data", name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "memory"), 0o755); err != nil {
		t.Fatal(err)
	}
}
