// Package st04architecture implements ST-04 Architecture Decision and its Policy gate.
package st04architecture

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st01orient"
	"github.com/sori883/aidlc/internal/stage/st03requirements"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/gate"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/state"
)

var requirementID = regexp.MustCompile(`^(?:REQ-[A-Z]+|CON|INV)-\d{3}$`)

type Assessment struct {
	RequirementID      string   `json:"requirement_id"`
	ArchitectureImpact bool     `json:"architecture_impact"`
	Reason             string   `json:"reason"`
	CurrentEntityRefs  []string `json:"current_entity_refs"`
}
type PlannedChange struct {
	ChangeID    string `json:"change_id"`
	Action      string `json:"action"`
	TargetKind  string `json:"target_kind"`
	TargetID    string `json:"target_id"`
	Description string `json:"description"`
}
type DecisionDraft struct {
	DecisionID        string          `json:"decision_id"`
	Title             string          `json:"title"`
	Context           string          `json:"context"`
	Decision          string          `json:"decision"`
	Rationale         string          `json:"rationale"`
	RequirementIDs    []string        `json:"requirement_ids"`
	CurrentEntityRefs []string        `json:"current_entity_refs"`
	PlannedChanges    []PlannedChange `json:"planned_changes"`
	Alternatives      []string        `json:"alternatives"`
	Consequences      []string        `json:"consequences"`
	Reversibility     string          `json:"reversibility"`
}
type WorkRequest struct {
	SchemaVersion          int                         `json:"schema_version"`
	Artifact               string                      `json:"artifact"`
	Version                int                         `json:"version"`
	IntentID               string                      `json:"intent_id"`
	StageID                contract.StageID            `json:"stage_id"`
	RequirementsCurrentRef contract.ArtifactReference  `json:"requirements_current_ref"`
	RequirementsRef        contract.ArtifactReference  `json:"requirements_ref"`
	CurrentContextRef      contract.ArtifactReference  `json:"current_context_ref"`
	SystemMapRef           contract.ArtifactReference  `json:"system_map_ref"`
	EffectivePolicyRef     contract.ArtifactReference  `json:"effective_policy_ref"`
	BaseRevision           *int                        `json:"base_revision"`
	BaseArchitectureRef    *contract.ArtifactReference `json:"base_architecture_ref"`
	RequirementIDs         []string                    `json:"requirement_ids"`
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
	Decisions              []DecisionDraft              `json:"decisions"`
	ReuseRef               *contract.ArtifactReference  `json:"reuse_ref"`
	ApprovalRef            *contract.ArtifactReference  `json:"approval_ref"`
	Evidence               []contract.ArtifactReference `json:"evidence"`
	Reason                 string                       `json:"reason"`
	ProposedBy             string                       `json:"proposed_by"`
}
type Decision struct {
	SchemaVersion          int                        `json:"schema_version"`
	Artifact               string                     `json:"artifact"`
	Version                int                        `json:"version"`
	IntentID               string                     `json:"intent_id"`
	Revision               int                        `json:"revision"`
	BaseRevision           *int                       `json:"base_revision"`
	ProposalID             string                     `json:"proposal_id"`
	RequirementsRef        contract.ArtifactReference `json:"requirements_ref"`
	CurrentContextRef      contract.ArtifactReference `json:"current_context_ref"`
	SystemMapRef           contract.ArtifactReference `json:"system_map_ref"`
	EffectivePolicyRef     contract.ArtifactReference `json:"effective_policy_ref"`
	RequirementAssessments []Assessment               `json:"requirement_assessments"`
	Decisions              []DecisionDraft            `json:"decisions"`
	Reason                 string                     `json:"reason"`
	CreatedAt              string                     `json:"created_at"`
}
type Current struct {
	SchemaVersion          int                          `json:"schema_version"`
	Artifact               string                       `json:"artifact"`
	Version                int                          `json:"version"`
	IntentID               string                       `json:"intent_id"`
	Disposition            contract.Disposition         `json:"disposition"`
	ArchitectureRef        *contract.ArtifactReference  `json:"architecture_ref"`
	RequirementsRef        contract.ArtifactReference   `json:"requirements_ref"`
	CurrentContextRef      contract.ArtifactReference   `json:"current_context_ref"`
	SystemMapRef           contract.ArtifactReference   `json:"system_map_ref"`
	EffectivePolicyRef     contract.ArtifactReference   `json:"effective_policy_ref"`
	RequirementAssessments []Assessment                 `json:"requirement_assessments"`
	Evidence               []contract.ArtifactReference `json:"evidence"`
	Reason                 string                       `json:"reason"`
	UpdatedAt              string                       `json:"updated_at"`
}
type PolicyApproval struct {
	SchemaVersion          int                        `json:"schema_version"`
	Artifact               string                     `json:"artifact"`
	Version                int                        `json:"version"`
	DecisionID             string                     `json:"decision_id"`
	IntentID               string                     `json:"intent_id"`
	ProposalRef            contract.ArtifactReference `json:"proposal_ref"`
	GateRequirementSetRef  contract.ArtifactReference `json:"gate_requirement_set_ref"`
	PolicyAcknowledgements []gate.Acknowledgement     `json:"policy_acknowledgements"`
	Decision               string                     `json:"decision"`
	Reason                 string                     `json:"reason"`
	DecidedBy              string                     `json:"decided_by"`
	DecidedAt              string                     `json:"decided_at"`
}

