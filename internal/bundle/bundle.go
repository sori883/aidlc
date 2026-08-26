// Package bundle renders the Codex project distribution from authored sources.
package bundle

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
)

const (
	LayoutFormat       = "aidlc-project-distribution"
	LayoutSchema       = 2
	LayoutManifestPath = ".codex/distribution-manifest.json"
	LauncherPath       = ".codex/tools/aidlc"
)

type File struct {
	Path       string
	Content    []byte
	Executable bool
	Area       string
}

type LayoutManifest struct {
	Format        string   `json:"format"`
	SchemaVersion int      `json:"schema_version"`
	Files         []string `json:"files"`
}

type CheckResult struct {
	Valid    bool     `json:"valid"`
	Missing  []string `json:"missing"`
	Stale    []string `json:"stale"`
	Orphaned []string `json:"orphaned"`
}

// Files renders the complete installed Codex layout except target binaries.
func Files(repoRoot string, binaryPaths []string) ([]File, error) {
	repoRoot, err := filepath.Abs(repoRoot)
	if err != nil {
		return nil, err
	}
	files := map[string]File{}
	add := func(path string, content []byte, executable bool, area string) error {
		if err := fsx.ValidateRelative(path); err != nil {
			return err
		}
		if _, exists := files[path]; exists {
			return fmt.Errorf("duplicate bundle path: %s", path)
		}
		files[path] = File{Path: path, Content: append([]byte{}, content...), Executable: executable, Area: area}
		return nil
	}
	read := func(relative string) ([]byte, error) {
		path := filepath.Join(repoRoot, filepath.FromSlash(relative))
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("bundle source must be a regular file: %s", path)
		}
		return os.ReadFile(path)
	}
	for _, source := range []struct {
		Source string
		Target string
		Area   string
	}{
		{Source: "harness/codex/AGENTS.md", Target: "AGENTS.md", Area: "harness"},
		{Source: "harness/codex/hooks.json", Target: ".codex/hooks.json", Area: "harness"},
	} {
		content, err := read(source.Source)
		if err != nil {
			return nil, err
		}
		if err := add(source.Target, content, false, source.Area); err != nil {
			return nil, err
		}
	}
	for _, tree := range []struct {
		Source string
		Target string
		Area   string
	}{
		{Source: "core/aidlc-common", Target: ".codex/aidlc-common", Area: "core"},
		{Source: "core/memory", Target: ".codex/memory", Area: "core"},
		{Source: "core/agents", Target: ".codex/agents", Area: "core"},
		{Source: "harness/codex/agents", Target: ".codex/agents", Area: "harness"},
		{Source: "harness/codex/skills", Target: ".agents/skills", Area: "harness"},
	} {
		if err := collect(repoRoot, tree.Source, tree.Target, tree.Area, add); err != nil {
			return nil, err
		}
	}
	if err := add(LauncherPath, []byte(posixLauncher), true, "harness"); err != nil {
		return nil, err
	}
	declared := make([]string, 0, len(files)+len(binaryPaths))
	for path := range files {
		declared = append(declared, path)
	}
	for _, path := range binaryPaths {
		if err := fsx.ValidateRelative(path); err != nil {
			return nil, err
		}
		if _, exists := files[path]; exists {
			return nil, fmt.Errorf("binary path collides with bundle file: %s", path)
		}
		declared = append(declared, path)
	}
	sort.Strings(declared)
	manifest := LayoutManifest{Format: LayoutFormat, SchemaVersion: LayoutSchema, Files: declared}
	content, err := jsonx.MarshalCanonical(manifest)
	if err != nil {
		return nil, err
	}
	if err := add(LayoutManifestPath, content, false, "harness"); err != nil {
		return nil, err
	}
	result := make([]File, 0, len(files))
	for _, file := range files {
		result = append(result, file)
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Path < result[right].Path })
	return result, nil
}

