// Package gate resolves and validates Human Gate requirements from pinned
// Effective Policy and Intent Risk artifacts.
package gate

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/explanationhtml"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/workflow/policy"
	"github.com/sori883/aidlc/internal/workflow/risk"
)

var allowedStages = map[contract.StageID]struct{}{
	contract.Stage04: {}, contract.Stage05: {}, contract.Stage07: {}, contract.Stage08: {}, contract.Stage09: {},
}

// Requirement joins one active Risk with one matching Policy rule.
type Requirement struct {
	RequirementID string          `json:"requirement_id"`
	RuleID        string          `json:"rule_id"`
	RiskID        string          `json:"risk_id"`
	Severity      policy.Severity `json:"severity"`
	RiskStatement string          `json:"risk_statement"`
	Statement     string          `json:"statement"`
}

// RequirementSet pins the exact Policy and Risk revisions reviewed by a human.
type RequirementSet struct {
	SchemaVersion      int                        `json:"schema_version"`
	Artifact           string                     `json:"artifact"`
	Version            int                        `json:"version"`
	IntentID           string                     `json:"intent_id"`
	StageID            contract.StageID           `json:"stage_id"`
	EffectivePolicyRef contract.ArtifactReference `json:"effective_policy_ref"`
	RiskRegisterRef    contract.ArtifactReference `json:"risk_register_ref"`
	Requirements       []Requirement              `json:"requirements"`
	CreatedAt          string                     `json:"created_at"`
}

// Acknowledgement is an explicit human acknowledgement for one Requirement.
type Acknowledgement struct {
	RequirementID string `json:"requirement_id"`
	Acknowledged  bool   `json:"acknowledged"`
	Reason        string `json:"reason"`
}

// Resolved describes a persisted Requirement Set and its reference.
type Resolved struct {
	Set       RequirementSet
	Path      string
	Reference contract.ArtifactReference
}

// DecodeRequirementSet strictly parses one Requirement Set.
func DecodeRequirementSet(content []byte) (RequirementSet, error) {
	value, err := jsonx.Decode[RequirementSet](content)
	if err != nil {
		return RequirementSet{}, err
	}
	if err := value.Validate(); err != nil {
		return RequirementSet{}, err
	}
	return value, nil
}

// DecodeAcknowledgement strictly parses one human acknowledgement.
func DecodeAcknowledgement(content []byte) (Acknowledgement, error) {
	value, err := jsonx.Decode[Acknowledgement](content)
	if err != nil {
		return Acknowledgement{}, err
	}
	if err := value.Validate(); err != nil {
		return Acknowledgement{}, err
	}
	return value, nil
}

// Validate enforces a complete Requirement Set.
func (value RequirementSet) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "human-gate-requirements" || value.Version != 1 {
		return fmt.Errorf("Human Gate Requirement Set has an invalid schema identity")
	}
	if err := oneLine(value.IntentID, "intent_id"); err != nil {
		return err
	}
	if _, ok := allowedStages[value.StageID]; !ok {
		return fmt.Errorf("stage_id must be a Human Gate Stage")
	}
	if err := value.EffectivePolicyRef.Validate(); err != nil {
		return fmt.Errorf("effective_policy_ref: %w", err)
	}
	if err := value.RiskRegisterRef.Validate(); err != nil {
		return fmt.Errorf("risk_register_ref: %w", err)
	}
	if value.Requirements == nil {
		return fmt.Errorf("requirements must be an array")
	}
	seen := make(map[string]struct{}, len(value.Requirements))
	previous := ""
	for index, item := range value.Requirements {
		if err := item.Validate(); err != nil {
			return fmt.Errorf("requirements[%d]: %w", index, err)
		}
		if _, exists := seen[item.RequirementID]; exists {
			return fmt.Errorf("requirements contains duplicate ID: %s", item.RequirementID)
		}
		if previous != "" && item.RequirementID < previous {
			return fmt.Errorf("requirements must be ordered by requirement_id")
		}
		seen[item.RequirementID], previous = struct{}{}, item.RequirementID
	}
	return timestamp(value.CreatedAt, "created_at")
}