type PrepareResult struct {
	Execution string                     `json:"execution"`
	Request   WorkRequest                `json:"request"`
	Reference contract.ArtifactReference `json:"reference"`
}
type CompleteResult struct {
	Decision         *Decision                   `json:"decision"`
	Reference        *contract.ArtifactReference `json:"reference"`
	Current          Current                     `json:"current"`
	CurrentReference contract.ArtifactReference  `json:"currentReference"`
	Plan             contract.StageExecutionPlan `json:"plan"`
	State            state.IntentState           `json:"state"`
}
type PolicyReviewResult struct {
	RecordDir         string                     `json:"recordDir"`
	Proposal          Proposal                   `json:"proposal"`
	ProposalReference contract.ArtifactReference `json:"proposalReference"`
	Gate              gate.RequirementSet        `json:"gate"`
	GateReference     contract.ArtifactReference `json:"gateReference"`
	ReviewReference   contract.ArtifactReference `json:"reviewReference"`
	State             state.IntentState          `json:"state"`
}
type PolicyApproveResult struct {
	CompleteResult
	Approval          PolicyApproval             `json:"approval"`
	ApprovalReference contract.ArtifactReference `json:"approvalReference"`
}

func RootDir(recordDir string) string { return filepath.Join(recordDir, "artifacts", "architecture") }
func WorkRequestPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "work-request.json")
}
func CurrentPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "current.json") }
func RevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "architecture-decision.json")
}
func PolicyProposalPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "policy-review", "proposal.json")
}
func PolicyGateRefPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "policy-review", "gate-reference.json")
}
func PolicyReviewPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "policy-review", "review.html")
}
func PolicyApprovalPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "policy-review", "approval.json")
}

