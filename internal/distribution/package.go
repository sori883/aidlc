package distribution

import (
	"bytes"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/sori883/aidlc/internal/bundle"
	"github.com/sori883/aidlc/internal/platform/jsonx"
)

type PackageOptions struct {
	RepoRoot  string
	OutputDir string
	Version   string
}

type PackageResult struct {
	OutputDir       string   `json:"output_dir"`
	ProjectDir      string   `json:"project_dir"`
	Manifest        Manifest `json:"manifest"`
	ManifestSHA256  string   `json:"manifest_sha256"`
	NativeSmoke     bool     `json:"native_smoke"`
	Checksums       string   `json:"checksums"`
	ReleaseAssetSet []string `json:"release_assets"`
}

// Package builds one reproducible candidate directory without publishing it.
func Package(ctx context.Context, options PackageOptions) (PackageResult, error) {
	repoRoot, err := filepath.Abs(options.RepoRoot)
	if err != nil {
		return PackageResult{}, err
	}
	outputDir, err := filepath.Abs(options.OutputDir)
	if err != nil {
		return PackageResult{}, err
	}
	if options.Version == "" {
		return PackageResult{}, fmt.Errorf("release version is required")
	}
	if err := prepareEmptyOutput(outputDir); err != nil {
		return PackageResult{}, err
	}
	projectDir := filepath.Join(outputDir, "project")
	if err := os.Mkdir(projectDir, 0o755); err != nil {
		return PackageResult{}, err
	}
	binaryPaths := make([]string, 0, len(Targets))
	for _, target := range Targets {
		binaryPaths = append(binaryPaths, target.ProjectPath)
	}
	projectFiles, err := bundle.Files(repoRoot, binaryPaths)
	if err != nil {
		return PackageResult{}, err
	}
	if err := bundle.Write(projectDir, projectFiles); err != nil {
		return PackageResult{}, err
	}
	fileRecords := make([]FileRecord, 0, len(projectFiles))
	for _, file := range projectFiles {
		fileRecords = append(fileRecords, FileRecord{Path: file.Path, SHA256: SHA256(file.Content), Bytes: int64(len(file.Content)), Executable: file.Executable, Area: file.Area})
	}
	binaries := make([]BinaryRecord, 0, len(Targets))
	releaseAssets := []string{ManifestAsset, "install.sh", "install.ps1"}
	nativeSmoke := false
	for _, target := range Targets {
		assetPath := filepath.Join(outputDir, target.Asset)
		if err := buildTarget(ctx, repoRoot, assetPath, target); err != nil {
			return PackageResult{}, err
		}
		content, err := os.ReadFile(assetPath)
		if err != nil {
			return PackageResult{}, err
		}
		if err := inspectBinary(assetPath, content, target); err != nil {
			return PackageResult{}, err
		}
		binaries = append(binaries, BinaryRecord{Target: target.Name, Asset: target.Asset, ProjectPath: target.ProjectPath, SHA256: SHA256(content), Bytes: int64(len(content)), GOOS: target.GOOS, GOARCH: target.GOARCH, Format: target.Format})
		releaseAssets = append(releaseAssets, target.Asset)
		if target.GOOS == runtime.GOOS && target.GOARCH == runtime.GOARCH {
			if err := smokeBinary(ctx, assetPath, options.Version); err != nil {
				return PackageResult{}, err
			}
			nativeSmoke = true
		}
	}
	if !nativeSmoke {
		return PackageResult{}, fmt.Errorf("no native target was available for smoke verification")
	}
	manifest := Manifest{Format: ManifestFormat, SchemaVersion: ManifestSchema, Version: options.Version, Repository: Repository, Tag: "v" + options.Version, ProjectRoot: ProjectRoot, Files: fileRecords, Binaries: binaries}
	if err := manifest.Validate(options.Version); err != nil {
		return PackageResult{}, err
	}
	manifestBytes, err := jsonx.MarshalCanonical(manifest)
	if err != nil {
		return PackageResult{}, err
	}
	if err := os.WriteFile(filepath.Join(outputDir, ManifestAsset), manifestBytes, 0o644); err != nil {
		return PackageResult{}, err
	}
	for _, script := range []struct {
		Source string
		Asset  string
		Mode   os.FileMode
	}{
		{Source: "installer/install.sh", Asset: "install.sh", Mode: 0o755},
		{Source: "installer/install.ps1", Asset: "install.ps1", Mode: 0o644},
	} {
		content, err := os.ReadFile(filepath.Join(repoRoot, script.Source))
		if err != nil {
			return PackageResult{}, fmt.Errorf("read bootstrap installer %s: %w", script.Source, err)
		}
		if err := os.WriteFile(filepath.Join(outputDir, script.Asset), content, script.Mode); err != nil {
			return PackageResult{}, err
		}
	}
	sort.Strings(releaseAssets)
	checksumContent, err := writeChecksums(outputDir, releaseAssets)
	if err != nil {
		return PackageResult{}, err
	}
	if err := validateCandidateEntries(outputDir, releaseAssets); err != nil {
		return PackageResult{}, err
	}
	assetSet := append(append([]string{}, releaseAssets...), ChecksumsAsset)
	return PackageResult{OutputDir: outputDir, ProjectDir: projectDir, Manifest: manifest, ManifestSHA256: SHA256(manifestBytes), NativeSmoke: true, Checksums: checksumContent, ReleaseAssetSet: assetSet}, nil
}

