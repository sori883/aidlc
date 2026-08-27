package stage_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/stage/st00bootstrap"
	"github.com/sori883/aidlc/internal/stage/st01orient"
	"github.com/sori883/aidlc/internal/stage/st02defineintent"
	"github.com/sori883/aidlc/internal/stage/st03requirements"
	"github.com/sori883/aidlc/internal/stage/st04architecture"
	"github.com/sori883/aidlc/internal/stage/st05buildcontract"
	"github.com/sori883/aidlc/internal/stage/st06build"
	"github.com/sori883/aidlc/internal/stage/st07review"
	"github.com/sori883/aidlc/internal/stage/st08release"
	"github.com/sori883/aidlc/internal/stage/st09outcome"
	"github.com/sori883/aidlc/internal/workflow/gate"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

const (
	t0  = "2026-08-26T00:00:00.000Z"
	t1  = "2026-08-26T00:00:01.000Z"
	t2  = "2026-08-26T00:00:02.000Z"
	t3  = "2026-08-26T00:00:03.000Z"
	t4  = "2026-08-26T00:00:04.000Z"
	t5  = "2026-08-26T00:00:05.000Z"
	t6  = "2026-08-26T00:00:06.000Z"
	t7  = "2026-08-26T00:00:07.000Z"
	t8  = "2026-08-26T00:00:08.000Z"
	t9  = "2026-08-26T00:00:09.000Z"
	t10 = "2026-08-26T00:00:10.000Z"
)

