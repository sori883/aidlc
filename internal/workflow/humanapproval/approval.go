package humanapproval

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"os"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/workflow/policy"
)

// Prepare validates an Action Proposal against the pending Freeze and persists
// the exact immutable Envelope plus an escaped human review page.
func Prepare(ctx context.Context, projectDir, recordDir string, proposal ActionProposal, preparedAt string) (PrepareResult, error) {
	var result PrepareResult
	err := lock.With(ctx, projectDir, lock.Options{}, func(context.Context) error {
		var err error
		result, err = prepareLocked(projectDir, recordDir, proposal, preparedAt)
		return err
	})
	return result, err
}

func prepareLocked(projectDir, recordDir string, proposal ActionProposal, preparedAt string) (PrepareResult, error) {
	if err := proposal.Validate(); err != nil {
		return PrepareResult{}, err
	}
	current, freeze, freezeRef, err := ReadCurrent(projectDir, recordDir)
	if err != nil {
		return PrepareResult{}, err
	}
	if current.Status != StatusPending {
		return PrepareResult{}, fmt.Errorf("Human Gate is already resolved")
	}
	if current.ReceiptRef != nil {
		return PrepareResult{}, fmt.Errorf("Human Gate already has an unconsumed Human Input Receipt")
	}
	if proposal.IntentID != freeze.IntentID || proposal.Scope != freeze.Scope || proposal.SubjectSHA256 != freeze.SubjectRef.SHA256 {
		return PrepareResult{}, fmt.Errorf("Human Action Proposal does not bind the pending Review Freeze")
	}
	if !contains(freeze.AllowedActions, proposal.Action) {
		return PrepareResult{}, fmt.Errorf("Human Action Proposal action is not allowed by the Review Freeze")
	}
	normalized, err := normalizeObject(proposal.Parameters)
	if err != nil {
		return PrepareResult{}, err
	}
	proposal.Parameters = normalized

	if current.EnvelopeRef != nil {
		existing, existingRef, err := readEnvelope(projectDir, *current.EnvelopeRef)
		if err != nil {
			return PrepareResult{}, err
		}
		if sameProposal(existing, proposal) {
			confirmation := Confirmation(freeze, existingRef)
			return PrepareResult{Envelope: existing, EnvelopeReference: existingRef, ReviewReference: *current.DecisionReview, Confirmation: confirmation}, nil
		}
	}
	if preparedAt == "" {
		preparedAt = now()
	}
	if err := timestamp(preparedAt, "prepared_at"); err != nil {
		return PrepareResult{}, err
	}
	seed := strings.Join([]string{freezeRef.SHA256, proposal.Action, proposal.Reason, string(proposal.Parameters), preparedAt}, "\x00")
	envelopeID := "envelope-" + strings.TrimPrefix(digest.Bytes([]byte(seed)), "sha256:")[:24]
	envelope := Envelope{
		SchemaVersion: 1, Artifact: "human-decision-envelope", Version: 1,
		EnvelopeID: envelopeID, IntentID: freeze.IntentID, Scope: freeze.Scope,
		FreezeRef: freezeRef, SubjectRef: freeze.SubjectRef,
		Action: proposal.Action, Reason: proposal.Reason, Parameters: normalized,
		ProposedBy: proposal.ProposedBy, PreparedAt: preparedAt,
	}
	if err := envelope.Validate(); err != nil {
		return PrepareResult{}, err
	}
	envelopeRef, _, err := writeCanonicalImmutable(projectDir, EnvelopePath(recordDir, freeze.FreezeID, envelopeID), envelope.Artifact, 1, envelope)
	if err != nil {
		return PrepareResult{}, err
	}
	confirmation := Confirmation(freeze, envelopeRef)
	reviewBytes := []byte(renderDecisionReview(freeze, envelope, envelopeRef, confirmation))
	reviewPath := DecisionReviewPath(recordDir, freeze.FreezeID, envelopeID)
	if err := writeImmutable(projectDir, reviewPath, reviewBytes); err != nil {
		return PrepareResult{}, err
	}
	reviewRef, err := reference(projectDir, reviewPath, "human-decision-review", 1, reviewBytes)
	if err != nil {
		return PrepareResult{}, err
	}
	current.EnvelopeRef = &envelopeRef
	current.DecisionReview = &reviewRef
	current.ReceiptRef = nil
	current.UpdatedAt = preparedAt
	if err := writeCurrent(projectDir, recordDir, current); err != nil {
		return PrepareResult{}, err
	}
	return PrepareResult{Envelope: envelope, EnvelopeReference: envelopeRef, ReviewReference: reviewRef, Confirmation: confirmation}, nil
}