func Prepare(ctx context.Context, projectDir, coreDir, preparedAt string) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage04)
	if err != nil {
		return PrepareResult{}, err
	}
	requirementsCurrent, requirementsCurrentRef, _, err := stageruntime.ReadCanonical[st03requirements.Current](current.ProjectDir, st03requirements.CurrentPath(current.Snapshot.RecordDir), "requirements-current", 1)
	if err != nil {
		return PrepareResult{}, fmt.Errorf("ST-04 Architecture: Requirements Current is required: %w", err)
	}
	definition, requirementsRef, _, err := stageruntime.ReadCanonical[st03requirements.Definition](current.ProjectDir, filepath.FromSlash(filepath.Join(current.ProjectDir, requirementsCurrent.RequirementsRef.SourceOfTruth)), "requirements-definition", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	contextValue, contextRef, _, err := stageruntime.ReadCanonical[st01orient.CurrentContext](current.ProjectDir, st01orient.CurrentContextPath(current.Snapshot.RecordDir), "current-context", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	mapRef := contextValue.SystemMapRef
	if _, err := stageruntime.ReadReference(current.ProjectDir, mapRef); err != nil {
		return PrepareResult{}, err
	}
	ids := requirementIDs(definition)
	var baseRevision *int
	var baseRef *contract.ArtifactReference
	storedCurrent, _, _, currentExists, err := stageruntime.ReadCanonicalIfExists[Current](current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), "architecture-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if currentExists && storedCurrent.ArchitectureRef != nil {
		decisionPath, err := stageruntime.ReadReference(current.ProjectDir, *storedCurrent.ArchitectureRef)
		if err != nil {
			return PrepareResult{}, err
		}
		decision, _, _, err := stageruntime.ReadCanonical[Decision](current.ProjectDir, decisionPath, "architecture-decision", 1)
		if err != nil {
			return PrepareResult{}, err
		}
		baseRevision = &decision.Revision
		baseRef = storedCurrent.ArchitectureRef
	}
	path := WorkRequestPath(current.Snapshot.RecordDir)
	storedRequest, reference, _, requestExists, err := stageruntime.ReadCanonicalIfExists[WorkRequest](current.ProjectDir, path, "architecture-work-request", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if requestExists && storedRequest.IntentID == current.Snapshot.State.IntentID && storedRequest.RequirementsCurrentRef == requirementsCurrentRef && storedRequest.RequirementsRef == requirementsRef && storedRequest.CurrentContextRef == contextRef && storedRequest.SystemMapRef == mapRef && storedRequest.EffectivePolicyRef == current.Snapshot.State.PolicySnapshot && equalInts(storedRequest.BaseRevision, baseRevision) && equalRefs(storedRequest.BaseArchitectureRef, baseRef) && equalStrings(storedRequest.RequirementIDs, ids) {
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
	request := WorkRequest{SchemaVersion: 1, Artifact: "architecture-work-request", Version: 1, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage04, RequirementsCurrentRef: requirementsCurrentRef, RequirementsRef: requirementsRef, CurrentContextRef: contextRef, SystemMapRef: mapRef, EffectivePolicyRef: current.Snapshot.State.PolicySnapshot, BaseRevision: baseRevision, BaseArchitectureRef: baseRef, RequirementIDs: ids, RequestedOutputs: []string{"architecture-assessment-proposal"}, Rules: []string{"Assess every pinned requirement exactly once for system-structure impact.", "Use execute only when a new system-structure decision is needed; never mutate the current System Map.", "Use reuse only with an existing canonical Architecture Decision and a human approval.", "Use not_applicable only when pinned Requirements and System Map Evidence prove zero impact.", "Do not add implementation detail, credentials, or routes.", "AI proposes content only; Core validates, versions, persists, and owns routing."}, CreatedAt: preparedAt}
	reference, _, err = stageruntime.WriteCanonical(current.ProjectDir, path, request.Artifact, 1, request, false)
	if err != nil {
		return PrepareResult{}, err
	}
	if _, err := stageruntime.SetReady(ctx, current, preparedAt); err != nil {
		return PrepareResult{}, err
	}
	return PrepareResult{Execution: "prepared", Request: request, Reference: reference}, nil
}

func Complete(ctx context.Context, projectDir, coreDir string, proposalContent []byte, completedAt string) (CompleteResult, error) {
	prepared, err := Prepare(ctx, projectDir, coreDir, "")
	if err != nil {
		return CompleteResult{}, err
	}
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage04)
	if err != nil {
		return CompleteResult{}, err
	}
	proposal, err := stageruntime.DecodeProposal(proposalContent, func(value Proposal) error { return value.Validate() })
	if err != nil {
		return CompleteResult{}, fmt.Errorf("ST-04 Architecture Proposal: %w", err)
	}
	if proposal.IntentID != current.Snapshot.State.IntentID || proposal.WorkRequestSHA256 != prepared.Reference.SHA256 {
		return CompleteResult{}, fmt.Errorf("ST-04 Architecture: Proposal does not bind the active Intent and Work Request")
	}
	if err := validateAgainstRequest(current.ProjectDir, prepared.Request, proposal); err != nil {
		return CompleteResult{}, err
	}
	resolvedGate, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage04, prepared.Request.EffectivePolicyRef, completedAt)
	if err != nil {
		return CompleteResult{}, err
	}
	if err := validateGateApproval(current.ProjectDir, current.Snapshot.RecordDir, resolvedGate, proposal); err != nil {
		return CompleteResult{}, err
	}
	if completedAt == "" {
		completedAt = stageruntime.Now()
	}
	var decision *Decision
	var decisionRef *contract.ArtifactReference
	if proposal.Disposition == contract.Execute {
		revision := 1
		if prepared.Request.BaseRevision != nil {
			revision = *prepared.Request.BaseRevision + 1
		}
		candidate := Decision{SchemaVersion: 1, Artifact: "architecture-decision", Version: 1, IntentID: proposal.IntentID, Revision: revision, BaseRevision: prepared.Request.BaseRevision, ProposalID: proposal.ProposalID, RequirementsRef: prepared.Request.RequirementsRef, CurrentContextRef: prepared.Request.CurrentContextRef, SystemMapRef: prepared.Request.SystemMapRef, EffectivePolicyRef: prepared.Request.EffectivePolicyRef, RequirementAssessments: proposal.RequirementAssessments, Decisions: proposal.Decisions, Reason: proposal.Reason, CreatedAt: completedAt}
		reference, _, writeErr := stageruntime.WriteCanonical(current.ProjectDir, RevisionPath(current.Snapshot.RecordDir, revision), candidate.Artifact, 1, candidate, true)
		if writeErr != nil {
			return CompleteResult{}, writeErr
		}
		decision = &candidate
		decisionRef = &reference
	} else if proposal.Disposition == contract.Reuse {
		decisionRef = proposal.ReuseRef
	}
	pointer := Current{SchemaVersion: 1, Artifact: "architecture-current", Version: 1, IntentID: proposal.IntentID, Disposition: proposal.Disposition, ArchitectureRef: decisionRef, RequirementsRef: prepared.Request.RequirementsRef, CurrentContextRef: prepared.Request.CurrentContextRef, SystemMapRef: prepared.Request.SystemMapRef, EffectivePolicyRef: prepared.Request.EffectivePolicyRef, RequirementAssessments: proposal.RequirementAssessments, Evidence: proposal.Evidence, Reason: proposal.Reason, UpdatedAt: completedAt}
	currentRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), pointer.Artifact, 1, pointer, false)
	if err != nil {
		return CompleteResult{}, err
	}
	revisedPlan := current.Snapshot.Plan
	existing := decisionFor(revisedPlan, contract.Stage04)
	if existing.ProposalRef == nil || *existing.ProposalRef != proposal.ProposalID || existing.Disposition != proposal.Disposition {
		stageProposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: proposal.ProposalID, StageID: contract.Stage04, Disposition: proposal.Disposition, Reason: proposal.Reason, Evidence: proposal.Evidence, ProposedBy: contract.ProposerAI}
		revisedPlan, err = workflowplan.Revise(revisedPlan, []contract.StageDispositionProposal{stageProposal}, workflowplan.RevisionOptions{ProjectDir: current.ProjectDir, StageContracts: []contract.StageContract{current.Contract}, DeterministicApplicability: func(candidate contract.StageDispositionProposal, _ contract.StageContract) bool {
			return candidate.Disposition == contract.NotApplicable
		}})
		if err != nil {
			return CompleteResult{}, err
		}
		current.Snapshot.Plan = revisedPlan
		current.Snapshot.State.PlanRevision = revisedPlan.Revision
		if _, err := audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.PlanRevised, []audit.Field{{Name: "Plan Revision", Value: fmt.Sprint(revisedPlan.Revision)}, {Name: "Stage", Value: "ST-04"}, {Name: "Disposition", Value: string(proposal.Disposition)}, {Name: "Decision Authority", Value: "core"}}, nil); err != nil {
			return CompleteResult{}, err
		}
	}
	advanced, err := stageruntime.Advance(ctx, current, currentRef, "architecture-assessment-validator", "ST-05 Build Contract is ready for Core preparation.", completedAt)
	if err != nil {
		return CompleteResult{}, err
	}
	return CompleteResult{Decision: decision, Reference: decisionRef, Current: pointer, CurrentReference: currentRef, Plan: revisedPlan, State: advanced}, nil
}