func collect(repoRoot, sourceRoot, targetRoot, area string, add func(string, []byte, bool, string) error) error {
	absolute := filepath.Join(repoRoot, filepath.FromSlash(sourceRoot))
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("bundle source must be a real directory: %s", absolute)
	}
	entries, err := os.ReadDir(absolute)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == ".DS_Store" {
			continue
		}
		source := filepath.Join(absolute, entry.Name())
		relativeSource := filepath.ToSlash(filepath.Join(sourceRoot, entry.Name()))
		target := filepath.ToSlash(filepath.Join(targetRoot, entry.Name()))
		entryInfo, err := os.Lstat(source)
		if err != nil || entryInfo.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsupported bundle source entry: %s", source)
		}
		if entryInfo.IsDir() {
			if err := collect(repoRoot, relativeSource, target, area, add); err != nil {
				return err
			}
			continue
		}
		if !entryInfo.Mode().IsRegular() {
			return fmt.Errorf("unsupported bundle source entry: %s", source)
		}
		content, err := os.ReadFile(source)
		if err != nil {
			return err
		}
		if err := add(target, content, false, area); err != nil {
			return err
		}
	}
	return nil
}

func Write(outDir string, files []File) error {
	previous, err := inspectWritableOutput(outDir)
	if err != nil {
		return err
	}
	if err := ensureOutputRoot(outDir); err != nil {
		return err
	}
	desired := map[string]struct{}{}
	for _, file := range files {
		desired[file.Path] = struct{}{}
		if file.Path == LayoutManifestPath {
			layout, decodeErr := DecodeLayout(file.Content)
			if decodeErr != nil {
				return decodeErr
			}
			for _, path := range layout.Files {
				desired[path] = struct{}{}
			}
		}
	}
	for _, path := range previous.Files {
		if _, keep := desired[path]; keep {
			continue
		}
		target, resolveErr := fsx.ResolveUnder(outDir, path, true)
		if resolveErr != nil {
			return resolveErr
		}
		if info, statErr := os.Lstat(target); statErr == nil {
			if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("orphaned generated path is not a regular file: %s", path)
			}
			if removeErr := os.Remove(target); removeErr != nil {
				return removeErr
			}
		} else if !os.IsNotExist(statErr) {
			return statErr
		}
	}
	for _, file := range files {
		parent := filepath.ToSlash(filepath.Dir(file.Path))
		if parent != "." {
			if _, err := fsx.EnsureDirUnder(outDir, parent, 0o755); err != nil {
				return err
			}
		}
		target, err := fsx.ResolveUnder(outDir, file.Path, true)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if file.Executable {
			mode = 0o755
		}
		if err := fsx.AtomicWriteFile(target, file.Content, mode); err != nil {
			return err
		}
	}
	return nil
}

func inspectWritableOutput(outDir string) (LayoutManifest, error) {
	empty := LayoutManifest{Files: []string{}}
	info, err := os.Lstat(outDir)
	if os.IsNotExist(err) {
		return empty, nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return LayoutManifest{}, fmt.Errorf("bundle output must be a real directory: %s", outDir)
	}
	entries, err := os.ReadDir(outDir)
	if err != nil {
		return LayoutManifest{}, err
	}
	nonMetadata := 0
	for _, entry := range entries {
		if entry.Name() != ".DS_Store" {
			nonMetadata++
		}
	}
	if nonMetadata == 0 {
		return empty, nil
	}
	manifestPath, err := fsx.ResolveUnder(outDir, LayoutManifestPath, false)
	if err != nil {
		return LayoutManifest{}, fmt.Errorf("refusing to overwrite a non-bundle directory without %s: %s", LayoutManifestPath, outDir)
	}
	content, err := os.ReadFile(manifestPath)
	if err != nil {
		return LayoutManifest{}, err
	}
	manifest, err := decodeWritableLayout(content)
	if err != nil {
		return LayoutManifest{}, fmt.Errorf("refusing to overwrite a directory with an invalid Project layout manifest: %w", err)
	}
	return manifest, nil
}

func decodeWritableLayout(content []byte) (LayoutManifest, error) {
	value, err := jsonx.Decode[LayoutManifest](content)
	if err != nil {
		return LayoutManifest{}, err
	}
	if value.Format != LayoutFormat || (value.SchemaVersion != 1 && value.SchemaVersion != LayoutSchema) || value.Files == nil {
		return LayoutManifest{}, fmt.Errorf("Project layout manifest identity is invalid")
	}
	if err := validateLayoutFiles(value.Files); err != nil {
		return LayoutManifest{}, err
	}
	return value, nil
}

