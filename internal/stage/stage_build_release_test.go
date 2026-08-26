package stage_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/doctor"
	"github.com/sori883/aidlc/internal/intent"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
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
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/orchestrator"
	"github.com/sori883/aidlc/internal/workflow/state"
)

func TestBuildReviewAndAuthorizedGitRelease(t *testing.T) {
	ctx := context.Background()
	projectDir, coreDir, born := fixture(t)
	remote := filepath.Join(t.TempDir(), "remote.git")
	git(t, filepath.Dir(remote), "init", "--bare", remote)
	git(t, projectDir, "remote", "add", "origin", remote)
	git(t, projectDir, "push", "-u", "origin", "main")

	advanceToST07Candidate(t, ctx, projectDir, coreDir, born)

	pending, err := st07review.Prepare(ctx, projectDir, coreDir, t7)
	if err != nil || pending.Pending == nil {
		t.Fatalf("review prepare = %+v, %v", pending, err)
	}
	if resumed, err := st07review.Prepare(ctx, projectDir, coreDir, t7); err != nil || resumed.Execution != "reused" || resumed.Pending == nil || resumed.Pending.ManifestReference != pending.Pending.ManifestReference {
		t.Fatalf("review resume = %+v, %v", resumed, err)
	}
	reviewDirective, err := orchestrator.Resolve(ctx, projectDir, coreDir, orchestrator.Registry{contract.Stage07: st07review.Handler{CoreDir: coreDir}})
	if err != nil || reviewDirective.Kind != directive.Approval {
		t.Fatalf("review directive = %+v, %v", reviewDirective, err)
	}
	accepted, err := st07review.Approve(ctx, projectDir, coreDir, pending.Pending.ManifestReference.SHA256, "The exact Candidate is acceptable.", nil, nil, t7)
	if err != nil || accepted.State.CurrentStage != contract.Stage08 {
		t.Fatalf("review approve = %+v, %v", accepted, err)
	}

	releaseRequest, err := st08release.Prepare(ctx, projectDir, coreDir, t8)
	if err != nil || releaseRequest.Request == nil || len(releaseRequest.Request.SourceTargets) != 1 {
		t.Fatalf("release prepare = %+v, %v", releaseRequest, err)
	}
	if resumed, err := st08release.Prepare(ctx, projectDir, coreDir, t8); err != nil || resumed.Execution != "reused" || resumed.Reference == nil || *resumed.Reference != *releaseRequest.Reference {
		t.Fatalf("release resume = %+v, %v", resumed, err)
	}
	source := releaseRequest.Request.SourceTargets[0]
	repositoryID := source.RepositoryID
	releaseProposal := st08release.Proposal{SchemaVersion: 1, Artifact: "release-plan-proposal", Version: 1, ProposalID: "release-001", IntentID: born.UUID, WorkRequestSHA256: releaseRequest.Reference.SHA256, Disposition: contract.Execute, Targets: []st08release.ProposedTarget{{TargetID: "TARGET-001", TargetKind: "source", Provider: "git", CapabilityID: st08release.GitCapabilityID, RepositoryID: &repositoryID, Locator: "origin#refs/heads/main"}}, Steps: []st08release.Step{{StepID: "STEP-001", TargetID: "TARGET-001", Operation: "source-promote", CapabilityID: st08release.GitCapabilityID, DependsOn: []string{}, DesiredState: source.CandidateRevision, PostReleaseCheck: "target-matches-desired", RollbackMode: "automatic"}}, ReleaseNotes: []string{"Add the verified message artifact."}, Reason: "Promote the accepted Candidate to main.", ProposedBy: "ai"}
	if _, err := st08release.Review(ctx, projectDir, coreDir, []byte("{}"), t8); err == nil {
		t.Fatal("ST-08 accepted an invalid proposal")
	}
	releaseReview, err := st08release.Review(ctx, projectDir, coreDir, encode(t, releaseProposal), t8)
	if err != nil {
		t.Fatal(err)
	}
	releaseDirective, err := orchestrator.Resolve(ctx, projectDir, coreDir, orchestrator.Registry{contract.Stage08: st08release.Handler{CoreDir: coreDir}})
	if err != nil || releaseDirective.Kind != directive.Approval {
		t.Fatalf("release directive = %+v, %v", releaseDirective, err)
	}
	planPath := st08release.PlanPath(stateRecordDir(t, projectDir))
	planBytes, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(planPath, append(planBytes, ' '), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := st08release.Authorize(ctx, projectDir, coreDir, releaseReview.PlanReference.SHA256, "Reject tampered mutable plan.", nil, t8); err == nil {
		t.Fatal("ST-08 accepted a tampered mutable Plan")
	}
	if err := os.WriteFile(planPath, planBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	authorized, err := st08release.Authorize(ctx, projectDir, coreDir, releaseReview.PlanReference.SHA256, "Authorize the exact Git promotion.", nil, t8)
	if err != nil || authorized.Attempt.Status != "active" {
		t.Fatalf("authorize = %+v, %v", authorized, err)
	}
	authorizedDirective, err := orchestrator.Resolve(ctx, projectDir, coreDir, orchestrator.Registry{contract.Stage08: st08release.Handler{CoreDir: coreDir}})
	if err != nil || authorizedDirective.Kind != directive.Parked {
		t.Fatalf("authorized release directive = %+v, %v", authorizedDirective, err)
	}
	released, err := st08release.Execute(ctx, projectDir, coreDir, t8)
	if err != nil || released.Outcome != "released" || released.State.CurrentStage != contract.Stage09 {
		t.Fatalf("execute = %+v, %v", released, err)
	}
	remoteHead := gitOutput(t, projectDir, "ls-remote", "--refs", "origin", "refs/heads/main")
	if len(remoteHead) < len(source.CandidateRevision) || remoteHead[:len(source.CandidateRevision)] != source.CandidateRevision {
		t.Fatalf("remote head = %q, candidate = %q", remoteHead, source.CandidateRevision)
	}
	outcomeRequest, err := st09outcome.Prepare(ctx, projectDir, coreDir, st09outcome.PrepareOptions{PreparedAt: t9})
	if err != nil || outcomeRequest.Request == nil || outcomeRequest.Reference == nil {
		t.Fatalf("outcome prepare = %+v, %v", outcomeRequest, err)
	}
	observations := make([]st09outcome.Observation, 0, len(outcomeRequest.Request.Signals))
	for _, signal := range outcomeRequest.Request.Signals {
		observations = append(observations, st09outcome.Observation{SignalID: signal.SignalID, Result: "inconclusive", EvidenceRefs: []contract.ArtifactReference{*released.CurrentReference}, Reason: "Human confirmation is still required.", ObservedAt: t9})
	}
	outcomeProposal := st09outcome.Proposal{SchemaVersion: 1, Artifact: "outcome-evaluation-proposal", Version: 1, ProposalID: "outcome-release-001", IntentID: born.UUID, WorkRequestSHA256: outcomeRequest.Reference.SHA256, Observations: observations, Reason: "The release is verified but the promised outcome needs a human judgment.", ProposedBy: "ai"}
	evaluated, err := st09outcome.Evaluate(ctx, projectDir, coreDir, encode(t, outcomeProposal), t9)
	if err != nil || evaluated.Outcome != "awaiting_decision" {
		t.Fatalf("outcome evaluate = %+v, %v", evaluated, err)
	}
	assertTamperRejected(t, st09outcome.EvaluationPath(stateRecordDir(t, projectDir)), func() error {
		_, err := orchestrator.Resolve(ctx, projectDir, coreDir, orchestrator.Registry{contract.Stage09: st09outcome.Handler{CoreDir: coreDir}})
		return err
	})
	outcomeDirective, err := orchestrator.Resolve(ctx, projectDir, coreDir, orchestrator.Registry{contract.Stage09: st09outcome.Handler{CoreDir: coreDir}})
	if err != nil || outcomeDirective.Kind != directive.Decision {
		t.Fatalf("outcome directive = %+v, %v", outcomeDirective, err)
	}
	notBefore := t10
	continued, err := st09outcome.Decide(ctx, projectDir, coreDir, st09outcome.DecideOptions{EvaluationSHA256: evaluated.EvaluationReference.SHA256, Decision: "continue-observation", Reason: "Collect one more bounded observation cycle.", NotBefore: &notBefore, DecidedAt: t9})
	if err != nil || continued.Outcome != "continued" {
		t.Fatalf("outcome continue = %+v, %v", continued, err)
	}
	nextRequest, err := st09outcome.Prepare(ctx, projectDir, coreDir, st09outcome.PrepareOptions{PreparedAt: t10})
	if err != nil || nextRequest.Request == nil || nextRequest.Request.Revision != 2 || nextRequest.Reference == nil {
		t.Fatalf("outcome second prepare = %+v, %v", nextRequest, err)
	}
	for index := range observations {
		observations[index].ObservedAt = t10
	}
	outcomeProposal.ProposalID = "outcome-release-002"
	outcomeProposal.WorkRequestSHA256 = nextRequest.Reference.SHA256
	outcomeProposal.Observations = observations
	evaluated, err = st09outcome.Evaluate(ctx, projectDir, coreDir, encode(t, outcomeProposal), t10)
	if err != nil || evaluated.Evaluation.Revision != 2 || evaluated.Outcome != "awaiting_decision" {
		t.Fatalf("outcome second evaluate = %+v, %v", evaluated, err)
	}
	completed, err := st09outcome.Decide(ctx, projectDir, coreDir, st09outcome.DecideOptions{EvaluationSHA256: evaluated.EvaluationReference.SHA256, Decision: "complete-with-outcome", Reason: "Accept the inconclusive observation as the recorded terminal outcome.", DecidedAt: t10})
	if err != nil || completed.State.Status != state.Completed {
		t.Fatalf("outcome decide = %+v, %v", completed, err)
	}
	if report := doctor.Check(projectDir, coreDir); !report.Healthy {
		t.Fatalf("doctor = %+v", report)
	}
}

func TestReleaseRecoversPromotionCompletedBeforeReceipt(t *testing.T) {
	ctx := context.Background()
	projectDir, coreDir, born := fixture(t)
	remote := filepath.Join(t.TempDir(), "remote.git")
	git(t, filepath.Dir(remote), "init", "--bare", remote)
	git(t, projectDir, "remote", "add", "origin", remote)
	git(t, projectDir, "push", "-u", "origin", "main")

	advanceToST07Candidate(t, ctx, projectDir, coreDir, born)
	pending, err := st07review.Prepare(ctx, projectDir, coreDir, t7)
	if err != nil || pending.Pending == nil {
		t.Fatalf("review prepare = %+v, %v", pending, err)
	}
	if _, err := st07review.Approve(ctx, projectDir, coreDir, pending.Pending.ManifestReference.SHA256, "Approve the recovery fixture.", nil, nil, t7); err != nil {
		t.Fatal(err)
	}
	releaseRequest, err := st08release.Prepare(ctx, projectDir, coreDir, t8)
	if err != nil || releaseRequest.Request == nil || releaseRequest.Reference == nil || len(releaseRequest.Request.SourceTargets) != 1 {
		t.Fatalf("release prepare = %+v, %v", releaseRequest, err)
	}
	source := releaseRequest.Request.SourceTargets[0]
	repositoryID := source.RepositoryID
	proposal := st08release.Proposal{
		SchemaVersion: 1, Artifact: "release-plan-proposal", Version: 1, ProposalID: "release-recovery-001", IntentID: born.UUID, WorkRequestSHA256: releaseRequest.Reference.SHA256, Disposition: contract.Execute,
		Targets:      []st08release.ProposedTarget{{TargetID: "TARGET-001", TargetKind: "source", Provider: "git", CapabilityID: st08release.GitCapabilityID, RepositoryID: &repositoryID, Locator: "origin#refs/heads/main"}},
		Steps:        []st08release.Step{{StepID: "STEP-001", TargetID: "TARGET-001", Operation: "source-promote", CapabilityID: st08release.GitCapabilityID, DependsOn: []string{}, DesiredState: source.CandidateRevision, PostReleaseCheck: "target-matches-desired", RollbackMode: "automatic"}},
		ReleaseNotes: []string{"Verify crash-safe Release resume."}, Reason: "Recover a completed promotion without replaying it.", ProposedBy: "ai",
	}
	reviewed, err := st08release.Review(ctx, projectDir, coreDir, encode(t, proposal), t8)
	if err != nil {
		t.Fatal(err)
	}
	authorized, err := st08release.Authorize(ctx, projectDir, coreDir, reviewed.PlanReference.SHA256, "Authorize the recovery fixture.", nil, t8)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate a process exit after the external promotion succeeded but before
	// Core persisted the step receipt. Execute must observe and recover it.
	git(t, projectDir, "push", "origin", source.CandidateRevision+":refs/heads/main")
	released, err := st08release.Execute(ctx, projectDir, coreDir, t8)
	if err != nil || released.Outcome != "released" || released.Receipt == nil || len(released.Receipt.StepReceiptRefs) != 1 {
		t.Fatalf("recovered execute = %+v, %v", released, err)
	}
	stepPath, err := stageruntime.ReadReference(projectDir, released.Receipt.StepReceiptRefs[0])
	if err != nil {
		t.Fatal(err)
	}
	step, _, _, err := stageruntime.ReadCanonical[st08release.StepReceipt](projectDir, stepPath, "release-step-receipt", 1)
	if err != nil || step.Outcome != "recovered" || step.Attempt != authorized.Attempt.Attempt {
		t.Fatalf("recovered step = %+v, %v", step, err)
	}
}

func TestReviewManifestTamperingFailsClosed(t *testing.T) {
	ctx := context.Background()
	projectDir, coreDir, born := fixture(t)
	advanceToST07Candidate(t, ctx, projectDir, coreDir, born)
	pending, err := st07review.Prepare(ctx, projectDir, coreDir, t7)
	if err != nil || pending.Pending == nil {
		t.Fatalf("prepare = %+v, %v", pending, err)
	}
	path := st07review.ManifestPath(stateRecordDir(t, projectDir))
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(content, ' '), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := st07review.Prepare(ctx, projectDir, coreDir, t7); err == nil {
		t.Fatal("tampered Review Manifest was accepted")
	}
}

func advanceToST07Candidate(t *testing.T, ctx context.Context, projectDir, coreDir string, born intent.BornWithState) {
	t.Helper()
	buildRequest := advanceToST05(t, ctx, projectDir, coreDir, born)
	proposal := executableBuildProposal(born, buildRequest)
	reviewed, err := st05buildcontract.Review(ctx, projectDir, coreDir, encode(t, proposal), t5)
	if err != nil {
		t.Fatal(err)
	}
	approved, err := st05buildcontract.Approve(ctx, projectDir, coreDir, reviewed.CandidateReference.SHA256, "Approve the executable Build Contract.", nil, t5)
	if err != nil || approved.State.CurrentStage != contract.Stage06 {
		t.Fatalf("approve = %+v, %v", approved, err)
	}
	prepared, err := st06build.Prepare(ctx, projectDir, coreDir, t6)
	if err != nil || prepared.Request == nil || len(prepared.Request.SourceWorkspaces) != 1 {
		t.Fatalf("prepare = %+v, %v", prepared, err)
	}
	assertTamperRejected(t, st06build.SessionPath(stateRecordDir(t, projectDir)), func() error {
		_, err := st06build.Prepare(ctx, projectDir, coreDir, t6)
		return err
	})
	if resumed, err := st06build.Prepare(ctx, projectDir, coreDir, t6); err != nil || resumed.Execution != "reused" || resumed.Reference == nil || *resumed.Reference != *prepared.Reference {
		t.Fatalf("build resume = %+v, %v", resumed, err)
	}
	if err := os.WriteFile(filepath.Join(prepared.Request.SourceWorkspaces[0].WorktreePath, "message.txt"), []byte("hello from Go\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	verified, err := st06build.Verify(ctx, projectDir, coreDir, "BOLT-001", t6)
	if err != nil || verified.Outcome != "candidate" || verified.Candidate == nil || verified.State.CurrentStage != contract.Stage07 {
		t.Fatalf("verify = %+v, %v", verified, err)
	}
	if len(verified.Candidate.IntegrationVerifierEvidenceRefs) != 1 {
		t.Fatalf("integration refs = %v", verified.Candidate.IntegrationVerifierEvidenceRefs)
	}
}

func stateRecordDir(t *testing.T, projectDir string) string {
	t.Helper()
	snapshot, err := state.Resume(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot.RecordDir
}

func TestBuildBlocksAfterThreeIdenticalContractFailures(t *testing.T) {
	ctx := context.Background()
	projectDir, coreDir, born := fixture(t)
	request := advanceToST05(t, ctx, projectDir, coreDir, born)
	proposal := executableBuildProposal(born, request)
	reviewed, err := st05buildcontract.Review(ctx, projectDir, coreDir, encode(t, proposal), t5)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st05buildcontract.Approve(ctx, projectDir, coreDir, reviewed.CandidateReference.SHA256, "Approve failure-boundary fixture.", nil, t5); err != nil {
		t.Fatal(err)
	}
	prepared, err := st06build.Prepare(ctx, projectDir, coreDir, t6)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 3; attempt++ {
		if prepared.Request == nil {
			t.Fatalf("attempt %d missing request", attempt)
		}
		if err := os.WriteFile(filepath.Join(prepared.Request.SourceWorkspaces[0].WorktreePath, "outside.txt"), []byte("same failure\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		result, err := st06build.Verify(ctx, projectDir, coreDir, "BOLT-001", t6)
		if err != nil {
			t.Fatal(err)
		}
		if attempt < 3 {
			if result.Outcome != "retry" || result.Request == nil {
				t.Fatalf("attempt %d = %+v", attempt, result)
			}
			prepared.Request = result.Request
		} else if result.Outcome != "blocked" || result.State.CurrentStage != contract.Stage06 {
			t.Fatalf("attempt 3 = %+v", result)
		}
	}
}

func executableBuildProposal(born intent.BornWithState, buildRequest st05buildcontract.PrepareResult) st05buildcontract.Proposal {
	sourceID := buildRequest.Request.TargetSources[0].SourceID
	cwd := "."
	checkExpected := "hello from Go"
	return st05buildcontract.Proposal{
		SchemaVersion: 1, Artifact: "build-contract-proposal", Version: 1, ProposalID: "build-contract-execute-001", IntentID: born.UUID, WorkRequestSHA256: buildRequest.Reference.SHA256, Disposition: contract.Execute,
		RequirementAssessments: []st05buildcontract.Assessment{{RequirementID: "REQ-F-001", BuildImpact: true, Reason: "A new repository artifact is required."}},
		ChangeContracts:        []st05buildcontract.ChangeContract{{ContractID: "CHG-001", Title: "Add the verified artifact", RequirementIDs: []string{"REQ-F-001"}, Targets: []st05buildcontract.Target{{SourceID: sourceID, Path: "message.txt"}}, DependsOnContractIDs: []string{}, Specification: []string{"Write the approved message."}}},
		AcceptanceCriteria:     []st05buildcontract.AcceptanceCriterion{{CriterionID: "AC-001", RequirementIDs: []string{"REQ-F-001"}, Given: "The selected repository", When: "the Bolt completes", Then: "message.txt contains the approved text", VerifierIDs: []string{"VER-001"}}},
		Verifiers:              []st05buildcontract.Verifier{{VerifierID: "VER-001", Kind: "artifact", SourceID: &sourceID, CWD: &cwd, Argv: []string{}, TimeoutMS: 1000, ExpectedExitCodes: []int{}, ArtifactCheck: &st05buildcontract.ArtifactCheck{Path: "message.txt", Assertion: "content-includes", Expected: &checkExpected}, Expected: "message.txt contains the approved text"}},
		Bolts:                  []st05buildcontract.Bolt{{BoltID: "BOLT-001", Title: "Add message", Objective: "Create the approved repository artifact.", ContractIDs: []string{"CHG-001"}, AcceptanceCriterionIDs: []string{"AC-001"}, Targets: []st05buildcontract.Target{{SourceID: sourceID, Path: "message.txt"}}, DependsOn: []string{}}},
		IntegrationContract:    &st05buildcontract.IntegrationContract{AcceptanceCriterionIDs: []string{"AC-001"}, VerifierIDs: []string{"VER-001"}, CandidateReadyWhen: []string{"The integration artifact verifier passes."}}, Evidence: []contract.ArtifactReference{}, Reason: "One isolated Bolt implements and verifies the change.", ProposedBy: "ai",
	}
}

func advanceToST05(t *testing.T, ctx context.Context, projectDir, coreDir string, born intent.BornWithState) st05buildcontract.PrepareResult {
	t.Helper()
	if _, err := st00bootstrap.Execute(ctx, projectDir, coreDir, st00bootstrap.Options{CreatedAt: t1}); err != nil {
		t.Fatal(err)
	}
	orientRequest, err := st01orient.Prepare(ctx, projectDir, coreDir, t1)
	if err != nil {
		t.Fatal(err)
	}
	orientProposal := st01orient.Proposal{SchemaVersion: 1, Artifact: "orient-proposal", Version: 1, IntentID: born.UUID, WorkRequestSHA256: orientRequest.Reference.SHA256, SystemMapPatch: st01orient.Patch{SchemaVersion: 1, Artifact: "system-map-patch", Version: 1, ProposalID: "orient-build-001", MapID: "default-system", Perspective: "accepted-code-baseline", SourceSnapshots: orientRequest.Profile.RepositorySnapshots, Evidence: []st01orient.Evidence{}, CoverageUpserts: []st01orient.Coverage{}, EntityUpserts: []st01orient.Entity{}, RelationUpserts: []st01orient.Relation{}, RemoveEntityIDs: []string{}, RemoveRelationIDs: []string{}, Reason: "Record repository baseline.", ProposedAt: t1, ProposedBy: "ai"}, CurrentContext: st01orient.ContextProposal{EntityIDs: []string{}, RelationIDs: []string{}, AdditionalFindings: []string{}, OutOfScope: []string{}, IntentOnlyNotes: []string{}, Unknowns: []string{}}, ProposedBy: "ai"}
	if _, err := st01orient.Complete(ctx, projectDir, coreDir, encode(t, orientProposal), t1); err != nil {
		t.Fatal(err)
	}
	intentRequest, err := st02defineintent.Prepare(ctx, projectDir, coreDir, t2)
	if err != nil {
		t.Fatal(err)
	}
	intentProposal := st02defineintent.Proposal{SchemaVersion: 1, Artifact: "intent-definition-proposal", Version: 1, ProposalID: "intent-build-001", IntentID: born.UUID, WorkRequestSHA256: intentRequest.Reference.SHA256, Purpose: "Add one verified repository artifact.", ExpectedOutcomes: []string{"The repository contains message.txt."}, InScope: []string{"Add message.txt."}, OutOfScope: []string{"Unrelated source changes."}, SuccessSignals: []string{"message.txt contains the approved text."}, Unknowns: []string{}, Reason: "The requested change is bounded.", ProposedBy: "ai"}
	if _, err := st02defineintent.Complete(ctx, projectDir, coreDir, encode(t, intentProposal), t2); err != nil {
		t.Fatal(err)
	}
	requirementsRequest, err := st03requirements.Prepare(ctx, projectDir, coreDir, t3)
	if err != nil {
		t.Fatal(err)
	}
	requirementsProposal := st03requirements.Proposal{SchemaVersion: 1, Artifact: "requirements-definition-proposal", Version: 1, ProposalID: "requirements-build-001", IntentID: born.UUID, WorkRequestSHA256: requirementsRequest.Reference.SHA256, FunctionalRequirements: []st03requirements.Item{{ID: "REQ-F-001", Statement: "The repository contains message.txt with the approved text.", SourceRefs: []st03requirements.SourceRef{{Artifact: "intent-definition", Pointer: "/expected_outcomes/0"}, {Artifact: "intent-definition", Pointer: "/success_signals/0"}}}}, QualityRequirements: []st03requirements.Item{}, Constraints: []st03requirements.Item{}, Invariants: []st03requirements.Item{}, OpenQuestions: []st03requirements.OpenQuestion{}, Reason: "The change has one traceable requirement.", ProposedBy: "ai"}
	requirementsResult, err := st03requirements.Complete(ctx, projectDir, coreDir, encode(t, requirementsProposal), t3)
	if err != nil {
		t.Fatal(err)
	}
	architectureRequest, err := st04architecture.Prepare(ctx, projectDir, coreDir, t4)
	if err != nil {
		t.Fatal(err)
	}
	architectureProposal := st04architecture.Proposal{SchemaVersion: 1, Artifact: "architecture-assessment-proposal", Version: 1, ProposalID: "architecture-build-001", IntentID: born.UUID, WorkRequestSHA256: architectureRequest.Reference.SHA256, Disposition: contract.NotApplicable, RequirementAssessments: []st04architecture.Assessment{{RequirementID: "REQ-F-001", ArchitectureImpact: false, Reason: "A standalone text artifact does not affect system structure.", CurrentEntityRefs: []string{}}}, Decisions: []st04architecture.DecisionDraft{}, Evidence: []contract.ArtifactReference{architectureRequest.Request.RequirementsRef, architectureRequest.Request.SystemMapRef}, Reason: "No Architecture Decision is needed.", ProposedBy: "ai"}
	if _, err := st04architecture.Complete(ctx, projectDir, coreDir, encode(t, architectureProposal), t4); err != nil {
		t.Fatal(err)
	}
	result, err := st05buildcontract.Prepare(ctx, projectDir, coreDir, t5)
	if err != nil {
		t.Fatal(err)
	}
	_ = requirementsResult
	return result
}

func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
	return string(output)
}
