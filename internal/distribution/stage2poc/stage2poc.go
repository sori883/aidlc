// Package stage2poc proves the Stage 2 distribution assumptions without
// changing the tracked Production distribution.
package stage2poc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const maxBinaryBytes int64 = 16 * 1024 * 1024

// Target describes one supported Go distribution target.
type Target struct {
	Name    string
	GOOS    string
	GOARCH  string
	GOAMD64 string
	Path    string
	Format  string
}

// Targets is the fixed initial distribution matrix.
var Targets = []Target{
	{Name: "darwin-amd64", GOOS: "darwin", GOARCH: "amd64", Path: ".codex/tools/bin/aidlc-darwin-amd64", Format: "mach-o"},
	{Name: "darwin-arm64", GOOS: "darwin", GOARCH: "arm64", Path: ".codex/tools/bin/aidlc-darwin-arm64", Format: "mach-o"},
	{Name: "linux-amd64", GOOS: "linux", GOARCH: "amd64", GOAMD64: "v1", Path: ".codex/tools/bin/aidlc-linux-amd64", Format: "elf"},
	{Name: "linux-arm64", GOOS: "linux", GOARCH: "arm64", Path: ".codex/tools/bin/aidlc-linux-arm64", Format: "elf"},
	{Name: "windows-amd64", GOOS: "windows", GOARCH: "amd64", Path: ".codex/tools/aidlc.exe", Format: "pe"},
}

// Options controls a Stage 2 proof run.
type Options struct {
	RepoRoot  string
	OutputDir string
	Target    string
}

// Artifact records the evidence collected for one binary.
type Artifact struct {
	Target      string `json:"target"`
	Path        string `json:"path"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256"`
	Format      string `json:"format"`
	GoVersion   string `json:"go_version"`
	NativeSmoke bool   `json:"native_smoke"`
}

// Report records reproducible Stage 2 PoC evidence.
type Report struct {
	SchemaVersion int        `json:"schema_version"`
	Artifacts     []Artifact `json:"artifacts"`
	GitRoundTrip  bool       `json:"git_round_trip"`
}

// Run builds, inspects, commits, clones, and (for the native target) executes
// the Stage 2 CLI. It never writes to the tracked Production distribution.
func Run(ctx context.Context, options Options) (Report, error) {
	repoRoot, err := filepath.Abs(options.RepoRoot)
	if err != nil {
		return Report{}, fmt.Errorf("resolve repository root: %w", err)
	}
	outputDir, err := filepath.Abs(options.OutputDir)
	if err != nil {
		return Report{}, fmt.Errorf("resolve output directory: %w", err)
	}
	if !pathWithin(repoRoot, outputDir) {
		return Report{}, fmt.Errorf("output directory must be inside repository root: %s", outputDir)
	}
	if err := os.RemoveAll(outputDir); err != nil {
		return Report{}, fmt.Errorf("reset output directory: %w", err)
	}
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return Report{}, fmt.Errorf("create output directory: %w", err)
	}

	selected, err := selectTargets(options.Target)
	if err != nil {
		return Report{}, err
	}
	projectDir, err := os.MkdirTemp("", "aidlc-stage2-project-")
	if err != nil {
		return Report{}, fmt.Errorf("create temporary Project: %w", err)
	}
	defer os.RemoveAll(projectDir)
	if err := copyTree(filepath.Join(repoRoot, "core", "aidlc-common"), filepath.Join(projectDir, ".codex", "aidlc-common")); err != nil {
		return Report{}, err
	}
	if err := copyTree(filepath.Join(repoRoot, "core", "memory"), filepath.Join(projectDir, ".codex", "memory")); err != nil {
		return Report{}, err
	}

	report := Report{SchemaVersion: 1}
	for _, target := range selected {
		outputPath := filepath.Join(outputDir, target.Name, filepath.Base(target.Path))
		if err := build(ctx, repoRoot, outputPath, target); err != nil {
			return Report{}, err
		}
		artifact, err := inspect(outputPath, target)
		if err != nil {
			return Report{}, err
		}
		projectPath := filepath.Join(projectDir, filepath.FromSlash(target.Path))
		if err := copyFile(outputPath, projectPath, 0o755); err != nil {
			return Report{}, err
		}
		report.Artifacts = append(report.Artifacts, artifact)
	}

	cloneDir, err := gitRoundTrip(ctx, projectDir)
	if err != nil {
		return Report{}, err
	}
	defer os.RemoveAll(filepath.Dir(cloneDir))
	report.GitRoundTrip = true

	nativeName := runtime.GOOS + "-" + runtime.GOARCH
	for index := range report.Artifacts {
		if report.Artifacts[index].Target != nativeName {
			continue
		}
		target, _ := targetByName(nativeName)
		binaryPath := filepath.Join(cloneDir, filepath.FromSlash(target.Path))
		if err := smokePathless(ctx, binaryPath, cloneDir); err != nil {
			return Report{}, err
		}
		report.Artifacts[index].NativeSmoke = true
	}
	if !hasTarget(selected, nativeName) {
		return Report{}, fmt.Errorf("selected targets do not include native target %s", nativeName)
	}

	reportBytes, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return Report{}, fmt.Errorf("encode report: %w", err)
	}
	reportBytes = append(reportBytes, '\n')
	if err := os.WriteFile(filepath.Join(outputDir, "report.json"), reportBytes, 0o644); err != nil {
		return Report{}, fmt.Errorf("write report: %w", err)
	}
	return report, nil
}