// Validate enforces one resolved Requirement.
func (value Requirement) Validate() error {
	for field, item := range map[string]string{
		"requirement_id": value.RequirementID,
		"rule_id":        value.RuleID,
		"risk_id":        value.RiskID,
		"risk_statement": value.RiskStatement,
		"statement":      value.Statement,
	} {
		if err := oneLine(item, field); err != nil {
			return err
		}
	}
	if !severityValid(value.Severity) {
		return fmt.Errorf("severity is invalid")
	}
	if value.RequirementID != value.RuleID+":"+value.RiskID {
		return fmt.Errorf("requirement_id must equal rule_id:risk_id")
	}
	return nil
}

// Validate enforces explicit human acknowledgement.
func (value Acknowledgement) Validate() error {
	if err := oneLine(value.RequirementID, "requirement_id"); err != nil {
		return err
	}
	if !value.Acknowledged {
		return fmt.Errorf("acknowledged must equal true")
	}
	return oneLine(value.Reason, "reason")
}

// Resolve creates or reuses an immutable Requirement Set.
func Resolve(projectDir, recordDir string, stageID contract.StageID, effectivePolicyRef contract.ArtifactReference, createdAt string) (Resolved, error) {
	if _, ok := allowedStages[stageID]; !ok {
		return Resolved{}, fmt.Errorf("Human Gate stage is invalid: %s", stageID)
	}
	policyPath, err := policy.VerifyProjectArtifactReference(projectDir, effectivePolicyRef)
	if err != nil {
		return Resolved{}, err
	}
	policyContent, err := os.ReadFile(policyPath)
	if err != nil {
		return Resolved{}, err
	}
	snapshot, err := policy.DecodeSnapshot(policyContent)
	if err != nil {
		return Resolved{}, err
	}
	register, registerRef, _, err := risk.ReadCurrent(projectDir, recordDir)
	if err != nil {
		return Resolved{}, err
	}
	if snapshot.IntentID != register.IntentID {
		return Resolved{}, fmt.Errorf("Human Gate Effective Policy and Risk Register belong to different Intents")
	}
	var requirements []Requirement
	for _, rule := range snapshot.HumanGateRules {
		if !containsStage(rule.StageIDs, stageID) {
			continue
		}
		for _, item := range register.Risks {
			if item.Status != risk.Active || severityRank(item.Severity) < severityRank(rule.MinimumSeverity) {
				continue
			}
			requirements = append(requirements, Requirement{
				RequirementID: rule.RuleID + ":" + item.RiskID,
				RuleID:        rule.RuleID,
				RiskID:        item.RiskID,
				Severity:      item.Severity,
				RiskStatement: item.Statement,
				Statement:     rule.Acknowledgement,
			})
		}
	}
	if requirements == nil {
		requirements = []Requirement{}
	}
	sort.Slice(requirements, func(left, right int) bool {
		return requirements[left].RequirementID < requirements[right].RequirementID
	})
	if createdAt == "" {
		createdAt = time.Now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	}
	set := RequirementSet{
		SchemaVersion: 1, Artifact: "human-gate-requirements", Version: 1,
		IntentID: snapshot.IntentID, StageID: stageID,
		EffectivePolicyRef: effectivePolicyRef, RiskRegisterRef: registerRef,
		Requirements: requirements, CreatedAt: createdAt,
	}
	if err := set.Validate(); err != nil {
		return Resolved{}, err
	}
	path, err := requirementPath(projectDir, recordDir, set)
	if err != nil {
		return Resolved{}, err
	}
	relativePath, err := portablePath(projectDir, path)
	if err != nil {
		return Resolved{}, err
	}
	if _, err := fsx.ResolveUnder(projectDir, relativePath, true); err != nil {
		return Resolved{}, fmt.Errorf("Human Gate Requirement Set path: %w", err)
	}
	content, err := jsonx.MarshalCanonical(set)
	if err != nil {
		return Resolved{}, err
	}
	if existing, readErr := os.ReadFile(path); readErr == nil {
		persisted, decodeErr := DecodeRequirementSet(existing)
		if decodeErr != nil {
			return Resolved{}, decodeErr
		}
		comparison := persisted
		comparison.CreatedAt = set.CreatedAt
		stableStored, _ := jsonx.MarshalCanonical(comparison)
		if string(stableStored) != string(content) {
			return Resolved{}, fmt.Errorf("Human Gate immutable Requirement Set differs")
		}
		content = existing
		set = persisted
	} else if !os.IsNotExist(readErr) {
		return Resolved{}, readErr
	} else {
		relativeParent, err := portablePath(projectDir, filepath.Dir(path))
		if err != nil {
			return Resolved{}, err
		}
		if _, err := fsx.EnsureDirUnder(projectDir, relativeParent, 0o755); err != nil {
			return Resolved{}, err
		}
		if err := fsx.AtomicWriteFile(path, content, 0o644); err != nil {
			return Resolved{}, err
		}
	}
	reference, err := referenceFor(projectDir, path, content)
	if err != nil {
		return Resolved{}, err
	}
	return Resolved{Set: set, Path: path, Reference: reference}, nil
}

