// Package st01orient implements ST-01 repository observation and System Map promotion.
package st01orient

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/process"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st00bootstrap"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

// SourceSnapshot pins one selected repository or external observation source.
type SourceSnapshot struct {
	SourceID   string  `json:"source_id"`
	SourceType string  `json:"source_type"`
	Locator    string  `json:"locator"`
	Revision   string  `json:"revision"`
	Dirty      bool    `json:"dirty"`
	ObservedAt string  `json:"observed_at"`
	ExpiresAt  *string `json:"expires_at,omitempty"`
}

type Evidence struct {
	EvidenceID   string `json:"evidence_id"`
	SourceID     string `json:"source_id"`
	EvidenceType string `json:"evidence_type"`
	Locator      string `json:"locator"`
	SHA256       string `json:"sha256"`
	ObservedAt   string `json:"observed_at"`
}

type Coverage struct {
	CoverageID   string   `json:"coverage_id"`
	Scope        string   `json:"scope"`
	Status       string   `json:"status"`
	EvidenceRefs []string `json:"evidence_refs"`
	ObservedAt   string   `json:"observed_at"`
}

type Provider struct {
	Name         string         `json:"name"`
	Service      string         `json:"service"`
	ResourceType *string        `json:"resource_type,omitempty"`
	Extensions   map[string]any `json:"extensions,omitempty"`
}

type Entity struct {
	EntityID     string    `json:"entity_id"`
	Name         string    `json:"name"`
	EntityType   string    `json:"entity_type"`
	Capability   string    `json:"capability"`
	CurrentState string    `json:"current_state"`
	Provider     *Provider `json:"provider,omitempty"`
	EvidenceRefs []string  `json:"evidence_refs"`
}

type Relation struct {
	RelationID   string   `json:"relation_id"`
	FromEntityID string   `json:"from_entity_id"`
	ToEntityID   string   `json:"to_entity_id"`
	RelationType string   `json:"relation_type"`
	CurrentState string   `json:"current_state"`
	EvidenceRefs []string `json:"evidence_refs"`
}

type WorkspaceProfile struct {
	SchemaVersion       int              `json:"schema_version"`
	Artifact            string           `json:"artifact"`
	Version             int              `json:"version"`
	IntentID            string           `json:"intent_id"`
	Space               string           `json:"space"`
	RepositorySnapshots []SourceSnapshot `json:"repository_snapshots"`
	ObservedAt          string           `json:"observed_at"`
}

type WorkRequest struct {
	SchemaVersion        int                         `json:"schema_version"`
	Artifact             string                      `json:"artifact"`
	Version              int                         `json:"version"`
	IntentID             string                      `json:"intent_id"`
	StageID              contract.StageID            `json:"stage_id"`
	DesignBriefRef       contract.ArtifactReference  `json:"design_brief_ref"`
	BootstrapReceiptRef  contract.ArtifactReference  `json:"bootstrap_receipt_ref"`
	WorkspaceProfileRef  contract.ArtifactReference  `json:"workspace_profile_ref"`
	SystemMapBaselineRef *contract.ArtifactReference `json:"system_map_baseline_ref,omitempty"`
	RequestedOutputs     []string                    `json:"requested_outputs"`
	Rules                []string                    `json:"rules"`
	CreatedAt            string                      `json:"created_at"`
}

type Patch struct {
	SchemaVersion     int              `json:"schema_version"`
	Artifact          string           `json:"artifact"`
	Version           int              `json:"version"`
	ProposalID        string           `json:"proposal_id"`
	MapID             string           `json:"map_id"`
	BaseRevision      *int             `json:"base_revision"`
	Perspective       string           `json:"perspective"`
	SourceSnapshots   []SourceSnapshot `json:"source_snapshots"`
	Evidence          []Evidence       `json:"evidence"`
	CoverageUpserts   []Coverage       `json:"coverage_upserts"`
	EntityUpserts     []Entity         `json:"entity_upserts"`
	RelationUpserts   []Relation       `json:"relation_upserts"`
	RemoveEntityIDs   []string         `json:"remove_entity_ids"`
	RemoveRelationIDs []string         `json:"remove_relation_ids"`
	Reason            string           `json:"reason"`
	ProposedAt        string           `json:"proposed_at"`
	ProposedBy        string           `json:"proposed_by"`
}

type ContextProposal struct {
	EntityIDs          []string `json:"entity_ids"`
	RelationIDs        []string `json:"relation_ids"`
	AdditionalFindings []string `json:"additional_findings"`
	OutOfScope         []string `json:"out_of_scope"`
	IntentOnlyNotes    []string `json:"intent_only_notes"`
	Unknowns           []string `json:"unknowns"`
}