func build(ctx context.Context, repoRoot, outputPath string, target Target) error {
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return fmt.Errorf("create binary directory: %w", err)
	}
	command := exec.CommandContext(ctx, "go", "build", "-trimpath", "-ldflags=-s -w", "-o", outputPath, "./cmd/aidlc")
	command.Dir = repoRoot
	command.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+target.GOOS, "GOARCH="+target.GOARCH)
	if target.GOAMD64 != "" {
		command.Env = append(command.Env, "GOAMD64="+target.GOAMD64)
	}
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("build %s: %w: %s", target.Name, err, output)
	}
	return nil
}

func inspect(path string, target Target) (Artifact, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return Artifact{}, fmt.Errorf("read %s binary: %w", target.Name, err)
	}
	if len(content) == 0 || int64(len(content)) >= maxBinaryBytes {
		return Artifact{}, fmt.Errorf("%s binary size %d must be between 1 and %d bytes", target.Name, len(content), maxBinaryBytes-1)
	}
	format, err := executableFormat(content)
	if err != nil {
		return Artifact{}, fmt.Errorf("inspect %s format: %w", target.Name, err)
	}
	if format != target.Format {
		return Artifact{}, fmt.Errorf("%s format = %s, want %s", target.Name, format, target.Format)
	}
	info, err := buildinfo.ReadFile(path)
	if err != nil {
		return Artifact{}, fmt.Errorf("read %s Go build info: %w", target.Name, err)
	}
	digest := sha256.Sum256(content)
	return Artifact{
		Target: target.Name, Path: filepath.ToSlash(path), Bytes: int64(len(content)),
		SHA256: "sha256:" + hex.EncodeToString(digest[:]), Format: format, GoVersion: info.GoVersion,
	}, nil
}

