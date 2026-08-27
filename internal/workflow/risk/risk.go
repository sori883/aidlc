// Package risk persists immutable Intent Risk revisions and a mutable pointer.
package risk

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/digest"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	"github.com/sori883/aidlc/internal/workflow/policy"
)

var stableID = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

// Status is one persisted Risk lifecycle state.
type Status string

const (
	Active    Status = "active"
	Resolved  Status = "resolved"
	Dismissed Status = "dismissed"
)

// DecisionAction is a human-only Risk mutation.
type DecisionAction string

const (
	Dismiss     DecisionAction = "dismiss"
	Resolve     DecisionAction = "resolve"
	SetSeverity DecisionAction = "set-severity"
)

// Seed is the common Risk content.
type Seed struct {
	RiskID       string                       `json:"risk_id"`
	Severity     policy.Severity              `json:"severity"`
	Statement    string                       `json:"statement"`
	EvidenceRefs []contract.ArtifactReference `json:"evidence_refs"`
}

// Entry is one Risk in the current Register.
type Entry struct {
	RiskID          string                       `json:"risk_id"`
	Severity        policy.Severity              `json:"severity"`
	Statement       string                       `json:"statement"`
	Status          Status                       `json:"status"`
	EvidenceRefs    []contract.ArtifactReference `json:"evidence_refs"`
	LastDecisionRef *contract.ArtifactReference  `json:"last_decision_ref"`
}

// Register is an immutable Risk revision.
type Register struct {
	SchemaVersion int     `json:"schema_version"`
	Artifact      string  `json:"artifact"`
	Version       int     `json:"version"`
	IntentID      string  `json:"intent_id"`
	Revision      int     `json:"revision"`
	BaseRevision  *int    `json:"base_revision"`
	Risks         []Entry `json:"risks"`
	CreatedAt     string  `json:"created_at"`
}

// Current pins the latest immutable Register.
type Current struct {
	SchemaVersion   int                        `json:"schema_version"`
	Artifact        string                     `json:"artifact"`
	Version         int                        `json:"version"`
	IntentID        string                     `json:"intent_id"`
	CurrentRevision int                        `json:"current_revision"`
	RegisterRef     contract.ArtifactReference `json:"register_ref"`
	UpdatedAt       string                     `json:"updated_at"`
}

// Proposal is an untrusted AI/human request that can add or raise Risks.
type Proposal struct {
	SchemaVersion int    `json:"schema_version"`
	Artifact      string `json:"artifact"`
	Version       int    `json:"version"`
	ProposalID    string `json:"proposal_id"`
	IntentID      string `json:"intent_id"`
	BaseRevision  int    `json:"base_revision"`
	Risks         []Seed `json:"risks"`
	Reason        string `json:"reason"`
	ProposedBy    string `json:"proposed_by"`
	ProposedAt    string `json:"proposed_at"`
}

// Decision is a human-only Risk reduction, resolution, or dismissal.
type Decision struct {
	SchemaVersion        int                          `json:"schema_version"`
	Artifact             string                       `json:"artifact"`
	Version              int                          `json:"version"`
	DecisionID           string                       `json:"decision_id"`
	IntentID             string                       `json:"intent_id"`
	RiskID               string                       `json:"risk_id"`
	Action               DecisionAction               `json:"action"`
	Severity             *policy.Severity             `json:"severity"`
	EvidenceRefs         []contract.ArtifactReference `json:"evidence_refs"`
	HumanInputReceiptRef contract.ArtifactReference   `json:"human_input_receipt_ref"`
	Reason               string                       `json:"reason"`
	DecidedBy            string                       `json:"decided_by"`
	DecidedAt            string                       `json:"decided_at"`
}

// Written contains both immutable and Current references.
type Written struct {
	Register          Register
	RegisterReference contract.ArtifactReference
	Current           Current
	CurrentReference  contract.ArtifactReference
}

type DecisionParameters struct {
	DecisionID   string                       `json:"decision_id"`
	RiskID       string                       `json:"risk_id"`
	Severity     *policy.Severity             `json:"severity"`
	EvidenceRefs []contract.ArtifactReference `json:"evidence_refs"`
}

type DecideResult struct {
	Register               Register                   `json:"register"`
	Decision               Decision                   `json:"decision"`
	DecisionReference      contract.ArtifactReference `json:"decisionReference"`
	HumanGateResolution    humanapproval.Resolution   `json:"humanGateResolution"`
	HumanGateResolutionRef contract.ArtifactReference `json:"humanGateResolutionReference"`
}

