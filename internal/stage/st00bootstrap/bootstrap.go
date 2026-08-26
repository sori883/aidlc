// Package st00bootstrap implements the deterministic ST-00 safety gate.
package st00bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/version"
	"github.com/sori883/aidlc/internal/workflow/catalog"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/policy"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

const (
	ReceiptSchemaVersion = 1
	ReceiptVersion       = 1
)

var checkIDs = [...]string{
	"active-intent",
	"stage-plan",
	"core-definitions",
	"effective-policy",
	"workspace-repositories",
}

// Check is one ordered deterministic Bootstrap verification result.
type Check struct {
	CheckID  string `json:"check_id"`
	Status   string `json:"status"`
	Evidence string `json:"evidence"`
}

// Receipt is the canonical immutable output of ST-00.
type Receipt struct {
	SchemaVersion   int                        `json:"schema_version"`
	Artifact        string                     `json:"artifact"`
	Version         int                        `json:"version"`
	IntentID        string                     `json:"intent_id"`
	Space           string                     `json:"space"`
	Harness         string                     `json:"harness"`
	AIDLCVersion    string                     `json:"aidlc_version"`
	CatalogVersion  string                     `json:"catalog_version"`
	GraphVersion    string                     `json:"graph_version"`
	PlanRevision    int                        `json:"plan_revision"`
	PolicySnapshot  contract.ArtifactReference `json:"policy_snapshot"`
	RepositoryRoots []string                   `json:"repository_roots"`
	InputSHA256     string                     `json:"input_sha256"`
	Checks          []Check                    `json:"checks"`
	Result          string                     `json:"result"`
	CreatedAt       string                     `json:"created_at"`
}

// Result describes an executed or resumed Bootstrap transition.
type Result struct {
	Execution string                     `json:"execution"`
	Receipt   Receipt                    `json:"receipt"`
	Reference contract.ArtifactReference `json:"reference"`
	State     state.IntentState          `json:"state"`
}

// Options injects the clock for deterministic tests.
type Options struct {
	CreatedAt string
}

type inputs struct {
	IntentID        string                     `json:"intent_id"`
	Space           string                     `json:"space"`
	Harness         string                     `json:"harness"`
	AIDLCVersion    string                     `json:"aidlc_version"`
	CatalogVersion  string                     `json:"catalog_version"`
	GraphVersion    string                     `json:"graph_version"`
	PlanRevision    int                        `json:"plan_revision"`
	PolicySnapshot  contract.ArtifactReference `json:"policy_snapshot"`
	RepositoryRoots []string                   `json:"repository_roots"`
}

// ReceiptPath returns the fixed immutable ST-00 output path.
func ReceiptPath(recordDir string) string {
	return filepath.Join(recordDir, "artifacts", "bootstrap-receipt-r1.json")
}

// LoadContract strictly loads the fixed ST-00 contract.
func LoadContract(coreDir string) (contract.StageContract, error) {
	path := filepath.Join(coreDir, "aidlc-common", "stages", "st-00-bootstrap.json")
	content, err := os.ReadFile(path)
	if err != nil {
		return contract.StageContract{}, fmt.Errorf("ST-00 Contract: cannot read %s: %w", path, err)
	}
	value, err := contract.DecodeStageContract(content)
	if err != nil {
		return contract.StageContract{}, fmt.Errorf("ST-00 Contract %s: %w", path, err)
	}
	if value.StageID != contract.Stage00 || value.Name != "Bootstrap" {
		return contract.StageContract{}, fmt.Errorf("ST-00 Contract: must define ST-00 Bootstrap")
	}
	return value, nil
}

// DecodeReceipt strictly decodes and validates a Bootstrap Receipt.
func DecodeReceipt(content []byte) (Receipt, error) {
	value, err := jsonx.Decode[Receipt](content)
	if err != nil {
		return Receipt{}, err
	}
	if err := value.Validate(); err != nil {
		return Receipt{}, err
	}
	return value, nil
}

