package fsx

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestValidateRelative(t *testing.T) {
	t.Parallel()
	if err := ValidateRelative("aidlc/spaces/default"); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"", ".", "../escape", "a/../b", "/absolute", `C:\\escape`, `a\\b`, "//server/share"} {
		if ValidateRelative(invalid) == nil {
			t.Fatalf("ValidateRelative(%q) succeeded", invalid)
		}
	}
}

func TestResolveUnderRejectsSymlinkAncestor(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require Windows developer mode")
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveUnder(root, "linked/file.json", true); err == nil {
		t.Fatal("ResolveUnder() followed a symlink ancestor")
	}
}

func TestAtomicWriteFile(t *testing.T) {
	t.Parallel()
	target := filepath.Join(t.TempDir(), "state.json")
	if err := AtomicWriteFile(target, []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(target, []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "two\n" {
		t.Fatalf("content = %q, %v", content, err)
	}
	matches, err := filepath.Glob(filepath.Join(filepath.Dir(target), ".aidlc-*.tmp"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("temporary files = %v, %v", matches, err)
	}
}