// Options controls deterministic timestamps and initial Risks.
type Options struct {
	Risks     []Seed
	CreatedAt string
}

// DecodeProposal strictly parses a Risk Proposal.
func DecodeProposal(content []byte) (Proposal, error) {
	value, err := jsonx.Decode[Proposal](content)
	if err != nil {
		return Proposal{}, err
	}
	if err := value.Validate(); err != nil {
		return Proposal{}, err
	}
	return value, nil
}

// DecodeDecision strictly parses a human Risk Decision.
func DecodeDecision(content []byte) (Decision, error) {
	value, err := jsonx.Decode[Decision](content)
	if err != nil {
		return Decision{}, err
	}
	if err := value.Validate(); err != nil {
		return Decision{}, err
	}
	return value, nil
}

// DecodeRegister strictly parses an immutable Register.
func DecodeRegister(content []byte) (Register, error) {
	value, err := jsonx.Decode[Register](content)
	if err != nil {
		return Register{}, err
	}
	if err := value.Validate(); err != nil {
		return Register{}, err
	}
	return value, nil
}

// DecodeCurrent strictly parses the Current pointer.
func DecodeCurrent(content []byte) (Current, error) {
	value, err := jsonx.Decode[Current](content)
	if err != nil {
		return Current{}, err
	}
	if err := value.Validate(); err != nil {
		return Current{}, err
	}
	return value, nil
}

// Validate enforces a Risk seed.
func (value Seed) Validate() error {
	if !stableID.MatchString(value.RiskID) {
		return fmt.Errorf("risk_id must be a stable lowercase identifier")
	}
	if !severityValid(value.Severity) {
		return fmt.Errorf("severity is invalid")
	}
	if err := oneLine(value.Statement, "statement"); err != nil {
		return err
	}
	if value.EvidenceRefs == nil {
		return fmt.Errorf("evidence_refs must be an array")
	}
	return validateReferences(value.EvidenceRefs)
}

// Validate enforces a complete immutable Register.
func (value Register) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "intent-risk-register" || value.Version != 1 {
		return fmt.Errorf("Intent Risk Register has an invalid schema identity")
	}
	if err := oneLine(value.IntentID, "intent_id"); err != nil {
		return err
	}
	if value.Revision < 1 {
		return fmt.Errorf("revision must be a positive integer")
	}
	if (value.Revision == 1 && value.BaseRevision != nil) || (value.Revision > 1 && (value.BaseRevision == nil || *value.BaseRevision != value.Revision-1)) {
		return fmt.Errorf("base_revision must be null for revision 1 or the previous revision")
	}
	if value.Risks == nil {
		return fmt.Errorf("risks must be an array")
	}
	seen := make(map[string]struct{}, len(value.Risks))
	for index, entry := range value.Risks {
		if err := entry.Validate(); err != nil {
			return fmt.Errorf("risks[%d]: %w", index, err)
		}
		if _, exists := seen[entry.RiskID]; exists {
			return fmt.Errorf("risks contains duplicate risk_id: %s", entry.RiskID)
		}
		seen[entry.RiskID] = struct{}{}
	}
	return timestamp(value.CreatedAt, "created_at")
}

// Validate enforces one Risk entry.
func (value Entry) Validate() error {
	seed := Seed{RiskID: value.RiskID, Severity: value.Severity, Statement: value.Statement, EvidenceRefs: value.EvidenceRefs}
	if err := seed.Validate(); err != nil {
		return err
	}
	if value.Status != Active && value.Status != Resolved && value.Status != Dismissed {
		return fmt.Errorf("status is invalid")
	}
	if value.LastDecisionRef != nil {
		return value.LastDecisionRef.Validate()
	}
	return nil
}

// Validate enforces the Current pointer.
func (value Current) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "intent-risk-current" || value.Version != 1 {
		return fmt.Errorf("Intent Risk Current has an invalid schema identity")
	}
	if err := oneLine(value.IntentID, "intent_id"); err != nil {
		return err
	}
	if value.CurrentRevision < 1 {
		return fmt.Errorf("current_revision must be a positive integer")
	}
	if err := value.RegisterRef.Validate(); err != nil {
		return err
	}
	return timestamp(value.UpdatedAt, "updated_at")
}

