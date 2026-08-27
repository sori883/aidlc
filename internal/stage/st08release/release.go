// Package st08release implements the human-authorized Release boundary.
package st08release

import (
	"context"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/process"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st05buildcontract"
	"github.com/sori883/aidlc/internal/stage/st07review"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/gate"
	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

const GitCapabilityID = "git-source-promote-v1"
const GitAdapterID = "core-git-source-promote-v1"

var remoteName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
var branchRef = regexp.MustCompile(`^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$`)

type Capability struct {
	CapabilityID     string   `json:"capability_id"`
	Provider         string   `json:"provider"`
	Operation        string   `json:"operation"`
	TargetKind       string   `json:"target_kind"`
	AdapterID        string   `json:"adapter_id"`
	CredentialSlots  []string `json:"credential_slots"`
	SupportsRollback bool     `json:"supports_rollback"`
}
type CapabilitySnapshot struct {
	SchemaVersion      int                        `json:"schema_version"`
	Artifact           string                     `json:"artifact"`
	Version            int                        `json:"version"`
	IntentID           string                     `json:"intent_id"`
	EffectivePolicyRef contract.ArtifactReference `json:"effective_policy_ref"`
	Capabilities       []Capability               `json:"capabilities"`
	CreatedAt          string                     `json:"created_at"`
}
type SourceTarget struct {
	RepositoryID      string   `json:"repository_id"`
	SourceIDs         []string `json:"source_ids"`
	SourceLocators    []string `json:"source_locators"`
	RepositoryRoot    string   `json:"repository_root"`
	BaseRevision      string   `json:"base_revision"`
	CandidateRevision string   `json:"candidate_revision"`
	IntegrationBranch string   `json:"integration_branch"`
	CurrentBranchRef  string   `json:"current_branch_ref"`
	AvailableRemotes  []string `json:"available_remotes"`
}
type WorkRequest struct {
	SchemaVersion            int                         `json:"schema_version"`
	Artifact                 string                      `json:"artifact"`
	Version                  int                         `json:"version"`
	IntentID                 string                      `json:"intent_id"`
	StageID                  contract.StageID            `json:"stage_id"`
	ReviewCurrentRef         contract.ArtifactReference  `json:"review_current_ref"`
	AcceptedCandidateRef     contract.ArtifactReference  `json:"accepted_candidate_ref"`
	EffectivePolicyRef       contract.ArtifactReference  `json:"effective_policy_ref"`
	SystemMapRef             contract.ArtifactReference  `json:"system_map_ref"`
	CapabilitySnapshotRef    contract.ArtifactReference  `json:"capability_snapshot_ref"`
	DeploymentMapBaselineRef *contract.ArtifactReference `json:"deployment_map_baseline_ref"`
	SourceTargets            []SourceTarget              `json:"source_targets"`
	RequestedOutput          string                      `json:"requested_output"`
	Rules                    []string                    `json:"rules"`
	CreatedAt                string                      `json:"created_at"`
}
type ProposedTarget struct {
	TargetID     string  `json:"target_id"`
	TargetKind   string  `json:"target_kind"`
	Provider     string  `json:"provider"`
	CapabilityID string  `json:"capability_id"`
	RepositoryID *string `json:"repository_id"`
	Locator      string  `json:"locator"`
	Environment  *string `json:"environment"`
}
type Target struct {
	ProposedTarget
	ObservedBefore string `json:"observed_before"`
	ObservedAt     string `json:"observed_at"`
}
type Step struct {
	StepID           string   `json:"step_id"`
	TargetID         string   `json:"target_id"`
	Operation        string   `json:"operation"`
	CapabilityID     string   `json:"capability_id"`
	DependsOn        []string `json:"depends_on"`
	DesiredState     string   `json:"desired_state"`
	PostReleaseCheck string   `json:"post_release_check"`
	RollbackMode     string   `json:"rollback_mode"`
}
type Proposal struct {
	SchemaVersion     int                  `json:"schema_version"`
	Artifact          string               `json:"artifact"`
	Version           int                  `json:"version"`
	ProposalID        string               `json:"proposal_id"`
	IntentID          string               `json:"intent_id"`
	WorkRequestSHA256 string               `json:"work_request_sha256"`
	Disposition       contract.Disposition `json:"disposition"`
	Targets           []ProposedTarget     `json:"targets"`
	Steps             []Step               `json:"steps"`
	ReleaseNotes      []string             `json:"release_notes"`
	Reason            string               `json:"reason"`
	ProposedBy        string               `json:"proposed_by"`
}
type Plan struct {
	SchemaVersion         int                        `json:"schema_version"`
	Artifact              string                     `json:"artifact"`
	Version               int                        `json:"version"`
	Revision              int                        `json:"revision"`
	IntentID              string                     `json:"intent_id"`
	StageID               contract.StageID           `json:"stage_id"`
	Disposition           contract.Disposition       `json:"disposition"`
	WorkRequestRef        contract.ArtifactReference `json:"work_request_ref"`
	ReviewCurrentRef      contract.ArtifactReference `json:"review_current_ref"`
	AcceptedCandidateRef  contract.ArtifactReference `json:"accepted_candidate_ref"`
	EffectivePolicyRef    contract.ArtifactReference `json:"effective_policy_ref"`
	CapabilitySnapshotRef contract.ArtifactReference `json:"capability_snapshot_ref"`
	Targets               []Target                   `json:"targets"`
	Steps                 []Step                     `json:"steps"`
	ReleaseNotes          []string                   `json:"release_notes"`
	Reason                string                     `json:"reason"`
	CreatedAt             string                     `json:"created_at"`
}
type Authority struct {
	SchemaVersion          int                        `json:"schema_version"`
	Artifact               string                     `json:"artifact"`
	Version                int                        `json:"version"`
	AuthorityID            string                     `json:"authority_id"`
	IntentID               string                     `json:"intent_id"`
	ReleasePlanRef         contract.ArtifactReference `json:"release_plan_ref"`
	AcceptedCandidateRef   contract.ArtifactReference `json:"accepted_candidate_ref"`
	GateRequirementSetRef  contract.ArtifactReference `json:"gate_requirement_set_ref"`
	PolicyAcknowledgements []gate.Acknowledgement     `json:"policy_acknowledgements"`
	HumanInputReceiptRef   contract.ArtifactReference `json:"human_input_receipt_ref"`
	Decision               string                     `json:"decision"`
	Reason                 string                     `json:"reason"`
	DecidedBy              string                     `json:"decided_by"`
	DecidedAt              string                     `json:"decided_at"`
}
type StepReceipt struct {
	SchemaVersion       int     `json:"schema_version"`
	Artifact            string  `json:"artifact"`
	Version             int     `json:"version"`
	IntentID            string  `json:"intent_id"`
	Attempt             int     `json:"attempt"`
	StepID              string  `json:"step_id"`
	TargetID            string  `json:"target_id"`
	CapabilityID        string  `json:"capability_id"`
	IdempotencyKey      string  `json:"idempotency_key"`
	Outcome             string  `json:"outcome"`
	BeforeState         string  `json:"before_state"`
	AfterState          string  `json:"after_state"`
	ExternalOperationID *string `json:"external_operation_id"`
	Detail              string  `json:"detail"`
	ExecutedAt          string  `json:"executed_at"`
}
type Attempt struct {
	SchemaVersion   int                          `json:"schema_version"`
	Artifact        string                       `json:"artifact"`
	Version         int                          `json:"version"`
	IntentID        string                       `json:"intent_id"`
	Attempt         int                          `json:"attempt"`
	Status          string                       `json:"status"`
	ReleasePlanRef  contract.ArtifactReference   `json:"release_plan_ref"`
	AuthorityRef    contract.ArtifactReference   `json:"authority_ref"`
	StepReceiptRefs []contract.ArtifactReference `json:"step_receipt_refs"`
	Failure         *string                      `json:"failure"`
	StartedAt       string                       `json:"started_at"`
	UpdatedAt       string                       `json:"updated_at"`
}
type TargetState struct {
	TargetID      string `json:"target_id"`
	ObservedState string `json:"observed_state"`
}
type Receipt struct {
	SchemaVersion        int                          `json:"schema_version"`
	Artifact             string                       `json:"artifact"`
	Version              int                          `json:"version"`
	IntentID             string                       `json:"intent_id"`
	Attempt              int                          `json:"attempt"`
	Outcome              string                       `json:"outcome"`
	ReleasePlanRef       contract.ArtifactReference   `json:"release_plan_ref"`
	AuthorityRef         contract.ArtifactReference   `json:"authority_ref"`
	AcceptedCandidateRef contract.ArtifactReference   `json:"accepted_candidate_ref"`
	StepReceiptRefs      []contract.ArtifactReference `json:"step_receipt_refs"`
	TargetStates         []TargetState                `json:"target_states"`
	CompletedAt          string                       `json:"completed_at"`
}
type DeploymentTarget struct {
	TargetID          string                     `json:"target_id"`
	TargetKind        string                     `json:"target_kind"`
	Provider          string                     `json:"provider"`
	Locator           string                     `json:"locator"`
	Environment       *string                    `json:"environment"`
	ObservedState     string                     `json:"observed_state"`
	ObservedAt        string                     `json:"observed_at"`
	ReleaseReceiptRef contract.ArtifactReference `json:"release_receipt_ref"`
}
type DeploymentMap struct {
	SchemaVersion int                `json:"schema_version"`
	Artifact      string             `json:"artifact"`
	Version       int                `json:"version"`
	MapID         string             `json:"map_id"`
	Revision      int                `json:"revision"`
	BaseRevision  *int               `json:"base_revision"`
	Targets       []DeploymentTarget `json:"targets"`
	UpdatedAt     string             `json:"updated_at"`
}
type DeploymentBaseline struct {
	SchemaVersion int    `json:"schema_version"`
	Artifact      string `json:"artifact"`
	Version       int    `json:"version"`
	MapID         string `json:"map_id"`
	Revision      int    `json:"revision"`
	SourceOfTruth string `json:"source_of_truth"`
	SHA256        string `json:"sha256"`
	UpdatedAt     string `json:"updated_at"`
}
type Current struct {
	SchemaVersion        int                         `json:"schema_version"`
	Artifact             string                      `json:"artifact"`
	Version              int                         `json:"version"`
	IntentID             string                      `json:"intent_id"`
	Disposition          contract.Disposition        `json:"disposition"`
	Outcome              string                      `json:"outcome"`
	ReviewCurrentRef     contract.ArtifactReference  `json:"review_current_ref"`
	AcceptedCandidateRef *contract.ArtifactReference `json:"accepted_candidate_ref"`
	ReleasePlanRef       *contract.ArtifactReference `json:"release_plan_ref"`
	ReleaseAuthorityRef  *contract.ArtifactReference `json:"release_authority_ref"`
	ReleaseReceiptRef    *contract.ArtifactReference `json:"release_receipt_ref"`
	DeploymentMapRef     *contract.ArtifactReference `json:"deployment_map_ref"`
	Reason               string                      `json:"reason"`
	UpdatedAt            string                      `json:"updated_at"`
}
type PrepareResult struct {
	Execution        string                      `json:"execution"`
	Request          *WorkRequest                `json:"request"`
	Reference        *contract.ArtifactReference `json:"reference"`
	Current          *Current                    `json:"current"`
	CurrentReference *contract.ArtifactReference `json:"currentReference"`
	State            state.IntentState           `json:"state"`
}
type ReviewResult struct {
	Plan            Plan                       `json:"plan"`
	PlanReference   contract.ArtifactReference `json:"planReference"`
	ReviewReference contract.ArtifactReference `json:"reviewReference"`
	Gate            gate.RequirementSet        `json:"gate"`
	GateReference   contract.ArtifactReference `json:"gateReference"`
	HumanGate       humanapproval.OpenResult   `json:"humanGate"`
	State           state.IntentState          `json:"state"`
}
type AuthorizeResult struct {
	Authority              Authority                  `json:"authority"`
	AuthorityReference     contract.ArtifactReference `json:"authorityReference"`
	Attempt                Attempt                    `json:"attempt"`
	HumanGateResolution    humanapproval.Resolution   `json:"humanGateResolution"`
	HumanGateResolutionRef contract.ArtifactReference `json:"humanGateResolutionReference"`
	State                  state.IntentState          `json:"state"`
}
type ExecuteResult struct {
	Outcome          string                      `json:"outcome"`
	Receipt          *Receipt                    `json:"receipt"`
	ReceiptReference *contract.ArtifactReference `json:"receiptReference"`
	Current          *Current                    `json:"current"`
	CurrentReference *contract.ArtifactReference `json:"currentReference"`
	State            state.IntentState           `json:"state"`
}
type ReuseResult struct {
	Current                       Current                    `json:"current"`
	CurrentReference              contract.ArtifactReference `json:"currentReference"`
	ReusedReleaseCurrentReference contract.ArtifactReference `json:"reusedReleaseCurrentReference"`
	State                         state.IntentState          `json:"state"`
}

func RootDir(recordDir string) string { return filepath.Join(recordDir, "artifacts", "release") }
func CapabilityPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "release-capability-snapshot.json")
}
func WorkRequestPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "work-request.json")
}
func PlanPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "release-plan.json") }
func PlanRevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "release-plan.json")
}
func ReviewPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "review", "release.html")
}
func ReviewRevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "release.html")
}
func AuthorityPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "review", "release-authority.json")
}
func AuthorityRevisionPath(recordDir, authorityID string) string {
	return filepath.Join(RootDir(recordDir), "decisions", authorityID, "release-authority.json")
}
func AttemptPath(recordDir string, attempt int) string {
	return filepath.Join(RootDir(recordDir), "attempts", fmt.Sprintf("%06d", attempt), "attempt.json")
}
func StepReceiptPath(recordDir string, attempt int, stepID string, rollback bool) string {
	suffix := ""
	if rollback {
		suffix = "-rollback"
	}
	return filepath.Join(RootDir(recordDir), "attempts", fmt.Sprintf("%06d", attempt), "steps", stepID+suffix+".json")
}
func ReceiptPath(recordDir string, attempt int) string {
	return filepath.Join(RootDir(recordDir), "attempts", fmt.Sprintf("%06d", attempt), "release-receipt.json")
}
func CurrentPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "current.json") }
func deploymentRoot(projectDir string) string {
	return filepath.Join(workspace.Root(projectDir), "spaces", workspace.ActiveSpace(projectDir), "codekb", "deployment-map")
}
func deploymentBaselinePath(projectDir string) string {
	return filepath.Join(deploymentRoot(projectDir), "baseline.json")
}
func deploymentRevisionPath(projectDir string, revision int) string {
	return filepath.Join(deploymentRoot(projectDir), "revisions", fmt.Sprintf("%06d", revision), "deployment-map.json")
}