type Proposal struct {
	SchemaVersion     int             `json:"schema_version"`
	Artifact          string          `json:"artifact"`
	Version           int             `json:"version"`
	IntentID          string          `json:"intent_id"`
	WorkRequestSHA256 string          `json:"work_request_sha256"`
	SystemMapPatch    Patch           `json:"system_map_patch"`
	CurrentContext    ContextProposal `json:"current_context"`
	ProposedBy        string          `json:"proposed_by"`
}

type SystemMap struct {
	SchemaVersion   int              `json:"schema_version"`
	Artifact        string           `json:"artifact"`
	Version         int              `json:"version"`
	MapID           string           `json:"map_id"`
	Revision        int              `json:"revision"`
	BaseRevision    *int             `json:"base_revision"`
	BaselineKind    string           `json:"baseline_kind"`
	Perspective     string           `json:"perspective"`
	SourceSnapshots []SourceSnapshot `json:"source_snapshots"`
	Evidence        []Evidence       `json:"evidence"`
	Coverage        []Coverage       `json:"coverage"`
	Entities        []Entity         `json:"entities"`
	Relations       []Relation       `json:"relations"`
	CreatedAt       string           `json:"created_at"`
}

type Baseline struct {
	SchemaVersion int    `json:"schema_version"`
	Artifact      string `json:"artifact"`
	Version       int    `json:"version"`
	MapID         string `json:"map_id"`
	Revision      int    `json:"revision"`
	SourceOfTruth string `json:"source_of_truth"`
	SHA256        string `json:"sha256"`
}

type CurrentContext struct {
	SchemaVersion       int                        `json:"schema_version"`
	Artifact            string                     `json:"artifact"`
	Version             int                        `json:"version"`
	IntentID            string                     `json:"intent_id"`
	DesignBriefRef      contract.ArtifactReference `json:"design_brief_ref"`
	WorkspaceProfileRef contract.ArtifactReference `json:"workspace_profile_ref"`
	SystemMapRef        contract.ArtifactReference `json:"system_map_ref"`
	SystemMapRevision   int                        `json:"system_map_revision"`
	EntityIDs           []string                   `json:"entity_ids"`
	RelationIDs         []string                   `json:"relation_ids"`
	AdditionalFindings  []string                   `json:"additional_findings"`
	OutOfScope          []string                   `json:"out_of_scope"`
	IntentOnlyNotes     []string                   `json:"intent_only_notes"`
	Unknowns            []string                   `json:"unknowns"`
	CreatedAt           string                     `json:"created_at"`
}

type PrepareResult struct {
	Execution        string                     `json:"execution"`
	Profile          WorkspaceProfile           `json:"profile"`
	ProfileReference contract.ArtifactReference `json:"profileReference"`
	Request          WorkRequest                `json:"request"`
	Reference        contract.ArtifactReference `json:"reference"`
}

type CompleteResult struct {
	SystemMap               SystemMap                  `json:"systemMap"`
	SystemMapReference      contract.ArtifactReference `json:"systemMapReference"`
	Baseline                Baseline                   `json:"baseline"`
	CurrentContext          CurrentContext             `json:"currentContext"`
	CurrentContextReference contract.ArtifactReference `json:"currentContextReference"`
	State                   state.IntentState          `json:"state"`
}

func WorkspaceProfilePath(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "workspace-profile.json")
}
func WorkRequestPath(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "orient-work-request.json")
}
func CurrentContextPath(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "current-context.json")
}
func SystemMapRoot(projectDir, space string) string {
	return filepath.Join(workspace.Root(projectDir), "spaces", space, "codekb", "system-map")
}
func BaselinePath(projectDir, space string) string {
	return filepath.Join(SystemMapRoot(projectDir, space), "baseline.json")
}
func RevisionPath(projectDir, space string, revision int) string {
	return filepath.Join(SystemMapRoot(projectDir, space), "revisions", fmt.Sprintf("%06d", revision), "system-map.json")
}

