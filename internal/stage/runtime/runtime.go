// Package runtime provides shared, Core-owned Stage persistence primitives.
// It deliberately owns no Stage-specific schema or route choice.
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/workflow/catalog"
	"github.com/sori883/aidlc/internal/workflow/policy"
	"github.com/sori883/aidlc/internal/workflow/state"
)

// Context binds a validated active State, Plan, Stage Contract, and Graph.
type Context struct {
	ProjectDir string
	CoreDir    string
	Snapshot   state.Snapshot
	Contract   contract.StageContract
	Graph      catalog.StageGraph
	Decision   contract.CoreStageDecision
}

// Load validates the active Core inputs for exactly one Stage.
func Load(projectDir, coreDir string, stageID contract.StageID) (Context, error) {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return Context{}, err
	}
	snapshot, err := state.Resume(projectRoot)
	if err != nil {
		return Context{}, err
	}
	if err := state.Validate(projectRoot, snapshot.RecordDir); err != nil {
		return Context{}, err
	}
	if snapshot.State.CurrentStage != stageID {
		return Context{}, fmt.Errorf("%s: current Stage must be %s, found %s", stageID, stageID, snapshot.State.CurrentStage)
	}
	definitions, err := catalog.Load(coreDir)
	if err != nil {
		return Context{}, err
	}
	if snapshot.State.CatalogVersion != definitions.Catalog.CatalogVersion || snapshot.State.GraphVersion != definitions.Graph.GraphVersion || snapshot.Plan.GraphVersion != definitions.Graph.GraphVersion {
		return Context{}, fmt.Errorf("%s: persisted definitions do not match the Runtime Catalog and Graph", stageID)
	}
	contracts, err := os.ReadDir(filepath.Join(coreDir, "aidlc-common", "stages"))
	if err != nil {
		return Context{}, err
	}
	var stageContract contract.StageContract
	foundContract := false
	for _, entry := range contracts {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		content, readErr := os.ReadFile(filepath.Join(coreDir, "aidlc-common", "stages", entry.Name()))
		if readErr != nil {
			return Context{}, readErr
		}
		candidate, decodeErr := contract.DecodeStageContract(content)
		if decodeErr != nil {
			return Context{}, fmt.Errorf("Stage Contract %s: %w", entry.Name(), decodeErr)
		}
		if candidate.StageID == stageID {
			stageContract, foundContract = candidate, true
		}
	}
	if !foundContract {
		return Context{}, fmt.Errorf("%s: Stage Contract is missing", stageID)
	}
	var decision contract.CoreStageDecision
	foundDecision := false
	for _, candidate := range snapshot.Plan.StageDecisions {
		if candidate.StageID == stageID {
			decision, foundDecision = candidate, true
			break
		}
	}
	if !foundDecision {
		return Context{}, fmt.Errorf("%s: Stage Execution Plan decision is missing", stageID)
	}
	if _, err := policy.VerifyProjectArtifactReference(projectRoot, snapshot.State.PolicySnapshot); err != nil {
		return Context{}, err
	}
	return Context{ProjectDir: projectRoot, CoreDir: coreDir, Snapshot: snapshot, Contract: stageContract, Graph: definitions.Graph, Decision: decision}, nil
}

// Reference creates and validates a Project-relative reference over raw bytes.
func Reference(projectDir, filePath, artifact string, version int, content []byte) (contract.ArtifactReference, error) {
	relative, err := filepath.Rel(projectDir, filePath)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return contract.ArtifactReference{}, fmt.Errorf("Artifact source_of_truth must remain inside the Project: %s", filePath)
	}
	portable := filepath.ToSlash(relative)
	if err := fsx.ValidateRelative(portable); err != nil {
		return contract.ArtifactReference{}, err
	}
	reference := contract.ArtifactReference{Artifact: artifact, Version: version, SourceOfTruth: portable, SHA256: digest.Bytes(content)}
	return reference, reference.Validate()
}

