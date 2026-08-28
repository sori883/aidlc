// Package st05buildcontract implements ST-05 Build Contract review and approval.
package st05buildcontract

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/explanationhtml"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st01orient"
	"github.com/sori883/aidlc/internal/stage/st03requirements"
	"github.com/sori883/aidlc/internal/stage/st04architecture"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/gate"
	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/state"
)

var patterns = map[string]*regexp.Regexp{"requirement": regexp.MustCompile(`^(?:REQ-[A-Z]+|CON|INV)-\d{3}$`), "contract": regexp.MustCompile(`^CHG-\d{3}$`), "criterion": regexp.MustCompile(`^AC-\d{3}$`), "verifier": regexp.MustCompile(`^VER-\d{3}$`), "bolt": regexp.MustCompile(`^BOLT-\d{3}$`)}

type TargetSource struct {
	SourceID string `json:"source_id"`
	Locator  string `json:"locator"`
}
type Target struct {
	SourceID string `json:"source_id"`
	Path     string `json:"path"`
}
type Assessment struct {
	RequirementID string `json:"requirement_id"`
	BuildImpact   bool   `json:"build_impact"`
	Reason        string `json:"reason"`
}
type ChangeContract struct {
	ContractID           string   `json:"contract_id"`
	Title                string   `json:"title"`
	RequirementIDs       []string `json:"requirement_ids"`
	Targets              []Target `json:"targets"`
	DependsOnContractIDs []string `json:"depends_on_contract_ids"`
	Specification        []string `json:"specification"`
}
type AcceptanceCriterion struct {
	CriterionID    string   `json:"criterion_id"`
	RequirementIDs []string `json:"requirement_ids"`
	Given          string   `json:"given"`
	When           string   `json:"when"`
	Then           string   `json:"then"`
	VerifierIDs    []string `json:"verifier_ids"`
}
type ArtifactCheck struct {
	Path      string  `json:"path"`
	Assertion string  `json:"assertion"`
	Expected  *string `json:"expected"`
}
type RuntimeCheck struct {
	StartArgv        []string `json:"start_argv"`
	Host             string   `json:"host"`
	Port             int      `json:"port"`
	Path             string   `json:"path"`
	ExpectedStatus   int      `json:"expected_status"`
	StartupTimeoutMS int      `json:"startup_timeout_ms"`
}
type Verifier struct {
	VerifierID        string                      `json:"verifier_id"`
	Kind              string                      `json:"kind"`
	SourceID          *string                     `json:"source_id"`
	CWD               *string                     `json:"cwd"`
	Argv              []string                    `json:"argv"`
	TimeoutMS         int                         `json:"timeout_ms"`
	ExpectedExitCodes []int                       `json:"expected_exit_codes"`
	ArtifactCheck     *ArtifactCheck              `json:"artifact_check"`
	RuntimeCheck      *RuntimeCheck               `json:"runtime_check"`
	Expected          string                      `json:"expected"`
	HumanExceptionRef *contract.ArtifactReference `json:"human_exception_ref"`
}
type Bolt struct {
	BoltID                 string   `json:"bolt_id"`
	Title                  string   `json:"title"`
	Objective              string   `json:"objective"`
	ContractIDs            []string `json:"contract_ids"`
	AcceptanceCriterionIDs []string `json:"acceptance_criterion_ids"`
	Targets                []Target `json:"targets"`
	DependsOn              []string `json:"depends_on"`
}
type IntegrationContract struct {
	AcceptanceCriterionIDs []string `json:"acceptance_criterion_ids"`
	VerifierIDs            []string `json:"verifier_ids"`
	CandidateReadyWhen     []string `json:"candidate_ready_when"`
}
type WorkRequest struct {
	SchemaVersion          int                         `json:"schema_version"`
	Artifact               string                      `json:"artifact"`
	Version                int                         `json:"version"`
	IntentID               string                      `json:"intent_id"`
	StageID                contract.StageID            `json:"stage_id"`
	RequirementsCurrentRef contract.ArtifactReference  `json:"requirements_current_ref"`
	RequirementsRef        contract.ArtifactReference  `json:"requirements_ref"`
	ArchitectureCurrentRef contract.ArtifactReference  `json:"architecture_current_ref"`
	ArchitectureRef        *contract.ArtifactReference `json:"architecture_ref"`
	CurrentContextRef      contract.ArtifactReference  `json:"current_context_ref"`
	SystemMapRef           contract.ArtifactReference  `json:"system_map_ref"`
	EffectivePolicyRef     contract.ArtifactReference  `json:"effective_policy_ref"`
	BaseRevision           *int                        `json:"base_revision"`
	BaseBuildContractRef   *contract.ArtifactReference `json:"base_build_contract_ref"`
	RequirementIDs         []string                    `json:"requirement_ids"`
	TargetSources          []TargetSource              `json:"target_sources"`
	RequestedOutputs       []string                    `json:"requested_outputs"`
	Rules                  []string                    `json:"rules"`
	CreatedAt              string                      `json:"created_at"`
}
type Proposal struct {
	SchemaVersion          int                          `json:"schema_version"`
	Artifact               string                       `json:"artifact"`
	Version                int                          `json:"version"`
	ProposalID             string                       `json:"proposal_id"`
	IntentID               string                       `json:"intent_id"`
	WorkRequestSHA256      string                       `json:"work_request_sha256"`
	Disposition            contract.Disposition         `json:"disposition"`
	RequirementAssessments []Assessment                 `json:"requirement_assessments"`
	ChangeContracts        []ChangeContract             `json:"change_contracts"`
	AcceptanceCriteria     []AcceptanceCriterion        `json:"acceptance_criteria"`
	Verifiers              []Verifier                   `json:"verifiers"`
	Bolts                  []Bolt                       `json:"bolts"`
	IntegrationContract    *IntegrationContract         `json:"integration_contract"`
	ReuseRef               *contract.ArtifactReference  `json:"reuse_ref"`
	Evidence               []contract.ArtifactReference `json:"evidence"`
	Reason                 string                       `json:"reason"`
	ProposedBy             string                       `json:"proposed_by"`
}
type Candidate struct {
	SchemaVersion          int                          `json:"schema_version"`
	Artifact               string                       `json:"artifact"`
	Version                int                          `json:"version"`
	ProposalID             string                       `json:"proposal_id"`
	IntentID               string                       `json:"intent_id"`
	Disposition            contract.Disposition         `json:"disposition"`
	RequirementAssessments []Assessment                 `json:"requirement_assessments"`
	ChangeContracts        []ChangeContract             `json:"change_contracts"`
	AcceptanceCriteria     []AcceptanceCriterion        `json:"acceptance_criteria"`
	Verifiers              []Verifier                   `json:"verifiers"`
	Bolts                  []Bolt                       `json:"bolts"`
	IntegrationContract    *IntegrationContract         `json:"integration_contract"`
	ReuseRef               *contract.ArtifactReference  `json:"reuse_ref"`
	Evidence               []contract.ArtifactReference `json:"evidence"`
	Reason                 string                       `json:"reason"`
	ProposedBy             string                       `json:"proposed_by"`
	WorkRequestRef         contract.ArtifactReference   `json:"work_request_ref"`
	RequirementsRef        contract.ArtifactReference   `json:"requirements_ref"`
	ArchitectureCurrentRef contract.ArtifactReference   `json:"architecture_current_ref"`
	ArchitectureRef        *contract.ArtifactReference  `json:"architecture_ref"`
	CurrentContextRef      contract.ArtifactReference   `json:"current_context_ref"`
	SystemMapRef           contract.ArtifactReference   `json:"system_map_ref"`
	EffectivePolicyRef     contract.ArtifactReference   `json:"effective_policy_ref"`
	TargetSources          []TargetSource               `json:"target_sources"`
	DerivedBatches         [][]string                   `json:"derived_batches"`
	CreatedAt              string                       `json:"created_at"`
}
type Approval struct {
	SchemaVersion          int                        `json:"schema_version"`
	Artifact               string                     `json:"artifact"`
	Version                int                        `json:"version"`
	DecisionID             string                     `json:"decision_id"`
	DecisionKind           string                     `json:"decision_kind"`
	IntentID               string                     `json:"intent_id"`
	CandidateRef           contract.ArtifactReference `json:"candidate_ref"`
	GateRequirementSetRef  contract.ArtifactReference `json:"gate_requirement_set_ref"`
	PolicyAcknowledgements []gate.Acknowledgement     `json:"policy_acknowledgements"`
	HumanInputReceiptRef   contract.ArtifactReference `json:"human_input_receipt_ref"`
	Decision               string                     `json:"decision"`
	Reason                 string                     `json:"reason"`
	DecidedBy              string                     `json:"decided_by"`
	DecidedAt              string                     `json:"decided_at"`
}
type BuildContract struct {
	Candidate
	Revision     int                        `json:"revision"`
	BaseRevision *int                       `json:"base_revision"`
	CandidateRef contract.ArtifactReference `json:"candidate_ref"`
	ApprovalRef  contract.ArtifactReference `json:"approval_ref"`
}
type Current struct {
	SchemaVersion          int                         `json:"schema_version"`
	Artifact               string                      `json:"artifact"`
	Version                int                         `json:"version"`
	IntentID               string                      `json:"intent_id"`
	Disposition            contract.Disposition        `json:"disposition"`
	BuildContractRef       *contract.ArtifactReference `json:"build_contract_ref"`
	CandidateRef           contract.ArtifactReference  `json:"candidate_ref"`
	ApprovalRef            contract.ArtifactReference  `json:"approval_ref"`
	RequirementsRef        contract.ArtifactReference  `json:"requirements_ref"`
	ArchitectureCurrentRef contract.ArtifactReference  `json:"architecture_current_ref"`
	CurrentContextRef      contract.ArtifactReference  `json:"current_context_ref"`
	SystemMapRef           contract.ArtifactReference  `json:"system_map_ref"`
	EffectivePolicyRef     contract.ArtifactReference  `json:"effective_policy_ref"`
	Reason                 string                      `json:"reason"`
	UpdatedAt              string                      `json:"updated_at"`
}
type PrepareResult struct {
	Execution string                     `json:"execution"`
	Request   WorkRequest                `json:"request"`
	Reference contract.ArtifactReference `json:"reference"`
}
type ReviewResult struct {
	Candidate          Candidate                  `json:"candidate"`
	CandidateReference contract.ArtifactReference `json:"candidateReference"`
	Gate               gate.RequirementSet        `json:"gate"`
	GateReference      contract.ArtifactReference `json:"gateReference"`
	ReviewReference    contract.ArtifactReference `json:"reviewReference"`
	HumanGate          humanapproval.OpenResult   `json:"humanGate"`
	State              state.IntentState          `json:"state"`
}
type ApproveResult struct {
	Contract               *BuildContract              `json:"contract"`
	Reference              *contract.ArtifactReference `json:"reference"`
	Current                Current                     `json:"current"`
	CurrentReference       contract.ArtifactReference  `json:"currentReference"`
	Approval               Approval                    `json:"approval"`
	ApprovalReference      contract.ArtifactReference  `json:"approvalReference"`
	HumanGateResolution    humanapproval.Resolution    `json:"humanGateResolution"`
	HumanGateResolutionRef contract.ArtifactReference  `json:"humanGateResolutionReference"`
	Plan                   contract.StageExecutionPlan `json:"plan"`
	State                  state.IntentState           `json:"state"`
}
type Pending struct {
	Candidate contract.ArtifactReference
	Review    contract.ArtifactReference
}

