package catalog

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLoadValidatesCanonicalDefinitions(t *testing.T) {
	t.Parallel()

	definitions, err := Load(repositoryCoreDir(t))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got, want := len(definitions.Catalog.Stages), 10; got != want {
		t.Fatalf("stage count = %d, want %d", got, want)
	}
	if got, want := definitions.Graph.GraphVersion, "vnext-10-stage-graph-v1"; got != want {
		t.Fatalf("graph version = %q, want %q", got, want)
	}
}

func TestLoadRejectsUnknownFieldsAndRouteDrift(t *testing.T) {
	t.Parallel()

	coreDir := copyDefinitionFixtures(t)
	catalogPath := filepath.Join(coreDir, "aidlc-common", "data", "vnext-stage-catalog.json")
	catalogData, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	catalogData = []byte(strings.Replace(string(catalogData), `"schema_version": 1`, `"schema_version": 1, "unknown": true`, 1))
	if err := os.WriteFile(catalogPath, catalogData, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(coreDir); err == nil {
		t.Fatal("Load() accepted an unknown field")
	}

	coreDir = copyDefinitionFixtures(t)
	graphPath := filepath.Join(coreDir, "aidlc-common", "data", "vnext-stage-graph.json")
	graphData, err := os.ReadFile(graphPath)
	if err != nil {
		t.Fatal(err)
	}
	graphData = []byte(strings.Replace(string(graphData), `"to": "ST-01"`, `"to": "ST-02"`, 1))
	if err := os.WriteFile(graphPath, graphData, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(coreDir); err == nil {
		t.Fatal("Load() accepted route drift")
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

func copyDefinitionFixtures(t *testing.T) string {
	t.Helper()
	coreDir := t.TempDir()
	targetDir := filepath.Join(coreDir, "aidlc-common", "data")
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"vnext-stage-catalog.json", "vnext-stage-graph.json"} {
		data, err := os.ReadFile(filepath.Join(repositoryCoreDir(t), "aidlc-common", "data", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(targetDir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return coreDir
}
