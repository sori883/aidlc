// Package directive defines the six Core-owned vNext Directive variants.
package directive

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/jsonx"
)

// Kind identifies one fixed Directive variant.
type Kind string

const (
	Parked   Kind = "parked"
	Work     Kind = "work"
	Approval Kind = "approval"
	Decision Kind = "decision"
	Advanced Kind = "advanced"
	Done     Kind = "done"
)

var (
	approvalDecisions = []string{"approve", "revise"}
	feedbackReasons   = []string{"requirements_changed", "architecture_impact", "build_contract_impact", "candidate_defect"}
	outcomeDecisions  = []string{"continue-observation", "complete-with-outcome", "complete-and-draft-follow-up"}
)

// Core is the strict tagged union used for every Core response.
type Core struct {
	SchemaVersion     int                          `json:"schema_version"`
	Workflow          string                       `json:"workflow"`
	Reason            string                       `json:"reason"`
	GraphVersion      string                       `json:"graph_version"`
	PlanRevision      int                          `json:"plan_revision"`
	DecisionAuthority string                       `json:"decision_authority"`
	Kind              Kind                         `json:"kind"`
	CompletedStage    *contract.StageID            `json:"completed_stage,omitempty"`
	Stage             *contract.StageID            `json:"stage,omitempty"`
	Evidence          []contract.ArtifactReference `json:"evidence,omitempty"`
	Request           *contract.ArtifactReference  `json:"request,omitempty"`
	Candidate         *contract.ArtifactReference  `json:"candidate,omitempty"`
	Review            *contract.ArtifactReference  `json:"review,omitempty"`
	Decisions         []string                     `json:"decisions,omitempty"`
	FeedbackReasons   []string                     `json:"feedback_reasons,omitempty"`
}

// Decode strictly decodes one Directive.
func Decode(content []byte) (Core, error) {
	value, err := jsonx.Decode[Core](content)
	if err != nil {
		return Core{}, err
	}
	if err := value.Validate(); err != nil {
		return Core{}, err
	}
	if err := validateDecodedKeys(content, value.Kind); err != nil {
		return Core{}, err
	}
	return value, nil
}

// Validate enforces variant-specific fields, fixed choices, and Core authority.
func (value Core) Validate() error {
	if value.SchemaVersion != 1 {
		return fmt.Errorf("vNext Core Directive.schema_version must equal 1")
	}
	if value.Workflow != "vnext" {
		return fmt.Errorf("vNext Core Directive.workflow must equal vnext")
	}
	if value.DecisionAuthority != "core" {
		return fmt.Errorf("vNext Core Directive.decision_authority must equal core")
	}
	if value.PlanRevision < 1 {
		return fmt.Errorf("vNext Core Directive.plan_revision must be a positive integer")
	}
	if err := oneLine(value.Reason, "reason"); err != nil {
		return err
	}
	if err := oneLine(value.GraphVersion, "graph_version"); err != nil {
		return err
	}

	switch value.Kind {
	case Done:
		return value.requireAbsent("done", false, false, false, false, false, false, false)
	case Parked:
		if err := requireStage(value.Stage, "stage"); err != nil {
			return err
		}
		return value.requireAbsent("parked", false, true, false, false, false, false, false)
	case Advanced:
		if err := requireStage(value.CompletedStage, "completed_stage"); err != nil {
			return err
		}
		if err := requireStage(value.Stage, "stage"); err != nil {
			return err
		}
		if len(value.Evidence) == 0 {
			return fmt.Errorf("vNext Core Directive.evidence must contain at least one Artifact reference")
		}
		for index, reference := range value.Evidence {
			if err := reference.Validate(); err != nil {
				return fmt.Errorf("vNext Core Directive.evidence[%d]: %w", index, err)
			}
		}
		return value.requireAbsent("advanced", true, true, true, false, false, false, false)
	case Work:
		if err := requireStage(value.Stage, "stage"); err != nil {
			return err
		}
		if value.Request == nil {
			return fmt.Errorf("vNext Core Directive.request is required")
		}
		if err := value.Request.Validate(); err != nil {
			return fmt.Errorf("vNext Core Directive.request: %w", err)
		}
		return value.requireAbsent("work", false, true, false, true, false, false, false)
	case Approval:
		if err := requireStage(value.Stage, "stage"); err != nil {
			return err
		}
		if value.Candidate == nil || value.Review == nil {
			return fmt.Errorf("vNext Core Directive approval requires candidate and review")
		}
		if err := value.Candidate.Validate(); err != nil {
			return err
		}
		if err := value.Review.Validate(); err != nil {
			return err
		}
		if !equalStrings(value.Decisions, approvalDecisions) {
			return fmt.Errorf("vNext Core Directive.decisions must equal [approve, revise]")
		}
		if value.FeedbackReasons != nil && !equalStrings(value.FeedbackReasons, feedbackReasons) {
			return fmt.Errorf("vNext Core Directive.feedback_reasons must equal the four fixed ST-07 feedback reasons")
		}
		return value.requireAbsent("approval", false, true, false, false, true, true, true)
	case Decision:
		if value.Stage == nil || *value.Stage != contract.Stage09 {
			return fmt.Errorf("vNext Core Directive.stage must equal ST-09")
		}
		if value.Candidate == nil || value.Review == nil {
			return fmt.Errorf("vNext Core Directive decision requires candidate and review")
		}
		if err := value.Candidate.Validate(); err != nil {
			return err
		}
		if err := value.Review.Validate(); err != nil {
			return err
		}
		if !equalStrings(value.Decisions, outcomeDecisions) {
			return fmt.Errorf("vNext Core Directive.decisions must equal the three fixed ST-09 decisions")
		}
		if len(value.FeedbackReasons) != 0 {
			return fmt.Errorf("vNext Core Directive.feedback_reasons is not allowed for decision")
		}
		return value.requireAbsent("decision", false, true, false, false, true, true, true)
	default:
		return fmt.Errorf("vNext Core Directive.kind must be parked, work, approval, decision, advanced, or done")
	}
}