func Prepare(ctx context.Context, projectDir, coreDir, at string) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage08)
	if err != nil {
		return PrepareResult{}, err
	}
	reviewCurrent, reviewRef, _, err := stageruntime.ReadCanonical[st07review.Current](current.ProjectDir, st07review.CurrentPath(current.Snapshot.RecordDir), "review-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if at == "" {
		at = stageruntime.Now()
	}
	if reviewCurrent.Outcome == "not_applicable" || reviewCurrent.AcceptedCandidateRef == nil {
		value := Current{SchemaVersion: 1, Artifact: "release-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: contract.NotApplicable, Outcome: "not_applicable", ReviewCurrentRef: reviewRef, Reason: "ST-07 produced no Accepted Candidate, so Release has no permitted external target.", UpdatedAt: at}
		ref, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), value.Artifact, 1, value, false)
		if err != nil {
			return PrepareResult{}, err
		}
		revised, err := revise(current, contract.NotApplicable, "st08-no-candidate", value.Reason, []contract.ArtifactReference{reviewRef, ref}, true)
		if err != nil {
			return PrepareResult{}, err
		}
		current.Snapshot.Plan = revised
		current.Snapshot.State.PlanRevision = revised.Revision
		advanced, err := stageruntime.Advance(ctx, current, ref, "release-schema-validator", "ST-09 Outcome Evaluation is ready for Core preparation.", at)
		return PrepareResult{Execution: "advanced", Current: &value, CurrentReference: &ref, State: advanced}, err
	}
	acceptedPath, err := stageruntime.ReadReference(current.ProjectDir, *reviewCurrent.AcceptedCandidateRef)
	if err != nil {
		return PrepareResult{}, err
	}
	accepted, acceptedRef, _, err := stageruntime.ReadCanonical[st07review.AcceptedCandidate](current.ProjectDir, acceptedPath, "accepted-candidate", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if acceptedRef != *reviewCurrent.AcceptedCandidateRef {
		return PrepareResult{}, fmt.Errorf("ST-08 Release: Accepted Candidate binding differs")
	}
	snapshot := CapabilitySnapshot{SchemaVersion: 1, Artifact: "release-capability-snapshot", Version: 1, IntentID: current.Snapshot.State.IntentID, EffectivePolicyRef: current.Snapshot.State.PolicySnapshot, Capabilities: []Capability{{CapabilityID: GitCapabilityID, Provider: "git", Operation: "source-promote", TargetKind: "source", AdapterID: GitAdapterID, CredentialSlots: []string{}, SupportsRollback: true}}, CreatedAt: at}
	storedSnapshot, snapshotRef, _, snapshotExists, err := stageruntime.ReadCanonicalIfExists[CapabilitySnapshot](current.ProjectDir, CapabilityPath(current.Snapshot.RecordDir), snapshot.Artifact, 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if snapshotExists {
		expected := snapshot
		expected.CreatedAt = storedSnapshot.CreatedAt
		if !reflect.DeepEqual(storedSnapshot, expected) {
			return PrepareResult{}, fmt.Errorf("ST-08 Release: existing Capability Snapshot is stale")
		}
		snapshot = storedSnapshot
	} else {
		snapshotRef, _, err = stageruntime.WriteCanonical(current.ProjectDir, CapabilityPath(current.Snapshot.RecordDir), snapshot.Artifact, 1, snapshot, true)
		if err != nil {
			return PrepareResult{}, err
		}
	}
	targets, err := sourceTargets(ctx, current.ProjectDir, accepted)
	if err != nil {
		return PrepareResult{}, err
	}
	baselineRef, err := readDeploymentBaselineRef(current.ProjectDir)
	if err != nil {
		return PrepareResult{}, err
	}
	request := WorkRequest{SchemaVersion: 1, Artifact: "release-work-request", Version: 1, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage08, ReviewCurrentRef: reviewRef, AcceptedCandidateRef: acceptedRef, EffectivePolicyRef: current.Snapshot.State.PolicySnapshot, SystemMapRef: accepted.SystemMapRef, CapabilitySnapshotRef: snapshotRef, DeploymentMapBaselineRef: baselineRef, SourceTargets: targets, RequestedOutput: "release-plan-proposal", Rules: []string{"Use only a capability_id from the pinned Capability Snapshot.", "Do not provide shell commands, credential values, or an alternative Stage route.", "Every Accepted Candidate Repository must have exactly one Source promotion target and step.", "Core re-observes every Target before approval and execution."}, CreatedAt: at}
	storedRequest, storedRef, _, requestExists, err := stageruntime.ReadCanonicalIfExists[WorkRequest](current.ProjectDir, WorkRequestPath(current.Snapshot.RecordDir), request.Artifact, 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if requestExists {
		expected := request
		expected.CreatedAt = storedRequest.CreatedAt
		if !reflect.DeepEqual(storedRequest, expected) {
			return PrepareResult{}, fmt.Errorf("ST-08 Release: existing Work Request is stale")
		}
		return PrepareResult{Execution: "reused", Request: &storedRequest, Reference: &storedRef, State: current.Snapshot.State}, nil
	}
	ref, _, err := stageruntime.WriteCanonical(current.ProjectDir, WorkRequestPath(current.Snapshot.RecordDir), request.Artifact, 1, request, false)
	if err != nil {
		return PrepareResult{}, err
	}
	ready, err := stageruntime.SetReady(ctx, current, at)
	return PrepareResult{Execution: "prepared", Request: &request, Reference: &ref, State: ready}, err
}

func Review(ctx context.Context, projectDir, coreDir string, proposalBytes []byte, at string) (ReviewResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage08)
	if err != nil {
		return ReviewResult{}, err
	}
	request, requestRef, _, err := stageruntime.ReadCanonical[WorkRequest](current.ProjectDir, WorkRequestPath(current.Snapshot.RecordDir), "release-work-request", 1)
	if err != nil {
		return ReviewResult{}, err
	}
	proposal, err := stageruntime.DecodeProposal[Proposal](proposalBytes, validateProposal)
	if err != nil {
		return ReviewResult{}, err
	}
	if proposal.IntentID != current.Snapshot.State.IntentID || proposal.WorkRequestSHA256 != requestRef.SHA256 {
		return ReviewResult{}, fmt.Errorf("ST-08 Release: Proposal does not match Work Request")
	}
	if at == "" {
		at = stageruntime.Now()
	}
	targets, err := pinTargets(ctx, current.ProjectDir, request, proposal.Targets, at)
	if err != nil {
		return ReviewResult{}, err
	}
	if err := validateSteps(request, targets, proposal.Steps); err != nil {
		return ReviewResult{}, err
	}
	revision := 1
	old, _, _, planExists, err := stageruntime.ReadCanonicalIfExists[Plan](current.ProjectDir, PlanPath(current.Snapshot.RecordDir), "release-plan", 1)
	if err != nil {
		return ReviewResult{}, err
	}
	if planExists {
		revision = old.Revision + 1
	}
	value := Plan{SchemaVersion: 1, Artifact: "release-plan", Version: 1, Revision: revision, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage08, Disposition: contract.Execute, WorkRequestRef: requestRef, ReviewCurrentRef: request.ReviewCurrentRef, AcceptedCandidateRef: request.AcceptedCandidateRef, EffectivePolicyRef: request.EffectivePolicyRef, CapabilitySnapshotRef: request.CapabilitySnapshotRef, Targets: targets, Steps: proposal.Steps, ReleaseNotes: proposal.ReleaseNotes, Reason: proposal.Reason, CreatedAt: at}
	ref, content, err := stageruntime.WriteCanonical(current.ProjectDir, PlanRevisionPath(current.Snapshot.RecordDir, revision), value.Artifact, 1, value, true)
	if err != nil {
		return ReviewResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, PlanPath(current.Snapshot.RecordDir), value.Artifact, content); err != nil {
		return ReviewResult{}, err
	}
	gateSet, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage08, request.EffectivePolicyRef, at)
	if err != nil {
		return ReviewResult{}, err
	}
	htmlBytes := []byte(renderHTML(value, gateSet.Set))
	reviewRef, err := writeRawImmutable(current.ProjectDir, ReviewRevisionPath(current.Snapshot.RecordDir, revision), "release-html", htmlBytes)
	if err != nil {
		return ReviewResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, ReviewPath(current.Snapshot.RecordDir), "release-html", htmlBytes); err != nil {
		return ReviewResult{}, err
	}
	stageProposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: proposal.ProposalID, StageID: contract.Stage08, Disposition: contract.Execute, Reason: proposal.Reason, Evidence: []contract.ArtifactReference{requestRef, ref, reviewRef}, ProposedBy: contract.ProposerAI}
	revised, err := workflowplan.Revise(current.Snapshot.Plan, []contract.StageDispositionProposal{stageProposal}, workflowplan.RevisionOptions{ProjectDir: current.ProjectDir, StageContracts: []contract.StageContract{current.Contract}})
	if err != nil {
		return ReviewResult{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	humanGate, err := humanapproval.Open(ctx, current.ProjectDir, current.Snapshot.RecordDir, humanapproval.OpenOptions{
		IntentID: current.Snapshot.State.IntentID, Scope: string(contract.Stage08),
		SubjectRef: ref, ReviewRef: reviewRef, GateRequirementRef: &gateSet.Reference,
		GraphVersion: current.Snapshot.State.GraphVersion, PlanRevision: current.Snapshot.State.PlanRevision,
		AllowedActions: []string{"authorize-release", "request-revision"}, OpenedAt: at,
	})
	if err != nil {
		return ReviewResult{}, err
	}
	parked, err := stageruntime.Park(ctx, current, "ST-08 is awaiting human authority for the exact Release Plan SHA-256.", at)
	if err != nil {
		return ReviewResult{}, err
	}
	_, _ = audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.StageAwaitingApproval, []audit.Field{{Name: "Stage", Value: "ST-08"}, {Name: "Release Plan SHA-256", Value: ref.SHA256}, {Name: "Review", Value: reviewRef.SourceOfTruth}, {Name: "Decision Authority", Value: "human"}}, nil)
	return ReviewResult{Plan: value, PlanReference: ref, ReviewReference: reviewRef, Gate: gateSet.Set, GateReference: gateSet.Reference, HumanGate: humanGate, State: parked}, nil
}

