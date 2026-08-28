// Package st07review implements the SHA-256-bound human Candidate review.
package st07review

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/explanationhtml"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/process"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st01orient"
	"github.com/sori883/aidlc/internal/stage/st03requirements"
	"github.com/sori883/aidlc/internal/stage/st05buildcontract"
	"github.com/sori883/aidlc/internal/stage/st06build"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/gate"
	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

type RequirementSummary struct {
	RequirementID string `json:"requirement_id"`
	Statement     string `json:"statement"`
}
type HumanCheck struct {
	VerifierID string `json:"verifier_id"`
	Expected   string `json:"expected"`
}
type HumanCheckResult struct {
	VerifierID string `json:"verifier_id"`
	Result     string `json:"result"`
	Note       string `json:"note"`
}
type FeedbackItem struct {
	FeedbackID     string   `json:"feedback_id"`
	Summary        string   `json:"summary"`
	RequirementIDs []string `json:"requirement_ids"`
	Impacts        []string `json:"impacts"`
}
type Manifest struct {
	SchemaVersion          int                                     `json:"schema_version"`
	Artifact               string                                  `json:"artifact"`
	Version                int                                     `json:"version"`
	IntentID               string                                  `json:"intent_id"`
	StageID                contract.StageID                        `json:"stage_id"`
	Disposition            contract.Disposition                    `json:"disposition"`
	BuildCurrentRef        contract.ArtifactReference              `json:"build_current_ref"`
	RunnableCandidateRef   contract.ArtifactReference              `json:"runnable_candidate_ref"`
	RequirementsRef        contract.ArtifactReference              `json:"requirements_ref"`
	ArchitectureCurrentRef contract.ArtifactReference              `json:"architecture_current_ref"`
	BuildContractRef       contract.ArtifactReference              `json:"build_contract_ref"`
	EffectivePolicyRef     contract.ArtifactReference              `json:"effective_policy_ref"`
	SystemMapRef           contract.ArtifactReference              `json:"system_map_ref"`
	SourceResults          []st06build.SourceResult                `json:"source_results"`
	Requirements           []RequirementSummary                    `json:"requirements"`
	AcceptanceCriteria     []st05buildcontract.AcceptanceCriterion `json:"acceptance_criteria"`
	MachineEvidenceRefs    []contract.ArtifactReference            `json:"machine_evidence_refs"`
	HumanChecks            []HumanCheck                            `json:"human_checks"`
	KnownConstraints       []string                                `json:"known_constraints"`
	CreatedAt              string                                  `json:"created_at"`
}
type Decision struct {
	SchemaVersion          int                        `json:"schema_version"`
	Artifact               string                     `json:"artifact"`
	Version                int                        `json:"version"`
	DecisionID             string                     `json:"decision_id"`
	DecisionKind           string                     `json:"decision_kind"`
	IntentID               string                     `json:"intent_id"`
	ReviewManifestRef      contract.ArtifactReference `json:"review_manifest_ref"`
	RunnableCandidateRef   contract.ArtifactReference `json:"runnable_candidate_ref"`
	GateRequirementSetRef  contract.ArtifactReference `json:"gate_requirement_set_ref"`
	PolicyAcknowledgements []gate.Acknowledgement     `json:"policy_acknowledgements"`
	HumanInputReceiptRef   contract.ArtifactReference `json:"human_input_receipt_ref"`
	Decision               string                     `json:"decision"`
	HumanCheckResults      []HumanCheckResult         `json:"human_check_results"`
	FeedbackItems          []FeedbackItem             `json:"feedback_items"`
	Reason                 string                     `json:"reason"`
	DecidedBy              string                     `json:"decided_by"`
	DecidedAt              string                     `json:"decided_at"`
}
type AcceptedCandidate struct {
	SchemaVersion          int                        `json:"schema_version"`
	Artifact               string                     `json:"artifact"`
	Version                int                        `json:"version"`
	IntentID               string                     `json:"intent_id"`
	RunnableCandidateRef   contract.ArtifactReference `json:"runnable_candidate_ref"`
	ReviewManifestRef      contract.ArtifactReference `json:"review_manifest_ref"`
	ApprovalRef            contract.ArtifactReference `json:"approval_ref"`
	RequirementsRef        contract.ArtifactReference `json:"requirements_ref"`
	ArchitectureCurrentRef contract.ArtifactReference `json:"architecture_current_ref"`
	BuildContractRef       contract.ArtifactReference `json:"build_contract_ref"`
	SystemMapRef           contract.ArtifactReference `json:"system_map_ref"`
	SourceResults          []st06build.SourceResult   `json:"source_results"`
	AcceptedAt             string                     `json:"accepted_at"`
}
type FeedbackCurrent struct {
	SchemaVersion        int                        `json:"schema_version"`
	Artifact             string                     `json:"artifact"`
	Version              int                        `json:"version"`
	IntentID             string                     `json:"intent_id"`
	ReviewManifestRef    contract.ArtifactReference `json:"review_manifest_ref"`
	HumanDecisionRef     contract.ArtifactReference `json:"human_decision_ref"`
	RejectedCandidateRef contract.ArtifactReference `json:"rejected_candidate_ref"`
	FeedbackItems        []FeedbackItem             `json:"feedback_items"`
	SelectedReason       string                     `json:"selected_reason"`
	ReturnStage          contract.StageID           `json:"return_stage"`
	InvalidatedStages    []contract.StageID         `json:"invalidated_stages"`
	Reason               string                     `json:"reason"`
	UpdatedAt            string                     `json:"updated_at"`
}
type Current struct {
	SchemaVersion        int                         `json:"schema_version"`
	Artifact             string                      `json:"artifact"`
	Version              int                         `json:"version"`
	IntentID             string                      `json:"intent_id"`
	Disposition          contract.Disposition        `json:"disposition"`
	Outcome              string                      `json:"outcome"`
	ReviewManifestRef    *contract.ArtifactReference `json:"review_manifest_ref"`
	HumanDecisionRef     contract.ArtifactReference  `json:"human_decision_ref"`
	AcceptedCandidateRef *contract.ArtifactReference `json:"accepted_candidate_ref"`
	FeedbackCurrentRef   *contract.ArtifactReference `json:"feedback_current_ref"`
	Reason               string                      `json:"reason"`
	UpdatedAt            string                      `json:"updated_at"`
}
type Pending struct {
	Manifest          Manifest                   `json:"manifest"`
	ManifestReference contract.ArtifactReference `json:"manifestReference"`
	ReviewReference   contract.ArtifactReference `json:"reviewReference"`
}
type PrepareResult struct {
	Execution        string                      `json:"execution"`
	Pending          *Pending                    `json:"pending"`
	Current          *Current                    `json:"current"`
	CurrentReference *contract.ArtifactReference `json:"currentReference"`
	HumanGate        *humanapproval.OpenResult   `json:"humanGate"`
	State            state.IntentState           `json:"state"`
}
type DecisionResult struct {
	Decision                   Decision                    `json:"decision"`
	DecisionReference          contract.ArtifactReference  `json:"decisionReference"`
	AcceptedCandidate          *AcceptedCandidate          `json:"acceptedCandidate"`
	AcceptedCandidateReference *contract.ArtifactReference `json:"acceptedCandidateReference"`
	Feedback                   *FeedbackCurrent            `json:"feedback"`
	FeedbackReference          *contract.ArtifactReference `json:"feedbackReference"`
	Current                    Current                     `json:"current"`
	CurrentReference           contract.ArtifactReference  `json:"currentReference"`
	HumanGateResolution        humanapproval.Resolution    `json:"humanGateResolution"`
	HumanGateResolutionRef     contract.ArtifactReference  `json:"humanGateResolutionReference"`
	State                      state.IntentState           `json:"state"`
}

