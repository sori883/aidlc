package space

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/sori883/aidlc/internal/workspace"
)

func TestCreateListAndSwitch(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	memoryDir := repositoryMemoryDir(t)
	if _, err := workspace.Initialize(projectDir, memoryDir); err != nil {
		t.Fatal(err)
	}
	created, err := Create(context.Background(), projectDir, "Team A", memoryDir)
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != "team-a" {
		t.Fatalf("name = %q, want team-a", created.Name)
	}
	for _, relative := range []string{"memory/templates/.gitkeep", "intents", "codekb/.gitkeep", "knowledge/.gitkeep"} {
		if _, err := os.Stat(filepath.Join(created.SpaceDir, relative)); err != nil {
			t.Fatalf("missing %s: %v", relative, err)
		}
	}
	selected, err := Switch(context.Background(), projectDir, "Team A")
	if err != nil {
		t.Fatal(err)
	}
	if !selected.Active || workspace.ActiveSpace(projectDir) != "team-a" {
		t.Fatalf("selected = %+v, active = %q", selected, workspace.ActiveSpace(projectDir))
	}
	want := []Info{{Name: "default", Active: false}, {Name: "team-a", Active: true}}
	got := List(projectDir)
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("List() = %+v, want %+v", got, want)
	}
}

func TestCreateAndSwitchRejectInvalidTargets(t *testing.T) {
	t.Parallel()
	projectDir := t.TempDir()
	memoryDir := repositoryMemoryDir(t)
	if _, err := workspace.Initialize(projectDir, memoryDir); err != nil {
		t.Fatal(err)
	}
	if _, err := Create(context.Background(), projectDir, "switch", memoryDir); err == nil {
		t.Fatal("Create() accepted a reserved name")
	}
	if _, err := Create(context.Background(), projectDir, "default", memoryDir); err == nil {
		t.Fatal("Create() accepted an existing name")
	}
	if _, err := Switch(context.Background(), projectDir, "missing"); err == nil {
		t.Fatal("Switch() accepted an unknown Space")
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
