// Package st06build implements isolated ST-06 Build & Converge execution.
package st06build

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/process"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st05buildcontract"
	"github.com/sori883/aidlc/internal/workflow/directive"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/state"
)

type SourceBinding struct {
	SourceID     string `json:"source_id"`
	Locator      string `json:"locator"`
	RelativePath string `json:"relative_path"`
}
type RepositoryWorkspace struct {
	RepositoryID        string          `json:"repository_id"`
	RepositoryRoot      string          `json:"repository_root"`
	BaseRevision        string          `json:"base_revision"`
	WorkingRevision     string          `json:"working_revision"`
	IntegrationBranch   string          `json:"integration_branch"`
	IntegrationWorktree string          `json:"integration_worktree"`
	Sources             []SourceBinding `json:"sources"`
}
type Session struct {
	SchemaVersion           int                        `json:"schema_version"`
	Artifact                string                     `json:"artifact"`
	Version                 int                        `json:"version"`
	SessionID               string                     `json:"session_id"`
	IntentID                string                     `json:"intent_id"`
	StageID                 contract.StageID           `json:"stage_id"`
	Disposition             contract.Disposition       `json:"disposition"`
	Status                  string                     `json:"status"`
	BuildContractCurrentRef contract.ArtifactReference `json:"build_contract_current_ref"`
	BuildContractRef        contract.ArtifactReference `json:"build_contract_ref"`
	EffectivePolicyRef      contract.ArtifactReference `json:"effective_policy_ref"`
	CompletedBoltIDs        []string                   `json:"completed_bolt_ids"`
	CurrentBoltID           *string                    `json:"current_bolt_id"`
	Repositories            []RepositoryWorkspace      `json:"repositories"`
	LastFailureSignature    *string                    `json:"last_failure_signature"`
	SameFailureCount        int                        `json:"same_failure_count"`
	BlockedReason           *string                    `json:"blocked_reason"`
	StartedAt               string                     `json:"started_at"`
	UpdatedAt               string                     `json:"updated_at"`
}
type SourceWorkspace struct {
	SourceID       string `json:"source_id"`
	Locator        string `json:"locator"`
	RepositoryID   string `json:"repository_id"`
	RepositoryRoot string `json:"repository_root"`
	WorktreePath   string `json:"worktree_path"`
	BaseRevision   string `json:"base_revision"`
}
type WorkRequest struct {
	SchemaVersion      int                                     `json:"schema_version"`
	Artifact           string                                  `json:"artifact"`
	Version            int                                     `json:"version"`
	SessionID          string                                  `json:"session_id"`
	IntentID           string                                  `json:"intent_id"`
	StageID            contract.StageID                        `json:"stage_id"`
	BuildContractRef   contract.ArtifactReference              `json:"build_contract_ref"`
	Bolt               st05buildcontract.Bolt                  `json:"bolt"`
	ChangeContracts    []st05buildcontract.ChangeContract      `json:"change_contracts"`
	AcceptanceCriteria []st05buildcontract.AcceptanceCriterion `json:"acceptance_criteria"`
	Verifiers          []st05buildcontract.Verifier            `json:"verifiers"`
	Attempt            int                                     `json:"attempt"`
	SourceWorkspaces   []SourceWorkspace                       `json:"source_workspaces"`
	RequestedOutput    string                                  `json:"requested_output"`
	Rules              []string                                `json:"rules"`
	CreatedAt          string                                  `json:"created_at"`
}
type ChangedFile struct {
	SourceID string  `json:"source_id"`
	Path     string  `json:"path"`
	Status   string  `json:"status"`
	SHA256   *string `json:"sha256"`
}
type VerifierEvidence struct {
	SchemaVersion int     `json:"schema_version"`
	Artifact      string  `json:"artifact"`
	Version       int     `json:"version"`
	IntentID      string  `json:"intent_id"`
	SessionID     string  `json:"session_id"`
	BoltID        *string `json:"bolt_id"`
	Attempt       *int    `json:"attempt"`
	Scope         string  `json:"scope"`
	VerifierID    string  `json:"verifier_id"`
	VerifierKind  string  `json:"verifier_kind"`
	Result        string  `json:"result"`
	ExitCode      *int    `json:"exit_code"`
	StdoutSHA256  *string `json:"stdout_sha256"`
	StderrSHA256  *string `json:"stderr_sha256"`
	Detail        string  `json:"detail"`
	ExecutedAt    string  `json:"executed_at"`
}
type Checkpoint struct {
	SchemaVersion        int                          `json:"schema_version"`
	Artifact             string                       `json:"artifact"`
	Version              int                          `json:"version"`
	IntentID             string                       `json:"intent_id"`
	SessionID            string                       `json:"session_id"`
	BuildContractRef     contract.ArtifactReference   `json:"build_contract_ref"`
	BoltID               string                       `json:"bolt_id"`
	Attempt              int                          `json:"attempt"`
	Outcome              string                       `json:"outcome"`
	ChangedFiles         []ChangedFile                `json:"changed_files"`
	VerifierEvidenceRefs []contract.ArtifactReference `json:"verifier_evidence_refs"`
	FailureSignature     *string                      `json:"failure_signature"`
	Reason               string                       `json:"reason"`
	CreatedAt            string                       `json:"created_at"`
}
type SourceResult struct {
	RepositoryID      string   `json:"repository_id"`
	SourceIDs         []string `json:"source_ids"`
	SourceLocator     string   `json:"source_locator"`
	BaseRevision      string   `json:"base_revision"`
	CandidateRevision string   `json:"candidate_revision"`
	IntegrationBranch string   `json:"integration_branch"`
	ChangedFiles      []string `json:"changed_files"`
}
type RunnableCandidate struct {
	SchemaVersion                   int                          `json:"schema_version"`
	Artifact                        string                       `json:"artifact"`
	Version                         int                          `json:"version"`
	IntentID                        string                       `json:"intent_id"`
	SessionID                       string                       `json:"session_id"`
	Disposition                     contract.Disposition         `json:"disposition"`
	BuildContractRef                contract.ArtifactReference   `json:"build_contract_ref"`
	SourceResults                   []SourceResult               `json:"source_results"`
	BoltCheckpointRefs              []contract.ArtifactReference `json:"bolt_checkpoint_refs"`
	IntegrationVerifierEvidenceRefs []contract.ArtifactReference `json:"integration_verifier_evidence_refs"`
	CreatedAt                       string                       `json:"created_at"`
}
type Current struct {
	SchemaVersion           int                         `json:"schema_version"`
	Artifact                string                      `json:"artifact"`
	Version                 int                         `json:"version"`
	IntentID                string                      `json:"intent_id"`
	Disposition             contract.Disposition        `json:"disposition"`
	BuildContractCurrentRef contract.ArtifactReference  `json:"build_contract_current_ref"`
	RunnableCandidateRef    *contract.ArtifactReference `json:"runnable_candidate_ref"`
	Reason                  string                      `json:"reason"`
	UpdatedAt               string                      `json:"updated_at"`
}
type PrepareResult struct {
	Execution        string                      `json:"execution"`
	Request          *WorkRequest                `json:"request"`
	Reference        *contract.ArtifactReference `json:"reference"`
	CurrentReference *contract.ArtifactReference `json:"currentReference"`
	State            state.IntentState           `json:"state"`
}
type VerifyResult struct {
	Outcome             string                      `json:"outcome"`
	Checkpoint          Checkpoint                  `json:"checkpoint"`
	CheckpointReference contract.ArtifactReference  `json:"checkpointReference"`
	Request             *WorkRequest                `json:"request"`
	RequestReference    *contract.ArtifactReference `json:"requestReference"`
	Candidate           *RunnableCandidate          `json:"candidate"`
	CandidateReference  *contract.ArtifactReference `json:"candidateReference"`
	State               state.IntentState           `json:"state"`
}
type ReuseResult struct {
	Current                  Current                    `json:"current"`
	CurrentReference         contract.ArtifactReference `json:"currentReference"`
	ReusedCandidateReference contract.ArtifactReference `json:"reusedCandidateReference"`
	State                    state.IntentState          `json:"state"`
}