func RootDir(recordDir string) string { return filepath.Join(recordDir, "artifacts", "build-contract") }
func WorkRequestPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "work-request.json")
}
func CandidatePath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "candidate.json")
}
func ReviewPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "review.html") }
func GateRefPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "gate-reference.json")
}
func ApprovalPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "approval.json") }
func CurrentPath(recordDir string) string  { return filepath.Join(RootDir(recordDir), "current.json") }
func RevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "build-contract.json")
}

func Prepare(ctx context.Context, projectDir, coreDir, preparedAt string) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage05)
	if err != nil {
		return PrepareResult{}, err
	}
	reqCurrent, reqCurrentRef, _, err := stageruntime.ReadCanonical[st03requirements.Current](current.ProjectDir, st03requirements.CurrentPath(current.Snapshot.RecordDir), "requirements-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	reqPath, err := stageruntime.ReadReference(current.ProjectDir, reqCurrent.RequirementsRef)
	if err != nil {
		return PrepareResult{}, err
	}
	definition, reqRef, _, err := stageruntime.ReadCanonical[st03requirements.Definition](current.ProjectDir, reqPath, "requirements-definition", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	architecture, archCurrentRef, _, err := stageruntime.ReadCanonical[st04architecture.Current](current.ProjectDir, st04architecture.CurrentPath(current.Snapshot.RecordDir), "architecture-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	contextValue, contextRef, _, err := stageruntime.ReadCanonical[st01orient.CurrentContext](current.ProjectDir, st01orient.CurrentContextPath(current.Snapshot.RecordDir), "current-context", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	mapPath, err := stageruntime.ReadReference(current.ProjectDir, contextValue.SystemMapRef)
	if err != nil {
		return PrepareResult{}, err
	}
	systemMap, mapRef, _, err := stageruntime.ReadCanonical[st01orient.SystemMap](current.ProjectDir, mapPath, "system-map", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	ids := requirementIDs(definition)
	sources := make([]TargetSource, 0, len(systemMap.SourceSnapshots))
	for _, source := range systemMap.SourceSnapshots {
		if source.SourceType != "external" {
			sources = append(sources, TargetSource{SourceID: source.SourceID, Locator: source.Locator})
		}
	}
	var baseRevision *int
	var baseRef *contract.ArtifactReference
	storedCurrent, _, _, currentExists, err := stageruntime.ReadCanonicalIfExists[Current](current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), "build-contract-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if currentExists && storedCurrent.BuildContractRef != nil {
		path, err := stageruntime.ReadReference(current.ProjectDir, *storedCurrent.BuildContractRef)
		if err != nil {
			return PrepareResult{}, err
		}
		old, _, _, err := stageruntime.ReadCanonical[BuildContract](current.ProjectDir, path, "build-contract", 1)
		if err != nil {
			return PrepareResult{}, err
		}
		baseRevision = &old.Revision
		baseRef = storedCurrent.BuildContractRef
	}
	path := WorkRequestPath(current.Snapshot.RecordDir)
	storedRequest, reference, _, requestExists, err := stageruntime.ReadCanonicalIfExists[WorkRequest](current.ProjectDir, path, "build-contract-work-request", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if requestExists && storedRequest.IntentID == current.Snapshot.State.IntentID && storedRequest.RequirementsCurrentRef == reqCurrentRef && storedRequest.RequirementsRef == reqRef && storedRequest.ArchitectureCurrentRef == archCurrentRef && equalRefs(storedRequest.ArchitectureRef, architecture.ArchitectureRef) && storedRequest.CurrentContextRef == contextRef && storedRequest.SystemMapRef == mapRef && storedRequest.EffectivePolicyRef == current.Snapshot.State.PolicySnapshot && equalInts(storedRequest.BaseRevision, baseRevision) && equalRefs(storedRequest.BaseBuildContractRef, baseRef) && equalStrings(storedRequest.RequirementIDs, ids) {
		if current.Snapshot.State.Status != state.Ready {
			if _, err := stageruntime.SetReady(ctx, current, storedRequest.CreatedAt); err != nil {
				return PrepareResult{}, err
			}
		}
		return PrepareResult{Execution: "reused", Request: storedRequest, Reference: reference}, nil
	}
	if preparedAt == "" {
		preparedAt = stageruntime.Now()
	}
	request := WorkRequest{SchemaVersion: 1, Artifact: "build-contract-work-request", Version: 1, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage05, RequirementsCurrentRef: reqCurrentRef, RequirementsRef: reqRef, ArchitectureCurrentRef: archCurrentRef, ArchitectureRef: architecture.ArchitectureRef, CurrentContextRef: contextRef, SystemMapRef: mapRef, EffectivePolicyRef: current.Snapshot.State.PolicySnapshot, BaseRevision: baseRevision, BaseBuildContractRef: baseRef, RequirementIDs: ids, TargetSources: sources, RequestedOutputs: []string{"build-contract-proposal"}, Rules: []string{"Assess every requirement exactly once for build impact.", "Use argv arrays and Project-relative repository targets; never use shell strings.", "Every Build Change, acceptance criterion, verifier, and Bolt must be traceable.", "Parallel Bolts cannot own overlapping targets.", "A human must approve the exact candidate SHA-256.", "AI proposes content only; Core validates, derives batches, persists, and routes."}, CreatedAt: preparedAt}
	reference, _, err = stageruntime.WriteCanonical(current.ProjectDir, path, request.Artifact, 1, request, false)
	if err != nil {
		return PrepareResult{}, err
	}
	if _, err := stageruntime.SetReady(ctx, current, preparedAt); err != nil {
		return PrepareResult{}, err
	}
	return PrepareResult{Execution: "prepared", Request: request, Reference: reference}, nil
}

func Review(ctx context.Context, projectDir, coreDir string, proposalContent []byte, reviewedAt string) (ReviewResult, error) {
	prepared, err := Prepare(ctx, projectDir, coreDir, "")
	if err != nil {
		return ReviewResult{}, err
	}
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage05)
	if err != nil {
		return ReviewResult{}, err
	}
	proposal, err := stageruntime.DecodeProposal(proposalContent, func(value Proposal) error { return value.Validate() })
	if err != nil {
		return ReviewResult{}, fmt.Errorf("ST-05 Build Contract Proposal: %w", err)
	}
	if proposal.IntentID != current.Snapshot.State.IntentID || proposal.WorkRequestSHA256 != prepared.Reference.SHA256 {
		return ReviewResult{}, fmt.Errorf("ST-05 Build Contract: Proposal does not bind the active Intent and Work Request")
	}
	batches, err := validateAgainstRequest(current.ProjectDir, prepared.Request, proposal)
	if err != nil {
		return ReviewResult{}, err
	}
	if reviewedAt == "" {
		reviewedAt = stageruntime.Now()
	}
	candidate := Candidate{SchemaVersion: 1, Artifact: "build-contract-candidate", Version: 1, ProposalID: proposal.ProposalID, IntentID: proposal.IntentID, Disposition: proposal.Disposition, RequirementAssessments: proposal.RequirementAssessments, ChangeContracts: proposal.ChangeContracts, AcceptanceCriteria: proposal.AcceptanceCriteria, Verifiers: proposal.Verifiers, Bolts: proposal.Bolts, IntegrationContract: proposal.IntegrationContract, ReuseRef: proposal.ReuseRef, Evidence: proposal.Evidence, Reason: proposal.Reason, ProposedBy: "ai", WorkRequestRef: prepared.Reference, RequirementsRef: prepared.Request.RequirementsRef, ArchitectureCurrentRef: prepared.Request.ArchitectureCurrentRef, ArchitectureRef: prepared.Request.ArchitectureRef, CurrentContextRef: prepared.Request.CurrentContextRef, SystemMapRef: prepared.Request.SystemMapRef, EffectivePolicyRef: prepared.Request.EffectivePolicyRef, TargetSources: prepared.Request.TargetSources, DerivedBatches: batches, CreatedAt: reviewedAt}
	candidateRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CandidatePath(current.Snapshot.RecordDir), candidate.Artifact, 1, candidate, false)
	if err != nil {
		return ReviewResult{}, err
	}
	resolved, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage05, prepared.Request.EffectivePolicyRef, reviewedAt)
	if err != nil {
		return ReviewResult{}, err
	}
	if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, GateRefPath(current.Snapshot.RecordDir), resolved.Reference.Artifact, resolved.Reference.Version, resolved.Reference, false); err != nil {
		return ReviewResult{}, err
	}
	reviewHTML, err := renderReview(candidate, candidateRef, resolved.Set)
	if err != nil {
		return ReviewResult{}, err
	}
	if err := ensureParent(current.ProjectDir, ReviewPath(current.Snapshot.RecordDir)); err != nil {
		return ReviewResult{}, err
	}
	if err := fsx.AtomicWriteFile(ReviewPath(current.Snapshot.RecordDir), []byte(reviewHTML), 0o644); err != nil {
		return ReviewResult{}, err
	}
	reviewRef, err := stageruntime.Reference(current.ProjectDir, ReviewPath(current.Snapshot.RecordDir), "build-contract-review", 1, []byte(reviewHTML))
	if err != nil {
		return ReviewResult{}, err
	}
	humanGate, err := humanapproval.Open(ctx, current.ProjectDir, current.Snapshot.RecordDir, humanapproval.OpenOptions{
		IntentID: current.Snapshot.State.IntentID, Scope: string(contract.Stage05),
		SubjectRef: candidateRef, ReviewRef: reviewRef, GateRequirementRef: &resolved.Reference,
		GraphVersion: current.Snapshot.State.GraphVersion, PlanRevision: current.Snapshot.State.PlanRevision,
		AllowedActions: []string{"approve-build-contract", "request-revision"}, OpenedAt: reviewedAt,
	})
	if err != nil {
		return ReviewResult{}, err
	}
	parked, err := stageruntime.Park(ctx, current, "ST-05 Build Contract candidate is awaiting human approval.", reviewedAt)
	if err != nil {
		return ReviewResult{}, err
	}
	_, _ = audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.StageAwaitingApproval, []audit.Field{{Name: "Stage", Value: "ST-05"}, {Name: "Candidate SHA-256", Value: candidateRef.SHA256}, {Name: "Decision Authority", Value: "human"}}, nil)
	return ReviewResult{Candidate: candidate, CandidateReference: candidateRef, Gate: resolved.Set, GateReference: resolved.Reference, ReviewReference: reviewRef, HumanGate: humanGate, State: parked}, nil
}