func executableFormat(content []byte) (string, error) {
	if len(content) < 4 {
		return "", errors.New("file is too short")
	}
	if bytes.Equal(content[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		return "elf", nil
	}
	if content[0] == 'M' && content[1] == 'Z' {
		return "pe", nil
	}
	magic := [4]byte{content[0], content[1], content[2], content[3]}
	for _, candidate := range [][4]byte{{0xfe, 0xed, 0xfa, 0xce}, {0xce, 0xfa, 0xed, 0xfe}, {0xfe, 0xed, 0xfa, 0xcf}, {0xcf, 0xfa, 0xed, 0xfe}} {
		if magic == candidate {
			return "mach-o", nil
		}
	}
	return "", fmt.Errorf("unknown executable magic %x", content[:4])
}

func gitRoundTrip(ctx context.Context, projectDir string) (string, error) {
	commands := [][]string{
		{"git", "init", "--quiet"},
		{"git", "config", "user.name", "AI-DLC Stage 2 PoC"},
		{"git", "config", "user.email", "stage2-poc@example.invalid"},
		{"git", "add", "."},
		{"git", "commit", "--quiet", "-m", "stage2 poc"},
	}
	for _, args := range commands {
		if err := runCommand(ctx, projectDir, os.Environ(), args[0], args[1:]...); err != nil {
			return "", err
		}
	}
	cloneParent, err := os.MkdirTemp("", "aidlc-stage2-clone-")
	if err != nil {
		return "", fmt.Errorf("create clone parent: %w", err)
	}
	cloneDir := filepath.Join(cloneParent, "project")
	if err := runCommand(ctx, "", os.Environ(), "git", "clone", "--quiet", "--no-hardlinks", projectDir, cloneDir); err != nil {
		_ = os.RemoveAll(cloneParent)
		return "", err
	}
	return cloneDir, nil
}

func smokePathless(ctx context.Context, binaryPath, projectDir string) error {
	commands := [][]string{
		{"--version"}, {"help"}, {"graph", "validate"}, {"delegation", "validate"},
	}
	for _, args := range commands {
		result, err := capture(ctx, projectDir, []string{}, binaryPath, args...)
		if err != nil || result.Code != 0 || result.Stderr != "" {
			return fmt.Errorf("PATH-less native smoke %q failed: %w; stderr=%s", args, err, result.Stderr)
		}
	}
	workspaceProject, err := os.MkdirTemp("", "aidlc-stage2-workspace-")
	if err != nil {
		return fmt.Errorf("create workspace smoke Project: %w", err)
	}
	defer os.RemoveAll(workspaceProject)
	result, err := capture(ctx, projectDir, []string{}, binaryPath, "workspace", "init", workspaceProject)
	if err != nil || result.Code != 0 || result.Stderr != "" {
		return fmt.Errorf("PATH-less workspace smoke failed: %w; stderr=%s", err, result.Stderr)
	}
	for _, args := range [][]string{
		{"space", "list", workspaceProject, "--json"},
		{"space", "create", workspaceProject, "Team A"},
		{"space", "switch", workspaceProject, "Team A"},
		{"space", "list", workspaceProject},
		{"intent", "birth", workspaceProject, "Native Workflow Gate"},
		{"state", "check", workspaceProject},
		{"doctor", "check", workspaceProject},
		{"next", workspaceProject},
	} {
		result, err := capture(ctx, projectDir, []string{}, binaryPath, args...)
		if err != nil || result.Code != 0 || result.Stderr != "" {
			return fmt.Errorf("PATH-less Space smoke %q failed: %w; stderr=%s", args, err, result.Stderr)
		}
	}
	if err := seedIntentFixture(workspaceProject); err != nil {
		return err
	}
	for _, args := range [][]string{
		{"intent", "list", workspaceProject, "--json"},
		{"intent", "switch", workspaceProject, "payment-api"},
		{"intent", "list", workspaceProject},
	} {
		result, err := capture(ctx, projectDir, []string{}, binaryPath, args...)
		if err != nil || result.Code != 0 || result.Stderr != "" {
			return fmt.Errorf("PATH-less Intent smoke %q failed: %w; stderr=%s", args, err, result.Stderr)
		}
	}
	return nil
}

type commandResult struct {
	Code   int
	Stdout string
	Stderr string
}

func seedIntentFixture(projectDir string) error {
	root := filepath.Join(projectDir, "aidlc", "spaces", "team-a", "intents")
	dirName := "260826-payment-api"
	recordDir := filepath.Join(root, dirName)
	if err := os.MkdirAll(recordDir, 0o755); err != nil {
		return fmt.Errorf("create Intent parity fixture: %w", err)
	}
	registry := []struct {
		UUID    string   `json:"uuid"`
		Slug    string   `json:"slug"`
		DirName string   `json:"dirName"`
		Repos   []string `json:"repos"`
		Status  string   `json:"status"`
	}{{
		UUID: "0198e26a-0000-7000-8000-000000000001", Slug: "payment-api",
		DirName: dirName, Repos: []string{"app"}, Status: "in-flight",
	}}
	content, err := json.MarshalIndent(registry, "", "  ")
	if err != nil {
		return err
	}
	content = append(content, '\n')
	for path, value := range map[string][]byte{
		filepath.Join(root, "intents.json"):        content,
		filepath.Join(root, "active-intent"):       []byte(dirName + "\n"),
		filepath.Join(recordDir, "aidlc-state.md"): []byte("# AI-DLC State Tracking\n"),
	} {
		if err := os.WriteFile(path, value, 0o644); err != nil {
			return fmt.Errorf("write Intent parity fixture: %w", err)
		}
	}
	return nil
}

func capture(ctx context.Context, cwd string, env []string, name string, args ...string) (commandResult, error) {
	commandCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(commandCtx, name, args...)
	command.Dir = cwd
	command.Env = env
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	code := 0
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			code = exitError.ExitCode()
		} else {
			code = -1
		}
	}
	return commandResult{Code: code, Stdout: stdout.String(), Stderr: stderr.String()}, err
}

func runCommand(ctx context.Context, cwd string, env []string, name string, args ...string) error {
	commandCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(commandCtx, name, args...)
	command.Dir = cwd
	command.Env = env
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("run %s %s: %w: %s", name, strings.Join(args, " "), err, output)
	}
	return nil
}

func selectTargets(name string) ([]Target, error) {
	if name == "" || name == "all" {
		return append([]Target(nil), Targets...), nil
	}
	target, ok := targetByName(name)
	if !ok {
		return nil, fmt.Errorf("unknown target %q", name)
	}
	return []Target{target}, nil
}

func targetByName(name string) (Target, bool) {
	for _, target := range Targets {
		if target.Name == name {
			return target, true
		}
	}
	return Target{}, false
}

func hasTarget(targets []Target, name string) bool {
	for _, target := range targets {
		if target.Name == name {
			return true
		}
	}
	return false
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func copyTree(sourceDir, targetDir string) error {
	return filepath.WalkDir(sourceDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(sourceDir, path)
		if err != nil {
			return err
		}
		targetPath := filepath.Join(targetDir, relative)
		if entry.IsDir() {
			return os.MkdirAll(targetPath, 0o755)
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported source entry: %s", path)
		}
		return copyFile(path, targetPath, info.Mode().Perm())
	})
}

func copyFile(sourcePath, targetPath string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		_ = target.Close()
		return err
	}
	return target.Close()
}