func RootDir(recordDir string) string { return filepath.Join(recordDir, "artifacts", "build") }
func SessionPath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "build-session.json")
}
func WorkRequestPath(recordDir, boltID string) string {
	return filepath.Join(RootDir(recordDir), "bolts", boltID, "work-request.json")
}
func CheckpointPath(recordDir, boltID string, attempt int) string {
	return filepath.Join(RootDir(recordDir), "bolts", boltID, "attempts", fmt.Sprintf("%06d", attempt), "checkpoint.json")
}
func VerifierPath(recordDir, boltID string, attempt int, verifierID string) string {
	return filepath.Join(RootDir(recordDir), "bolts", boltID, "attempts", fmt.Sprintf("%06d", attempt), "verifiers", verifierID+".json")
}
func IntegrationVerifierPath(recordDir, sessionID, verifierID string) string {
	return filepath.Join(RootDir(recordDir), "integration", sessionID, "verifiers", verifierID+".json")
}
func CandidatePath(recordDir string) string {
	return filepath.Join(RootDir(recordDir), "runnable-candidate.json")
}
func CurrentPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "current.json") }

func Prepare(ctx context.Context, projectDir, coreDir, preparedAt string) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage06)
	if err != nil {
		return PrepareResult{}, err
	}
	buildCurrent, buildCurrentRef, _, err := stageruntime.ReadCanonical[st05buildcontract.Current](current.ProjectDir, st05buildcontract.CurrentPath(current.Snapshot.RecordDir), "build-contract-current", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if buildCurrent.Disposition == contract.NotApplicable || buildCurrent.BuildContractRef == nil {
		if preparedAt == "" {
			preparedAt = stageruntime.Now()
		}
		pointer := Current{SchemaVersion: 1, Artifact: "build-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: contract.NotApplicable, BuildContractCurrentRef: buildCurrentRef, RunnableCandidateRef: nil, Reason: "The approved Build Contract deterministically requires no repository changes.", UpdatedAt: preparedAt}
		reference, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), pointer.Artifact, 1, pointer, false)
		if err != nil {
			return PrepareResult{}, err
		}
		revised, err := revisePlan(current, contract.NotApplicable, "st06-no-build", pointer.Reason, []contract.ArtifactReference{buildCurrent.ApprovalRef, reference})
		if err != nil {
			return PrepareResult{}, err
		}
		current.Snapshot.Plan = revised
		current.Snapshot.State.PlanRevision = revised.Revision
		advanced, err := stageruntime.Advance(ctx, current, reference, "build-session-schema-validator", "ST-07 Human Feedback & Approval is ready for Core preparation.", preparedAt)
		if err != nil {
			return PrepareResult{}, err
		}
		return PrepareResult{Execution: "advanced", CurrentReference: &reference, State: advanced}, nil
	}
	contractPath, err := stageruntime.ReadReference(current.ProjectDir, *buildCurrent.BuildContractRef)
	if err != nil {
		return PrepareResult{}, err
	}
	buildContract, contractRef, _, err := stageruntime.ReadCanonical[st05buildcontract.BuildContract](current.ProjectDir, contractPath, "build-contract", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if preparedAt == "" {
		preparedAt = stageruntime.Now()
	}
	session, _, _, sessionExists, err := stageruntime.ReadCanonicalIfExists[Session](current.ProjectDir, SessionPath(current.Snapshot.RecordDir), "build-session", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if sessionExists {
		if session.BuildContractRef != contractRef || session.BuildContractCurrentRef != buildCurrentRef {
			return PrepareResult{}, fmt.Errorf("ST-06 Build: existing Session is stale")
		}
		if session.Status == "blocked" {
			return PrepareResult{}, fmt.Errorf("ST-06 Build: %s", stringValue(session.BlockedReason))
		}
		if session.Status == "completed" {
			_, reference, _, candidateExists, candidateErr := stageruntime.ReadCanonicalIfExists[RunnableCandidate](current.ProjectDir, CandidatePath(current.Snapshot.RecordDir), "runnable-candidate", 1)
			if candidateErr != nil {
				return PrepareResult{}, candidateErr
			}
			if !candidateExists {
				return PrepareResult{}, fmt.Errorf("ST-06 Build: completed Session has no Runnable Candidate")
			}
			return PrepareResult{Execution: "advanced", CurrentReference: &reference, State: current.Snapshot.State, Request: nil}, nil
		}
		if session.CurrentBoltID == nil {
			return PrepareResult{}, fmt.Errorf("ST-06 Build: active Session has no current Bolt")
		}
		request, reference, _, err := stageruntime.ReadCanonical[WorkRequest](current.ProjectDir, WorkRequestPath(current.Snapshot.RecordDir, *session.CurrentBoltID), "bolt-work-request", 1)
		if err != nil {
			return PrepareResult{}, err
		}
		if current.Snapshot.State.Status != state.Ready {
			if _, err := stageruntime.SetReady(ctx, current, request.CreatedAt); err != nil {
				return PrepareResult{}, err
			}
		}
		return PrepareResult{Execution: "reused", Request: &request, Reference: &reference, State: current.Snapshot.State}, nil
	}
	repositories, err := createRepositories(ctx, current.ProjectDir, current.Snapshot.RecordDir, current.Snapshot.State.IntentID, buildContract, preparedAt)
	if err != nil {
		return PrepareResult{}, err
	}
	first, ok := readyBolt(buildContract, nil)
	if !ok {
		return PrepareResult{}, fmt.Errorf("ST-06 Build: executable Build Contract has no ready Bolt")
	}
	sessionID := "build-" + digest.Bytes([]byte(current.Snapshot.State.IntentID + "\x00" + contractRef.SHA256))[7:19]
	firstID := first.BoltID
	session = Session{SchemaVersion: 1, Artifact: "build-session", Version: 1, SessionID: sessionID, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage06, Disposition: contract.Execute, Status: "active", BuildContractCurrentRef: buildCurrentRef, BuildContractRef: contractRef, EffectivePolicyRef: current.Snapshot.State.PolicySnapshot, CompletedBoltIDs: []string{}, CurrentBoltID: &firstID, Repositories: repositories, LastFailureSignature: nil, SameFailureCount: 0, BlockedReason: nil, StartedAt: preparedAt, UpdatedAt: preparedAt}
	if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, SessionPath(current.Snapshot.RecordDir), session.Artifact, 1, session, false); err != nil {
		return PrepareResult{}, err
	}
	request, reference, err := buildRequest(ctx, current.ProjectDir, current.Snapshot.RecordDir, session, buildContract, first, 1, preparedAt)
	if err != nil {
		return PrepareResult{}, err
	}
	if _, err := stageruntime.SetReady(ctx, current, preparedAt); err != nil {
		return PrepareResult{}, err
	}
	_, _ = audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.BoltStarted, []audit.Field{{Name: "Stage", Value: "ST-06"}, {Name: "Bolt", Value: first.BoltID}, {Name: "Attempt", Value: "1"}, {Name: "Decision Authority", Value: "core"}}, nil)
	return PrepareResult{Execution: "prepared", Request: &request, Reference: &reference, State: current.Snapshot.State}, nil
}