type AuthorizationParameters struct {
	PolicyAcknowledgements []gate.Acknowledgement `json:"policy_acknowledgements"`
}

func Authorize(ctx context.Context, projectDir, coreDir string, proof humanapproval.Proof) (AuthorizeResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage08)
	if err != nil {
		return AuthorizeResult{}, err
	}
	value, ref, err := readCurrentPlan(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return AuthorizeResult{}, err
	}
	if err := proof.Require(string(contract.Stage08), "authorize-release", ref.SHA256); err != nil {
		return AuthorizeResult{}, fmt.Errorf("ST-08 Release: %w", err)
	}
	var parameters AuthorizationParameters
	if err := proof.Parameters(&parameters); err != nil {
		return AuthorizeResult{}, fmt.Errorf("ST-08 Release authorization parameters: %w", err)
	}
	acknowledgements := parameters.PolicyAcknowledgements
	reason := proof.Reason()
	at := proof.Receipt().ObservedAt
	requestPath, err := stageruntime.ReadReference(current.ProjectDir, value.WorkRequestRef)
	if err != nil {
		return AuthorizeResult{}, err
	}
	request, _, _, err := stageruntime.ReadCanonical[WorkRequest](current.ProjectDir, requestPath, "release-work-request", 1)
	if err != nil {
		return AuthorizeResult{}, err
	}
	activeBaselineRef, err := readDeploymentBaselineRef(current.ProjectDir)
	if err != nil {
		return AuthorizeResult{}, err
	}
	if !equalOptionalRefs(request.DeploymentMapBaselineRef, activeBaselineRef) {
		return AuthorizeResult{}, fmt.Errorf("ST-08 Release: Deployment Map baseline changed before authority")
	}
	if err := reobserveTargets(ctx, current.ProjectDir, value); err != nil {
		return AuthorizeResult{}, err
	}
	gateSet, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage08, value.EffectivePolicyRef, at)
	if err != nil {
		return AuthorizeResult{}, err
	}
	if err := gate.ValidateAcknowledgements(current.ProjectDir, current.Snapshot.RecordDir, gateSet.Set, acknowledgements, true); err != nil {
		return AuthorizeResult{}, err
	}
	if acknowledgements == nil {
		acknowledgements = []gate.Acknowledgement{}
	}
	authority := Authority{SchemaVersion: 1, Artifact: "release-authority", Version: 1, AuthorityID: "release-authority-" + ref.SHA256[7:19], IntentID: current.Snapshot.State.IntentID, ReleasePlanRef: ref, AcceptedCandidateRef: value.AcceptedCandidateRef, GateRequirementSetRef: gateSet.Reference, PolicyAcknowledgements: acknowledgements, HumanInputReceiptRef: proof.ReceiptReference(), Decision: "authorize-release", Reason: reason, DecidedBy: "human", DecidedAt: at}
	authorityRef, authorityBytes, err := stageruntime.WriteCanonical(current.ProjectDir, AuthorityRevisionPath(current.Snapshot.RecordDir, authority.AuthorityID), authority.Artifact, 1, authority, true)
	if err != nil {
		return AuthorizeResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, AuthorityPath(current.Snapshot.RecordDir), authority.Artifact, authorityBytes); err != nil {
		return AuthorizeResult{}, err
	}
	attempt := Attempt{SchemaVersion: 1, Artifact: "release-attempt", Version: 1, IntentID: current.Snapshot.State.IntentID, Attempt: nextAttempt(current.Snapshot.RecordDir), Status: "active", ReleasePlanRef: ref, AuthorityRef: authorityRef, StepReceiptRefs: []contract.ArtifactReference{}, StartedAt: at, UpdatedAt: at}
	if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, AttemptPath(current.Snapshot.RecordDir, attempt.Attempt), attempt.Artifact, 1, attempt, false); err != nil {
		return AuthorizeResult{}, err
	}
	parked, err := stageruntime.Park(ctx, current, "ST-08 has exact human authority and is ready for Core execution.", at)
	if err != nil {
		return AuthorizeResult{}, err
	}
	resolution, resolutionRef, err := humanapproval.Resolve(ctx, current.ProjectDir, current.Snapshot.RecordDir, proof, &authorityRef, "authorized", at)
	return AuthorizeResult{Authority: authority, AuthorityReference: authorityRef, Attempt: attempt, HumanGateResolution: resolution, HumanGateResolutionRef: resolutionRef, State: parked}, err
}