// Validate enforces an untrusted Proposal.
func (value Proposal) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "intent-risk-proposal" || value.Version != 1 {
		return fmt.Errorf("Intent Risk Proposal has an invalid schema identity")
	}
	if !stableID.MatchString(value.ProposalID) {
		return fmt.Errorf("proposal_id must be a stable lowercase identifier")
	}
	if err := oneLine(value.IntentID, "intent_id"); err != nil {
		return err
	}
	if value.BaseRevision < 1 {
		return fmt.Errorf("base_revision must be a positive integer")
	}
	if len(value.Risks) == 0 {
		return fmt.Errorf("risks must contain at least 1 item")
	}
	seen := make(map[string]struct{}, len(value.Risks))
	for index, risk := range value.Risks {
		if err := risk.Validate(); err != nil {
			return fmt.Errorf("risks[%d]: %w", index, err)
		}
		if _, ok := seen[risk.RiskID]; ok {
			return fmt.Errorf("risks contains duplicate risk_id: %s", risk.RiskID)
		}
		seen[risk.RiskID] = struct{}{}
	}
	if err := oneLine(value.Reason, "reason"); err != nil {
		return err
	}
	if value.ProposedBy != "ai" && value.ProposedBy != "human" {
		return fmt.Errorf("proposed_by must be ai or human")
	}
	return timestamp(value.ProposedAt, "proposed_at")
}

// Validate enforces human-only Decision authority.
func (value Decision) Validate() error {
	if value.SchemaVersion != 1 || value.Artifact != "intent-risk-decision" || value.Version != 1 {
		return fmt.Errorf("Intent Risk Decision has an invalid schema identity")
	}
	if !stableID.MatchString(value.DecisionID) || !stableID.MatchString(value.RiskID) {
		return fmt.Errorf("decision_id and risk_id must be stable lowercase identifiers")
	}
	if err := oneLine(value.IntentID, "intent_id"); err != nil {
		return err
	}
	if value.Action != Dismiss && value.Action != Resolve && value.Action != SetSeverity {
		return fmt.Errorf("action is invalid")
	}
	if (value.Action == SetSeverity) != (value.Severity != nil) {
		return fmt.Errorf("set-severity requires severity and other actions require null severity")
	}
	if value.Severity != nil && !severityValid(*value.Severity) {
		return fmt.Errorf("severity is invalid")
	}
	if value.EvidenceRefs == nil {
		return fmt.Errorf("evidence_refs must be an array")
	}
	if err := validateReferences(value.EvidenceRefs); err != nil {
		return err
	}
	if err := value.HumanInputReceiptRef.Validate(); err != nil {
		return fmt.Errorf("human_input_receipt_ref: %w", err)
	}
	if value.Action == Resolve && len(value.EvidenceRefs) == 0 {
		return fmt.Errorf("evidence_refs resolve requires Evidence")
	}
	if err := oneLine(value.Reason, "reason"); err != nil {
		return err
	}
	if value.DecidedBy != "human" {
		return fmt.Errorf("decided_by must equal human")
	}
	return timestamp(value.DecidedAt, "decided_at")
}

// RootDir returns the Risk artifact root.
func RootDir(recordDir string) string     { return filepath.Join(recordDir, "artifacts", "risks") }
func CurrentPath(recordDir string) string { return filepath.Join(RootDir(recordDir), "current.json") }
func RevisionPath(recordDir string, revision int) string {
	return filepath.Join(RootDir(recordDir), "revisions", fmt.Sprintf("%06d", revision), "intent-risk-register.json")
}
func ProposalPath(recordDir, proposalID string) string {
	return filepath.Join(RootDir(recordDir), "proposals", proposalID, "proposal.json")
}
func DecisionPath(recordDir, decisionID string) string {
	return filepath.Join(RootDir(recordDir), "decisions", decisionID, "decision.json")
}

