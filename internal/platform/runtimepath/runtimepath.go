package runtimepath

import (
	"fmt"
	"os"
	"path/filepath"
)

// ResolveCoreDir locates the directory containing aidlc-common/ and memory/.
func ResolveCoreDir(executable, cwd string, getenv func(string) string) (string, error) {
	if explicit := getenv("AIDLC_RUNTIME_CORE_DIR"); explicit != "" {
		return requireCoreDir(explicit)
	}

	candidates := make([]string, 0, 6)
	if installDir := getenv("AIDLC_INSTALL_DIR"); installDir != "" {
		candidates = append(candidates, installDir)
	}
	if executable != "" {
		executableDir := filepath.Dir(executable)
		candidates = append(
			candidates,
			filepath.Join(executableDir, "..", ".."),
			filepath.Join(executableDir, ".."),
		)
	}
	if cwd != "" {
		candidates = append(candidates, filepath.Join(cwd, "core"), filepath.Join(cwd, ".codex"), cwd)
	}

	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		absolute, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		absolute = filepath.Clean(absolute)
		if _, ok := seen[absolute]; ok {
			continue
		}
		seen[absolute] = struct{}{}
		if isCoreDir(absolute) {
			return absolute, nil
		}
	}
	return "", fmt.Errorf("cannot locate AI-DLC runtime assets")
}

// CoreDir resolves runtime assets from the current process.
func CoreDir() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable: %w", err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("resolve working directory: %w", err)
	}
	return ResolveCoreDir(executable, cwd, os.Getenv)
}

func requireCoreDir(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve runtime core directory: %w", err)
	}
	absolute = filepath.Clean(absolute)
	if !isCoreDir(absolute) {
		return "", fmt.Errorf("AI-DLC runtime assets are missing from %s", absolute)
	}
	return absolute, nil
}

func isCoreDir(path string) bool {
	required := []string{
		filepath.Join(path, "aidlc-common", "data", "vnext-stage-catalog.json"),
		filepath.Join(path, "aidlc-common", "data", "vnext-stage-graph.json"),
		filepath.Join(path, "aidlc-common", "data", "vnext-stage-delegation.json"),
	}
	for _, requiredPath := range required {
		info, err := os.Stat(requiredPath)
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	memory, err := os.Stat(filepath.Join(path, "memory"))
	return err == nil && memory.IsDir()
}