func Verify(ctx context.Context, projectDir, coreDir, boltID, verifiedAt string) (VerifyResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage06)
	if err != nil {
		return VerifyResult{}, err
	}
	session, _, _, err := stageruntime.ReadCanonical[Session](current.ProjectDir, SessionPath(current.Snapshot.RecordDir), "build-session", 1)
	if err != nil {
		return VerifyResult{}, err
	}
	if session.Status != "active" || session.CurrentBoltID == nil || *session.CurrentBoltID != boltID {
		return VerifyResult{}, fmt.Errorf("ST-06 Build: Core selected %s, not %s", stringValue(session.CurrentBoltID), boltID)
	}
	request, _, _, err := stageruntime.ReadCanonical[WorkRequest](current.ProjectDir, WorkRequestPath(current.Snapshot.RecordDir, boltID), "bolt-work-request", 1)
	if err != nil {
		return VerifyResult{}, err
	}
	buildPath, err := stageruntime.ReadReference(current.ProjectDir, session.BuildContractRef)
	if err != nil {
		return VerifyResult{}, err
	}
	buildContract, _, _, err := stageruntime.ReadCanonical[st05buildcontract.BuildContract](current.ProjectDir, buildPath, "build-contract", 1)
	if err != nil {
		return VerifyResult{}, err
	}
	if verifiedAt == "" {
		verifiedAt = stageruntime.Now()
	}
	changed, issues, err := collectChanges(ctx, request)
	if err != nil {
		return VerifyResult{}, err
	}
	evidence, evidenceRefs := runVerifiers(ctx, current.ProjectDir, current.Snapshot.RecordDir, session, request, request.Verifiers, request.SourceWorkspaces, "bolt", verifiedAt)
	failed := false
	for _, item := range evidence {
		if item.Result == "failed" {
			failed = true
		}
	}
	if len(changed) == 0 {
		issues = append(issues, "The Bolt produced no repository changes.")
	}
	passed := !failed && len(issues) == 0
	outcome := "passed"
	reason := "All Bolt verifiers passed and changed paths match the Build Contract."
	var signature *string
	if !passed {
		outcome = "failed"
		reason = strings.Join(issues, " ")
		var signatureInput strings.Builder
		signatureInput.WriteString(reason)
		for _, item := range evidence {
			signatureInput.WriteString("\x00")
			signatureInput.WriteString(item.VerifierID)
			signatureInput.WriteString("\x00")
			signatureInput.WriteString(item.Result)
			signatureInput.WriteString("\x00")
			signatureInput.WriteString(item.Detail)
		}
		value := digest.Bytes([]byte(signatureInput.String()))
		signature = &value
	}
	checkpoint := Checkpoint{SchemaVersion: 1, Artifact: "build-attempt-checkpoint", Version: 1, IntentID: session.IntentID, SessionID: session.SessionID, BuildContractRef: session.BuildContractRef, BoltID: boltID, Attempt: request.Attempt, Outcome: outcome, ChangedFiles: changed, VerifierEvidenceRefs: evidenceRefs, FailureSignature: signature, Reason: reason, CreatedAt: verifiedAt}
	checkpointRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CheckpointPath(current.Snapshot.RecordDir, boltID, request.Attempt), checkpoint.Artifact, 1, checkpoint, true)
	if err != nil {
		return VerifyResult{}, err
	}
	if !passed {
		count := 1
		if session.LastFailureSignature != nil && signature != nil && *session.LastFailureSignature == *signature {
			count = session.SameFailureCount + 1
		}
		session.LastFailureSignature = signature
		session.SameFailureCount = count
		if count >= 3 {
			session.Status = "blocked"
			blocked := "The same failure signature occurred 3 times for " + boltID + "."
			session.BlockedReason = &blocked
			if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, SessionPath(current.Snapshot.RecordDir), session.Artifact, 1, session, false); err != nil {
				return VerifyResult{}, err
			}
			parked, err := stageruntime.Park(ctx, current, blocked, verifiedAt)
			return VerifyResult{Outcome: "blocked", Checkpoint: checkpoint, CheckpointReference: checkpointRef, State: parked}, err
		}
		nextRequest, nextRef, err := buildRequest(ctx, current.ProjectDir, current.Snapshot.RecordDir, session, buildContract, request.Bolt, request.Attempt+1, verifiedAt)
		if err != nil {
			return VerifyResult{}, err
		}
		session.UpdatedAt = verifiedAt
		if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, SessionPath(current.Snapshot.RecordDir), session.Artifact, 1, session, false); err != nil {
			return VerifyResult{}, err
		}
		return VerifyResult{Outcome: "retry", Checkpoint: checkpoint, CheckpointReference: checkpointRef, Request: &nextRequest, RequestReference: &nextRef, State: current.Snapshot.State}, nil
	}
	if err := commitAndIntegrate(ctx, current.ProjectDir, current.Snapshot.RecordDir, session, request); err != nil {
		return VerifyResult{}, err
	}
	session.CompletedBoltIDs = append(session.CompletedBoltIDs, boltID)
	_, _ = audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.BoltCompleted, []audit.Field{{Name: "Stage", Value: "ST-06"}, {Name: "Bolt", Value: boltID}, {Name: "Attempt", Value: fmt.Sprint(request.Attempt)}, {Name: "Checkpoint", Value: checkpointRef.SHA256}, {Name: "Decision Authority", Value: "core"}}, nil)
	if next, ok := readyBolt(buildContract, session.CompletedBoltIDs); ok {
		session.CurrentBoltID = &next.BoltID
		session.LastFailureSignature = nil
		session.SameFailureCount = 0
		session.UpdatedAt = verifiedAt
		if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, SessionPath(current.Snapshot.RecordDir), session.Artifact, 1, session, false); err != nil {
			return VerifyResult{}, err
		}
		nextRequest, nextRef, err := buildRequest(ctx, current.ProjectDir, current.Snapshot.RecordDir, session, buildContract, next, 1, verifiedAt)
		if err != nil {
			return VerifyResult{}, err
		}
		return VerifyResult{Outcome: "next_bolt", Checkpoint: checkpoint, CheckpointReference: checkpointRef, Request: &nextRequest, RequestReference: &nextRef, State: current.Snapshot.State}, nil
	}
	integrationRefs := []contract.ArtifactReference{}
	if buildContract.IntegrationContract != nil {
		integrationVerifiers := []st05buildcontract.Verifier{}
		for _, verifierID := range buildContract.IntegrationContract.VerifierIDs {
			for _, verifier := range buildContract.Verifiers {
				if verifier.VerifierID == verifierID {
					integrationVerifiers = append(integrationVerifiers, verifier)
				}
			}
		}
		integrationRequest := request
		integrationRequest.SourceWorkspaces = integrationWorkspaces(session)
		evidence, refs := runVerifiers(ctx, current.ProjectDir, current.Snapshot.RecordDir, session, integrationRequest, integrationVerifiers, integrationRequest.SourceWorkspaces, "integration", verifiedAt)
		integrationRefs = refs
		for _, item := range evidence {
			if item.Result == "failed" {
				reason := "An Integration Contract verifier failed: " + item.VerifierID
				session.Status = "blocked"
				session.BlockedReason = &reason
				session.UpdatedAt = verifiedAt
				if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, SessionPath(current.Snapshot.RecordDir), session.Artifact, 1, session, false); err != nil {
					return VerifyResult{}, err
				}
				parked, err := stageruntime.Park(ctx, current, reason, verifiedAt)
				return VerifyResult{Outcome: "blocked", Checkpoint: checkpoint, CheckpointReference: checkpointRef, State: parked}, err
			}
		}
	}
	session.CurrentBoltID = nil
	session.Status = "completed"
	session.UpdatedAt = verifiedAt
	if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, SessionPath(current.Snapshot.RecordDir), session.Artifact, 1, session, false); err != nil {
		return VerifyResult{}, err
	}
	candidate, candidateRef, currentRef, advanced, err := completeCandidate(ctx, current, session, buildContract, integrationRefs, verifiedAt)
	if err != nil {
		return VerifyResult{}, err
	}
	return VerifyResult{Outcome: "candidate", Checkpoint: checkpoint, CheckpointReference: checkpointRef, Candidate: &candidate, CandidateReference: &candidateRef, State: advanced, RequestReference: &currentRef}, nil
}

