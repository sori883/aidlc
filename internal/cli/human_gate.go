package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/stage/st04architecture"
	"github.com/sori883/aidlc/internal/stage/st05buildcontract"
	"github.com/sori883/aidlc/internal/stage/st07review"
	"github.com/sori883/aidlc/internal/stage/st08release"
	"github.com/sori883/aidlc/internal/stage/st09outcome"
	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	"github.com/sori883/aidlc/internal/workflow/risk"
	"github.com/sori883/aidlc/internal/workflow/state"
)

type humanGateApplyResult struct {
	Action              string                     `json:"action"`
	ActionResult        any                        `json:"actionResult"`
	Resolution          humanapproval.Resolution   `json:"resolution"`
	ResolutionReference contract.ArtifactReference `json:"resolutionReference"`
}

func runHumanGate(ctx context.Context, args []string, stdout, stderr io.Writer, coreDir string) int {
	if len(args) < 3 {
		return writeError(stderr, "Usage: aidlc human-gate <status|prepare|apply> <project-dir> [human-action-proposal.json|receipt-sha256]")
	}
	projectDir, err := filepath.Abs(args[2])
	if err != nil {
		return writeError(stderr, err.Error())
	}
	projectDir, err = filepath.EvalSymlinks(filepath.Clean(projectDir))
	if err != nil {
		return writeError(stderr, err.Error())
	}
	snapshot, err := state.Resume(projectDir)
	if err != nil {
		return writeError(stderr, err.Error())
	}
	switch args[1] {
	case "status":
		if len(args) != 3 {
			return writeError(stderr, "Usage: aidlc human-gate status <project-dir>")
		}
		current, freeze, freezeRef, err := humanapproval.ReadCurrent(projectDir, snapshot.RecordDir)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, struct {
			Current         humanapproval.Current      `json:"current"`
			Freeze          humanapproval.Freeze       `json:"freeze"`
			FreezeReference contract.ArtifactReference `json:"freezeReference"`
		}{current, freeze, freezeRef}, true)
	case "prepare":
		if len(args) != 4 {
			return writeError(stderr, "Usage: aidlc human-gate prepare <project-dir> <human-action-proposal.json>")
		}
		content, err := readJSONBytes(args[3])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		proposal, err := humanapproval.DecodeActionProposal(content)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		if proposal.IntentID != snapshot.State.IntentID {
			return writeError(stderr, "Human Action Proposal belongs to another Intent")
		}
		if proposal.Scope == humanapproval.ScopeRisk {
			_, subjectRef, _, err := risk.ReadCurrent(projectDir, snapshot.RecordDir)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			if _, err := humanapproval.Open(ctx, projectDir, snapshot.RecordDir, humanapproval.OpenOptions{
				IntentID: snapshot.State.IntentID, Scope: humanapproval.ScopeRisk,
				SubjectRef: subjectRef, ReviewRef: subjectRef,
				GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision,
				AllowedActions: []string{string(risk.Dismiss), string(risk.Resolve), string(risk.SetSeverity)},
			}); err != nil {
				return writeError(stderr, err.Error())
			}
		} else if proposal.Scope != string(snapshot.State.CurrentStage) {
			return writeError(stderr, "Human Action Proposal scope is not the active Stage")
		}
		if err := validateHumanActionProposal(proposal); err != nil {
			return writeError(stderr, err.Error())
		}
		result, err := humanapproval.Prepare(ctx, projectDir, snapshot.RecordDir, proposal, "")
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, result, true)
	case "apply":
		if len(args) != 4 {
			return writeError(stderr, "Usage: aidlc human-gate apply <project-dir> <receipt-sha256>")
		}
		code := 1
		lockErr := lock.With(ctx, projectDir, lock.Options{}, func(lockContext context.Context) error {
			lockedSnapshot, resumeErr := state.Resume(projectDir)
			if resumeErr != nil {
				code = writeError(stderr, resumeErr.Error())
				return nil
			}
			current, _, _, readErr := humanapproval.ReadCurrent(projectDir, lockedSnapshot.RecordDir)
			if readErr != nil {
				code = writeError(stderr, readErr.Error())
				return nil
			}
			proof, proofErr := humanapproval.ValidateProof(projectDir, lockedSnapshot.RecordDir, args[3], lockedSnapshot.State.IntentID, current.Scope, lockedSnapshot.State.GraphVersion, lockedSnapshot.State.PlanRevision)
			if proofErr != nil {
				code = writeError(stderr, proofErr.Error())
				return nil
			}
			code = applyHumanGate(lockContext, projectDir, lockedSnapshot.RecordDir, coreDir, proof, stdout, stderr)
			return nil
		})
		if lockErr != nil {
			return writeError(stderr, lockErr.Error())
		}
		return code
	default:
		return writeError(stderr, "Usage: aidlc human-gate <status|prepare|apply> <project-dir> [human-action-proposal.json|receipt-sha256]")
	}
}