// Prepare creates an idempotent repository profile and Orient Work Request.
func Prepare(ctx context.Context, projectDir, coreDir, observedAt string) (PrepareResult, error) {
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage01)
	if err != nil {
		return PrepareResult{}, err
	}
	if current.Decision.Disposition == contract.NotApplicable {
		return PrepareResult{}, fmt.Errorf("ST-01 Orient requires an executable or reusable decision")
	}
	receipt, receiptRef, err := st00bootstrap.VerifyAt(current.ProjectDir, current.Snapshot.RecordDir)
	if err != nil {
		return PrepareResult{}, err
	}
	briefPath := filepath.Join(current.Snapshot.RecordDir, "artifacts", "design-brief.json")
	briefContent, err := os.ReadFile(briefPath)
	if err != nil {
		return PrepareResult{}, fmt.Errorf("ST-01 Orient: Design Brief does not exist: %s", briefPath)
	}
	briefRef, err := stageruntime.Reference(current.ProjectDir, briefPath, "design-brief", 1, briefContent)
	if err != nil {
		return PrepareResult{}, err
	}
	spaceName := workspace.ActiveSpace(current.ProjectDir)
	if observedAt == "" {
		observedAt = stageruntime.Now()
	}
	profile, err := currentProfile(ctx, current.ProjectDir, current.Snapshot.State.IntentID, spaceName, receipt.RepositoryRoots, observedAt)
	if err != nil {
		return PrepareResult{}, err
	}
	baseline, baselineRef, err := readBaseline(current.ProjectDir, spaceName)
	if err != nil {
		return PrepareResult{}, err
	}
	profilePath := WorkspaceProfilePath(current.Snapshot.RecordDir)
	requestPath := WorkRequestPath(current.Snapshot.RecordDir)
	storedProfile, profileRef, _, profileExists, err := stageruntime.ReadCanonicalIfExists[WorkspaceProfile](current.ProjectDir, profilePath, "workspace-profile", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	storedRequest, requestRef, _, requestExists, err := stageruntime.ReadCanonicalIfExists[WorkRequest](current.ProjectDir, requestPath, "orient-work-request", 1)
	if err != nil {
		return PrepareResult{}, err
	}
	if profileExists && requestExists && snapshotsEqual(storedProfile.RepositorySnapshots, profile.RepositorySnapshots) {
		if storedRequest.IntentID == current.Snapshot.State.IntentID && storedRequest.WorkspaceProfileRef == profileRef && equalOptionalRef(storedRequest.SystemMapBaselineRef, baselineRef) {
			if current.Snapshot.State.Status != state.Ready {
				if _, err := stageruntime.SetReady(ctx, current, storedProfile.ObservedAt); err != nil {
					return PrepareResult{}, err
				}
			}
			return PrepareResult{Execution: "reused", Profile: storedProfile, ProfileReference: profileRef, Request: storedRequest, Reference: requestRef}, nil
		}
	}
	profileRef, _, err = stageruntime.WriteCanonical(current.ProjectDir, profilePath, "workspace-profile", 1, profile, false)
	if err != nil {
		return PrepareResult{}, err
	}
	request := WorkRequest{
		SchemaVersion: 1, Artifact: "orient-work-request", Version: 1, IntentID: current.Snapshot.State.IntentID, StageID: contract.Stage01,
		DesignBriefRef: briefRef, BootstrapReceiptRef: receiptRef, WorkspaceProfileRef: profileRef, SystemMapBaselineRef: baselineRef,
		RequestedOutputs: []string{"system-map-patch", "current-context-proposal"},
		Rules: []string{
			"Observe only the Design Brief scope and explicitly record unknown or out-of-scope areas.",
			"Use only accepted-code-baseline state; never mix working, planned, or production state.",
			"Every observed fact must cite Evidence from a declared source snapshot.",
			"AI proposes content only; Core validates and owns persistence and Stage routing.",
			"System Map is JSON-only by default; do not generate HTML without a human request.",
		}, CreatedAt: observedAt,
	}
	requestRef, _, err = stageruntime.WriteCanonical(current.ProjectDir, requestPath, "orient-work-request", 1, request, false)
	if err != nil {
		return PrepareResult{}, err
	}
	if _, err := stageruntime.SetReady(ctx, current, observedAt); err != nil {
		return PrepareResult{}, err
	}
	_ = baseline
	return PrepareResult{Execution: "prepared", Profile: profile, ProfileReference: profileRef, Request: request, Reference: requestRef}, nil
}

