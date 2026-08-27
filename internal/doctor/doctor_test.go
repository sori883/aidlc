package doctor

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/hookhealth"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/sensor"
	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/risk"
	"github.com/sori883/aidlc/internal/workflow/state"
)

func TestCheckAndLimitedRepair(t *testing.T) {
	projectDir, recordDir := fixture(t)
	report := Check(projectDir, coreDir(t))
	if !report.Healthy {
		t.Fatalf("healthy report = %+v", report)
	}
	if err := os.WriteFile(state.SummaryPath(recordDir), []byte("stale\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	report = Check(projectDir, coreDir(t))
	if !report.Healthy || !hasCode(report, "VNEXT_STATE_SUMMARY_STALE") {
		t.Fatalf("stale report = %+v", report)
	}
	repaired, err := Repair(context.Background(), projectDir, coreDir(t))
	if err != nil {
		t.Fatal(err)
	}
	if !repaired.Healthy || hasCode(repaired, "VNEXT_STATE_SUMMARY_STALE") {
		t.Fatalf("repaired report = %+v", repaired)
	}
}

func TestCheckRejectsInvalidPendingHumanGate(t *testing.T) {
	projectDir, recordDir := fixture(t)
	snapshot, err := state.Read(recordDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := humanapproval.Open(context.Background(), projectDir, recordDir, humanapproval.OpenOptions{
		IntentID: snapshot.State.IntentID, Scope: humanapproval.ScopeRisk,
		SubjectRef: snapshot.State.PolicySnapshot, ReviewRef: snapshot.State.PolicySnapshot,
		GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision,
		AllowedActions: []string{"dismiss"}, OpenedAt: "2026-08-27T00:00:00.000Z",
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(humanapproval.CurrentPath(recordDir), []byte("not-json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	report := Check(projectDir, coreDir(t))
	if report.Healthy || !hasCode(report, "VNEXT_HUMAN_GATE_INVALID") {
		t.Fatalf("report = %+v", report)
	}
}

func TestInstalledHookConfigurationAndUnobservedRuntimeAreDistinguished(t *testing.T) {
	projectDir, _ := fixture(t)
	installHookFixture(t, projectDir)
	report := Check(projectDir, coreDir(t))
	if !report.Healthy || !hasCode(report, "VNEXT_HOOK_CONFIG_VALID") || !hasCode(report, "VNEXT_HOOK_HANDLERS_NOT_OBSERVED") || !hasCode(report, "VNEXT_HOOK_EVENTS_NOT_OBSERVED") || !hasCode(report, "VNEXT_SENSOR_HANDLER_NOT_OBSERVED") {
		t.Fatalf("report = %+v", report)
	}
}

func TestDoctorRejectsMissingOrMiswiredRequiredHook(t *testing.T) {
	projectDir, _ := fixture(t)
	installHookFixture(t, projectDir)
	path := filepath.Join(projectDir, ".codex", "hooks.json")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	modified := strings.Replace(string(content), `"matcher": "^apply_patch$"`, `"matcher": "^Bash$"`, 1)
	if modified == string(content) {
		t.Fatal("Sensor matcher was not found in fixture")
	}
	if err := os.WriteFile(path, []byte(modified), 0o644); err != nil {
		t.Fatal(err)
	}
	report := Check(projectDir, coreDir(t))
	if report.Healthy || !hasCode(report, "VNEXT_HOOK_CONFIG_INVALID") {
		t.Fatalf("report = %+v", report)
	}
}

func TestDoctorSeparatesSensorInvocationMatchAndFire(t *testing.T) {
	projectDir, recordDir := fixture(t)
	installHookFixture(t, projectDir)
	if err := hookhealth.Record(context.Background(), projectDir, hookhealth.Observation{Handler: "sensor", SourceEvent: "PostToolUse", Succeeded: true, Outcome: "no-match"}); err != nil {
		t.Fatal(err)
	}
	if err := sensor.RecordObservation(context.Background(), projectDir, recordDir, "sensor", "PostToolUse", "ST-00", "tool-1", 0, 0, sensor.Options{}); err != nil {
		t.Fatal(err)
	}
	report := Check(projectDir, coreDir(t))
	if !hasCode(report, "VNEXT_SENSOR_HANDLER_OBSERVED_NO_MATCH") || hasCode(report, "VNEXT_SENSOR_FIRED") {
		t.Fatalf("no-match report = %+v", report)
	}
	if err := sensor.RecordObservation(context.Background(), projectDir, recordDir, "sensor", "PostToolUse", "ST-00", "tool-2", 1, 0, sensor.Options{}); err != nil {
		t.Fatal(err)
	}
	report = Check(projectDir, coreDir(t))
	if !hasCode(report, "VNEXT_SENSOR_MATCHED_NOT_FIRED") || hasCode(report, "VNEXT_SENSOR_FIRED") {
		t.Fatalf("matched report = %+v", report)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "value.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if result, err := sensor.Fire(context.Background(), sensor.Request{ProjectDir: projectDir, RecordDir: recordDir, Stage: "ST-00", SensorID: "json-valid", Trigger: sensor.TriggerWrite, Path: "value.json"}, sensor.Options{}); err != nil || !result.Fired {
		t.Fatalf("Sensor Fire = %#v, %v", result, err)
	}
	if err := sensor.RecordObservation(context.Background(), projectDir, recordDir, "sensor", "PostToolUse", "ST-00", "tool-3", 1, 1, sensor.Options{}); err != nil {
		t.Fatal(err)
	}
	report = Check(projectDir, coreDir(t))
	if !hasCode(report, "VNEXT_SENSOR_FIRED") {
		t.Fatalf("fired report = %+v", report)
	}
}

func TestDoctorRejectsCorruptHookHealthLedger(t *testing.T) {
	projectDir, recordDir := fixture(t)
	installHookFixture(t, projectDir)
	if err := hookhealth.Record(context.Background(), projectDir, hookhealth.Observation{Handler: "guard", SourceEvent: "PreToolUse", Succeeded: true, Outcome: "allowed"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hookhealth.Path(recordDir), []byte("not-json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	report := Check(projectDir, coreDir(t))
	if report.Healthy || !hasCode(report, "VNEXT_HOOK_HEALTH_INVALID") {
		t.Fatalf("report = %+v", report)
	}
}

func fixture(t *testing.T) (string, string) {
	t.Helper()
	projectDir := t.TempDir()
	recordDir := filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "intent-1")
	if err := os.MkdirAll(filepath.Join(recordDir, "artifacts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "aidlc", "active-space"), []byte("default\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "aidlc", "spaces", "default", "intents", "active-intent"), []byte("intent-1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	content := []byte("{}\n")
	if err := os.WriteFile(filepath.Join(projectDir, "aidlc", "policy.json"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	policyRef := contract.ArtifactReference{Artifact: "effective-policy", Version: 1, SourceOfTruth: "aidlc/policy.json", SHA256: digest.Bytes(content)}
	if _, err := risk.Initialize(context.Background(), projectDir, recordDir, "intent-1", risk.Options{CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	plan, err := workflowplan.Initial("intent-1", "vnext-10-stage-graph-v1", policyRef)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := state.Initialize(context.Background(), projectDir, recordDir, state.InitializeOptions{IntentID: "intent-1", CatalogVersion: "vnext-stage-catalog-v1", GraphVersion: "vnext-10-stage-graph-v1", PolicySnapshot: policyRef, Plan: plan, CreatedAt: "2026-08-25T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if _, err := audit.Append(context.Background(), projectDir, recordDir, audit.WorkflowStarted, []audit.Field{{Name: "Workflow", Value: "vNext"}}, nil); err != nil {
		t.Fatal(err)
	}
	return projectDir, recordDir
}

func hasCode(report Report, code string) bool {
	for _, finding := range report.Findings {
		if finding.Code == code {
			return true
		}
	}
	return false
}

func coreDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "core"))
}

func installHookFixture(t *testing.T, projectDir string) {
	t.Helper()
	directory := filepath.Join(projectDir, ".codex")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "distribution-manifest.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Dir(coreDir(t))
	content, err := os.ReadFile(filepath.Join(root, "harness", "codex", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "hooks.json"), content, 0o644); err != nil {
		t.Fatal(err)
	}
}
