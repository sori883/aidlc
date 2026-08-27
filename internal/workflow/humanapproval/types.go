// Package humanapproval owns review freezes, exact human-action envelopes,
// Codex-observed input receipts, and one-time gate resolutions.
package humanapproval

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/jsonx"
)

const (
	ScopeRisk = "RISK"

	StatusPending  = "pending"
	StatusResolved = "resolved"
)

var (
	stableID = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)
	scopes   = map[string]struct{}{
		string(contract.Stage04): {},
		string(contract.Stage05): {},
		string(contract.Stage07): {},
		string(contract.Stage08): {},
		string(contract.Stage09): {},
		ScopeRisk:                {},
	}
)

// Freeze pins the exact subject, human rendering, Gate requirements, and
// workflow revision that were presented before a human action is accepted.
type Freeze struct {
	SchemaVersion      int                         `json:"schema_version"`
	Artifact           string                      `json:"artifact"`
	Version            int                         `json:"version"`
	FreezeID           string                      `json:"freeze_id"`
	IntentID           string                      `json:"intent_id"`
	Scope              string                      `json:"scope"`
	SubjectRef         contract.ArtifactReference  `json:"subject_ref"`
	FrozenSubjectRef   contract.ArtifactReference  `json:"frozen_subject_ref"`
	ReviewRef          contract.ArtifactReference  `json:"review_ref"`
	FrozenReviewRef    contract.ArtifactReference  `json:"frozen_review_ref"`
	GateRequirementRef *contract.ArtifactReference `json:"gate_requirement_ref"`
	FrozenGateRef      *contract.ArtifactReference `json:"frozen_gate_ref"`
	GraphVersion       string                      `json:"graph_version"`
	PlanRevision       int                         `json:"plan_revision"`
	AllowedActions     []string                    `json:"allowed_actions"`
	ConfirmationCode   string                      `json:"confirmation_code"`
	OpenedAt           string                      `json:"opened_at"`
}

// Current is the mutable Core pointer to one immutable Human Gate history.
type Current struct {
	SchemaVersion  int                         `json:"schema_version"`
	Artifact       string                      `json:"artifact"`
	Version        int                         `json:"version"`
	IntentID       string                      `json:"intent_id"`
	Scope          string                      `json:"scope"`
	Status         string                      `json:"status"`
	FreezeRef      contract.ArtifactReference  `json:"freeze_ref"`
	EnvelopeRef    *contract.ArtifactReference `json:"envelope_ref"`
	DecisionReview *contract.ArtifactReference `json:"decision_review_ref"`
	ReceiptRef     *contract.ArtifactReference `json:"receipt_ref"`
	ResolutionRef  *contract.ArtifactReference `json:"resolution_ref"`
	UpdatedAt      string                      `json:"updated_at"`
}

// ActionProposal is AI-proposed decision content. Core validates and freezes
// it, but it has no authority until a matching UserPromptSubmit Receipt exists.
type ActionProposal struct {
	SchemaVersion int             `json:"schema_version"`
	Artifact      string          `json:"artifact"`
	Version       int             `json:"version"`
	IntentID      string          `json:"intent_id"`
	Scope         string          `json:"scope"`
	SubjectSHA256 string          `json:"subject_sha256"`
	Action        string          `json:"action"`
	Reason        string          `json:"reason"`
	Parameters    json.RawMessage `json:"parameters"`
	ProposedBy    string          `json:"proposed_by"`
}

// Envelope binds the exact proposed action payload to one Review Freeze.
type Envelope struct {
	SchemaVersion int                        `json:"schema_version"`
	Artifact      string                     `json:"artifact"`
	Version       int                        `json:"version"`
	EnvelopeID    string                     `json:"envelope_id"`
	IntentID      string                     `json:"intent_id"`
	Scope         string                     `json:"scope"`
	FreezeRef     contract.ArtifactReference `json:"freeze_ref"`
	SubjectRef    contract.ArtifactReference `json:"subject_ref"`
	Action        string                     `json:"action"`
	Reason        string                     `json:"reason"`
	Parameters    json.RawMessage            `json:"parameters"`
	ProposedBy    string                     `json:"proposed_by"`
	PreparedAt    string                     `json:"prepared_at"`
}