// WriteCanonical writes a canonical JSON artifact, optionally enforcing immutability.
func WriteCanonical(projectDir, filePath, artifact string, version int, value any, immutable bool) (contract.ArtifactReference, []byte, error) {
	content, err := jsonx.MarshalCanonical(value)
	if err != nil {
		return contract.ArtifactReference{}, nil, err
	}
	if err := ensureParent(projectDir, filePath); err != nil {
		return contract.ArtifactReference{}, nil, err
	}
	if existing, readErr := os.ReadFile(filePath); readErr == nil {
		if immutable && !bytes.Equal(existing, content) {
			return contract.ArtifactReference{}, nil, fmt.Errorf("immutable Artifact already exists with different content: %s", filePath)
		}
		if immutable {
			content = existing
		} else if err := fsx.AtomicWriteFile(filePath, content, 0o644); err != nil {
			return contract.ArtifactReference{}, nil, err
		}
	} else if !os.IsNotExist(readErr) {
		return contract.ArtifactReference{}, nil, readErr
	} else if err := fsx.AtomicWriteFile(filePath, content, 0o644); err != nil {
		return contract.ArtifactReference{}, nil, err
	}
	reference, err := Reference(projectDir, filePath, artifact, version, content)
	if err != nil {
		return contract.ArtifactReference{}, nil, err
	}
	if _, err := policy.VerifyProjectArtifactReference(projectDir, reference); err != nil {
		return contract.ArtifactReference{}, nil, err
	}
	return reference, content, nil
}

// ReadCanonical strictly decodes a canonical JSON artifact and verifies its reference.
func ReadCanonical[T any](projectDir, filePath, artifact string, version int) (T, contract.ArtifactReference, []byte, error) {
	var zero T
	info, err := os.Lstat(filePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return zero, contract.ArtifactReference{}, nil, fmt.Errorf("Artifact must be a regular non-symlink file: %s", filePath)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		return zero, contract.ArtifactReference{}, nil, err
	}
	value, err := jsonx.Decode[T](content)
	if err != nil {
		return zero, contract.ArtifactReference{}, nil, fmt.Errorf("decode %s: %w", filePath, err)
	}
	canonical, err := jsonx.MarshalCanonical(value)
	if err != nil || !bytes.Equal(canonical, content) {
		return zero, contract.ArtifactReference{}, nil, fmt.Errorf("Artifact is not canonical: %s", filePath)
	}
	reference, err := Reference(projectDir, filePath, artifact, version, content)
	if err != nil {
		return zero, contract.ArtifactReference{}, nil, err
	}
	if _, err := policy.VerifyProjectArtifactReference(projectDir, reference); err != nil {
		return zero, contract.ArtifactReference{}, nil, err
	}
	return value, reference, content, nil
}

// ReadCanonicalIfExists distinguishes a genuinely absent optional artifact from
// an existing artifact that is malformed, non-canonical, or otherwise unsafe.
// Callers must never silently replace the latter during resume.
func ReadCanonicalIfExists[T any](projectDir, filePath, artifact string, version int) (T, contract.ArtifactReference, []byte, bool, error) {
	var zero T
	if _, err := os.Lstat(filePath); err != nil {
		if os.IsNotExist(err) {
			return zero, contract.ArtifactReference{}, nil, false, nil
		}
		return zero, contract.ArtifactReference{}, nil, false, err
	}
	value, reference, content, err := ReadCanonical[T](projectDir, filePath, artifact, version)
	if err != nil {
		return zero, contract.ArtifactReference{}, nil, true, err
	}
	return value, reference, content, true, nil
}

// DecodeProposal rejects unknown fields and a trailing value.
func DecodeProposal[T any](content []byte, validate func(T) error) (T, error) {
	value, err := jsonx.Decode[T](content)
	if err != nil {
		return value, err
	}
	if validate != nil {
		if err := validate(value); err != nil {
			return value, err
		}
	}
	return value, nil
}

// SetReady removes a parked reason after Core has fixed the Stage request.
func SetReady(ctx context.Context, current Context, at string) (state.IntentState, error) {
	if at == "" {
		at = Now()
	}
	updated := current.Snapshot.State
	updated.Status = state.Ready
	updated.ParkedReason = nil
	updated.NotBefore = nil
	updated.Deadline = nil
	updated.UpdatedAt = at
	if err := state.Store(ctx, current.ProjectDir, current.Snapshot.RecordDir, updated, current.Snapshot.Plan); err != nil {
		return state.IntentState{}, err
	}
	return updated, nil
}

// Park records a Core-owned reason without changing the Stage.
func Park(ctx context.Context, current Context, reason, at string) (state.IntentState, error) {
	if err := OneLine(reason, "parked reason"); err != nil {
		return state.IntentState{}, err
	}
	if at == "" {
		at = Now()
	}
	updated := current.Snapshot.State
	updated.Status = state.Parked
	updated.ParkedReason = &reason
	updated.UpdatedAt = at
	if err := state.Store(ctx, current.ProjectDir, current.Snapshot.RecordDir, updated, current.Snapshot.Plan); err != nil {
		return state.IntentState{}, err
	}
	return updated, nil
}