func PendingReview(projectDir, recordDir string) (Pending, *Candidate, error) {
	candidate, candidateRef, _, err := stageruntime.ReadCanonical[Candidate](projectDir, CandidatePath(recordDir), "build-contract-candidate", 1)
	if err != nil {
		if os.IsNotExist(err) {
			return Pending{}, nil, nil
		}
		return Pending{}, nil, err
	}
	gateRef, _, _, err := stageruntime.ReadCanonical[contract.ArtifactReference](projectDir, GateRefPath(recordDir), "human-gate-requirements", 1)
	if err != nil {
		return Pending{}, nil, err
	}
	gatePath, err := stageruntime.ReadReference(projectDir, gateRef)
	if err != nil {
		return Pending{}, nil, err
	}
	set, _, _, err := stageruntime.ReadCanonical[gate.RequirementSet](projectDir, gatePath, "human-gate-requirements", 1)
	if err != nil {
		return Pending{}, nil, err
	}
	expected, err := renderReview(candidate, candidateRef, set)
	if err != nil {
		return Pending{}, nil, err
	}
	content, err := os.ReadFile(ReviewPath(recordDir))
	if err != nil || string(content) != expected {
		return Pending{}, nil, fmt.Errorf("ST-05 Build Contract: review HTML does not match canonical Candidate")
	}
	reviewRef, err := stageruntime.Reference(projectDir, ReviewPath(recordDir), "build-contract-review", 1, content)
	if err != nil {
		return Pending{}, nil, err
	}
	return Pending{Candidate: candidateRef, Review: reviewRef}, &candidate, nil
}

