// Package hooksubagent validates the structured return contract of an
// AI-DLC Stage Agent at Codex SubagentStop.
package hooksubagent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st06build"
	"github.com/sori883/aidlc/internal/workflow/delegation"
	"github.com/sori883/aidlc/internal/workflow/state"
)

const (
	SchemaVersion  = 1
	markerPrefix   = "AIDLC_STAGE_RESULT: "
	maxInputBytes  = 2 * 1024 * 1024
	maxMarkerBytes = 64 * 1024
)

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$`)

// Options identifies the Harness and supplies deterministic time in tests.
type Options struct {
	Harness string
	Clock   func() time.Time
}

// Output is one changed file reported by a Stage Agent.
type Output struct {
	Path   string  `json:"path"`
	Status string  `json:"status"`
	SHA256 *string `json:"sha256"`
}

// ReviewedPath binds one read-only review input to its bytes.
type ReviewedPath struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// StageResult is the strict JSON object following AIDLC_STAGE_RESULT.
type StageResult struct {
	SchemaVersion       int              `json:"schema_version"`
	AgentName           string           `json:"agent_name"`
	StageID             contract.StageID `json:"stage_id"`
	AssignmentKind      string           `json:"assignment_kind"`
	Role                string           `json:"role"`
	Status              string           `json:"status"`
	MutationScope       string           `json:"mutation_scope"`
	Outputs             []Output         `json:"outputs"`
	ReviewedPaths       []ReviewedPath   `json:"reviewed_paths"`
	Checks              []string         `json:"checks"`
	Skills              []string         `json:"skills"`
	UnresolvedQuestions []string         `json:"unresolved_questions"`
}

// Receipt is immutable evidence that the Hook validated one Stage result. It
// does not mean Core accepted the work.
type Receipt struct {
	SchemaVersion int              `json:"schema_version"`
	Artifact      string           `json:"artifact"`
	Version       int              `json:"version"`
	ReceiptID     string           `json:"receipt_id"`
	IntentID      string           `json:"intent_id"`
	AgentID       string           `json:"agent_id"`
	AgentType     string           `json:"agent_type"`
	SessionID     string           `json:"session_id"`
	StageID       contract.StageID `json:"stage_id"`
	ResultSHA256  string           `json:"result_sha256"`
	Result        StageResult      `json:"result"`
	ObservedAt    string           `json:"observed_at"`
}

// Status describes the response category selected for SubagentStop.
type Status string

const (
	Accepted Status = "accepted"
	Continue Status = "continue-subagent"
	Released Status = "released-to-conductor"
	Noop     Status = "noop"
)

// Result is one Hook decision and optional immutable Receipt.
type Result struct {
	Status           Status                      `json:"status"`
	ReasonCode       string                      `json:"reason_code,omitempty"`
	Attempts         int                         `json:"attempts"`
	ReceiptReference *contract.ArtifactReference `json:"receipt_reference,omitempty"`
}

// ReceiptInventory summarizes verified current delegation Receipts.
type ReceiptInventory struct {
	Present       bool     `json:"present"`
	ValidReceipts int      `json:"valid_receipts"`
	AgentIDs      []string `json:"agent_ids"`
}

type codexInput struct {
	SessionID            string `json:"session_id"`
	TurnID               string `json:"turn_id"`
	CWD                  string `json:"cwd"`
	HookEventName        string `json:"hook_event_name"`
	AgentID              string `json:"agent_id"`
	AgentType            string `json:"agent_type"`
	AgentTranscriptPath  string `json:"agent_transcript_path"`
	StopHookActive       bool   `json:"stop_hook_active"`
	LastAssistantMessage string `json:"last_assistant_message"`
}

type assignmentMatch struct {
	assignment delegation.Assignment
	kind       string
	role       string
	scope      string
}

type continuationState struct {
	SchemaVersion int    `json:"schema_version"`
	AgentID       string `json:"agent_id"`
	AgentType     string `json:"agent_type"`
	StageID       string `json:"stage_id"`
	FailureCode   string `json:"failure_code"`
	Signature     string `json:"signature"`
	Attempts      int    `json:"attempts"`
	Status        string `json:"status"`
	ObservedAt    string `json:"observed_at"`
}

// CurrentReceipt is a mutable pointer to the latest immutable Receipt for one
// Agent ID in the active Intent.
type CurrentReceipt struct {
	SchemaVersion    int                        `json:"schema_version"`
	AgentID          string                     `json:"agent_id"`
	IntentID         string                     `json:"intent_id"`
	StageID          contract.StageID           `json:"stage_id"`
	ReceiptReference contract.ArtifactReference `json:"receipt_reference"`
	UpdatedAt        string                     `json:"updated_at"`
}

type validationFailure struct{ code string }

func (failure validationFailure) Error() string { return failure.code }

// Validate consumes one SubagentStop delivery. Invalid Stage results receive
// one bounded continuation; a repeated stop is released to the Conductor to
// prevent a continuation trap.
func Validate(ctx context.Context, projectDir, coreDir string, input io.Reader, options Options) (Result, error) {
	projectRoot, err := realDirectory(projectDir)
	if err != nil {
		return Result{}, err
	}
	if options.Harness == "" {
		options.Harness = "codex"
	}
	if options.Harness != "codex" {
		return Result{}, fmt.Errorf("unsupported Hook harness: %s", options.Harness)
	}
	delivery, err := decodeCodex(input)
	if err != nil {
		return Result{}, err
	}
	if err := validateDelivery(projectRoot, delivery); err != nil {
		return Result{}, err
	}

	result := Result{Status: Noop}
	err = lock.With(ctx, projectRoot, lock.Options{MaxRetries: 60, Retry: 25 * time.Millisecond}, func(context.Context) error {
		inspection, inspectErr := state.InspectActive(projectRoot)
		if inspectErr != nil || inspection.Kind != state.InspectionVNext {
			return nil
		}
		snapshot, readErr := state.Read(inspection.RecordDir)
		if readErr != nil {
			return readErr
		}
		catalog, loadErr := delegation.Load(coreDir)
		if loadErr != nil {
			return loadErr
		}
		stage, ok := catalog.Find(snapshot.State.CurrentStage)
		if !ok {
			return fmt.Errorf("Delegation Catalog has no active Stage")
		}
		parsed, validationErr := validateResult(projectRoot, inspection.RecordDir, snapshot, stage, delivery)
		if validationErr == nil {
			reference, receiptErr := writeReceipt(projectRoot, inspection.RecordDir, snapshot, delivery, parsed, options.Clock)
			if receiptErr != nil {
				return receiptErr
			}
			if err := writeContinuation(projectRoot, inspection.RecordDir, continuationState{SchemaVersion: SchemaVersion, AgentID: delivery.AgentID, AgentType: delivery.AgentType, StageID: string(snapshot.State.CurrentStage), Attempts: 0, Status: string(Accepted), ObservedAt: iso(now(options.Clock))}); err != nil {
				return err
			}
			result = Result{Status: Accepted, ReceiptReference: &reference}
			return nil
		}
		var invalid validationFailure
		if !errors.As(validationErr, &invalid) {
			return validationErr
		}
		attempts, attemptErr := recordFailure(projectRoot, inspection.RecordDir, snapshot, delivery, invalid.code, options.Clock)
		if attemptErr != nil {
			return attemptErr
		}
		result = Result{Status: Continue, ReasonCode: invalid.code, Attempts: attempts}
		if delivery.StopHookActive || attempts >= 2 {
			result.Status = Released
			if err := markReleased(projectRoot, inspection.RecordDir, snapshot, delivery, invalid.code, attempts, options.Clock); err != nil {
				return err
			}
		}
		return nil
	})
	return result, err
}

// MarshalResponse produces only documented Codex SubagentStop JSON shapes.
func MarshalResponse(result Result) ([]byte, error) {
	var value any
	switch result.Status {
	case Accepted, Noop:
		value = struct{}{}
	case Continue:
		value = struct {
			Decision string `json:"decision"`
			Reason   string `json:"reason"`
		}{Decision: "block", Reason: "AI-DLC Stage result is invalid (" + result.ReasonCode + "). Return one corrected AIDLC_STAGE_RESULT JSON marker; do not broaden the assignment."}
	case Released:
		value = struct {
			Continue      bool   `json:"continue"`
			StopReason    string `json:"stopReason"`
			SystemMessage string `json:"systemMessage"`
		}{Continue: false, StopReason: "AI-DLC released an invalid Stage result after bounded continuation.", SystemMessage: "The Conductor must treat the Stage Agent result as unvalidated and must not submit it to Core."}
	default:
		return nil, fmt.Errorf("unknown SubagentStop result status: %s", result.Status)
	}
	content, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return append(content, '\n'), nil
}

// MarshalFailureResponse fails open at the Hook layer to avoid trapping the
// subagent. Core and the Conductor still require an immutable Receipt.
func MarshalFailureResponse() []byte { return []byte("{}\n") }

func validateResult(projectRoot, recordDir string, snapshot state.Snapshot, stage delegation.Stage, delivery codexInput) (StageResult, error) {
	marker, err := extractMarker(delivery.LastAssistantMessage)
	if err != nil {
		return StageResult{}, err
	}
	value, err := jsonx.Decode[StageResult](marker)
	if err != nil {
		return StageResult{}, validationFailure{code: "invalid-result-json"}
	}
	if value.SchemaVersion != SchemaVersion || value.AgentName != delivery.AgentType || value.StageID != snapshot.State.CurrentStage {
		return StageResult{}, validationFailure{code: "identity-mismatch"}
	}
	if value.Outputs == nil || value.ReviewedPaths == nil || value.Checks == nil || value.Skills == nil || value.UnresolvedQuestions == nil {
		return StageResult{}, validationFailure{code: "missing-result-array"}
	}
	match, ok := matchAssignment(stage, delivery.AgentType, value.AssignmentKind, value.Role)
	if !ok || value.MutationScope != match.scope {
		return StageResult{}, validationFailure{code: "assignment-mismatch"}
	}
	if !requiredSkills(value.Skills, match.assignment.RequiredSkills) {
		return StageResult{}, validationFailure{code: "required-skill-missing"}
	}
	if err := validateLines(value.Checks, "check", 64); err != nil {
		return StageResult{}, err
	}
	if err := validateLines(value.Skills, "skill", 32); err != nil {
		return StageResult{}, err
	}
	if err := validateLines(value.UnresolvedQuestions, "question", 32); err != nil {
		return StageResult{}, err
	}
	if !validStatus(value.AssignmentKind, value.Role, value.Status) {
		return StageResult{}, validationFailure{code: "status-mismatch"}
	}
	if value.Status == "blocked" {
		if len(value.UnresolvedQuestions) == 0 {
			return StageResult{}, validationFailure{code: "blocked-without-question"}
		}
	} else if len(value.Checks) == 0 {
		return StageResult{}, validationFailure{code: "checks-missing"}
	}

	switch match.scope {
	case "read-only":
		if len(value.Outputs) != 0 || len(value.ReviewedPaths) == 0 {
			return StageResult{}, validationFailure{code: "read-only-scope-mismatch"}
		}
		if err := verifyReviewed(projectRoot, value.ReviewedPaths); err != nil {
			return StageResult{}, err
		}
	case "proposal-only":
		if len(value.ReviewedPaths) != 0 || (value.Status != "blocked" && len(value.Outputs) == 0) {
			return StageResult{}, validationFailure{code: "proposal-scope-mismatch"}
		}
		if err := verifyProposalOutputs(projectRoot, value.Outputs); err != nil {
			return StageResult{}, err
		}
	case "assigned-worktree":
		if len(value.ReviewedPaths) != 0 || (value.Status != "blocked" && len(value.Outputs) == 0) {
			return StageResult{}, validationFailure{code: "worktree-scope-mismatch"}
		}
		if err := verifyWorktreeOutputs(projectRoot, recordDir, snapshot, value.Outputs); err != nil {
			return StageResult{}, err
		}
	default:
		return StageResult{}, validationFailure{code: "mutation-scope-invalid"}
	}
	return value, nil
}

func extractMarker(message string) ([]byte, error) {
	if len(message) == 0 || len(message) > maxInputBytes {
		return nil, validationFailure{code: "result-marker-missing"}
	}
	var marker string
	for _, line := range strings.Split(strings.ReplaceAll(message, "\r\n", "\n"), "\n") {
		if !strings.HasPrefix(line, markerPrefix) {
			continue
		}
		if marker != "" {
			return nil, validationFailure{code: "result-marker-duplicate"}
		}
		marker = strings.TrimPrefix(line, markerPrefix)
	}
	if marker == "" || len(marker) > maxMarkerBytes {
		return nil, validationFailure{code: "result-marker-missing"}
	}
	return []byte(marker), nil
}

func matchAssignment(stage delegation.Stage, agentType, kind, role string) (assignmentMatch, bool) {
	var assignment *delegation.Assignment
	switch kind {
	case "work":
		assignment = stage.WorkAssignment
	case "review":
		assignment = stage.ReviewAssignment
	default:
		return assignmentMatch{}, false
	}
	if assignment == nil {
		return assignmentMatch{}, false
	}
	matched := false
	switch role {
	case "lead":
		matched = assignment.LeadAgent == agentType
	case "support":
		for _, support := range assignment.SupportAgents {
			matched = matched || support == agentType
		}
	case "reviewer":
		matched = assignment.ReviewerAgent != nil && *assignment.ReviewerAgent == agentType
	}
	scope := assignment.MutationScope
	if role == "reviewer" {
		scope = "read-only"
	}
	return assignmentMatch{assignment: *assignment, kind: kind, role: role, scope: scope}, matched
}

func requiredSkills(actual, required []string) bool {
	seen := map[string]bool{}
	for _, value := range actual {
		if seen[value] {
			return false
		}
		seen[value] = true
	}
	for _, value := range required {
		if !seen[value] {
			return false
		}
	}
	return true
}

func validStatus(kind, role, status string) bool {
	if status == "blocked" {
		return true
	}
	if kind == "review" || role == "reviewer" {
		return status == "ready" || status == "not-ready"
	}
	return status == "completed"
}

func verifyProposalOutputs(projectRoot string, outputs []Output) error {
	seen := map[string]bool{}
	for _, output := range outputs {
		if seen[output.Path] {
			return validationFailure{code: "output-path-duplicate"}
		}
		seen[output.Path] = true
		absolute, err := outputPath(projectRoot, output, false)
		if err != nil {
			return err
		}
		if pathWithin(absolute, filepath.Join(projectRoot, "aidlc")) || pathWithin(absolute, filepath.Join(projectRoot, ".codex")) {
			return validationFailure{code: "proposal-protected-path"}
		}
	}
	return nil
}

func verifyReviewed(projectRoot string, paths []ReviewedPath) error {
	seen := map[string]bool{}
	for _, item := range paths {
		if seen[item.Path] || digest.Validate(item.SHA256) != nil {
			return validationFailure{code: "review-binding-invalid"}
		}
		seen[item.Path] = true
		absolute, err := resolveProjectPath(projectRoot, item.Path, false)
		if err != nil {
			return validationFailure{code: "review-path-invalid"}
		}
		actual, err := digestRegularFile(absolute)
		if err != nil || actual != item.SHA256 {
			return validationFailure{code: "review-digest-mismatch"}
		}
	}
	return nil
}

func verifyWorktreeOutputs(projectRoot, recordDir string, snapshot state.Snapshot, outputs []Output) error {
	allowed, err := worktreeTargets(projectRoot, recordDir, snapshot)
	if err != nil {
		return validationFailure{code: "worktree-scope-unavailable"}
	}
	seen := map[string]bool{}
	for _, output := range outputs {
		if seen[output.Path] {
			return validationFailure{code: "output-path-duplicate"}
		}
		seen[output.Path] = true
		absolute, err := outputPath(projectRoot, output, true)
		if err != nil {
			return err
		}
		permitted := false
		for _, target := range allowed {
			permitted = permitted || pathWithin(absolute, target)
		}
		if !permitted {
			return validationFailure{code: "worktree-target-mismatch"}
		}
	}
	return nil
}

func outputPath(projectRoot string, output Output, allowDeleted bool) (string, error) {
	if output.Status != "added" && output.Status != "modified" && output.Status != "deleted" && output.Status != "renamed" {
		return "", validationFailure{code: "output-status-invalid"}
	}
	absolute, err := resolveProjectPath(projectRoot, output.Path, output.Status == "deleted")
	if err != nil {
		return "", validationFailure{code: "output-path-invalid"}
	}
	if output.Status == "deleted" {
		if !allowDeleted || output.SHA256 != nil {
			return "", validationFailure{code: "deleted-output-invalid"}
		}
		if _, statErr := os.Lstat(absolute); !os.IsNotExist(statErr) {
			return "", validationFailure{code: "deleted-output-still-exists"}
		}
		return absolute, nil
	}
	if output.SHA256 == nil || digest.Validate(*output.SHA256) != nil {
		return "", validationFailure{code: "output-digest-invalid"}
	}
	actual, err := digestRegularFile(absolute)
	if err != nil || actual != *output.SHA256 {
		return "", validationFailure{code: "output-digest-mismatch"}
	}
	return absolute, nil
}

func worktreeTargets(projectRoot, recordDir string, snapshot state.Snapshot) ([]string, error) {
	session, _, _, err := stageruntime.ReadCanonical[st06build.Session](projectRoot, st06build.SessionPath(recordDir), "build-session", 1)
	if err != nil || session.CurrentBoltID == nil || session.StageID != contract.Stage06 || session.Status != "active" || session.IntentID != snapshot.State.IntentID {
		return nil, fmt.Errorf("invalid active Build Session")
	}
	request, _, _, err := stageruntime.ReadCanonical[st06build.WorkRequest](projectRoot, st06build.WorkRequestPath(recordDir, *session.CurrentBoltID), "bolt-work-request", 1)
	if err != nil || request.SessionID != session.SessionID || request.IntentID != snapshot.State.IntentID || request.Bolt.BoltID != *session.CurrentBoltID || request.Attempt < 1 {
		return nil, fmt.Errorf("invalid active Bolt Work Request")
	}
	var targets []string
	for _, workspace := range request.SourceWorkspaces {
		root, err := realDirectory(workspace.WorktreePath)
		if err != nil || !pathWithin(root, filepath.Join(recordDir, "artifacts", "build", "worktrees")) {
			return nil, fmt.Errorf("invalid Worktree")
		}
		matched := false
		for _, target := range request.Bolt.Targets {
			if target.SourceID != workspace.SourceID {
				continue
			}
			absolute, err := fsx.ResolveUnder(root, filepath.ToSlash(target.Path), true)
			if err != nil {
				return nil, err
			}
			targets = append(targets, filepath.Clean(absolute))
			matched = true
		}
		if !matched {
			return nil, fmt.Errorf("Worktree has no target")
		}
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("no Worktree target")
	}
	return targets, nil
}

func writeReceipt(projectRoot, recordDir string, snapshot state.Snapshot, delivery codexInput, result StageResult, clock func() time.Time) (contract.ArtifactReference, error) {
	resultContent, err := jsonx.MarshalCanonical(result)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	resultSHA := digest.Bytes(resultContent)
	receiptID := identifier("receipt", delivery.SessionID, delivery.AgentID, snapshot.State.IntentID, string(snapshot.State.CurrentStage), resultSHA)
	path := filepath.Join(recordDir, "artifacts", "delegation", "receipts", delivery.AgentID, receiptID+".json")
	var reference contract.ArtifactReference
	observedAt := iso(now(clock))
	if existing, readErr := readRegularFile(path); readErr == nil {
		value, decodeErr := jsonx.Decode[Receipt](existing)
		if decodeErr != nil || value.ReceiptID != receiptID || value.ResultSHA256 != resultSHA || value.AgentID != delivery.AgentID || value.AgentType != delivery.AgentType || value.SessionID != delivery.SessionID || value.IntentID != snapshot.State.IntentID || value.StageID != snapshot.State.CurrentStage {
			return contract.ArtifactReference{}, fmt.Errorf("immutable delegation Receipt differs")
		}
		canonicalResult, canonicalErr := jsonx.MarshalCanonical(value.Result)
		if canonicalErr != nil || digest.Bytes(canonicalResult) != resultSHA {
			return contract.ArtifactReference{}, fmt.Errorf("immutable delegation Receipt result binding differs")
		}
		reference, err = receiptReference(projectRoot, path, existing)
		if err != nil {
			return contract.ArtifactReference{}, err
		}
		observedAt = value.ObservedAt
	} else if !os.IsNotExist(readErr) {
		return contract.ArtifactReference{}, readErr
	} else {
		value := Receipt{SchemaVersion: SchemaVersion, Artifact: "delegation-result-receipt", Version: 1, ReceiptID: receiptID, IntentID: snapshot.State.IntentID, AgentID: delivery.AgentID, AgentType: delivery.AgentType, SessionID: delivery.SessionID, StageID: snapshot.State.CurrentStage, ResultSHA256: resultSHA, Result: result, ObservedAt: observedAt}
		content, err := jsonx.MarshalCanonical(value)
		if err != nil {
			return contract.ArtifactReference{}, err
		}
		if err := ensureParent(projectRoot, path); err != nil {
			return contract.ArtifactReference{}, err
		}
		if err := fsx.AtomicWriteFile(path, content, 0o644); err != nil {
			return contract.ArtifactReference{}, err
		}
		reference, err = receiptReference(projectRoot, path, content)
		if err != nil {
			return contract.ArtifactReference{}, err
		}
	}
	current := CurrentReceipt{SchemaVersion: SchemaVersion, AgentID: delivery.AgentID, IntentID: snapshot.State.IntentID, StageID: snapshot.State.CurrentStage, ReceiptReference: reference, UpdatedAt: observedAt}
	currentContent, err := jsonx.MarshalCanonical(current)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	currentPath := filepath.Join(recordDir, "artifacts", "delegation", "current", delivery.AgentID+".json")
	if err := ensureParent(projectRoot, currentPath); err != nil {
		return contract.ArtifactReference{}, err
	}
	if err := fsx.AtomicWriteFile(currentPath, currentContent, 0o644); err != nil {
		return contract.ArtifactReference{}, err
	}
	return reference, nil
}

func recordFailure(projectRoot, recordDir string, snapshot state.Snapshot, delivery codexInput, code string, clock func() time.Time) (int, error) {
	path := continuationPath(recordDir, delivery.AgentID)
	signature := identifier("failure", delivery.AgentType, string(snapshot.State.CurrentStage), code)
	attempts := 1
	if content, err := readRegularFile(path); err == nil {
		prior, decodeErr := jsonx.Decode[continuationState](content)
		if decodeErr != nil {
			return 0, decodeErr
		}
		if prior.Signature == signature && prior.Status != string(Accepted) {
			attempts = prior.Attempts + 1
		}
	} else if !os.IsNotExist(err) {
		return 0, err
	}
	value := continuationState{SchemaVersion: SchemaVersion, AgentID: delivery.AgentID, AgentType: delivery.AgentType, StageID: string(snapshot.State.CurrentStage), FailureCode: code, Signature: signature, Attempts: attempts, Status: string(Continue), ObservedAt: iso(now(clock))}
	return attempts, writeContinuation(projectRoot, recordDir, value)
}

func markReleased(projectRoot, recordDir string, snapshot state.Snapshot, delivery codexInput, code string, attempts int, clock func() time.Time) error {
	value := continuationState{SchemaVersion: SchemaVersion, AgentID: delivery.AgentID, AgentType: delivery.AgentType, StageID: string(snapshot.State.CurrentStage), FailureCode: code, Signature: identifier("failure", delivery.AgentType, string(snapshot.State.CurrentStage), code), Attempts: attempts, Status: string(Released), ObservedAt: iso(now(clock))}
	return writeContinuation(projectRoot, recordDir, value)
}

func writeContinuation(projectRoot, recordDir string, value continuationState) error {
	path := continuationPath(recordDir, value.AgentID)
	content, err := jsonx.MarshalCanonical(value)
	if err != nil {
		return err
	}
	if err := ensureParent(projectRoot, path); err != nil {
		return err
	}
	return fsx.AtomicWriteFile(path, content, 0o644)
}

func continuationPath(recordDir, agentID string) string {
	return filepath.Join(recordDir, "artifacts", "delegation", "continuations", agentID+".json")
}

func receiptReference(projectRoot, path string, content []byte) (contract.ArtifactReference, error) {
	relative, err := filepath.Rel(projectRoot, path)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	value := contract.ArtifactReference{Artifact: "delegation-result-receipt", Version: 1, SourceOfTruth: filepath.ToSlash(relative), SHA256: digest.Bytes(content)}
	return value, value.Validate()
}

func ensureParent(projectRoot, path string) error {
	relative, err := filepath.Rel(projectRoot, filepath.Dir(path))
	if err != nil {
		return err
	}
	_, err = fsx.EnsureDirUnder(projectRoot, filepath.ToSlash(relative), 0o755)
	return err
}

func resolveProjectPath(projectRoot, value string, allowMissing bool) (string, error) {
	if err := fsx.ValidateRelative(filepath.ToSlash(value)); err != nil {
		return "", err
	}
	return fsx.ResolveUnder(projectRoot, filepath.ToSlash(value), allowMissing)
}

func digestRegularFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("not a regular file")
	}
	return digest.File(path)
}

func readRegularFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("not a regular non-symlink file: %s", path)
	}
	return os.ReadFile(path)
}

func validateLines(values []string, kind string, maximum int) error {
	if len(values) > maximum {
		return validationFailure{code: kind + "-list-too-large"}
	}
	seen := map[string]bool{}
	for _, value := range values {
		if value == "" || len(value) > 512 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") || seen[value] {
			return validationFailure{code: kind + "-invalid"}
		}
		seen[value] = true
	}
	return nil
}

func decodeCodex(input io.Reader) (codexInput, error) {
	limited := &io.LimitedReader{R: input, N: maxInputBytes + 1}
	content, err := io.ReadAll(limited)
	if err != nil {
		return codexInput{}, err
	}
	if len(content) == 0 || len(content) > maxInputBytes {
		return codexInput{}, fmt.Errorf("Codex SubagentStop input must contain one bounded JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	var value codexInput
	if err := decoder.Decode(&value); err != nil {
		return codexInput{}, fmt.Errorf("decode Codex SubagentStop input: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return codexInput{}, fmt.Errorf("Codex SubagentStop input must contain exactly one JSON object")
	}
	return value, nil
}

func validateDelivery(projectRoot string, value codexInput) error {
	for name, text := range map[string]string{"session_id": value.SessionID, "turn_id": value.TurnID, "agent_id": value.AgentID, "agent_type": value.AgentType} {
		if text == "" || !identifierPattern.MatchString(text) || metadata(text, name, 256) != nil {
			return fmt.Errorf("Codex SubagentStop %s is invalid", name)
		}
	}
	if value.HookEventName != "SubagentStop" {
		return fmt.Errorf("unsupported Codex SubagentStop event: %s", value.HookEventName)
	}
	if value.CWD == "" {
		return fmt.Errorf("Codex SubagentStop cwd is required")
	}
	cwd, err := realDirectory(value.CWD)
	if err != nil || !pathWithin(cwd, projectRoot) {
		return fmt.Errorf("Codex SubagentStop cwd is outside the Project")
	}
	if len(value.AgentTranscriptPath) > 4096 || strings.ContainsAny(value.AgentTranscriptPath, "\r\n\x00") {
		return fmt.Errorf("Codex SubagentStop transcript path is invalid")
	}
	return nil
}

func metadata(value, name string, maximum int) error {
	if len(value) > maximum {
		return fmt.Errorf("%s too long", name)
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return fmt.Errorf("%s contains control", name)
		}
	}
	return nil
}

func realDirectory(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	absolute, err = filepath.EvalSymlinks(filepath.Clean(absolute))
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("directory must be real")
	}
	return absolute, nil
}

func pathWithin(candidate, root string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func identifier(prefix string, values ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(values, "\x00")))
	return prefix + "-" + hex.EncodeToString(sum[:])[:24]
}

func now(clock func() time.Time) time.Time {
	if clock != nil {
		return clock()
	}
	return time.Now()
}

func iso(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

// Inspect returns the latest validated Receipt for an Agent in the active
// Intent. The referenced immutable bytes are verified before return.
func Inspect(projectDir, agentID string) (CurrentReceipt, Receipt, error) {
	projectRoot, err := realDirectory(projectDir)
	if err != nil {
		return CurrentReceipt{}, Receipt{}, err
	}
	if !identifierPattern.MatchString(agentID) {
		return CurrentReceipt{}, Receipt{}, fmt.Errorf("invalid Agent ID")
	}
	inspection, err := state.InspectActive(projectRoot)
	if err != nil || inspection.Kind != state.InspectionVNext {
		return CurrentReceipt{}, Receipt{}, fmt.Errorf("no active vNext Intent")
	}
	path := filepath.Join(inspection.RecordDir, "artifacts", "delegation", "current", agentID+".json")
	currentContent, err := readRegularFile(path)
	if err != nil {
		return CurrentReceipt{}, Receipt{}, err
	}
	current, err := jsonx.Decode[CurrentReceipt](currentContent)
	if err != nil {
		return CurrentReceipt{}, Receipt{}, err
	}
	if current.SchemaVersion != SchemaVersion || current.AgentID != agentID || current.ReceiptReference.Artifact != "delegation-result-receipt" || current.ReceiptReference.Version != 1 || current.ReceiptReference.Validate() != nil {
		return CurrentReceipt{}, Receipt{}, fmt.Errorf("delegation Receipt pointer identity mismatch")
	}
	absolute, err := resolveProjectPath(projectRoot, current.ReceiptReference.SourceOfTruth, false)
	if err != nil {
		return CurrentReceipt{}, Receipt{}, err
	}
	content, err := readRegularFile(absolute)
	if err != nil || digest.Bytes(content) != current.ReceiptReference.SHA256 {
		return CurrentReceipt{}, Receipt{}, fmt.Errorf("delegation Receipt digest mismatch")
	}
	receipt, err := jsonx.Decode[Receipt](content)
	if err != nil || receipt.SchemaVersion != SchemaVersion || receipt.Artifact != "delegation-result-receipt" || receipt.Version != 1 || receipt.AgentID != agentID || receipt.IntentID != current.IntentID || receipt.StageID != current.StageID {
		return CurrentReceipt{}, Receipt{}, fmt.Errorf("delegation Receipt binding mismatch")
	}
	canonicalResult, err := jsonx.MarshalCanonical(receipt.Result)
	if err != nil || digest.Bytes(canonicalResult) != receipt.ResultSHA256 {
		return CurrentReceipt{}, Receipt{}, fmt.Errorf("delegation Receipt result digest mismatch")
	}
	return current, receipt, nil
}

// InspectAll verifies every current delegation Receipt in the active Intent.
func InspectAll(projectDir string) (ReceiptInventory, error) {
	projectRoot, err := realDirectory(projectDir)
	if err != nil {
		return ReceiptInventory{}, err
	}
	inspection, err := state.InspectActive(projectRoot)
	if err != nil || inspection.Kind != state.InspectionVNext {
		return ReceiptInventory{}, fmt.Errorf("no active vNext Intent")
	}
	directory := filepath.Join(inspection.RecordDir, "artifacts", "delegation", "current")
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return ReceiptInventory{AgentIDs: []string{}}, nil
	}
	if err != nil {
		return ReceiptInventory{}, err
	}
	inventory := ReceiptInventory{Present: true, AgentIDs: []string{}}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			return ReceiptInventory{}, fmt.Errorf("delegation current Receipt directory contains an invalid entry")
		}
		agentID := strings.TrimSuffix(entry.Name(), ".json")
		if !identifierPattern.MatchString(agentID) {
			return ReceiptInventory{}, fmt.Errorf("delegation current Receipt has an invalid Agent ID")
		}
		if _, _, err := Inspect(projectRoot, agentID); err != nil {
			return ReceiptInventory{}, err
		}
		inventory.AgentIDs = append(inventory.AgentIDs, agentID)
	}
	sort.Strings(inventory.AgentIDs)
	inventory.ValidReceipts = len(inventory.AgentIDs)
	return inventory, nil
}

// SortOutputs provides canonical ordering guidance to callers and tests.
func SortOutputs(outputs []Output) {
	sort.Slice(outputs, func(i, j int) bool { return outputs[i].Path < outputs[j].Path })
}