// Validate enforces the fixed identity, ordering, and value constraints.
func (value Receipt) Validate() error {
	if value.SchemaVersion != ReceiptSchemaVersion || value.Artifact != "bootstrap-receipt" || value.Version != ReceiptVersion {
		return fmt.Errorf("Bootstrap Receipt has an invalid schema identity")
	}
	for field, text := range map[string]string{
		"intent_id": value.IntentID, "space": value.Space, "aidlc_version": value.AIDLCVersion,
		"catalog_version": value.CatalogVersion, "graph_version": value.GraphVersion,
	} {
		if err := oneLine(text, field); err != nil {
			return err
		}
	}
	if value.Harness != "codex" || value.Result != "ready" {
		return fmt.Errorf("Bootstrap Receipt harness/result must equal codex/ready")
	}
	if value.PlanRevision < 1 {
		return fmt.Errorf("Bootstrap Receipt.plan_revision must be a positive integer")
	}
	if err := value.PolicySnapshot.Validate(); err != nil {
		return fmt.Errorf("Bootstrap Receipt.policy_snapshot: %w", err)
	}
	if len(value.RepositoryRoots) == 0 {
		return fmt.Errorf("Bootstrap Receipt.repository_roots must not be empty")
	}
	seenRoots := map[string]struct{}{}
	for index, root := range value.RepositoryRoots {
		if root != "." {
			if err := fsx.ValidateRelative(root); err != nil {
				return fmt.Errorf("Bootstrap Receipt.repository_roots[%d]: %w", index, err)
			}
		}
		if _, exists := seenRoots[root]; exists {
			return fmt.Errorf("Bootstrap Receipt.repository_roots contains duplicate root: %s", root)
		}
		seenRoots[root] = struct{}{}
	}
	if err := digest.Validate(value.InputSHA256); err != nil {
		return fmt.Errorf("Bootstrap Receipt.input_sha256 %w", err)
	}
	if len(value.Checks) != len(checkIDs) {
		return fmt.Errorf("Bootstrap Receipt.checks must contain exactly %d checks", len(checkIDs))
	}
	for index, check := range value.Checks {
		if check.CheckID != checkIDs[index] {
			return fmt.Errorf("Bootstrap Receipt.checks[%d].check_id must equal %s; fixed check order cannot change", index, checkIDs[index])
		}
		if check.Status != "passed" {
			return fmt.Errorf("Bootstrap Receipt.checks[%d].status must equal passed", index)
		}
		if err := oneLine(check.Evidence, fmt.Sprintf("checks[%d].evidence", index)); err != nil {
			return err
		}
	}
	if _, err := parseTimestamp(value.CreatedAt); err != nil {
		return fmt.Errorf("Bootstrap Receipt.created_at: %w", err)
	}
	return nil
}

// Execute verifies ST-00, persists its Receipt, and advances through the fixed edge.
func Execute(ctx context.Context, projectDir, coreDir string, options Options) (Result, error) {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return Result{}, err
	}
	var result Result
	err = lock.With(ctx, projectRoot, lock.Options{}, func(lockContext context.Context) error {
		snapshot, loadErr := state.Resume(projectRoot)
		if loadErr != nil {
			return loadErr
		}
		result, loadErr = executeLocked(lockContext, projectRoot, coreDir, snapshot, options)
		return loadErr
	})
	if err != nil {
		if snapshot, resumeErr := state.Resume(projectRoot); resumeErr == nil {
			_, _ = audit.Append(ctx, projectRoot, snapshot.RecordDir, audit.RouteBlocked, []audit.Field{
				{Name: "Stage", Value: "ST-00"}, {Name: "Reason", Value: cleanError(err)}, {Name: "Decision Authority", Value: "core"},
			}, nil)
		}
	}
	return result, err
}