func TestNoBuildIntentRunsEveryGoStageAndCompletes(t *testing.T) {
	ctx := context.Background()
	projectDir, coreDir, born := fixture(t)

	if result, err := st00bootstrap.Execute(ctx, projectDir, coreDir, st00bootstrap.Options{CreatedAt: t1}); err != nil || result.State.CurrentStage != contract.Stage01 {
		t.Fatalf("ST-00 = %+v, %v", result, err)
	} else {
	}
	if _, _, err := st00bootstrap.VerifyAt(projectDir, stateRecordDir(t, projectDir)); err != nil {
		t.Fatalf("ST-00 resume verification: %v", err)
	}
	orientRequest, err := st01orient.Prepare(ctx, projectDir, coreDir, t1)
	if err != nil {
		t.Fatal(err)
	}
	assertTamperRejected(t, st01orient.WorkspaceProfilePath(stateRecordDir(t, projectDir)), func() error {
		_, err := st01orient.Prepare(ctx, projectDir, coreDir, t1)
		return err
	})
	if resumed, err := st01orient.Prepare(ctx, projectDir, coreDir, t1); err != nil || resumed.Execution != "reused" || resumed.Reference != orientRequest.Reference {
		t.Fatalf("ST-01 resume = %+v, %v", resumed, err)
	}
	if _, err := st01orient.Complete(ctx, projectDir, coreDir, []byte("{}"), t1); err == nil {
		t.Fatal("ST-01 accepted an invalid proposal")
	}
	orientProposal := st01orient.Proposal{SchemaVersion: 1, Artifact: "orient-proposal", Version: 1, IntentID: born.UUID, WorkRequestSHA256: orientRequest.Reference.SHA256, SystemMapPatch: st01orient.Patch{SchemaVersion: 1, Artifact: "system-map-patch", Version: 1, ProposalID: "orient-001", MapID: "default-system", Perspective: "accepted-code-baseline", SourceSnapshots: orientRequest.Profile.RepositorySnapshots, Evidence: []st01orient.Evidence{}, CoverageUpserts: []st01orient.Coverage{}, EntityUpserts: []st01orient.Entity{}, RelationUpserts: []st01orient.Relation{}, RemoveEntityIDs: []string{}, RemoveRelationIDs: []string{}, Reason: "Record the current repository baseline.", ProposedAt: t1, ProposedBy: "ai"}, CurrentContext: st01orient.ContextProposal{EntityIDs: []string{}, RelationIDs: []string{}, AdditionalFindings: []string{}, OutOfScope: []string{}, IntentOnlyNotes: []string{}, Unknowns: []string{}}, ProposedBy: "ai"}
	orient, err := st01orient.Complete(ctx, projectDir, coreDir, encode(t, orientProposal), t1)
	if err != nil || orient.State.CurrentStage != contract.Stage02 {
		t.Fatalf("ST-01 = %+v, %v", orient, err)
	}

	intentRequest, err := st02defineintent.Prepare(ctx, projectDir, coreDir, t2)
	if err != nil {
		t.Fatal(err)
	}
	assertTamperRejected(t, st02defineintent.WorkRequestPath(stateRecordDir(t, projectDir)), func() error {
		_, err := st02defineintent.Prepare(ctx, projectDir, coreDir, t2)
		return err
	})
	if resumed, err := st02defineintent.Prepare(ctx, projectDir, coreDir, t2); err != nil || resumed.Execution != "reused" || resumed.Reference != intentRequest.Reference {
		t.Fatalf("ST-02 resume = %+v, %v", resumed, err)
	}
	if _, err := st02defineintent.Complete(ctx, projectDir, coreDir, []byte("{}"), t2); err == nil {
		t.Fatal("ST-02 accepted an invalid proposal")
	}
	intentProposal := st02defineintent.Proposal{SchemaVersion: 1, Artifact: "intent-definition-proposal", Version: 1, ProposalID: "intent-001", IntentID: born.UUID, WorkRequestSHA256: intentRequest.Reference.SHA256, Purpose: "Document an already-correct repository without code changes.", ExpectedOutcomes: []string{"The repository remains unchanged."}, InScope: []string{"Document the verified no-change outcome."}, OutOfScope: []string{"Source changes."}, SuccessSignals: []string{"The accepted evidence confirms no source change."}, Unknowns: []string{}, Reason: "The Intent is documentation-only.", ProposedBy: "ai"}
	intentResult, err := st02defineintent.Complete(ctx, projectDir, coreDir, encode(t, intentProposal), t2)
	if err != nil || intentResult.State.CurrentStage != contract.Stage03 {
		t.Fatalf("ST-02 = %+v, %v", intentResult, err)
	}

	requirementsRequest, err := st03requirements.Prepare(ctx, projectDir, coreDir, t3)
	if err != nil {
		t.Fatal(err)
	}
	assertTamperRejected(t, st03requirements.WorkRequestPath(stateRecordDir(t, projectDir)), func() error {
		_, err := st03requirements.Prepare(ctx, projectDir, coreDir, t3)
		return err
	})
	if resumed, err := st03requirements.Prepare(ctx, projectDir, coreDir, t3); err != nil || resumed.Execution != "reused" || resumed.Reference != requirementsRequest.Reference {
		t.Fatalf("ST-03 resume = %+v, %v", resumed, err)
	}
	if _, err := st03requirements.Complete(ctx, projectDir, coreDir, []byte("{}"), t3); err == nil {
		t.Fatal("ST-03 accepted an invalid proposal")
	}
	requirementsProposal := st03requirements.Proposal{SchemaVersion: 1, Artifact: "requirements-definition-proposal", Version: 1, ProposalID: "requirements-001", IntentID: born.UUID, WorkRequestSHA256: requirementsRequest.Reference.SHA256, FunctionalRequirements: []st03requirements.Item{{ID: "REQ-F-001", Statement: "The repository content remains unchanged.", SourceRefs: []st03requirements.SourceRef{{Artifact: "intent-definition", Pointer: "/expected_outcomes/0"}, {Artifact: "intent-definition", Pointer: "/success_signals/0"}}}}, QualityRequirements: []st03requirements.Item{}, Constraints: []st03requirements.Item{}, Invariants: []st03requirements.Item{}, OpenQuestions: []st03requirements.OpenQuestion{}, Reason: "One traceable no-change requirement is sufficient.", ProposedBy: "ai"}
	requirementsResult, err := st03requirements.Complete(ctx, projectDir, coreDir, encode(t, requirementsProposal), t3)
	if err != nil || requirementsResult.State.CurrentStage != contract.Stage04 {
		t.Fatalf("ST-03 = %+v, %v", requirementsResult, err)
	}

	architectureRequest, err := st04architecture.Prepare(ctx, projectDir, coreDir, t4)
	if err != nil {
		t.Fatal(err)
	}
	assertTamperRejected(t, st04architecture.WorkRequestPath(stateRecordDir(t, projectDir)), func() error {
		_, err := st04architecture.Prepare(ctx, projectDir, coreDir, t4)
		return err
	})
	if resumed, err := st04architecture.Prepare(ctx, projectDir, coreDir, t4); err != nil || resumed.Execution != "reused" || resumed.Reference != architectureRequest.Reference {
		t.Fatalf("ST-04 resume = %+v, %v", resumed, err)
	}
	if _, err := st04architecture.Complete(ctx, projectDir, coreDir, []byte("{}"), t4); err == nil {
		t.Fatal("ST-04 accepted an invalid proposal")
	}
	architectureProposal := st04architecture.Proposal{SchemaVersion: 1, Artifact: "architecture-assessment-proposal", Version: 1, ProposalID: "architecture-001", IntentID: born.UUID, WorkRequestSHA256: architectureRequest.Reference.SHA256, Disposition: contract.NotApplicable, RequirementAssessments: []st04architecture.Assessment{{RequirementID: "REQ-F-001", ArchitectureImpact: false, Reason: "No system structure changes are required.", CurrentEntityRefs: []string{}}}, Decisions: []st04architecture.DecisionDraft{}, Evidence: []contract.ArtifactReference{architectureRequest.Request.RequirementsRef, architectureRequest.Request.SystemMapRef}, Reason: "The requirement has no architecture impact.", ProposedBy: "ai"}
	architectureResult, err := st04architecture.Complete(ctx, projectDir, coreDir, encode(t, architectureProposal), t4)
	if err != nil || architectureResult.State.CurrentStage != contract.Stage05 {
		t.Fatalf("ST-04 = %+v, %v", architectureResult, err)
	}

	buildRequest, err := st05buildcontract.Prepare(ctx, projectDir, coreDir, t5)
	if err != nil {
		t.Fatal(err)
	}
	assertTamperRejected(t, st05buildcontract.WorkRequestPath(stateRecordDir(t, projectDir)), func() error {
		_, err := st05buildcontract.Prepare(ctx, projectDir, coreDir, t5)
		return err
	})
	if resumed, err := st05buildcontract.Prepare(ctx, projectDir, coreDir, t5); err != nil || resumed.Execution != "reused" || resumed.Reference != buildRequest.Reference {
		t.Fatalf("ST-05 resume = %+v, %v", resumed, err)
	}
	if _, err := st05buildcontract.Review(ctx, projectDir, coreDir, []byte("{}"), t5); err == nil {
		t.Fatal("ST-05 accepted an invalid proposal")
	}
	buildProposal := st05buildcontract.Proposal{SchemaVersion: 1, Artifact: "build-contract-proposal", Version: 1, ProposalID: "build-contract-001", IntentID: born.UUID, WorkRequestSHA256: buildRequest.Reference.SHA256, Disposition: contract.NotApplicable, RequirementAssessments: []st05buildcontract.Assessment{{RequirementID: "REQ-F-001", BuildImpact: false, Reason: "No repository change is required."}}, ChangeContracts: []st05buildcontract.ChangeContract{}, AcceptanceCriteria: []st05buildcontract.AcceptanceCriterion{}, Verifiers: []st05buildcontract.Verifier{}, Bolts: []st05buildcontract.Bolt{}, Evidence: []contract.ArtifactReference{buildRequest.Request.RequirementsRef, buildRequest.Request.ArchitectureCurrentRef}, Reason: "The accepted state already satisfies the requirement.", ProposedBy: "ai"}
	if _, err := st05buildcontract.Review(ctx, projectDir, coreDir, encode(t, buildProposal), t5); err != nil {
		t.Fatal(err)
	}
	proof := humanProof(t, projectDir, "approve-build-contract", "Approve the verified no-build contract.", st05buildcontract.ApprovalParameters{PolicyAcknowledgements: []gate.Acknowledgement{}}, t5)
	buildApproved, err := st05buildcontract.Approve(ctx, projectDir, coreDir, proof)
	if err != nil || buildApproved.State.CurrentStage != contract.Stage06 {
		t.Fatalf("ST-05 = %+v, %v", buildApproved, err)
	}

	buildResult, err := st06build.Prepare(ctx, projectDir, coreDir, t6)
	if err != nil || buildResult.State.CurrentStage != contract.Stage07 || buildResult.Execution != "advanced" {
		t.Fatalf("ST-06 = %+v, %v", buildResult, err)
	}
	reviewResult, err := st07review.Prepare(ctx, projectDir, coreDir, t7)
	if err != nil || reviewResult.State.CurrentStage != contract.Stage08 || reviewResult.Execution != "advanced" {
		t.Fatalf("ST-07 = %+v, %v", reviewResult, err)
	}
	releaseResult, err := st08release.Prepare(ctx, projectDir, coreDir, t8)
	if err != nil || releaseResult.State.CurrentStage != contract.Stage09 || releaseResult.Execution != "advanced" {
		t.Fatalf("ST-08 = %+v, %v", releaseResult, err)
	}

	outcomeRequest, err := st09outcome.Prepare(ctx, projectDir, coreDir, st09outcome.PrepareOptions{PreparedAt: t9})
	if err != nil || outcomeRequest.Request == nil || outcomeRequest.Reference == nil {
		t.Fatalf("ST-09 prepare = %+v, %v", outcomeRequest, err)
	}
	assertTamperRejected(t, st09outcome.WorkRequestPath(stateRecordDir(t, projectDir)), func() error {
		_, err := st09outcome.Prepare(ctx, projectDir, coreDir, st09outcome.PrepareOptions{PreparedAt: t9})
		return err
	})
	if resumed, err := st09outcome.Prepare(ctx, projectDir, coreDir, st09outcome.PrepareOptions{PreparedAt: t9}); err != nil || resumed.Execution != "reused" || resumed.Reference == nil || *resumed.Reference != *outcomeRequest.Reference {
		t.Fatalf("ST-09 resume = %+v, %v", resumed, err)
	}
	if _, err := st09outcome.Evaluate(ctx, projectDir, coreDir, []byte("{}"), t9); err == nil {
		t.Fatal("ST-09 accepted an invalid proposal")
	}
	observations := make([]st09outcome.Observation, 0, len(outcomeRequest.Request.Signals))
	for _, signal := range outcomeRequest.Request.Signals {
		observations = append(observations, st09outcome.Observation{SignalID: signal.SignalID, Result: "achieved", EvidenceRefs: []contract.ArtifactReference{requiredReference(t, releaseResult.CurrentReference)}, Reason: "The deterministic no-release record verifies this signal.", ObservedAt: t9})
	}
	proposal := st09outcome.Proposal{SchemaVersion: 1, Artifact: "outcome-evaluation-proposal", Version: 1, ProposalID: "outcome-001", IntentID: born.UUID, WorkRequestSHA256: outcomeRequest.Reference.SHA256, Observations: observations, Reason: "Every promised signal is achieved without source or release changes.", ProposedBy: "ai"}
	outcome, err := st09outcome.Evaluate(ctx, projectDir, coreDir, encode(t, proposal), t9)
	if err != nil || outcome.Outcome != "completed" || outcome.State.Status != state.Completed {
		t.Fatalf("ST-09 = %+v, %v", outcome, err)
	}
	if _, err := st09outcome.Prepare(ctx, projectDir, coreDir, st09outcome.PrepareOptions{PreparedAt: t9}); err == nil {
		t.Fatal("completed ST-09 unexpectedly prepared again")
	}
}

