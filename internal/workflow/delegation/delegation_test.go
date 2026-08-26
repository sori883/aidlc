package delegation

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
)

func TestLoadValidatesCanonicalDelegation(t *testing.T) {
	t.Parallel()

	catalog, err := Load(repositoryCoreDir(t))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got, want := len(catalog.Stages), 10; got != want {
		t.Fatalf("stage count = %d, want %d", got, want)
	}
	stage, ok := catalog.Find(contract.Stage05)
	if !ok || stage.WorkAssignment == nil || stage.ReviewAssignment == nil {
		t.Fatal("ST-05 assignments are incomplete")
	}
	if got, want := stage.WorkAssignment.LeadAgent, "aidlc-build-planner-agent"; got != want {
		t.Fatalf("lead agent = %q, want %q", got, want)
	}
}

func TestLoadRejectsUnknownFieldsAndNestedDelegation(t *testing.T) {
	t.Parallel()

	for name, replacement := range map[string]string{
		"unknown": `"schema_version": 1, "unknown": true`,
		"nested":  `"nested_delegation": true`,
	} {
		t.Run(name, func(t *testing.T) {
			coreDir := t.TempDir()
			target := filepath.Join(coreDir, "aidlc-common", "data", "vnext-stage-delegation.json")
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filepath.Join(repositoryCoreDir(t), "aidlc-common", "data", "vnext-stage-delegation.json"))
			if err != nil {
				t.Fatal(err)
			}
			needle := `"schema_version": 1`
			if name == "nested" {
				needle = `"nested_delegation": false`
			}
			data = []byte(strings.Replace(string(data), needle, replacement, 1))
			if err := os.WriteFile(target, data, 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(coreDir); err == nil {
				t.Fatalf("Load() accepted %s drift", name)
			}
		})
	}
}

func repositoryCoreDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "core"))
}
