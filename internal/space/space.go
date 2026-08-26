// Package space manages vNext Space identity and the active pointer.
package space

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/workspace"
)

// Info describes one known Space.
type Info struct {
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

// Created describes a newly materialized Space.
type Created struct {
	Name     string
	SpaceDir string
}

// Root returns the Space collection directory.
func Root(projectDir string) string {
	return filepath.Join(workspace.Root(projectDir), "spaces")
}

// List returns sorted Space identities and their active state.
func List(projectDir string) []Info {
	selected := workspace.ActiveSpace(projectDir)
	names := map[string]struct{}{workspace.DefaultSpace: {}}
	entries, err := os.ReadDir(Root(projectDir))
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				names[entry.Name()] = struct{}{}
			}
		}
	}
	ordered := make([]string, 0, len(names))
	for name := range names {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	spaces := make([]Info, 0, len(ordered))
	for _, name := range ordered {
		spaces = append(spaces, Info{Name: name, Active: name == selected})
	}
	return spaces
}

// Create materializes a Space without inheriting team or project learning.
func Create(ctx context.Context, projectDir, rawName, memorySourceDir string) (Created, error) {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return Created{}, fmt.Errorf("resolve Project directory: %w", err)
	}
	if info, err := os.Lstat(projectRoot); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Created{}, fmt.Errorf("Project directory must not be a symlink: %s", projectRoot)
	}
	if info, err := os.Lstat(workspace.Root(projectRoot)); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Created{}, fmt.Errorf("Workspace directory must not be a symlink: %s", workspace.Root(projectRoot))
	}
	defaultSpaceDir := filepath.Join(Root(projectRoot), workspace.DefaultSpace)
	if info, err := os.Lstat(defaultSpaceDir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Created{}, fmt.Errorf("Initialize the workspace before creating a space")
	}
	name := workspace.Slugify(rawName, 48)
	if workspace.IsReservedName(name) {
		return Created{}, fmt.Errorf("%q is a reserved name and cannot be a space name", name)
	}
	spaceDir := filepath.Join(Root(projectRoot), name)
	err = lock.With(ctx, projectRoot, lock.Options{}, func(context.Context) error {
		if err := os.Mkdir(spaceDir, 0o755); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return fmt.Errorf("Space %q already exists at %s", name, spaceDir)
			}
			return fmt.Errorf("create Space: %w", err)
		}
		complete := false
		defer func() {
			if !complete {
				_ = os.RemoveAll(spaceDir)
			}
		}()
		for _, relative := range []string{"memory/templates", "intents", "codekb", "knowledge"} {
			portable := "aidlc/spaces/" + name + "/" + relative
			if _, err := fsx.EnsureDirUnder(projectRoot, portable, 0o755); err != nil {
				return err
			}
		}
		memoryTarget := filepath.Join(spaceDir, "memory")
		defaultMemory := filepath.Join(defaultSpaceDir, "memory")
		orgMarkdown, err := readFirstRegular(
			filepath.Join(defaultMemory, "org.md"), filepath.Join(memorySourceDir, "org.md"),
		)
		if err != nil {
			return err
		}
		orgPolicy, err := readFirstRegular(
			filepath.Join(defaultMemory, "org-policy.json"), filepath.Join(memorySourceDir, "org-policy.json"),
		)
		if err != nil {
			return err
		}
		files := map[string][]byte{"org.md": orgMarkdown, "org-policy.json": orgPolicy}
		for _, filename := range []string{"team.md", "project.md", "team-policy.json", "project-policy.json"} {
			content, err := readRegular(filepath.Join(memorySourceDir, filename))
			if err != nil {
				return err
			}
			files[filename] = content
		}
		for _, filename := range []string{"org.md", "org-policy.json", "team.md", "project.md", "team-policy.json", "project-policy.json"} {
			if err := fsx.AtomicWriteFile(filepath.Join(memoryTarget, filename), files[filename], 0o644); err != nil {
				return err
			}
		}
		for _, target := range []string{
			filepath.Join(memoryTarget, "templates", ".gitkeep"),
			filepath.Join(spaceDir, "codekb", ".gitkeep"),
			filepath.Join(spaceDir, "knowledge", ".gitkeep"),
		} {
			if err := fsx.AtomicWriteFile(target, nil, 0o644); err != nil {
				return err
			}
		}
		complete = true
		return nil
	})
	if err != nil {
		return Created{}, err
	}
	return Created{Name: name, SpaceDir: spaceDir}, nil
}

// Switch selects an existing normalized Space.
func Switch(ctx context.Context, projectDir, rawName string) (Info, error) {
	name := workspace.Slugify(rawName, 48)
	found := false
	spaces := List(projectDir)
	for _, candidate := range spaces {
		if candidate.Name == name {
			found = true
			break
		}
	}
	if !found {
		names := make([]string, 0, len(spaces))
		for _, candidate := range spaces {
			names = append(names, candidate.Name)
		}
		return Info{}, fmt.Errorf("Unknown space %q. Existing: %s", name, strings.Join(names, ", "))
	}
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return Info{}, err
	}
	if _, err := fsx.ResolveUnder(projectRoot, "aidlc/spaces/"+name, false); err != nil {
		return Info{}, fmt.Errorf("resolve Space safely: %w", err)
	}
	err = lock.With(ctx, projectRoot, lock.Options{}, func(context.Context) error {
		return fsx.AtomicWriteFile(filepath.Join(workspace.Root(projectRoot), "active-space"), []byte(name+"\n"), 0o644)
	})
	if err != nil {
		return Info{}, err
	}
	return Info{Name: name, Active: true}, nil
}

func readFirstRegular(paths ...string) ([]byte, error) {
	for _, candidate := range paths {
		content, err := readRegular(candidate)
		if err == nil {
			return content, nil
		}
	}
	return nil, fmt.Errorf("no readable regular Memory source: %v", paths)
}

func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("Memory source must be a regular file: %s", path)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read Memory source %s: %w", path, err)
	}
	return content, nil
}