// Confirmation returns the only prompt form that the Receipt Hook recognizes.
func Confirmation(freeze Freeze, envelopeRef contract.ArtifactReference) string {
	return strings.Join([]string{"/aidlc-confirm", freeze.FreezeID, envelopeRef.SHA256, freeze.ConfirmationCode}, " ")
}

// Capture records an exact UserPromptSubmit confirmation. Ordinary prompts are
// metadata-only no-ops and are never persisted by this package.
func Capture(ctx context.Context, projectDir, recordDir, harness, sessionID, turnID, prompt, observedAt string) (CaptureResult, error) {
	if !strings.HasPrefix(prompt, "/aidlc-confirm") {
		return CaptureResult{}, nil
	}
	var result CaptureResult
	err := lock.With(ctx, projectDir, lock.Options{}, func(context.Context) error {
		var err error
		result, err = captureLocked(projectDir, recordDir, harness, sessionID, turnID, prompt, observedAt)
		return err
	})
	return result, err
}

func captureLocked(projectDir, recordDir, harness, sessionID, turnID, prompt, observedAt string) (CaptureResult, error) {
	parts := strings.Split(prompt, " ")
	if len(parts) != 4 || strings.Join(parts, " ") != prompt || parts[0] != "/aidlc-confirm" {
		return CaptureResult{Matched: true}, fmt.Errorf("Human Gate confirmation must exactly match the generated one-line command")
	}
	if harness != "codex" {
		return CaptureResult{Matched: true}, fmt.Errorf("unsupported Human Receipt harness: %s", harness)
	}
	if err := oneLine(sessionID, "session_id"); err != nil {
		return CaptureResult{Matched: true}, err
	}
	if turnID != "" {
		if err := oneLine(turnID, "turn_id"); err != nil {
			return CaptureResult{Matched: true}, err
		}
	}
	current, freeze, freezeRef, err := ReadCurrent(projectDir, recordDir)
	if err != nil {
		return CaptureResult{Matched: true}, err
	}
	if current.Status != StatusPending || current.EnvelopeRef == nil {
		return CaptureResult{Matched: true}, fmt.Errorf("Human Gate has no pending Decision Envelope")
	}
	if parts[1] != freeze.FreezeID || parts[2] != current.EnvelopeRef.SHA256 || parts[3] != freeze.ConfirmationCode {
		return CaptureResult{Matched: true}, fmt.Errorf("Human Gate confirmation is stale or belongs to another review")
	}
	envelope, envelopeRef, err := readEnvelope(projectDir, *current.EnvelopeRef)
	if err != nil {
		return CaptureResult{Matched: true}, err
	}
	if current.ReceiptRef != nil {
		receipt, receiptRef, err := readReceipt(projectDir, *current.ReceiptRef)
		if err != nil {
			return CaptureResult{Matched: true}, err
		}
		if receipt.EnvelopeRef == envelopeRef && receipt.SessionID == sessionID && receipt.TurnID == turnID {
			return CaptureResult{Matched: true, Receipt: &receipt, ReceiptReference: &receiptRef}, nil
		}
		return CaptureResult{Matched: true}, fmt.Errorf("Human Gate already has a different unconsumed Receipt")
	}
	if observedAt == "" {
		observedAt = now()
	}
	if err := timestamp(observedAt, "observed_at"); err != nil {
		return CaptureResult{Matched: true}, err
	}
	seed := strings.Join([]string{envelopeRef.SHA256, sessionID, turnID, observedAt}, "\x00")
	receiptID := "receipt-" + strings.TrimPrefix(digest.Bytes([]byte(seed)), "sha256:")[:24]
	receipt := Receipt{
		SchemaVersion: 1, Artifact: "human-input-receipt", Version: 1,
		ReceiptID: receiptID, IntentID: freeze.IntentID, Scope: freeze.Scope,
		FreezeRef: freezeRef, EnvelopeRef: envelopeRef, Action: envelope.Action,
		Harness: harness, SessionID: sessionID, TurnID: turnID, ObservedAt: observedAt,
	}
	if err := receipt.Validate(); err != nil {
		return CaptureResult{Matched: true}, err
	}
	receiptRef, _, err := writeCanonicalImmutable(projectDir, ReceiptPath(recordDir, freeze.FreezeID, receiptID), receipt.Artifact, 1, receipt)
	if err != nil {
		return CaptureResult{Matched: true}, err
	}
	current.ReceiptRef = &receiptRef
	current.UpdatedAt = observedAt
	if err := writeCurrent(projectDir, recordDir, current); err != nil {
		return CaptureResult{Matched: true}, err
	}
	return CaptureResult{Matched: true, Receipt: &receipt, ReceiptReference: &receiptRef}, nil
}