// Receipt is metadata extracted from an exact Codex UserPromptSubmit command.
// It never stores the raw prompt.
type Receipt struct {
	SchemaVersion int                        `json:"schema_version"`
	Artifact      string                     `json:"artifact"`
	Version       int                        `json:"version"`
	ReceiptID     string                     `json:"receipt_id"`
	IntentID      string                     `json:"intent_id"`
	Scope         string                     `json:"scope"`
	FreezeRef     contract.ArtifactReference `json:"freeze_ref"`
	EnvelopeRef   contract.ArtifactReference `json:"envelope_ref"`
	Action        string                     `json:"action"`
	Harness       string                     `json:"harness"`
	SessionID     string                     `json:"session_id"`
	TurnID        string                     `json:"turn_id"`
	ObservedAt    string                     `json:"observed_at"`
}

// Resolution consumes one Receipt and optionally binds the Stage or Risk
// decision artifact produced from the exact Envelope.
type Resolution struct {
	SchemaVersion int                         `json:"schema_version"`
	Artifact      string                      `json:"artifact"`
	Version       int                         `json:"version"`
	ResolutionID  string                      `json:"resolution_id"`
	IntentID      string                      `json:"intent_id"`
	Scope         string                      `json:"scope"`
	FreezeRef     contract.ArtifactReference  `json:"freeze_ref"`
	EnvelopeRef   contract.ArtifactReference  `json:"envelope_ref"`
	ReceiptRef    contract.ArtifactReference  `json:"receipt_ref"`
	DecisionRef   *contract.ArtifactReference `json:"decision_ref"`
	Action        string                      `json:"action"`
	Outcome       string                      `json:"outcome"`
	ResolvedAt    string                      `json:"resolved_at"`
}

// OpenOptions supplies already-validated Core state and exact reviewed refs.
type OpenOptions struct {
	IntentID           string
	Scope              string
	SubjectRef         contract.ArtifactReference
	ReviewRef          contract.ArtifactReference
	GateRequirementRef *contract.ArtifactReference
	GraphVersion       string
	PlanRevision       int
	AllowedActions     []string
	OpenedAt           string
}

// OpenResult describes the pending immutable Freeze and mutable pointer.
type OpenResult struct {
	Freeze          Freeze                     `json:"freeze"`
	FreezeReference contract.ArtifactReference `json:"freezeReference"`
	Current         Current                    `json:"current"`
	Confirmation    string                     `json:"confirmation"`
}

// PrepareResult describes a frozen decision Envelope and human HTML review.
type PrepareResult struct {
	Envelope          Envelope                   `json:"envelope"`
	EnvelopeReference contract.ArtifactReference `json:"envelopeReference"`
	ReviewReference   contract.ArtifactReference `json:"reviewReference"`
	Confirmation      string                     `json:"confirmation"`
}

// CaptureResult is empty for an ordinary prompt and populated only after an
// exact confirmation command was validated and persisted.
type CaptureResult struct {
	Matched          bool                        `json:"matched"`
	Receipt          *Receipt                    `json:"receipt"`
	ReceiptReference *contract.ArtifactReference `json:"receiptReference"`
}

// Proof can only be constructed by validating a pending, unconsumed Receipt.
// Its unexported marker prevents callers from manufacturing Human authority.
type Proof struct {
	valid       bool
	freeze      Freeze
	freezeRef   contract.ArtifactReference
	envelope    Envelope
	envelopeRef contract.ArtifactReference
	receipt     Receipt
	receiptRef  contract.ArtifactReference
}

func (value Freeze) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "human-review-freeze" || value.Version != 1 {
		return fmt.Errorf("Human Review Freeze has an invalid schema identity")
	}
	if !stableID.MatchString(value.FreezeID) {
		return fmt.Errorf("freeze_id must be a stable identifier")
	}
	if err := validateIdentity(value.IntentID, value.Scope); err != nil {
		return err
	}
	for field, ref := range map[string]contract.ArtifactReference{
		"subject_ref": value.SubjectRef, "frozen_subject_ref": value.FrozenSubjectRef,
		"review_ref": value.ReviewRef, "frozen_review_ref": value.FrozenReviewRef,
	} {
		if err := ref.Validate(); err != nil {
			return fmt.Errorf("%s: %w", field, err)
		}
	}
	if (value.GateRequirementRef == nil) != (value.FrozenGateRef == nil) {
		return fmt.Errorf("gate_requirement_ref and frozen_gate_ref must be present together")
	}
	for field, ref := range map[string]*contract.ArtifactReference{
		"gate_requirement_ref": value.GateRequirementRef,
		"frozen_gate_ref":      value.FrozenGateRef,
	} {
		if ref != nil {
			if err := ref.Validate(); err != nil {
				return fmt.Errorf("%s: %w", field, err)
			}
		}
	}
	if err := oneLine(value.GraphVersion, "graph_version"); err != nil {
		return err
	}
	if value.PlanRevision < 1 {
		return fmt.Errorf("plan_revision must be positive")
	}
	if err := validateActions(value.AllowedActions); err != nil {
		return err
	}
	if !stableID.MatchString(value.ConfirmationCode) {
		return fmt.Errorf("confirmation_code must be a stable identifier")
	}
	return timestamp(value.OpenedAt, "opened_at")
}