type ApprovalParameters struct {
	PolicyAcknowledgements []gate.Acknowledgement `json:"policy_acknowledgements"`
}

func Approve(ctx context.Context, projectDir, coreDir string, proof humanapproval.Proof) (ApproveResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage05)
	if err != nil {
		return ApproveResult{}, err
	}
	pending, candidate, err := PendingReview(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil || candidate == nil {
		return ApproveResult{}, fmt.Errorf("ST-05 Build Contract: pending Candidate is missing: %w", err)
	}
	if err := proof.Require(string(contract.Stage05), "approve-build-contract", pending.Candidate.SHA256); err != nil {
		return ApproveResult{}, fmt.Errorf("ST-05 Build Contract: %w", err)
	}
	var parameters ApprovalParameters
	if err := proof.Parameters(&parameters); err != nil {
		return ApproveResult{}, fmt.Errorf("ST-05 Build Contract approval parameters: %w", err)
	}
	acks := parameters.PolicyAcknowledgements
	reason := proof.Reason()
	decidedAt := proof.Receipt().ObservedAt
	gateRef, _, _, err := stageruntime.ReadCanonical[contract.ArtifactReference](current.ProjectDir, GateRefPath(current.Snapshot.RecordDir), "human-gate-requirements", 1)
	if err != nil {
		return ApproveResult{}, err
	}
	gatePath, err := stageruntime.ReadReference(current.ProjectDir, gateRef)
	if err != nil {
		return ApproveResult{}, err
	}
	set, _, _, err := stageruntime.ReadCanonical[gate.RequirementSet](current.ProjectDir, gatePath, "human-gate-requirements", 1)
	if err != nil {
		return ApproveResult{}, err
	}
	if err := gate.ValidateAcknowledgements(current.ProjectDir, current.Snapshot.RecordDir, set, acks, true); err != nil {
		return ApproveResult{}, err
	}
	if acks == nil {
		acks = []gate.Acknowledgement{}
	}
	approval := Approval{SchemaVersion: 1, Artifact: "human-decision", Version: 1, DecisionID: "approve-build-contract-" + pending.Candidate.SHA256[7:19], DecisionKind: "approval", IntentID: current.Snapshot.State.IntentID, CandidateRef: pending.Candidate, GateRequirementSetRef: gateRef, PolicyAcknowledgements: acks, HumanInputReceiptRef: proof.ReceiptReference(), Decision: "approve-build-contract", Reason: reason, DecidedBy: "human", DecidedAt: decidedAt}
	approvalRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, ApprovalPath(current.Snapshot.RecordDir), approval.Artifact, 1, approval, true)
	if err != nil {
		return ApproveResult{}, err
	}
	var build *BuildContract
	var buildRef *contract.ArtifactReference
	if candidate.Disposition == contract.Execute {
		revision := 1
		var baseRevision *int
		if prepared, prepareErr := Prepare(ctx, current.ProjectDir, coreDir, ""); prepareErr == nil && prepared.Request.BaseRevision != nil {
			base := *prepared.Request.BaseRevision
			baseRevision = &base
			revision = base + 1
		}
		value := BuildContract{Candidate: *candidate, Revision: revision, BaseRevision: baseRevision, CandidateRef: pending.Candidate, ApprovalRef: approvalRef}
		value.Artifact = "build-contract"
		value.ReuseRef = nil
		reference, _, writeErr := stageruntime.WriteCanonical(current.ProjectDir, RevisionPath(current.Snapshot.RecordDir, revision), value.Artifact, 1, value, true)
		if writeErr != nil {
			return ApproveResult{}, writeErr
		}
		build = &value
		buildRef = &reference
	} else if candidate.Disposition == contract.Reuse {
		buildRef = candidate.ReuseRef
		if buildRef == nil {
			return ApproveResult{}, fmt.Errorf("ST-05 Build Contract: reuse reference is missing")
		}
		if _, err := stageruntime.ReadReference(current.ProjectDir, *buildRef); err != nil {
			return ApproveResult{}, err
		}
	}
	pointer := Current{SchemaVersion: 1, Artifact: "build-contract-current", Version: 1, IntentID: candidate.IntentID, Disposition: candidate.Disposition, BuildContractRef: buildRef, CandidateRef: pending.Candidate, ApprovalRef: approvalRef, RequirementsRef: candidate.RequirementsRef, ArchitectureCurrentRef: candidate.ArchitectureCurrentRef, CurrentContextRef: candidate.CurrentContextRef, SystemMapRef: candidate.SystemMapRef, EffectivePolicyRef: candidate.EffectivePolicyRef, Reason: candidate.Reason, UpdatedAt: decidedAt}
	currentRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), pointer.Artifact, 1, pointer, false)
	if err != nil {
		return ApproveResult{}, err
	}
	stageProposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: candidate.ProposalID, StageID: contract.Stage05, Disposition: candidate.Disposition, Reason: candidate.Reason, Evidence: append(append([]contract.ArtifactReference{}, candidate.Evidence...), approvalRef), ProposedBy: contract.ProposerAI}
	if buildRef != nil && !containsRef(stageProposal.Evidence, *buildRef) {
		stageProposal.Evidence = append(stageProposal.Evidence, *buildRef)
	}
	revised, err := workflowplan.Revise(current.Snapshot.Plan, []contract.StageDispositionProposal{stageProposal}, workflowplan.RevisionOptions{ProjectDir: current.ProjectDir, StageContracts: []contract.StageContract{current.Contract}, DeterministicApplicability: func(proposal contract.StageDispositionProposal, _ contract.StageContract) bool {
		return proposal.Disposition == contract.NotApplicable
	}})
	if err != nil {
		return ApproveResult{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	advanced, err := stageruntime.Advance(ctx, current, currentRef, "build-contract-approval-validator", "ST-06 Build & Converge is ready for Core preparation.", decidedAt)
	if err != nil {
		return ApproveResult{}, err
	}
	resolution, resolutionRef, err := humanapproval.Resolve(ctx, current.ProjectDir, current.Snapshot.RecordDir, proof, &approvalRef, "approved", decidedAt)
	if err != nil {
		return ApproveResult{}, err
	}
	return ApproveResult{Contract: build, Reference: buildRef, Current: pointer, CurrentReference: currentRef, Approval: approval, ApprovalReference: approvalRef, HumanGateResolution: resolution, HumanGateResolutionRef: resolutionRef, Plan: revised, State: advanced}, nil
}

type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	pending, candidate, err := PendingReview(projectDir, snapshot.RecordDir)
	if err == nil && candidate != nil {
		stageID := contract.Stage05
		result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Approval, Stage: &stageID, Reason: "Core validated the Build Contract candidate. A human must approve this exact SHA-256 or request revision.", Candidate: &pending.Candidate, Review: &pending.Review, Decisions: []string{"approve", "revise"}, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
		return result, result.Validate()
	}
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, "")
	if err != nil {
		return directive.Core{}, err
	}
	stageID := contract.Stage05
	result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Work, Stage: &stageID, Reason: "Core prepared the fixed ST-05 inputs; AI may propose the Build Contract and Bolt DAG but cannot approve or choose a route.", Request: &prepared.Reference, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
	return result, result.Validate()
}