// ValidateProof validates the active state binding and constructs a Proof for
// exactly one action. The caller supplies current State values to reject resume
// or plan drift.
func ValidateProof(projectDir, recordDir, receiptSHA, intentID, scope, graphVersion string, planRevision int) (Proof, error) {
	current, freeze, freezeRef, err := ReadCurrent(projectDir, recordDir)
	if err != nil {
		return Proof{}, err
	}
	if current.Status != StatusPending || current.EnvelopeRef == nil || current.ReceiptRef == nil {
		return Proof{}, fmt.Errorf("Human Gate has no pending, receipted Decision Envelope")
	}
	if current.ReceiptRef.SHA256 != receiptSHA {
		return Proof{}, fmt.Errorf("Human Input Receipt SHA-256 does not match current Receipt")
	}
	if freeze.IntentID != intentID || freeze.Scope != scope || freeze.GraphVersion != graphVersion || freeze.PlanRevision != planRevision {
		return Proof{}, fmt.Errorf("Human Input Receipt is stale for the active Intent, scope, Graph, or Plan revision")
	}
	envelope, envelopeRef, err := readEnvelope(projectDir, *current.EnvelopeRef)
	if err != nil {
		return Proof{}, err
	}
	receipt, receiptRef, err := readReceipt(projectDir, *current.ReceiptRef)
	if err != nil {
		return Proof{}, err
	}
	if envelope.FreezeRef != freezeRef || envelope.SubjectRef != freeze.SubjectRef ||
		receipt.FreezeRef != freezeRef || receipt.EnvelopeRef != envelopeRef ||
		receipt.IntentID != envelope.IntentID || receipt.Scope != envelope.Scope || receipt.Action != envelope.Action {
		return Proof{}, fmt.Errorf("Human Input Receipt does not bind the current Decision Envelope and Review Freeze")
	}
	return Proof{valid: true, freeze: freeze, freezeRef: freezeRef, envelope: envelope, envelopeRef: envelopeRef, receipt: receipt, receiptRef: receiptRef}, nil
}

// Require rejects a manufactured, stale, differently-scoped, or differently
// parameterized Proof before a Stage or Risk mutation.
func (proof Proof) Require(scope, action, subjectSHA string) error {
	if !proof.valid {
		return fmt.Errorf("explicit Human Input Receipt proof is required")
	}
	if proof.freeze.Scope != scope || proof.envelope.Action != action || proof.freeze.SubjectRef.SHA256 != subjectSHA {
		return fmt.Errorf("Human Input Receipt proof does not authorize this exact action and subject")
	}
	return nil
}

func (proof Proof) Parameters(target any) error {
	if !proof.valid {
		return fmt.Errorf("explicit Human Input Receipt proof is required")
	}
	decoder := json.NewDecoder(strings.NewReader(string(proof.envelope.Parameters)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("Human Decision parameters contain a trailing value")
		}
		return fmt.Errorf("Human Decision parameters contain invalid trailing JSON: %w", err)
	}
	return nil
}

func (proof Proof) Reason() string                                { return proof.envelope.Reason }
func (proof Proof) Action() string                                { return proof.envelope.Action }
func (proof Proof) Scope() string                                 { return proof.envelope.Scope }
func (proof Proof) SubjectReference() contract.ArtifactReference  { return proof.freeze.SubjectRef }
func (proof Proof) Receipt() Receipt                              { return proof.receipt }
func (proof Proof) ReceiptReference() contract.ArtifactReference  { return proof.receiptRef }
func (proof Proof) EnvelopeReference() contract.ArtifactReference { return proof.envelopeRef }