// Complete validates observed Evidence, promotes a Map revision, and advances.
func Complete(ctx context.Context, projectDir, coreDir string, proposalContent []byte, completedAt string) (CompleteResult, error) {
	prepared, err := Prepare(ctx, projectDir, coreDir, "")
	if err != nil {
		return CompleteResult{}, err
	}
	current, err := stageruntime.Load(projectDir, coreDir, contract.Stage01)
	if err != nil {
		return CompleteResult{}, err
	}
	proposal, err := stageruntime.DecodeProposal(proposalContent, func(value Proposal) error { return value.Validate() })
	if err != nil {
		return CompleteResult{}, fmt.Errorf("ST-01 Orient Proposal: %w", err)
	}
	if proposal.IntentID != current.Snapshot.State.IntentID || proposal.WorkRequestSHA256 != prepared.Reference.SHA256 {
		return CompleteResult{}, fmt.Errorf("ST-01 Orient: Proposal does not bind the active Intent and Work Request")
	}
	spaceName := workspace.ActiveSpace(current.ProjectDir)
	existing, _, err := readBaseline(current.ProjectDir, spaceName)
	if err != nil {
		return CompleteResult{}, err
	}
	var expectedRevision *int
	if existing != nil {
		revision := existing.Revision
		expectedRevision = &revision
	}
	if !equalRevision(proposal.SystemMapPatch.BaseRevision, expectedRevision) {
		return CompleteResult{}, fmt.Errorf("ST-01 Orient: Patch base_revision %s does not match current revision %s", revisionText(proposal.SystemMapPatch.BaseRevision), revisionText(expectedRevision))
	}
	if err := validateSnapshots(prepared.Profile, proposal.SystemMapPatch.SourceSnapshots, existing); err != nil {
		return CompleteResult{}, err
	}
	allSnapshots := append([]SourceSnapshot(nil), proposal.SystemMapPatch.SourceSnapshots...)
	if existing != nil {
		allSnapshots = upsertSources(existing.SourceSnapshots, allSnapshots)
	}
	if err := validateEvidence(current.ProjectDir, allSnapshots, proposal.SystemMapPatch.Evidence); err != nil {
		return CompleteResult{}, err
	}
	if completedAt == "" {
		completedAt = stageruntime.Now()
	}
	resultMap, err := applyPatch(existing, proposal.SystemMapPatch, completedAt)
	if err != nil {
		return CompleteResult{}, err
	}
	if err := validateContext(proposal.CurrentContext, resultMap); err != nil {
		return CompleteResult{}, err
	}
	mapPath := RevisionPath(current.ProjectDir, spaceName, resultMap.Revision)
	mapRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, mapPath, "system-map", 1, resultMap, true)
	if err != nil {
		return CompleteResult{}, fmt.Errorf("ST-01 Orient: %w", err)
	}
	baseline := Baseline{SchemaVersion: 1, Artifact: "system-map-baseline", Version: 1, MapID: resultMap.MapID, Revision: resultMap.Revision, SourceOfTruth: mapRef.SourceOfTruth, SHA256: mapRef.SHA256}
	if _, _, err := stageruntime.WriteCanonical(current.ProjectDir, BaselinePath(current.ProjectDir, spaceName), "system-map-baseline", 1, baseline, false); err != nil {
		return CompleteResult{}, err
	}
	contextValue := CurrentContext{
		SchemaVersion: 1, Artifact: "current-context", Version: 1, IntentID: current.Snapshot.State.IntentID,
		DesignBriefRef: prepared.Request.DesignBriefRef, WorkspaceProfileRef: prepared.ProfileReference, SystemMapRef: mapRef, SystemMapRevision: resultMap.Revision,
		EntityIDs: proposal.CurrentContext.EntityIDs, RelationIDs: proposal.CurrentContext.RelationIDs,
		AdditionalFindings: proposal.CurrentContext.AdditionalFindings, OutOfScope: proposal.CurrentContext.OutOfScope,
		IntentOnlyNotes: proposal.CurrentContext.IntentOnlyNotes, Unknowns: proposal.CurrentContext.Unknowns, CreatedAt: completedAt,
	}
	contextRef, _, err := stageruntime.WriteCanonical(current.ProjectDir, CurrentContextPath(current.Snapshot.RecordDir), "current-context", 1, contextValue, false)
	if err != nil {
		return CompleteResult{}, err
	}
	advanced, err := stageruntime.Advance(ctx, current, contextRef, "system-map-validator", "ST-02 Define Intent is ready for Core preparation.", completedAt)
	if err != nil {
		return CompleteResult{}, err
	}
	return CompleteResult{SystemMap: resultMap, SystemMapReference: mapRef, Baseline: baseline, CurrentContext: contextValue, CurrentContextReference: contextRef, State: advanced}, nil
}

// Handler prepares an ST-01 Work Directive.
type Handler struct{ CoreDir string }

func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	prepared, err := Prepare(ctx, projectDir, handler.CoreDir, "")
	if err != nil {
		return directive.Core{}, err
	}
	stageID := contract.Stage01
	result := directive.Core{SchemaVersion: 1, Workflow: "vnext", Kind: directive.Work, Stage: &stageID, Reason: "Core prepared the fixed ST-01 Orient inputs; AI may propose Map observations and Intent context only.", Request: &prepared.Reference, GraphVersion: snapshot.State.GraphVersion, PlanRevision: snapshot.State.PlanRevision, DecisionAuthority: "core"}
	return result, result.Validate()
}