func fixture(t *testing.T) (string, string, intent.BornWithState) {
	t.Helper()
	projectDir := t.TempDir()
	coreDir := core(t)
	git(t, projectDir, "init", "-b", "main")
	git(t, projectDir, "config", "user.name", "AI-DLC Test")
	git(t, projectDir, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(projectDir, "README.md"), []byte("# Fixture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, ".gitignore"), []byte("/aidlc/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, projectDir, "add", "README.md", ".gitignore")
	git(t, projectDir, "commit", "-m", "fixture")
	if _, err := workspace.Initialize(projectDir, filepath.Join(coreDir, "memory")); err != nil {
		t.Fatal(err)
	}
	born, err := intent.BirthWithState(context.Background(), projectDir, coreDir, "no build e2e", "default", intent.BirthWorkflowOptions{Identity: intent.Options{Clock: func() time.Time { parsed, _ := time.Parse(time.RFC3339Nano, t0); return parsed }, UUID: func() (string, error) { return "0198e26a-0000-7000-8000-000000000099", nil }}})
	if err != nil {
		t.Fatal(err)
	}
	return projectDir, coreDir, born
}
func core(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime caller")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "core"))
}
func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
}
func encode(t *testing.T, value any) []byte {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func requiredReference(t *testing.T, value *contract.ArtifactReference) contract.ArtifactReference {
	t.Helper()
	if value == nil {
		t.Fatal("required reference is nil")
	}
	return *value
}

func assertTamperRejected(t *testing.T, path string, operation func() error) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(append([]byte{}, content...), ' '), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := operation(); err == nil {
		t.Fatalf("tampered Artifact was accepted: %s", path)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
}
