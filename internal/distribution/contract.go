// Package distribution defines and builds the Go GitHub Release transport.
package distribution

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/sori883/aidlc/internal/platform/fsx"
)

const (
	Repository                       = "sori883/aidlc"
	ManifestFormat                   = "aidlc-github-distribution"
	ManifestSchema                   = 2
	ManifestAsset                    = "aidlc-distribution.json"
	ChecksumsAsset                   = "SHA256SUMS"
	ProjectRoot                      = "dist/project"
	InstallationFormat               = "aidlc-project-installation"
	InstallationSchema               = 2
	InstallationManifestPath         = ".codex/aidlc-installation.json"
	LegacyInstallationManifest       = ".aidlc/installation.json"
	MaxBinaryBytes             int64 = 16 * 1024 * 1024
	MaxProjectFileBytes        int64 = 16 * 1024 * 1024
)

// Target is one immutable supported Go distribution target.
type Target struct {
	Name        string
	GOOS        string
	GOARCH      string
	GOAMD64     string
	Asset       string
	ProjectPath string
	Format      string
}

var Targets = []Target{
	{Name: "darwin-amd64", GOOS: "darwin", GOARCH: "amd64", Asset: "aidlc-darwin-amd64", ProjectPath: ".codex/tools/bin/aidlc-darwin-amd64", Format: "mach-o"},
	{Name: "darwin-arm64", GOOS: "darwin", GOARCH: "arm64", Asset: "aidlc-darwin-arm64", ProjectPath: ".codex/tools/bin/aidlc-darwin-arm64", Format: "mach-o"},
	{Name: "linux-amd64", GOOS: "linux", GOARCH: "amd64", GOAMD64: "v1", Asset: "aidlc-linux-amd64", ProjectPath: ".codex/tools/bin/aidlc-linux-amd64", Format: "elf"},
	{Name: "linux-arm64", GOOS: "linux", GOARCH: "arm64", Asset: "aidlc-linux-arm64", ProjectPath: ".codex/tools/bin/aidlc-linux-arm64", Format: "elf"},
	{Name: "windows-amd64", GOOS: "windows", GOARCH: "amd64", Asset: "aidlc-windows-amd64.exe", ProjectPath: ".codex/tools/aidlc.exe", Format: "pe"},
}

type FileRecord struct {
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	Executable bool   `json:"executable"`
	Area       string `json:"area"`
}

type BinaryRecord struct {
	Target      string `json:"target"`
	Asset       string `json:"asset"`
	ProjectPath string `json:"project_path"`
	SHA256      string `json:"sha256"`
	Bytes       int64  `json:"bytes"`
	GOOS        string `json:"goos"`
	GOARCH      string `json:"goarch"`
	Format      string `json:"format"`
}

type Manifest struct {
	Format        string         `json:"format"`
	SchemaVersion int            `json:"schema_version"`
	Version       string         `json:"version"`
	Repository    string         `json:"repository"`
	Tag           string         `json:"tag"`
	ProjectRoot   string         `json:"project_root"`
	Files         []FileRecord   `json:"files"`
	Binaries      []BinaryRecord `json:"binaries"`
}

type ManagedFile struct {
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	Executable bool   `json:"executable"`
}

type InstallationDistribution struct {
	Type       string `json:"type"`
	Repository string `json:"repository"`
	Tag        string `json:"tag"`
	Target     string `json:"target"`
}

type InstallationManifest struct {
	Format        string                    `json:"format"`
	SchemaVersion int                       `json:"schema_version"`
	Version       string                    `json:"version"`
	Harness       string                    `json:"harness"`
	InstalledAt   string                    `json:"installed_at"`
	Distribution  *InstallationDistribution `json:"distribution,omitempty"`
	Files         []ManagedFile             `json:"files"`
}

var (
	hexDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)
	harnessID = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
)

func TargetByName(name string) (Target, bool) {
	for _, target := range Targets {
		if target.Name == name {
			return target, true
		}
	}
	return Target{}, false
}

func HostTarget(goos, goarch string) (Target, error) {
	for _, target := range Targets {
		if target.GOOS == goos && target.GOARCH == goarch {
			return target, nil
		}
	}
	return Target{}, fmt.Errorf("unsupported platform: %s-%s", goos, goarch)
}