func currentProfile(ctx context.Context, projectDir, intentID, spaceName string, roots []string, observedAt string) (WorkspaceProfile, error) {
	snapshots := make([]SourceSnapshot, 0, len(roots))
	for _, root := range roots {
		snapshot, err := snapshotRepository(ctx, projectDir, root, observedAt)
		if err != nil {
			return WorkspaceProfile{}, err
		}
		snapshots = append(snapshots, snapshot)
	}
	return WorkspaceProfile{SchemaVersion: 1, Artifact: "workspace-profile", Version: 1, IntentID: intentID, Space: spaceName, RepositorySnapshots: snapshots, ObservedAt: observedAt}, nil
}

func snapshotRepository(ctx context.Context, projectDir, root, observedAt string) (SourceSnapshot, error) {
	absolute := projectDir
	if root != "." {
		var err error
		absolute, err = fsx.ResolveUnder(projectDir, root, false)
		if err != nil {
			return SourceSnapshot{}, fmt.Errorf("ST-01 Orient: Repository root is invalid: %s", root)
		}
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return SourceSnapshot{}, fmt.Errorf("ST-01 Orient: Repository root is invalid: %s", root)
	}
	locator, err := filepath.Rel(projectDir, absolute)
	if err != nil {
		return SourceSnapshot{}, err
	}
	if locator == "" {
		locator = "."
	}
	locator = filepath.ToSlash(locator)
	hash := sha256.Sum256([]byte(locator))
	sourceID := "repo-" + hex.EncodeToString(hash[:])[:12]
	if gitHead, ok := gitOutput(ctx, absolute, "rev-parse", "HEAD"); ok {
		status, _ := gitOutput(ctx, absolute, "status", "--porcelain=v1", "--untracked-files=all")
		return SourceSnapshot{SourceID: sourceID, SourceType: "git", Locator: locator, Revision: gitHead, Dirty: status != "", ObservedAt: observedAt}, nil
	}
	revision, err := directoryRevision(absolute)
	if err != nil {
		return SourceSnapshot{}, err
	}
	return SourceSnapshot{SourceID: sourceID, SourceType: "directory", Locator: locator, Revision: revision, Dirty: false, ObservedAt: observedAt}, nil
}

func gitOutput(ctx context.Context, root string, args ...string) (string, bool) {
	result, err := process.Run(ctx, process.Request{Executable: "git", Args: args, Dir: root, Env: os.Environ(), ExitCodes: []int{0}})
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(result.Stdout)), true
}

func directoryRevision(root string) (string, error) {
	var paths []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path != root {
			if _, skip := map[string]struct{}{`.git`: {}, `node_modules`: {}, `aidlc`: {}, `.DS_Store`: {}}[entry.Name()]; skip {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if entry.Type()&os.ModeSymlink == 0 && entry.Type().IsRegular() {
			relative, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return relErr
			}
			paths = append(paths, filepath.ToSlash(relative))
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(paths)
	hash := sha256.New()
	for _, path := range paths {
		content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			return "", err
		}
		_, _ = hash.Write([]byte(path))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write(content)
		_, _ = hash.Write([]byte{0})
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func readBaseline(projectDir, spaceName string) (*SystemMap, *contract.ArtifactReference, error) {
	path := BaselinePath(projectDir, spaceName)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil, nil, nil
	}
	baseline, _, _, err := stageruntime.ReadCanonical[Baseline](projectDir, path, "system-map-baseline", 1)
	if err != nil {
		return nil, nil, err
	}
	mapPath := RevisionPath(projectDir, spaceName, baseline.Revision)
	value, reference, _, err := stageruntime.ReadCanonical[SystemMap](projectDir, mapPath, "system-map", 1)
	if err != nil {
		return nil, nil, err
	}
	if value.MapID != baseline.MapID || reference.SourceOfTruth != baseline.SourceOfTruth || reference.SHA256 != baseline.SHA256 {
		return nil, nil, fmt.Errorf("ST-01 Orient: System Map baseline does not match its immutable revision")
	}
	return &value, &reference, nil
}

func (value Proposal) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "orient-proposal" || value.Version != 1 || value.ProposedBy != "ai" {
		return fmt.Errorf("Orient Proposal has an invalid schema identity or authority")
	}
	if err := stageruntime.OneLine(value.IntentID, "Orient Proposal.intent_id"); err != nil {
		return err
	}
	if err := digest.Validate(value.WorkRequestSHA256); err != nil {
		return err
	}
	if err := value.SystemMapPatch.Validate(); err != nil {
		return err
	}
	return validateUniqueStrings(value.CurrentContext)
}

func (value Patch) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "system-map-patch" || value.Version != 1 || value.Perspective != "accepted-code-baseline" || value.ProposedBy != "ai" {
		return fmt.Errorf("System Map Patch has an invalid schema identity, perspective, or authority")
	}
	for field, text := range map[string]string{"proposal_id": value.ProposalID, "map_id": value.MapID, "reason": value.Reason} {
		if err := stageruntime.OneLine(text, "System Map Patch."+field); err != nil {
			return err
		}
	}
	if value.BaseRevision != nil && *value.BaseRevision < 1 {
		return fmt.Errorf("System Map Patch.base_revision must be null or positive")
	}
	if err := stageruntime.Timestamp(value.ProposedAt, "System Map Patch.proposed_at"); err != nil {
		return err
	}
	if value.SourceSnapshots == nil || value.Evidence == nil || value.CoverageUpserts == nil || value.EntityUpserts == nil || value.RelationUpserts == nil || value.RemoveEntityIDs == nil || value.RemoveRelationIDs == nil {
		return fmt.Errorf("System Map Patch collection fields must be arrays")
	}
	if err := validateMap(value.SourceSnapshots, value.Evidence, value.CoverageUpserts, value.EntityUpserts, value.RelationUpserts); err != nil {
		return err
	}
	return nil
}