func (value Current) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "human-gate-current" || value.Version != 1 {
		return fmt.Errorf("Human Gate Current has an invalid schema identity")
	}
	if err := validateIdentity(value.IntentID, value.Scope); err != nil {
		return err
	}
	if value.Status != StatusPending && value.Status != StatusResolved {
		return fmt.Errorf("status must be pending or resolved")
	}
	if err := value.FreezeRef.Validate(); err != nil {
		return fmt.Errorf("freeze_ref: %w", err)
	}
	for field, ref := range map[string]*contract.ArtifactReference{
		"envelope_ref": value.EnvelopeRef, "decision_review_ref": value.DecisionReview,
		"receipt_ref": value.ReceiptRef, "resolution_ref": value.ResolutionRef,
	} {
		if ref != nil {
			if err := ref.Validate(); err != nil {
				return fmt.Errorf("%s: %w", field, err)
			}
		}
	}
	if (value.EnvelopeRef == nil) != (value.DecisionReview == nil) {
		return fmt.Errorf("envelope_ref and decision_review_ref must be present together")
	}
	if value.ReceiptRef != nil && value.EnvelopeRef == nil {
		return fmt.Errorf("receipt_ref requires envelope_ref")
	}
	if value.Status == StatusPending && value.ResolutionRef != nil {
		return fmt.Errorf("pending Current cannot have resolution_ref")
	}
	if value.Status == StatusResolved && value.ResolutionRef == nil {
		return fmt.Errorf("resolved Current requires resolution_ref")
	}
	if value.Status == StatusResolved && (value.EnvelopeRef == nil || value.DecisionReview == nil || value.ReceiptRef == nil) {
		return fmt.Errorf("resolved Current requires envelope_ref, decision_review_ref, and receipt_ref")
	}
	return timestamp(value.UpdatedAt, "updated_at")
}

func DecodeActionProposal(content []byte) (ActionProposal, error) {
	value, err := jsonx.Decode[ActionProposal](content)
	if err != nil {
		return ActionProposal{}, err
	}
	if err := value.Validate(); err != nil {
		return ActionProposal{}, err
	}
	return value, nil
}

func (value ActionProposal) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "human-action-proposal" || value.Version != 1 {
		return fmt.Errorf("Human Action Proposal has an invalid schema identity")
	}
	if err := validateIdentity(value.IntentID, value.Scope); err != nil {
		return err
	}
	if !strings.HasPrefix(value.SubjectSHA256, "sha256:") || len(value.SubjectSHA256) != 71 {
		return fmt.Errorf("subject_sha256 must be a SHA-256 reference")
	}
	if err := oneLine(value.Action, "action"); err != nil {
		return err
	}
	if err := oneLine(value.Reason, "reason"); err != nil {
		return err
	}
	if err := object(value.Parameters, "parameters"); err != nil {
		return err
	}
	if value.ProposedBy != "ai" && value.ProposedBy != "human" {
		return fmt.Errorf("proposed_by must be ai or human")
	}
	return nil
}

func (value Envelope) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "human-decision-envelope" || value.Version != 1 {
		return fmt.Errorf("Human Decision Envelope has an invalid schema identity")
	}
	if !stableID.MatchString(value.EnvelopeID) {
		return fmt.Errorf("envelope_id must be a stable identifier")
	}
	if err := validateIdentity(value.IntentID, value.Scope); err != nil {
		return err
	}
	if err := value.FreezeRef.Validate(); err != nil {
		return fmt.Errorf("freeze_ref: %w", err)
	}
	if err := value.SubjectRef.Validate(); err != nil {
		return fmt.Errorf("subject_ref: %w", err)
	}
	if err := oneLine(value.Action, "action"); err != nil {
		return err
	}
	if err := oneLine(value.Reason, "reason"); err != nil {
		return err
	}
	if err := object(value.Parameters, "parameters"); err != nil {
		return err
	}
	if value.ProposedBy != "ai" && value.ProposedBy != "human" {
		return fmt.Errorf("proposed_by must be ai or human")
	}
	return timestamp(value.PreparedAt, "prepared_at")
}

