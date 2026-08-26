package contract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/jsonx"
)

// SchemaVersion is the common vNext contract schema.
const SchemaVersion = 1

var artifactNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// Disposition is a Core-controlled Stage work-depth decision.
type Disposition string

const (
	Execute       Disposition = "execute"
	Reuse         Disposition = "reuse"
	NotApplicable Disposition = "not_applicable"
)

// Proposer identifies an untrusted proposal source.
type Proposer string

const (
	ProposerAI    Proposer = "ai"
	ProposerHuman Proposer = "human"
	ProposerCore  Proposer = "core"
)

// HumanDecisionKind declares an irreducible human judgment.
type HumanDecisionKind string

const (
	ValueJudgment    HumanDecisionKind = "value_judgment"
	Exception        HumanDecisionKind = "exception"
	Approval         HumanDecisionKind = "approval"
	ReleaseAuthority HumanDecisionKind = "release_authority"
)

// ArtifactRequirement declares one Stage input.
type ArtifactRequirement struct {
	Artifact string `json:"artifact"`
	Required bool   `json:"required"`
}

// StageContract is the immutable contract for one fixed Stage.
type StageContract struct {
	SchemaVersion      int                   `json:"schema_version"`
	StageID            StageID               `json:"stage_id"`
	Name               string                `json:"name"`
	Purpose            string                `json:"purpose"`
	Inputs             []ArtifactRequirement `json:"inputs"`
	Outputs            []string              `json:"outputs"`
	CompletionCriteria []string              `json:"completion_criteria"`
	StopConditions     []string              `json:"stop_conditions"`
	HumanDecisions     []HumanDecisionKind   `json:"human_decisions"`
	Verifiers          []string              `json:"verifiers"`
}

// ArtifactReference pins raw bytes at a portable source of truth.
type ArtifactReference struct {
	Artifact      string `json:"artifact"`
	Version       int    `json:"version"`
	SourceOfTruth string `json:"source_of_truth"`
	SHA256        string `json:"sha256"`
}

// StageDispositionProposal is untrusted and cannot carry route authority.
type StageDispositionProposal struct {
	SchemaVersion int                 `json:"schema_version"`
	ProposalID    string              `json:"proposal_id"`
	StageID       StageID             `json:"stage_id"`
	Disposition   Disposition         `json:"disposition"`
	Reason        string              `json:"reason"`
	Evidence      []ArtifactReference `json:"evidence"`
	ProposedBy    Proposer            `json:"proposed_by"`
}

// CoreStageDecision is the only persisted Stage decision shape.
type CoreStageDecision struct {
	SchemaVersion     int                 `json:"schema_version"`
	DecisionID        string              `json:"decision_id"`
	StageID           StageID             `json:"stage_id"`
	Disposition       Disposition         `json:"disposition"`
	Reason            string              `json:"reason"`
	Evidence          []ArtifactReference `json:"evidence"`
	DecisionAuthority string              `json:"decision_authority"`
	ProposalRef       *string             `json:"proposal_ref,omitempty"`
}

// StageExecutionPlan fixes one Core decision for every Stage.
type StageExecutionPlan struct {
	SchemaVersion  int                 `json:"schema_version"`
	IntentID       string              `json:"intent_id"`
	Revision       int                 `json:"revision"`
	GraphVersion   string              `json:"graph_version"`
	PolicySnapshot ArtifactReference   `json:"policy_snapshot"`
	StageDecisions []CoreStageDecision `json:"stage_decisions"`
}

// DecodeStageContract strictly decodes and validates a Stage contract.
func DecodeStageContract(content []byte) (StageContract, error) {
	value, err := jsonx.Decode[StageContract](content)
	if err != nil {
		return StageContract{}, err
	}
	if err := value.Validate(); err != nil {
		return StageContract{}, err
	}
	return value, nil
}

// DecodeStageDispositionProposal strictly decodes an untrusted proposal.
func DecodeStageDispositionProposal(content []byte) (StageDispositionProposal, error) {
	value, err := jsonx.Decode[StageDispositionProposal](content)
	if err != nil {
		return StageDispositionProposal{}, err
	}
	if err := value.Validate(); err != nil {
		return StageDispositionProposal{}, err
	}
	return value, nil
}

// DecodeStageExecutionPlan strictly decodes a complete Core Plan.
func DecodeStageExecutionPlan(content []byte) (StageExecutionPlan, error) {
	var raw struct {
		StageDecisions []map[string]json.RawMessage `json:"stage_decisions"`
	}
	if err := json.Unmarshal(content, &raw); err != nil {
		return StageExecutionPlan{}, err
	}
	for index, decision := range raw.StageDecisions {
		if proposalRef, exists := decision["proposal_ref"]; exists && bytes.Equal(bytes.TrimSpace(proposalRef), []byte("null")) {
			return StageExecutionPlan{}, fmt.Errorf("Stage Execution Plan.stage_decisions[%d].proposal_ref must not be null", index)
		}
	}
	value, err := jsonx.Decode[StageExecutionPlan](content)
	if err != nil {
		return StageExecutionPlan{}, err
	}
	if err := value.Validate(); err != nil {
		return StageExecutionPlan{}, err
	}
	return value, nil
}

