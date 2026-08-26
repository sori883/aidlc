// Package st09outcome implements terminal, evidence-bound Outcome Evaluation.
package st09outcome

import (
	"context"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st02defineintent"
	"github.com/sori883/aidlc/internal/stage/st03requirements"
	"github.com/sori883/aidlc/internal/stage/st07review"
	"github.com/sori883/aidlc/internal/stage/st08release"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/gate"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/state"
)

type Signal struct {
	SignalID             string   `json:"signal_id"`
	SourceArtifact       string   `json:"source_artifact"`
	SourcePointer        string   `json:"source_pointer"`
	Statement            string   `json:"statement"`
	Required             bool     `json:"required"`
	AllowedEvidenceTypes []string `json:"allowed_evidence_types"`
}
type WorkRequest struct {
	SchemaVersion       int                         `json:"schema_version"`
	Artifact            string                      `json:"artifact"`
	Version             int                         `json:"version"`
	Revision            int                         `json:"revision"`
	IntentID            string                      `json:"intent_id"`
	StageID             contract.StageID            `json:"stage_id"`
	IntentDefinitionRef contract.ArtifactReference  `json:"intent_definition_ref"`
	RequirementsRef     contract.ArtifactReference  `json:"requirements_ref"`
	ReviewManifestRef   *contract.ArtifactReference `json:"review_manifest_ref"`
	ReleaseCurrentRef   contract.ArtifactReference  `json:"release_current_ref"`
	ReleaseOutcome      string                      `json:"release_outcome"`
	EffectivePolicyRef  contract.ArtifactReference  `json:"effective_policy_ref"`
	Signals             []Signal                    `json:"signals"`
	NotBefore           string                      `json:"not_before"`
	Deadline            *string                     `json:"deadline"`
	RequestedOutput     string                      `json:"requested_output"`
	Rules               []string                    `json:"rules"`
	CreatedAt           string                      `json:"created_at"`
}
type Observation struct {
	SignalID     string                       `json:"signal_id"`
	Result       string                       `json:"result"`
	EvidenceRefs []contract.ArtifactReference `json:"evidence_refs"`
	Reason       string                       `json:"reason"`
	ObservedAt   string                       `json:"observed_at"`
}
type Proposal struct {
	SchemaVersion     int           `json:"schema_version"`
	Artifact          string        `json:"artifact"`
	Version           int           `json:"version"`
	ProposalID        string        `json:"proposal_id"`
	IntentID          string        `json:"intent_id"`
	WorkRequestSHA256 string        `json:"work_request_sha256"`
	Observations      []Observation `json:"observations"`
	Reason            string        `json:"reason"`
	ProposedBy        string        `json:"proposed_by"`
}
type Evidence struct {
	SchemaVersion  int                        `json:"schema_version"`
	Artifact       string                     `json:"artifact"`
	Version        int                        `json:"version"`
	Revision       int                        `json:"revision"`
	EvidenceID     string                     `json:"evidence_id"`
	IntentID       string                     `json:"intent_id"`
	WorkRequestRef contract.ArtifactReference `json:"work_request_ref"`
	Observations   []Observation              `json:"observations"`
	CollectedAt    string                     `json:"collected_at"`
}
type Evaluation struct {
	SchemaVersion         int                        `json:"schema_version"`
	Artifact              string                     `json:"artifact"`
	Version               int                        `json:"version"`
	Revision              int                        `json:"revision"`
	EvaluationID          string                     `json:"evaluation_id"`
	IntentID              string                     `json:"intent_id"`
	StageID               contract.StageID           `json:"stage_id"`
	Disposition           contract.Disposition       `json:"disposition"`
	WorkRequestRef        contract.ArtifactReference `json:"work_request_ref"`
	OutcomeEvidenceRef    contract.ArtifactReference `json:"outcome_evidence_ref"`
	GateRequirementSetRef contract.ArtifactReference `json:"gate_requirement_set_ref"`
	ReleaseOutcome        string                     `json:"release_outcome"`
	SignalResults         []Observation              `json:"signal_results"`
	OverallResult         string                     `json:"overall_result"`
	Reason                string                     `json:"reason"`
	EvaluatedAt           string                     `json:"evaluated_at"`
}
type HumanDecision struct {
	SchemaVersion          int                        `json:"schema_version"`
	Artifact               string                     `json:"artifact"`
	Version                int                        `json:"version"`
	DecisionID             string                     `json:"decision_id"`
	IntentID               string                     `json:"intent_id"`
	OutcomeEvaluationRef   contract.ArtifactReference `json:"outcome_evaluation_ref"`
	GateRequirementSetRef  contract.ArtifactReference `json:"gate_requirement_set_ref"`
	PolicyAcknowledgements []gate.Acknowledgement     `json:"policy_acknowledgements"`
	Decision               string                     `json:"decision"`
	Reason                 string                     `json:"reason"`
	DecidedBy              string                     `json:"decided_by"`
	DecidedAt              string                     `json:"decided_at"`
	NotBefore              *string                    `json:"not_before"`
	Deadline               *string                    `json:"deadline"`
}
type FollowUpBrief struct {
	SchemaVersion        int                        `json:"schema_version"`
	Artifact             string                     `json:"artifact"`
	Version              int                        `json:"version"`
	BriefID              string                     `json:"brief_id"`
	SourceIntentID       string                     `json:"source_intent_id"`
	OutcomeEvaluationRef contract.ArtifactReference `json:"outcome_evaluation_ref"`
	HumanDecisionRef     contract.ArtifactReference `json:"human_decision_ref"`
	Title                string                     `json:"title"`
	ProblemSummary       string                     `json:"problem_summary"`
	UnresolvedSignalIDs  []string                   `json:"unresolved_signal_ids"`
	CreatedAt            string                     `json:"created_at"`
}
type Current struct {
	SchemaVersion        int                         `json:"schema_version"`
	Artifact             string                      `json:"artifact"`
	Version              int                         `json:"version"`
	IntentID             string                      `json:"intent_id"`
	Disposition          contract.Disposition        `json:"disposition"`
	OverallResult        string                      `json:"overall_result"`
	CompletionMode       string                      `json:"completion_mode"`
	WorkRequestRef       contract.ArtifactReference  `json:"work_request_ref"`
	OutcomeEvidenceRef   contract.ArtifactReference  `json:"outcome_evidence_ref"`
	OutcomeEvaluationRef contract.ArtifactReference  `json:"outcome_evaluation_ref"`
	HumanDecisionRef     *contract.ArtifactReference `json:"human_decision_ref"`
	FollowUpBriefRef     *contract.ArtifactReference `json:"follow_up_brief_ref"`
	Reason               string                      `json:"reason"`
	CompletedAt          string                      `json:"completed_at"`
}
type PrepareOptions struct {
	PreparedAt string
	NotBefore  string
	Deadline   *string
}
type PrepareResult struct {
	Execution string                      `json:"execution"`
	Request   *WorkRequest                `json:"request"`
	Reference *contract.ArtifactReference `json:"reference"`
	State     state.IntentState           `json:"state"`
}
type EvaluateResult struct {
	Outcome             string                      `json:"outcome"`
	Evidence            Evidence                    `json:"evidence"`
	EvidenceReference   contract.ArtifactReference  `json:"evidenceReference"`
	Evaluation          Evaluation                  `json:"evaluation"`
	EvaluationReference contract.ArtifactReference  `json:"evaluationReference"`
	HTMLReference       contract.ArtifactReference  `json:"htmlReference"`
	Current             *Current                    `json:"current"`
	CurrentReference    *contract.ArtifactReference `json:"currentReference"`
	State               state.IntentState           `json:"state"`
}
type DecideOptions struct {
	EvaluationSHA256       string
	Decision               string
	Reason                 string
	PolicyAcknowledgements []gate.Acknowledgement
	NotBefore              *string
	Deadline               *string
	DecidedAt              string
}
type DecideResult struct {
	Outcome           string                      `json:"outcome"`
	Decision          HumanDecision               `json:"decision"`
	DecisionReference contract.ArtifactReference  `json:"decisionReference"`
	FollowUp          *FollowUpBrief              `json:"followUp"`
	FollowUpReference *contract.ArtifactReference `json:"followUpReference"`
	Current           *Current                    `json:"current"`
	CurrentReference  *contract.ArtifactReference `json:"currentReference"`
	State             state.IntentState           `json:"state"`
}
type ReuseResult struct {
	Current                       Current                    `json:"current"`
	CurrentReference              contract.ArtifactReference `json:"currentReference"`
	ReusedOutcomeCurrentReference contract.ArtifactReference `json:"reusedOutcomeCurrentReference"`
	State                         state.IntentState          `json:"state"`
}