func Execute(ctx context.Context, projectDir, coreDir, at string) (ExecuteResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage08)
	if err != nil {
		return ExecuteResult{}, err
	}
	planValue, planRef, err := readCurrentPlan(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return ExecuteResult{}, err
	}
	authority, authorityRef, err := readCurrentAuthority(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return ExecuteResult{}, err
	}
	if authority.ReleasePlanRef != planRef {
		return ExecuteResult{}, fmt.Errorf("ST-08 Release: Authority does not bind active Plan")
	}
	attemptNumber := latestAttempt(current.Snapshot.RecordDir)
	attempt, _, _, err := stageruntime.ReadCanonical[Attempt](current.ProjectDir, AttemptPath(current.Snapshot.RecordDir, attemptNumber), "release-attempt", 1)
	if err != nil {
		return ExecuteResult{}, err
	}
	if attempt.Status != "active" || attempt.AuthorityRef != authorityRef {
		return ExecuteResult{}, fmt.Errorf("ST-08 Release: no active authorized Attempt")
	}
	if at == "" {
		at = stageruntime.Now()
	}
	requestPath, err := stageruntime.ReadReference(current.ProjectDir, planValue.WorkRequestRef)
	if err != nil {
		return ExecuteResult{}, err
	}
	request, _, _, err := stageruntime.ReadCanonical[WorkRequest](current.ProjectDir, requestPath, "release-work-request", 1)
	if err != nil {
		return ExecuteResult{}, err
	}
	activeBaselineRef, err := readDeploymentBaselineRef(current.ProjectDir)
	if err != nil {
		return ExecuteResult{}, err
	}
	if !equalOptionalRefs(request.DeploymentMapBaselineRef, activeBaselineRef) {
		return block(ctx, current, attempt, "Deployment Map baseline changed after Release planning", at)
	}
	receiptRefs := append([]contract.ArtifactReference{}, attempt.StepReceiptRefs...)
	completed := []Step{}
	for _, step := range ordered(planValue.Steps) {
		target := targetByID(planValue.Targets, step.TargetID)
		if target == nil {
			return block(ctx, current, attempt, "Release target lost its Repository binding", at)
		}
		source := sourceByID(request.SourceTargets, stringValue(target.RepositoryID))
		if source == nil {
			return block(ctx, current, attempt, "Release target lost its Repository binding", at)
		}
		root := filepath.Join(current.ProjectDir, filepath.FromSlash(source.RepositoryRoot))
		receiptPath := StepReceiptPath(current.Snapshot.RecordDir, attempt.Attempt, step.StepID, false)
		prior, priorRef, _, receiptExists, err := stageruntime.ReadCanonicalIfExists[StepReceipt](current.ProjectDir, receiptPath, "release-step-receipt", 1)
		if err != nil {
			return ExecuteResult{}, err
		}
		if receiptExists {
			if prior.IntentID != current.Snapshot.State.IntentID || prior.Attempt != attempt.Attempt || prior.StepID != step.StepID || prior.TargetID != target.TargetID || prior.CapabilityID != step.CapabilityID || (prior.Outcome != "succeeded" && prior.Outcome != "recovered") || prior.AfterState != step.DesiredState {
				return block(ctx, current, attempt, "existing Release Step receipt differs from the active Plan", at)
			}
			observed, err := remoteRevision(ctx, root, target.Locator)
			if err != nil || observed != step.DesiredState {
				return block(ctx, current, attempt, "completed Release Step no longer matches its receipt", at)
			}
			if !containsReference(receiptRefs, priorRef) {
				receiptRefs = append(receiptRefs, priorRef)
			}
			completed = append(completed, step)
			attempt.StepReceiptRefs = receiptRefs
			attempt.UpdatedAt = at
			if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, AttemptPath(current.Snapshot.RecordDir, attempt.Attempt), attempt.Artifact, 1, attempt, false); err != nil {
				return ExecuteResult{}, err
			}
			continue
		}
		before, err := remoteRevision(ctx, root, target.Locator)
		if err != nil {
			return block(ctx, current, attempt, err.Error(), at)
		}
		if before != target.ObservedBefore && before != step.DesiredState {
			return block(ctx, current, attempt, "Release Target drifted after authority", at)
		}
		outcome := "succeeded"
		detail := "Registered Git Source promotion reached the approved revision."
		var operationID *string
		if before == step.DesiredState {
			outcome = "recovered"
			detail = "Target already matched the approved revision; no duplicate operation was sent."
		} else {
			remote, ref, err := locatorParts(target.Locator)
			if err != nil {
				return block(ctx, current, attempt, err.Error(), at)
			}
			if _, err := git(ctx, root, "push", "--porcelain", remote, step.DesiredState+":"+ref); err != nil {
				afterFailure, observeErr := remoteRevision(ctx, root, target.Locator)
				if observeErr != nil {
					afterFailure = before
				}
				failed := StepReceipt{SchemaVersion: 1, Artifact: "release-step-receipt", Version: 1, IntentID: current.Snapshot.State.IntentID, Attempt: attempt.Attempt, StepID: step.StepID, TargetID: target.TargetID, CapabilityID: step.CapabilityID, IdempotencyKey: digest.Bytes([]byte(planRef.SHA256 + "\x00" + step.StepID + "\x00" + step.DesiredState)), Outcome: "failed", BeforeState: before, AfterState: afterFailure, Detail: err.Error(), ExecutedAt: at}
				failedRef, _, writeErr := stageruntime.WriteCanonical(current.ProjectDir, StepReceiptPath(current.Snapshot.RecordDir, attempt.Attempt, step.StepID, false), failed.Artifact, 1, failed, true)
				if writeErr != nil {
					return ExecuteResult{}, writeErr
				}
				receiptRefs = append(receiptRefs, failedRef)
				if len(completed) == 0 {
					return blockWithRefs(ctx, current, attempt, "Release Step failed before any completed promotion", at, receiptRefs)
				}
				if rollbackErr := rollback(ctx, current.ProjectDir, current.Snapshot.RecordDir, planValue, request, attempt, completed, at, &receiptRefs); rollbackErr != nil {
					return blockWithRefs(ctx, current, attempt, rollbackErr.Error(), at, receiptRefs)
				}
				return finalize(ctx, current, planValue, planRef, authorityRef, attempt, request, "rolled_back", receiptRefs, at)
			}
			id := "git:" + target.Locator + "@" + step.DesiredState
			operationID = &id
		}
		after, err := remoteRevision(ctx, root, target.Locator)
		if err != nil || after != step.DesiredState {
			return blockWithRefs(ctx, current, attempt, "post-release verification did not reach approved revision", at, receiptRefs)
		}
		receipt := StepReceipt{SchemaVersion: 1, Artifact: "release-step-receipt", Version: 1, IntentID: current.Snapshot.State.IntentID, Attempt: attempt.Attempt, StepID: step.StepID, TargetID: target.TargetID, CapabilityID: step.CapabilityID, IdempotencyKey: digest.Bytes([]byte(planRef.SHA256 + "\x00" + step.StepID + "\x00" + step.DesiredState)), Outcome: outcome, BeforeState: before, AfterState: after, ExternalOperationID: operationID, Detail: detail, ExecutedAt: at}
		ref, _, err := stageruntime.WriteCanonical(current.ProjectDir, StepReceiptPath(current.Snapshot.RecordDir, attempt.Attempt, step.StepID, false), receipt.Artifact, 1, receipt, true)
		if err != nil {
			return ExecuteResult{}, err
		}
		receiptRefs = append(receiptRefs, ref)
		completed = append(completed, step)
		attempt.StepReceiptRefs = receiptRefs
		attempt.UpdatedAt = at
		if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, AttemptPath(current.Snapshot.RecordDir, attempt.Attempt), attempt.Artifact, 1, attempt, false); err != nil {
			return ExecuteResult{}, err
		}
	}
	return finalize(ctx, current, planValue, planRef, authorityRef, attempt, request, "released", receiptRefs, at)
}

