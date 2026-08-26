// Package installer downloads, plans, and applies a conflict-safe Project installation.
package installer

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/distribution"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
)

type SourceFile struct {
	Path       string
	Content    []byte
	SHA256     string
	Executable bool
}

type DownloadedDistribution struct {
	Manifest   distribution.Manifest
	HostBinary distribution.BinaryRecord
	Files      []SourceFile
}

type PreviousInstallation struct {
	Manifest     distribution.InstallationManifest
	Path         string
	LegacyLayout bool
}

type PathState struct {
	Kind   string
	SHA256 string
}

type Plan struct {
	Written   []string                   `json:"written"`
	Unchanged []string                   `json:"unchanged"`
	Removed   []string                   `json:"removed"`
	Conflicts []string                   `json:"conflicts"`
	NextFiles []distribution.ManagedFile `json:"next_files"`
}

type Options struct {
	Command     string
	ProjectDir  string
	Harness     string
	DryRun      bool
	InstalledAt string
	ReleaseRoot string
	ProjectRoot string
	Transport   TransportOptions
}

type Result struct {
	Command            string   `json:"command"`
	Version            string   `json:"version"`
	Project            string   `json:"project"`
	Executable         string   `json:"executable"`
	DistributionTarget string   `json:"distribution_target"`
	Written            []string `json:"written"`
	Unchanged          []string `json:"unchanged"`
	Removed            []string `json:"removed"`
	Conflicts          []string `json:"conflicts"`
	DryRun             bool     `json:"dry_run"`
}

func Run(ctx context.Context, options Options) (Result, error) {
	if options.Command != "install" && options.Command != "update" {
		return Result{}, fmt.Errorf("Installer command must be install or update")
	}
	if options.Harness == "" {
		options.Harness = "codex"
	}
	if options.Harness != "codex" {
		return Result{}, fmt.Errorf("unsupported Harness: %s", options.Harness)
	}
	projectDir, err := filepath.Abs(options.ProjectDir)
	if err != nil {
		return Result{}, err
	}
	if err := assertSafeProject(projectDir); err != nil {
		return Result{}, err
	}
	previous, err := ReadPrevious(projectDir)
	if err != nil {
		return Result{}, err
	}
	if options.Command == "update" && previous == nil {
		return Result{}, fmt.Errorf("AI-DLC is not installed; run the install command first")
	}
	transport := options.Transport
	if options.ReleaseRoot != "" {
		transport.ReleaseRoot = options.ReleaseRoot
	}
	if options.ProjectRoot != "" {
		transport.ProjectRoot = options.ProjectRoot
	}
	downloaded, err := Download(ctx, transport)
	if err != nil {
		return Result{}, err
	}
	plan, err := PlanInstallation(downloaded.Files, previous, func(path string) PathState { return InspectPath(projectDir, path) })
	if err != nil {
		return Result{}, err
	}
	executable := ".codex/tools/aidlc"
	if downloaded.HostBinary.GOOS == "windows" {
		executable = ".codex/tools/aidlc.exe"
	}
	result := Result{Command: options.Command, Version: downloaded.Manifest.Version, Project: projectDir, Executable: executable, DistributionTarget: downloaded.HostBinary.Target, Written: plan.Written, Unchanged: plan.Unchanged, Removed: plan.Removed, Conflicts: plan.Conflicts, DryRun: options.DryRun}
	if len(plan.Conflicts) == 0 && !options.DryRun {
		at := options.InstalledAt
		if at == "" {
			at = time.Now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		}
		if err := Apply(projectDir, options.Harness, at, downloaded, previous, plan); err != nil {
			return Result{}, err
		}
	}
	return result, nil
}

func PlanInstallation(sources []SourceFile, previous *PreviousInstallation, inspect func(string) PathState) (Plan, error) {
	previousFiles := map[string]distribution.ManagedFile{}
	if previous != nil {
		for _, file := range previous.Manifest.Files {
			previousFiles[file.Path] = file
		}
	}
	sourcePaths := map[string]struct{}{}
	plan := Plan{Written: []string{}, Unchanged: []string{}, Removed: []string{}, Conflicts: []string{}, NextFiles: []distribution.ManagedFile{}}
	for _, source := range sources {
		if err := fsx.ValidateRelative(source.Path); err != nil || source.Path == "aidlc" || strings.HasPrefix(source.Path, "aidlc/") || distribution.SHA256(source.Content) != source.SHA256 {
			return Plan{}, fmt.Errorf("invalid installation source: %s", source.Path)
		}
		if _, exists := sourcePaths[source.Path]; exists {
			return Plan{}, fmt.Errorf("duplicate installation source: %s", source.Path)
		}
		sourcePaths[source.Path] = struct{}{}
		state := inspect(source.Path)
		switch {
		case state.Kind == "missing":
			plan.Written = append(plan.Written, source.Path)
		case state.Kind == "file" && state.SHA256 == source.SHA256:
			plan.Unchanged = append(plan.Unchanged, source.Path)
		case state.Kind == "file" && previousFiles[source.Path].SHA256 == state.SHA256:
			plan.Written = append(plan.Written, source.Path)
		default:
			plan.Conflicts = append(plan.Conflicts, source.Path)
		}
		plan.NextFiles = append(plan.NextFiles, distribution.ManagedFile{Path: source.Path, SHA256: source.SHA256, Bytes: int64(len(source.Content)), Executable: source.Executable})
	}
	if previous != nil {
		for _, managed := range previous.Manifest.Files {
			if _, exists := sourcePaths[managed.Path]; exists {
				continue
			}
			state := inspect(managed.Path)
			if state.Kind == "missing" {
				continue
			}
			if state.Kind == "file" && state.SHA256 == managed.SHA256 {
				plan.Removed = append(plan.Removed, managed.Path)
			} else {
				plan.Conflicts = append(plan.Conflicts, managed.Path)
			}
		}
	}
	sort.Strings(plan.Written)
	sort.Strings(plan.Unchanged)
	sort.Strings(plan.Removed)
	sort.Strings(plan.Conflicts)
	plan.NextFiles = distribution.SortedManagedFiles(plan.NextFiles)
	return plan, nil
}