func SHA256(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func prepareEmptyOutput(outputDir string) error {
	if info, err := os.Lstat(outputDir); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("release output must be a real directory: %s", outputDir)
		}
		entries, err := os.ReadDir(outputDir)
		if err != nil {
			return err
		}
		if len(entries) != 0 {
			return fmt.Errorf("release output must be absent or empty: %s", outputDir)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(outputDir, 0o755)
}

func buildTarget(ctx context.Context, repoRoot, destination string, target Target) error {
	command := exec.CommandContext(ctx, "go", "build", "-trimpath", "-ldflags=-s -w", "-o", destination, "./cmd/aidlc")
	command.Dir = repoRoot
	command.Env = buildEnvironment(target)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("build %s: %w: %s", target.Name, err, output)
	}
	if target.GOOS != "windows" {
		if err := os.Chmod(destination, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func buildEnvironment(target Target) []string {
	replacements := map[string]string{"CGO_ENABLED": "0", "GOOS": target.GOOS, "GOARCH": target.GOARCH}
	if target.GOAMD64 != "" {
		replacements["GOAMD64"] = target.GOAMD64
	}
	result := make([]string, 0, len(os.Environ())+len(replacements))
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		if _, replaced := replacements[name]; !replaced {
			result = append(result, value)
		}
	}
	keys := make([]string, 0, len(replacements))
	for key := range replacements {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		result = append(result, key+"="+replacements[key])
	}
	return result
}

func inspectBinary(path string, content []byte, target Target) error {
	if int64(len(content)) <= 0 || int64(len(content)) >= MaxBinaryBytes {
		return fmt.Errorf("%s binary size %d is outside the 16MiB Gate", target.Name, len(content))
	}
	format, err := executableFormat(content)
	if err != nil || format != target.Format {
		return fmt.Errorf("%s executable format = %s, want %s: %w", target.Name, format, target.Format, err)
	}
	info, err := buildinfo.ReadFile(path)
	if err != nil || !strings.HasPrefix(info.GoVersion, "go1.26") {
		return fmt.Errorf("%s Go build info is invalid: %w", target.Name, err)
	}
	return nil
}

func executableFormat(content []byte) (string, error) {
	if len(content) < 4 {
		return "", fmt.Errorf("executable is too short")
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

func smokeBinary(ctx context.Context, path, version string) error {
	command := exec.CommandContext(ctx, path, "--version")
	command.Env = []string{"PATH="}
	output, err := command.CombinedOutput()
	if err != nil || string(output) != "aidlc "+version+"\n" {
		return fmt.Errorf("native release smoke failed: %w: %s", err, output)
	}
	return nil
}

func writeChecksums(outputDir string, assets []string) (string, error) {
	lines := make([]string, 0, len(assets))
	for _, asset := range assets {
		path := filepath.Join(outputDir, asset)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("release asset must be a regular file: %s", asset)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		lines = append(lines, SHA256(content)+"  "+asset)
	}
	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(outputDir, ChecksumsAsset), []byte(content), 0o644); err != nil {
		return "", err
	}
	return content, nil
}

func validateCandidateEntries(outputDir string, releaseAssets []string) error {
	allowed := map[string]struct{}{ChecksumsAsset: {}, "project": {}}
	for _, asset := range releaseAssets {
		allowed[asset] = struct{}{}
	}
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		return err
	}
	if len(entries) != len(allowed) {
		return fmt.Errorf("release candidate contains an unexpected or missing top-level entry")
	}
	for _, entry := range entries {
		if _, ok := allowed[entry.Name()]; !ok {
			return fmt.Errorf("release candidate contains unexpected top-level entry: %s", entry.Name())
		}
	}
	return nil
}