// Reuse verifies an already released Candidate against live targets before
// carrying its immutable release evidence into the active Intent.
func Reuse(ctx context.Context, projectDir, coreDir, sourceCurrentPath, reason, at string) (ReuseResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage08)
	if err != nil {
		return ReuseResult{}, err
	}
	reviewCurrent, reviewRef, _, err := stageruntime.ReadCanonical[st07review.Current](current.ProjectDir, st07review.CurrentPath(current.Snapshot.RecordDir), "review-current", 1)
	if err != nil || reviewCurrent.AcceptedCandidateRef == nil {
		return ReuseResult{}, fmt.Errorf("ST-08 Release: reuse requires the active Accepted Candidate")
	}
	activePath, err := stageruntime.ReadReference(current.ProjectDir, *reviewCurrent.AcceptedCandidateRef)
	if err != nil {
		return ReuseResult{}, err
	}
	activeAccepted, activeAcceptedRef, _, err := stageruntime.ReadCanonical[st07review.AcceptedCandidate](current.ProjectDir, activePath, "accepted-candidate", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	prior, priorRef, _, err := stageruntime.ReadCanonical[Current](current.ProjectDir, sourceCurrentPath, "release-current", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	if prior.Outcome != "released" || prior.AcceptedCandidateRef == nil || prior.ReleasePlanRef == nil || prior.ReleaseAuthorityRef == nil || prior.ReleaseReceiptRef == nil || prior.DeploymentMapRef == nil {
		return ReuseResult{}, fmt.Errorf("ST-08 Release: only a complete released Current can be reused")
	}
	priorAcceptedPath, err := stageruntime.ReadReference(current.ProjectDir, *prior.AcceptedCandidateRef)
	if err != nil {
		return ReuseResult{}, err
	}
	priorAccepted, _, _, err := stageruntime.ReadCanonical[st07review.AcceptedCandidate](current.ProjectDir, priorAcceptedPath, "accepted-candidate", 1)
	if err != nil || !reflect.DeepEqual(priorAccepted.SourceResults, activeAccepted.SourceResults) {
		return ReuseResult{}, fmt.Errorf("ST-08 Release: reused Release belongs to different Candidate source revisions")
	}
	planPath, err := stageruntime.ReadReference(current.ProjectDir, *prior.ReleasePlanRef)
	if err != nil {
		return ReuseResult{}, err
	}
	planValue, planRef, _, err := stageruntime.ReadCanonical[Plan](current.ProjectDir, planPath, "release-plan", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	if planValue.EffectivePolicyRef != current.Snapshot.State.PolicySnapshot {
		return ReuseResult{}, fmt.Errorf("ST-08 Release: reused Plan Policy differs from active Policy")
	}
	authorityPath, err := stageruntime.ReadReference(current.ProjectDir, *prior.ReleaseAuthorityRef)
	if err != nil {
		return ReuseResult{}, err
	}
	authority, authorityRef, _, err := stageruntime.ReadCanonical[Authority](current.ProjectDir, authorityPath, "release-authority", 1)
	if err != nil || authority.ReleasePlanRef != planRef {
		return ReuseResult{}, fmt.Errorf("ST-08 Release: reused Authority does not bind Plan")
	}
	receiptPath, err := stageruntime.ReadReference(current.ProjectDir, *prior.ReleaseReceiptRef)
	if err != nil {
		return ReuseResult{}, err
	}
	receipt, receiptRef, _, err := stageruntime.ReadCanonical[Receipt](current.ProjectDir, receiptPath, "release-receipt", 1)
	if err != nil || receipt.Outcome != "released" || receipt.ReleasePlanRef != planRef || receipt.AuthorityRef != authorityRef {
		return ReuseResult{}, fmt.Errorf("ST-08 Release: reused Receipt binding differs")
	}
	requestPath, err := stageruntime.ReadReference(current.ProjectDir, planValue.WorkRequestRef)
	if err != nil {
		return ReuseResult{}, err
	}
	request, _, _, err := stageruntime.ReadCanonical[WorkRequest](current.ProjectDir, requestPath, "release-work-request", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	for _, target := range planValue.Targets {
		source := sourceByID(request.SourceTargets, stringValue(target.RepositoryID))
		if source == nil {
			return ReuseResult{}, fmt.Errorf("ST-08 Release: reused Target lost Repository binding")
		}
		observed, err := remoteRevision(ctx, filepath.Join(current.ProjectDir, filepath.FromSlash(source.RepositoryRoot)), target.Locator)
		if err != nil || observed != source.CandidateRevision {
			return ReuseResult{}, fmt.Errorf("ST-08 Release: reused Target no longer matches released Candidate")
		}
	}
	if _, err := stageruntime.ReadReference(current.ProjectDir, *prior.DeploymentMapRef); err != nil {
		return ReuseResult{}, err
	}
	if at == "" {
		at = stageruntime.Now()
	}
	value := Current{SchemaVersion: 1, Artifact: "release-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: contract.Reuse, Outcome: "released", ReviewCurrentRef: reviewRef, AcceptedCandidateRef: &activeAcceptedRef, ReleasePlanRef: &planRef, ReleaseAuthorityRef: &authorityRef, ReleaseReceiptRef: &receiptRef, DeploymentMapRef: prior.DeploymentMapRef, Reason: reason, UpdatedAt: at}
	valueRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), value.Artifact, 1, value, false)
	if err != nil {
		return ReuseResult{}, err
	}
	revised, err := revise(current, contract.Reuse, "st08-reuse-"+priorRef.SHA256[7:19], reason, []contract.ArtifactReference{planRef, authorityRef, receiptRef, *prior.DeploymentMapRef, priorRef, valueRef}, false)
	if err != nil {
		return ReuseResult{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	advanced, err := stageruntime.Advance(ctx, current, valueRef, "external-operation-reconciler", "ST-09 Outcome Evaluation is ready for Core preparation.", at)
	return ReuseResult{Current: value, CurrentReference: valueRef, ReusedReleaseCurrentReference: priorRef, State: advanced}, err
}

type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	_, _, _, planExists, err := stageruntime.ReadCanonicalIfExists[Plan](projectDir, PlanPath(snapshot.RecordDir), "release-plan", 1)
	if err != nil {
		return directive.Core{}, err
	}
	if planExists {
		plan, planRef, err := readCurrentPlan(projectDir, snapshot.RecordDir)
		if err != nil {
			return directive.Core{}, err
		}
		currentHTML, err := readRegular(ReviewPath(snapshot.RecordDir))
		if err != nil {
			return directive.Core{}, err
		}
		immutableHTML, err := readRegular(ReviewRevisionPath(snapshot.RecordDir, plan.Revision))
		if err != nil || string(currentHTML) != string(immutableHTML) {
			return directive.Core{}, fmt.Errorf("ST-08 Release: mutable Review HTML differs from immutable revision")
		}
		reviewRef, err := stageruntime.Reference(projectDir, ReviewRevisionPath(snapshot.RecordDir, plan.Revision), "release-html", 1, immutableHTML)
		if err != nil {
			return directive.Core{}, err
		}
		_, _, _, authorityExists, err := stageruntime.ReadCanonicalIfExists[Authority](projectDir, AuthorityPath(snapshot.RecordDir), "release-authority", 1)
		if err != nil {
			return directive.Core{}, err
		}
		stageID := contract.Stage08
		if !authorityExists {
			result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Approval, Stage: &stageID, Reason: "A human must approve the exact Release Plan before any external operation.", Candidate: &planRef, Review: &reviewRef, Decisions: []string{"approve", "revise"}, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
			return result, result.Validate()
		}
		if _, _, err := readCurrentAuthority(projectDir, snapshot.RecordDir); err != nil {
			return directive.Core{}, err
		}
		result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Parked, Stage: &stageID, Reason: "The exact Release Plan is authorized and awaits Core execution.", GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
		return result, result.Validate()
	}
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, "")
	if err != nil {
		return directive.Core{}, err
	}
	if prepared.Execution == "advanced" && prepared.CurrentReference != nil {
		from, to := contract.Stage08, contract.Stage09
		result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Advanced, CompletedStage: &from, Stage: &to, Reason: "ST-08 deterministically recorded not_applicable and advanced.", Evidence: []contract.ArtifactReference{*prepared.CurrentReference}, GraphVersion: prepared.State.GraphVersion, PlanRevision: prepared.State.PlanRevision, DecisionAuthority: "core"}
		return result, result.Validate()
	}
	if prepared.Reference == nil {
		return directive.Core{}, fmt.Errorf("ST-08 Release did not produce a Work Request")
	}
	stageID := contract.Stage08
	result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Work, Stage: &stageID, Reason: "Core fixed the accepted Candidate and installed release capability; AI may propose a structured Plan only.", Request: prepared.Reference, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
	return result, result.Validate()
}

func validateProposal(value Proposal) error {
	if value.SchemaVersion != 1 || value.Artifact != "release-plan-proposal" || value.Version != 1 || value.Disposition != contract.Execute || value.ProposedBy != "ai" {
		return fmt.Errorf("Release Plan Proposal has invalid schema identity or authority")
	}
	if len(value.Targets) == 0 || len(value.Steps) == 0 {
		return fmt.Errorf("Release Plan Proposal requires Targets and Steps")
	}
	return nil
}
func pinTargets(ctx context.Context, projectDir string, request WorkRequest, proposed []ProposedTarget, at string) ([]Target, error) {
	if len(proposed) != len(request.SourceTargets) {
		return nil, fmt.Errorf("ST-08 Release: exactly one target per Repository is required")
	}
	seen := map[string]bool{}
	result := []Target{}
	for _, item := range proposed {
		if item.RepositoryID == nil || item.TargetKind != "source" || item.Provider != "git" || item.CapabilityID != GitCapabilityID || seen[*item.RepositoryID] {
			return nil, fmt.Errorf("ST-08 Release: invalid or duplicate Git source target")
		}
		source := sourceByID(request.SourceTargets, *item.RepositoryID)
		if source == nil {
			return nil, fmt.Errorf("ST-08 Release: target references unknown Repository")
		}
		remote, _, err := locatorParts(item.Locator)
		if err != nil || !contains(source.AvailableRemotes, remote) {
			return nil, fmt.Errorf("ST-08 Release: target locator is not an available remote")
		}
		observed, err := remoteRevision(ctx, filepath.Join(projectDir, filepath.FromSlash(source.RepositoryRoot)), item.Locator)
		if err != nil {
			return nil, err
		}
		seen[*item.RepositoryID] = true
		result = append(result, Target{ProposedTarget: item, ObservedBefore: observed, ObservedAt: at})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].TargetID < result[j].TargetID })
	return result, nil
}
func validateSteps(request WorkRequest, targets []Target, steps []Step) error {
	if len(steps) != len(targets) {
		return fmt.Errorf("ST-08 Release: exactly one Step per Target is required")
	}
	targetSeen := map[string]bool{}
	stepIDs := map[string]bool{}
	for _, step := range steps {
		target := targetByID(targets, step.TargetID)
		if target == nil || target.RepositoryID == nil || targetSeen[step.TargetID] || stepIDs[step.StepID] || step.Operation != "source-promote" || step.CapabilityID != GitCapabilityID || step.PostReleaseCheck != "target-matches-desired" || step.RollbackMode != "automatic" {
			return fmt.Errorf("ST-08 Release: invalid Release Step")
		}
		source := sourceByID(request.SourceTargets, *target.RepositoryID)
		if source == nil || step.DesiredState != source.CandidateRevision {
			return fmt.Errorf("ST-08 Release: Step desired state differs from Candidate")
		}
		targetSeen[step.TargetID] = true
		stepIDs[step.StepID] = true
	}
	_, ok := orderedSafe(steps)
	if !ok {
		return fmt.Errorf("ST-08 Release: Step dependency graph is cyclic or unknown")
	}
	return nil
}
func sourceTargets(ctx context.Context, projectDir string, accepted st07review.AcceptedCandidate) ([]SourceTarget, error) {
	canonicalProject, err := filepath.EvalSymlinks(projectDir)
	if err != nil {
		return nil, err
	}
	contractPath, err := stageruntime.ReadReference(projectDir, accepted.BuildContractRef)
	if err != nil {
		return nil, err
	}
	build, _, _, err := stageruntime.ReadCanonical[st05buildcontract.BuildContract](projectDir, contractPath, "build-contract", 1)
	if err != nil {
		return nil, err
	}
	result := []SourceTarget{}
	for _, candidate := range accepted.SourceResults {
		roots := map[string]bool{}
		locators := []string{}
		for _, sourceID := range candidate.SourceIDs {
			found := false
			for _, target := range build.TargetSources {
				if target.SourceID == sourceID {
					root := projectDir
					if target.Locator != "." {
						root = filepath.Join(projectDir, filepath.FromSlash(target.Locator))
					}
					repo, err := git(ctx, root, "rev-parse", "--show-toplevel")
					if err != nil {
						return nil, err
					}
					roots[repo] = true
					locators = append(locators, target.Locator)
					found = true
				}
			}
			if !found {
				return nil, fmt.Errorf("ST-08 Release: unknown source %s", sourceID)
			}
		}
		if len(roots) != 1 {
			return nil, fmt.Errorf("ST-08 Release: Candidate Repository binding differs")
		}
		var root string
		for value := range roots {
			root = value
		}
		branch, err := git(ctx, root, "symbolic-ref", "HEAD")
		if err != nil {
			return nil, err
		}
		remotesText, err := git(ctx, root, "remote")
		if err != nil {
			return nil, err
		}
		remotes := lines(remotesText)
		canonicalRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			return nil, err
		}
		relative, err := filepath.Rel(canonicalProject, canonicalRoot)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("ST-08 Release: Repository is outside Project")
		}
		result = append(result, SourceTarget{RepositoryID: candidate.RepositoryID, SourceIDs: candidate.SourceIDs, SourceLocators: locators, RepositoryRoot: filepath.ToSlash(relative), BaseRevision: candidate.BaseRevision, CandidateRevision: candidate.CandidateRevision, IntegrationBranch: candidate.IntegrationBranch, CurrentBranchRef: branch, AvailableRemotes: remotes})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].RepositoryID < result[j].RepositoryID })
	return result, nil
}
func reobserveTargets(ctx context.Context, projectDir string, plan Plan) error {
	requestPath, err := stageruntime.ReadReference(projectDir, plan.WorkRequestRef)
	if err != nil {
		return err
	}
	request, _, _, err := stageruntime.ReadCanonical[WorkRequest](projectDir, requestPath, "release-work-request", 1)
	if err != nil {
		return err
	}
	for _, target := range plan.Targets {
		source := sourceByID(request.SourceTargets, stringValue(target.RepositoryID))
		if source == nil {
			return fmt.Errorf("ST-08 Release: target lost Repository binding")
		}
		observed, err := remoteRevision(ctx, filepath.Join(projectDir, filepath.FromSlash(source.RepositoryRoot)), target.Locator)
		if err != nil {
			return err
		}
		if observed != target.ObservedBefore {
			return fmt.Errorf("ST-08 Release: Target %s drifted after review", target.TargetID)
		}
	}
	return nil
}
func rollback(ctx context.Context, projectDir, recordDir string, plan Plan, request WorkRequest, attempt Attempt, completed []Step, at string, refs *[]contract.ArtifactReference) error {
	for index := len(completed) - 1; index >= 0; index-- {
		step := completed[index]
		target := targetByID(plan.Targets, step.TargetID)
		if target == nil {
			return fmt.Errorf("ST-08 Release: rollback target is missing")
		}
		source := sourceByID(request.SourceTargets, stringValue(target.RepositoryID))
		if source == nil {
			return fmt.Errorf("ST-08 Release: rollback Repository binding is missing")
		}
		root := filepath.Join(projectDir, filepath.FromSlash(source.RepositoryRoot))
		remote, ref, _ := locatorParts(target.Locator)
		currentState, err := remoteRevision(ctx, root, target.Locator)
		if err != nil {
			return err
		}
		if _, err := git(ctx, root, "push", "--porcelain", "--force-with-lease="+ref+":"+step.DesiredState, remote, target.ObservedBefore+":"+ref); err != nil {
			return fmt.Errorf("ST-08 Release: rollback failed: %w", err)
		}
		after, err := remoteRevision(ctx, root, target.Locator)
		if err != nil || after != target.ObservedBefore {
			return fmt.Errorf("ST-08 Release: rollback state mismatch")
		}
		operationID := "git:" + target.Locator + "@" + target.ObservedBefore
		receipt := StepReceipt{SchemaVersion: 1, Artifact: "release-step-receipt", Version: 1, IntentID: attempt.IntentID, Attempt: attempt.Attempt, StepID: step.StepID, TargetID: target.TargetID, CapabilityID: step.CapabilityID, IdempotencyKey: digest.Bytes([]byte(plan.WorkRequestRef.SHA256 + "\x00rollback\x00" + step.StepID + "\x00" + target.ObservedBefore)), Outcome: "rolled_back", BeforeState: currentState, AfterState: after, ExternalOperationID: &operationID, Detail: "Completed promotion returned to its authority-time observed state.", ExecutedAt: at}
		receiptRef, _, err := stageruntime.WriteCanonical(projectDir, StepReceiptPath(recordDir, attempt.Attempt, step.StepID, true), receipt.Artifact, 1, receipt, true)
		if err != nil {
			return err
		}
		*refs = append(*refs, receiptRef)
	}
	return nil
}
func finalize(ctx context.Context, current stageruntime.Context, plan Plan, planRef, authorityRef contract.ArtifactReference, attempt Attempt, request WorkRequest, outcome string, receiptRefs []contract.ArtifactReference, at string) (ExecuteResult, error) {
	states := []TargetState{}
	for _, target := range plan.Targets {
		source := sourceByID(request.SourceTargets, stringValue(target.RepositoryID))
		observed, err := remoteRevision(ctx, filepath.Join(current.ProjectDir, filepath.FromSlash(source.RepositoryRoot)), target.Locator)
		if err != nil {
			return ExecuteResult{}, err
		}
		states = append(states, TargetState{TargetID: target.TargetID, ObservedState: observed})
	}
	receipt := Receipt{SchemaVersion: 1, Artifact: "release-receipt", Version: 1, IntentID: current.Snapshot.State.IntentID, Attempt: attempt.Attempt, Outcome: outcome, ReleasePlanRef: planRef, AuthorityRef: authorityRef, AcceptedCandidateRef: plan.AcceptedCandidateRef, StepReceiptRefs: receiptRefs, TargetStates: states, CompletedAt: at}
	receiptRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, ReceiptPath(current.Snapshot.RecordDir, attempt.Attempt), receipt.Artifact, 1, receipt, true)
	if err != nil {
		return ExecuteResult{}, err
	}
	deploymentRef, err := promoteDeployment(current.ProjectDir, plan, request, receiptRef, states, at)
	if err != nil {
		return ExecuteResult{}, err
	}
	attempt.Status = map[bool]string{true: "succeeded", false: "rolled_back"}[outcome == "released"]
	attempt.StepReceiptRefs = receiptRefs
	attempt.UpdatedAt = at
	if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, AttemptPath(current.Snapshot.RecordDir, attempt.Attempt), attempt.Artifact, 1, attempt, false); err != nil {
		return ExecuteResult{}, err
	}
	reason := "All authorized Release Steps reached their approved Target state."
	if outcome == "rolled_back" {
		reason = "A later Release Step failed and all completed external operations were returned to their observed pre-release state."
	}
	value := Current{SchemaVersion: 1, Artifact: "release-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: contract.Execute, Outcome: outcome, ReviewCurrentRef: plan.ReviewCurrentRef, AcceptedCandidateRef: &plan.AcceptedCandidateRef, ReleasePlanRef: &planRef, ReleaseAuthorityRef: &authorityRef, ReleaseReceiptRef: &receiptRef, DeploymentMapRef: &deploymentRef, Reason: reason, UpdatedAt: at}
	valueRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), value.Artifact, 1, value, false)
	if err != nil {
		return ExecuteResult{}, err
	}
	revised, err := revise(current, contract.Execute, "st08-release-"+planRef.SHA256[7:19], value.Reason, []contract.ArtifactReference{planRef, authorityRef, receiptRef, deploymentRef, valueRef}, false)
	if err != nil {
		return ExecuteResult{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	advanced, err := stageruntime.Advance(ctx, current, valueRef, "deployment-map-promoter", "ST-09 Outcome Evaluation is ready for Core preparation.", at)
	return ExecuteResult{Outcome: outcome, Receipt: &receipt, ReceiptReference: &receiptRef, Current: &value, CurrentReference: &valueRef, State: advanced}, err
}
func promoteDeployment(projectDir string, plan Plan, request WorkRequest, receiptRef contract.ArtifactReference, states []TargetState, at string) (contract.ArtifactReference, error) {
	old, oldMap, activeBaselineRef, exists, err := readDeploymentBaseline(projectDir)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	if !equalOptionalRefs(request.DeploymentMapBaselineRef, activeBaselineRef) {
		return contract.ArtifactReference{}, fmt.Errorf("ST-08 Release: Deployment Map baseline changed before promotion")
	}
	revision := 1
	var base *int
	if exists {
		revision = old.Revision + 1
		value := old.Revision
		base = &value
	}
	stateByID := map[string]string{}
	for _, item := range states {
		stateByID[item.TargetID] = item.ObservedState
	}
	replaced := map[string]bool{}
	for _, target := range plan.Targets {
		replaced[deploymentTargetKey(target.Provider, target.Locator, target.Environment)] = true
	}
	targets := []DeploymentTarget{}
	for _, target := range oldMap.Targets {
		if !replaced[deploymentTargetKey(target.Provider, target.Locator, target.Environment)] {
			targets = append(targets, target)
		}
	}
	for _, target := range plan.Targets {
		targets = append(targets, DeploymentTarget{TargetID: "deployment-" + digest.Bytes([]byte(target.TargetID + "\x00" + target.Locator))[7:23], TargetKind: target.TargetKind, Provider: target.Provider, Locator: target.Locator, Environment: target.Environment, ObservedState: stateByID[target.TargetID], ObservedAt: at, ReleaseReceiptRef: receiptRef})
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].TargetID < targets[j].TargetID })
	value := DeploymentMap{SchemaVersion: 1, Artifact: "deployment-map", Version: 1, MapID: "default-deployment", Revision: revision, BaseRevision: base, Targets: targets, UpdatedAt: at}
	ref, _, err := stageruntime.WriteCanonical(projectDir, deploymentRevisionPath(projectDir, revision), value.Artifact, 1, value, true)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	baseline := DeploymentBaseline{SchemaVersion: 1, Artifact: "deployment-map-baseline", Version: 1, MapID: value.MapID, Revision: revision, SourceOfTruth: ref.SourceOfTruth, SHA256: ref.SHA256, UpdatedAt: at}
	_, _, err = stageruntime.WriteCanonical(projectDir, deploymentBaselinePath(projectDir), baseline.Artifact, 1, baseline, false)
	return ref, err
}
func block(ctx context.Context, current stageruntime.Context, attempt Attempt, reason, at string) (ExecuteResult, error) {
	return blockWithRefs(ctx, current, attempt, reason, at, attempt.StepReceiptRefs)
}
func blockWithRefs(ctx context.Context, current stageruntime.Context, attempt Attempt, reason, at string, refs []contract.ArtifactReference) (ExecuteResult, error) {
	attempt.Status = "blocked"
	attempt.StepReceiptRefs = refs
	attempt.Failure = &reason
	attempt.UpdatedAt = at
	if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, AttemptPath(current.Snapshot.RecordDir, attempt.Attempt), attempt.Artifact, 1, attempt, false); err != nil {
		return ExecuteResult{}, err
	}
	parked, err := stageruntime.Park(ctx, current, "Release blocked before a completed external outcome: "+reason, at)
	return ExecuteResult{Outcome: "blocked", State: parked}, err
}
func readCurrentPlan(projectDir, recordDir string) (Plan, contract.ArtifactReference, error) {
	current, currentRef, _, err := stageruntime.ReadCanonical[Plan](projectDir, PlanPath(recordDir), "release-plan", 1)
	if err != nil {
		return Plan{}, contract.ArtifactReference{}, err
	}
	immutable, ref, _, err := stageruntime.ReadCanonical[Plan](projectDir, PlanRevisionPath(recordDir, current.Revision), "release-plan", 1)
	if err != nil {
		return Plan{}, contract.ArtifactReference{}, err
	}
	if currentRef.SHA256 != ref.SHA256 || !reflect.DeepEqual(current, immutable) {
		return Plan{}, contract.ArtifactReference{}, fmt.Errorf("ST-08 Release: mutable Plan differs from immutable revision")
	}
	return immutable, ref, nil
}
func readCurrentAuthority(projectDir, recordDir string) (Authority, contract.ArtifactReference, error) {
	current, currentRef, _, err := stageruntime.ReadCanonical[Authority](projectDir, AuthorityPath(recordDir), "release-authority", 1)
	if err != nil {
		return Authority{}, contract.ArtifactReference{}, err
	}
	immutable, ref, _, err := stageruntime.ReadCanonical[Authority](projectDir, AuthorityRevisionPath(recordDir, current.AuthorityID), "release-authority", 1)
	if err != nil {
		return Authority{}, contract.ArtifactReference{}, err
	}
	if currentRef.SHA256 != ref.SHA256 || !reflect.DeepEqual(current, immutable) {
		return Authority{}, contract.ArtifactReference{}, fmt.Errorf("ST-08 Release: mutable Authority differs from immutable decision")
	}
	return immutable, ref, nil
}
func readDeploymentBaseline(projectDir string) (DeploymentBaseline, DeploymentMap, *contract.ArtifactReference, bool, error) {
	value, ref, _, exists, err := stageruntime.ReadCanonicalIfExists[DeploymentBaseline](projectDir, deploymentBaselinePath(projectDir), "deployment-map-baseline", 1)
	if err != nil || !exists {
		return DeploymentBaseline{}, DeploymentMap{}, nil, false, err
	}
	mapValue, mapRef, _, err := stageruntime.ReadCanonical[DeploymentMap](projectDir, filepath.Join(projectDir, filepath.FromSlash(value.SourceOfTruth)), "deployment-map", 1)
	if err != nil {
		return DeploymentBaseline{}, DeploymentMap{}, nil, true, err
	}
	if value.MapID != mapValue.MapID || value.Revision != mapValue.Revision || value.SHA256 != mapRef.SHA256 {
		return DeploymentBaseline{}, DeploymentMap{}, nil, true, fmt.Errorf("ST-08 Release: Deployment Map baseline differs")
	}
	return value, mapValue, &ref, true, nil
}
func readDeploymentBaselineRef(projectDir string) (*contract.ArtifactReference, error) {
	_, _, ref, exists, err := readDeploymentBaseline(projectDir)
	if err != nil || !exists {
		return nil, err
	}
	return ref, nil
}
func equalOptionalRefs(left, right *contract.ArtifactReference) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
func deploymentTargetKey(provider, locator string, environment *string) string {
	return provider + "\x00" + locator + "\x00" + stringValue(environment)
}
func remoteRevision(ctx context.Context, root, locator string) (string, error) {
	remote, ref, err := locatorParts(locator)
	if err != nil {
		return "", err
	}
	output, err := git(ctx, root, "ls-remote", "--refs", remote, ref)
	if err != nil {
		return "", err
	}
	parts := strings.Fields(output)
	if len(parts) != 2 || parts[1] != ref {
		return "", fmt.Errorf("ST-08 Release: target must resolve to exactly one ref")
	}
	return parts[0], nil
}
func locatorParts(locator string) (string, string, error) {
	index := strings.Index(locator, "#")
	if index < 1 {
		return "", "", fmt.Errorf("ST-08 Release: invalid target locator")
	}
	remote, ref := locator[:index], locator[index+1:]
	if !remoteName.MatchString(remote) || !branchRef.MatchString(ref) || strings.Contains(ref, "..") || strings.ContainsAny(ref, "~^:?*[\\") {
		return "", "", fmt.Errorf("ST-08 Release: unsafe target locator")
	}
	return remote, ref, nil
}
func ordered(values []Step) []Step { result, _ := orderedSafe(values); return result }
func orderedSafe(values []Step) ([]Step, bool) {
	pending := map[string]Step{}
	for _, value := range values {
		pending[value.StepID] = value
	}
	done := map[string]bool{}
	result := []Step{}
	for len(pending) > 0 {
		ids := []string{}
		for id, value := range pending {
			ready := true
			for _, dependency := range value.DependsOn {
				if !done[dependency] {
					ready = false
				}
			}
			if ready {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			return nil, false
		}
		sort.Strings(ids)
		id := ids[0]
		result = append(result, pending[id])
		delete(pending, id)
		done[id] = true
	}
	return result, true
}
func targetByID(values []Target, id string) *Target {
	for index := range values {
		if values[index].TargetID == id {
			return &values[index]
		}
	}
	return nil
}
func sourceByID(values []SourceTarget, id string) *SourceTarget {
	for index := range values {
		if values[index].RepositoryID == id {
			return &values[index]
		}
	}
	return nil
}
func nextAttempt(recordDir string) int { return latestAttempt(recordDir) + 1 }
func latestAttempt(recordDir string) int {
	entries, _ := os.ReadDir(filepath.Join(RootDir(recordDir), "attempts"))
	max := 0
	for _, entry := range entries {
		var value int
		if _, err := fmt.Sscanf(entry.Name(), "%06d", &value); err == nil && value > max {
			max = value
		}
	}
	return max
}
func git(ctx context.Context, dir string, args ...string) (string, error) {
	result, err := process.Run(ctx, process.Request{Executable: "git", Args: args, Dir: dir, Env: os.Environ(), ExitCodes: []int{0}})
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(result.Stderr)))
	}
	return strings.TrimSpace(string(result.Stdout)), nil
}
func lines(value string) []string {
	result := []string{}
	for _, line := range strings.Split(value, "\n") {
		if strings.TrimSpace(line) != "" {
			result = append(result, strings.TrimSpace(line))
		}
	}
	sort.Strings(result)
	return result
}
func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
func containsReference(values []contract.ArtifactReference, expected contract.ArtifactReference) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func renderHTML(plan Plan, set gate.RequirementSet) string {
	return "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>ST-08 Release</title></head><body><main><h1>ST-08 Release</h1><p>" + html.EscapeString(plan.Reason) + "</p><p>Targets: " + fmt.Sprint(len(plan.Targets)) + " / Policy requirements: " + fmt.Sprint(len(set.Requirements)) + "</p></main></body></html>\n"
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
			return contract.ArtifactReference{}, fmt.Errorf("immutable Release artifact differs: %s", path)
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
func revise(current stageruntime.Context, disposition contract.Disposition, id, reason string, evidence []contract.ArtifactReference, deterministic bool) (contract.StageExecutionPlan, error) {
	proposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: id, StageID: contract.Stage08, Disposition: disposition, Reason: reason, Evidence: evidence, ProposedBy: contract.ProposerCore}
	return workflowplan.Revise(current.Snapshot.Plan, []contract.StageDispositionProposal{proposal}, workflowplan.RevisionOptions{ProjectDir: current.ProjectDir, StageContracts: []contract.StageContract{current.Contract}, DeterministicApplicability: func(value contract.StageDispositionProposal, _ contract.StageContract) bool {
		return deterministic && value.Disposition == contract.NotApplicable
	}})
}
