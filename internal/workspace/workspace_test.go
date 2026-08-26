package workspace

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInitializeMatchesWorkspaceContract(t *testing.T) {
	t.Parallel()

	projectDir := t.TempDir()
	result, err := Initialize(projectDir, repositoryMemoryDir(t))
	if err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	if result.ActiveSpace != "default" {
		t.Fatalf("active space = %q, want default", result.ActiveSpace)
	}
	if got, want := len(result.CreatedFiles), 8; got != want {
		t.Fatalf("created file count = %d, want %d", got, want)
	}
	activeSpacePath := filepath.Join(projectDir, "aidlc", "active-space")
	if got, err := os.ReadFile(activeSpacePath); err != nil || string(got) != "default\n" {
		t.Fatalf("active-space = %q, %v", got, err)
	}

	orgPath := filepath.Join(projectDir, "aidlc", "spaces", "default", "memory", "org.md")
	if err := os.WriteFile(orgPath, []byte("# User rules\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err = Initialize(projectDir, repositoryMemoryDir(t))
	if err != nil {
		t.Fatalf("Initialize() second error = %v", err)
	}
	if len(result.CreatedFiles) != 0 || len(result.PreservedFiles) != 8 {
		t.Fatalf("second result created=%d preserved=%d, want 0/8", len(result.CreatedFiles), len(result.PreservedFiles))
	}
	if got, err := os.ReadFile(orgPath); err != nil || string(got) != "# User rules\n" {
		t.Fatalf("preserved org.md = %q, %v", got, err)
	}
}

func TestInitializeRejectsSymlinkWorkspace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require Windows developer mode")
	}
	projectDir := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(projectDir, "aidlc")); err != nil {
		t.Fatal(err)
	}
	if _, err := Initialize(projectDir, repositoryMemoryDir(t)); err == nil {
		t.Fatal("Initialize() followed a symlink Workspace")
	}
}

func TestActiveSpaceDoesNotFollowSymlinkPointer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require Windows developer mode")
	}
	projectDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(projectDir, "aidlc"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("team-a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(projectDir, "aidlc", "active-space")); err != nil {
		t.Fatal(err)
	}
	if got := ActiveSpace(projectDir); got != DefaultSpace {
		t.Fatalf("ActiveSpace() = %q, want %q", got, DefaultSpace)
	}
}

func TestSlugifyMatchesStableContract(t *testing.T) {
	t.Parallel()
	tests := map[string]string{
		"  123 Payment API  ": "intent-123-payment-api",
		"---":                 "intent",
		"Team A":              "team-a",
	}
	for input, want := range tests {
		if got := Slugify(input, 48); got != want {
			t.Fatalf("Slugify(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestInitializeRejectsMissingProjectAndHostMetadata(t *testing.T) {
	t.Parallel()

	missing := filepath.Join(t.TempDir(), "missing")
	if _, err := Initialize(missing, repositoryMemoryDir(t)); err == nil {
		t.Fatal("Initialize() accepted a missing Project")
	}

	projectDir := t.TempDir()
	memorySource := t.TempDir()
	if err := os.WriteFile(filepath.Join(memorySource, "org.md"), []byte("# Org\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memorySource, ".DS_Store"), []byte("metadata"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(memorySource, "phases"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Initialize(projectDir, memorySource); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	target := filepath.Join(projectDir, "aidlc", "spaces", "default", "memory")
	if _, err := os.Stat(filepath.Join(target, ".DS_Store")); !os.IsNotExist(err) {
		t.Fatal(".DS_Store was copied")
	}
	if _, err := os.Stat(filepath.Join(target, "phases")); !os.IsNotExist(err) {
		t.Fatal("phases was copied")
	}
}

func repositoryMemoryDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "core", "memory"))
}