// Initialize creates revision one or returns a validated existing Register.
func Initialize(ctx context.Context, projectDir, recordDir, intentID string, options Options) (Written, error) {
	var written Written
	err := lock.With(ctx, projectDir, lock.Options{}, func(lockContext context.Context) error {
		currentPath, err := safePath(projectDir, CurrentPath(recordDir), true)
		if err != nil {
			return err
		}
		if _, err := os.Stat(currentPath); err == nil {
			register, reference, current, err := ReadCurrent(projectDir, recordDir)
			if err != nil {
				return err
			}
			if register.IntentID != intentID {
				return fmt.Errorf("Intent Risk existing Register belongs to another Intent")
			}
			currentContent, err := os.ReadFile(currentPath)
			if err != nil {
				return err
			}
			written = Written{Register: register, RegisterReference: reference, Current: current, CurrentReference: makeReference(projectDir, CurrentPath(recordDir), "intent-risk-current", currentContent)}
			return nil
		} else if !os.IsNotExist(err) {
			return err
		}
		entries := make([]Entry, 0, len(options.Risks))
		for _, seed := range options.Risks {
			if err := seed.Validate(); err != nil {
				return err
			}
			entries = append(entries, Entry{RiskID: seed.RiskID, Severity: seed.Severity, Statement: seed.Statement, Status: Active, EvidenceRefs: seed.EvidenceRefs})
		}
		createdAt := options.CreatedAt
		if createdAt == "" {
			createdAt = isoMilliseconds(time.Now())
		}
		register := Register{SchemaVersion: 1, Artifact: "intent-risk-register", Version: 1, IntentID: intentID, Revision: 1, Risks: entries, CreatedAt: createdAt}
		if err := register.Validate(); err != nil {
			return err
		}
		if err := verifyReferences(projectDir, flattenEntryReferences(entries)); err != nil {
			return err
		}
		written, err = writeRevision(projectDir, recordDir, register)
		return err
	})
	return written, err
}

// ReadCurrent validates the Current pointer, Register binding, and references.
func ReadCurrent(projectDir, recordDir string) (Register, contract.ArtifactReference, Current, error) {
	currentPath, err := safePath(projectDir, CurrentPath(recordDir), false)
	if err != nil {
		return Register{}, contract.ArtifactReference{}, Current{}, err
	}
	currentContent, err := os.ReadFile(currentPath)
	if err != nil {
		return Register{}, contract.ArtifactReference{}, Current{}, fmt.Errorf("Intent Risk missing Current pointer: %w", err)
	}
	current, err := DecodeCurrent(currentContent)
	if err != nil {
		return Register{}, contract.ArtifactReference{}, Current{}, err
	}
	if current.RegisterRef.Artifact != "intent-risk-register" {
		return Register{}, contract.ArtifactReference{}, Current{}, fmt.Errorf("Intent Risk Current pointer must reference intent-risk-register")
	}
	path, err := policy.VerifyProjectArtifactReference(projectDir, current.RegisterRef)
	if err != nil {
		return Register{}, contract.ArtifactReference{}, Current{}, err
	}
	registerContent, err := os.ReadFile(path)
	if err != nil {
		return Register{}, contract.ArtifactReference{}, Current{}, err
	}
	register, err := DecodeRegister(registerContent)
	if err != nil {
		return Register{}, contract.ArtifactReference{}, Current{}, err
	}
	if register.IntentID != current.IntentID || register.Revision != current.CurrentRevision {
		return Register{}, contract.ArtifactReference{}, Current{}, fmt.Errorf("Intent Risk Current pointer does not match the immutable Register")
	}
	if err := verifyReferences(projectDir, flattenEntryReferences(register.Risks)); err != nil {
		return Register{}, contract.ArtifactReference{}, Current{}, err
	}
	return register, current.RegisterRef, current, nil
}