func Reuse(ctx context.Context, projectDir, coreDir, candidatePath, reason, reusedAt string) (ReuseResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage06)
	if err != nil {
		return ReuseResult{}, err
	}
	candidate, candidateRef, _, err := stageruntime.ReadCanonical[RunnableCandidate](current.ProjectDir, candidatePath, "runnable-candidate", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	buildCurrent, buildCurrentRef, _, err := stageruntime.ReadCanonical[st05buildcontract.Current](current.ProjectDir, st05buildcontract.CurrentPath(current.Snapshot.RecordDir), "build-contract-current", 1)
	if err != nil {
		return ReuseResult{}, err
	}
	if buildCurrent.BuildContractRef == nil || candidate.BuildContractRef != *buildCurrent.BuildContractRef {
		return ReuseResult{}, fmt.Errorf("ST-06 Build: reused Candidate does not match active Build Contract")
	}
	for _, result := range candidate.SourceResults {
		repository := result.SourceLocator
		if strings.Contains(repository, ",") {
			return ReuseResult{}, fmt.Errorf("ST-06 Build: reused Candidate source mapping is ambiguous")
		}
		root := filepath.Join(current.ProjectDir, filepath.FromSlash(repository))
		head, err := git(ctx, root, "rev-parse", "HEAD")
		if err != nil || head != result.CandidateRevision {
			return ReuseResult{}, fmt.Errorf("ST-06 Build: reused Candidate revision is not present: %s", result.CandidateRevision)
		}
	}
	if reusedAt == "" {
		reusedAt = stageruntime.Now()
	}
	pointer := Current{SchemaVersion: 1, Artifact: "build-current", Version: 1, IntentID: current.Snapshot.State.IntentID, Disposition: contract.Reuse, BuildContractCurrentRef: buildCurrentRef, RunnableCandidateRef: &candidateRef, Reason: reason, UpdatedAt: reusedAt}
	currentRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), pointer.Artifact, 1, pointer, false)
	if err != nil {
		return ReuseResult{}, err
	}
	revised, err := revisePlan(current, contract.Reuse, "st06-reuse", reason, []contract.ArtifactReference{candidateRef, currentRef})
	if err != nil {
		return ReuseResult{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	advanced, err := stageruntime.Advance(ctx, current, currentRef, "runnable-candidate-validator", "ST-07 Human Feedback & Approval is ready for Core preparation.", reusedAt)
	if err != nil {
		return ReuseResult{}, err
	}
	return ReuseResult{Current: pointer, CurrentReference: currentRef, ReusedCandidateReference: candidateRef, State: advanced}, nil
}

type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, "")
	if err != nil {
		return directive.Core{}, err
	}
	if prepared.Execution == "advanced" && prepared.CurrentReference != nil {
		from, to := contract.Stage06, contract.Stage07
		result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Advanced, CompletedStage: &from, Stage: &to, Reason: "ST-06 had no executable Bolt; Core recorded deterministic not_applicable and advanced to ST-07.", Evidence: []contract.ArtifactReference{*prepared.CurrentReference}, GraphVersion: prepared.State.GraphVersion, PlanRevision: prepared.State.PlanRevision, DecisionAuthority: "core"}
		return result, result.Validate()
	}
	if prepared.Reference == nil {
		return directive.Core{}, fmt.Errorf("ST-06 Build did not produce a Work Request")
	}
	stageID := contract.Stage06
	result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Work, Stage: &stageID, Reason: "Core selected the next Bolt; AI may implement only that Bolt in supplied isolated Git worktrees.", Request: prepared.Reference, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
	return result, result.Validate()
}

