// Package st03requirements implements traceable ST-03 Requirements & Constraints.
package st03requirements

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st01orient"
	"github.com/sori883/aidlc/internal/stage/st02defineintent"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/state"
)

var idPatterns = map[string]*regexp.Regexp{
	"functional": regexp.MustCompile(`^REQ-F-\d{3}$`),
	"quality":    regexp.MustCompile(`^REQ-Q-\d{3}$`),
	"constraint": regexp.MustCompile(`^CON-\d{3}$`),
	"invariant":  regexp.MustCompile(`^INV-\d{3}$`),
	"question":   regexp.MustCompile(`^Q-\d{3}$`),
}

type SourceRef struct {
	Artifact string `json:"artifact"`
	Pointer  string `json:"pointer"`
}

type Item struct {
	ID         string      `json:"id"`
	Statement  string      `json:"statement"`
	SourceRefs []SourceRef `json:"source_refs"`
}

type OpenQuestion struct {
	ID         string      `json:"id"`
	Question   string      `json:"question"`
	Blocking   bool        `json:"blocking"`
	Reason     string      `json:"reason"`
	SourceRefs []SourceRef `json:"source_refs"`
}

type WorkRequest struct {
	SchemaVersion       int                         `json:"schema_version"`
	Artifact            string                      `json:"artifact"`
	Version             int                         `json:"version"`
	IntentID            string                      `json:"intent_id"`
	StageID             contract.StageID            `json:"stage_id"`
	IntentDefinitionRef contract.ArtifactReference  `json:"intent_definition_ref"`
	CurrentContextRef   contract.ArtifactReference  `json:"current_context_ref"`
	EffectivePolicyRef  contract.ArtifactReference  `json:"effective_policy_ref"`
	BaseRevision        *int                        `json:"base_revision"`
	BaseRequirementsRef *contract.ArtifactReference `json:"base_requirements_ref"`
	CoverageRequired    []SourceRef                 `json:"coverage_required"`
	RequestedOutputs    []string                    `json:"requested_outputs"`
	Rules               []string                    `json:"rules"`
	CreatedAt           string                      `json:"created_at"`
}

type Proposal struct {
	SchemaVersion          int            `json:"schema_version"`
	Artifact               string         `json:"artifact"`
	Version                int            `json:"version"`
	ProposalID             string         `json:"proposal_id"`
	IntentID               string         `json:"intent_id"`
	WorkRequestSHA256      string         `json:"work_request_sha256"`
	FunctionalRequirements []Item         `json:"functional_requirements"`
	QualityRequirements    []Item         `json:"quality_requirements"`
	Constraints            []Item         `json:"constraints"`
	Invariants             []Item         `json:"invariants"`
	OpenQuestions          []OpenQuestion `json:"open_questions"`
	Reason                 string         `json:"reason"`
	ProposedBy             string         `json:"proposed_by"`
}

type Definition struct {
	SchemaVersion          int                        `json:"schema_version"`
	Artifact               string                     `json:"artifact"`
	Version                int                        `json:"version"`
	IntentID               string                     `json:"intent_id"`
	Revision               int                        `json:"revision"`
	BaseRevision           *int                       `json:"base_revision"`
	ProposalID             string                     `json:"proposal_id"`
	IntentDefinitionRef    contract.ArtifactReference `json:"intent_definition_ref"`
	CurrentContextRef      contract.ArtifactReference `json:"current_context_ref"`
	EffectivePolicyRef     contract.ArtifactReference `json:"effective_policy_ref"`
	FunctionalRequirements []Item                     `json:"functional_requirements"`
	QualityRequirements    []Item                     `json:"quality_requirements"`
	Constraints            []Item                     `json:"constraints"`
	Invariants             []Item                     `json:"invariants"`
	OpenQuestions          []OpenQuestion             `json:"open_questions"`
	Reason                 string                     `json:"reason"`
	CreatedAt              string                     `json:"created_at"`
}

type Current struct {
	SchemaVersion   int                        `json:"schema_version"`
	Artifact        string                     `json:"artifact"`
	Version         int                        `json:"version"`
	IntentID        string                     `json:"intent_id"`
	CurrentRevision int                        `json:"current_revision"`
	RequirementsRef contract.ArtifactReference `json:"requirements_ref"`
	UpdatedAt       string                     `json:"updated_at"`
}

type PrepareResult struct {
	Execution string                     `json:"execution"`
	Request   WorkRequest                `json:"request"`
	Reference contract.ArtifactReference `json:"reference"`
}

type CompleteResult struct {
	Definition       Definition                 `json:"definition"`
	Reference        contract.ArtifactReference `json:"reference"`
	Current          Current                    `json:"current"`
	CurrentReference contract.ArtifactReference `json:"currentReference"`
	State            state.IntentState          `json:"state"`
}