func (value Proposal) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "build-contract-proposal" || value.Version != 1 || value.ProposedBy != "ai" || (value.Disposition != contract.Execute && value.Disposition != contract.Reuse && value.Disposition != contract.NotApplicable) {
		return fmt.Errorf("Build Contract Proposal has invalid identity, authority, or disposition")
	}
	if err := digest.Validate(value.WorkRequestSHA256); err != nil {
		return err
	}
	if value.RequirementAssessments == nil || value.ChangeContracts == nil || value.AcceptanceCriteria == nil || value.Verifiers == nil || value.Bolts == nil || value.Evidence == nil {
		return fmt.Errorf("Build Contract collection fields must be arrays")
	}
	switch value.Disposition {
	case contract.Execute:
		if len(value.ChangeContracts) == 0 || len(value.AcceptanceCriteria) == 0 || len(value.Verifiers) == 0 || len(value.Bolts) == 0 || value.IntegrationContract == nil || value.ReuseRef != nil {
			return fmt.Errorf("execute requires contracts, criteria, verifiers, bolts, integration contract, and no reuse_ref")
		}
	case contract.Reuse:
		if value.ReuseRef == nil || len(value.ChangeContracts)+len(value.AcceptanceCriteria)+len(value.Verifiers)+len(value.Bolts) != 0 || value.IntegrationContract != nil {
			return fmt.Errorf("reuse requires reuse_ref and no new build graph")
		}
	case contract.NotApplicable:
		if value.ReuseRef != nil || len(value.ChangeContracts)+len(value.AcceptanceCriteria)+len(value.Verifiers)+len(value.Bolts) != 0 || value.IntegrationContract != nil {
			return fmt.Errorf("not_applicable cannot contain build work")
		}
	}
	return stageruntime.OneLine(value.Reason, "Build Contract reason")
}

