// Package policy builds and verifies immutable Effective Policy snapshots.
package policy

import (
	"fmt"
	"os"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/workspace"
)

const SnapshotSchemaVersion = 2

// Layer is one fixed Memory priority layer.
type Layer string

const (
	Org     Layer = "org"
	Team    Layer = "team"
	Project Layer = "project"
)

var OrderedLayers = []Layer{Org, Team, Project}

// Severity is an Intent Risk severity.
type Severity string

const (
	Low      Severity = "low"
	Medium   Severity = "medium"
	High     Severity = "high"
	Critical Severity = "critical"
)

var (
	ruleIDPattern    = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	timestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$`)
	humanGateStages  = map[contract.StageID]struct{}{
		contract.Stage04: {}, contract.Stage05: {}, contract.Stage07: {}, contract.Stage08: {}, contract.Stage09: {},
	}
)

// Source pins one Markdown or machine Policy source.
type Source struct {
	Layer         Layer  `json:"layer"`
	SourceOfTruth string `json:"source_of_truth"`
	SHA256        string `json:"sha256"`
	Content       string `json:"content"`
}

// HumanGateRule declares a minimum-risk acknowledgement at selected Stages.
type HumanGateRule struct {
	RuleID          string             `json:"rule_id"`
	MinimumSeverity Severity           `json:"minimum_severity"`
	StageIDs        []contract.StageID `json:"stage_ids"`
	Acknowledgement string             `json:"acknowledgement"`
}

// SourceDocument is the strict machine Policy file stored beside Memory.
type SourceDocument struct {
	SchemaVersion int             `json:"schema_version"`
	Artifact      string          `json:"artifact"`
	Layer         Layer           `json:"layer"`
	Rules         []HumanGateRule `json:"rules"`
}

// Snapshot is the immutable additive policy view for one Intent.
type Snapshot struct {
	SchemaVersion  int             `json:"schema_version"`
	SnapshotID     string          `json:"snapshot_id"`
	IntentID       string          `json:"intent_id"`
	Revision       int             `json:"revision"`
	CreatedAt      string          `json:"created_at"`
	SourcePriority []Layer         `json:"source_priority"`
	Sources        []Source        `json:"sources"`
	ControlSources []Source        `json:"control_sources"`
	HumanGateRules []HumanGateRule `json:"human_gate_rules"`
}

// BuildOptions injects revision and clock.
type BuildOptions struct {
	Revision  int
	CreatedAt string
}

// Written describes a persisted snapshot and reference.
type Written struct {
	Path      string
	Snapshot  Snapshot
	Reference contract.ArtifactReference
}

// DecodeSourceDocument strictly parses a machine Policy source.
func DecodeSourceDocument(content []byte) (SourceDocument, error) {
	value, err := jsonx.Decode[SourceDocument](content)
	if err != nil {
		return SourceDocument{}, err
	}
	if err := value.Validate(); err != nil {
		return SourceDocument{}, err
	}
	return value, nil
}

// DecodeSnapshot strictly parses and validates an Effective Policy snapshot.
func DecodeSnapshot(content []byte) (Snapshot, error) {
	value, err := jsonx.Decode[Snapshot](content)
	if err != nil {
		return Snapshot{}, err
	}
	if err := value.Validate(); err != nil {
		return Snapshot{}, err
	}
	return value, nil
}

// Validate enforces a machine Policy source.
func (value SourceDocument) Validate() error {
	if value.SchemaVersion != 1 {
		return fmt.Errorf("Human Gate Policy source.schema_version must equal 1")
	}
	if value.Artifact != "human-gate-policy-source" {
		return fmt.Errorf("Human Gate Policy source.artifact must equal human-gate-policy-source")
	}
	if !value.Layer.valid() {
		return fmt.Errorf("Human Gate Policy source.layer is invalid")
	}
	if value.Rules == nil {
		return fmt.Errorf("Human Gate Policy source.rules must be an array")
	}
	seen := make(map[string]struct{}, len(value.Rules))
	for index, rule := range value.Rules {
		if err := rule.Validate(); err != nil {
			return fmt.Errorf("Human Gate Policy source.rules[%d]: %w", index, err)
		}
		if _, exists := seen[rule.RuleID]; exists {
			return fmt.Errorf("Human Gate Policy source.rules contains duplicate rule_id: %s", rule.RuleID)
		}
		seen[rule.RuleID] = struct{}{}
	}
	return nil
}

// Validate enforces a Human Gate rule.
func (value HumanGateRule) Validate() error {
	if !ruleIDPattern.MatchString(value.RuleID) {
		return fmt.Errorf("rule_id must use lowercase kebab-case")
	}
	if !value.MinimumSeverity.valid() {
		return fmt.Errorf("minimum_severity is invalid")
	}
	if len(value.StageIDs) == 0 {
		return fmt.Errorf("stage_ids must be a non-empty array")
	}
	seen := make(map[contract.StageID]struct{}, len(value.StageIDs))
	for _, stageID := range value.StageIDs {
		if _, allowed := humanGateStages[stageID]; !allowed {
			return fmt.Errorf("stage_ids contains non-Human-Gate Stage: %s", stageID)
		}
		if _, exists := seen[stageID]; exists {
			return fmt.Errorf("stage_ids contains duplicate Stage: %s", stageID)
		}
		seen[stageID] = struct{}{}
	}
	return oneLine(value.Acknowledgement, "acknowledgement")
}

// Validate enforces byte hashes, fixed order, and additive control rules.
func (value Snapshot) Validate() error {
	if value.SchemaVersion != SnapshotSchemaVersion {
		return fmt.Errorf("Effective Policy snapshot.schema_version must equal %d", SnapshotSchemaVersion)
	}
	if err := oneLine(value.SnapshotID, "snapshot_id"); err != nil {
		return err
	}
	if err := oneLine(value.IntentID, "intent_id"); err != nil {
		return err
	}
	if value.Revision < 1 {
		return fmt.Errorf("Effective Policy snapshot.revision must be a positive integer")
	}
	if !timestampPattern.MatchString(value.CreatedAt) {
		return fmt.Errorf("Effective Policy snapshot.created_at must be an ISO-8601 UTC timestamp")
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", normalizeTimestamp(value.CreatedAt)); err != nil {
		return fmt.Errorf("Effective Policy snapshot.created_at must be an ISO-8601 UTC timestamp")
	}
	if !equalLayers(value.SourcePriority, OrderedLayers) {
		return fmt.Errorf("Effective Policy snapshot.source_priority must use org, team, project order")
	}
	if err := validateSources(value.Sources, false, "sources"); err != nil {
		return err
	}
	if err := validateSources(value.ControlSources, true, "control_sources"); err != nil {
		return err
	}
	var expected []HumanGateRule
	for index, source := range value.ControlSources {
		document, err := DecodeSourceDocument([]byte(source.Content))
		if err != nil {
			return fmt.Errorf("Effective Policy snapshot.control_sources[%d].content: %w", index, err)
		}
		if document.Layer != source.Layer {
			return fmt.Errorf("Effective Policy snapshot.control_sources[%d].content.layer must equal %s", index, source.Layer)
		}
		expected = append(expected, document.Rules...)
	}
	if !equalRules(value.HumanGateRules, expected) {
		return fmt.Errorf("Effective Policy snapshot.human_gate_rules must equal the additive control source rules")
	}
	seen := make(map[string]struct{}, len(value.HumanGateRules))
	for _, rule := range value.HumanGateRules {
		if _, exists := seen[rule.RuleID]; exists {
			return fmt.Errorf("Effective Policy snapshot.human_gate_rules duplicate rule_id: %s", rule.RuleID)
		}
		seen[rule.RuleID] = struct{}{}
	}
	return nil
}

// Build snapshots all six Memory files in fixed priority order.
func Build(projectDir, intentID string, options BuildOptions) (Snapshot, error) {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return Snapshot{}, err
	}
	revision := options.Revision
	if revision == 0 {
		revision = 1
	}
	if revision < 1 {
		return Snapshot{}, fmt.Errorf("Effective Policy revision must be a positive integer")
	}
	selectedSpace := workspace.ActiveSpace(projectRoot)
	memoryRelative := "aidlc/spaces/" + selectedSpace + "/memory"
	memoryDir, err := fsx.ResolveUnder(projectRoot, memoryRelative, false)
	if err != nil {
		return Snapshot{}, fmt.Errorf("resolve Effective Policy Memory: %w", err)
	}
	var sources []Source
	var controls []Source
	var rules []HumanGateRule
	for _, layer := range OrderedLayers {
		markdown, err := readSource(projectRoot, filepath.Join(memoryDir, string(layer)+".md"), layer)
		if err != nil {
			return Snapshot{}, fmt.Errorf("Effective Policy missing %s Memory: %w", layer, err)
		}
		sources = append(sources, markdown)
		control, err := readSource(projectRoot, filepath.Join(memoryDir, string(layer)+"-policy.json"), layer)
		if err != nil {
			return Snapshot{}, fmt.Errorf("Effective Policy missing %s machine Policy: %w", layer, err)
		}
		document, err := DecodeSourceDocument([]byte(control.Content))
		if err != nil {
			return Snapshot{}, fmt.Errorf("Effective Policy %s machine Policy: %w", layer, err)
		}
		if document.Layer != layer {
			return Snapshot{}, fmt.Errorf("Effective Policy %s machine Policy.layer must equal %s", layer, layer)
		}
		controls = append(controls, control)
		rules = append(rules, document.Rules...)
	}
	createdAt := options.CreatedAt
	if createdAt == "" {
		createdAt = isoMilliseconds(time.Now())
	}
	snapshot := Snapshot{
		SchemaVersion: SnapshotSchemaVersion, SnapshotID: fmt.Sprintf("effective-policy-%s-r%d", intentID, revision),
		IntentID: intentID, Revision: revision, CreatedAt: createdAt,
		SourcePriority: append([]Layer(nil), OrderedLayers...), Sources: sources, ControlSources: controls, HumanGateRules: rules,
	}
	if err := snapshot.Validate(); err != nil {
		return Snapshot{}, err
	}
	return snapshot, nil
}

// Write persists one immutable snapshot and returns its raw-byte reference.
func Write(projectDir, recordDir, intentID string, options BuildOptions) (Written, error) {
	snapshot, err := Build(projectDir, intentID, options)
	if err != nil {
		return Written{}, err
	}
	content, err := jsonx.MarshalCanonical(snapshot)
	if err != nil {
		return Written{}, err
	}
	revision := snapshot.Revision
	path := filepath.Join(recordDir, fmt.Sprintf("effective-policy-r%d.json", revision))
	source, err := portableProjectPath(projectDir, path)
	if err != nil {
		return Written{}, err
	}
	if _, err := fsx.ResolveUnder(projectDir, source, true); err != nil {
		return Written{}, fmt.Errorf("Effective Policy snapshot path: %w", err)
	}
	if existing, readErr := os.ReadFile(path); readErr == nil {
		if string(existing) != string(content) {
			return Written{}, fmt.Errorf("Effective Policy immutable snapshot already has different content: %s", source)
		}
	} else if !os.IsNotExist(readErr) {
		return Written{}, readErr
	} else {
		parent := pathpkg.Dir(source)
		if _, err := fsx.EnsureDirUnder(projectDir, parent, 0o755); err != nil {
			return Written{}, err
		}
		if err := fsx.AtomicWriteFile(path, content, 0o644); err != nil {
			return Written{}, err
		}
	}
	reference := contract.ArtifactReference{Artifact: "effective-policy", Version: revision, SourceOfTruth: source, SHA256: digest.Bytes(content)}
	if err := reference.Validate(); err != nil {
		return Written{}, err
	}
	return Written{Path: path, Snapshot: snapshot, Reference: reference}, nil
}

// VerifyProjectArtifactReference validates safe path, raw bytes, and digest.
func VerifyProjectArtifactReference(projectDir string, reference contract.ArtifactReference) (string, error) {
	if err := reference.Validate(); err != nil {
		return "", err
	}
	path, err := fsx.ResolveUnder(projectDir, reference.SourceOfTruth, false)
	if err != nil {
		return "", fmt.Errorf("Artifact reference source_of_truth: %w", err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Artifact reference source_of_truth does not exist: %s", reference.SourceOfTruth)
	}
	actual, err := digest.File(path)
	if err != nil {
		return "", err
	}
	if actual != reference.SHA256 {
		return "", fmt.Errorf("Artifact reference sha256 mismatch for %s", reference.SourceOfTruth)
	}
	return path, nil
}

func validateSources(values []Source, control bool, context string) error {
	if len(values) != len(OrderedLayers) {
		return fmt.Errorf("Effective Policy snapshot.%s must contain exactly %d sources", context, len(OrderedLayers))
	}
	for index, expected := range OrderedLayers {
		value := values[index]
		if value.Layer != expected {
			return fmt.Errorf("Effective Policy snapshot.%s[%d].layer must equal %s", context, index, expected)
		}
		if err := oneLine(value.SourceOfTruth, context+".source_of_truth"); err != nil {
			return err
		}
		if err := digest.Validate(value.SHA256); err != nil {
			return err
		}
		if digest.Bytes([]byte(value.Content)) != value.SHA256 {
			return fmt.Errorf("Effective Policy snapshot.%s[%d].sha256 does not match the snapshotted content", context, index)
		}
		if control {
			if _, err := DecodeSourceDocument([]byte(value.Content)); err != nil {
				return err
			}
		}
	}
	return nil
}

func readSource(projectRoot, path string, layer Layer) (Source, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return Source{}, fmt.Errorf("not a regular file: %s", path)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return Source{}, err
	}
	portable, err := portableProjectPath(projectRoot, path)
	if err != nil {
		return Source{}, err
	}
	return Source{Layer: layer, SourceOfTruth: portable, SHA256: digest.Bytes(content), Content: string(content)}, nil
}

func portableProjectPath(projectDir, value string) (string, error) {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return "", err
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(projectRoot, absolute)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("Effective Policy path is outside the project: %s", absolute)
	}
	portable := filepath.ToSlash(relative)
	if err := fsx.ValidateRelative(portable); err != nil {
		return "", err
	}
	return portable, nil
}

func (value Layer) valid() bool { return value == Org || value == Team || value == Project }
func (value Severity) valid() bool {
	return value == Low || value == Medium || value == High || value == Critical
}

func oneLine(value, field string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s must be a non-empty single-line string", field)
	}
	return nil
}

func equalLayers(actual, expected []Layer) bool {
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

func equalRules(actual, expected []HumanGateRule) bool {
	if len(actual) != len(expected) {
		return false
	}
	for index := range expected {
		left, right := actual[index], expected[index]
		if left.RuleID != right.RuleID || left.MinimumSeverity != right.MinimumSeverity || left.Acknowledgement != right.Acknowledgement || len(left.StageIDs) != len(right.StageIDs) {
			return false
		}
		for stageIndex := range left.StageIDs {
			if left.StageIDs[stageIndex] != right.StageIDs[stageIndex] {
				return false
			}
		}
	}
	return true
}

func normalizeTimestamp(value string) string {
	if strings.Contains(value, ".") {
		return value
	}
	return strings.TrimSuffix(value, "Z") + ".000Z"
}

func isoMilliseconds(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