func validateMap(sources []SourceSnapshot, evidence []Evidence, coverage []Coverage, entities []Entity, relations []Relation) error {
	sourceIDs := map[string]struct{}{}
	for _, source := range sources {
		if err := validateSource(source); err != nil {
			return err
		}
		if source.Dirty {
			return fmt.Errorf("dirty working state cannot enter the accepted code baseline")
		}
		if _, exists := sourceIDs[source.SourceID]; exists {
			return fmt.Errorf("duplicate source_id: %s", source.SourceID)
		}
		sourceIDs[source.SourceID] = struct{}{}
	}
	evidenceIDs := map[string]struct{}{}
	for _, item := range evidence {
		if _, exists := sourceIDs[item.SourceID]; !exists {
			return fmt.Errorf("Evidence %s refers to unknown source_id: %s", item.EvidenceID, item.SourceID)
		}
		if err := digest.Validate(item.SHA256); err != nil {
			return err
		}
		if _, exists := evidenceIDs[item.EvidenceID]; exists {
			return fmt.Errorf("duplicate evidence_id: %s", item.EvidenceID)
		}
		evidenceIDs[item.EvidenceID] = struct{}{}
	}
	entityIDs := map[string]struct{}{}
	for _, entity := range entities {
		if _, exists := entityIDs[entity.EntityID]; exists {
			return fmt.Errorf("duplicate entity_id: %s", entity.EntityID)
		}
		entityIDs[entity.EntityID] = struct{}{}
		if !allowed(entity.CurrentState, "observed", "stale", "unknown") {
			return fmt.Errorf("Entity.current_state must be one of: observed, stale, unknown")
		}
		if err := validateEvidenceRefs(entity.EvidenceRefs, evidenceIDs); err != nil {
			return err
		}
		if entity.Provider != nil {
			for key, scalar := range entity.Provider.Extensions {
				switch scalar.(type) {
				case nil, string, bool, float64:
				default:
					return fmt.Errorf("provider extension %s must be a scalar", key)
				}
			}
		}
	}
	for _, item := range coverage {
		if !allowed(item.Status, "observed", "unobserved", "stale", "unknown") {
			return fmt.Errorf("Coverage.status is invalid")
		}
		if err := validateEvidenceRefs(item.EvidenceRefs, evidenceIDs); err != nil {
			return err
		}
	}
	for _, relation := range relations {
		if _, exists := entityIDs[relation.FromEntityID]; !exists {
			return fmt.Errorf("unknown relation endpoint: %s", relation.FromEntityID)
		}
		if _, exists := entityIDs[relation.ToEntityID]; !exists {
			return fmt.Errorf("unknown relation endpoint: %s", relation.ToEntityID)
		}
		if !allowed(relation.CurrentState, "observed", "stale", "unknown") {
			return fmt.Errorf("Relation.current_state is invalid")
		}
		if err := validateEvidenceRefs(relation.EvidenceRefs, evidenceIDs); err != nil {
			return err
		}
	}
	return nil
}

func validateSource(value SourceSnapshot) error {
	if !allowed(value.SourceType, "git", "directory", "external") {
		return fmt.Errorf("SourceSnapshot.source_type is invalid")
	}
	for _, text := range []string{value.SourceID, value.Locator, value.Revision} {
		if err := stageruntime.OneLine(text, "SourceSnapshot"); err != nil {
			return err
		}
	}
	if err := stageruntime.Timestamp(value.ObservedAt, "SourceSnapshot.observed_at"); err != nil {
		return err
	}
	if value.SourceType == "external" && (value.ExpiresAt == nil || value.Dirty) {
		return fmt.Errorf("external SourceSnapshot requires expires_at and dirty=false")
	}
	if value.SourceType != "external" && value.ExpiresAt != nil {
		return fmt.Errorf("expires_at is allowed only for external sources")
	}
	return nil
}