func createRepositories(ctx context.Context, projectDir, recordDir, intentID string, build st05buildcontract.BuildContract, at string) ([]RepositoryWorkspace, error) {
	roots := map[string]*RepositoryWorkspace{}
	for _, source := range build.TargetSources {
		sourceRoot := projectDir
		if source.Locator != "." {
			sourceRoot = filepath.Join(projectDir, filepath.FromSlash(source.Locator))
		}
		repoRoot, err := git(ctx, sourceRoot, "rev-parse", "--show-toplevel")
		if err != nil {
			return nil, fmt.Errorf("ST-06 Build: selected source is not inside Git: %s", source.Locator)
		}
		canonicalRepo, err := filepath.EvalSymlinks(repoRoot)
		if err != nil {
			return nil, err
		}
		canonicalSource, err := filepath.EvalSymlinks(sourceRoot)
		if err != nil {
			return nil, err
		}
		repoRoot = canonicalRepo
		relative, err := filepath.Rel(repoRoot, canonicalSource)
		if err != nil {
			return nil, err
		}
		if relative == "" {
			relative = "."
		}
		repository := roots[repoRoot]
		if repository == nil {
			id := "repo-" + digest.Bytes([]byte(repoRoot))[7:19]
			base, err := git(ctx, repoRoot, "rev-parse", "HEAD")
			if err != nil {
				return nil, err
			}
			branch := "aidlc/" + intentID[:min(12, len(intentID))] + "/integration-" + id
			tree := filepath.Join(RootDir(recordDir), "worktrees", id, "integration")
			if err := os.MkdirAll(filepath.Dir(tree), 0o755); err != nil {
				return nil, err
			}
			if err := ensureWorktree(ctx, repoRoot, tree, branch, base); err != nil {
				return nil, err
			}
			value := RepositoryWorkspace{RepositoryID: id, RepositoryRoot: repoRoot, BaseRevision: base, WorkingRevision: base, IntegrationBranch: branch, IntegrationWorktree: tree, Sources: []SourceBinding{}}
			repository = &value
			roots[repoRoot] = repository
		}
		repository.Sources = append(repository.Sources, SourceBinding{SourceID: source.SourceID, Locator: source.Locator, RelativePath: filepath.ToSlash(relative)})
	}
	result := make([]RepositoryWorkspace, 0, len(roots))
	for _, value := range roots {
		result = append(result, *value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].RepositoryID < result[j].RepositoryID })
	return result, nil
}

func buildRequest(ctx context.Context, projectDir, recordDir string, session Session, build st05buildcontract.BuildContract, bolt st05buildcontract.Bolt, attempt int, at string) (WorkRequest, contract.ArtifactReference, error) {
	workspaces := []SourceWorkspace{}
	for _, repository := range session.Repositories {
		boltBranch := repository.IntegrationBranch + "-" + strings.ToLower(bolt.BoltID) + "-a" + fmt.Sprint(attempt)
		boltTree := filepath.Join(RootDir(recordDir), "worktrees", repository.RepositoryID, strings.ToLower(bolt.BoltID), fmt.Sprintf("attempt-%06d", attempt))
		head, err := git(ctx, repository.IntegrationWorktree, "rev-parse", "HEAD")
		if err != nil {
			return WorkRequest{}, contract.ArtifactReference{}, err
		}
		if err := ensureWorktree(ctx, repository.RepositoryRoot, boltTree, boltBranch, head); err != nil {
			return WorkRequest{}, contract.ArtifactReference{}, err
		}
		for _, source := range repository.Sources {
			used := false
			for _, target := range bolt.Targets {
				if target.SourceID == source.SourceID {
					used = true
				}
			}
			if used {
				path := boltTree
				if source.RelativePath != "." {
					path = filepath.Join(boltTree, filepath.FromSlash(source.RelativePath))
				}
				workspaces = append(workspaces, SourceWorkspace{SourceID: source.SourceID, Locator: source.Locator, RepositoryID: repository.RepositoryID, RepositoryRoot: repository.RepositoryRoot, WorktreePath: path, BaseRevision: repository.BaseRevision})
			}
		}
	}
	contracts := []st05buildcontract.ChangeContract{}
	for _, item := range build.ChangeContracts {
		if contains(bolt.ContractIDs, item.ContractID) {
			contracts = append(contracts, item)
		}
	}
	criteria := []st05buildcontract.AcceptanceCriterion{}
	verifierIDs := map[string]bool{}
	for _, item := range build.AcceptanceCriteria {
		if contains(bolt.AcceptanceCriterionIDs, item.CriterionID) {
			criteria = append(criteria, item)
			for _, id := range item.VerifierIDs {
				verifierIDs[id] = true
			}
		}
	}
	verifiers := []st05buildcontract.Verifier{}
	for _, item := range build.Verifiers {
		if verifierIDs[item.VerifierID] {
			verifiers = append(verifiers, item)
		}
	}
	request := WorkRequest{SchemaVersion: 1, Artifact: "bolt-work-request", Version: 1, SessionID: session.SessionID, IntentID: session.IntentID, StageID: contract.Stage06, BuildContractRef: session.BuildContractRef, Bolt: bolt, ChangeContracts: contracts, AcceptanceCriteria: criteria, Verifiers: verifiers, Attempt: attempt, SourceWorkspaces: workspaces, RequestedOutput: "repository-changes", Rules: []string{"Modify only declared target paths in the supplied worktrees.", "Do not commit, merge, release, or alter Core-owned artifacts.", "Core executes every approved verifier with explicit argv and timeout.", "Repeated identical failures stop after three attempts."}, CreatedAt: at}
	reference, _, err := stageruntime.WriteCanonical(projectDir, WorkRequestPath(recordDir, bolt.BoltID), request.Artifact, 1, request, false)
	return request, reference, err
}