func validateHumanActionProposal(proposal humanapproval.ActionProposal) error {
	empty := func() error {
		value, err := jsonx.Decode[map[string]json.RawMessage](proposal.Parameters)
		if err != nil {
			return err
		}
		if len(value) != 0 {
			return fmt.Errorf("request-revision parameters must be an empty object")
		}
		return nil
	}
	switch proposal.Scope {
	case string(contract.Stage04):
		if proposal.Action == "request-revision" {
			return empty()
		}
		if proposal.Action != "approve-architecture-policy" {
			return fmt.Errorf("invalid ST-04 Human Action")
		}
		value, err := jsonx.Decode[st04architecture.ApprovalParameters](proposal.Parameters)
		if err == nil && value.PolicyAcknowledgements == nil {
			err = fmt.Errorf("policy_acknowledgements must be an array")
		}
		return err
	case string(contract.Stage05):
		if proposal.Action == "request-revision" {
			return empty()
		}
		if proposal.Action != "approve-build-contract" {
			return fmt.Errorf("invalid ST-05 Human Action")
		}
		value, err := jsonx.Decode[st05buildcontract.ApprovalParameters](proposal.Parameters)
		if err == nil && value.PolicyAcknowledgements == nil {
			err = fmt.Errorf("policy_acknowledgements must be an array")
		}
		return err
	case string(contract.Stage07):
		if proposal.Action != "approve-runnable-candidate" && proposal.Action != "request-changes" {
			return fmt.Errorf("invalid ST-07 Human Action")
		}
		value, err := jsonx.Decode[st07review.DecisionParameters](proposal.Parameters)
		if err == nil && (value.PolicyAcknowledgements == nil || value.HumanCheckResults == nil || value.FeedbackItems == nil) {
			err = fmt.Errorf("ST-07 parameter collections must be arrays")
		}
		return err
	case string(contract.Stage08):
		if proposal.Action == "request-revision" {
			return empty()
		}
		if proposal.Action != "authorize-release" {
			return fmt.Errorf("invalid ST-08 Human Action")
		}
		value, err := jsonx.Decode[st08release.AuthorizationParameters](proposal.Parameters)
		if err == nil && value.PolicyAcknowledgements == nil {
			err = fmt.Errorf("policy_acknowledgements must be an array")
		}
		return err
	case string(contract.Stage09):
		if proposal.Action != "continue-observation" && proposal.Action != "complete-with-outcome" && proposal.Action != "complete-and-draft-follow-up" {
			return fmt.Errorf("invalid ST-09 Human Action")
		}
		value, err := jsonx.Decode[st09outcome.DecisionParameters](proposal.Parameters)
		if err == nil && value.PolicyAcknowledgements == nil {
			err = fmt.Errorf("policy_acknowledgements must be an array")
		}
		return err
	case humanapproval.ScopeRisk:
		if proposal.Action != string(risk.Dismiss) && proposal.Action != string(risk.Resolve) && proposal.Action != string(risk.SetSeverity) {
			return fmt.Errorf("invalid Intent Risk Human Action")
		}
		value, err := jsonx.Decode[risk.DecisionParameters](proposal.Parameters)
		if err == nil && value.EvidenceRefs == nil {
			err = fmt.Errorf("evidence_refs must be an array")
		}
		return err
	default:
		return fmt.Errorf("unsupported Human Action scope")
	}
}