// Validate enforces the complete common Stage contract.
func (value StageContract) Validate() error {
	if value.SchemaVersion != SchemaVersion {
		return fmt.Errorf("Stage Contract.schema_version must equal %d", SchemaVersion)
	}
	if !value.StageID.Valid() {
		return fmt.Errorf("Stage Contract.stage_id %w", stageIDError(value.StageID))
	}
	if err := oneLine(value.Name, "Stage Contract.name"); err != nil {
		return err
	}
	if err := oneLine(value.Purpose, "Stage Contract.purpose"); err != nil {
		return err
	}
	if value.Inputs == nil {
		return fmt.Errorf("Stage Contract.inputs must be an array")
	}
	seenInputs := make(map[string]struct{}, len(value.Inputs))
	for index, input := range value.Inputs {
		if !artifactNamePattern.MatchString(input.Artifact) {
			return fmt.Errorf("Stage Contract.inputs[%d].artifact must use lowercase kebab-case", index)
		}
		if _, exists := seenInputs[input.Artifact]; exists {
			return fmt.Errorf("Stage Contract.inputs contains duplicate artifact: %s", input.Artifact)
		}
		seenInputs[input.Artifact] = struct{}{}
	}
	if err := uniqueNames(value.Outputs, 0, artifactNamePattern, "Stage Contract.outputs"); err != nil {
		return err
	}
	if err := uniqueNames(value.CompletionCriteria, 1, nil, "Stage Contract.completion_criteria"); err != nil {
		return err
	}
	if err := uniqueNames(value.StopConditions, 1, nil, "Stage Contract.stop_conditions"); err != nil {
		return err
	}
	if value.HumanDecisions == nil {
		return fmt.Errorf("Stage Contract.human_decisions must be an array")
	}
	seenDecisions := make(map[HumanDecisionKind]struct{}, len(value.HumanDecisions))
	for index, decision := range value.HumanDecisions {
		if !decision.valid() {
			return fmt.Errorf("Stage Contract.human_decisions[%d] has an invalid value", index)
		}
		if _, exists := seenDecisions[decision]; exists {
			return fmt.Errorf("Stage Contract.human_decisions contains duplicate value: %s", decision)
		}
		seenDecisions[decision] = struct{}{}
	}
	return uniqueNames(value.Verifiers, 1, nil, "Stage Contract.verifiers")
}

// Validate enforces an Artifact reference without reading it.
func (value ArtifactReference) Validate() error {
	if !artifactNamePattern.MatchString(value.Artifact) {
		return fmt.Errorf("Artifact reference.artifact must use lowercase kebab-case")
	}
	if value.Version < 1 {
		return fmt.Errorf("Artifact reference.version must be a positive integer")
	}
	if err := oneLine(value.SourceOfTruth, "Artifact reference.source_of_truth"); err != nil {
		return err
	}
	if err := digest.Validate(value.SHA256); err != nil {
		return fmt.Errorf("Artifact reference.sha256 %w", err)
	}
	return nil
}

// Validate enforces an untrusted disposition proposal.
func (value StageDispositionProposal) Validate() error {
	if value.SchemaVersion != SchemaVersion {
		return fmt.Errorf("Stage disposition proposal.schema_version must equal %d", SchemaVersion)
	}
	if err := oneLine(value.ProposalID, "Stage disposition proposal.proposal_id"); err != nil {
		return err
	}
	if !value.StageID.Valid() {
		return fmt.Errorf("Stage disposition proposal.stage_id %w", stageIDError(value.StageID))
	}
	if !value.Disposition.valid() {
		return fmt.Errorf("Stage disposition proposal.disposition has an invalid value")
	}
	if err := oneLine(value.Reason, "Stage disposition proposal.reason"); err != nil {
		return err
	}
	if err := validateEvidence(value.Evidence, "Stage disposition proposal.evidence"); err != nil {
		return err
	}
	if value.Disposition != Execute && len(value.Evidence) == 0 {
		return fmt.Errorf("Stage disposition proposal.evidence %s requires at least one evidence reference", value.Disposition)
	}
	if !value.ProposedBy.valid() {
		return fmt.Errorf("Stage disposition proposal.proposed_by has an invalid value")
	}
	return nil
}