func (value Receipt) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "human-input-receipt" || value.Version != 1 {
		return fmt.Errorf("Human Input Receipt has an invalid schema identity")
	}
	if !stableID.MatchString(value.ReceiptID) {
		return fmt.Errorf("receipt_id must be a stable identifier")
	}
	if err := validateIdentity(value.IntentID, value.Scope); err != nil {
		return err
	}
	if err := value.FreezeRef.Validate(); err != nil {
		return fmt.Errorf("freeze_ref: %w", err)
	}
	if err := value.EnvelopeRef.Validate(); err != nil {
		return fmt.Errorf("envelope_ref: %w", err)
	}
	for field, text := range map[string]string{"action": value.Action, "harness": value.Harness, "session_id": value.SessionID} {
		if err := oneLine(text, field); err != nil {
			return err
		}
	}
	if value.TurnID != "" {
		if err := oneLine(value.TurnID, "turn_id"); err != nil {
			return err
		}
	}
	return timestamp(value.ObservedAt, "observed_at")
}

func (value Resolution) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "human-gate-resolution" || value.Version != 1 {
		return fmt.Errorf("Human Gate Resolution has an invalid schema identity")
	}
	if !stableID.MatchString(value.ResolutionID) {
		return fmt.Errorf("resolution_id must be a stable identifier")
	}
	if err := validateIdentity(value.IntentID, value.Scope); err != nil {
		return err
	}
	for field, ref := range map[string]contract.ArtifactReference{
		"freeze_ref": value.FreezeRef, "envelope_ref": value.EnvelopeRef, "receipt_ref": value.ReceiptRef,
	} {
		if err := ref.Validate(); err != nil {
			return fmt.Errorf("%s: %w", field, err)
		}
	}
	if value.DecisionRef != nil {
		if err := value.DecisionRef.Validate(); err != nil {
			return fmt.Errorf("decision_ref: %w", err)
		}
	}
	for field, text := range map[string]string{"action": value.Action, "outcome": value.Outcome} {
		if err := oneLine(text, field); err != nil {
			return err
		}
	}
	return timestamp(value.ResolvedAt, "resolved_at")
}

func validateIdentity(intentID, scope string) error {
	if err := oneLine(intentID, "intent_id"); err != nil {
		return err
	}
	if _, ok := scopes[scope]; !ok {
		return fmt.Errorf("scope must be ST-04, ST-05, ST-07, ST-08, ST-09, or RISK")
	}
	return nil
}

func validateActions(values []string) error {
	if len(values) == 0 {
		return fmt.Errorf("allowed_actions must contain at least one action")
	}
	seen := map[string]struct{}{}
	for index, value := range values {
		if err := oneLine(value, fmt.Sprintf("allowed_actions[%d]", index)); err != nil {
			return err
		}
		if _, exists := seen[value]; exists {
			return fmt.Errorf("allowed_actions contains duplicate action %s", value)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func normalizedActions(values []string) ([]string, error) {
	result := append([]string(nil), values...)
	sort.Strings(result)
	if err := validateActions(result); err != nil {
		return nil, err
	}
	return result, nil
}

func object(content json.RawMessage, field string) error {
	if len(content) == 0 {
		return fmt.Errorf("%s must be a JSON object", field)
	}
	var value map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || value == nil {
		return fmt.Errorf("%s must be a JSON object", field)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("%s must contain exactly one JSON value", field)
		}
		return fmt.Errorf("%s contains invalid trailing JSON: %w", field, err)
	}
	return nil
}

func oneLine(value, field string) error {
	if strings.TrimSpace(value) != value || value == "" || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s must be a non-empty single line", field)
	}
	return nil
}

func timestamp(value, field string) error {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.Location() != time.UTC {
		return fmt.Errorf("%s must be an ISO-8601 UTC timestamp", field)
	}
	return nil
}