// Propose applies additions or non-decreasing severity updates.
func Propose(ctx context.Context, projectDir, recordDir string, proposal Proposal, createdAt string) (Register, error) {
	var result Register
	err := lock.With(ctx, projectDir, lock.Options{}, func(lockContext context.Context) error {
		if err := proposal.Validate(); err != nil {
			return err
		}
		current, _, _, err := ReadCurrent(projectDir, recordDir)
		if err != nil {
			return err
		}
		if proposal.IntentID != current.IntentID {
			return fmt.Errorf("Intent Risk Proposal belongs to another Intent")
		}
		if proposal.BaseRevision != current.Revision {
			return fmt.Errorf("Intent Risk Proposal base_revision %d is stale; current is %d", proposal.BaseRevision, current.Revision)
		}
		var references []contract.ArtifactReference
		for _, item := range proposal.Risks {
			references = append(references, item.EvidenceRefs...)
		}
		if err := verifyReferences(projectDir, references); err != nil {
			return err
		}
		risks := append([]Entry(nil), current.Risks...)
		for _, proposed := range proposal.Risks {
			index := findRisk(risks, proposed.RiskID)
			if index < 0 {
				risks = append(risks, Entry{RiskID: proposed.RiskID, Severity: proposed.Severity, Statement: proposed.Statement, Status: Active, EvidenceRefs: proposed.EvidenceRefs})
				continue
			}
			existing := risks[index]
			if existing.Status != Active {
				return fmt.Errorf("Intent Risk AI proposal cannot reactivate %s", existing.RiskID)
			}
			if severityRank(proposed.Severity) < severityRank(existing.Severity) {
				return fmt.Errorf("Intent Risk AI proposal cannot reduce severity for %s", existing.RiskID)
			}
			existing.Severity, existing.Statement, existing.EvidenceRefs = proposed.Severity, proposed.Statement, proposed.EvidenceRefs
			risks[index] = existing
		}
		proposalContent, _ := jsonx.MarshalCanonical(proposal)
		if err := writeImmutable(projectDir, ProposalPath(recordDir, proposal.ProposalID), proposalContent); err != nil {
			return err
		}
		base := current.Revision
		timestamp := createdAt
		if timestamp == "" {
			timestamp = proposal.ProposedAt
		}
		next := Register{SchemaVersion: 1, Artifact: "intent-risk-register", Version: 1, IntentID: current.IntentID, Revision: base + 1, BaseRevision: &base, Risks: risks, CreatedAt: timestamp}
		written, err := writeRevision(projectDir, recordDir, next)
		if err != nil {
			return err
		}
		result = written.Register
		return nil
	})
	return result, err
}

// Decide applies one human-only mutation.
func Decide(ctx context.Context, projectDir, recordDir string, proof humanapproval.Proof) (DecideResult, error) {
	var result DecideResult
	err := lock.With(ctx, projectDir, lock.Options{}, func(lockContext context.Context) error {
		current, currentRef, _, err := ReadCurrent(projectDir, recordDir)
		if err != nil {
			return err
		}
		if err := proof.Require(humanapproval.ScopeRisk, proof.Action(), currentRef.SHA256); err != nil {
			return fmt.Errorf("Intent Risk Decision: %w", err)
		}
		var parameters DecisionParameters
		if err := proof.Parameters(&parameters); err != nil {
			return fmt.Errorf("Intent Risk Decision parameters: %w", err)
		}
		decision := Decision{
			SchemaVersion: 1, Artifact: "intent-risk-decision", Version: 1,
			DecisionID: parameters.DecisionID, IntentID: current.IntentID,
			RiskID: parameters.RiskID, Action: DecisionAction(proof.Action()), Severity: parameters.Severity,
			EvidenceRefs: parameters.EvidenceRefs, HumanInputReceiptRef: proof.ReceiptReference(),
			Reason: proof.Reason(), DecidedBy: "human", DecidedAt: proof.Receipt().ObservedAt,
		}
		if err := decision.Validate(); err != nil {
			return err
		}
		if decision.IntentID != current.IntentID {
			return fmt.Errorf("Intent Risk Decision belongs to another Intent")
		}
		if err := verifyReferences(projectDir, decision.EvidenceRefs); err != nil {
			return err
		}
		index := findRisk(current.Risks, decision.RiskID)
		if index < 0 {
			return fmt.Errorf("Intent Risk unknown risk_id: %s", decision.RiskID)
		}
		content, _ := jsonx.MarshalCanonical(decision)
		path := DecisionPath(recordDir, decision.DecisionID)
		if err := writeImmutable(projectDir, path, content); err != nil {
			return err
		}
		decisionRef := makeReference(projectDir, path, "intent-risk-decision", content)
		risks := append([]Entry(nil), current.Risks...)
		entry := risks[index]
		if decision.Severity != nil {
			entry.Severity = *decision.Severity
		}
		switch decision.Action {
		case Dismiss:
			entry.Status = Dismissed
		case Resolve:
			entry.Status = Resolved
		default:
			entry.Status = Active
		}
		if len(decision.EvidenceRefs) > 0 {
			entry.EvidenceRefs = decision.EvidenceRefs
		}
		entry.LastDecisionRef = &decisionRef
		risks[index] = entry
		base := current.Revision
		timestamp := decision.DecidedAt
		next := Register{SchemaVersion: 1, Artifact: "intent-risk-register", Version: 1, IntentID: current.IntentID, Revision: base + 1, BaseRevision: &base, Risks: risks, CreatedAt: timestamp}
		written, err := writeRevision(projectDir, recordDir, next)
		if err != nil {
			return err
		}
		resolution, resolutionRef, err := humanapproval.Resolve(lockContext, projectDir, recordDir, proof, &decisionRef, "recorded", timestamp)
		if err != nil {
			return err
		}
		result = DecideResult{Register: written.Register, Decision: decision, DecisionReference: decisionRef, HumanGateResolution: resolution, HumanGateResolutionRef: resolutionRef}
		return nil
	})
	return result, err
}