func applyHumanGate(ctx context.Context, projectDir, recordDir, coreDir string, proof humanapproval.Proof, stdout, stderr io.Writer) int {
	var actionResult any
	var decisionRef *contract.ArtifactReference
	var outcome string
	var event audit.Event
	var resolution humanapproval.Resolution
	var resolutionRef contract.ArtifactReference

	switch proof.Scope() {
	case string(contract.Stage04):
		if proof.Action() == "request-revision" {
			outcome, event = "revision-requested", audit.GateRejected
			break
		}
		result, err := st04architecture.ApprovePolicy(ctx, projectDir, coreDir, proof)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		actionResult, decisionRef, outcome, event = result, &result.ApprovalReference, "approved", audit.GateApproved
		resolution, resolutionRef = result.HumanGateResolution, result.HumanGateResolutionRef
	case string(contract.Stage05):
		if proof.Action() == "request-revision" {
			outcome, event = "revision-requested", audit.GateRejected
			break
		}
		result, err := st05buildcontract.Approve(ctx, projectDir, coreDir, proof)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		actionResult, decisionRef, outcome, event = result, &result.ApprovalReference, "approved", audit.GateApproved
		resolution, resolutionRef = result.HumanGateResolution, result.HumanGateResolutionRef
	case string(contract.Stage07):
		var result st07review.DecisionResult
		var err error
		if proof.Action() == "approve-runnable-candidate" {
			result, err = st07review.Approve(ctx, projectDir, coreDir, proof)
			outcome, event = "approved", audit.GateApproved
		} else {
			result, err = st07review.Feedback(ctx, projectDir, coreDir, proof)
			outcome, event = "changes-requested", audit.GateRejected
		}
		if err != nil {
			return writeError(stderr, err.Error())
		}
		actionResult, decisionRef = result, &result.DecisionReference
		resolution, resolutionRef = result.HumanGateResolution, result.HumanGateResolutionRef
	case string(contract.Stage08):
		if proof.Action() == "request-revision" {
			outcome, event = "revision-requested", audit.GateRejected
			break
		}
		result, err := st08release.Authorize(ctx, projectDir, coreDir, proof)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		actionResult, decisionRef, outcome, event = result, &result.AuthorityReference, "authorized", audit.GateApproved
		resolution, resolutionRef = result.HumanGateResolution, result.HumanGateResolutionRef
	case string(contract.Stage09):
		result, err := st09outcome.Decide(ctx, projectDir, coreDir, proof)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		actionResult, decisionRef, outcome, event = result, &result.DecisionReference, result.Outcome, audit.GateApproved
		resolution, resolutionRef = result.HumanGateResolution, result.HumanGateResolutionRef
	case humanapproval.ScopeRisk:
		result, err := risk.Decide(ctx, projectDir, recordDir, proof)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		actionResult, decisionRef, outcome, event = result, &result.DecisionReference, "recorded", audit.GateApproved
		resolution, resolutionRef = result.HumanGateResolution, result.HumanGateResolutionRef
	default:
		return writeError(stderr, "unsupported Human Gate scope")
	}

	if resolutionRef.SHA256 == "" {
		var err error
		resolution, resolutionRef, err = humanapproval.Resolve(ctx, projectDir, recordDir, proof, decisionRef, outcome, "")
		if err != nil {
			return writeError(stderr, err.Error())
		}
	}
	if outcome == "revision-requested" {
		if err := parkRevisionRequest(ctx, projectDir, recordDir, proof); err != nil {
			return writeError(stderr, err.Error())
		}
	}
	fields := []audit.Field{
		{Name: "Scope", Value: proof.Scope()}, {Name: "Action", Value: proof.Action()},
		{Name: "Subject SHA-256", Value: proof.SubjectReference().SHA256},
		{Name: "Human Receipt SHA-256", Value: proof.ReceiptReference().SHA256},
		{Name: "Resolution SHA-256", Value: resolutionRef.SHA256}, {Name: "Decision Authority", Value: "human"},
	}
	if _, err := audit.Append(ctx, projectDir, recordDir, event, fields, nil); err != nil {
		return writeError(stderr, err.Error())
	}
	return writeJSON(stdout, stderr, humanGateApplyResult{Action: proof.Action(), ActionResult: actionResult, Resolution: resolution, ResolutionReference: resolutionRef}, true)
}

func parkRevisionRequest(ctx context.Context, projectDir, recordDir string, proof humanapproval.Proof) error {
	snapshot, err := state.Read(recordDir)
	if err != nil {
		return err
	}
	reason := proof.Scope() + " review was rejected by an explicit human Receipt; a revised proposal is required."
	snapshot.State.Status = state.Parked
	snapshot.State.ParkedReason = &reason
	snapshot.State.NotBefore = nil
	snapshot.State.Deadline = nil
	snapshot.State.UpdatedAt = proof.Receipt().ObservedAt
	return state.Store(ctx, projectDir, recordDir, snapshot.State, snapshot.Plan)
}

func readJSONBytes(path string) ([]byte, error) {
	value, err := readJSONFile[json.RawMessage](path)
	if err != nil {
		return nil, err
	}
	return []byte(value), nil
}