func RootDir(recordDir string) string { return filepath.Join(recordDir, "artifacts", "requirements") }
func WorkRequestPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "work-request.json")
}
func CurrentPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "current.json") }
func RevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "requirements-definition.json")
}

func Prepare(ctx context.Context, projectDir, coreDir, preparedAt string) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage03)
	if err != nil {
		return PrepareResult{}, err
	}
	if current.Decision.Disposition == contract.NotApplicable {
		return PrepareResult{}, fmt.Errorf("ST-03 Requirements: ST-03 cannot be not_applicable; every Intent needs explicit requirements")
	}
	intentPath := st02defineintent.DefinitionPath(current.Snapshot.RecordDir)
	intentDefinition, intentRef, _, err := stageruntime.ReadCanonical[st02defineintent.Definition](current.ProjectDir, intentPath, "intent-definition", 1)
	if err != nil {
		return PrepareResult{}, fmt.Errorf("ST-03 Requirements: Intent Definition is required: %w", err)
	}
	contextPath := st01orient.CurrentContextPath(current.Snapshot.RecordDir)
	_, contextRef, _, err := stageruntime.ReadCanonical[st01orient.CurrentContext](current.ProjectDir, contextPath, "current-context", 1)
	if err != nil {
		return PrepareResult{}, fmt.Errorf("ST-03 Requirements: Current Context is required: %w", err)
	}
	var baseRevision *int
	var baseRef *contract.ArtifactReference
	storedCurrent, _, _, currentExists, err := stageruntime.ReadCanonicalIfExists[Current](current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), "requirements-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if currentExists {
		baseRevision = &storedCurrent.CurrentRevision
		baseRef = &storedCurrent.RequirementsRef
		if _, err := stageruntime.ReadReference(current.ProjectDir, storedCurrent.RequirementsRef); err != nil {
			return PrepareResult{}, err
		}
	}
	coverage := requiredCoverage(intentDefinition)
	path := WorkRequestPath(current.Snapshot.RecordDir)
	storedRequest, reference, _, requestExists, err := stageruntime.ReadCanonicalIfExists[WorkRequest](current.ProjectDir, path, "requirements-work-request", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if requestExists && storedRequest.IntentID == current.Snapshot.State.IntentID && storedRequest.IntentDefinitionRef == intentRef && storedRequest.CurrentContextRef == contextRef && storedRequest.EffectivePolicyRef == current.Snapshot.State.PolicySnapshot && equalRevision(storedRequest.BaseRevision, baseRevision) && equalReference(storedRequest.BaseRequirementsRef, baseRef) && equalSourceRefs(storedRequest.CoverageRequired, coverage) {
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
	request := WorkRequest{
		SchemaVersion: 1, Artifact: "requirements-work-request", Version: 1, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage03,
		IntentDefinitionRef: intentRef, CurrentContextRef: contextRef, EffectivePolicyRef: current.Snapshot.State.PolicySnapshot,
		BaseRevision: baseRevision, BaseRequirementsRef: baseRef, CoverageRequired: coverage,
		RequestedOutputs: []string{"requirements-definition-proposal"},
		Rules: []string{
			"Define observable functional requirements, relevant quality requirements, constraints, invariants, and open questions only.",
			"Every requirement item must cite an existing JSON Pointer in the pinned Intent Definition, Current Context, or Effective Policy.",
			"Cover every expected outcome and success signal from the Intent Definition without expanding its scope.",
			"Do not add architecture choices, acceptance test procedures, Bolt plans, implementation instructions, or routes.",
			"Ask a human before submission when a value judgment, conflict, or risk acceptance remains unresolved.",
			"AI proposes content only; Core validates, versions, persists, and owns the fixed Stage transition.",
		}, CreatedAt: preparedAt,
	}
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
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage03)
	if err != nil {
		return CompleteResult{}, err
	}
	proposal, err := stageruntime.DecodeProposal(proposalContent, func(value Proposal) error { return value.Validate() })
	if err != nil {
		return CompleteResult{}, fmt.Errorf("ST-03 Requirements Proposal: %w", err)
	}
	if proposal.IntentID != current.Snapshot.State.IntentID {
		return CompleteResult{}, fmt.Errorf("ST-03 Requirements: Proposal Intent does not match State")
	}
	if proposal.WorkRequestSHA256 != prepared.Reference.SHA256 {
		return CompleteResult{}, fmt.Errorf("ST-03 Requirements: Proposal does not reference the current Requirements Work Request")
	}
	if err := verifySources(current.ProjectDir, prepared.Request, proposal); err != nil {
		return CompleteResult{}, err
	}
	if completedAt == "" {
		completedAt = stageruntime.Now()
	}
	revision := 1
	if prepared.Request.BaseRevision != nil {
		revision = *prepared.Request.BaseRevision + 1
	}
	definition := Definition{
		SchemaVersion: 1, Artifact: "requirements-definition", Version: 1, IntentID: proposal.IntentID, Revision: revision, BaseRevision: prepared.Request.BaseRevision, ProposalID: proposal.ProposalID,
		IntentDefinitionRef: prepared.Request.IntentDefinitionRef, CurrentContextRef: prepared.Request.CurrentContextRef, EffectivePolicyRef: prepared.Request.EffectivePolicyRef,
		FunctionalRequirements: proposal.FunctionalRequirements, QualityRequirements: proposal.QualityRequirements, Constraints: proposal.Constraints, Invariants: proposal.Invariants, OpenQuestions: proposal.OpenQuestions, Reason: proposal.Reason, CreatedAt: completedAt,
	}
	path := RevisionPath(current.Snapshot.RecordDir, revision)
	stored, _, _, exists, err := stageruntime.ReadCanonicalIfExists[Definition](current.ProjectDir, path, "requirements-definition", 1)
	if err != nil {
		return CompleteResult{}, err
	}
	if exists {
		if !definitionStableEqual(stored, definition) {
			return CompleteResult{}, fmt.Errorf("ST-03 Requirements: immutable Requirements revision %d already exists with different content", revision)
		}
		definition = stored
	}
	reference, _, err := stageruntime.WriteCanonical(current.ProjectDir, path, definition.Artifact, 1, definition, true)
	if err != nil {
		return CompleteResult{}, err
	}
	pointer := Current{SchemaVersion: 1, Artifact: "requirements-current", Version: 1, IntentID: proposal.IntentID, CurrentRevision: revision, RequirementsRef: reference, UpdatedAt: definition.CreatedAt}
	currentRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), pointer.Artifact, 1, pointer, false)
	if err != nil {
		return CompleteResult{}, err
	}
	advanced, err := stageruntime.Advance(ctx, current, reference, "requirements-definition-validator", "ST-04 Architecture Decision is ready for Core preparation.", completedAt)
	if err != nil {
		return CompleteResult{}, err
	}
	return CompleteResult{Definition: definition, Reference: reference, Current: pointer, CurrentReference: currentRef, State: advanced}, nil
}