// Advance records completion Evidence and follows exactly one fixed forward edge.
func Advance(ctx context.Context, current Context, evidence contract.ArtifactReference, verifier, reason, at string) (state.IntentState, error) {
	next, ok := catalog.NextForward(current.Graph, current.Snapshot.State.CurrentStage)
	if !ok {
		return state.IntentState{}, fmt.Errorf("%s is terminal and has no forward edge", current.Snapshot.State.CurrentStage)
	}
	if err := catalog.ValidateRoute(current.Graph, catalog.RouteRequest{From: current.Snapshot.State.CurrentStage, To: next}); err != nil {
		return state.IntentState{}, err
	}
	if _, err := policy.VerifyProjectArtifactReference(current.ProjectDir, evidence); err != nil {
		return state.IntentState{}, err
	}
	entries, err := audit.ReadOrdered(current.Snapshot.RecordDir)
	if err != nil {
		return state.IntentState{}, err
	}
	completed := false
	routed := false
	for _, entry := range entries {
		completed = completed || (entry.Event == string(audit.StageCompleted) && entry.Fields["Stage"] == string(current.Snapshot.State.CurrentStage) && entry.Fields["Evidence SHA-256"] == evidence.SHA256)
		routed = routed || (entry.Event == string(audit.RouteDecided) && entry.Fields["From Stage"] == string(current.Snapshot.State.CurrentStage) && entry.Fields["Current Stage"] == string(next))
	}
	if !completed {
		if _, err := audit.AppendBatch(ctx, current.ProjectDir, current.Snapshot.RecordDir, []audit.BatchEntry{
			{Event: audit.StageStarted, Fields: []audit.Field{{Name: "Stage", Value: string(current.Snapshot.State.CurrentStage)}, {Name: "Executor", Value: "ai+core"}, {Name: "Verifier", Value: verifier}}},
			{Event: audit.StageCompleted, Fields: []audit.Field{{Name: "Stage", Value: string(current.Snapshot.State.CurrentStage)}, {Name: "Artifact", Value: evidence.SourceOfTruth}, {Name: "Evidence SHA-256", Value: evidence.SHA256}, {Name: "Decision Authority", Value: "core"}}},
		}, nil); err != nil {
			return state.IntentState{}, err
		}
	}
	if !routed {
		if _, err := audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.RouteDecided, []audit.Field{
			{Name: "From Stage", Value: string(current.Snapshot.State.CurrentStage)}, {Name: "Current Stage", Value: string(next)}, {Name: "Graph", Value: current.Graph.GraphVersion}, {Name: "Decision Authority", Value: "core"},
		}, nil); err != nil {
			return state.IntentState{}, err
		}
	}
	if at == "" {
		at = Now()
	}
	updated := current.Snapshot.State
	updated.CurrentStage = next
	updated.Status = state.Parked
	updated.ParkedReason = &reason
	updated.NotBefore = nil
	updated.Deadline = nil
	updated.UpdatedAt = at
	if err := state.Store(ctx, current.ProjectDir, current.Snapshot.RecordDir, updated, current.Snapshot.Plan); err != nil {
		return state.IntentState{}, err
	}
	return updated, nil
}

// RouteFeedback records one of the fixed ST-07 feedback edges. The caller must
// persist the classified human decision before invoking this transition.
func RouteFeedback(ctx context.Context, current Context, target contract.StageID, feedbackReason, parkedReason, at string) (state.IntentState, error) {
	if current.Snapshot.State.CurrentStage != contract.Stage07 {
		return state.IntentState{}, fmt.Errorf("only ST-07 may route feedback")
	}
	if err := catalog.ValidateRoute(current.Graph, catalog.RouteRequest{From: contract.Stage07, To: target, FeedbackReason: feedbackReason}); err != nil {
		return state.IntentState{}, err
	}
	if at == "" {
		at = Now()
	}
	if _, err := audit.Append(ctx, current.ProjectDir, current.Snapshot.RecordDir, audit.RouteDecided, []audit.Field{
		{Name: "From Stage", Value: "ST-07"},
		{Name: "Current Stage", Value: string(target)},
		{Name: "Reason", Value: feedbackReason},
		{Name: "Graph", Value: current.Graph.GraphVersion},
		{Name: "Decision Authority", Value: "core"},
	}, nil); err != nil {
		return state.IntentState{}, err
	}
	updated := current.Snapshot.State
	updated.CurrentStage = target
	updated.Status = state.Parked
	updated.ParkedReason = &parkedReason
	updated.NotBefore = nil
	updated.Deadline = nil
	updated.UpdatedAt = at
	if err := state.Store(ctx, current.ProjectDir, current.Snapshot.RecordDir, updated, current.Snapshot.Plan); err != nil {
		return state.IntentState{}, err
	}
	return updated, nil
}