func validateSnapshots(profile WorkspaceProfile, snapshots []SourceSnapshot, existing *SystemMap) error {
	profileByID := map[string]SourceSnapshot{}
	for _, source := range profile.RepositorySnapshots {
		profileByID[source.SourceID] = source
	}
	oldByID := map[string]SourceSnapshot{}
	if existing != nil {
		for _, source := range existing.SourceSnapshots {
			oldByID[source.SourceID] = source
		}
	}
	for _, source := range snapshots {
		if source.SourceType == "external" {
			continue
		}
		expected, exists := profileByID[source.SourceID]
		if !exists || !snapshotStableEqual(source, expected) {
			return fmt.Errorf("ST-01 Orient: Patch source snapshot does not match Workspace Profile: %s", source.SourceID)
		}
		if previous, exists := oldByID[source.SourceID]; exists && (previous.Revision != source.Revision || previous.Locator != source.Locator) {
			return fmt.Errorf("ST-01 Orient: source %s changed from the accepted baseline; promotion requires ST-07", source.SourceID)
		}
	}
	return nil
}

func validateEvidence(projectDir string, sources []SourceSnapshot, evidence []Evidence) error {
	byID := map[string]SourceSnapshot{}
	for _, source := range sources {
		byID[source.SourceID] = source
	}
	for _, item := range evidence {
		source, exists := byID[item.SourceID]
		if !exists {
			return fmt.Errorf("ST-01 Orient: Evidence source is unknown: %s", item.SourceID)
		}
		if item.EvidenceType == "external-record" {
			if source.SourceType != "external" {
				return fmt.Errorf("ST-01 Orient: external Evidence requires an external source: %s", item.EvidenceID)
			}
			continue
		}
		if source.SourceType == "external" || item.EvidenceType != "file" || filepath.IsAbs(item.Locator) || strings.Contains(item.Locator, "\\") {
			return fmt.Errorf("ST-01 Orient: Evidence locator escapes Repository: %s", item.Locator)
		}
		root := projectDir
		if source.Locator != "." {
			var err error
			root, err = fsx.ResolveUnder(projectDir, source.Locator, false)
			if err != nil {
				return err
			}
		}
		path, err := fsx.ResolveUnder(root, item.Locator, false)
		if err != nil {
			return fmt.Errorf("ST-01 Orient: Evidence locator escapes Repository: %s", item.Locator)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("ST-01 Orient: Evidence file does not exist: %s", item.Locator)
		}
		if digest.Bytes(content) != item.SHA256 {
			return fmt.Errorf("ST-01 Orient: Evidence SHA-256 does not match: %s", item.Locator)
		}
	}
	return nil
}

func applyPatch(existing *SystemMap, patch Patch, createdAt string) (SystemMap, error) {
	var currentRevision *int
	baselineKind := "imported"
	var sources []SourceSnapshot
	var evidence []Evidence
	var coverage []Coverage
	var entities []Entity
	var relations []Relation
	if existing != nil {
		revision := existing.Revision
		currentRevision = &revision
		baselineKind = "accepted"
		sources, evidence, coverage, entities, relations = existing.SourceSnapshots, existing.Evidence, existing.Coverage, existing.Entities, existing.Relations
		if patch.MapID != existing.MapID {
			return SystemMap{}, fmt.Errorf("ST-01 Orient: Patch map_id does not match the shared System Map")
		}
	}
	sources = upsertSources(sources, patch.SourceSnapshots)
	evidence = upsertEvidence(evidence, patch.Evidence)
	coverage = upsertCoverage(coverage, patch.CoverageUpserts)
	entities = removeAndUpsertEntities(entities, patch.EntityUpserts, patch.RemoveEntityIDs)
	relations = removeAndUpsertRelations(relations, patch.RelationUpserts, patch.RemoveRelationIDs)
	if err := validateMap(sources, evidence, coverage, entities, relations); err != nil {
		return SystemMap{}, err
	}
	revision := 1
	if currentRevision != nil {
		revision = *currentRevision + 1
	}
	return SystemMap{SchemaVersion: 1, Artifact: "system-map", Version: 1, MapID: patch.MapID, Revision: revision, BaseRevision: currentRevision, BaselineKind: baselineKind, Perspective: "accepted-code-baseline", SourceSnapshots: sources, Evidence: evidence, Coverage: coverage, Entities: entities, Relations: relations, CreatedAt: createdAt}, nil
}