// ValidateAcknowledgements requires exactly one acknowledgement per Requirement.
func ValidateAcknowledgements(projectDir, recordDir string, set RequirementSet, values []Acknowledgement, requireCurrentRisk bool) error {
	if err := set.Validate(); err != nil {
		return err
	}
	if requireCurrentRisk {
		_, currentRef, _, err := risk.ReadCurrent(projectDir, recordDir)
		if err != nil {
			return err
		}
		if currentRef != set.RiskRegisterRef {
			return fmt.Errorf("Human Gate Risk Register changed after the Requirement Set was created")
		}
	}
	expected := make(map[string]struct{}, len(set.Requirements))
	for _, item := range set.Requirements {
		expected[item.RequirementID] = struct{}{}
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if err := value.Validate(); err != nil {
			return err
		}
		if _, exists := seen[value.RequirementID]; exists {
			return fmt.Errorf("Human Gate duplicate acknowledgement: %s", value.RequirementID)
		}
		if _, exists := expected[value.RequirementID]; !exists {
			return fmt.Errorf("Human Gate unknown acknowledgement: %s", value.RequirementID)
		}
		seen[value.RequirementID] = struct{}{}
	}
	for requirementID := range expected {
		if _, exists := seen[requirementID]; !exists {
			return fmt.Errorf("Human Gate missing acknowledgement: %s", requirementID)
		}
	}
	return nil
}

// RenderReviewHTML produces the same compact, escaped Human Gate review view.
func RenderReviewHTML(set RequirementSet, subject string) (string, error) {
	if err := set.Validate(); err != nil {
		return "", err
	}
	return explanationhtml.Render(explanationhtml.Page{
		Title:   string(set.StageID) + " Human Gate",
		Eyebrow: "AI-DLC / " + string(set.StageID),
		Heading: string(set.StageID) + " 人間確認",
		Lead:    "このページは、Policy（追加ルール）とIntent Risk（今回の作業で注意すること）を含めて、対象を承認してよいか確認するためのページです。",
		Notice:  "対象と追加確認事項を読み、承認または修正依頼を人が決めます。AIはこの判断を代行しません。",
		Metrics: []explanationhtml.Metric{
			{Label: "現在のStage", Value: string(set.StageID), Help: "AI-DLCの現在位置"},
			{Label: "追加確認", Value: fmt.Sprint(len(set.Requirements)) + "件", Help: "PolicyとRiskから導かれた項目"},
		},
		Sections: []explanationhtml.Section{
			{
				Heading: "今回確認する対象",
				Lead:    "この対象について、人の判断が必要です。",
				Cards: []explanationhtml.Card{{
					Label:   "判断対象",
					Heading: subject,
					Text:    "内容が意図と一致し、次へ進めてよいかを確認してください。",
				}},
			},
			ReviewSection(set),
		},
		Footer: []explanationhtml.Fact{
			{Label: "Intent", Value: set.IntentID, Code: true},
			{Label: "Effective Policy SHA-256", Value: set.EffectivePolicyRef.SHA256, Code: true},
			{Label: "Risk Register SHA-256", Value: set.RiskRegisterRef.SHA256, Code: true},
		},
	})
}