func executeLocked(ctx context.Context, projectDir, coreDir string, snapshot state.Snapshot, options Options) (Result, error) {
	expected, definitions, decision, err := expectedInputs(projectDir, coreDir, snapshot)
	if err != nil {
		return Result{}, err
	}
	path := ReceiptPath(snapshot.RecordDir)
	var receipt Receipt
	var content []byte
	execution := "executed"
	if info, statErr := os.Lstat(path); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return Result{}, fmt.Errorf("ST-00 Bootstrap: Receipt must be a regular non-symlink file")
		}
		content, err = os.ReadFile(path)
		if err != nil {
			return Result{}, err
		}
		receipt, err = DecodeReceipt(content)
		if err != nil {
			return Result{}, fmt.Errorf("ST-00 Bootstrap: Receipt was modified or is invalid: %w", err)
		}
		canonical, marshalErr := jsonx.MarshalCanonical(receipt)
		if marshalErr != nil || !bytes.Equal(content, canonical) {
			return Result{}, fmt.Errorf("ST-00 Bootstrap: Receipt is not canonical")
		}
		if err := receiptMatches(receipt, expected); err != nil {
			return Result{}, err
		}
		execution = "reused"
	} else if !os.IsNotExist(statErr) {
		return Result{}, statErr
	} else {
		if decision.Disposition == contract.Reuse {
			return Result{}, fmt.Errorf("ST-00 Bootstrap: reuse requires the same Intent's Bootstrap Receipt")
		}
		createdAt := options.CreatedAt
		if createdAt == "" {
			createdAt = isoMilliseconds(time.Now())
		}
		receipt, err = buildReceipt(expected, createdAt)
		if err != nil {
			return Result{}, err
		}
		content, err = jsonx.MarshalCanonical(receipt)
		if err != nil {
			return Result{}, err
		}
		if err := fsx.AtomicWriteFile(path, content, 0o644); err != nil {
			return Result{}, err
		}
	}
	reference, err := artifactReference(projectDir, path, "bootstrap-receipt", content)
	if err != nil {
		return Result{}, err
	}
	if _, err := policy.VerifyProjectArtifactReference(projectDir, reference); err != nil {
		return Result{}, err
	}
	if decision.Disposition == contract.Reuse && !containsReference(decision.Evidence, reference) {
		return Result{}, fmt.Errorf("ST-00 Bootstrap: reuse Evidence does not match the same Intent's Receipt")
	}
	entries, err := audit.ReadOrdered(snapshot.RecordDir)
	if err != nil {
		return Result{}, err
	}
	for _, entry := range entries {
		if entry.Event == string(audit.StageCompleted) && entry.Fields["Stage"] == "ST-00" && entry.Fields["Receipt SHA-256"] != reference.SHA256 {
			return Result{}, fmt.Errorf("ST-00 Bootstrap: Receipt was modified after ST-00 completion")
		}
	}
	if !hasCompletion(entries, reference) {
		if _, err := audit.AppendBatch(ctx, projectDir, snapshot.RecordDir, []audit.BatchEntry{
			{Event: audit.StageStarted, Fields: []audit.Field{{Name: "Stage", Value: "ST-00"}, {Name: "Executor", Value: "core"}, {Name: "Verifier", Value: "aidlc-vnext-bootstrap"}}},
			{Event: audit.StageCompleted, Fields: []audit.Field{{Name: "Stage", Value: "ST-00"}, {Name: "Artifact", Value: reference.SourceOfTruth}, {Name: "Receipt SHA-256", Value: reference.SHA256}, {Name: "Execution", Value: execution}, {Name: "Decision Authority", Value: "core"}}},
		}, nil); err != nil {
			return Result{}, err
		}
	}
	entries, err = audit.ReadOrdered(snapshot.RecordDir)
	if err != nil {
		return Result{}, err
	}
	if !hasRoute(entries, contract.Stage00, contract.Stage01) {
		if _, err := audit.Append(ctx, projectDir, snapshot.RecordDir, audit.RouteDecided, []audit.Field{
			{Name: "From Stage", Value: "ST-00"}, {Name: "Current Stage", Value: "ST-01"}, {Name: "Graph", Value: definitions.Graph.GraphVersion}, {Name: "Decision Authority", Value: "core"},
		}, nil); err != nil {
			return Result{}, err
		}
	}
	updatedAt := options.CreatedAt
	if updatedAt == "" {
		updatedAt = isoMilliseconds(time.Now())
	}
	reason := "ST-01 Orient is ready for Core preparation."
	advanced := snapshot.State
	advanced.CurrentStage = contract.Stage01
	advanced.Status = state.Parked
	advanced.ParkedReason = &reason
	advanced.NotBefore = nil
	advanced.Deadline = nil
	advanced.UpdatedAt = updatedAt
	if err := state.Store(ctx, projectDir, snapshot.RecordDir, advanced, snapshot.Plan); err != nil {
		return Result{}, err
	}
	return Result{Execution: execution, Receipt: receipt, Reference: reference, State: advanced}, nil
}