// Validate enforces Core-only persisted authority.
func (value CoreStageDecision) Validate() error {
	if value.SchemaVersion != SchemaVersion {
		return fmt.Errorf("Core Stage decision.schema_version must equal %d", SchemaVersion)
	}
	if err := oneLine(value.DecisionID, "Core Stage decision.decision_id"); err != nil {
		return err
	}
	if !value.StageID.Valid() {
		return fmt.Errorf("Core Stage decision.stage_id %w", stageIDError(value.StageID))
	}
	if !value.Disposition.valid() {
		return fmt.Errorf("Core Stage decision.disposition has an invalid value")
	}
	if err := oneLine(value.Reason, "Core Stage decision.reason"); err != nil {
		return err
	}
	if err := validateEvidence(value.Evidence, "Core Stage decision.evidence"); err != nil {
		return err
	}
	if value.Disposition != Execute && len(value.Evidence) == 0 {
		return fmt.Errorf("Core Stage decision.evidence %s requires at least one evidence reference", value.Disposition)
	}
	if value.DecisionAuthority != "core" {
		return fmt.Errorf("Core Stage decision.decision_authority must equal core")
	}
	if value.ProposalRef != nil {
		if err := oneLine(*value.ProposalRef, "Core Stage decision.proposal_ref"); err != nil {
			return err
		}
	}
	return nil
}

// Validate enforces fixed ten-Stage coverage and order.
func (value StageExecutionPlan) Validate() error {
	if value.SchemaVersion != SchemaVersion {
		return fmt.Errorf("Stage Execution Plan.schema_version must equal %d", SchemaVersion)
	}
	if err := oneLine(value.IntentID, "Stage Execution Plan.intent_id"); err != nil {
		return err
	}
	if value.Revision < 1 {
		return fmt.Errorf("Stage Execution Plan.revision must be a positive integer")
	}
	if err := oneLine(value.GraphVersion, "Stage Execution Plan.graph_version"); err != nil {
		return err
	}
	if err := value.PolicySnapshot.Validate(); err != nil {
		return fmt.Errorf("Stage Execution Plan.policy_snapshot: %w", err)
	}
	if len(value.StageDecisions) != len(OrderedStageIDs) {
		return fmt.Errorf("Stage Execution Plan.stage_decisions must contain exactly %d decisions", len(OrderedStageIDs))
	}
	seen := make(map[string]struct{}, len(value.StageDecisions))
	for index, decision := range value.StageDecisions {
		if err := decision.Validate(); err != nil {
			return fmt.Errorf("Stage Execution Plan.stage_decisions[%d]: %w", index, err)
		}
		if decision.StageID != OrderedStageIDs[index] {
			return fmt.Errorf("Stage Execution Plan.stage_decisions[%d].stage_id must equal %s; fixed Stage order cannot be changed", index, OrderedStageIDs[index])
		}
		if _, exists := seen[decision.DecisionID]; exists {
			return fmt.Errorf("Stage Execution Plan.stage_decisions contains duplicate decision_id: %s", decision.DecisionID)
		}
		seen[decision.DecisionID] = struct{}{}
	}
	return nil
}

func (value Disposition) valid() bool {
	return value == Execute || value == Reuse || value == NotApplicable
}
func (value Proposer) valid() bool {
	return value == ProposerAI || value == ProposerHuman || value == ProposerCore
}
func (value HumanDecisionKind) valid() bool {
	return value == ValueJudgment || value == Exception || value == Approval || value == ReleaseAuthority
}

func oneLine(value, context string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s must be a non-empty single-line string", context)
	}
	return nil
}

func uniqueNames(values []string, minimum int, pattern *regexp.Regexp, context string) error {
	if values == nil {
		return fmt.Errorf("%s must be an array", context)
	}
	if len(values) < minimum {
		return fmt.Errorf("%s must contain at least %d item(s)", context, minimum)
	}
	seen := make(map[string]struct{}, len(values))
	for index, value := range values {
		if err := oneLine(value, fmt.Sprintf("%s[%d]", context, index)); err != nil {
			return err
		}
		if pattern != nil && !pattern.MatchString(value) {
			return fmt.Errorf("%s[%d] has an invalid format", context, index)
		}
		if _, exists := seen[value]; exists {
			return fmt.Errorf("%s contains duplicate value: %s", context, value)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func validateEvidence(values []ArtifactReference, context string) error {
	if values == nil {
		return fmt.Errorf("%s must be an array", context)
	}
	seen := make(map[string]struct{}, len(values))
	for index, value := range values {
		if err := value.Validate(); err != nil {
			return fmt.Errorf("%s[%d]: %w", context, index, err)
		}
		identity := fmt.Sprintf("%s@%d:%s", value.Artifact, value.Version, value.SourceOfTruth)
		if _, exists := seen[identity]; exists {
			return fmt.Errorf("%s contains duplicate reference: %s", context, identity)
		}
		seen[identity] = struct{}{}
	}
	return nil
}

func stageIDError(value StageID) error {
	_, err := ParseStageID(string(value))
	return err
}