// ReviewSection returns the Policy and Risk portion of a larger explanatory
// review page without creating a second HTML document.
func ReviewSection(set RequirementSet) explanationhtml.Section {
	section := explanationhtml.Section{
		Heading: "追加のPolicy確認",
		Lead:    "固定のHuman Gateに加え、現在のPolicyとIntent Riskから必要になった確認です。",
	}
	if len(set.Requirements) == 0 {
		section.Items = []explanationhtml.Item{{Text: "追加の確認項目はありません。固定のHuman Gateは通常どおり実行します。"}}
		return section
	}
	for _, item := range set.Requirements {
		section.Cards = append(section.Cards, explanationhtml.Card{
			Label:   item.RequirementID,
			Heading: item.Statement,
			Text:    item.RiskStatement,
			Tone:    "warning",
			Facts: []explanationhtml.Fact{
				{Label: "重要度", Value: string(item.Severity)},
				{Label: "Risk ID", Value: item.RiskID, Code: true},
				{Label: "Rule ID", Value: item.RuleID, Code: true},
			},
		})
	}
	return section
}

func requirementPath(projectDir, recordDir string, set RequirementSet) (string, error) {
	keyInput := string(set.StageID) + "\x00" + set.EffectivePolicyRef.SHA256 + "\x00" + set.RiskRegisterRef.SHA256
	sum := sha256.Sum256([]byte(keyInput))
	path := filepath.Join(recordDir, "artifacts", "gates", string(set.StageID), hex.EncodeToString(sum[:]), "requirements.json")
	if _, err := portablePath(projectDir, path); err != nil {
		return "", err
	}
	return path, nil
}

func referenceFor(projectDir, path string, content []byte) (contract.ArtifactReference, error) {
	relative, err := portablePath(projectDir, path)
	if err != nil {
		return contract.ArtifactReference{}, err
	}
	return contract.ArtifactReference{Artifact: "human-gate-requirements", Version: 1, SourceOfTruth: relative, SHA256: digest.Bytes(content)}, nil
}

func portablePath(projectDir, path string) (string, error) {
	root, err := filepath.Abs(projectDir)
	if err != nil {
		return "", err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, absolute)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("Human Gate path is outside the Project: %s", absolute)
	}
	portable := filepath.ToSlash(relative)
	if err := fsx.ValidateRelative(portable); err != nil {
		return "", err
	}
	return portable, nil
}

func containsStage(values []contract.StageID, expected contract.StageID) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func severityValid(value policy.Severity) bool { return severityRank(value) >= 0 }

func severityRank(value policy.Severity) int {
	switch value {
	case policy.Low:
		return 0
	case policy.Medium:
		return 1
	case policy.High:
		return 2
	case policy.Critical:
		return 3
	default:
		return -1
	}
}

func oneLine(value, field string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s must be a non-empty single-line string", field)
	}
	return nil
}

func timestamp(value, field string) error {
	if err := oneLine(value, field); err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339Nano, value); err != nil || !strings.HasSuffix(value, "Z") {
		return fmt.Errorf("%s must be an ISO-8601 UTC timestamp", field)
	}
	return nil
}