func RootDir(recordDir string) string { return filepath.Join(recordDir, "artifacts", "review") }
func ManifestPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "review-manifest.json")
}
func ReviewPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "review.html") }
func ManifestRevisionPath(recordDir, candidateSHA string) string {
	return filepath.Join(RootDir(recordDir), "cycles", strings.TrimPrefix(candidateSHA, "sha256:"), "review-manifest.json")
}
func ReviewRevisionPath(recordDir, candidateSHA string) string {
	return filepath.Join(RootDir(recordDir), "cycles", strings.TrimPrefix(candidateSHA, "sha256:"), "review.html")
}
func DecisionPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "human-decision.json")
}
func DecisionRevisionPath(recordDir, decisionID string) string {
	return filepath.Join(RootDir(recordDir), "decisions", decisionID+".json")
}
func AcceptedPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "accepted-candidate.json")
}
func FeedbackPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "feedback-current.json")
}
func FeedbackRevisionPath(recordDir, candidateSHA string) string {
	return filepath.Join(RootDir(recordDir), "cycles", strings.TrimPrefix(candidateSHA, "sha256:"), "feedback-current.json")
}
func CurrentPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "current.json") }

func Prepare(ctx context.Context, projectDir, coreDir, at string) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage07)
	if err != nil {
		return PrepareResult{}, err
	}
	buildCurrent, buildCurrentRef, _, err := stageruntime.ReadCanonical[st06build.Current](current.ProjectDir, st06build.CurrentPath(current.Snapshot.RecordDir), "build-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	contractCurrent, _, _, err := stageruntime.ReadCanonical[st05buildcontract.Current](current.ProjectDir, st05buildcontract.CurrentPath(current.Snapshot.RecordDir), "build-contract-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if at == "" {
		at = stageruntime.Now()
	}
	if buildCurrent.Disposition == contract.NotApplicable || buildCurrent.RunnableCandidateRef == nil {
		value := Current{SchemaVersion: 1, Artifact: "review-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: contract.NotApplicable, Outcome: "not_applicable", HumanDecisionRef: contractCurrent.ApprovalRef, Reason: "ST-06 produced no Runnable Candidate; the exact ST-05 approval is deterministic Evidence.", UpdatedAt: at}
		ref, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), value.Artifact, 1, value, false)
		if err != nil {
			return PrepareResult{}, err
		}
		revised, err := revise(current, contract.NotApplicable, "st07-no-candidate", value.Reason, []contract.ArtifactReference{buildCurrentRef, contractCurrent.ApprovalRef, ref}, true)
		if err != nil {
			return PrepareResult{}, err
		}
		current.Snapshot.Plan = revised
		current.Snapshot.State.PlanRevision = revised.Revision
		advanced, err := stageruntime.Advance(ctx, current, ref, "candidate-binding-validator", "ST-08 Release is ready for Core preparation.", at)
		return PrepareResult{Execution: "advanced", Current: &value, CurrentReference: &ref, State: advanced}, err
	}
	manifestExists := fileExists(ManifestPath(current.Snapshot.RecordDir))
	reviewExists := fileExists(ReviewPath(current.Snapshot.RecordDir))
	if manifestExists != reviewExists {
		return PrepareResult{}, fmt.Errorf("ST-07 Human Review: Manifest and HTML must exist together")
	}
	if manifestExists {
		pending, err := readPending(current.ProjectDir, current.Snapshot.RecordDir)
		if err != nil {
			return PrepareResult{}, err
		}
		if pending.Manifest.RunnableCandidateRef.SHA256 != buildCurrent.RunnableCandidateRef.SHA256 {
			return PrepareResult{}, fmt.Errorf("ST-07 Human Review: existing Manifest is stale")
		}
		return PrepareResult{Execution: "reused", Pending: &pending, State: current.Snapshot.State}, nil
	}
	candidatePath, err := stageruntime.ReadReference(current.ProjectDir, *buildCurrent.RunnableCandidateRef)
	if err != nil {
		return PrepareResult{}, err
	}
	candidate, candidateRef, candidateBytes, err := stageruntime.ReadCanonical[st06build.RunnableCandidate](current.ProjectDir, candidatePath, "runnable-candidate", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if candidateRef != *buildCurrent.RunnableCandidateRef {
		return PrepareResult{}, fmt.Errorf("ST-07 Human Review: Candidate binding differs")
	}
	if contractCurrent.BuildContractRef == nil || candidate.BuildContractRef != *contractCurrent.BuildContractRef {
		return PrepareResult{}, fmt.Errorf("ST-07 Human Review: Candidate Build Contract differs")
	}
	snapshotPath := filepath.Join(RootDir(current.Snapshot.RecordDir), "candidates", candidateRef.SHA256[7:], "runnable-candidate.json")
	snapshotRef, err := writeRawImmutable(current.ProjectDir, snapshotPath, "runnable-candidate", candidateBytes)
	if err != nil {
		return PrepareResult{}, err
	}
	contractPath, err := stageruntime.ReadReference(current.ProjectDir, *contractCurrent.BuildContractRef)
	if err != nil {
		return PrepareResult{}, err
	}
	buildContract, _, _, err := stageruntime.ReadCanonical[st05buildcontract.BuildContract](current.ProjectDir, contractPath, "build-contract", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if err := verifyCandidateGit(ctx, current.ProjectDir, candidate, buildContract); err != nil {
		return PrepareResult{}, err
	}
	requirementsPath, err := stageruntime.ReadReference(current.ProjectDir, contractCurrent.RequirementsRef)
	if err != nil {
		return PrepareResult{}, err
	}
	requirements, _, _, err := stageruntime.ReadCanonical[st03requirements.Definition](current.ProjectDir, requirementsPath, "requirements-definition", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	selected := selectRequirements(requirements, buildContract.RequirementAssessments)
	if len(selected) != len(buildContract.RequirementAssessments) {
		return PrepareResult{}, fmt.Errorf("ST-07 Human Review: Build Contract requirement coverage differs")
	}
	humanChecks := []HumanCheck{}
	for _, verifier := range buildContract.Verifiers {
		if verifier.Kind == "human-at-st07" {
			humanChecks = append(humanChecks, HumanCheck{VerifierID: verifier.VerifierID, Expected: verifier.Expected})
		}
	}
	known := make([]string, 0, len(requirements.Constraints)+len(requirements.Invariants))
	for _, item := range append(append([]st03requirements.Item{}, requirements.Constraints...), requirements.Invariants...) {
		known = append(known, item.Statement)
	}
	evidence := append(append([]contract.ArtifactReference{}, candidate.BoltCheckpointRefs...), candidate.IntegrationVerifierEvidenceRefs...)
	for _, ref := range evidence {
		if _, err := stageruntime.ReadReference(current.ProjectDir, ref); err != nil {
			return PrepareResult{}, err
		}
	}
	manifest := Manifest{SchemaVersion: 1, Artifact: "review-manifest", Version: 1, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage07, Disposition: buildCurrent.Disposition, BuildCurrentRef: buildCurrentRef, RunnableCandidateRef: snapshotRef, RequirementsRef: contractCurrent.RequirementsRef, ArchitectureCurrentRef: contractCurrent.ArchitectureCurrentRef, BuildContractRef: *contractCurrent.BuildContractRef, EffectivePolicyRef: contractCurrent.EffectivePolicyRef, SystemMapRef: contractCurrent.SystemMapRef, SourceResults: candidate.SourceResults, Requirements: selected, AcceptanceCriteria: buildContract.AcceptanceCriteria, MachineEvidenceRefs: evidence, HumanChecks: humanChecks, KnownConstraints: known, CreatedAt: at}
	manifestRef, manifestBytes, err := stageruntime.WriteCanonical(current.ProjectDir, ManifestRevisionPath(current.Snapshot.RecordDir, snapshotRef.SHA256), manifest.Artifact, 1, manifest, true)
	if err != nil {
		return PrepareResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, ManifestPath(current.Snapshot.RecordDir), manifest.Artifact, manifestBytes); err != nil {
		return PrepareResult{}, err
	}
	gateSet, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage07, manifest.EffectivePolicyRef, at)
	if err != nil {
		return PrepareResult{}, err
	}
	renderedHTML, err := renderHTML(manifest, gateSet.Set)
	if err != nil {
		return PrepareResult{}, err
	}
	htmlBytes := []byte(renderedHTML)
	reviewRef, err := writeRawImmutable(current.ProjectDir, ReviewRevisionPath(current.Snapshot.RecordDir, snapshotRef.SHA256), "review-html", htmlBytes)
	if err != nil {
		return PrepareResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, ReviewPath(current.Snapshot.RecordDir), "review-html", htmlBytes); err != nil {
		return PrepareResult{}, err
	}
	humanGate, err := humanapproval.Open(ctx, current.ProjectDir, current.Snapshot.RecordDir, humanapproval.OpenOptions{
		IntentID: current.Snapshot.State.IntentID, Scope: string(contract.Stage07),
		SubjectRef: manifestRef, ReviewRef: reviewRef, GateRequirementRef: &gateSet.Reference,
		GraphVersion: current.Snapshot.State.GraphVersion, PlanRevision: current.Snapshot.State.PlanRevision,
		AllowedActions: []string{"approve-runnable-candidate", "request-changes"}, OpenedAt: at,
	})
	if err != nil {
		return PrepareResult{}, err
	}
	parked, err := stageruntime.Park(ctx, current, "ST-07 is awaiting human approval or classified feedback for the exact Review Manifest SHA-256.", at)
	if err != nil {
		return PrepareResult{}, err
	}
	_, _ = audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.StageAwaitingApproval, []audit.Field{{Name: "Stage", Value: "ST-07"}, {Name: "Review Manifest SHA-256", Value: manifestRef.SHA256}, {Name: "Review", Value: reviewRef.SourceOfTruth}, {Name: "Decision Authority", Value: "human"}}, nil)
	pending := Pending{Manifest: manifest, ManifestReference: manifestRef, ReviewReference: reviewRef}
	return PrepareResult{Execution: "prepared", Pending: &pending, HumanGate: &humanGate, State: parked}, nil
}