func ReviewPolicy(ctx context.Context, projectDir, coreDir string, proposalContent []byte, reviewedAt string) (PolicyReviewResult, error) {
	prepared, err := Prepare(ctx, projectDir, coreDir, "")
	if err != nil {
		return PolicyReviewResult{}, err
	}
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage04)
	if err != nil {
		return PolicyReviewResult{}, err
	}
	proposal, err := stageruntime.DecodeProposal(proposalContent, func(value Proposal) error { return value.Validate() })
	if err != nil {
		return PolicyReviewResult{}, err
	}
	if proposal.WorkRequestSHA256 != prepared.Reference.SHA256 || proposal.IntentID != current.Snapshot.State.IntentID {
		return PolicyReviewResult{}, fmt.Errorf("ST-04 Architecture: Proposal does not bind current work")
	}
	if err := validateAgainstRequest(current.ProjectDir, prepared.Request, proposal); err != nil {
		return PolicyReviewResult{}, err
	}
	if reviewedAt == "" {
		reviewedAt = stageruntime.Now()
	}
	resolved, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage04, prepared.Request.EffectivePolicyRef, reviewedAt)
	if err != nil {
		return PolicyReviewResult{}, err
	}
	if len(resolved.Set.Requirements) == 0 {
		return PolicyReviewResult{}, fmt.Errorf("ST-04 Architecture: no Policy approval is required; run architecture complete")
	}
	proposalRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, PolicyProposalPath(current.Snapshot.RecordDir), "architecture-assessment-proposal", 1, proposal, false)
	if err != nil {
		return PolicyReviewResult{}, err
	}
	if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, PolicyGateRefPath(current.Snapshot.RecordDir), resolved.Reference.Artifact, resolved.Reference.Version, resolved.Reference, false); err != nil {
		return PolicyReviewResult{}, err
	}
	html, err := gate.RenderReviewHTML(resolved.Set, fmt.Sprintf("Architecture Proposal %s (%s)", proposal.ProposalID, proposalRef.SHA256))
	if err != nil {
		return PolicyReviewResult{}, err
	}
	if err := ensureTextParent(current.ProjectDir, PolicyReviewPath(current.Snapshot.RecordDir)); err != nil {
		return PolicyReviewResult{}, err
	}
	if err := fsx.AtomicWriteFile(PolicyReviewPath(current.Snapshot.RecordDir), []byte(html), 0o644); err != nil {
		return PolicyReviewResult{}, err
	}
	reviewRef, err := stageruntime.Reference(current.ProjectDir, PolicyReviewPath(current.Snapshot.RecordDir), "architecture-policy-review", 1, []byte(html))
	if err != nil {
		return PolicyReviewResult{}, err
	}
	parked, err := stageruntime.Park(ctx, current, "ST-04 Architecture Proposal is awaiting Policy approval.", reviewedAt)
	if err != nil {
		return PolicyReviewResult{}, err
	}
	_, _ = audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.StageAwaitingApproval, []audit.Field{{Name: "Stage", Value: "ST-04"}, {Name: "Proposal SHA-256", Value: proposalRef.SHA256}, {Name: "Gate Requirement Set", Value: resolved.Reference.SourceOfTruth}, {Name: "Decision Authority", Value: "human"}}, nil)
	return PolicyReviewResult{RecordDir: current.Snapshot.RecordDir, Proposal: proposal, ProposalReference: proposalRef, Gate: resolved.Set, GateReference: resolved.Reference, ReviewReference: reviewRef, State: parked}, nil
}