func (manifest Manifest) Validate(expectedVersion string) error {
	if manifest.Format != ManifestFormat || manifest.SchemaVersion != ManifestSchema || manifest.Version != expectedVersion || manifest.Repository != Repository || manifest.Tag != "v"+expectedVersion || manifest.ProjectRoot != ProjectRoot || len(manifest.Files) > 4096 {
		return fmt.Errorf("Distribution manifest identity is invalid")
	}
	paths := map[string]struct{}{}
	previous := ""
	for _, file := range manifest.Files {
		if err := validateManagedPath(file.Path); err != nil || !hexDigest.MatchString(file.SHA256) || file.Bytes < 0 || file.Bytes > MaxProjectFileBytes || (file.Area != "core" && file.Area != "harness") || strings.HasSuffix(file.Path, ".ts") {
			return fmt.Errorf("invalid project file record: %s", file.Path)
		}
		if _, exists := paths[file.Path]; exists || (previous != "" && file.Path <= previous) {
			return fmt.Errorf("project file paths must be unique and sorted: %s", file.Path)
		}
		paths[file.Path] = struct{}{}
		previous = file.Path
	}
	if len(manifest.Binaries) != len(Targets) {
		return fmt.Errorf("Distribution manifest requires exactly %d binaries", len(Targets))
	}
	assets := map[string]struct{}{}
	targets := map[string]struct{}{}
	for index, binary := range manifest.Binaries {
		expected := Targets[index]
		if binary.Target != expected.Name || binary.Asset != expected.Asset || binary.ProjectPath != expected.ProjectPath || binary.GOOS != expected.GOOS || binary.GOARCH != expected.GOARCH || binary.Format != expected.Format || !hexDigest.MatchString(binary.SHA256) || binary.Bytes <= 0 || binary.Bytes >= MaxBinaryBytes || strings.ContainsAny(binary.Asset, `/\\`) {
			return fmt.Errorf("invalid binary record: %s", binary.Asset)
		}
		if err := validateManagedPath(binary.ProjectPath); err != nil {
			return fmt.Errorf("invalid binary project path: %s", binary.ProjectPath)
		}
		if _, exists := paths[binary.ProjectPath]; exists {
			return fmt.Errorf("duplicate installed path: %s", binary.ProjectPath)
		}
		if _, exists := assets[binary.Asset]; exists {
			return fmt.Errorf("duplicate binary asset: %s", binary.Asset)
		}
		if _, exists := targets[binary.Target]; exists {
			return fmt.Errorf("duplicate binary target: %s", binary.Target)
		}
		paths[binary.ProjectPath] = struct{}{}
		assets[binary.Asset] = struct{}{}
		targets[binary.Target] = struct{}{}
	}
	return nil
}

func (manifest InstallationManifest) Validate() error {
	if manifest.Format != InstallationFormat || (manifest.SchemaVersion != 1 && manifest.SchemaVersion != InstallationSchema) || strings.TrimSpace(manifest.Version) == "" || !harnessID.MatchString(manifest.Harness) || strings.TrimSpace(manifest.InstalledAt) == "" || manifest.Files == nil || len(manifest.Files) > 4101 {
		return fmt.Errorf("Installation manifest identity is invalid")
	}
	paths := map[string]struct{}{}
	for _, file := range manifest.Files {
		if err := validateManagedPath(file.Path); err != nil || !hexDigest.MatchString(file.SHA256) || file.Bytes < 0 {
			return fmt.Errorf("invalid managed file record: %s", file.Path)
		}
		if _, exists := paths[file.Path]; exists {
			return fmt.Errorf("duplicate managed file record: %s", file.Path)
		}
		paths[file.Path] = struct{}{}
	}
	if manifest.Distribution != nil && (manifest.Distribution.Type != "github-release" || manifest.Distribution.Repository != Repository || strings.TrimSpace(manifest.Distribution.Tag) == "" || strings.TrimSpace(manifest.Distribution.Target) == "") {
		return fmt.Errorf("Installation distribution record is invalid")
	}
	return nil
}

func validateManagedPath(value string) error {
	if err := fsx.ValidateRelative(value); err != nil {
		return err
	}
	if value == "aidlc" || strings.HasPrefix(value, "aidlc/") {
		return fmt.Errorf("distribution must not manage the user-owned aidlc Workspace")
	}
	return nil
}

func SortedManagedFiles(files []ManagedFile) []ManagedFile {
	result := append([]ManagedFile{}, files...)
	sort.Slice(result, func(left, right int) bool { return result[left].Path < result[right].Path })
	return result
}