// VerifyAt validates a completed Receipt and its Audit binding.
func VerifyAt(projectDir, recordDir string) (Receipt, contract.ArtifactReference, error) {
	path := ReceiptPath(recordDir)
	content, err := os.ReadFile(path)
	if err != nil {
		return Receipt{}, contract.ArtifactReference{}, fmt.Errorf("ST-00 Bootstrap: Bootstrap Receipt does not exist: %s", path)
	}
	receipt, err := DecodeReceipt(content)
	if err != nil {
		return Receipt{}, contract.ArtifactReference{}, fmt.Errorf("ST-00 Bootstrap: Receipt was modified or is invalid: %w", err)
	}
	canonical, err := jsonx.MarshalCanonical(receipt)
	if err != nil || !bytes.Equal(content, canonical) {
		return Receipt{}, contract.ArtifactReference{}, fmt.Errorf("ST-00 Bootstrap: Receipt is not canonical")
	}
	reference, err := artifactReference(projectDir, path, "bootstrap-receipt", content)
	if err != nil {
		return Receipt{}, contract.ArtifactReference{}, err
	}
	if _, err := policy.VerifyProjectArtifactReference(projectDir, reference); err != nil {
		return Receipt{}, contract.ArtifactReference{}, err
	}
	entries, err := audit.ReadOrdered(recordDir)
	if err != nil {
		return Receipt{}, contract.ArtifactReference{}, err
	}
	if !hasCompletion(entries, reference) {
		return Receipt{}, contract.ArtifactReference{}, fmt.Errorf("ST-00 Bootstrap: Audit has no matching ST-00 completion Evidence")
	}
	return receipt, reference, nil
}

// Handler adapts ST-00 execution to the Core orchestrator.
type Handler struct{ CoreDir string }

// Resolve executes ST-00 and returns an advanced Core Directive.
func (handler Handler) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	result, err := Execute(ctx, projectDir, handler.CoreDir, Options{})
	if err != nil {
		return directive.Core{}, err
	}
	from, to := contract.Stage00, contract.Stage01
	directiveResult := directive.Core{
		SchemaVersion: 1, Workflow: "vnext", Reason: "ST-00 Bootstrap completed deterministic Core verification.",
		GraphVersion: result.State.GraphVersion, PlanRevision: result.State.PlanRevision, DecisionAuthority: "core",
		Kind: directive.Advanced, CompletedStage: &from, Stage: &to, Evidence: []contract.ArtifactReference{result.Reference},
	}
	return directiveResult, directiveResult.Validate()
}

