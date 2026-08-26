// Package st02defineintent implements ST-02 Define Intent.
package st02defineintent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/state"
)

var stableID = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

// WorkRequest is the fixed Core input supplied to the product agent.
type WorkRequest struct {
	SchemaVersion      int                        `json:"schema_version"`
	Artifact           string                     `json:"artifact"`
	Version            int                        `json:"version"`
	IntentID           string                     `json:"intent_id"`
	StageID            contract.StageID           `json:"stage_id"`
	DesignBriefRef     contract.ArtifactReference `json:"design_brief_ref"`
	CurrentContextRef  contract.ArtifactReference `json:"current_context_ref"`
	EffectivePolicyRef contract.ArtifactReference `json:"effective_policy_ref"`
	RequestedOutputs   []string                   `json:"requested_outputs"`
	Rules              []string                   `json:"rules"`
	CreatedAt          string                     `json:"created_at"`
}

// Proposal is untrusted AI-authored Intent content.
type Proposal struct {
	SchemaVersion     int      `json:"schema_version"`
	Artifact          string   `json:"artifact"`
	Version           int      `json:"version"`
	ProposalID        string   `json:"proposal_id"`
	IntentID          string   `json:"intent_id"`
	WorkRequestSHA256 string   `json:"work_request_sha256"`
	Purpose           string   `json:"purpose"`
	ExpectedOutcomes  []string `json:"expected_outcomes"`
	InScope           []string `json:"in_scope"`
	OutOfScope        []string `json:"out_of_scope"`
	SuccessSignals    []string `json:"success_signals"`
	Unknowns          []string `json:"unknowns"`
	Reason            string   `json:"reason"`
	ProposedBy        string   `json:"proposed_by"`
}

// Definition is the immutable Core-owned ST-02 output.
type Definition struct {
	SchemaVersion      int                        `json:"schema_version"`
	Artifact           string                     `json:"artifact"`
	Version            int                        `json:"version"`
	IntentID           string                     `json:"intent_id"`
	ProposalID         string                     `json:"proposal_id"`
	DesignBriefRef     contract.ArtifactReference `json:"design_brief_ref"`
	CurrentContextRef  contract.ArtifactReference `json:"current_context_ref"`
	EffectivePolicyRef contract.ArtifactReference `json:"effective_policy_ref"`
	Purpose            string                     `json:"purpose"`
	ExpectedOutcomes   []string                   `json:"expected_outcomes"`
	InScope            []string                   `json:"in_scope"`
	OutOfScope         []string                   `json:"out_of_scope"`
	SuccessSignals     []string                   `json:"success_signals"`
	Unknowns           []string                   `json:"unknowns"`
	Reason             string                     `json:"reason"`
	CreatedAt          string                     `json:"created_at"`
}

// PrepareResult describes a newly prepared or reused Work Request.
type PrepareResult struct {
	Execution string                     `json:"execution"`
	Request   WorkRequest                `json:"request"`
	Reference contract.ArtifactReference `json:"reference"`
}

// CompleteResult describes the immutable Definition and advanced State.
type CompleteResult struct {
	Definition Definition                 `json:"definition"`
	Reference  contract.ArtifactReference `json:"reference"`
	State      state.IntentState          `json:"state"`
}

func WorkRequestPath(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "define-intent-work-request.json")
}

func DefinitionPath(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "intent-definition.json")
}