func ensureWorktree(ctx context.Context, repositoryRoot, tree, branch, revision string) error {
	info, err := os.Lstat(tree)
	if err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("ST-06 Build: Worktree path must be a non-symlink directory: %s", tree)
		}
		actualRoot, err := git(ctx, tree, "rev-parse", "--show-toplevel")
		if err != nil {
			return fmt.Errorf("ST-06 Build: existing Worktree path is not a registered Git worktree: %s", tree)
		}
		canonicalActual, err := filepath.EvalSymlinks(actualRoot)
		if err != nil {
			return err
		}
		canonicalExpected, err := filepath.EvalSymlinks(tree)
		if err != nil {
			return err
		}
		if canonicalActual != canonicalExpected {
			return fmt.Errorf("ST-06 Build: existing Worktree resolves to a different root: %s", tree)
		}
		actualBranch, err := git(ctx, tree, "symbolic-ref", "--short", "HEAD")
		if err != nil || actualBranch != branch {
			return fmt.Errorf("ST-06 Build: existing Worktree is bound to a different branch: %s", tree)
		}
		actualRevision, err := git(ctx, tree, "rev-parse", "HEAD")
		if err != nil || actualRevision != revision {
			return fmt.Errorf("ST-06 Build: existing Worktree revision differs before Session persistence: %s", tree)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(tree), 0o755); err != nil {
		return err
	}
	if _, err := git(ctx, repositoryRoot, "worktree", "prune"); err != nil {
		return err
	}
	if _, err := git(ctx, repositoryRoot, "branch", "-f", branch, revision); err != nil {
		return err
	}
	if _, err := git(ctx, repositoryRoot, "worktree", "add", "--force", tree, branch); err != nil {
		return err
	}
	return nil
}

func collectChanges(ctx context.Context, request WorkRequest) ([]ChangedFile, []string, error) {
	allowed := map[string]map[string]bool{}
	for _, target := range request.Bolt.Targets {
		if allowed[target.SourceID] == nil {
			allowed[target.SourceID] = map[string]bool{}
		}
		allowed[target.SourceID][target.Path] = true
	}
	changed := []ChangedFile{}
	issues := []string{}
	for _, workspace := range request.SourceWorkspaces {
		output, err := git(ctx, workspace.WorktreePath, "status", "--porcelain=v1", "--untracked-files=all")
		if err != nil {
			return nil, nil, err
		}
		for _, line := range strings.Split(output, "\n") {
			if len(line) < 4 {
				continue
			}
			statusCode := strings.TrimSpace(line[:2])
			path := strings.TrimSpace(line[3:])
			if strings.Contains(path, " -> ") {
				parts := strings.Split(path, " -> ")
				path = parts[len(parts)-1]
			}
			path = filepath.ToSlash(path)
			permitted := false
			for target := range allowed[workspace.SourceID] {
				if path == target || strings.HasPrefix(path, strings.TrimSuffix(target, "/")+"/") {
					permitted = true
				}
			}
			if !permitted {
				issues = append(issues, "Changed path is outside the Bolt contract: "+workspace.SourceID+":"+path)
			}
			status := "modified"
			if strings.Contains(statusCode, "?") || strings.Contains(statusCode, "A") {
				status = "added"
			} else if strings.Contains(statusCode, "D") {
				status = "deleted"
			} else if strings.Contains(statusCode, "R") {
				status = "renamed"
			}
			var sha *string
			if status != "deleted" {
				content, readErr := os.ReadFile(filepath.Join(workspace.WorktreePath, filepath.FromSlash(path)))
				if readErr == nil {
					value := digest.Bytes(content)
					sha = &value
				}
			}
			changed = append(changed, ChangedFile{SourceID: workspace.SourceID, Path: path, Status: status, SHA256: sha})
		}
	}
	sort.Slice(changed, func(i, j int) bool {
		if changed[i].SourceID == changed[j].SourceID {
			return changed[i].Path < changed[j].Path
		}
		return changed[i].SourceID < changed[j].SourceID
	})
	return changed, issues, nil
}