func expectedInputs(projectDir, coreDir string, snapshot state.Snapshot) (inputs, catalog.Definitions, contract.CoreStageDecision, error) {
	if _, err := LoadContract(coreDir); err != nil {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, err
	}
	definitions, err := catalog.Load(coreDir)
	if err != nil {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, err
	}
	if err := state.Validate(projectDir, snapshot.RecordDir); err != nil {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, err
	}
	if snapshot.State.CurrentStage != contract.Stage00 {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, fmt.Errorf("ST-00 Bootstrap: current Stage must be ST-00, found %s", snapshot.State.CurrentStage)
	}
	if snapshot.State.CatalogVersion != definitions.Catalog.CatalogVersion || snapshot.State.GraphVersion != definitions.Graph.GraphVersion || snapshot.Plan.GraphVersion != definitions.Graph.GraphVersion {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, fmt.Errorf("ST-00 Bootstrap: persisted definitions do not match the Runtime Catalog and Graph")
	}
	var decision contract.CoreStageDecision
	found := false
	for _, candidate := range snapshot.Plan.StageDecisions {
		if candidate.StageID == contract.Stage00 {
			decision, found = candidate, true
			break
		}
	}
	if !found {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, fmt.Errorf("ST-00 Bootstrap: Plan has no ST-00 decision")
	}
	if decision.Disposition == contract.NotApplicable {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, fmt.Errorf("ST-00 Bootstrap: ST-00 cannot be not_applicable")
	}
	if _, err := policy.VerifyProjectArtifactReference(projectDir, snapshot.State.PolicySnapshot); err != nil {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, fmt.Errorf("ST-00 Bootstrap: Effective Policy SHA-256 does not match: %w", err)
	}
	spaceName := workspace.ActiveSpace(projectDir)
	for label, path := range map[string]string{
		"Project root":         projectDir,
		"Workspace root":       workspace.Root(projectDir),
		"active Space":         filepath.Join(workspace.Root(projectDir), "spaces", spaceName),
		"active Intent record": snapshot.RecordDir,
	} {
		info, statErr := os.Lstat(path)
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, fmt.Errorf("ST-00 Bootstrap: %s does not exist or is not a real directory: %s", label, path)
		}
	}
	roots, err := selectedRepositoryRoots(projectDir, snapshot.RecordDir, snapshot.State.IntentID, spaceName)
	if err != nil {
		return inputs{}, catalog.Definitions{}, contract.CoreStageDecision{}, err
	}
	return inputs{
		IntentID: snapshot.State.IntentID, Space: spaceName, Harness: "codex", AIDLCVersion: version.Version,
		CatalogVersion: snapshot.State.CatalogVersion, GraphVersion: snapshot.State.GraphVersion,
		PlanRevision: snapshot.State.PlanRevision, PolicySnapshot: snapshot.State.PolicySnapshot, RepositoryRoots: roots,
	}, definitions, decision, nil
}

func selectedRepositoryRoots(projectDir, recordDir, intentID, spaceName string) ([]string, error) {
	var matches []intent.RegistryEntry
	for _, entry := range intent.ReadRegistry(projectDir, spaceName) {
		if entry.UUID == intentID && entry.DirName == filepath.Base(recordDir) {
			matches = append(matches, entry)
		}
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("ST-00 Bootstrap: active Intent must have exactly one matching registry entry")
	}
	roots := matches[0].Repos
	if len(roots) == 0 {
		roots = []string{"."}
	}
	seen := map[string]struct{}{}
	result := make([]string, 0, len(roots))
	for _, root := range roots {
		normalized := root
		if root != "." {
			if err := fsx.ValidateRelative(root); err != nil {
				return nil, fmt.Errorf("ST-00 Bootstrap: Repository root must be project-relative and safe: %s", root)
			}
		} else {
			normalized = "."
		}
		if _, exists := seen[normalized]; exists {
			return nil, fmt.Errorf("ST-00 Bootstrap: duplicate Repository root: %s", normalized)
		}
		seen[normalized] = struct{}{}
		path := projectDir
		if normalized != "." {
			var err error
			path, err = fsx.ResolveUnder(projectDir, normalized, false)
			if err != nil {
				return nil, fmt.Errorf("ST-00 Bootstrap: Repository root does not exist: %s", normalized)
			}
		}
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("ST-00 Bootstrap: Repository root does not exist: %s", normalized)
		}
		result = append(result, filepath.ToSlash(normalized))
	}
	return result, nil
}

func buildReceipt(expected inputs, createdAt string) (Receipt, error) {
	compact, err := json.Marshal(expected)
	if err != nil {
		return Receipt{}, err
	}
	receipt := Receipt{
		SchemaVersion: ReceiptSchemaVersion, Artifact: "bootstrap-receipt", Version: ReceiptVersion,
		IntentID: expected.IntentID, Space: expected.Space, Harness: expected.Harness, AIDLCVersion: expected.AIDLCVersion,
		CatalogVersion: expected.CatalogVersion, GraphVersion: expected.GraphVersion, PlanRevision: expected.PlanRevision,
		PolicySnapshot: expected.PolicySnapshot, RepositoryRoots: append([]string(nil), expected.RepositoryRoots...),
		InputSHA256: digest.Bytes(compact), Checks: checksFor(expected), Result: "ready", CreatedAt: createdAt,
	}
	return receipt, receipt.Validate()
}