type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, "")
	if err != nil {
		return directive.Core{}, err
	}
	stageID := contract.Stage03
	result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Work, Stage: &stageID, Reason: "Core prepared the fixed ST-03 Requirements inputs; AI may propose traceable requirements and constraints only.", Request: &prepared.Reference, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
	return result, result.Validate()
}

func (value Proposal) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "requirements-definition-proposal" || value.Version != 1 || value.ProposedBy != "ai" {
		return fmt.Errorf("Requirements Definition Proposal has an invalid schema identity or authority")
	}
	if err := stageruntime.OneLine(value.ProposalID, "proposal_id"); err != nil {
		return err
	}
	if err := stageruntime.OneLine(value.IntentID, "intent_id"); err != nil {
		return err
	}
	if err := digest.Validate(value.WorkRequestSHA256); err != nil {
		return err
	}
	if value.FunctionalRequirements == nil || value.QualityRequirements == nil || value.Constraints == nil || value.Invariants == nil || value.OpenQuestions == nil {
		return fmt.Errorf("Requirements collection fields must be arrays")
	}
	if len(value.FunctionalRequirements)+len(value.QualityRequirements)+len(value.Constraints)+len(value.Invariants) == 0 {
		return fmt.Errorf("Requirements Proposal must define at least one requirement, constraint, or invariant")
	}
	seen := map[string]struct{}{}
	groups := []struct {
		name    string
		pattern *regexp.Regexp
		items   []Item
	}{{"functional", idPatterns["functional"], value.FunctionalRequirements}, {"quality", idPatterns["quality"], value.QualityRequirements}, {"constraint", idPatterns["constraint"], value.Constraints}, {"invariant", idPatterns["invariant"], value.Invariants}}
	for _, group := range groups {
		for _, item := range group.items {
			if !group.pattern.MatchString(item.ID) {
				return fmt.Errorf("%s ID has an invalid format: %s", group.name, item.ID)
			}
			if _, exists := seen[item.ID]; exists {
				return fmt.Errorf("duplicate requirement ID: %s", item.ID)
			}
			seen[item.ID] = struct{}{}
			if err := stageruntime.OneLine(item.Statement, item.ID+" statement"); err != nil {
				return err
			}
			if err := validateSourceRefs(item.SourceRefs); err != nil {
				return err
			}
		}
	}
	for _, question := range value.OpenQuestions {
		if !idPatterns["question"].MatchString(question.ID) {
			return fmt.Errorf("question ID has an invalid format: %s", question.ID)
		}
		if _, exists := seen[question.ID]; exists {
			return fmt.Errorf("duplicate requirement ID: %s", question.ID)
		}
		seen[question.ID] = struct{}{}
		if err := stageruntime.OneLine(question.Question, "question"); err != nil {
			return err
		}
		if err := stageruntime.OneLine(question.Reason, "question reason"); err != nil {
			return err
		}
		if err := validateSourceRefs(question.SourceRefs); err != nil {
			return err
		}
	}
	return stageruntime.OneLine(value.Reason, "Requirements Proposal.reason")
}