func runVerifiers(ctx context.Context, projectDir, recordDir string, session Session, request WorkRequest, verifiers []st05buildcontract.Verifier, workspaces []SourceWorkspace, scope, at string) ([]VerifierEvidence, []contract.ArtifactReference) {
	evidence := []VerifierEvidence{}
	references := []contract.ArtifactReference{}
	for _, verifier := range verifiers {
		result := runVerifier(ctx, session, request, verifier, workspaces, scope, at)
		path := IntegrationVerifierPath(recordDir, session.SessionID, verifier.VerifierID)
		if scope == "bolt" {
			path = VerifierPath(recordDir, request.Bolt.BoltID, request.Attempt, verifier.VerifierID)
		}
		reference, _, err := stageruntime.WriteCanonical(projectDir, path, result.Artifact, 1, result, true)
		if err != nil {
			result.Result = "failed"
			result.Detail = err.Error()
		} else {
			references = append(references, reference)
		}
		evidence = append(evidence, result)
	}
	return evidence, references
}
func runVerifier(ctx context.Context, session Session, request WorkRequest, verifier st05buildcontract.Verifier, workspaces []SourceWorkspace, scope, at string) VerifierEvidence {
	boltID := &request.Bolt.BoltID
	attempt := &request.Attempt
	if scope == "integration" {
		boltID = nil
		attempt = nil
	}
	result := VerifierEvidence{SchemaVersion: 1, Artifact: "verifier-evidence", Version: 1, IntentID: session.IntentID, SessionID: session.SessionID, BoltID: boltID, Attempt: attempt, Scope: scope, VerifierID: verifier.VerifierID, VerifierKind: verifier.Kind, Result: "failed", Detail: "Verifier failed.", ExecutedAt: at}
	if verifier.Kind == "human-at-st07" {
		result.Result = "deferred"
		result.Detail = "Deferred to ST-07 human review."
		return result
	}
	workspace := workspaceFor(workspaces, stringValue(verifier.SourceID))
	if workspace == nil {
		result.Detail = "Verifier source workspace is missing."
		return result
	}
	cwd := workspace.WorktreePath
	if verifier.CWD != nil && *verifier.CWD != "." {
		cwd = filepath.Join(cwd, filepath.FromSlash(*verifier.CWD))
	}
	if verifier.Kind == "command" {
		run, err := process.Run(ctx, process.Request{Executable: verifier.Argv[0], Args: verifier.Argv[1:], Dir: cwd, Env: os.Environ(), Timeout: time.Duration(verifier.TimeoutMS) * time.Millisecond, ExitCodes: verifier.ExpectedExitCodes})
		exit := run.ExitCode
		result.ExitCode = &exit
		out := digest.Bytes(run.Stdout)
		errout := digest.Bytes(run.Stderr)
		result.StdoutSHA256 = &out
		result.StderrSHA256 = &errout
		if err == nil {
			result.Result = "passed"
			result.Detail = "Command completed with an approved exit code."
		} else {
			result.Detail = err.Error()
		}
		return result
	}
	if verifier.Kind == "artifact" && verifier.ArtifactCheck != nil {
		path := filepath.Join(cwd, filepath.FromSlash(verifier.ArtifactCheck.Path))
		content, err := os.ReadFile(path)
		passed := err == nil
		detail := "Artifact exists."
		if passed && verifier.ArtifactCheck.Assertion == "sha256-equals" {
			passed = verifier.ArtifactCheck.Expected != nil && digest.Bytes(content) == *verifier.ArtifactCheck.Expected
		}
		if passed && verifier.ArtifactCheck.Assertion == "content-includes" {
			passed = verifier.ArtifactCheck.Expected != nil && bytes.Contains(content, []byte(*verifier.ArtifactCheck.Expected))
		}
		if passed {
			result.Result = "passed"
		} else {
			detail = "Artifact assertion failed."
		}
		result.Detail = detail
		return result
	}
	if verifier.Kind == "runtime" && verifier.RuntimeCheck != nil {
		check := verifier.RuntimeCheck
		if len(check.StartArgv) == 0 {
			result.Detail = "Runtime verifier start_argv is empty."
			return result
		}
		runtimeCtx, cancel := context.WithTimeout(ctx, time.Duration(verifier.TimeoutMS)*time.Millisecond)
		defer cancel()
		command := exec.CommandContext(runtimeCtx, check.StartArgv[0], check.StartArgv[1:]...)
		command.Dir = cwd
		command.Env = os.Environ()
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		if err := command.Start(); err != nil {
			result.Detail = fmt.Sprintf("start runtime verifier: %v", err)
			return result
		}
		done := make(chan error, 1)
		go func() { done <- command.Wait() }()
		defer func() {
			if command.Process != nil {
				_ = command.Process.Kill()
			}
			select {
			case <-done:
			case <-time.After(time.Second):
			}
		}()
		client := http.Client{Timeout: time.Duration(check.StartupTimeoutMS) * time.Millisecond}
		deadline := time.NewTimer(time.Duration(check.StartupTimeoutMS) * time.Millisecond)
		defer deadline.Stop()
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			response, requestErr := client.Get(fmt.Sprintf("http://%s:%d%s", check.Host, check.Port, check.Path))
			if requestErr == nil {
				_ = response.Body.Close()
				if response.StatusCode == check.ExpectedStatus {
					result.Result = "passed"
					result.Detail = "Runtime endpoint returned the approved status."
					return result
				}
			}
			select {
			case err := <-done:
				result.Detail = fmt.Sprintf("runtime verifier exited before becoming ready: %v; stderr=%s", err, strings.TrimSpace(stderr.String()))
				return result
			case <-deadline.C:
				result.Detail = "Runtime endpoint did not become ready before startup_timeout_ms."
				return result
			case <-ticker.C:
			case <-runtimeCtx.Done():
				result.Detail = runtimeCtx.Err().Error()
				return result
			}
		}
	}
	return result
}

func commitAndIntegrate(ctx context.Context, projectDir, recordDir string, session Session, request WorkRequest) error {
	seen := map[string]bool{}
	for _, workspace := range request.SourceWorkspaces {
		if seen[workspace.RepositoryID] {
			continue
		}
		seen[workspace.RepositoryID] = true
		if _, err := git(ctx, workspace.WorktreePath, "add", "--all"); err != nil {
			return err
		}
		if _, err := git(ctx, workspace.WorktreePath, "-c", "user.name=AI-DLC Core", "-c", "user.email=aidlc-core@local", "commit", "-m", "aidlc("+request.Bolt.BoltID+"): "+request.Bolt.Title); err != nil {
			return err
		}
		branch, err := git(ctx, workspace.WorktreePath, "branch", "--show-current")
		if err != nil {
			return err
		}
		repository := repositoryFor(session.Repositories, workspace.RepositoryID)
		if repository == nil {
			return fmt.Errorf("repository workspace missing")
		}
		if _, err := git(ctx, repository.IntegrationWorktree, "merge", "--ff-only", branch); err != nil {
			return err
		}
		_, _ = audit.Append(ctx, projectDir, recordDir, audit.WorktreeMerged, []audit.Field{{Name: "Stage", Value: "ST-06"}, {Name: "Bolt", Value: request.Bolt.BoltID}, {Name: "Repository", Value: workspace.RepositoryID}, {Name: "Branch", Value: branch}, {Name: "Decision Authority", Value: "core"}}, nil)
		_, _ = git(ctx, repository.RepositoryRoot, "worktree", "remove", "--force", attemptRoot(*repository, workspace.WorktreePath))
	}
	return nil
}