func Apply(projectDir, harness, installedAt string, downloaded DownloadedDistribution, previous *PreviousInstallation, plan Plan) error {
	if len(plan.Conflicts) != 0 {
		return fmt.Errorf("cannot apply an installation plan with conflicts")
	}
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		return err
	}
	if err := assertSafeProject(projectDir); err != nil {
		return err
	}
	fresh, err := PlanInstallation(downloaded.Files, previous, func(path string) PathState { return InspectPath(projectDir, path) })
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(fresh.Written, plan.Written) || !reflect.DeepEqual(fresh.Unchanged, plan.Unchanged) || !reflect.DeepEqual(fresh.Removed, plan.Removed) || len(fresh.Conflicts) != 0 {
		return fmt.Errorf("installation target changed after planning")
	}
	written := make(map[string]struct{}, len(plan.Written))
	for _, path := range plan.Written {
		written[path] = struct{}{}
	}
	for _, source := range downloaded.Files {
		if _, ok := written[source.Path]; !ok {
			continue
		}
		if err := writeProjectFile(projectDir, source); err != nil {
			return err
		}
	}
	for _, path := range plan.Removed {
		target, err := resolveProjectPath(projectDir, path, false)
		if err != nil {
			return err
		}
		if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	manifest := distribution.InstallationManifest{Format: distribution.InstallationFormat, SchemaVersion: distribution.InstallationSchema, Version: downloaded.Manifest.Version, Harness: harness, InstalledAt: installedAt, Distribution: &distribution.InstallationDistribution{Type: "github-release", Repository: downloaded.Manifest.Repository, Tag: downloaded.Manifest.Tag, Target: downloaded.HostBinary.Target}, Files: plan.NextFiles}
	if err := manifest.Validate(); err != nil {
		return err
	}
	content, err := jsonx.MarshalCanonical(manifest)
	if err != nil {
		return err
	}
	if err := writeProjectFile(projectDir, SourceFile{Path: distribution.InstallationManifestPath, Content: content, SHA256: distribution.SHA256(content)}); err != nil {
		return err
	}
	if previous != nil && previous.Path != distribution.InstallationManifestPath {
		legacy, err := resolveProjectPath(projectDir, previous.Path, false)
		if err == nil {
			if err := os.Remove(legacy); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

func ReadPrevious(projectDir string) (*PreviousInstallation, error) {
	for _, candidate := range []string{distribution.InstallationManifestPath, distribution.LegacyInstallationManifest} {
		path, err := resolveProjectPath(projectDir, candidate, true)
		if err != nil {
			return nil, err
		}
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("invalid installation manifest: %s", path)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		manifest, err := jsonx.Decode[distribution.InstallationManifest](content)
		if err != nil {
			return nil, fmt.Errorf("invalid installation manifest %s: %w", path, err)
		}
		if err := manifest.Validate(); err != nil {
			return nil, fmt.Errorf("invalid installation manifest %s: %w", path, err)
		}
		return &PreviousInstallation{Manifest: manifest, Path: candidate, LegacyLayout: candidate == distribution.LegacyInstallationManifest}, nil
	}
	return nil, nil
}

func InspectPath(projectDir, path string) PathState {
	target, err := resolveProjectPath(projectDir, path, true)
	if err != nil {
		return PathState{Kind: "unsafe"}
	}
	info, err := os.Lstat(target)
	if err != nil {
		if os.IsNotExist(err) {
			return PathState{Kind: "missing"}
		}
		return PathState{Kind: "unsafe"}
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return PathState{Kind: "other"}
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return PathState{Kind: "unsafe"}
	}
	return PathState{Kind: "file", SHA256: distribution.SHA256(content)}
}

func assertSafeProject(projectDir string) error {
	info, err := os.Lstat(projectDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Project is not a safe directory: %s", projectDir)
	}
	return nil
}

func resolveProjectPath(projectDir, path string, allowMissing bool) (string, error) {
	if err := fsx.ValidateRelative(path); err != nil {
		return "", err
	}
	if path == "aidlc" || strings.HasPrefix(path, "aidlc/") {
		return "", fmt.Errorf("Installer cannot manage user-owned Workspace path: %s", path)
	}
	if _, err := os.Lstat(projectDir); os.IsNotExist(err) {
		if allowMissing {
			return filepath.Join(projectDir, filepath.FromSlash(path)), nil
		}
		return "", err
	}
	return fsx.ResolveUnder(projectDir, path, allowMissing)
}

func writeProjectFile(projectDir string, source SourceFile) error {
	parent := filepath.ToSlash(filepath.Dir(source.Path))
	if parent != "." {
		if _, err := fsx.EnsureDirUnder(projectDir, parent, 0o755); err != nil {
			return err
		}
	}
	target, err := resolveProjectPath(projectDir, source.Path, true)
	if err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if source.Executable {
		mode = 0o755
	}
	return fsx.AtomicWriteFile(target, source.Content, mode)
}