func validateSourceRefs(values []SourceRef) error {
	if len(values) == 0 {
		return fmt.Errorf("source_refs must contain at least one item")
	}
	seen := map[string]struct{}{}
	for _, value := range values {
		if value.Artifact != "intent-definition" && value.Artifact != "current-context" && value.Artifact != "effective-policy" {
			return fmt.Errorf("source artifact is invalid: %s", value.Artifact)
		}
		if value.Pointer == "" || !strings.HasPrefix(value.Pointer, "/") || regexp.MustCompile(`~(?:[^01]|$)`).MatchString(value.Pointer) {
			return fmt.Errorf("source pointer must be a non-root RFC 6901 JSON Pointer: %s", value.Pointer)
		}
		key := value.Artifact + ":" + value.Pointer
		if _, exists := seen[key]; exists {
			return fmt.Errorf("source_refs contains duplicate reference: %s", key)
		}
		seen[key] = struct{}{}
	}
	return nil
}

func requiredCoverage(value st02defineintent.Definition) []SourceRef {
	result := make([]SourceRef, 0, len(value.ExpectedOutcomes)+len(value.SuccessSignals))
	for index := range value.ExpectedOutcomes {
		result = append(result, SourceRef{Artifact: "intent-definition", Pointer: "/expected_outcomes/" + strconv.Itoa(index)})
	}
	for index := range value.SuccessSignals {
		result = append(result, SourceRef{Artifact: "intent-definition", Pointer: "/success_signals/" + strconv.Itoa(index)})
	}
	return result
}

func verifySources(projectDir string, request WorkRequest, proposal Proposal) error {
	references := map[string]contract.ArtifactReference{"intent-definition": request.IntentDefinitionRef, "current-context": request.CurrentContextRef, "effective-policy": request.EffectivePolicyRef}
	documents := map[string]any{}
	for artifact, reference := range references {
		path, err := stageruntime.ReadReference(projectDir, reference)
		if err != nil {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var value any
		if err := json.Unmarshal(content, &value); err != nil {
			return err
		}
		documents[artifact] = value
	}
	covered := map[string]struct{}{}
	items := append(append(append(append([]Item{}, proposal.FunctionalRequirements...), proposal.QualityRequirements...), proposal.Constraints...), proposal.Invariants...)
	for _, item := range items {
		for _, source := range item.SourceRefs {
			if !pointerExists(documents[source.Artifact], source.Pointer) {
				return fmt.Errorf("ST-03 Requirements: source pointer does not exist: %s%s", source.Artifact, source.Pointer)
			}
			covered[source.Artifact+":"+source.Pointer] = struct{}{}
		}
	}
	for _, question := range proposal.OpenQuestions {
		if question.Blocking {
			return fmt.Errorf("ST-03 Requirements: blocking open question remains: %s", question.ID)
		}
		for _, source := range question.SourceRefs {
			if !pointerExists(documents[source.Artifact], source.Pointer) {
				return fmt.Errorf("ST-03 Requirements: source pointer does not exist: %s%s", source.Artifact, source.Pointer)
			}
		}
	}
	for _, required := range request.CoverageRequired {
		key := required.Artifact + ":" + required.Pointer
		if _, exists := covered[key]; !exists {
			return fmt.Errorf("ST-03 Requirements: required coverage is missing: %s%s", required.Artifact, required.Pointer)
		}
	}
	return nil
}

func pointerExists(document any, pointer string) bool {
	current := document
	for _, segment := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		segment = strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~")
		switch value := current.(type) {
		case map[string]any:
			next, exists := value[segment]
			if !exists {
				return false
			}
			current = next
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(value) {
				return false
			}
			current = value[index]
		default:
			return false
		}
	}
	return true
}

func definitionStableEqual(left, right Definition) bool {
	left.CreatedAt = ""
	right.CreatedAt = ""
	leftBytes, _ := json.Marshal(left)
	rightBytes, _ := json.Marshal(right)
	return string(leftBytes) == string(rightBytes)
}
func equalRevision(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
func equalReference(left, right *contract.ArtifactReference) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
func equalSourceRefs(left, right []SourceRef) bool {
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