type DecisionParameters struct {
	PolicyAcknowledgements []gate.Acknowledgement `json:"policy_acknowledgements"`
	HumanCheckResults      []HumanCheckResult     `json:"human_check_results"`
	FeedbackItems          []FeedbackItem         `json:"feedback_items"`
}

func Approve(ctx context.Context, projectDir, coreDir string, proof humanapproval.Proof) (DecisionResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage07)
	if err != nil {
		return DecisionResult{}, err
	}
	pending, err := readPending(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return DecisionResult{}, err
	}
	if err := proof.Require(string(contract.Stage07), "approve-runnable-candidate", pending.ManifestReference.SHA256); err != nil {
		return DecisionResult{}, fmt.Errorf("ST-07 Human Review: %w", err)
	}
	var parameters DecisionParameters
	if err := proof.Parameters(&parameters); err != nil {
		return DecisionResult{}, fmt.Errorf("ST-07 approval parameters: %w", err)
	}
	checks := parameters.HumanCheckResults
	acknowledgements := parameters.PolicyAcknowledgements
	if len(parameters.FeedbackItems) != 0 {
		return DecisionResult{}, fmt.Errorf("ST-07 approval parameters cannot contain feedback_items")
	}
	reason := proof.Reason()
	at := proof.Receipt().ObservedAt
	if err := validateChecks(pending.Manifest, checks, true); err != nil {
		return DecisionResult{}, err
	}
	if err := stageruntime.OneLine(reason, "ST-07 approval reason"); err != nil {
		return DecisionResult{}, err
	}
	gateSet, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage07, pending.Manifest.EffectivePolicyRef, at)
	if err != nil {
		return DecisionResult{}, err
	}
	if err := gate.ValidateAcknowledgements(current.ProjectDir, current.Snapshot.RecordDir, gateSet.Set, acknowledgements, true); err != nil {
		return DecisionResult{}, err
	}
	if acknowledgements == nil {
		acknowledgements = []gate.Acknowledgement{}
	}
	if checks == nil {
		checks = []HumanCheckResult{}
	}
	decision := Decision{SchemaVersion: 1, Artifact: "human-decision", Version: 1, DecisionID: "approve-" + pending.ManifestReference.SHA256[7:19], DecisionKind: "candidate-review", IntentID: current.Snapshot.State.IntentID, ReviewManifestRef: pending.ManifestReference, RunnableCandidateRef: pending.Manifest.RunnableCandidateRef, GateRequirementSetRef: gateSet.Reference, PolicyAcknowledgements: acknowledgements, HumanInputReceiptRef: proof.ReceiptReference(), Decision: "approve-runnable-candidate", HumanCheckResults: checks, FeedbackItems: []FeedbackItem{}, Reason: reason, DecidedBy: "human", DecidedAt: at}
	decisionRef, decisionBytes, err := stageruntime.WriteCanonical(current.ProjectDir, DecisionRevisionPath(current.Snapshot.RecordDir, decision.DecisionID), decision.Artifact, 1, decision, true)
	if err != nil {
		return DecisionResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, DecisionPath(current.Snapshot.RecordDir), decision.Artifact, decisionBytes); err != nil {
		return DecisionResult{}, err
	}
	mapRef, err := promoteSystemMap(current.ProjectDir, pending.Manifest.SystemMapRef, pending.Manifest.SourceResults, at)
	if err != nil {
		return DecisionResult{}, err
	}
	accepted := AcceptedCandidate{SchemaVersion: 1, Artifact: "accepted-candidate", Version: 1, IntentID: current.Snapshot.State.IntentID, RunnableCandidateRef: pending.Manifest.RunnableCandidateRef, ReviewManifestRef: pending.ManifestReference, ApprovalRef: decisionRef, RequirementsRef: pending.Manifest.RequirementsRef, ArchitectureCurrentRef: pending.Manifest.ArchitectureCurrentRef, BuildContractRef: pending.Manifest.BuildContractRef, SystemMapRef: mapRef, SourceResults: pending.Manifest.SourceResults, AcceptedAt: at}
	acceptedRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, AcceptedPath(current.Snapshot.RecordDir), accepted.Artifact, 1, accepted, true)
	if err != nil {
		return DecisionResult{}, err
	}
	value := Current{SchemaVersion: 1, Artifact: "review-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: pending.Manifest.Disposition, Outcome: "approved", ReviewManifestRef: &pending.ManifestReference, HumanDecisionRef: decisionRef, AcceptedCandidateRef: &acceptedRef, Reason: reason, UpdatedAt: at}
	valueRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), value.Artifact, 1, value, false)
	if err != nil {
		return DecisionResult{}, err
	}
	revised, err := revise(current, pending.Manifest.Disposition, "st07-approved-"+pending.ManifestReference.SHA256[7:19], reason, []contract.ArtifactReference{decisionRef, acceptedRef, valueRef}, false)
	if err != nil {
		return DecisionResult{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	advanced, err := stageruntime.Advance(ctx, current, valueRef, "accepted-baseline-promoter", "ST-08 Release is ready for Core preparation.", at)
	if err != nil {
		return DecisionResult{}, err
	}
	resolution, resolutionRef, err := humanapproval.Resolve(ctx, current.ProjectDir, current.Snapshot.RecordDir, proof, &decisionRef, "approved", at)
	if err != nil {
		return DecisionResult{}, err
	}
	return DecisionResult{Decision: decision, DecisionReference: decisionRef, AcceptedCandidate: &accepted, AcceptedCandidateReference: &acceptedRef, Current: value, CurrentReference: valueRef, HumanGateResolution: resolution, HumanGateResolutionRef: resolutionRef, State: advanced}, nil
}

func Feedback(ctx context.Context, projectDir, coreDir string, proof humanapproval.Proof) (DecisionResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage07)
	if err != nil {
		return DecisionResult{}, err
	}
	pending, err := readPending(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return DecisionResult{}, err
	}
	if err := proof.Require(string(contract.Stage07), "request-changes", pending.ManifestReference.SHA256); err != nil {
		return DecisionResult{}, fmt.Errorf("ST-07 Human Review: %w", err)
	}
	var parameters DecisionParameters
	if err := proof.Parameters(&parameters); err != nil {
		return DecisionResult{}, fmt.Errorf("ST-07 feedback parameters: %w", err)
	}
	if len(parameters.PolicyAcknowledgements) != 0 {
		return DecisionResult{}, fmt.Errorf("ST-07 feedback parameters cannot contain policy_acknowledgements")
	}
	items := parameters.FeedbackItems
	checks := parameters.HumanCheckResults
	reason := proof.Reason()
	at := proof.Receipt().ObservedAt
	if err := validateChecks(pending.Manifest, checks, false); err != nil {
		return DecisionResult{}, err
	}
	target, impact, err := selectRoute(pending.Manifest, items)
	if err != nil {
		return DecisionResult{}, err
	}
	if err := stageruntime.OneLine(reason, "ST-07 feedback reason"); err != nil {
		return DecisionResult{}, err
	}
	gateSet, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage07, pending.Manifest.EffectivePolicyRef, at)
	if err != nil {
		return DecisionResult{}, err
	}
	if checks == nil {
		checks = []HumanCheckResult{}
	}
	if items == nil {
		items = []FeedbackItem{}
	}
	decision := Decision{SchemaVersion: 1, Artifact: "human-decision", Version: 1, DecisionID: "feedback-" + pending.ManifestReference.SHA256[7:19], DecisionKind: "candidate-review", IntentID: current.Snapshot.State.IntentID, ReviewManifestRef: pending.ManifestReference, RunnableCandidateRef: pending.Manifest.RunnableCandidateRef, GateRequirementSetRef: gateSet.Reference, PolicyAcknowledgements: []gate.Acknowledgement{}, HumanInputReceiptRef: proof.ReceiptReference(), Decision: "request-changes", HumanCheckResults: checks, FeedbackItems: items, Reason: reason, DecidedBy: "human", DecidedAt: at}
	decisionRef, decisionBytes, err := stageruntime.WriteCanonical(current.ProjectDir, DecisionRevisionPath(current.Snapshot.RecordDir, decision.DecisionID), decision.Artifact, 1, decision, true)
	if err != nil {
		return DecisionResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, DecisionPath(current.Snapshot.RecordDir), decision.Artifact, decisionBytes); err != nil {
		return DecisionResult{}, err
	}
	invalidated := stageRange(target, contract.Stage07)
	feedback := FeedbackCurrent{SchemaVersion: 1, Artifact: "feedback-current", Version: 1, IntentID: current.Snapshot.State.IntentID, ReviewManifestRef: pending.ManifestReference, HumanDecisionRef: decisionRef, RejectedCandidateRef: pending.Manifest.RunnableCandidateRef, FeedbackItems: items, SelectedReason: impact, ReturnStage: target, InvalidatedStages: invalidated, Reason: reason, UpdatedAt: at}
	feedbackRef, feedbackBytes, err := stageruntime.WriteCanonical(current.ProjectDir, FeedbackRevisionPath(current.Snapshot.RecordDir, pending.Manifest.RunnableCandidateRef.SHA256), feedback.Artifact, 1, feedback, true)
	if err != nil {
		return DecisionResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, FeedbackPath(current.Snapshot.RecordDir), feedback.Artifact, feedbackBytes); err != nil {
		return DecisionResult{}, err
	}
	value := Current{SchemaVersion: 1, Artifact: "review-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: pending.Manifest.Disposition, Outcome: "feedback", ReviewManifestRef: &pending.ManifestReference, HumanDecisionRef: decisionRef, FeedbackCurrentRef: &feedbackRef, Reason: reason, UpdatedAt: at}
	valueRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), value.Artifact, 1, value, false)
	if err != nil {
		return DecisionResult{}, err
	}
	proposals := make([]contract.StageDispositionProposal, 0, len(invalidated))
	for _, stageID := range invalidated {
		proposals = append(proposals, contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: "feedback-" + decision.DecisionID + "-" + strings.ToLower(string(stageID)), StageID: stageID, Disposition: contract.Execute, Reason: "ST-07 " + impact + ": " + reason, Evidence: []contract.ArtifactReference{decisionRef, feedbackRef}, ProposedBy: contract.ProposerAI})
	}
	revised, err := workflowplan.Revise(current.Snapshot.Plan, proposals, workflowplan.RevisionOptions{ProjectDir: current.ProjectDir})
	if err != nil {
		return DecisionResult{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	returned, err := stageruntime.RouteFeedback(ctx, current, target, impact, "ST-07 feedback requires re-evaluation from "+string(target)+": "+impact+".", at)
	if err != nil {
		return DecisionResult{}, err
	}
	resolution, resolutionRef, err := humanapproval.Resolve(ctx, current.ProjectDir, current.Snapshot.RecordDir, proof, &decisionRef, "changes-requested", at)
	if err != nil {
		return DecisionResult{}, err
	}
	return DecisionResult{Decision: decision, DecisionReference: decisionRef, Feedback: &feedback, FeedbackReference: &feedbackRef, Current: value, CurrentReference: valueRef, HumanGateResolution: resolution, HumanGateResolutionRef: resolutionRef, State: returned}, nil
}

type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, "")
	if err != nil {
		return directive.Core{}, err
	}
	if prepared.Execution == "advanced" && prepared.CurrentReference != nil {
		from, to := contract.Stage07, contract.Stage08
		result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Advanced, CompletedStage: &from, Stage: &to, Reason: "ST-07 deterministically recorded not_applicable and advanced.", Evidence: []contract.ArtifactReference{*prepared.CurrentReference}, GraphVersion: prepared.State.GraphVersion, PlanRevision: prepared.State.PlanRevision, DecisionAuthority: "core"}
		return result, result.Validate()
	}
	if prepared.Pending == nil {
		return directive.Core{}, fmt.Errorf("ST-07 Human Review did not produce a Review Manifest")
	}
	stageID := contract.Stage07
	result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Approval, Stage: &stageID, Reason: "A human must approve the exact Review Manifest or request a classified revision.", Candidate: &prepared.Pending.ManifestReference, Review: &prepared.Pending.ReviewReference, Decisions: []string{"approve", "revise"}, FeedbackReasons: []string{"requirements_changed", "architecture_impact", "build_contract_impact", "candidate_defect"}, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
	return result, result.Validate()
}