func checksFor(value inputs) []Check {
	return []Check{
		{CheckID: checkIDs[0], Status: "passed", Evidence: fmt.Sprintf("Active vNext Intent %s is selected in Space %s.", value.IntentID, value.Space)},
		{CheckID: checkIDs[1], Status: "passed", Evidence: fmt.Sprintf("Stage Execution Plan revision %d is valid at ST-00.", value.PlanRevision)},
		{CheckID: checkIDs[2], Status: "passed", Evidence: fmt.Sprintf("Catalog %s and Graph %s are valid.", value.CatalogVersion, value.GraphVersion)},
		{CheckID: checkIDs[3], Status: "passed", Evidence: fmt.Sprintf("Effective Policy %s is verified.", value.PolicySnapshot.SHA256)},
		{CheckID: checkIDs[4], Status: "passed", Evidence: fmt.Sprintf("Codex and Go %s can access: %s.", runtime.Version(), strings.Join(value.RepositoryRoots, ", "))},
	}
}

func receiptMatches(receipt Receipt, expected inputs) error {
	compact, err := json.Marshal(expected)
	if err != nil {
		return err
	}
	if receipt.InputSHA256 != digest.Bytes(compact) {
		return fmt.Errorf("ST-00 Bootstrap: Receipt input fingerprint does not match current Core inputs")
	}
	if receipt.IntentID != expected.IntentID || receipt.Space != expected.Space || receipt.Harness != expected.Harness ||
		receipt.AIDLCVersion != expected.AIDLCVersion || receipt.CatalogVersion != expected.CatalogVersion || receipt.GraphVersion != expected.GraphVersion ||
		receipt.PlanRevision != expected.PlanRevision || receipt.PolicySnapshot != expected.PolicySnapshot || !equalStrings(receipt.RepositoryRoots, expected.RepositoryRoots) {
		return fmt.Errorf("ST-00 Bootstrap: Receipt does not match current Core inputs")
	}
	expectedChecks := checksFor(expected)
	if !equalChecks(receipt.Checks, expectedChecks) {
		return fmt.Errorf("ST-00 Bootstrap: Receipt checks do not match current Core verification")
	}
	return nil
}

func artifactReference(projectDir, filePath, artifact string, content []byte) (contract.ArtifactReference, error) {
	relative, err := filepath.Rel(projectDir, filePath)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return contract.ArtifactReference{}, fmt.Errorf("Bootstrap Receipt: source_of_truth must remain inside the project")
	}
	return contract.ArtifactReference{Artifact: artifact, Version: 1, SourceOfTruth: filepath.ToSlash(relative), SHA256: digest.Bytes(content)}, nil
}

func containsReference(values []contract.ArtifactReference, expected contract.ArtifactReference) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func hasCompletion(entries []audit.OrderedEntry, reference contract.ArtifactReference) bool {
	for _, entry := range entries {
		if entry.Event == string(audit.StageCompleted) && entry.Fields["Stage"] == "ST-00" && entry.Fields["Receipt SHA-256"] == reference.SHA256 {
			return true
		}
	}
	return false
}

func hasRoute(entries []audit.OrderedEntry, from, to contract.StageID) bool {
	for _, entry := range entries {
		if entry.Event == string(audit.RouteDecided) && entry.Fields["From Stage"] == string(from) && entry.Fields["Current Stage"] == string(to) {
			return true
		}
	}
	return false
}

func equalStrings(left, right []string) bool {
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

func equalChecks(left, right []Check) bool {
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

func oneLine(value, field string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("Bootstrap Receipt.%s must be a non-empty single-line string", field)
	}
	return nil
}

func parseTimestamp(value string) (time.Time, error) {
	if err := oneLine(value, "timestamp"); err != nil {
		return time.Time{}, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || !strings.HasSuffix(value, "Z") {
		return time.Time{}, fmt.Errorf("must be an ISO-8601 UTC timestamp")
	}
	return parsed, nil
}

func isoMilliseconds(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func cleanError(err error) string {
	return strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(err.Error()))
}