// ValidateArtifacts checks canonical contiguous revisions and Current binding.
func ValidateArtifacts(projectDir, recordDir, expectedIntentID string) error {
	currentPath, err := safePath(projectDir, CurrentPath(recordDir), false)
	if err != nil {
		return err
	}
	currentContent, err := os.ReadFile(currentPath)
	if err != nil {
		return fmt.Errorf("Intent Risk Register Current is missing")
	}
	current, err := DecodeCurrent(currentContent)
	if err != nil {
		return err
	}
	canonical, _ := jsonx.MarshalCanonical(current)
	if string(canonical) != string(currentContent) {
		return fmt.Errorf("Intent Risk Register Current is not canonical")
	}
	if expectedIntentID != "" && current.IntentID != expectedIntentID {
		return fmt.Errorf("Intent Risk Register belongs to another Intent")
	}
	revisionsRoot := filepath.Join(RootDir(recordDir), "revisions")
	entries, err := os.ReadDir(revisionsRoot)
	if err != nil {
		return err
	}
	var names []string
	for _, entry := range entries {
		if matched, _ := regexp.MatchString(`^\d{6}$`, entry.Name()); matched && entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) != current.CurrentRevision {
		return fmt.Errorf("Intent Risk Register revisions must be contiguous and immutable")
	}
	latestDigest := ""
	for revision := 1; revision <= current.CurrentRevision; revision++ {
		expected := fmt.Sprintf("%06d", revision)
		if names[revision-1] != expected {
			return fmt.Errorf("Intent Risk Register revisions must be contiguous and immutable")
		}
		revisionPath, err := safePath(projectDir, RevisionPath(recordDir, revision), false)
		if err != nil {
			return err
		}
		content, err := os.ReadFile(revisionPath)
		if err != nil {
			return err
		}
		register, err := DecodeRegister(content)
		if err != nil {
			return err
		}
		serialized, _ := jsonx.MarshalCanonical(register)
		if string(serialized) != string(content) {
			return fmt.Errorf("Intent Risk Register revision %d is not canonical", revision)
		}
		if register.IntentID != current.IntentID || register.Revision != revision {
			return fmt.Errorf("Intent Risk Register revision %d has an invalid Intent or revision binding", revision)
		}
		if err := verifyReferences(projectDir, flattenEntryReferences(register.Risks)); err != nil {
			return err
		}
		if err := verifyDecisionReceipts(projectDir, register.Risks); err != nil {
			return err
		}
		if revision == current.CurrentRevision {
			latestDigest = digest.Bytes(content)
		}
	}
	if _, err = policy.VerifyProjectArtifactReference(projectDir, current.RegisterRef); err != nil {
		return err
	}
	if current.RegisterRef.SHA256 != latestDigest {
		return fmt.Errorf("Intent Risk Current does not pin the latest immutable revision")
	}
	return nil
}

func writeRevision(projectDir, recordDir string, register Register) (Written, error) {
	if err := register.Validate(); err != nil {
		return Written{}, err
	}
	content, _ := jsonx.MarshalCanonical(register)
	path := RevisionPath(recordDir, register.Revision)
	if err := writeImmutable(projectDir, path, content); err != nil {
		return Written{}, err
	}
	registerRef := makeReference(projectDir, path, "intent-risk-register", content)
	current := Current{SchemaVersion: 1, Artifact: "intent-risk-current", Version: 1, IntentID: register.IntentID, CurrentRevision: register.Revision, RegisterRef: registerRef, UpdatedAt: register.CreatedAt}
	if err := current.Validate(); err != nil {
		return Written{}, err
	}
	currentContent, _ := jsonx.MarshalCanonical(current)
	currentPath := CurrentPath(recordDir)
	if err := ensureParentUnderProject(projectDir, currentPath); err != nil {
		return Written{}, err
	}
	if _, err := safePath(projectDir, currentPath, true); err != nil {
		return Written{}, err
	}
	if err := fsx.AtomicWriteFile(currentPath, currentContent, 0o644); err != nil {
		return Written{}, err
	}
	return Written{Register: register, RegisterReference: registerRef, Current: current, CurrentReference: makeReference(projectDir, currentPath, "intent-risk-current", currentContent)}, nil
}