func RootDir(recordDir string) string { return filepath.Join(recordDir, "artifacts", "outcome") }
func WorkRequestPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "work-request.json")
}
func WorkRequestRevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "requests", fmt.Sprintf("%06d", revision), "work-request.json")
}
func EvidencePath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "outcome-evidence.json")
}
func EvidenceRevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "outcome-evidence.json")
}
func EvaluationPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "outcome-evaluation.json")
}
func EvaluationRevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "outcome-evaluation.json")
}
func HTMLPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "outcome.html") }
func HTMLRevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "outcome.html")
}
func DecisionPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "review", "human-decision.json")
}
func DecisionRevisionPath(recordDir, decisionID string) string {
	return filepath.Join(RootDir(recordDir), "decisions", decisionID, "human-decision.json")
}
func CurrentPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "current.json") }
func FollowUpPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "follow-up-brief.json")
}

func Prepare(ctx context.Context, projectDir, coreDir string, options PrepareOptions) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage09)
	if err != nil {
		return PrepareResult{}, err
	}
	if current.Snapshot.State.Status == state.Completed {
		return PrepareResult{}, fmt.Errorf("ST-09 Outcome Evaluation: Workflow is already completed")
	}
	intentValue, intentRef, _, err := stageruntime.ReadCanonical[st02defineintent.Definition](current.ProjectDir, st02defineintent.DefinitionPath(current.Snapshot.RecordDir), "intent-definition", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	reqCurrent, _, _, err := stageruntime.ReadCanonical[st03requirements.Current](current.ProjectDir, st03requirements.CurrentPath(current.Snapshot.RecordDir), "requirements-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	reqPath, err := stageruntime.ReadReference(current.ProjectDir, reqCurrent.RequirementsRef)
	if err != nil {
		return PrepareResult{}, err
	}
	requirements, requirementsRef, _, err := stageruntime.ReadCanonical[st03requirements.Definition](current.ProjectDir, reqPath, "requirements-definition", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	release, releaseRef, _, err := stageruntime.ReadCanonical[st08release.Current](current.ProjectDir, st08release.CurrentPath(current.Snapshot.RecordDir), "release-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	reviewValue, reviewRef, _, err := stageruntime.ReadCanonical[st07review.Current](current.ProjectDir, st07review.CurrentPath(current.Snapshot.RecordDir), "review-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if release.ReviewCurrentRef != reviewRef {
		return PrepareResult{}, fmt.Errorf("ST-09 Outcome Evaluation: Release Current does not pin Review Current")
	}
	var manifest *st07review.Manifest
	var manifestRef *contract.ArtifactReference
	if reviewValue.ReviewManifestRef != nil {
		path, err := stageruntime.ReadReference(current.ProjectDir, *reviewValue.ReviewManifestRef)
		if err != nil {
			return PrepareResult{}, err
		}
		value, ref, _, err := stageruntime.ReadCanonical[st07review.Manifest](current.ProjectDir, path, "review-manifest", 1)
		if err != nil {
			return PrepareResult{}, err
		}
		manifest = &value
		manifestRef = &ref
	}
	at := options.PreparedAt
	if at == "" {
		at = stageruntime.Now()
	}
	notBefore := options.NotBefore
	if notBefore == "" {
		if current.Snapshot.State.NotBefore != nil {
			notBefore = *current.Snapshot.State.NotBefore
		} else {
			notBefore = at
		}
	}
	deadline := options.Deadline
	if deadline == nil {
		deadline = current.Snapshot.State.Deadline
	}
	if err := validateWindow(notBefore, deadline); err != nil {
		return PrepareResult{}, err
	}
	revision, err := nextRequestRevision(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return PrepareResult{}, err
	}
	schedule := WorkRequest{SchemaVersion: 1, Artifact: "outcome-work-request", Version: 1, Revision: revision, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage09, IntentDefinitionRef: intentRef, RequirementsRef: requirementsRef, ReviewManifestRef: manifestRef, ReleaseCurrentRef: releaseRef, ReleaseOutcome: release.Outcome, EffectivePolicyRef: current.Snapshot.State.PolicySnapshot, Signals: buildSignals(intentValue, requirements, manifest), NotBefore: notBefore, Deadline: deadline, RequestedOutput: "outcome-evaluation-proposal", Rules: []string{"Assess every signal_id exactly once.", "Use only Project-bound Artifact Evidence or a registered observation/human confirmation recorded outside the AI proposal.", "Do not include shell commands, secrets, a next Stage, a backward route, or a new Intent instruction.", "A rolled_back Release cannot be proposed as an achieved overall Outcome."}, CreatedAt: at}
	_, _, _, requestExists, err := stageruntime.ReadCanonicalIfExists[WorkRequest](current.ProjectDir, WorkRequestPath(current.Snapshot.RecordDir), "outcome-work-request", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if requestExists {
		old, oldRef, err := readCurrentRequest(current.ProjectDir, current.Snapshot.RecordDir)
		if err != nil {
			return PrepareResult{}, err
		}
		if equivalentRequest(old, schedule) {
			return PrepareResult{Execution: "reused", Request: &old, Reference: &oldRef, State: current.Snapshot.State}, nil
		}
	}
	now, _ := time.Parse(time.RFC3339Nano, at)
	start, _ := time.Parse(time.RFC3339Nano, notBefore)
	if now.Before(start) {
		parked, err := parkSchedule(ctx, current, "ST-09 Outcome observation is scheduled for "+notBefore+".", notBefore, deadline, at)
		return PrepareResult{Execution: "waiting", State: parked}, err
	}
	if deadline != nil {
		end, _ := time.Parse(time.RFC3339Nano, *deadline)
		if now.After(end) {
			parked, err := parkSchedule(ctx, current, "ST-09 Outcome observation deadline "+*deadline+" passed; a human must reschedule or decide the Outcome.", notBefore, deadline, at)
			return PrepareResult{Execution: "waiting", State: parked}, err
		}
	}
	if requestExists {
		if err := clearMutableObservationCycle(current.Snapshot.RecordDir); err != nil {
			return PrepareResult{}, err
		}
	}
	immutableRef, content, err := stageruntime.WriteCanonical(current.ProjectDir, WorkRequestRevisionPath(current.Snapshot.RecordDir, schedule.Revision), schedule.Artifact, 1, schedule, true)
	if err != nil {
		return PrepareResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, WorkRequestPath(current.Snapshot.RecordDir), schedule.Artifact, content); err != nil {
		return PrepareResult{}, err
	}
	parked, err := parkSchedule(ctx, current, "ST-09 Outcome Evidence and Evaluation proposal are required.", notBefore, deadline, at)
	if err == nil {
		_, err = audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.StageStarted, []audit.Field{{Name: "Stage", Value: "ST-09"}, {Name: "Work Request SHA-256", Value: immutableRef.SHA256}, {Name: "Signal Count", Value: fmt.Sprint(len(schedule.Signals))}, {Name: "Decision Authority", Value: "core"}}, nil)
	}
	return PrepareResult{Execution: "prepared", Request: &schedule, Reference: &immutableRef, State: parked}, err
}

func Evaluate(ctx context.Context, projectDir, coreDir string, proposalBytes []byte, at string) (EvaluateResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage09)
	if err != nil {
		return EvaluateResult{}, err
	}
	request, requestRef, err := readCurrentRequest(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return EvaluateResult{}, err
	}
	proposal, err := stageruntime.DecodeProposal[Proposal](proposalBytes, validateProposal)
	if err != nil {
		return EvaluateResult{}, err
	}
	if proposal.IntentID != current.Snapshot.State.IntentID || proposal.WorkRequestSHA256 != requestRef.SHA256 {
		return EvaluateResult{}, fmt.Errorf("ST-09 Outcome Evaluation: Proposal does not match Work Request")
	}
	if err := validateObservations(current.ProjectDir, request, proposal.Observations); err != nil {
		return EvaluateResult{}, err
	}
	overall := CalculateResult(proposal.Observations)
	if request.ReleaseOutcome == "rolled_back" && overall == "achieved" {
		return EvaluateResult{}, fmt.Errorf("ST-09 Outcome Evaluation: rolled_back Release cannot be achieved")
	}
	if at == "" {
		at = stageruntime.Now()
	}
	revision, err := nextEvaluationRevision(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return EvaluateResult{}, err
	}
	evidence := Evidence{SchemaVersion: 1, Artifact: "outcome-evidence", Version: 1, Revision: revision, EvidenceID: fmt.Sprintf("outcome-evidence-%03d", revision), IntentID: current.Snapshot.State.IntentID, WorkRequestRef: requestRef, Observations: proposal.Observations, CollectedAt: at}
	evidenceRef, evidenceBytes, err := stageruntime.WriteCanonical(current.ProjectDir, EvidenceRevisionPath(current.Snapshot.RecordDir, revision), evidence.Artifact, 1, evidence, true)
	if err != nil {
		return EvaluateResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, EvidencePath(current.Snapshot.RecordDir), evidence.Artifact, evidenceBytes); err != nil {
		return EvaluateResult{}, err
	}
	gateSet, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage09, request.EffectivePolicyRef, at)
	if err != nil {
		return EvaluateResult{}, err
	}
	evaluation := Evaluation{SchemaVersion: 1, Artifact: "outcome-evaluation", Version: 1, Revision: revision, EvaluationID: fmt.Sprintf("outcome-evaluation-%03d", revision), IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage09, Disposition: contract.Execute, WorkRequestRef: requestRef, OutcomeEvidenceRef: evidenceRef, GateRequirementSetRef: gateSet.Reference, ReleaseOutcome: request.ReleaseOutcome, SignalResults: proposal.Observations, OverallResult: overall, Reason: proposal.Reason, EvaluatedAt: at}
	evaluationRef, evaluationBytes, err := stageruntime.WriteCanonical(current.ProjectDir, EvaluationRevisionPath(current.Snapshot.RecordDir, revision), evaluation.Artifact, 1, evaluation, true)
	if err != nil {
		return EvaluateResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, EvaluationPath(current.Snapshot.RecordDir), evaluation.Artifact, evaluationBytes); err != nil {
		return EvaluateResult{}, err
	}
	htmlBytes := []byte(renderHTML(evaluation, gateSet.Set))
	htmlRef, err := writeRawImmutable(current.ProjectDir, HTMLRevisionPath(current.Snapshot.RecordDir, revision), "outcome-html", htmlBytes)
	if err != nil {
		return EvaluateResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, HTMLPath(current.Snapshot.RecordDir), "outcome-html", htmlBytes); err != nil {
		return EvaluateResult{}, err
	}
	if overall == "achieved" && len(gateSet.Set.Requirements) == 0 {
		value, valueRef, completed, err := finalize(ctx, current, evaluation, requestRef, evidenceRef, evaluationRef, nil, nil, "auto-achieved", "Every fixed Outcome signal is achieved with verified Project Evidence.", at, contract.Execute)
		return EvaluateResult{Outcome: "completed", Evidence: evidence, EvidenceReference: evidenceRef, Evaluation: evaluation, EvaluationReference: evaluationRef, HTMLReference: htmlRef, Current: &value, CurrentReference: &valueRef, State: completed}, err
	}
	parked, err := stageruntime.Park(ctx, current, "ST-09 Outcome is "+overall+"; a human value judgment is required.", at)
	return EvaluateResult{Outcome: "awaiting_decision", Evidence: evidence, EvidenceReference: evidenceRef, Evaluation: evaluation, EvaluationReference: evaluationRef, HTMLReference: htmlRef, State: parked}, err
}

func Decide(ctx context.Context, projectDir, coreDir string, options DecideOptions) (DecideResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage09)
	if err != nil {
		return DecideResult{}, err
	}
	evaluation, evaluationRef, err := readCurrentEvaluation(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return DecideResult{}, err
	}
	if evaluationRef.SHA256 != options.EvaluationSHA256 {
		return DecideResult{}, fmt.Errorf("ST-09 Outcome Evaluation: decision does not bind current Evaluation")
	}
	if !allowed(options.Decision, "continue-observation", "complete-with-outcome", "complete-and-draft-follow-up") {
		return DecideResult{}, fmt.Errorf("ST-09 Outcome Evaluation: invalid human decision")
	}
	if options.DecidedAt == "" {
		options.DecidedAt = stageruntime.Now()
	}
	requestPath, err := stageruntime.ReadReference(current.ProjectDir, evaluation.WorkRequestRef)
	if err != nil {
		return DecideResult{}, err
	}
	request, _, _, err := stageruntime.ReadCanonical[WorkRequest](current.ProjectDir, requestPath, "outcome-work-request", 1)
	if err != nil {
		return DecideResult{}, err
	}
	gatePath, err := stageruntime.ReadReference(current.ProjectDir, evaluation.GateRequirementSetRef)
	if err != nil {
		return DecideResult{}, err
	}
	gateSet, _, _, err := stageruntime.ReadCanonical[gate.RequirementSet](current.ProjectDir, gatePath, "human-gate-requirements", 1)
	if err != nil {
		return DecideResult{}, err
	}
	if gateSet.EffectivePolicyRef != request.EffectivePolicyRef || gateSet.StageID != contract.Stage09 {
		return DecideResult{}, fmt.Errorf("ST-09 Outcome Evaluation: Gate does not bind the Work Request Policy")
	}
	if evaluation.OverallResult == "achieved" && len(gateSet.Requirements) == 0 {
		return DecideResult{}, fmt.Errorf("ST-09 Outcome Evaluation: achieved Evaluation without Policy requirements requires no human decision")
	}
	acks := options.PolicyAcknowledgements
	if options.Decision == "continue-observation" {
		acks = []gate.Acknowledgement{}
		if options.NotBefore == nil {
			return DecideResult{}, fmt.Errorf("ST-09 Outcome Evaluation: continue-observation requires not_before")
		}
		if err := validateWindow(*options.NotBefore, options.Deadline); err != nil {
			return DecideResult{}, err
		}
	} else if err := gate.ValidateAcknowledgements(current.ProjectDir, current.Snapshot.RecordDir, gateSet, acks, true); err != nil {
		return DecideResult{}, err
	}
	if acks == nil {
		acks = []gate.Acknowledgement{}
	}
	decision := HumanDecision{SchemaVersion: 1, Artifact: "outcome-human-decision", Version: 1, DecisionID: "outcome-decision-" + digest.Bytes([]byte(evaluationRef.SHA256 + "\x00" + options.Decision + "\x00" + options.DecidedAt))[7:19], IntentID: current.Snapshot.State.IntentID, OutcomeEvaluationRef: evaluationRef, GateRequirementSetRef: evaluation.GateRequirementSetRef, PolicyAcknowledgements: acks, Decision: options.Decision, Reason: options.Reason, DecidedBy: "human", DecidedAt: options.DecidedAt}
	if options.Decision == "continue-observation" {
		decision.NotBefore = options.NotBefore
		decision.Deadline = options.Deadline
	}
	decisionRef, decisionBytes, err := stageruntime.WriteCanonical(current.ProjectDir, DecisionRevisionPath(current.Snapshot.RecordDir, decision.DecisionID), decision.Artifact, 1, decision, true)
	if err != nil {
		return DecideResult{}, err
	}
	if _, err := writeRaw(current.ProjectDir, DecisionPath(current.Snapshot.RecordDir), decision.Artifact, decisionBytes); err != nil {
		return DecideResult{}, err
	}
	if options.Decision == "continue-observation" {
		parked, err := parkSchedule(ctx, current, "ST-09 Outcome observation continues at "+*options.NotBefore+".", *options.NotBefore, options.Deadline, options.DecidedAt)
		return DecideResult{Outcome: "continued", Decision: decision, DecisionReference: decisionRef, State: parked}, err
	}
	var followUp *FollowUpBrief
	var followUpRef *contract.ArtifactReference
	if options.Decision == "complete-and-draft-follow-up" {
		unresolved := []string{}
		for _, item := range evaluation.SignalResults {
			if item.Result != "achieved" {
				unresolved = append(unresolved, item.SignalID)
			}
		}
		value := FollowUpBrief{SchemaVersion: 1, Artifact: "follow-up-brief", Version: 1, BriefID: "follow-up-" + evaluationRef.SHA256[7:19], SourceIntentID: current.Snapshot.State.IntentID, OutcomeEvaluationRef: evaluationRef, HumanDecisionRef: decisionRef, Title: "Follow-up for Outcome Evaluation", ProblemSummary: evaluation.OverallResult + ": " + options.Reason, UnresolvedSignalIDs: unresolved, CreatedAt: options.DecidedAt}
		ref, _, err := stageruntime.WriteCanonical(current.ProjectDir, FollowUpPath(current.Snapshot.RecordDir), value.Artifact, 1, value, false)
		if err != nil {
			return DecideResult{}, err
		}
		followUp = &value
		followUpRef = &ref
	}
	evidencePath, err := stageruntime.ReadReference(current.ProjectDir, evaluation.OutcomeEvidenceRef)
	if err != nil {
		return DecideResult{}, err
	}
	_, evidenceRef, _, err := stageruntime.ReadCanonical[Evidence](current.ProjectDir, evidencePath, "outcome-evidence", 1)
	if err != nil {
		return DecideResult{}, err
	}
	mode := "human-accepted"
	if followUp != nil {
		mode = "human-follow-up"
	}
	value, valueRef, completed, err := finalize(ctx, current, evaluation, evaluation.WorkRequestRef, evidenceRef, evaluationRef, &decisionRef, followUpRef, mode, options.Reason, options.DecidedAt, contract.Execute)
	return DecideResult{Outcome: "completed", Decision: decision, DecisionReference: decisionRef, FollowUp: followUp, FollowUpReference: followUpRef, Current: &value, CurrentReference: &valueRef, State: completed}, err
}