func completeCandidate(ctx context.Context, current stageruntime.Context, session Session, build st05buildcontract.BuildContract, integrationRefs []contract.ArtifactReference, at string) (RunnableCandidate, contract.ArtifactReference, contract.ArtifactReference, state.IntentState, error) {
	sourceResults := []SourceResult{}
	for _, repository := range session.Repositories {
		revision, err := git(ctx, repository.IntegrationWorktree, "rev-parse", "HEAD")
		if err != nil {
			return RunnableCandidate{}, contract.ArtifactReference{}, contract.ArtifactReference{}, state.IntentState{}, err
		}
		diff, _ := git(ctx, repository.IntegrationWorktree, "diff", "--name-only", repository.BaseRevision+".."+revision)
		files := nonEmptyLines(diff)
		sourceIDs := []string{}
		locators := []string{}
		for _, source := range repository.Sources {
			sourceIDs = append(sourceIDs, source.SourceID)
			locators = append(locators, source.Locator)
		}
		sourceResults = append(sourceResults, SourceResult{RepositoryID: repository.RepositoryID, SourceIDs: sourceIDs, SourceLocator: strings.Join(locators, ","), BaseRevision: repository.BaseRevision, CandidateRevision: revision, IntegrationBranch: repository.IntegrationBranch, ChangedFiles: files})
	}
	checkpoints := []contract.ArtifactReference{}
	for _, bolt := range build.Bolts {
		var passed *contract.ArtifactReference
		for attempt := 1; attempt < 10000; attempt++ {
			path := CheckpointPath(current.Snapshot.RecordDir, bolt.BoltID, attempt)
			checkpoint, reference, _, err := stageruntime.ReadCanonical[Checkpoint](current.ProjectDir, path, "build-attempt-checkpoint", 1)
			if err != nil {
				break
			}
			if checkpoint.Outcome == "passed" {
				copy := reference
				passed = &copy
			}
		}
		if passed == nil {
			return RunnableCandidate{}, contract.ArtifactReference{}, contract.ArtifactReference{}, state.IntentState{}, fmt.Errorf("ST-06 Build: no passing Checkpoint for %s", bolt.BoltID)
		}
		checkpoints = append(checkpoints, *passed)
	}
	candidate := RunnableCandidate{SchemaVersion: 1, Artifact: "runnable-candidate", Version: 1, IntentID: session.IntentID, SessionID: session.SessionID, Disposition: contract.Execute, BuildContractRef: session.BuildContractRef, SourceResults: sourceResults, BoltCheckpointRefs: checkpoints, IntegrationVerifierEvidenceRefs: integrationRefs, CreatedAt: at}
	candidateRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CandidatePath(current.Snapshot.RecordDir), candidate.Artifact, 1, candidate, false)
	if err != nil {
		return RunnableCandidate{}, contract.ArtifactReference{}, contract.ArtifactReference{}, state.IntentState{}, err
	}
	pointer := Current{SchemaVersion: 1, Artifact: "build-current", Version: 1, IntentID: session.IntentID, Disposition: contract.Execute, BuildContractCurrentRef: session.BuildContractCurrentRef, RunnableCandidateRef: &candidateRef, Reason: "All Core-selected Bolts and integration verifiers passed.", UpdatedAt: at}
	currentRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentPath(current.Snapshot.RecordDir), pointer.Artifact, 1, pointer, false)
	if err != nil {
		return RunnableCandidate{}, contract.ArtifactReference{}, contract.ArtifactReference{}, state.IntentState{}, err
	}
	revised, err := revisePlan(current, contract.Execute, session.SessionID, pointer.Reason, []contract.ArtifactReference{candidateRef, currentRef})
	if err != nil {
		return RunnableCandidate{}, contract.ArtifactReference{}, contract.ArtifactReference{}, state.IntentState{}, err
	}
	current.Snapshot.Plan = revised
	current.Snapshot.State.PlanRevision = revised.Revision
	advanced, err := stageruntime.Advance(ctx, current, currentRef, "runnable-candidate-validator", "ST-07 Human Feedback & Approval is ready for Core preparation.", at)
	return candidate, candidateRef, currentRef, advanced, err
}

func revisePlan(current stageruntime.Context, disposition contract.Disposition, id, reason string, evidence []contract.ArtifactReference) (contract.StageExecutionPlan, error) {
	proposal := contract.StageDispositionProposal{SchemaVersion: 1, ProposalID: id, StageID: contract.Stage06, Disposition: disposition, Reason: reason, Evidence: evidence, ProposedBy: contract.ProposerCore}
	return workflowplan.Revise(current.Snapshot.Plan, []contract.StageDispositionProposal{proposal}, workflowplan.RevisionOptions{ProjectDir: current.ProjectDir, StageContracts: []contract.StageContract{current.Contract}, DeterministicApplicability: func(value contract.StageDispositionProposal, _ contract.StageContract) bool {
		return value.Disposition == contract.NotApplicable
	}})
}
func readyBolt(build st05buildcontract.BuildContract, completed []string) (st05buildcontract.Bolt, bool) {
	done := map[string]bool{}
	for _, id := range completed {
		done[id] = true
	}
	for _, batch := range build.DerivedBatches {
		for _, id := range batch {
			if done[id] {
				continue
			}
			for _, bolt := range build.Bolts {
				if bolt.BoltID == id {
					return bolt, true
				}
			}
		}
	}
	return st05buildcontract.Bolt{}, false
}
func git(ctx context.Context, dir string, args ...string) (string, error) {
	result, err := process.Run(ctx, process.Request{Executable: "git", Args: args, Dir: dir, Env: os.Environ(), ExitCodes: []int{0}})
	if err != nil {
		return "", fmt.Errorf("git %s in %s: %w: %s", strings.Join(args, " "), dir, err, strings.TrimSpace(string(result.Stderr)))
	}
	return strings.TrimSpace(string(result.Stdout)), nil
}
func workspaceFor(values []SourceWorkspace, id string) *SourceWorkspace {
	for index := range values {
		if values[index].SourceID == id {
			return &values[index]
		}
	}
	return nil
}
func repositoryFor(values []RepositoryWorkspace, id string) *RepositoryWorkspace {
	for index := range values {
		if values[index].RepositoryID == id {
			return &values[index]
		}
	}
	return nil
}
func integrationWorkspaces(session Session) []SourceWorkspace {
	result := []SourceWorkspace{}
	for _, repository := range session.Repositories {
		for _, source := range repository.Sources {
			path := repository.IntegrationWorktree
			if source.RelativePath != "." {
				path = filepath.Join(path, filepath.FromSlash(source.RelativePath))
			}
			result = append(result, SourceWorkspace{SourceID: source.SourceID, Locator: source.Locator, RepositoryID: repository.RepositoryID, RepositoryRoot: repository.RepositoryRoot, WorktreePath: path, BaseRevision: repository.BaseRevision})
		}
	}
	return result
}
func attemptRoot(repository RepositoryWorkspace, sourceWorkspace string) string {
	cleaned := filepath.Clean(sourceWorkspace)
	for _, source := range repository.Sources {
		if source.RelativePath == "." {
			return cleaned
		}
		suffix := filepath.FromSlash(source.RelativePath)
		if strings.HasSuffix(cleaned, suffix) {
			return strings.TrimSuffix(cleaned, suffix)
		}
	}
	return cleaned
}
func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
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
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func nonEmptyLines(value string) []string {
	result := []string{}
	for _, line := range strings.Split(value, "\n") {
		if strings.TrimSpace(line) != "" {
			result = append(result, filepath.ToSlash(strings.TrimSpace(line)))
		}
	}
	sort.Strings(result)
	return result
}
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var _ = containsRef