func validateAgainstRequest(projectDir string, request WorkRequest, proposal Proposal) ([][]string, error) {
	expected := set(request.RequirementIDs)
	assessed := map[string]Assessment{}
	for _, assessment := range proposal.RequirementAssessments {
		if !patterns["requirement"].MatchString(assessment.RequirementID) || strings.TrimSpace(assessment.Reason) == "" {
			return nil, fmt.Errorf("invalid requirement assessment: %s", assessment.RequirementID)
		}
		if _, exists := assessed[assessment.RequirementID]; exists {
			return nil, fmt.Errorf("duplicate requirement assessment: %s", assessment.RequirementID)
		}
		assessed[assessment.RequirementID] = assessment
	}
	for id := range expected {
		if _, exists := assessed[id]; !exists {
			return nil, fmt.Errorf("ST-05 Build Contract: requirement coverage is missing: %s", id)
		}
	}
	for id := range assessed {
		if _, exists := expected[id]; !exists {
			return nil, fmt.Errorf("unknown requirement assessment: %s", id)
		}
	}
	sources := map[string]string{}
	for _, source := range request.TargetSources {
		sources[source.SourceID] = source.Locator
	}
	validateTargets := func(targets []Target) error {
		seen := map[string]struct{}{}
		for _, target := range targets {
			root, exists := sources[target.SourceID]
			if !exists {
				return fmt.Errorf("target source is unknown: %s", target.SourceID)
			}
			if target.Path == "" || filepath.IsAbs(target.Path) || strings.Contains(target.Path, "\\") || strings.HasPrefix(filepath.Clean(target.Path), "..") || filepath.Clean(target.Path) != target.Path {
				return fmt.Errorf("target must stay inside repository boundary: %s/%s", root, target.Path)
			}
			key := target.SourceID + ":" + target.Path
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate target: %s", key)
			}
			seen[key] = struct{}{}
		}
		return nil
	}
	contracts := map[string]ChangeContract{}
	for _, item := range proposal.ChangeContracts {
		if !patterns["contract"].MatchString(item.ContractID) {
			return nil, fmt.Errorf("invalid contract ID: %s", item.ContractID)
		}
		if _, exists := contracts[item.ContractID]; exists {
			return nil, fmt.Errorf("duplicate contract ID: %s", item.ContractID)
		}
		if err := validateTargets(item.Targets); err != nil {
			return nil, err
		}
		if len(item.RequirementIDs) == 0 || len(item.Targets) == 0 || len(item.Specification) == 0 {
			return nil, fmt.Errorf("Build Change %s is incomplete", item.ContractID)
		}
		for _, id := range item.RequirementIDs {
			if _, exists := expected[id]; !exists {
				return nil, fmt.Errorf("Build Change %s references unknown requirement %s", item.ContractID, id)
			}
		}
		contracts[item.ContractID] = item
	}
	criteria := map[string]AcceptanceCriterion{}
	for _, item := range proposal.AcceptanceCriteria {
		if !patterns["criterion"].MatchString(item.CriterionID) {
			return nil, fmt.Errorf("invalid criterion ID: %s", item.CriterionID)
		}
		if _, exists := criteria[item.CriterionID]; exists {
			return nil, fmt.Errorf("duplicate criterion ID: %s", item.CriterionID)
		}
		if len(item.RequirementIDs) == 0 || len(item.VerifierIDs) == 0 || item.Given == "" || item.When == "" || item.Then == "" {
			return nil, fmt.Errorf("Acceptance Criterion %s is incomplete", item.CriterionID)
		}
		for _, id := range item.RequirementIDs {
			if _, exists := expected[id]; !exists {
				return nil, fmt.Errorf("Acceptance Criterion %s references unknown requirement %s", item.CriterionID, id)
			}
		}
		criteria[item.CriterionID] = item
	}
	verifiers := map[string]Verifier{}
	for _, item := range proposal.Verifiers {
		if !patterns["verifier"].MatchString(item.VerifierID) {
			return nil, fmt.Errorf("invalid verifier ID: %s", item.VerifierID)
		}
		if item.Kind == "command" && (len(item.Argv) == 0 || item.SourceID == nil || item.CWD == nil || len(item.ExpectedExitCodes) == 0) {
			return nil, fmt.Errorf("command verifier requires argv array, source_id, cwd, and expected exit codes")
		}
		if item.TimeoutMS <= 0 {
			return nil, fmt.Errorf("verifier timeout_ms must be positive")
		}
		if item.SourceID != nil {
			if _, exists := sources[*item.SourceID]; !exists {
				return nil, fmt.Errorf("verifier references unknown source_id: %s", *item.SourceID)
			}
		}
		if item.CWD != nil && *item.CWD != "." {
			if err := fsx.ValidateRelative(*item.CWD); err != nil {
				return nil, fmt.Errorf("verifier cwd: %w", err)
			}
		}
		if item.Kind != "command" && item.Kind != "runtime" && item.Kind != "artifact" && item.Kind != "human-at-st07" {
			return nil, fmt.Errorf("invalid verifier kind")
		}
		if _, exists := verifiers[item.VerifierID]; exists {
			return nil, fmt.Errorf("duplicate verifier ID: %s", item.VerifierID)
		}
		if item.Kind == "artifact" && (item.SourceID == nil || item.ArtifactCheck == nil) {
			return nil, fmt.Errorf("artifact verifier requires source_id and artifact_check")
		}
		if item.Kind == "artifact" && item.ArtifactCheck != nil {
			if err := fsx.ValidateRelative(item.ArtifactCheck.Path); err != nil {
				return nil, fmt.Errorf("artifact verifier path: %w", err)
			}
			if item.ArtifactCheck.Assertion != "exists" && item.ArtifactCheck.Assertion != "sha256-equals" && item.ArtifactCheck.Assertion != "content-includes" {
				return nil, fmt.Errorf("artifact verifier assertion is invalid")
			}
			if item.ArtifactCheck.Assertion != "exists" && item.ArtifactCheck.Expected == nil {
				return nil, fmt.Errorf("artifact verifier expected is required")
			}
		}
		if item.Kind == "runtime" && (item.SourceID == nil || item.RuntimeCheck == nil || len(item.RuntimeCheck.StartArgv) == 0) {
			return nil, fmt.Errorf("runtime verifier requires source_id and runtime_check")
		}
		if item.Kind == "runtime" && item.RuntimeCheck != nil {
			check := item.RuntimeCheck
			if !oneOf(check.Host, "127.0.0.1", "localhost", "::1") || check.Port < 1 || check.Port > 65535 || !strings.HasPrefix(check.Path, "/") || check.ExpectedStatus < 100 || check.ExpectedStatus > 599 || check.StartupTimeoutMS <= 0 {
				return nil, fmt.Errorf("runtime verifier check is unsafe or incomplete")
			}
		}
		if item.Kind == "human-at-st07" && item.Expected == "" {
			return nil, fmt.Errorf("human verifier requires expected")
		}
		verifiers[item.VerifierID] = item
	}
	bolts := map[string]Bolt{}
	for _, bolt := range proposal.Bolts {
		if !patterns["bolt"].MatchString(bolt.BoltID) {
			return nil, fmt.Errorf("invalid Bolt ID: %s", bolt.BoltID)
		}
		if contains(bolt.DependsOn, bolt.BoltID) {
			return nil, fmt.Errorf("Bolt %s cannot depend on itself", bolt.BoltID)
		}
		if _, exists := bolts[bolt.BoltID]; exists {
			return nil, fmt.Errorf("duplicate Bolt ID: %s", bolt.BoltID)
		}
		if len(bolt.ContractIDs) == 0 || len(bolt.AcceptanceCriterionIDs) == 0 || len(bolt.Targets) == 0 {
			return nil, fmt.Errorf("Bolt %s is incomplete", bolt.BoltID)
		}
		if err := validateTargets(bolt.Targets); err != nil {
			return nil, err
		}
		bolts[bolt.BoltID] = bolt
	}
	for _, contractItem := range contracts {
		for _, dependency := range contractItem.DependsOnContractIDs {
			if _, exists := contracts[dependency]; !exists {
				return nil, fmt.Errorf("Build Change depends on unknown Contract: %s", dependency)
			}
		}
	}
	referencedContracts := map[string]bool{}
	referencedCriteria := map[string]bool{}
	for _, bolt := range proposal.Bolts {
		for _, id := range bolt.ContractIDs {
			if _, exists := contracts[id]; !exists {
				return nil, fmt.Errorf("Bolt %s references unknown Contract %s", bolt.BoltID, id)
			}
			referencedContracts[id] = true
		}
		for _, id := range bolt.AcceptanceCriterionIDs {
			if _, exists := criteria[id]; !exists {
				return nil, fmt.Errorf("Bolt %s references unknown Criterion %s", bolt.BoltID, id)
			}
			referencedCriteria[id] = true
		}
	}
	for id := range contracts {
		if !referencedContracts[id] {
			return nil, fmt.Errorf("Build Change %s is not assigned to a Bolt", id)
		}
	}
	for id := range criteria {
		if !referencedCriteria[id] {
			return nil, fmt.Errorf("Acceptance Criterion %s is not assigned to a Bolt", id)
		}
	}
	for _, criterion := range criteria {
		for _, id := range criterion.VerifierIDs {
			if _, exists := verifiers[id]; !exists {
				return nil, fmt.Errorf("Criterion %s references unknown Verifier %s", criterion.CriterionID, id)
			}
		}
	}
	if proposal.Disposition == contract.Execute {
		if proposal.IntegrationContract == nil {
			return nil, fmt.Errorf("execute requires Integration Contract")
		}
		for _, id := range proposal.IntegrationContract.AcceptanceCriterionIDs {
			if _, exists := criteria[id]; !exists {
				return nil, fmt.Errorf("Integration Contract references unknown Criterion %s", id)
			}
		}
		for _, id := range proposal.IntegrationContract.VerifierIDs {
			if _, exists := verifiers[id]; !exists {
				return nil, fmt.Errorf("Integration Contract references unknown Verifier %s", id)
			}
		}
		if len(proposal.IntegrationContract.CandidateReadyWhen) == 0 {
			return nil, fmt.Errorf("Integration Contract requires candidate_ready_when")
		}
	}
	batches, err := deriveBatches(bolts)
	if err != nil {
		return nil, err
	}
	batchByBolt := map[string]int{}
	for index, batch := range batches {
		for _, id := range batch {
			batchByBolt[id] = index
		}
	}
	targets := map[string]string{}
	for _, bolt := range proposal.Bolts {
		for _, target := range bolt.Targets {
			key := target.SourceID + ":" + target.Path
			if previous, exists := targets[key]; exists && batchByBolt[previous] == batchByBolt[bolt.BoltID] {
				return nil, fmt.Errorf("parallel Bolts have conflicting target paths: %s", key)
			}
			targets[key] = bolt.BoltID
		}
	}
	for _, item := range contracts {
		for _, dependency := range item.DependsOnContractIDs {
			backed := false
			for _, bolt := range proposal.Bolts {
				if contains(bolt.ContractIDs, item.ContractID) {
					for _, depBolt := range proposal.Bolts {
						if contains(depBolt.ContractIDs, dependency) && dependsTransitively(bolts, bolt.BoltID, depBolt.BoltID, map[string]bool{}) {
							backed = true
						}
					}
				}
			}
			if !backed {
				return nil, fmt.Errorf("Build Change dependency %s->%s is not backed by the Bolt DAG", item.ContractID, dependency)
			}
		}
	}
	for _, reference := range proposal.Evidence {
		if _, err := stageruntime.ReadReference(projectDir, reference); err != nil {
			return nil, err
		}
	}
	if proposal.Disposition == contract.NotApplicable {
		for _, assessment := range proposal.RequirementAssessments {
			if assessment.BuildImpact {
				return nil, fmt.Errorf("not_applicable requires build_impact=false")
			}
		}
		for _, required := range []contract.ArtifactReference{request.RequirementsRef, request.ArchitectureCurrentRef} {
			if !containsRef(proposal.Evidence, required) {
				return nil, fmt.Errorf("not_applicable Evidence must pin %s", required.Artifact)
			}
		}
	}
	if proposal.Disposition == contract.Reuse {
		if !containsRef(proposal.Evidence, *proposal.ReuseRef) {
			return nil, fmt.Errorf("reuse Evidence must pin Build Contract")
		}
		if _, err := stageruntime.ReadReference(projectDir, *proposal.ReuseRef); err != nil {
			return nil, err
		}
	}
	return batches, nil
}