// Reuse accepts only a previously achieved Outcome whose pinned promises,
// Release Current, Policy, signals, and referenced Evidence still match.
func Reuse(ctx context.Context, projectDir, coreDir, sourceCurrentPath, reason, at string) (ReuseResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage09)
	if err != nil {
		return ReuseResult{}, err
	}
	prior, priorRef, _, err := stageruntime.ReadCanonical[Current](current.ProjectDir, sourceCurrentPath, "outcome-current", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	if prior.OverallResult != "achieved" {
		return ReuseResult{}, fmt.Errorf("ST-09 Outcome Evaluation: only an achieved Outcome can be reused")
	}
	priorRequestPath, err := stageruntime.ReadReference(current.ProjectDir, prior.WorkRequestRef)
	if err != nil {
		return ReuseResult{}, err
	}
	priorRequest, _, _, err := stageruntime.ReadCanonical[WorkRequest](current.ProjectDir, priorRequestPath, "outcome-work-request", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	priorEvidencePath, err := stageruntime.ReadReference(current.ProjectDir, prior.OutcomeEvidenceRef)
	if err != nil {
		return ReuseResult{}, err
	}
	priorEvidence, evidenceRef, _, err := stageruntime.ReadCanonical[Evidence](current.ProjectDir, priorEvidencePath, "outcome-evidence", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	for _, observation := range priorEvidence.Observations {
		for _, ref := range observation.EvidenceRefs {
			if _, err := stageruntime.ReadReference(current.ProjectDir, ref); err != nil {
				return ReuseResult{}, err
			}
		}
	}
	priorEvaluationPath, err := stageruntime.ReadReference(current.ProjectDir, prior.OutcomeEvaluationRef)
	if err != nil {
		return ReuseResult{}, err
	}
	priorEvaluation, evaluationRef, _, err := stageruntime.ReadCanonical[Evaluation](current.ProjectDir, priorEvaluationPath, "outcome-evaluation", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	if priorEvaluation.OverallResult != "achieved" || priorEvaluation.OutcomeEvidenceRef != evidenceRef {
		return ReuseResult{}, fmt.Errorf("ST-09 Outcome Evaluation: reused Evaluation binding differs")
	}
	if at == "" {
		at = stageruntime.Now()
	}
	prepared, err := Prepare(ctx, current.ProjectDir, coreDir, PrepareOptions{PreparedAt: at})
	if err != nil {
		return ReuseResult{}, err
	}
	if prepared.Request == nil || prepared.Reference == nil {
		return ReuseResult{}, fmt.Errorf("ST-09 Outcome Evaluation: active Work Request is not ready for reuse")
	}
	if !equivalentPromises(priorRequest, *prepared.Request) {
		return ReuseResult{}, fmt.Errorf("ST-09 Outcome Evaluation: reused Outcome does not match active promises, Release, Policy, and signals")
	}
	gateSet, err := gate.Resolve(current.ProjectDir, current.Snapshot.RecordDir, contract.Stage09, prepared.Request.EffectivePolicyRef, at)
	if err != nil {
		return ReuseResult{}, err
	}
	if len(gateSet.Set.Requirements) != 0 {
		return ReuseResult{}, fmt.Errorf("ST-09 Outcome Evaluation: current Policy requires human confirmation")
	}
	htmlBytes := []byte(renderHTML(priorEvaluation, gateSet.Set))
	if _, err := writeRaw(current.ProjectDir, HTMLPath(current.Snapshot.RecordDir), "outcome-html", htmlBytes); err != nil {
		return ReuseResult{}, err
	}
	current, err = stageruntime.Load(current.ProjectDir, coreDir, contract.Stage09)
	if err != nil {
		return ReuseResult{}, err
	}
	reusedEvaluation := priorEvaluation
	reusedEvaluation.Disposition = contract.Reuse
	value, valueRef, completed, err := finalize(ctx, current, reusedEvaluation, *prepared.Reference, evidenceRef, evaluationRef, nil, nil, "reused", reason, at, contract.Reuse)
	return ReuseResult{Current: value, CurrentReference: valueRef, ReusedOutcomeCurrentReference: priorRef, State: completed}, err
}

type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	_, _, _, evaluationExists, err := stageruntime.ReadCanonicalIfExists[Evaluation](projectDir, EvaluationPath(snapshot.RecordDir), "outcome-evaluation", 1)
	if err != nil {
		return directive.Core{}, err
	}
	if evaluationExists {
		evaluation, evaluationRef, err := readCurrentEvaluation(projectDir, snapshot.RecordDir)
		if err != nil {
			return directive.Core{}, err
		}
		_, _, _, decisionExists, err := stageruntime.ReadCanonicalIfExists[HumanDecision](projectDir, DecisionPath(snapshot.RecordDir), "outcome-human-decision", 1)
		if err != nil {
			return directive.Core{}, err
		}
		pending := true
		if decisionExists {
			decision, _, err := readCurrentDecision(projectDir, snapshot.RecordDir)
			if err != nil {
				return directive.Core{}, err
			}
			pending = decision.Decision != "continue-observation" || decision.OutcomeEvaluationRef != evaluationRef
			if decision.Decision != "continue-observation" && decision.OutcomeEvaluationRef == evaluationRef {
				return directive.Core{}, fmt.Errorf("ST-09 Outcome Evaluation: terminal human decision exists while Stage remains active")
			}
		}
		if pending {
			htmlBytes, err := readRegular(HTMLRevisionPath(snapshot.RecordDir, evaluation.Revision))
			if err != nil {
				return directive.Core{}, err
			}
			htmlRef, err := stageruntime.Reference(projectDir, HTMLRevisionPath(snapshot.RecordDir, evaluation.Revision), "outcome-html", 1, htmlBytes)
			if err != nil {
				return directive.Core{}, err
			}
			stageID := contract.Stage09
			result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Decision, Stage: &stageID, Reason: "A human must decide whether to continue observation or accept the evaluated Outcome.", Candidate: &evaluationRef, Review: &htmlRef, Decisions: []string{"continue-observation", "complete-with-outcome", "complete-and-draft-follow-up"}, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
			return result, result.Validate()
		}
	}
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, PrepareOptions{})
	if err != nil {
		return directive.Core{}, err
	}
	if prepared.Execution == "waiting" {
		stageID := contract.Stage09
		reason := "ST-09 Outcome observation is waiting."
		if prepared.State.ParkedReason != nil {
			reason = *prepared.State.ParkedReason
		}
		result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Parked, Stage: &stageID, Reason: reason, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
		return result, result.Validate()
	}
	if prepared.Reference == nil {
		return directive.Core{}, fmt.Errorf("ST-09 Outcome Evaluation did not produce a Work Request")
	}
	stageID := contract.Stage09
	result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Work, Stage: &stageID, Reason: "Core fixed every promised Outcome signal; AI may propose observations only.", Request: prepared.Reference, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
	return result, result.Validate()
}

func buildSignals(intent st02defineintent.Definition, requirements st03requirements.Definition, manifest *st07review.Manifest) []Signal {
	result := []Signal{}
	add := func(id, artifact, pointer, statement string) {
		result = append(result, Signal{SignalID: id, SourceArtifact: artifact, SourcePointer: pointer, Statement: statement, Required: true, AllowedEvidenceTypes: []string{"artifact", "registered-observation", "human-confirmation"}})
	}
	for index, value := range intent.ExpectedOutcomes {
		add(fmt.Sprintf("OUT-%03d", index+1), "intent-definition", fmt.Sprintf("/expected_outcomes/%d", index), value)
	}
	for index, value := range intent.SuccessSignals {
		add(fmt.Sprintf("SIG-%03d", index+1), "intent-definition", fmt.Sprintf("/success_signals/%d", index), value)
	}
	collections := []struct {
		name   string
		values []st03requirements.Item
	}{{"functional_requirements", requirements.FunctionalRequirements}, {"quality_requirements", requirements.QualityRequirements}, {"constraints", requirements.Constraints}, {"invariants", requirements.Invariants}}
	for _, collection := range collections {
		for index, value := range collection.values {
			add(value.ID, "requirements-definition", fmt.Sprintf("/%s/%d", collection.name, index), value.Statement)
		}
	}
	if manifest != nil {
		for index, value := range manifest.AcceptanceCriteria {
			add(value.CriterionID, "review-manifest", fmt.Sprintf("/acceptance_criteria/%d", index), value.Given+" / "+value.When+" / "+value.Then)
		}
	}
	return result
}
func validateProposal(value Proposal) error {
	if value.SchemaVersion != 1 || value.Artifact != "outcome-evaluation-proposal" || value.Version != 1 || value.ProposedBy != "ai" || len(value.Observations) == 0 {
		return fmt.Errorf("Outcome Proposal has invalid schema identity, authority, or observations")
	}
	return nil
}
func validateObservations(projectDir string, request WorkRequest, values []Observation) error {
	expected := map[string]bool{}
	for _, signal := range request.Signals {
		expected[signal.SignalID] = true
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !expected[value.SignalID] || seen[value.SignalID] || !allowed(value.Result, "achieved", "partially_achieved", "not_achieved", "inconclusive") || len(value.EvidenceRefs) == 0 {
			return fmt.Errorf("ST-09 Outcome Evaluation: invalid, duplicate, or uncovered observation %s", value.SignalID)
		}
		seen[value.SignalID] = true
		if err := stageruntime.Timestamp(value.ObservedAt, "observation observed_at"); err != nil {
			return err
		}
		observed, _ := time.Parse(time.RFC3339Nano, value.ObservedAt)
		start, _ := time.Parse(time.RFC3339Nano, request.NotBefore)
		if observed.Before(start) {
			return fmt.Errorf("ST-09 Outcome Evaluation: observation is before not_before")
		}
		if request.Deadline != nil {
			end, _ := time.Parse(time.RFC3339Nano, *request.Deadline)
			if observed.After(end) {
				return fmt.Errorf("ST-09 Outcome Evaluation: observation is after deadline")
			}
		}
		for _, ref := range value.EvidenceRefs {
			if _, err := stageruntime.ReadReference(projectDir, ref); err != nil {
				return err
			}
		}
	}
	if len(seen) != len(expected) {
		return fmt.Errorf("ST-09 Outcome Evaluation: every fixed signal must be assessed exactly once")
	}
	return nil
}
func CalculateResult(values []Observation) string {
	for _, value := range values {
		if value.Result == "inconclusive" {
			return "inconclusive"
		}
	}
	allAchieved := true
	allFailed := true
	for _, value := range values {
		allAchieved = allAchieved && value.Result == "achieved"
		allFailed = allFailed && value.Result == "not_achieved"
	}
	if allAchieved {
		return "achieved"
	}
	if allFailed {
		return "not_achieved"
	}
	return "partially_achieved"
}
func finalize(ctx context.Context, current stageruntime.Context, evaluation Evaluation, requestRef, evidenceRef, evaluationRef contract.ArtifactReference, decisionRef, followUpRef *contract.ArtifactReference, mode, reason, at string, disposition contract.Disposition) (Current, contract.ArtifactReference, state.IntentState, error) {
	value := Current{SchemaVersion: 1, Artifact: "outcome-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: disposition, OverallResult: evaluation.OverallResult, CompletionMode: mode, WorkRequestRef: requestRef, OutcomeEvidenceRef: evidenceRef, OutcomeEvaluationRef: evaluationRef, HumanDecisionRef: decisionRef, FollowUpBriefRef: followUpRef, Reason: reason, CompletedAt: at}
	ref, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), value.Artifact, 1, value, false)
	if err != nil {
		return Current{}, contract.ArtifactReference{}, state.IntentState{}, err
	}
	evidence := []contract.ArtifactReference{requestRef, evidenceRef, evaluationRef, ref}
	if decisionRef != nil {
		evidence = append(evidence, *decisionRef)
	}
	if followUpRef != nil {
		evidence = append(evidence, *followUpRef)
	}
	proposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: "st09-" + string(disposition) + "-" + evaluationRef.SHA256[7:19], StageID: contract.Stage09, Disposition: disposition, Reason: reason, Evidence: evidence, ProposedBy: contract.ProposerCore}
	revised, err := workflowplan.Revise(current.Snapshot.Plan, []contract.StageDispositionProposal{proposal}, workflowplan.RevisionOptions{ProjectDir: current.ProjectDir, StageContracts: []contract.StageContract{current.Contract}})
	if err != nil {
		return Current{}, contract.ArtifactReference{}, state.IntentState{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	completed, err := stageruntime.Complete(ctx, current, ref, "terminal-state-validator", at)
	return value, ref, completed, err
}
func parkSchedule(ctx context.Context, current stageruntime.Context, reason, notBefore string, deadline *string, at string) (state.IntentState, error) {
	updated := current.Snapshot.State
	updated.Status = state.Parked
	updated.ParkedReason = &reason
	updated.NotBefore = &notBefore
	updated.Deadline = deadline
	updated.UpdatedAt = at
	err := state.Store(ctx, current.ProjectDir, current.Snapshot.RecordDir, updated, current.Snapshot.Plan)
	return updated, err
}
func clearMutableObservationCycle(recordDir string) error {
	for _, path := range []string{EvidencePath(recordDir), EvaluationPath(recordDir), HTMLPath(recordDir), DecisionPath(recordDir)} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
func validateWindow(notBefore string, deadline *string) error {
	if err := stageruntime.Timestamp(notBefore, "not_before"); err != nil {
		return err
	}
	if deadline != nil {
		if err := stageruntime.Timestamp(*deadline, "deadline"); err != nil {
			return err
		}
		start, _ := time.Parse(time.RFC3339Nano, notBefore)
		end, _ := time.Parse(time.RFC3339Nano, *deadline)
		if !end.After(start) {
			return fmt.Errorf("deadline must be after not_before")
		}
	}
	return nil
}
func readCurrentRequest(projectDir, recordDir string) (WorkRequest, contract.ArtifactReference, error) {
	current, currentRef, _, err := stageruntime.ReadCanonical[WorkRequest](projectDir, WorkRequestPath(recordDir), "outcome-work-request", 1)
	if err != nil {
		return WorkRequest{}, contract.ArtifactReference{}, err
	}
	immutable, ref, _, err := stageruntime.ReadCanonical[WorkRequest](projectDir, WorkRequestRevisionPath(recordDir, current.Revision), "outcome-work-request", 1)
	if err != nil {
		return WorkRequest{}, contract.ArtifactReference{}, err
	}
	if currentRef.SHA256 != ref.SHA256 || !reflect.DeepEqual(current, immutable) {
		return WorkRequest{}, contract.ArtifactReference{}, fmt.Errorf("ST-09 Outcome Evaluation: mutable Work Request differs from immutable revision")
	}
	return immutable, ref, nil
}
func readCurrentEvaluation(projectDir, recordDir string) (Evaluation, contract.ArtifactReference, error) {
	current, currentRef, _, err := stageruntime.ReadCanonical[Evaluation](projectDir, EvaluationPath(recordDir), "outcome-evaluation", 1)
	if err != nil {
		return Evaluation{}, contract.ArtifactReference{}, err
	}
	immutable, ref, _, err := stageruntime.ReadCanonical[Evaluation](projectDir, EvaluationRevisionPath(recordDir, current.Revision), "outcome-evaluation", 1)
	if err != nil {
		return Evaluation{}, contract.ArtifactReference{}, err
	}
	if currentRef.SHA256 != ref.SHA256 || !reflect.DeepEqual(current, immutable) {
		return Evaluation{}, contract.ArtifactReference{}, fmt.Errorf("ST-09 Outcome Evaluation: mutable Evaluation differs from immutable revision")
	}
	currentHTML, err := readRegular(HTMLPath(recordDir))
	if err != nil {
		return Evaluation{}, contract.ArtifactReference{}, err
	}
	immutableHTML, err := readRegular(HTMLRevisionPath(recordDir, current.Revision))
	if err != nil {
		return Evaluation{}, contract.ArtifactReference{}, err
	}
	if string(currentHTML) != string(immutableHTML) {
		return Evaluation{}, contract.ArtifactReference{}, fmt.Errorf("ST-09 Outcome Evaluation: mutable HTML differs from immutable revision")
	}
	return immutable, ref, nil
}
func readCurrentDecision(projectDir, recordDir string) (HumanDecision, contract.ArtifactReference, error) {
	current, currentRef, _, err := stageruntime.ReadCanonical[HumanDecision](projectDir, DecisionPath(recordDir), "outcome-human-decision", 1)
	if err != nil {
		return HumanDecision{}, contract.ArtifactReference{}, err
	}
	immutable, ref, _, err := stageruntime.ReadCanonical[HumanDecision](projectDir, DecisionRevisionPath(recordDir, current.DecisionID), "outcome-human-decision", 1)
	if err != nil {
		return HumanDecision{}, contract.ArtifactReference{}, err
	}
	if currentRef.SHA256 != ref.SHA256 || !reflect.DeepEqual(current, immutable) {
		return HumanDecision{}, contract.ArtifactReference{}, fmt.Errorf("ST-09 Outcome Evaluation: mutable human decision differs from immutable decision")
	}
	return immutable, ref, nil
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
func nextRequestRevision(projectDir, recordDir string) (int, error) {
	_, _, _, exists, err := stageruntime.ReadCanonicalIfExists[WorkRequest](projectDir, WorkRequestPath(recordDir), "outcome-work-request", 1)
	if err != nil {
		return 0, err
	}
	if exists {
		if _, _, err := readCurrentRequest(projectDir, recordDir); err != nil {
			return 0, err
		}
	}
	return nextNumberedRevision(filepath.Join(RootDir(recordDir), "requests")), nil
}
func nextEvaluationRevision(projectDir, recordDir string) (int, error) {
	_, _, _, exists, err := stageruntime.ReadCanonicalIfExists[Evaluation](projectDir, EvaluationPath(recordDir), "outcome-evaluation", 1)
	if err != nil {
		return 0, err
	}
	if exists {
		if _, _, err := readCurrentEvaluation(projectDir, recordDir); err != nil {
			return 0, err
		}
	}
	return nextNumberedRevision(filepath.Join(RootDir(recordDir), "revisions")), nil
}
func nextNumberedRevision(root string) int {
	entries, _ := os.ReadDir(root)
	max := 0
	for _, entry := range entries {
		var value int
		if entry.IsDir() {
			if _, err := fmt.Sscanf(entry.Name(), "%06d", &value); err == nil && value > max {
				max = value
			}
		}
	}
	return max + 1
}
func equivalentRequest(left, right WorkRequest) bool {
	left.Revision = 0
	right.Revision = 0
	left.CreatedAt = ""
	right.CreatedAt = ""
	return reflect.DeepEqual(left, right)
}
func equivalentPromises(left, right WorkRequest) bool {
	left.Revision, right.Revision = 0, 0
	left.CreatedAt, right.CreatedAt = "", ""
	left.NotBefore, right.NotBefore = "", ""
	left.Deadline, right.Deadline = nil, nil
	return reflect.DeepEqual(left, right)
}
func renderHTML(value Evaluation, set gate.RequirementSet) string {
	rows := append([]Observation{}, value.SignalResults...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].SignalID < rows[j].SignalID })
	var body strings.Builder
	body.WriteString("<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>ST-09 Outcome</title></head><body><main><h1>ST-09 Outcome Evaluation</h1><p>Overall: " + html.EscapeString(value.OverallResult) + "</p><ul>")
	for _, item := range rows {
		body.WriteString("<li>" + html.EscapeString(item.SignalID) + ": " + html.EscapeString(item.Result) + "</li>")
	}
	body.WriteString("</ul><p>Policy requirements: " + fmt.Sprint(len(set.Requirements)) + "</p></main></body></html>\n")
	return body.String()
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
			return contract.ArtifactReference{}, fmt.Errorf("immutable Outcome artifact differs")
		}
		return stageruntime.Reference(projectDir, path, artifact, 1, existing)
	}
	if !os.IsNotExist(err) {
		return contract.ArtifactReference{}, err
	}
	return writeRaw(projectDir, path, artifact, content)
}
func allowed(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}
