package version

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestReleaseVersionAndGoCutoverSourcesStayConsistent(t *testing.T) {
	root := repositoryRoot(t)
	for path, marker := range map[string]string{
		"installer/install.sh":  `version="` + Version + `"`,
		"installer/install.ps1": `$version = "` + Version + `"`,
		"README.md":             "/releases/download/v" + Version + "/install.sh",
	} {
		content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(content), marker) {
			t.Fatalf("%s does not contain canonical version marker %q", path, marker)
		}
	}
	for _, retired := range []string{
		"package.json",
		"bun.lock",
		"tsconfig.json",
		"core/tools/aidlc.ts",
		"core/tools/aidlc-graph.ts",
		"core/tools/aidlc-scope-loader.ts",
		"core/tools/aidlc-state.ts",
		"core/tools/aidlc-doctor.ts",
		"core/tools/aidlc-orchestrate.ts",
		"core/tools/aidlc-executor.ts",
		"core/tools/aidlc-stage-loader.ts",
		"core/tools/aidlc-sensor.ts",
		"core/tools/aidlc-worktree.ts",
		"core/tools/aidlc-unit-graph.ts",
		"core/tools/contracts",
		"core/tools/data",
		"core/knowledge",
		"core/sensors",
		"core/hooks",
		"harness/codex/hooks/aidlc-sensor-fire.ts",
		"installer/aidlc-install.ts",
		"dist/codex",
	} {
		hasFiles, err := treeHasFiles(filepath.Join(root, filepath.FromSlash(retired)))
		if err != nil {
			t.Fatal(err)
		}
		if hasFiles {
			t.Fatalf("retired runtime path still exists: %s", retired)
		}
	}

	docs, err := os.ReadDir(filepath.Join(root, "docs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range docs {
		if strings.HasPrefix(entry.Name(), "aidlc-v2-") {
			t.Fatalf("retired v2 document remains: %s", entry.Name())
		}
	}
	readme, err := os.ReadFile(filepath.Join(root, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	readmeText := string(readme)
	if !strings.Contains(readmeText, "# AI-DLC vNext for Codex") {
		t.Fatal("README does not identify the vNext release")
	}
	for _, retired := range []string{"32 stages", "32 Stage", "Scopeの選び方", "AI-DLC v2"} {
		if strings.Contains(readmeText, retired) {
			t.Fatalf("README contains retired identity %q", retired)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "docs", "aidlc-vnext-1.0.0-release-notes.md")); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseWorkflowsKeepNativeAndImmutableBoundaries(t *testing.T) {
	root := repositoryRoot(t)
	mainWorkflow := readRepositoryFile(t, root, ".github/workflows/ci-main.yml")
	for _, marker := range []string{
		`go-version: "1.26.4"`,
		"go test -race -count=1 ./...",
		"stage2-poc",
		"TestPackageBuildsFiveTargetReleaseCandidate",
		"linux-amd64",
		"linux-arm64",
		"darwin-amd64",
		"darwin-arm64",
		"windows-amd64",
	} {
		if !strings.Contains(mainWorkflow, marker) {
			t.Fatalf("main workflow is missing %q", marker)
		}
	}
	for _, retired := range []string{"setup-bun", "bun run", "bun test"} {
		if strings.Contains(strings.ToLower(mainWorkflow), retired) {
			t.Fatalf("main workflow still configures Bun: %s", retired)
		}
	}

	releaseWorkflow := readRepositoryFile(t, root, ".github/workflows/release-github.yml")
	for _, marker := range []string{
		`go-version: "1.26.4"`,
		"git merge-base --is-ancestor",
		"--workflow ci-main.yml",
		"gh release view",
		"go run ./cmd/aidlc-dev package-release",
		"build/github-release/SHA256SUMS",
		"build/github-release/aidlc-distribution.json",
		"build/github-release/aidlc-darwin-amd64",
		"build/github-release/aidlc-darwin-arm64",
		"build/github-release/aidlc-linux-amd64",
		"build/github-release/aidlc-linux-arm64",
		"build/github-release/aidlc-windows-amd64.exe",
		"build/github-release/install.sh",
		"build/github-release/install.ps1",
	} {
		if !strings.Contains(releaseWorkflow, marker) {
			t.Fatalf("release workflow is missing %q", marker)
		}
	}
	for _, retired := range []string{"setup-bun", "bun run", "bun test"} {
		if strings.Contains(strings.ToLower(releaseWorkflow), retired) {
			t.Fatalf("release workflow still configures Bun: %s", retired)
		}
	}
	if strings.Contains(releaseWorkflow, "build/github-release/*") {
		t.Fatal("release workflow uploads assets through a mutable glob")
	}
}

func treeHasFiles(path string) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return true, nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		hasFiles, err := treeHasFiles(filepath.Join(path, entry.Name()))
		if err != nil {
			return false, err
		}
		if hasFiles {
			return true, nil
		}
	}
	return false, nil
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