func ApprovePolicy(ctx context.Context, projectDir, coreDir, proposalSHA, reason string, acks []gate.Acknowledgement, decidedAt string) (PolicyApproveResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage04)
	if err != nil {
		return PolicyApproveResult{}, err
	}
	proposal, proposalRef, _, err := stageruntime.ReadCanonical[Proposal](current.ProjectDir, PolicyProposalPath(current.Snapshot.RecordDir), "architecture-assessment-proposal", 1)
	if err != nil {
		return PolicyApproveResult{}, fmt.Errorf("ST-04 Architecture: Policy review Proposal is missing")
	}
	if proposalRef.SHA256 != proposalSHA {
		return PolicyApproveResult{}, fmt.Errorf("ST-04 Architecture: human approval does not match the reviewed Proposal SHA-256")
	}
	gateRef, _, _, err := stageruntime.ReadCanonical[contract.ArtifactReference](current.ProjectDir, PolicyGateRefPath(current.Snapshot.RecordDir), "human-gate-requirements", 1)
	if err != nil {
		return PolicyApproveResult{}, err
	}
	gatePath, err := stageruntime.ReadReference(current.ProjectDir, gateRef)
	if err != nil {
		return PolicyApproveResult{}, err
	}
	set, _, _, err := stageruntime.ReadCanonical[gate.RequirementSet](current.ProjectDir, gatePath, "human-gate-requirements", 1)
	if err != nil {
		return PolicyApproveResult{}, err
	}
	if err := gate.ValidateAcknowledgements(current.ProjectDir, current.Snapshot.RecordDir, set, acks, true); err != nil {
		return PolicyApproveResult{}, err
	}
	if decidedAt == "" {
		decidedAt = stageruntime.Now()
	}
	if acks == nil {
		acks = []gate.Acknowledgement{}
	}
	approval := PolicyApproval{SchemaVersion: 1, Artifact: "architecture-policy-approval", Version: 1, DecisionID: "architecture-policy-" + proposalRef.SHA256[7:19], IntentID: current.Snapshot.State.IntentID, ProposalRef: proposalRef, GateRequirementSetRef: gateRef, PolicyAcknowledgements: acks, Decision: "approve-architecture-policy", Reason: reason, DecidedBy: "human", DecidedAt: decidedAt}
	approvalRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, PolicyApprovalPath(current.Snapshot.RecordDir), approval.Artifact, 1, approval, true)
	if err != nil {
		return PolicyApproveResult{}, err
	}
	proposal.Evidence = append(proposal.Evidence, approvalRef)
	content, _ := json.Marshal(proposal)
	completed, err := Complete(ctx, current.ProjectDir, coreDir, content, decidedAt)
	if err != nil {
		return PolicyApproveResult{}, err
	}
	_, _ = audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.GateApproved, []audit.Field{{Name: "Stage", Value: "ST-04"}, {Name: "Decision Authority", Value: "human"}}, nil)
	return PolicyApproveResult{CompleteResult: completed, Approval: approval, ApprovalReference: approvalRef}, nil
}

