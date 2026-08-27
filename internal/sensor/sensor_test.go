package sensor

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
)

func TestCatalogAndWriteMatchingAreStable(t *testing.T) {
	definitions := List()
	if len(definitions) != 3 || definitions[0].ID != "artifact-reference-integrity" || definitions[2].ID != "json-valid" {
		t.Fatalf("List() = %#v", definitions)
	}
	matched := MatchWrite("internal/example.GO")
	if len(matched) != 1 || matched[0].ID != "go-format" {
		t.Fatalf("MatchWrite() = %#v", matched)
	}
	if _, ok := Describe("missing"); ok {
		t.Fatal("Describe(missing) unexpectedly succeeded")
	}
}

func TestFireWritesPairedAuditAndDeduplicatesSameInput(t *testing.T) {
	projectDir, recordDir := sensorFixture(t)
	path := filepath.Join(projectDir, "main.go")
	if err := os.WriteFile(path, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	clock := func() time.Time { return time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC) }
	request := Request{ProjectDir: projectDir, RecordDir: recordDir, Stage: "ST-06", SensorID: "go-format", Trigger: TriggerWrite, Path: "main.go", ObservationID: "tool-1"}
	first, err := Fire(context.Background(), request, Options{Clock: clock})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Fired || !first.Passed || first.Deduplicated {
		t.Fatalf("first Fire() = %#v", first)
	}
	second, err := Fire(context.Background(), request, Options{Clock: clock})
	if err != nil {
		t.Fatal(err)
	}
	if second.Fired || !second.Passed || !second.Deduplicated || second.FireID != first.FireID {
		t.Fatalf("second Fire() = %#v", second)
	}
	entries, err := audit.ReadOrdered(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Event != string(audit.SensorFired) || entries[1].Event != string(audit.SensorPassed) {
		t.Fatalf("Audit entries = %#v", entries)
	}
}

func TestFireRecordsFindingAndReevaluatesChangedBytes(t *testing.T) {
	projectDir, recordDir := sensorFixture(t)
	path := filepath.Join(projectDir, "main.go")
	if err := os.WriteFile(path, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	request := Request{ProjectDir: projectDir, RecordDir: recordDir, Stage: "ST-06", SensorID: "go-format", Trigger: TriggerWrite, Path: "main.go"}
	if _, err := Fire(context.Background(), request, Options{}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("package   main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := Fire(context.Background(), request, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Fired || result.Passed || result.FindingCode != "go_format_mismatch" || result.DetailPath == "" {
		t.Fatalf("Fire() = %#v", result)
	}
	if _, err := os.Lstat(filepath.Join(projectDir, filepath.FromSlash(result.DetailPath))); err != nil {
		t.Fatalf("finding detail: %v", err)
	}
	entries, err := audit.ReadOrdered(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 || entries[3].Event != string(audit.SensorFailed) {
		t.Fatalf("Audit entries = %#v", entries)
	}
}

func TestJSONSensorRejectsTrailingValue(t *testing.T) {
	projectDir, recordDir := sensorFixture(t)
	if err := os.WriteFile(filepath.Join(projectDir, "value.json"), []byte("{} {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := Fire(context.Background(), Request{ProjectDir: projectDir, RecordDir: recordDir, Stage: "ST-06", SensorID: "json-valid", Trigger: TriggerWrite, Path: "value.json"}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Passed || result.FindingCode != "json_trailing_value" {
		t.Fatalf("Fire() = %#v", result)
	}
}

func TestArtifactReferenceSensorBindsExpectedDigest(t *testing.T) {
	projectDir, recordDir := sensorFixture(t)
	content := []byte("reviewed artifact\n")
	if err := os.WriteFile(filepath.Join(projectDir, "decision.md"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	good := contract.ArtifactReference{Artifact: "decision", Version: 1, SourceOfTruth: "decision.md", SHA256: digest.Bytes(content)}
	passed, err := FireReference(context.Background(), projectDir, recordDir, "ST-05", good, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !passed.Passed || !passed.Blocking {
		t.Fatalf("passed = %#v", passed)
	}
	wrong := good
	wrong.SHA256 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	failed, err := FireReference(context.Background(), projectDir, recordDir, "ST-05", wrong, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if failed.Deduplicated || failed.Passed || !failed.Fired || failed.FindingCode != "artifact_sha256_mismatch" {
		t.Fatalf("failed = %#v", failed)
	}
}

func TestConcurrentFireProducesOneAuditPair(t *testing.T) {
	projectDir, recordDir := sensorFixture(t)
	if err := os.WriteFile(filepath.Join(projectDir, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	request := Request{ProjectDir: projectDir, RecordDir: recordDir, Stage: "ST-06", SensorID: "go-format", Trigger: TriggerWrite, Path: "main.go"}
	const count = 8
	var wait sync.WaitGroup
	errors := make(chan error, count)
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := Fire(context.Background(), request, Options{})
			errors <- err
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	entries, err := audit.ReadOrdered(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("Audit entry count = %d, want 2", len(entries))
	}
}

func TestRecordObservationDistinguishesMatchedFromFired(t *testing.T) {
	projectDir, recordDir := sensorFixture(t)
	if err := RecordObservation(context.Background(), projectDir, recordDir, "sensor", "PostToolUse", "ST-06", "tool-7", 2, 1, Options{}); err != nil {
		t.Fatal(err)
	}
	status, err := Inspect(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Present || len(status.Observations) != 1 || status.Observations[0].Matched != 2 || status.Observations[0].Fired != 1 {
		t.Fatalf("Inspect() = %#v", status)
	}
}

func TestSensorRejectsPathEscapesAndSymlinks(t *testing.T) {
	projectDir, recordDir := sensorFixture(t)
	request := Request{ProjectDir: projectDir, RecordDir: recordDir, Stage: "ST-06", SensorID: "json-valid", Trigger: TriggerWrite, Path: "../outside.json"}
	if _, err := Fire(context.Background(), request, Options{}); err == nil {
		t.Fatal("path escape unexpectedly accepted")
	}
	if runtime.GOOS == "windows" {
		return
	}
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(projectDir, "link.json")); err != nil {
		t.Fatal(err)
	}
	request.Path = "link.json"
	if _, err := Fire(context.Background(), request, Options{}); err == nil {
		t.Fatal("symlink input unexpectedly accepted")
	}
}

func TestSensorRejectsSymlinkedLedgerAndImmutableFinding(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is not generally available on Windows")
	}
	projectDir, recordDir := sensorFixture(t)
	ledgerDirectory := filepath.Dir(ledgerPath(recordDir))
	if err := os.MkdirAll(ledgerDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	outsideLedger := filepath.Join(t.TempDir(), "current.json")
	if err := os.WriteFile(outsideLedger, []byte(`{"schema_version":1,"entries":{},"observations":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideLedger, ledgerPath(recordDir)); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(recordDir); err == nil {
		t.Fatal("symlinked Sensor ledger unexpectedly accepted")
	}
	if err := os.Remove(ledgerPath(recordDir)); err != nil {
		t.Fatal(err)
	}

	value := detail{SchemaVersion: SchemaVersion, FireID: "fire-symlink", SensorID: "go-format", Stage: "ST-06", Trigger: TriggerWrite, Severity: Advisory, Path: "main.go", Outcome: "failed", FindingCode: "go_format_mismatch", Message: "mismatch", ObservedAt: "2026-08-28T00:00:00.000Z"}
	findingDirectory := filepath.Join(recordDir, "artifacts", "sensors", "findings", "st06", value.SensorID)
	if err := os.MkdirAll(findingDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	outsideFinding := filepath.Join(t.TempDir(), "outside-finding.json")
	original := []byte("outside must remain unchanged\n")
	if err := os.WriteFile(outsideFinding, original, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideFinding, filepath.Join(findingDirectory, value.FireID+".json")); err != nil {
		t.Fatal(err)
	}
	if _, err := writeDetail(projectDir, recordDir, value); err == nil {
		t.Fatal("symlinked immutable Sensor finding unexpectedly accepted")
	}
	content, err := os.ReadFile(outsideFinding)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(original) {
		t.Fatalf("outside finding changed to %q", content)
	}
}

func sensorFixture(t *testing.T) (string, string) {
	t.Helper()
	projectDir := t.TempDir()
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "sensor-test")
	if err := os.MkdirAll(recordDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir
}