// Prepare binds Design Brief, Current Context, and Effective Policy.
func Prepare(ctx context.Context, projectDir, coreDir, preparedAt string) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage02)
	if err != nil {
		return PrepareResult{}, err
	}
	if current.Decision.Disposition == contract.NotApplicable {
		return PrepareResult{}, fmt.Errorf("ST-02 Define Intent: ST-02 cannot be not_applicable; every Intent needs a definition")
	}
	briefRef, err := existingReference(current.ProjectDir, filepath.Join(current.Snapshot.RecordDir, "artifacts", "design-brief.json"), "design-brief")
	if err != nil {
		return PrepareResult{}, fmt.Errorf("ST-02 Define Intent: Design Brief is required: %w", err)
	}
	contextRef, err := existingReference(current.ProjectDir, filepath.Join(current.Snapshot.RecordDir, "artifacts", "current-context.json"), "current-context")
	if err != nil {
		return PrepareResult{}, fmt.Errorf("ST-02 Define Intent: Current Context is required: %w", err)
	}
	path := WorkRequestPath(current.Snapshot.RecordDir)
	stored, reference, _, exists, err := stageruntime.ReadCanonicalIfExists[WorkRequest](current.ProjectDir, path, "define-intent-work-request", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if exists {
		if err := stored.Validate(); err == nil && stored.IntentID == current.Snapshot.State.IntentID && stored.DesignBriefRef == briefRef && stored.CurrentContextRef == contextRef && stored.EffectivePolicyRef == current.Snapshot.State.PolicySnapshot {
			if current.Snapshot.State.Status != state.Ready {
				if _, err := stageruntime.SetReady(ctx, current, stored.CreatedAt); err != nil {
					return PrepareResult{}, err
				}
			}
			return PrepareResult{Execution: "reused", Request: stored, Reference: reference}, nil
		}
	}
	if preparedAt == "" {
		preparedAt = stageruntime.Now()
	}
	request := WorkRequest{
		SchemaVersion: 1, Artifact: "define-intent-work-request", Version: 1,
		IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage02,
		DesignBriefRef: briefRef, CurrentContextRef: contextRef, EffectivePolicyRef: current.Snapshot.State.PolicySnapshot,
		RequestedOutputs: []string{"intent-definition-proposal"},
		Rules: []string{
			"Define only purpose, expected outcomes, scope, exclusions, success signals, and known unknowns.",
			"Do not add requirements detail, architecture decisions, build plans, implementation instructions, or routes.",
			"Keep small changes short and ask a human before proposing when a value judgment or priority choice is unresolved.",
			"AI proposes content only; Core validates, persists, and owns the fixed Stage transition.",
		},
		CreatedAt: preparedAt,
	}
	if err := request.Validate(); err != nil {
		return PrepareResult{}, err
	}
	reference, _, err = stageruntime.WriteCanonical(current.ProjectDir, path, request.Artifact, request.Version, request, false)
	if err != nil {
		return PrepareResult{}, err
	}
	if _, err := stageruntime.SetReady(ctx, current, preparedAt); err != nil {
		return PrepareResult{}, err
	}
	return PrepareResult{Execution: "prepared", Request: request, Reference: reference}, nil
}

// Complete validates one proposal, persists the immutable Definition, and advances.
func Complete(ctx context.Context, projectDir, coreDir string, proposalContent []byte, completedAt string) (CompleteResult, error) {
	prepared, err := Prepare(ctx, projectDir, coreDir, "")
	if err != nil {
		return CompleteResult{}, err
	}
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage02)
	if err != nil {
		return CompleteResult{}, err
	}
	proposal, err := stageruntime.DecodeProposal(proposalContent, func(value Proposal) error { return value.Validate() })
	if err != nil {
		return CompleteResult{}, fmt.Errorf("ST-02 Define Intent Proposal: %w", err)
	}
	if proposal.IntentID != current.Snapshot.State.IntentID {
		return CompleteResult{}, fmt.Errorf("ST-02 Define Intent: Proposal Intent does not match State")
	}
	if proposal.WorkRequestSHA256 != prepared.Reference.SHA256 {
		return CompleteResult{}, fmt.Errorf("ST-02 Define Intent: Proposal does not reference the current Define Intent Work Request")
	}
	if completedAt == "" {
		completedAt = stageruntime.Now()
	}
	definition := Definition{
		SchemaVersion: 1, Artifact: "intent-definition", Version: 1,
		IntentID: proposal.IntentID, ProposalID: proposal.ProposalID,
		DesignBriefRef: prepared.Request.DesignBriefRef, CurrentContextRef: prepared.Request.CurrentContextRef, EffectivePolicyRef: prepared.Request.EffectivePolicyRef,
		Purpose: proposal.Purpose, ExpectedOutcomes: proposal.ExpectedOutcomes, InScope: proposal.InScope, OutOfScope: proposal.OutOfScope,
		SuccessSignals: proposal.SuccessSignals, Unknowns: proposal.Unknowns, Reason: proposal.Reason, CreatedAt: completedAt,
	}
	if err := definition.Validate(); err != nil {
		return CompleteResult{}, err
	}
	path := DefinitionPath(current.Snapshot.RecordDir)
	reference, _, err := stageruntime.WriteCanonical(current.ProjectDir, path, definition.Artifact, definition.Version, definition, true)
	if err != nil {
		return CompleteResult{}, fmt.Errorf("ST-02 Define Intent: %w", err)
	}
	advanced, err := stageruntime.Advance(ctx, current, reference, "intent-definition-validator", "ST-03 Requirements & Constraints is ready for Core preparation.", completedAt)
	if err != nil {
		return CompleteResult{}, err
	}
	return CompleteResult{Definition: definition, Reference: reference, State: advanced}, nil
}

// Handler prepares the fixed ST-02 Work Directive.
type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, "")
	if err != nil {
		return directive.Core{}, err
	}
	stageID := contract.Stage02
	result := directive.Core{
		SchemaVersion: 1, Workflow: "vnext", Kind: directive.Work, Stage: &stageID,
		Reason:  "Core prepared the fixed ST-02 Define Intent inputs; AI may propose the bounded Intent Definition only.",
		Request: &prepared.Reference, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core",
	}
	return result, result.Validate()
}