type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, "")
	if err != nil {
		return directive.Core{}, err
	}
	stageID := contract.Stage04
	result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Work, Stage: &stageID, Reason: "Core prepared the fixed ST-04 Architecture inputs; AI may propose execute, reuse, or a verifiable not_applicable assessment only.", Request: &prepared.Reference, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
	return result, result.Validate()
}

func (value Proposal) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "architecture-assessment-proposal" || value.Version != 1 || value.ProposedBy != "ai" || (value.Disposition != contract.Execute && value.Disposition != contract.Reuse && value.Disposition != contract.NotApplicable) {
		return fmt.Errorf("Architecture Proposal has an invalid schema identity, authority, or disposition")
	}
	if err := stageruntime.OneLine(value.ProposalID, "proposal_id"); err != nil {
		return err
	}
	if err := digest.Validate(value.WorkRequestSHA256); err != nil {
		return err
	}
	if len(value.RequirementAssessments) == 0 {
		return fmt.Errorf("Architecture Proposal requires assessments")
	}
	seen := map[string]struct{}{}
	for _, assessment := range value.RequirementAssessments {
		if !requirementID.MatchString(assessment.RequirementID) {
			return fmt.Errorf("invalid requirement_id: %s", assessment.RequirementID)
		}
		if _, exists := seen[assessment.RequirementID]; exists {
			return fmt.Errorf("duplicate requirement ID: %s", assessment.RequirementID)
		}
		seen[assessment.RequirementID] = struct{}{}
		if err := stageruntime.OneLine(assessment.Reason, "assessment reason"); err != nil {
			return err
		}
	}
	switch value.Disposition {
	case contract.Execute:
		if len(value.Decisions) == 0 || value.ReuseRef != nil {
			return fmt.Errorf("execute requires decisions and cannot contain reuse_ref")
		}
	case contract.Reuse:
		if len(value.Decisions) != 0 || value.ReuseRef == nil || value.ApprovalRef == nil {
			return fmt.Errorf("reuse requires reuse_ref and approval_ref only")
		}
	case contract.NotApplicable:
		if len(value.Decisions) != 0 || value.ReuseRef != nil || value.ApprovalRef != nil {
			return fmt.Errorf("not_applicable cannot contain decisions or reuse/approval refs")
		}
	}
	for _, decision := range value.Decisions {
		if !regexp.MustCompile(`^ADR-\d{3}$`).MatchString(decision.DecisionID) || len(decision.PlannedChanges) == 0 || len(decision.RequirementIDs) == 0 || len(decision.Alternatives) == 0 || len(decision.Consequences) == 0 {
			return fmt.Errorf("Architecture Decision Draft is incomplete")
		}
		if decision.Reversibility != "easy" && decision.Reversibility != "moderate" && decision.Reversibility != "hard" {
			return fmt.Errorf("Architecture Decision reversibility is invalid")
		}
	}
	return stageruntime.OneLine(value.Reason, "proposal reason")
}

