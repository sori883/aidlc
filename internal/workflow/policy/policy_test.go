package policy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
)

func TestBuildWriteAndVerify(t *testing.T) {
	t.Parallel()
	projectDir, recordDir := policyFixture(t)
	snapshot, err := Build(projectDir, "intent-1", BuildOptions{CreatedAt: "2026-08-23T00:00:00.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	if !equalLayers(snapshot.SourcePriority, OrderedLayers) || len(snapshot.Sources) != 3 || len(snapshot.ControlSources) != 3 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	written, err := Write(projectDir, recordDir, "intent-1", BuildOptions{CreatedAt: "2026-08-23T00:00:00.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyProjectArtifactReference(projectDir, written.Reference); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(written.Path, []byte("tampered\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyProjectArtifactReference(projectDir, written.Reference); err == nil {
		t.Fatal("VerifyProjectArtifactReference() accepted tampering")
	}
}

func TestSnapshotRejectsOrderAndUnknownField(t *testing.T) {
	t.Parallel()
	projectDir, _ := policyFixture(t)
	snapshot, err := Build(projectDir, "intent-1", BuildOptions{CreatedAt: "2026-08-23T00:00:00.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot.SourcePriority[0], snapshot.SourcePriority[1] = snapshot.SourcePriority[1], snapshot.SourcePriority[0]
	if err := snapshot.Validate(); err == nil {
		t.Fatal("Validate() accepted reordered priority")
	}
	content := []byte(`{"schema_version":2,"snapshot_id":"x","intent_id":"i","revision":1,"created_at":"2026-08-23T00:00:00.000Z","source_priority":[],"sources":[],"control_sources":[],"human_gate_rules":[],"profile":"enterprise"}`)
	if _, err := DecodeSnapshot(content); err == nil {
		t.Fatal("DecodeSnapshot() accepted unknown field")
	}
}

func TestVerifyRejectsEscapesAndSymlinks(t *testing.T) {
	projectDir, _ := policyFixture(t)
	reference := contractReference("../outside")
	if _, err := VerifyProjectArtifactReference(projectDir, reference); err == nil {
		t.Fatal("VerifyProjectArtifactReference() accepted traversal")
	}
	outside := t.TempDir()
	link := filepath.Join(projectDir, "linked-records")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := Write(projectDir, link, "intent-1", BuildOptions{CreatedAt: "2026-08-23T00:00:00.000Z"}); err == nil {
		t.Fatal("Write() accepted a symlink record directory")
	}
	if _, err := os.Stat(filepath.Join(outside, "effective-policy-r1.json")); !os.IsNotExist(err) {
		t.Fatalf("Write() changed a symlink target: %v", err)
	}
}

func TestWriteRejectsOutsideProjectBeforeWriting(t *testing.T) {
	t.Parallel()
	projectDir, _ := policyFixture(t)
	recordDir := filepath.Join(t.TempDir(), "records")
	if _, err := Write(projectDir, recordDir, "intent-1", BuildOptions{CreatedAt: "2026-08-23T00:00:00.000Z"}); err == nil {
		t.Fatal("Write() accepted a record directory outside the project")
	}
	if _, err := os.Stat(filepath.Join(recordDir, "effective-policy-r1.json")); !os.IsNotExist(err) {
		t.Fatalf("Write() changed the outside directory: %v", err)
	}
}

func TestWriteDoesNotReplaceImmutableSnapshot(t *testing.T) {
	t.Parallel()
	projectDir, recordDir := policyFixture(t)
	first, err := Write(projectDir, recordDir, "intent-1", BuildOptions{CreatedAt: "2026-08-23T00:00:00.000Z"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Write(projectDir, recordDir, "intent-1", BuildOptions{CreatedAt: "2026-08-23T00:00:01.000Z"}); err == nil {
		t.Fatal("Write() replaced an immutable snapshot")
	}
	content, err := os.ReadFile(first.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) == "" || !strings.Contains(string(content), "2026-08-23T00:00:00.000Z") {
		t.Fatal("Write() changed the original snapshot")
	}
}

func policyFixture(t *testing.T) (string, string) {
	t.Helper()
	projectDir := t.TempDir()
	memoryDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "memory")
	if err := os.MkdirAll(memoryDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "aidlc", "active-space"), []byte("default\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, layer := range OrderedLayers {
		if err := os.WriteFile(filepath.Join(memoryDir, string(layer)+".md"), []byte("# "+string(layer)+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		content := "{\n  \"schema_version\": 1,\n  \"artifact\": \"human-gate-policy-source\",\n  \"layer\": \"" + string(layer) + "\",\n  \"rules\": []\n}\n"
		if err := os.WriteFile(filepath.Join(memoryDir, string(layer)+"-policy.json"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "intent-1")
	if err := os.MkdirAll(recordDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir
}

func contractReference(path string) contract.ArtifactReference {
	return contract.ArtifactReference{Artifact: "test", Version: 1, SourceOfTruth: path, SHA256: "sha256:" + strings.Repeat("a", 64)}
}