func (value WorkRequest) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "define-intent-work-request" || value.Version != 1 || value.StageID != contract.Stage02 {
		return fmt.Errorf("Define Intent Work Request has an invalid schema identity")
	}
	if err := stageruntime.OneLine(value.IntentID, "Define Intent Work Request.intent_id"); err != nil {
		return err
	}
	for _, reference := range []contract.ArtifactReference{value.DesignBriefRef, value.CurrentContextRef, value.EffectivePolicyRef} {
		if err := reference.Validate(); err != nil {
			return err
		}
	}
	if !equalStrings(value.RequestedOutputs, []string{"intent-definition-proposal"}) || len(value.Rules) == 0 {
		return fmt.Errorf("Define Intent Work Request has invalid requested_outputs or rules")
	}
	if err := uniqueStrings(value.Rules, 1, "rules"); err != nil {
		return err
	}
	return stageruntime.Timestamp(value.CreatedAt, "Define Intent Work Request.created_at")
}

func (value Proposal) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "intent-definition-proposal" || value.Version != 1 || value.ProposedBy != "ai" {
		return fmt.Errorf("Intent Definition Proposal has an invalid schema identity or authority")
	}
	if !stableID.MatchString(value.ProposalID) {
		return fmt.Errorf("Intent Definition Proposal.proposal_id must be a stable lowercase identifier")
	}
	if err := stageruntime.OneLine(value.IntentID, "Intent Definition Proposal.intent_id"); err != nil {
		return err
	}
	if err := digest.Validate(value.WorkRequestSHA256); err != nil {
		return err
	}
	return validateDefinitionFields(value.Purpose, value.ExpectedOutcomes, value.InScope, value.OutOfScope, value.SuccessSignals, value.Unknowns, value.Reason)
}

func (value Definition) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "intent-definition" || value.Version != 1 || !stableID.MatchString(value.ProposalID) {
		return fmt.Errorf("Intent Definition has an invalid schema identity")
	}
	if err := stageruntime.OneLine(value.IntentID, "Intent Definition.intent_id"); err != nil {
		return err
	}
	for _, reference := range []contract.ArtifactReference{value.DesignBriefRef, value.CurrentContextRef, value.EffectivePolicyRef} {
		if err := reference.Validate(); err != nil {
			return err
		}
	}
	if err := validateDefinitionFields(value.Purpose, value.ExpectedOutcomes, value.InScope, value.OutOfScope, value.SuccessSignals, value.Unknowns, value.Reason); err != nil {
		return err
	}
	return stageruntime.Timestamp(value.CreatedAt, "Intent Definition.created_at")
}

func validateDefinitionFields(purpose string, outcomes, inScope, outScope, signals, unknowns []string, reason string) error {
	if err := stageruntime.OneLine(purpose, "purpose"); err != nil {
		return err
	}
	if err := stageruntime.OneLine(reason, "reason"); err != nil {
		return err
	}
	for label, values := range map[string][]string{"expected_outcomes": outcomes, "in_scope": inScope, "out_of_scope": outScope, "success_signals": signals, "unknowns": unknowns} {
		minimum := 0
		if label == "expected_outcomes" || label == "in_scope" || label == "success_signals" {
			minimum = 1
		}
		if err := uniqueStrings(values, minimum, label); err != nil {
			return err
		}
	}
	excluded := map[string]struct{}{}
	for _, item := range outScope {
		excluded[item] = struct{}{}
	}
	for _, item := range inScope {
		if _, exists := excluded[item]; exists {
			return fmt.Errorf("item appears in both in_scope and out_of_scope: %s", item)
		}
	}
	return nil
}

func uniqueStrings(values []string, minimum int, field string) error {
	if values == nil || len(values) < minimum {
		return fmt.Errorf("%s must contain at least %d item(s)", field, minimum)
	}
	seen := map[string]struct{}{}
	for _, value := range values {
		if err := stageruntime.OneLine(value, field); err != nil {
			return err
		}
		if _, exists := seen[value]; exists {
			return fmt.Errorf("%s contains duplicate value: %s", field, value)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func existingReference(projectDir, path, artifact string) (contract.ArtifactReference, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	if !json.Valid(content) || !strings.HasSuffix(string(content), "\n") {
		return contract.ArtifactReference{}, fmt.Errorf("Artifact is not canonical JSON: %s", path)
	}
	return stageruntime.Reference(projectDir, path, artifact, 1, content)
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

// DecodeWorkRequest is exported for compatibility fixtures.
func DecodeWorkRequest(content []byte) (WorkRequest, error) {
	value, err := jsonx.Decode[WorkRequest](content)
	if err != nil {
		return WorkRequest{}, err
	}
	return value, value.Validate()
}