func validateAgainstRequest(projectDir string, request WorkRequest, proposal Proposal) error {
	expected := map[string]struct{}{}
	for _, id := range request.RequirementIDs {
		expected[id] = struct{}{}
	}
	actual := map[string]Assessment{}
	for _, assessment := range proposal.RequirementAssessments {
		actual[assessment.RequirementID] = assessment
	}
	for id := range expected {
		if _, exists := actual[id]; !exists {
			return fmt.Errorf("ST-04 Architecture: requirement coverage is missing: %s", id)
		}
	}
	for id := range actual {
		if _, exists := expected[id]; !exists {
			return fmt.Errorf("ST-04 Architecture: assessment references an unknown requirement: %s", id)
		}
	}
	for _, reference := range proposal.Evidence {
		if _, err := stageruntime.ReadReference(projectDir, reference); err != nil {
			return err
		}
	}
	if proposal.Disposition == contract.Execute {
		impacted := map[string]struct{}{}
		for _, assessment := range proposal.RequirementAssessments {
			if assessment.ArchitectureImpact {
				impacted[assessment.RequirementID] = struct{}{}
			}
		}
		if len(impacted) == 0 {
			return fmt.Errorf("ST-04 Architecture: execute requires at least one architecture-impact requirement")
		}
		covered := map[string]struct{}{}
		for _, decision := range proposal.Decisions {
			for _, id := range decision.RequirementIDs {
				covered[id] = struct{}{}
			}
			if decision.Reversibility == "hard" && proposal.ApprovalRef == nil {
				return fmt.Errorf("ST-04 Architecture: hard-to-reverse decision requires a human-decision approval_ref")
			}
		}
		for id := range impacted {
			if _, exists := covered[id]; !exists {
				return fmt.Errorf("ST-04 Architecture: impacted requirement lacks a decision: %s", id)
			}
		}
	} else if proposal.Disposition == contract.NotApplicable {
		for _, assessment := range proposal.RequirementAssessments {
			if assessment.ArchitectureImpact {
				return fmt.Errorf("ST-04 Architecture: not_applicable requires architecture_impact=false for %s", assessment.RequirementID)
			}
		}
		for _, required := range []contract.ArtifactReference{request.RequirementsRef, request.SystemMapRef} {
			if !containsRef(proposal.Evidence, required) {
				return fmt.Errorf("ST-04 Architecture: not_applicable Evidence must pin %s", required.Artifact)
			}
		}
	} else {
		if !containsRef(proposal.Evidence, *proposal.ReuseRef) || !containsRef(proposal.Evidence, *proposal.ApprovalRef) {
			return fmt.Errorf("ST-04 Architecture: reuse Evidence must include decision and approval")
		}
		for _, reference := range []contract.ArtifactReference{*proposal.ReuseRef, *proposal.ApprovalRef} {
			if _, err := stageruntime.ReadReference(projectDir, reference); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateGateApproval(projectDir, recordDir string, resolved gate.Resolved, proposal Proposal) error {
	approvalRefs := []contract.ArtifactReference{}
	for _, reference := range proposal.Evidence {
		if reference.Artifact == "architecture-policy-approval" {
			approvalRefs = append(approvalRefs, reference)
		}
	}
	if len(resolved.Set.Requirements) == 0 {
		if len(approvalRefs) != 0 {
			return fmt.Errorf("ST-04 Architecture: Policy approval Evidence is not allowed when the Gate is empty")
		}
		return nil
	}
	if len(approvalRefs) != 1 {
		return fmt.Errorf("ST-04 Architecture: Policy approval is required; run architecture policy-review")
	}
	path, err := stageruntime.ReadReference(projectDir, approvalRefs[0])
	if err != nil {
		return err
	}
	approval, _, _, err := stageruntime.ReadCanonical[PolicyApproval](projectDir, path, "architecture-policy-approval", 1)
	if err != nil {
		return err
	}
	if approval.GateRequirementSetRef != resolved.Reference {
		return fmt.Errorf("ST-04 Architecture: Policy approval is bound to a stale Gate")
	}
	return gate.ValidateAcknowledgements(projectDir, recordDir, resolved.Set, approval.PolicyAcknowledgements, true)
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
func decisionFor(plan contract.StageExecutionPlan, id contract.StageID) contract.CoreStageDecision {
	for _, decision := range plan.StageDecisions {
		if decision.StageID == id {
			return decision
		}
	}
	return contract.CoreStageDecision{}
}
func containsRef(values []contract.ArtifactReference, expected contract.ArtifactReference) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
func equalInts(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
func equalRefs(left, right *contract.ArtifactReference) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
func ensureTextParent(projectDir, target string) error {
	relative, err := filepath.Rel(projectDir, filepath.Dir(target))
	if err != nil || relative == "." || strings.HasPrefix(relative, "..") {
		return fmt.Errorf("path outside Project")
	}
	_, err = fsx.EnsureDirUnder(projectDir, filepath.ToSlash(relative), 0o755)
	return err
}