func readPending(projectDir, recordDir string) (Pending, error) {
	manifest, currentManifestRef, _, err := stageruntime.ReadCanonical[Manifest](projectDir, ManifestPath(recordDir), "review-manifest", 1)
	if err != nil {
		return Pending{}, err
	}
	immutableManifest, manifestRef, _, err := stageruntime.ReadCanonical[Manifest](projectDir, ManifestRevisionPath(recordDir, manifest.RunnableCandidateRef.SHA256), "review-manifest", 1)
	if err != nil {
		return Pending{}, err
	}
	if currentManifestRef.SHA256 != manifestRef.SHA256 || !reflect.DeepEqual(manifest, immutableManifest) {
		return Pending{}, fmt.Errorf("ST-07 Human Review: mutable Manifest differs from immutable cycle")
	}
	htmlBytes, err := readRegular(ReviewPath(recordDir))
	if err != nil {
		return Pending{}, err
	}
	immutableHTML, err := readRegular(ReviewRevisionPath(recordDir, manifest.RunnableCandidateRef.SHA256))
	if err != nil {
		return Pending{}, err
	}
	if string(htmlBytes) != string(immutableHTML) {
		return Pending{}, fmt.Errorf("ST-07 Human Review: mutable HTML differs from immutable cycle")
	}
	reviewRef, err := stageruntime.Reference(projectDir, ReviewRevisionPath(recordDir, manifest.RunnableCandidateRef.SHA256), "review-html", 1, immutableHTML)
	if err != nil {
		return Pending{}, err
	}
	gateSet, err := gate.Resolve(projectDir, recordDir, contract.Stage07, manifest.EffectivePolicyRef, manifest.CreatedAt)
	if err != nil {
		return Pending{}, err
	}
	expectedHTML, err := renderHTML(manifest, gateSet.Set)
	if err != nil {
		return Pending{}, err
	}
	if string(htmlBytes) != expectedHTML {
		return Pending{}, fmt.Errorf("ST-07 Human Review: Review HTML differs from its Manifest")
	}
	return Pending{Manifest: immutableManifest, ManifestReference: manifestRef, ReviewReference: reviewRef}, nil
}
func validateChecks(manifest Manifest, values []HumanCheckResult, approval bool) error {
	expected := map[string]bool{}
	for _, check := range manifest.HumanChecks {
		expected[check.VerifierID] = true
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !expected[value.VerifierID] || seen[value.VerifierID] {
			return fmt.Errorf("ST-07 Human Review: unknown or duplicate human check %s", value.VerifierID)
		}
		if value.Result != "passed" && value.Result != "failed" {
			return fmt.Errorf("ST-07 Human Review: invalid human check result")
		}
		seen[value.VerifierID] = true
	}
	if approval {
		for id := range expected {
			if !seen[id] {
				return fmt.Errorf("ST-07 Human Review: approval requires human check %s", id)
			}
		}
		for _, value := range values {
			if value.Result != "passed" {
				return fmt.Errorf("ST-07 Human Review: approval requires every human check to pass")
			}
		}
	}
	return nil
}
func selectRoute(manifest Manifest, items []FeedbackItem) (contract.StageID, string, error) {
	if len(items) == 0 {
		return "", "", fmt.Errorf("ST-07 Human Review: at least one feedback item is required")
	}
	known := map[string]bool{}
	for _, item := range manifest.Requirements {
		known[item.RequirementID] = true
	}
	impactSet := map[string]bool{}
	ids := map[string]bool{}
	for _, item := range items {
		if item.FeedbackID == "" || item.Summary == "" || ids[item.FeedbackID] {
			return "", "", fmt.Errorf("ST-07 Human Review: invalid or duplicate feedback item")
		}
		ids[item.FeedbackID] = true
		for _, id := range item.RequirementIDs {
			if !known[id] {
				return "", "", fmt.Errorf("ST-07 Human Review: feedback references unknown requirement %s", id)
			}
		}
		for _, impact := range item.Impacts {
			impactSet[impact] = true
		}
	}
	routes := []struct {
		reason string
		stage  contract.StageID
	}{{"requirements_changed", contract.Stage03}, {"architecture_impact", contract.Stage04}, {"build_contract_impact", contract.Stage05}, {"candidate_defect", contract.Stage06}}
	for _, route := range routes {
		if impactSet[route.reason] {
			return route.stage, route.reason, nil
		}
	}
	return "", "", fmt.Errorf("ST-07 Human Review: feedback has no fixed route impact")
}
func selectRequirements(definition st03requirements.Definition, assessments []st05buildcontract.Assessment) []RequirementSummary {
	requested := map[string]bool{}
	for _, item := range assessments {
		requested[item.RequirementID] = true
	}
	result := []RequirementSummary{}
	all := append(append(append(append([]st03requirements.Item{}, definition.FunctionalRequirements...), definition.QualityRequirements...), definition.Constraints...), definition.Invariants...)
	for _, item := range all {
		if requested[item.ID] {
			result = append(result, RequirementSummary{RequirementID: item.ID, Statement: item.Statement})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].RequirementID < result[j].RequirementID })
	return result
}
func promoteSystemMap(projectDir string, reference contract.ArtifactReference, results []st06build.SourceResult, at string) (contract.ArtifactReference, error) {
	path, err := stageruntime.ReadReference(projectDir, reference)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	value, actual, _, err := stageruntime.ReadCanonical[st01orient.SystemMap](projectDir, path, "system-map", 1)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	if actual != reference {
		return contract.ArtifactReference{}, fmt.Errorf("ST-07 Human Review: System Map reference differs")
	}
	revisions := map[string]string{}
	for _, result := range results {
		for _, id := range result.SourceIDs {
			revisions[id] = result.CandidateRevision
		}
	}
	for index := range value.SourceSnapshots {
		if revision, ok := revisions[value.SourceSnapshots[index].SourceID]; ok {
			value.SourceSnapshots[index].Revision = revision
			value.SourceSnapshots[index].Dirty = false
			value.SourceSnapshots[index].ObservedAt = at
			delete(revisions, value.SourceSnapshots[index].SourceID)
		}
	}
	if len(revisions) != 0 {
		return contract.ArtifactReference{}, fmt.Errorf("ST-07 Human Review: Candidate references unknown System Map source")
	}
	base := value.Revision
	value.Revision++
	value.BaseRevision = &base
	value.BaselineKind = "accepted-code"
	value.CreatedAt = at
	spaceName := workspace.ActiveSpace(projectDir)
	promoted, _, err := stageruntime.WriteCanonical(projectDir, st01orient.RevisionPath(projectDir, spaceName, value.Revision), "system-map", 1, value, true)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	baseline := st01orient.Baseline{SchemaVersion: 1, Artifact: "system-map-baseline", Version: 1, MapID: value.MapID, Revision: value.Revision, SourceOfTruth: promoted.SourceOfTruth, SHA256: promoted.SHA256}
	_, _, err = stageruntime.WriteCanonical(projectDir, st01orient.BaselinePath(projectDir, spaceName), "system-map-baseline", 1, baseline, false)
	return promoted, err
}
func verifyCandidateGit(ctx context.Context, projectDir string, candidate st06build.RunnableCandidate, build st05buildcontract.BuildContract) error {
	locators := map[string]string{}
	for _, source := range build.TargetSources {
		locators[source.SourceID] = source.Locator
	}
	for _, result := range candidate.SourceResults {
		roots := map[string]bool{}
		for _, sourceID := range result.SourceIDs {
			locator, ok := locators[sourceID]
			if !ok {
				return fmt.Errorf("ST-07 Human Review: Candidate references unknown source %s", sourceID)
			}
			root := projectDir
			if locator != "." {
				root = filepath.Join(projectDir, filepath.FromSlash(locator))
			}
			resolved, err := reviewGit(ctx, root, "rev-parse", "--show-toplevel")
			if err != nil {
				return err
			}
			roots[resolved] = true
		}
		if len(roots) != 1 {
			return fmt.Errorf("ST-07 Human Review: Candidate Repository binding differs for %s", result.RepositoryID)
		}
		var root string
		for item := range roots {
			root = item
		}
		if _, err := reviewGit(ctx, root, "cat-file", "-e", result.CandidateRevision+"^{commit}"); err != nil {
			return fmt.Errorf("ST-07 Human Review: Candidate revision is unavailable: %s", result.CandidateRevision)
		}
		changed, err := reviewGit(ctx, root, "diff", "--name-only", result.BaseRevision+".."+result.CandidateRevision)
		if err != nil {
			return err
		}
		actual := []string{}
		for _, line := range strings.Split(changed, "\n") {
			if strings.TrimSpace(line) != "" {
				actual = append(actual, filepath.ToSlash(strings.TrimSpace(line)))
			}
		}
		sort.Strings(actual)
		expected := append([]string{}, result.ChangedFiles...)
		sort.Strings(expected)
		if strings.Join(actual, "\x00") != strings.Join(expected, "\x00") {
			return fmt.Errorf("ST-07 Human Review: Candidate changed files differ for %s", result.RepositoryID)
		}
	}
	return nil
}
func reviewGit(ctx context.Context, dir string, args ...string) (string, error) {
	result, err := process.Run(ctx, process.Request{Executable: "git", Args: args, Dir: dir, Env: os.Environ(), ExitCodes: []int{0}})
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(result.Stderr)))
	}
	return strings.TrimSpace(string(result.Stdout)), nil
}
func renderHTML(manifest Manifest, requirements gate.RequirementSet) (string, error) {
	humanSection := explanationhtml.Section{
		Heading: "人が実物を見て確認すること",
		Lead:    "自動テストだけでは判断できない見た目や操作を確認します。",
	}
	for _, check := range manifest.HumanChecks {
		humanSection.Cards = append(humanSection.Cards, explanationhtml.Card{
			Label:   check.VerifierID,
			Heading: "人の確認",
			Text:    check.Expected,
			Tone:    "warning",
		})
	}

	requirementSection := explanationhtml.Section{
		Heading: "満たす必要がある要件",
		Lead:    "完成候補が満たすべき条件です。IDは正本との対応を確認するために残します。",
	}
	for _, requirement := range manifest.Requirements {
		requirementSection.Cards = append(requirementSection.Cards, explanationhtml.Card{
			Label:   requirement.RequirementID,
			Heading: "要件",
			Text:    requirement.Statement,
		})
	}

	acceptanceSection := explanationhtml.Section{
		Heading: "完成と判断する条件",
		Lead:    "Build Contractで承認された受入条件です。",
	}
	for _, criterion := range manifest.AcceptanceCriteria {
		acceptanceSection.Cards = append(acceptanceSection.Cards, explanationhtml.Card{
			Label:   criterion.CriterionID,
			Heading: "受入条件",
			Facts: []explanationhtml.Fact{
				{Label: "前提", Value: criterion.Given},
				{Label: "操作", Value: criterion.When},
				{Label: "期待結果", Value: criterion.Then},
				{Label: "検証方法", Value: strings.Join(criterion.VerifierIDs, ", "), Code: true},
			},
		})
	}

	sections := []explanationhtml.Section{
		{
			Heading: "このページで決めること",
			Lead:    "完成した候補を、次のRelease計画へ進めてよいかを判断します。",
			Ordered: true,
			Items: []explanationhtml.Item{
				{Text: "最初に完成したもの自体を確認する。"},
				{Text: "人の確認項目と要件を満たしているか確認する。"},
				{Text: "問題がなければ承認し、問題があれば修正を依頼する。"},
			},
		},
	}
	if len(humanSection.Cards) > 0 {
		sections = append(sections, humanSection)
	}
	if len(requirementSection.Cards) > 0 {
		sections = append(sections, requirementSection)
	}
	if len(acceptanceSection.Cards) > 0 {
		sections = append(sections, acceptanceSection)
	}
	if len(manifest.KnownConstraints) > 0 {
		constraintSection := explanationhtml.Section{Heading: "既知の制約", Lead: "承認前に把握しておく制約です。"}
		for _, constraint := range manifest.KnownConstraints {
			constraintSection.Items = append(constraintSection.Items, explanationhtml.Item{Text: constraint})
		}
		sections = append(sections, constraintSection)
	}
	sections = append(sections, gate.ReviewSection(requirements))

	return explanationhtml.Render(explanationhtml.Page{
		Title:   "ST-07 Candidate Review",
		Eyebrow: "AI-DLC / ST-07",
		Heading: "完成したものを確認",
		Lead:    "このページは、実装と自動テストが終わった候補を、人が実際に確認するためのページです。",
		Notice:  "要件IDだけを読むのではなく、最初に完成物そのものを開いてください。承認はReleaseの実行ではなく、Release計画へ進める許可です。",
		Metrics: []explanationhtml.Metric{
			{Label: "要件", Value: fmt.Sprint(len(manifest.Requirements)) + "件", Help: "候補が満たす条件"},
			{Label: "人の確認", Value: fmt.Sprint(len(manifest.HumanChecks)) + "件", Help: "実物で確認する項目"},
			{Label: "機械Evidence", Value: fmt.Sprint(len(manifest.MachineEvidenceRefs)) + "件", Help: "自動確認の記録"},
			{Label: "追加Policy", Value: fmt.Sprint(len(requirements.Requirements)) + "件", Help: "PolicyとRiskからの確認"},
		},
		Sections: sections,
		Footer: []explanationhtml.Fact{
			{Label: "Intent", Value: manifest.IntentID, Code: true},
			{Label: "Runnable Candidate SHA-256", Value: manifest.RunnableCandidateRef.SHA256, Code: true},
			{Label: "Build Contract SHA-256", Value: manifest.BuildContractRef.SHA256, Code: true},
		},
	})
}
func writeRaw(projectDir, path, artifact string, content []byte) (contract.ArtifactReference, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return contract.ArtifactReference{}, err
	}
	if err := fsx.AtomicWriteFile(path, content, 0o644); err != nil {
		return contract.ArtifactReference{}, err
	}
	return stageruntime.Reference(projectDir, path, artifact, 1, content)
}
func writeRawImmutable(projectDir, path, artifact string, content []byte) (contract.ArtifactReference, error) {
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return contract.ArtifactReference{}, fmt.Errorf("immutable Artifact must be a regular non-symlink file: %s", path)
		}
		existing, err := os.ReadFile(path)
		if err != nil {
			return contract.ArtifactReference{}, err
		}
		if string(existing) != string(content) {
			return contract.ArtifactReference{}, fmt.Errorf("immutable Artifact differs: %s", path)
		}
		return stageruntime.Reference(projectDir, path, artifact, 1, existing)
	}
	if !os.IsNotExist(err) {
		return contract.ArtifactReference{}, err
	}
	return writeRaw(projectDir, path, artifact, content)
}
func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("Artifact must be a regular non-symlink file: %s", path)
	}
	return os.ReadFile(path)
}
func fileExists(path string) bool { _, err := os.Lstat(path); return err == nil }
func stageRange(from, through contract.StageID) []contract.StageID {
	result := []contract.StageID{}
	active := false
	for _, id := range contract.OrderedStageIDs {
		if id == from {
			active = true
		}
		if active {
			result = append(result, id)
		}
		if id == through {
			break
		}
	}
	return result
}
func revise(current stageruntime.Context, disposition contract.Disposition, id, reason string, evidence []contract.ArtifactReference, deterministic bool) (contract.StageExecutionPlan, error) {
	proposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: id, StageID: contract.Stage07, Disposition: disposition, Reason: reason, Evidence: evidence, ProposedBy: contract.ProposerCore}
	return workflowplan.Revise(current.Snapshot.Plan, []contract.StageDispositionProposal{proposal}, workflowplan.RevisionOptions{ProjectDir: current.ProjectDir, StageContracts: []contract.StageContract{current.Contract}, DeterministicApplicability: func(value contract.StageDispositionProposal, _ contract.StageContract) bool {
		return deterministic && value.Disposition == contract.NotApplicable
	}})
}