// Complete records terminal ST-09 Evidence and closes the Workflow.
func Complete(ctx context.Context, current Context, evidence contract.ArtifactReference, verifier, at string) (state.IntentState, error) {
	if current.Snapshot.State.CurrentStage != contract.Stage09 {
		return state.IntentState{}, fmt.Errorf("only ST-09 may complete the Workflow")
	}
	if _, err := policy.VerifyProjectArtifactReference(current.ProjectDir, evidence); err != nil {
		return state.IntentState{}, err
	}
	entries, err := audit.ReadOrdered(current.Snapshot.RecordDir)
	if err != nil {
		return state.IntentState{}, err
	}
	completed := false
	for _, entry := range entries {
		if entry.Event == string(audit.WorkflowCompleted) && entry.Fields["Outcome SHA-256"] == evidence.SHA256 {
			completed = true
			break
		}
	}
	if !completed {
		if _, err := audit.AppendBatch(ctx, current.ProjectDir, current.Snapshot.RecordDir, []audit.BatchEntry{
			{Event: audit.StageCompleted, Fields: []audit.Field{{Name: "Stage", Value: "ST-09"}, {Name: "Artifact", Value: evidence.SourceOfTruth}, {Name: "Evidence SHA-256", Value: evidence.SHA256}, {Name: "Verifier", Value: verifier}, {Name: "Decision Authority", Value: "core"}}},
			{Event: audit.WorkflowCompleted, Fields: []audit.Field{{Name: "Workflow", Value: "vNext"}, {Name: "Outcome SHA-256", Value: evidence.SHA256}, {Name: "Decision Authority", Value: "core"}}},
		}, nil); err != nil {
			return state.IntentState{}, err
		}
	}
	if at == "" {
		at = Now()
	}
	updated := current.Snapshot.State
	updated.Status = state.Completed
	updated.ParkedReason = nil
	updated.NotBefore = nil
	updated.Deadline = nil
	updated.UpdatedAt = at
	if err := state.Store(ctx, current.ProjectDir, current.Snapshot.RecordDir, updated, current.Snapshot.Plan); err != nil {
		return state.IntentState{}, err
	}
	return updated, nil
}

// ReadReference validates an already-persisted Artifact reference.
func ReadReference(projectDir string, reference contract.ArtifactReference) (string, error) {
	return policy.VerifyProjectArtifactReference(projectDir, reference)
}

// DecodeObject decodes an arbitrary JSON object without accepting trailing data.
func DecodeObject(content []byte) (map[string]json.RawMessage, error) {
	value, err := jsonx.Decode[map[string]json.RawMessage](content)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return nil, fmt.Errorf("JSON value must be an object")
	}
	return value, nil
}

// RequireKeys enforces an exact object key set.
func RequireKeys(value map[string]json.RawMessage, required []string, optional []string, context string) error {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = struct{}{}
		if _, exists := value[key]; !exists {
			return fmt.Errorf("%s.%s is required", context, key)
		}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	for key := range value {
		if _, exists := allowed[key]; !exists {
			return fmt.Errorf("%s: unknown field: %s", context, key)
		}
	}
	return nil
}

// OneLine validates a non-empty, trimmed scalar string.
func OneLine(value, field string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s must be a non-empty single-line string", field)
	}
	return nil
}

// Timestamp validates an ISO-8601 UTC timestamp.
func Timestamp(value, field string) error {
	if err := OneLine(value, field); err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339Nano, value); err != nil || !strings.HasSuffix(value, "Z") {
		return fmt.Errorf("%s must be an ISO-8601 UTC timestamp", field)
	}
	return nil
}

// Now returns the canonical JavaScript-compatible UTC millisecond timestamp.
func Now() string {
	return time.Now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func ensureParent(projectDir, target string) error {
	relative, err := filepath.Rel(projectDir, filepath.Dir(target))
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("Artifact directory must remain inside the Project: %s", target)
	}
	_, err = fsx.EnsureDirUnder(projectDir, filepath.ToSlash(relative), 0o755)
	return err
}