// Resolve consumes a Proof once and closes the pending Freeze. decisionRef may
// be nil for a human request-revision whose Resolution is itself the decision.
func Resolve(ctx context.Context, projectDir, recordDir string, proof Proof, decisionRef *contract.ArtifactReference, outcome, resolvedAt string) (Resolution, contract.ArtifactReference, error) {
	var resolution Resolution
	var resolutionRef contract.ArtifactReference
	err := lock.With(ctx, projectDir, lock.Options{}, func(context.Context) error {
		if !proof.valid {
			return fmt.Errorf("explicit Human Input Receipt proof is required")
		}
		current, freeze, freezeRef, err := ReadCurrent(projectDir, recordDir)
		if err != nil {
			return err
		}
		if current.Status != StatusPending || current.EnvelopeRef == nil || current.ReceiptRef == nil ||
			*current.EnvelopeRef != proof.envelopeRef || *current.ReceiptRef != proof.receiptRef || freezeRef != proof.freezeRef {
			return fmt.Errorf("Human Input Receipt was already consumed or is no longer current")
		}
		if decisionRef != nil {
			if _, err := policy.VerifyProjectArtifactReference(projectDir, *decisionRef); err != nil {
				return err
			}
		}
		if err := oneLine(outcome, "outcome"); err != nil {
			return err
		}
		if resolvedAt == "" {
			resolvedAt = proof.receipt.ObservedAt
		}
		seed := strings.Join([]string{proof.receiptRef.SHA256, proof.envelope.Action, outcome}, "\x00")
		resolutionID := "resolution-" + strings.TrimPrefix(digest.Bytes([]byte(seed)), "sha256:")[:24]
		resolution = Resolution{
			SchemaVersion: 1, Artifact: "human-gate-resolution", Version: 1,
			ResolutionID: resolutionID, IntentID: freeze.IntentID, Scope: freeze.Scope,
			FreezeRef: freezeRef, EnvelopeRef: proof.envelopeRef, ReceiptRef: proof.receiptRef,
			DecisionRef: cloneRef(decisionRef), Action: proof.envelope.Action, Outcome: outcome, ResolvedAt: resolvedAt,
		}
		if err := resolution.Validate(); err != nil {
			return err
		}
		resolutionRef, _, err = writeCanonicalImmutable(projectDir, ResolutionPath(recordDir, freeze.FreezeID), resolution.Artifact, 1, resolution)
		if err != nil {
			return err
		}
		current.Status = StatusResolved
		current.ResolutionRef = &resolutionRef
		current.UpdatedAt = resolvedAt
		return writeCurrent(projectDir, recordDir, current)
	})
	return resolution, resolutionRef, err
}