func (value Core) requireAbsent(kind string, completed, stage, evidence, request, candidate, review, decisions bool) error {
	if !completed && value.CompletedStage != nil {
		return fmt.Errorf("vNext Core Directive.completed_stage is not allowed for %s", kind)
	}
	if !stage && value.Stage != nil {
		return fmt.Errorf("vNext Core Directive.stage is not allowed for %s", kind)
	}
	if !evidence && value.Evidence != nil {
		return fmt.Errorf("vNext Core Directive.evidence is not allowed for %s", kind)
	}
	if !request && value.Request != nil {
		return fmt.Errorf("vNext Core Directive.request is not allowed for %s", kind)
	}
	if !candidate && value.Candidate != nil {
		return fmt.Errorf("vNext Core Directive.candidate is not allowed for %s", kind)
	}
	if !review && value.Review != nil {
		return fmt.Errorf("vNext Core Directive.review is not allowed for %s", kind)
	}
	if !decisions && value.Decisions != nil {
		return fmt.Errorf("vNext Core Directive.decisions is not allowed for %s", kind)
	}
	if kind != "approval" && value.FeedbackReasons != nil {
		return fmt.Errorf("vNext Core Directive.feedback_reasons is not allowed for %s", kind)
	}
	return nil
}

func validateDecodedKeys(content []byte, kind Kind) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(content, &fields); err != nil {
		return err
	}
	allowed := map[string]struct{}{
		"schema_version": {}, "kind": {}, "workflow": {}, "reason": {},
		"graph_version": {}, "plan_revision": {}, "decision_authority": {},
	}
	add := func(names ...string) {
		for _, name := range names {
			allowed[name] = struct{}{}
		}
	}
	switch kind {
	case Parked:
		add("stage")
	case Work:
		add("stage", "request")
	case Approval:
		add("stage", "candidate", "review", "decisions", "feedback_reasons")
	case Decision:
		add("stage", "candidate", "review", "decisions")
	case Advanced:
		add("completed_stage", "stage", "evidence")
	case Done:
	}
	for name := range fields {
		if _, ok := allowed[name]; !ok {
			return fmt.Errorf("vNext Core Directive.%s is not allowed for %s", name, kind)
		}
	}
	return nil
}

func requireStage(value *contract.StageID, field string) error {
	if value == nil || !value.Valid() {
		return fmt.Errorf("vNext Core Directive.%s must be one of the fixed Stage IDs", field)
	}
	return nil
}

func oneLine(value, field string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("vNext Core Directive.%s must be a non-empty single-line string", field)
	}
	return nil
}

func equalStrings(actual, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	for index := range expected {
		if actual[index] != expected[index] {
			return false
		}
	}
	return true
}
