package workspace

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/sori883/aidlc/internal/platform/fsx"
)

// DefaultSpace is the always-valid initial Space.
const DefaultSpace = "default"

var (
	slugSeparators = regexp.MustCompile(`[^a-z0-9]+`)
	trimDashes     = regexp.MustCompile(`^-+|-+$`)
	trailingDashes = regexp.MustCompile(`-+$`)
	spaceName      = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
	reservedNames  = map[string]struct{}{
		"help": {}, "list": {}, "switch": {}, "birth": {}, "create": {},
		"archive": {}, "rename": {}, "show": {},
	}
)

// Result describes an idempotent Workspace initialization.
type Result struct {
	ProjectDir     string
	WorkspaceDir   string
	ActiveSpace    string
	CreatedFiles   []string
	PreservedFiles []string
}

// Initialize creates the minimum vNext Workspace without overwriting user files.
func Initialize(projectDir, memorySourceDir string) (Result, error) {
	resolvedProjectDir, err := filepath.Abs(projectDir)
	if err != nil {
		return Result{}, fmt.Errorf("resolve Project directory: %w", err)
	}
	resolvedProjectDir = filepath.Clean(resolvedProjectDir)
	resolvedMemorySource, err := filepath.Abs(memorySourceDir)
	if err != nil {
		return Result{}, fmt.Errorf("resolve Memory source directory: %w", err)
	}
	resolvedMemorySource = filepath.Clean(resolvedMemorySource)
	if err := requireDirectory(resolvedProjectDir, "Project directory"); err != nil {
		return Result{}, err
	}
	if err := requireDirectory(resolvedMemorySource, "Memory source directory"); err != nil {
		return Result{}, err
	}

	result := Result{
		ProjectDir:   resolvedProjectDir,
		WorkspaceDir: Root(resolvedProjectDir),
	}
	if _, err := fsx.EnsureDirUnder(resolvedProjectDir, "aidlc", 0o755); err != nil {
		return Result{}, fmt.Errorf("create Workspace directory: %w", err)
	}
	activeSpacePath := filepath.Join(result.WorkspaceDir, "active-space")
	if err := writeFileIfMissing(activeSpacePath, []byte(DefaultSpace+"\n"), &result); err != nil {
		return Result{}, err
	}
	activeSpaceBytes, err := os.ReadFile(activeSpacePath)
	if err != nil {
		return Result{}, fmt.Errorf("read active space pointer: %w", err)
	}
	result.ActiveSpace = strings.TrimSpace(string(activeSpaceBytes))
	if result.ActiveSpace == "" {
		return Result{}, fmt.Errorf("Active space pointer is empty: %s", activeSpacePath)
	}

	memoryTarget := filepath.Join(result.WorkspaceDir, "spaces", DefaultSpace, "memory")
	if _, err := fsx.EnsureDirUnder(resolvedProjectDir, "aidlc/spaces/default/memory", 0o755); err != nil {
		return Result{}, fmt.Errorf("create default Memory directory: %w", err)
	}
	if err := copyMissingTree(resolvedMemorySource, memoryTarget, &result); err != nil {
		return Result{}, err
	}
	return result, nil
}

// Root returns the absolute Workspace directory beneath a Project.
func Root(projectDir string) string {
	absolute, err := filepath.Abs(projectDir)
	if err != nil {
		return filepath.Join(projectDir, "aidlc")
	}
	return filepath.Join(filepath.Clean(absolute), "aidlc")
}

// ActiveSpace returns the selected Space and defaults to DefaultSpace for a
// fresh shell, matching the existing runtime contract.
func ActiveSpace(projectDir string) string {
	pointer := filepath.Join(Root(projectDir), "active-space")
	info, statErr := os.Lstat(pointer)
	content, err := os.ReadFile(pointer)
	if statErr == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && err == nil {
		if selected := strings.TrimSpace(string(content)); selected != "" {
			if spaceName.MatchString(selected) {
				return selected
			}
		}
	}
	return DefaultSpace
}

// Slugify creates the stable ASCII record name used by Spaces and Intents.
func Slugify(value string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = 48
	}
	slug := strings.ToLower(value)
	slug = slugSeparators.ReplaceAllString(slug, "-")
	slug = trimDashes.ReplaceAllString(slug, "")
	if len(slug) > maxLength {
		slug = slug[:maxLength]
	}
	slug = trailingDashes.ReplaceAllString(slug, "")
	if slug == "" {
		return "intent"
	}
	if slug[0] < 'a' || slug[0] > 'z' {
		slug = trailingDashes.ReplaceAllString("intent-"+slug, "")
	}
	return slug
}

// IsReservedName reports whether a record name is reserved by the CLI.
func IsReservedName(value string) bool {
	_, ok := reservedNames[value]
	return ok
}

func requireDirectory(path, label string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is not a directory: %s", label, path)
	}
	return nil
}

func writeFileIfMissing(path string, content []byte, result *Result) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err == nil {
		if _, writeErr := file.Write(content); writeErr != nil {
			_ = file.Close()
			return fmt.Errorf("write Workspace file %s: %w", path, writeErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			return fmt.Errorf("close Workspace file %s: %w", path, closeErr)
		}
		result.CreatedFiles = append(result.CreatedFiles, path)
		return nil
	}
	if !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("create Workspace file %s: %w", path, err)
	}
	info, statErr := os.Lstat(path)
	if statErr != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("Workspace path must be a file: %s", path)
	}
	result.PreservedFiles = append(result.PreservedFiles, path)
	return nil
}

func copyMissingTree(sourceDir, targetDir string, result *Result) error {
	if err := ensureRealDirectory(targetDir); err != nil {
		return fmt.Errorf("create Workspace directory %s: %w", targetDir, err)
	}
	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		return fmt.Errorf("read Memory source %s: %w", sourceDir, err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.Name() == ".DS_Store" || entry.Name() == "phases" {
			continue
		}
		sourcePath := filepath.Join(sourceDir, entry.Name())
		targetPath := filepath.Join(targetDir, entry.Name())
		if entry.IsDir() {
			if err := ensureRealDirectory(targetPath); err != nil {
				return err
			}
			if err := copyMissingTree(sourcePath, targetPath, result); err != nil {
				return err
			}
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("Memory seed contains an unsupported entry: %s", sourcePath)
		}
		if err := copyFileIfMissing(sourcePath, targetPath, info.Mode().Perm(), result); err != nil {
			return err
		}
	}
	return nil
}

func ensureRealDirectory(path string) error {
	if err := os.Mkdir(path, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("create Workspace directory %s: %w", path, err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Workspace path must be a directory: %s", path)
	}
	return nil
}

func copyFileIfMissing(sourcePath, targetPath string, mode os.FileMode, result *Result) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open Memory seed %s: %w", sourcePath, err)
	}
	defer source.Close()
	target, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("create Workspace file %s: %w", targetPath, err)
		}
		info, statErr := os.Lstat(targetPath)
		if statErr != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("Workspace path must be a file: %s", targetPath)
		}
		result.PreservedFiles = append(result.PreservedFiles, targetPath)
		return nil
	}
	if _, err := io.Copy(target, source); err != nil {
		_ = target.Close()
		return fmt.Errorf("copy Memory seed to %s: %w", targetPath, err)
	}
	if err := target.Close(); err != nil {
		return fmt.Errorf("close Workspace file %s: %w", targetPath, err)
	}
	result.CreatedFiles = append(result.CreatedFiles, targetPath)
	return nil
}