func Check(outDir string, expected []File) (CheckResult, error) {
	result := CheckResult{Missing: []string{}, Stale: []string{}, Orphaned: []string{}}
	expectedByPath := map[string]File{}
	allowedDeclared := map[string]struct{}{}
	for _, file := range expected {
		expectedByPath[file.Path] = file
		if file.Path == LayoutManifestPath {
			if layout, err := DecodeLayout(file.Content); err == nil {
				for _, path := range layout.Files {
					allowedDeclared[path] = struct{}{}
				}
			}
		}
		target, err := fsx.ResolveUnder(outDir, file.Path, false)
		if err != nil {
			result.Missing = append(result.Missing, file.Path)
			continue
		}
		content, err := os.ReadFile(target)
		if err != nil || !bytes.Equal(content, file.Content) {
			result.Stale = append(result.Stale, file.Path)
		}
	}
	manifestPath, err := fsx.ResolveUnder(outDir, LayoutManifestPath, false)
	if err == nil {
		content, readErr := os.ReadFile(manifestPath)
		if readErr == nil {
			manifest, decodeErr := jsonx.Decode[LayoutManifest](content)
			if decodeErr == nil && manifest.Format == LayoutFormat && manifest.SchemaVersion == LayoutSchema {
				for _, path := range manifest.Files {
					if _, exists := expectedByPath[path]; exists {
						continue
					}
					if _, allowed := allowedDeclared[path]; allowed {
						continue
					}
					if _, statErr := fsx.ResolveUnder(outDir, path, false); statErr == nil {
						result.Orphaned = append(result.Orphaned, path)
					}
				}
			}
		}
	}
	sort.Strings(result.Missing)
	sort.Strings(result.Stale)
	sort.Strings(result.Orphaned)
	result.Valid = len(result.Missing) == 0 && len(result.Stale) == 0 && len(result.Orphaned) == 0
	return result, nil
}

func ensureOutputRoot(outDir string) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	info, err := os.Lstat(outDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("bundle output must be a real directory: %s", outDir)
	}
	return nil
}

func DecodeLayout(content []byte) (LayoutManifest, error) {
	value, err := jsonx.Decode[LayoutManifest](content)
	if err != nil {
		return LayoutManifest{}, err
	}
	if value.Format != LayoutFormat || value.SchemaVersion != LayoutSchema || value.Files == nil {
		return LayoutManifest{}, fmt.Errorf("Project layout manifest identity is invalid")
	}
	if err := validateLayoutFiles(value.Files); err != nil {
		return LayoutManifest{}, err
	}
	return value, nil
}

func validateLayoutFiles(files []string) error {
	if !sort.StringsAreSorted(files) {
		return fmt.Errorf("Project layout files must be sorted")
	}
	seen := map[string]struct{}{}
	for _, path := range files {
		if err := fsx.ValidateRelative(path); err != nil {
			return err
		}
		if _, exists := seen[path]; exists {
			return fmt.Errorf("duplicate Project layout path: %s", path)
		}
		seen[path] = struct{}{}
	}
	return nil
}

const posixLauncher = `#!/bin/sh
set -eu

tool_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
system=$(uname -s)
machine=$(uname -m)

case "$system:$machine" in
  Darwin:x86_64) binary="$tool_dir/bin/aidlc-darwin-amd64" ;;
  Darwin:arm64) binary="$tool_dir/bin/aidlc-darwin-arm64" ;;
  Linux:x86_64) binary="$tool_dir/bin/aidlc-linux-amd64" ;;
  Linux:aarch64|Linux:arm64) binary="$tool_dir/bin/aidlc-linux-arm64" ;;
  *) echo "aidlc: unsupported platform $system-$machine" >&2; exit 1 ;;
esac

if [ ! -x "$binary" ]; then
  echo "aidlc: installed binary is missing or not executable: $binary" >&2
  exit 1
fi
exec "$binary" "$@"
`
