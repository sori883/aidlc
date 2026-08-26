// Package fsx provides fail-closed path and atomic filesystem primitives.
package fsx

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

var windowsAbsolute = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

// ValidateRelative validates a persisted portable Project-relative path.
func ValidateRelative(value string) error {
	if value == "" || strings.ContainsRune(value, '\x00') {
		return fmt.Errorf("path must be a non-empty Project-relative path")
	}
	if strings.Contains(value, "\\") {
		return fmt.Errorf("path must use '/' separators")
	}
	if path.IsAbs(value) || filepath.IsAbs(value) || windowsAbsolute.MatchString(value) || strings.HasPrefix(value, "//") {
		return fmt.Errorf("path must be Project-relative")
	}
	clean := path.Clean(value)
	if clean == "." || clean != value || clean == ".." || strings.HasPrefix(clean, "../") {
		return fmt.Errorf("path must be normalized and cannot traverse parents")
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("path contains an invalid segment")
		}
	}
	return nil
}

// ResolveUnder resolves a portable path below root and rejects symlink
// ancestors. The leaf may be absent when allowMissingLeaf is true.
func ResolveUnder(root, relative string, allowMissingLeaf bool) (string, error) {
	if err := ValidateRelative(relative); err != nil {
		return "", err
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve root: %w", err)
	}
	absoluteRoot = filepath.Clean(absoluteRoot)
	rootInfo, err := os.Lstat(absoluteRoot)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("root must be a real directory: %s", absoluteRoot)
	}
	cursor := absoluteRoot
	parts := strings.Split(relative, "/")
	for index, part := range parts {
		cursor = filepath.Join(cursor, part)
		info, statErr := os.Lstat(cursor)
		if errors.Is(statErr, fs.ErrNotExist) && allowMissingLeaf {
			continue
		}
		if statErr != nil {
			return "", fmt.Errorf("inspect path %s: %w", cursor, statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("symlink path is not allowed: %s", cursor)
		}
		if index < len(parts)-1 && !info.IsDir() {
			return "", fmt.Errorf("path ancestor must be a directory: %s", cursor)
		}
	}
	return cursor, nil
}

// EnsureDirUnder creates relative below root one component at a time without
// following a pre-existing symlink.
func EnsureDirUnder(root, relative string, mode os.FileMode) (string, error) {
	if err := ValidateRelative(relative); err != nil {
		return "", err
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	cursor := filepath.Clean(absoluteRoot)
	for _, part := range strings.Split(relative, "/") {
		cursor = filepath.Join(cursor, part)
		if err := os.Mkdir(cursor, mode); err != nil && !errors.Is(err, fs.ErrExist) {
			return "", fmt.Errorf("create directory %s: %w", cursor, err)
		}
		info, err := os.Lstat(cursor)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("directory path must not be a symlink: %s", cursor)
		}
	}
	return cursor, nil
}

// AtomicWriteFile writes through a same-directory temporary file and rename.
func AtomicWriteFile(target string, content []byte, mode os.FileMode) error {
	directory := filepath.Dir(target)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("atomic write parent must be a real directory: %s", directory)
	}
	temporary, err := os.CreateTemp(directory, ".aidlc-*.tmp")
	if err != nil {
		return fmt.Errorf("create atomic temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("set atomic temporary mode: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write atomic temporary file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync atomic temporary file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close atomic temporary file: %w", err)
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return fmt.Errorf("replace atomic target: %w", err)
	}
	committed = true
	if directoryHandle, err := os.Open(directory); err == nil {
		_ = directoryHandle.Sync()
		_ = directoryHandle.Close()
	}
	return nil
}