func validateContext(value ContextProposal, systemMap SystemMap) error {
	entities := map[string]struct{}{}
	for _, item := range systemMap.Entities {
		entities[item.EntityID] = struct{}{}
	}
	relations := map[string]struct{}{}
	for _, item := range systemMap.Relations {
		relations[item.RelationID] = struct{}{}
	}
	for _, id := range value.EntityIDs {
		if _, exists := entities[id]; !exists {
			return fmt.Errorf("ST-01 Orient: Current Context selects unknown entity_id: %s", id)
		}
	}
	for _, id := range value.RelationIDs {
		if _, exists := relations[id]; !exists {
			return fmt.Errorf("ST-01 Orient: Current Context selects unknown relation_id: %s", id)
		}
	}
	return nil
}

func validateUniqueStrings(value ContextProposal) error {
	for label, values := range map[string][]string{"entity_ids": value.EntityIDs, "relation_ids": value.RelationIDs, "additional_findings": value.AdditionalFindings, "out_of_scope": value.OutOfScope, "intent_only_notes": value.IntentOnlyNotes, "unknowns": value.Unknowns} {
		if values == nil {
			return fmt.Errorf("Current Context Proposal.%s must be an array", label)
		}
		seen := map[string]struct{}{}
		for _, item := range values {
			if err := stageruntime.OneLine(item, label); err != nil {
				return err
			}
			if _, exists := seen[item]; exists {
				return fmt.Errorf("%s contains duplicate value: %s", label, item)
			}
			seen[item] = struct{}{}
		}
	}
	return nil
}

func validateEvidenceRefs(values []string, known map[string]struct{}) error {
	for _, value := range values {
		if _, exists := known[value]; !exists {
			return fmt.Errorf("unknown evidence_ref: %s", value)
		}
	}
	return nil
}

func snapshotsEqual(left, right []SourceSnapshot) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if !snapshotStableEqual(left[index], right[index]) {
			return false
		}
	}
	return true
}

func snapshotStableEqual(left, right SourceSnapshot) bool {
	return left.SourceID == right.SourceID && left.SourceType == right.SourceType && left.Locator == right.Locator && left.Revision == right.Revision && left.Dirty == right.Dirty
}

func equalOptionalRef(left, right *contract.ArtifactReference) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func equalRevision(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func revisionText(value *int) string {
	if value == nil {
		return "null"
	}
	return fmt.Sprint(*value)
}

func allowed(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func upsertSources(existing, updates []SourceSnapshot) []SourceSnapshot {
	values := map[string]SourceSnapshot{}
	for _, value := range existing {
		values[value.SourceID] = value
	}
	for _, value := range updates {
		values[value.SourceID] = value
	}
	keys := sortedKeys(values)
	result := make([]SourceSnapshot, 0, len(keys))
	for _, key := range keys {
		result = append(result, values[key])
	}
	return result
}

func upsertEvidence(existing, updates []Evidence) []Evidence {
	values := map[string]Evidence{}
	for _, value := range existing {
		values[value.EvidenceID] = value
	}
	for _, value := range updates {
		values[value.EvidenceID] = value
	}
	keys := sortedKeys(values)
	result := make([]Evidence, 0, len(keys))
	for _, key := range keys {
		result = append(result, values[key])
	}
	return result
}

func upsertCoverage(existing, updates []Coverage) []Coverage {
	values := map[string]Coverage{}
	for _, value := range existing {
		values[value.CoverageID] = value
	}
	for _, value := range updates {
		values[value.CoverageID] = value
	}
	keys := sortedKeys(values)
	result := make([]Coverage, 0, len(keys))
	for _, key := range keys {
		result = append(result, values[key])
	}
	return result
}

func removeAndUpsertEntities(existing, updates []Entity, removals []string) []Entity {
	values := map[string]Entity{}
	for _, value := range existing {
		values[value.EntityID] = value
	}
	for _, key := range removals {
		delete(values, key)
	}
	for _, value := range updates {
		values[value.EntityID] = value
	}
	keys := sortedKeys(values)
	result := make([]Entity, 0, len(keys))
	for _, key := range keys {
		result = append(result, values[key])
	}
	return result
}

func removeAndUpsertRelations(existing, updates []Relation, removals []string) []Relation {
	values := map[string]Relation{}
	for _, value := range existing {
		values[value.RelationID] = value
	}
	for _, key := range removals {
		delete(values, key)
	}
	for _, value := range updates {
		values[value.RelationID] = value
	}
	keys := sortedKeys(values)
	result := make([]Relation, 0, len(keys))
	for _, key := range keys {
		result = append(result, values[key])
	}
	return result
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// RegistryRoots is exposed for Stage parity tests.
func RegistryRoots(projectDir, spaceName, intentID, recordDir string) []string {
	for _, entry := range intent.ReadRegistry(projectDir, spaceName) {
		if entry.UUID == intentID && entry.DirName == filepath.Base(recordDir) {
			return append([]string(nil), entry.Repos...)
		}
	}
	return nil
}