func writeImmutable(projectDir, path string, content []byte) error {
	if _, err := safePath(projectDir, path, true); err != nil {
		return err
	}
	existing, err := os.ReadFile(path)
	if err == nil {
		if string(existing) != string(content) {
			return fmt.Errorf("Intent Risk immutable artifact already has different content: %s", path)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	if err := ensureParentUnderProject(projectDir, path); err != nil {
		return err
	}
	return fsx.AtomicWriteFile(path, content, 0o644)
}

func ensureParentUnderProject(projectDir, target string) error {
	root, err := filepath.Abs(projectDir)
	if err != nil {
		return err
	}
	parent := filepath.Dir(target)
	relative, err := filepath.Rel(root, parent)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("Intent Risk path is outside the Project: %s", target)
	}
	_, err = fsx.EnsureDirUnder(root, filepath.ToSlash(relative), 0o755)
	return err
}

func safePath(projectDir, target string, allowMissing bool) (string, error) {
	root, err := filepath.Abs(projectDir)
	if err != nil {
		return "", err
	}
	absolute, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, absolute)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("Intent Risk path is outside the Project: %s", target)
	}
	resolved, err := fsx.ResolveUnder(root, filepath.ToSlash(relative), allowMissing)
	if err != nil {
		return "", fmt.Errorf("Intent Risk path: %w", err)
	}
	return resolved, nil
}

func makeReference(projectDir, path, artifact string, content []byte) contract.ArtifactReference {
	root, _ := filepath.Abs(projectDir)
	absolute, _ := filepath.Abs(path)
	relative, _ := filepath.Rel(root, absolute)
	return contract.ArtifactReference{Artifact: artifact, Version: 1, SourceOfTruth: filepath.ToSlash(relative), SHA256: digest.Bytes(content)}
}

func verifyReferences(projectDir string, references []contract.ArtifactReference) error {
	for _, reference := range references {
		if _, err := policy.VerifyProjectArtifactReference(projectDir, reference); err != nil {
			return err
		}
	}
	return nil
}

func verifyDecisionReceipts(projectDir string, entries []Entry) error {
	for _, entry := range entries {
		if entry.LastDecisionRef == nil {
			continue
		}
		path, err := policy.VerifyProjectArtifactReference(projectDir, *entry.LastDecisionRef)
		if err != nil {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		decision, err := DecodeDecision(content)
		if err != nil {
			return err
		}
		if decision.IntentID == "" || decision.RiskID != entry.RiskID || string(decision.Action) == "" {
			return fmt.Errorf("Intent Risk Decision does not bind its Register entry")
		}
		receipt, err := humanapproval.VerifyReceipt(projectDir, decision.HumanInputReceiptRef)
		if err != nil {
			return fmt.Errorf("Intent Risk Decision Human Input Receipt: %w", err)
		}
		if receipt.IntentID != decision.IntentID || receipt.Scope != humanapproval.ScopeRisk || receipt.Action != string(decision.Action) {
			return fmt.Errorf("Intent Risk Decision does not bind the same Human action as its Receipt")
		}
	}
	return nil
}
func validateReferences(references []contract.ArtifactReference) error {
	for _, reference := range references {
		if err := reference.Validate(); err != nil {
			return err
		}
	}
	return nil
}
func flattenEntryReferences(entries []Entry) []contract.ArtifactReference {
	var result []contract.ArtifactReference
	for _, entry := range entries {
		result = append(result, entry.EvidenceRefs...)
		if entry.LastDecisionRef != nil {
			result = append(result, *entry.LastDecisionRef)
		}
	}
	return result
}
func findRisk(entries []Entry, riskID string) int {
	for index, entry := range entries {
		if entry.RiskID == riskID {
			return index
		}
	}
	return -1
}
func severityValid(value policy.Severity) bool {
	return value == policy.Low || value == policy.Medium || value == policy.High || value == policy.Critical
}
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
	}
	return -1
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
func isoMilliseconds(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