func deriveBatches(bolts map[string]Bolt) ([][]string, error) {
	remaining := map[string]Bolt{}
	for id, bolt := range bolts {
		remaining[id] = bolt
	}
	done := map[string]bool{}
	var batches [][]string
	for len(remaining) > 0 {
		batch := []string{}
		for id, bolt := range remaining {
			ready := true
			for _, dependency := range bolt.DependsOn {
				if _, exists := bolts[dependency]; !exists {
					return nil, fmt.Errorf("Bolt depends on unknown Bolt: %s", dependency)
				}
				if !done[dependency] {
					ready = false
				}
			}
			if ready {
				batch = append(batch, id)
			}
		}
		if len(batch) == 0 {
			return nil, fmt.Errorf("Bolt DAG contains a cycle")
		}
		sort.Strings(batch)
		batches = append(batches, batch)
		for _, id := range batch {
			delete(remaining, id)
			done[id] = true
		}
	}
	if batches == nil {
		batches = [][]string{}
	}
	return batches, nil
}
func dependsTransitively(bolts map[string]Bolt, from, target string, seen map[string]bool) bool {
	if seen[from] {
		return false
	}
	seen[from] = true
	for _, dependency := range bolts[from].DependsOn {
		if dependency == target || dependsTransitively(bolts, dependency, target, seen) {
			return true
		}
	}
	return false
}
func renderReview(candidate Candidate, reference contract.ArtifactReference, set gate.RequirementSet) (string, error) {
	targetCount := 0
	changeSection := explanationhtml.Section{
		Heading: "変更する内容",
		Lead:    "変更範囲と、実装時に守ることを確認します。",
	}
	for _, change := range candidate.ChangeContracts {
		card := explanationhtml.Card{Label: change.ContractID, Heading: change.Title}
		if len(change.RequirementIDs) > 0 {
			card.Facts = append(card.Facts, explanationhtml.Fact{Label: "対応する要件", Value: strings.Join(change.RequirementIDs, ", "), Code: true})
		}
		if len(change.DependsOnContractIDs) > 0 {
			card.Facts = append(card.Facts, explanationhtml.Fact{Label: "先に必要な変更", Value: strings.Join(change.DependsOnContractIDs, ", "), Code: true})
		}
		for _, target := range change.Targets {
			targetCount++
			card.Items = append(card.Items, explanationhtml.Item{Label: "変更対象", Text: target.SourceID + "/" + target.Path})
		}
		for _, specification := range change.Specification {
			card.Items = append(card.Items, explanationhtml.Item{Label: "実装条件", Text: specification})
		}
		changeSection.Cards = append(changeSection.Cards, card)
	}

	acceptanceSection := explanationhtml.Section{
		Heading: "完成と判断する条件",
		Lead:    "各条件について、前提・操作・期待結果を確認します。",
	}
	for _, criterion := range candidate.AcceptanceCriteria {
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

	verificationSection := explanationhtml.Section{
		Heading: "確認方法",
		Lead:    "実装後に、機械または人がどのように確認するかを示します。",
	}
	for _, verifier := range candidate.Verifiers {
		facts := []explanationhtml.Fact{
			{Label: "種類", Value: verifier.Kind},
			{Label: "作業場所", Value: stringValue(verifier.CWD), Code: true},
			{Label: "制限時間", Value: fmt.Sprintf("%dms", verifier.TimeoutMS)},
		}
		if len(verifier.Argv) > 0 {
			facts = append(facts, explanationhtml.Fact{Label: "コマンド", Value: strings.Join(verifier.Argv, " "), Pre: true})
		}
		if verifier.Expected != "" {
			facts = append(facts, explanationhtml.Fact{Label: "人が確認すること", Value: verifier.Expected})
		}
		verificationSection.Cards = append(verificationSection.Cards, explanationhtml.Card{
			Label:   verifier.VerifierID,
			Heading: verifier.Kind,
			Facts:   facts,
		})
	}

	sections := []explanationhtml.Section{
		{
			Heading: "まず確認すること",
			Lead:    "このBuild Contractは、実装を始める前の約束です。",
			Ordered: true,
			Items: []explanationhtml.Item{
				{Text: "変更対象が、今回の目的に必要な範囲だけになっているか。"},
				{Text: "完成と判断する条件が、実際に確認できる内容になっているか。"},
				{Text: "機械確認と人の確認が、目的に対して十分か。"},
			},
		},
	}
	if len(changeSection.Cards) > 0 {
		sections = append(sections, changeSection)
	}
	if len(acceptanceSection.Cards) > 0 {
		sections = append(sections, acceptanceSection)
	}
	if len(verificationSection.Cards) > 0 {
		sections = append(sections, verificationSection)
	}
	sections = append(sections, gate.ReviewSection(set))

	return explanationhtml.Render(explanationhtml.Page{
		Title:   "ST-05 Build Contract Review",
		Eyebrow: "AI-DLC / ST-05",
		Heading: "実装前の約束を確認",
		Lead:    candidate.Reason,
		Notice:  "変更範囲、完成条件、確認方法を読み、この内容で実装へ進めてよいかを人が判断します。",
		Metrics: []explanationhtml.Metric{
			{Label: "変更契約", Value: fmt.Sprint(len(candidate.ChangeContracts)) + "件", Help: "実装する変更のまとまり"},
			{Label: "変更対象", Value: fmt.Sprint(targetCount) + "件", Help: "ファイルまたは対象領域"},
			{Label: "受入条件", Value: fmt.Sprint(len(candidate.AcceptanceCriteria)) + "件", Help: "完成と判断する条件"},
			{Label: "確認方法", Value: fmt.Sprint(len(candidate.Verifiers)) + "件", Help: "機械確認と人の確認"},
		},
		Sections: sections,
		Footer: []explanationhtml.Fact{
			{Label: "Candidate SHA-256", Value: reference.SHA256, Code: true},
			{Label: "Proposal ID", Value: candidate.ProposalID, Code: true},
			{Label: "Intent", Value: candidate.IntentID, Code: true},
		},
	})
}
func requirementIDs(value st03requirements.Definition) []string {
	result := []string{}
	for _, group := range [][]st03requirements.Item{value.FunctionalRequirements, value.QualityRequirements, value.Constraints, value.Invariants} {
		for _, item := range group {
			result = append(result, item.ID)
		}
	}
	return result
}
func set(values []string) map[string]struct{} {
	result := map[string]struct{}{}
	for _, value := range values {
		result[value] = struct{}{}
	}
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
func oneOf(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}
func containsRef(values []contract.ArtifactReference, expected contract.ArtifactReference) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
func equalRefs(left, right *contract.ArtifactReference) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
func equalInts(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func ensureParent(projectDir, target string) error {
	relative, err := filepath.Rel(projectDir, filepath.Dir(target))
	if err != nil || strings.HasPrefix(relative, "..") {
		return fmt.Errorf("review path outside Project")
	}
	_, err = fsx.EnsureDirUnder(projectDir, filepath.ToSlash(relative), 0o755)
	return err
}