func readEnvelope(projectDir string, reference contract.ArtifactReference) (Envelope, contract.ArtifactReference, error) {
	path, err := policy.VerifyProjectArtifactReference(projectDir, reference)
	if err != nil {
		return Envelope{}, contract.ArtifactReference{}, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return Envelope{}, contract.ArtifactReference{}, err
	}
	value, err := jsonx.Decode[Envelope](content)
	if err != nil {
		return Envelope{}, contract.ArtifactReference{}, err
	}
	if err := value.Validate(); err != nil {
		return Envelope{}, contract.ArtifactReference{}, err
	}
	if reference.Artifact != value.Artifact || reference.Version != value.Version {
		return Envelope{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Envelope reference identity differs")
	}
	return value, reference, nil
}

func readReceipt(projectDir string, reference contract.ArtifactReference) (Receipt, contract.ArtifactReference, error) {
	path, err := policy.VerifyProjectArtifactReference(projectDir, reference)
	if err != nil {
		return Receipt{}, contract.ArtifactReference{}, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return Receipt{}, contract.ArtifactReference{}, err
	}
	value, err := jsonx.Decode[Receipt](content)
	if err != nil {
		return Receipt{}, contract.ArtifactReference{}, err
	}
	if err := value.Validate(); err != nil {
		return Receipt{}, contract.ArtifactReference{}, err
	}
	if reference.Artifact != value.Artifact || reference.Version != value.Version {
		return Receipt{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Receipt reference identity differs")
	}
	return value, reference, nil
}

func readResolution(projectDir string, reference contract.ArtifactReference) (Resolution, contract.ArtifactReference, error) {
	path, err := policy.VerifyProjectArtifactReference(projectDir, reference)
	if err != nil {
		return Resolution{}, contract.ArtifactReference{}, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return Resolution{}, contract.ArtifactReference{}, err
	}
	value, err := jsonx.Decode[Resolution](content)
	if err != nil {
		return Resolution{}, contract.ArtifactReference{}, err
	}
	if err := value.Validate(); err != nil {
		return Resolution{}, contract.ArtifactReference{}, err
	}
	if reference.Artifact != value.Artifact || reference.Version != value.Version {
		return Resolution{}, contract.ArtifactReference{}, fmt.Errorf("Human Gate Resolution reference identity differs")
	}
	return value, reference, nil
}

// VerifyReceipt validates one historical Receipt without relying on the mutable
// Current pointer. Doctor and historical decision readers use it after a later
// Human Gate cycle has replaced Current.
func VerifyReceipt(projectDir string, reference contract.ArtifactReference) (Receipt, error) {
	receipt, _, err := readReceipt(projectDir, reference)
	if err != nil {
		return Receipt{}, err
	}
	envelope, envelopeRef, err := readEnvelope(projectDir, receipt.EnvelopeRef)
	if err != nil {
		return Receipt{}, err
	}
	freeze, freezeRef, err := readFreeze(projectDir, receipt.FreezeRef)
	if err != nil {
		return Receipt{}, err
	}
	if err := verifyFreezeBytes(projectDir, freeze); err != nil {
		return Receipt{}, err
	}
	if envelopeRef != receipt.EnvelopeRef || freezeRef != receipt.FreezeRef ||
		envelope.FreezeRef != freezeRef || envelope.SubjectRef != freeze.SubjectRef ||
		receipt.IntentID != freeze.IntentID || receipt.Scope != freeze.Scope ||
		envelope.IntentID != freeze.IntentID || envelope.Scope != freeze.Scope || receipt.Action != envelope.Action ||
		!contains(freeze.AllowedActions, envelope.Action) {
		return Receipt{}, fmt.Errorf("historical Human Input Receipt does not bind its Envelope and Review Freeze")
	}
	return receipt, nil
}

func sameProposal(envelope Envelope, proposal ActionProposal) bool {
	return envelope.IntentID == proposal.IntentID && envelope.Scope == proposal.Scope &&
		envelope.SubjectRef.SHA256 == proposal.SubjectSHA256 && envelope.Action == proposal.Action &&
		envelope.Reason == proposal.Reason && string(envelope.Parameters) == string(proposal.Parameters) &&
		envelope.ProposedBy == proposal.ProposedBy
}

func normalizeObject(content json.RawMessage) (json.RawMessage, error) {
	value, err := jsonx.Decode[map[string]json.RawMessage](content)
	if err != nil || value == nil {
		return nil, fmt.Errorf("parameters must be one JSON object")
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(normalized), nil
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func renderDecisionReview(freeze Freeze, envelope Envelope, envelopeRef contract.ArtifactReference, confirmation string) string {
	parameters, _ := json.MarshalIndent(envelope.Parameters, "", "  ")
	return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>AI-DLC Human Decision</title>" +
		"<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;line-height:1.5}" +
		"code,pre{background:#f4f4f4;padding:.2rem .4rem;overflow:auto}dt{font-weight:700;margin-top:1rem}</style></head><body>" +
		"<h1>Human Decision Review</h1><p>This page is generated from immutable Core artifacts. Confirm only after reviewing every value.</p><dl>" +
		"<dt>Intent</dt><dd><code>" + html.EscapeString(envelope.IntentID) + "</code></dd>" +
		"<dt>Scope</dt><dd><code>" + html.EscapeString(envelope.Scope) + "</code></dd>" +
		"<dt>Subject SHA-256</dt><dd><code>" + html.EscapeString(freeze.SubjectRef.SHA256) + "</code></dd>" +
		"<dt>Original Review SHA-256</dt><dd><code>" + html.EscapeString(freeze.ReviewRef.SHA256) + "</code></dd>" +
		"<dt>Action</dt><dd><code>" + html.EscapeString(envelope.Action) + "</code></dd>" +
		"<dt>Reason</dt><dd>" + html.EscapeString(envelope.Reason) + "</dd>" +
		"<dt>Envelope SHA-256</dt><dd><code>" + html.EscapeString(envelopeRef.SHA256) + "</code></dd></dl>" +
		"<h2>Exact parameters</h2><pre>" + html.EscapeString(string(parameters)) + "</pre>" +
		"<h2>Explicit confirmation</h2><p>Send this exact one-line message in Codex:</p><pre>" + html.EscapeString(confirmation) + "</pre>" +
		"</body></html>\n"
}
