package st08release

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
)

func TestRollbackRestoresObservedGitRevision(t *testing.T) {
	projectDir := t.TempDir()
	repositoryRoot := filepath.Join(projectDir, "repo")
	remote := filepath.Join(projectDir, "remote.git")
	if err := os.Mkdir(repositoryRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, projectDir, "init", "--bare", remote)
	runGit(t, repositoryRoot, "init", "-b", "main")
	runGit(t, repositoryRoot, "config", "user.name", "AI-DLC Test")
	runGit(t, repositoryRoot, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(repositoryRoot, "message.txt"), []byte("before\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repositoryRoot, "add", "message.txt")
	runGit(t, repositoryRoot, "commit", "-m", "before")
	before := gitValue(t, repositoryRoot, "rev-parse", "HEAD")
	runGit(t, repositoryRoot, "remote", "add", "origin", remote)
	runGit(t, repositoryRoot, "push", "-u", "origin", "main")
	if err := os.WriteFile(filepath.Join(repositoryRoot, "message.txt"), []byte("after\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repositoryRoot, "commit", "-am", "after")
	after := gitValue(t, repositoryRoot, "rev-parse", "HEAD")
	runGit(t, repositoryRoot, "push", "origin", "main")

	repositoryID := "repo-001"
	targetID := "TARGET-001"
	plan := Plan{WorkRequestRef: testReference("release-work-request"), Targets: []Target{{ProposedTarget: ProposedTarget{TargetID: targetID, Provider: "git", CapabilityID: GitCapabilityID, RepositoryID: &repositoryID, Locator: "origin#refs/heads/main"}, ObservedBefore: before}}, Steps: []Step{{StepID: "STEP-001", TargetID: targetID, CapabilityID: GitCapabilityID, DesiredState: after}}}
	request := WorkRequest{SourceTargets: []SourceTarget{{RepositoryID: repositoryID, RepositoryRoot: "repo"}}}
	attempt := Attempt{IntentID: "intent-test", Attempt: 1}
	references := []contract.ArtifactReference{}
	if err := rollback(context.Background(), projectDir, filepath.Join(projectDir, "record"), plan, request, attempt, plan.Steps, "2026-08-26T00:00:00.000Z", &references); err != nil {
		t.Fatal(err)
	}
	if observed := strings.Fields(gitValue(t, repositoryRoot, "ls-remote", "--refs", "origin", "refs/heads/main"))[0]; observed != before {
		t.Fatalf("rollback left remote at %s, want %s", observed, before)
	}
	if len(references) != 1 {
		t.Fatalf("rollback receipts = %d, want 1", len(references))
	}
}

func testReference(artifact string) contract.ArtifactReference {
	return contract.ArtifactReference{Artifact: artifact, Version: 1, SourceOfTruth: "fixture.json", SHA256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
}

func gitValue(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}
