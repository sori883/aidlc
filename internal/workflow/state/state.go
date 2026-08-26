// Package state owns vNext Workflow State and Stage Execution Plan persistence.
package state

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/workflow/policy"
	"github.com/sori883/aidlc/internal/workflow/risk"
	"github.com/sori883/aidlc/internal/workspace"
)

// Status is the persisted Core workflow lifecycle.
type Status string

const (
	Parked    Status = "parked"
	Ready     Status = "ready"
	Completed Status = "completed"
)

// IntentState is the authoritative Core-owned workflow cursor.
type IntentState struct {
	SchemaVersion  int                        `json:"schema_version"`
	Workflow       string                     `json:"workflow"`
	IntentID       string                     `json:"intent_id"`
	CatalogVersion string                     `json:"catalog_version"`
	GraphVersion   string                     `json:"graph_version"`
	PlanRevision   int                        `json:"plan_revision"`
	PolicySnapshot contract.ArtifactReference `json:"policy_snapshot"`
	CurrentStage   contract.StageID           `json:"current_stage"`
	Status         Status                     `json:"status"`
	ParkedReason   *string                    `json:"parked_reason,omitempty"`
	NotBefore      *string                    `json:"not_before,omitempty"`
	Deadline       *string                    `json:"deadline,omitempty"`
	CreatedAt      string                     `json:"created_at"`
	UpdatedAt      string                     `json:"updated_at"`
}

// Snapshot binds an authoritative State and Plan loaded from disk.
type Snapshot struct {
	RecordDir string
	State     IntentState
	Plan      contract.StageExecutionPlan
}

// InitializeOptions supplies immutable workflow definitions and a clock.
type InitializeOptions struct {
	IntentID       string
	CatalogVersion string
	GraphVersion   string
	PolicySnapshot contract.ArtifactReference
	Plan           contract.StageExecutionPlan
	CreatedAt      string
}

// InspectionKind classifies an active Intent without converting old data.
type InspectionKind string

const (
	InspectionVNext       InspectionKind = "vnext"
	InspectionUnsupported InspectionKind = "unsupported"
	InspectionIncomplete  InspectionKind = "incomplete"
)

// Inspection describes the selected Intent's workflow state.
type Inspection struct {
	Kind      InspectionKind
	RecordDir string
	Selected  string
}

// StatePath returns the authoritative State path.
func StatePath(recordDir string) string { return filepath.Join(recordDir, "aidlc-state.json") }

// SummaryPath returns the human-readable mirror path.
func SummaryPath(recordDir string) string { return filepath.Join(recordDir, "aidlc-state.md") }

// PlanPath returns the authoritative Stage Execution Plan path.
func PlanPath(recordDir string) string { return filepath.Join(recordDir, "stage-execution-plan.json") }

// Decode strictly parses an Intent State.
func Decode(content []byte) (IntentState, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(content, &fields); err != nil {
		return IntentState{}, err
	}
	for _, name := range []string{"parked_reason", "not_before", "deadline"} {
		if raw, exists := fields[name]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return IntentState{}, fmt.Errorf("vNext Intent State.%s must not be null", name)
		}
	}
	value, err := jsonx.Decode[IntentState](content)
	if err != nil {
		return IntentState{}, err
	}
	if err := value.Validate(); err != nil {
		return IntentState{}, err
	}
	return value, nil
}

// Validate enforces state lifecycle and observation schedule invariants.
func (value IntentState) Validate() error {
	if value.SchemaVersion != 1 || value.Workflow != "vnext" {
		return fmt.Errorf("vNext Intent State has an invalid schema identity")
	}
	for field, text := range map[string]string{
		"intent_id":       value.IntentID,
		"catalog_version": value.CatalogVersion,
		"graph_version":   value.GraphVersion,
	} {
		if err := oneLine(text, field); err != nil {
			return err
		}
	}
	if value.PlanRevision < 1 {
		return fmt.Errorf("plan_revision must be a positive integer")
	}
	if err := value.PolicySnapshot.Validate(); err != nil {
		return fmt.Errorf("policy_snapshot: %w", err)
	}
	if !value.CurrentStage.Valid() {
		return fmt.Errorf("current_stage is invalid: %s", value.CurrentStage)
	}
	if value.Status != Parked && value.Status != Ready && value.Status != Completed {
		return fmt.Errorf("status must be parked, ready, or completed")
	}
	if value.Status == Parked && value.ParkedReason == nil {
		return fmt.Errorf("parked_reason is required while status is parked")
	}
	if value.Status != Parked && value.ParkedReason != nil {
		return fmt.Errorf("parked_reason is allowed only while status is parked")
	}
	if value.ParkedReason != nil {
		if err := oneLine(*value.ParkedReason, "parked_reason"); err != nil {
			return err
		}
	}
	if value.Status != Parked && (value.NotBefore != nil || value.Deadline != nil) {
		return fmt.Errorf("observation schedule is allowed only while status is parked")
	}
	if value.Deadline != nil && value.NotBefore == nil {
		return fmt.Errorf("not_before is required when deadline is present")
	}
	var notBefore time.Time
	if value.NotBefore != nil {
		parsed, err := parseTimestamp(*value.NotBefore, "not_before")
		if err != nil {
			return err
		}
		notBefore = parsed
	}
	if value.Deadline != nil {
		deadline, err := parseTimestamp(*value.Deadline, "deadline")
		if err != nil {
			return err
		}
		if !deadline.After(notBefore) {
			return fmt.Errorf("deadline must be after not_before")
		}
	}
	if _, err := parseTimestamp(value.CreatedAt, "created_at"); err != nil {
		return err
	}
	_, err := parseTimestamp(value.UpdatedAt, "updated_at")
	return err
}

// Initialize persists the initial parked ST-00 cursor and safe Plan.
func Initialize(ctx context.Context, projectDir, recordDir string, options InitializeOptions) (Snapshot, error) {
	var result Snapshot
	err := lock.With(ctx, projectDir, lock.Options{}, func(context.Context) error {
		if _, err := os.Lstat(StatePath(recordDir)); err == nil {
			return fmt.Errorf("vNext State: Core-owned State already exists")
		} else if !os.IsNotExist(err) {
			return err
		}
		if _, err := os.Lstat(PlanPath(recordDir)); err == nil {
			return fmt.Errorf("vNext State: Core-owned Plan already exists")
		} else if !os.IsNotExist(err) {
			return err
		}
		if _, err := policy.VerifyProjectArtifactReference(projectDir, options.PolicySnapshot); err != nil {
			return err
		}
		if err := options.Plan.Validate(); err != nil {
			return err
		}
		if options.Plan.IntentID != options.IntentID || options.Plan.GraphVersion != options.GraphVersion || options.Plan.PolicySnapshot != options.PolicySnapshot {
			return fmt.Errorf("vNext State: initial State does not match Plan")
		}
		createdAt := options.CreatedAt
		if createdAt == "" {
			createdAt = isoMilliseconds(time.Now())
		}
		reason := "ST-00 is ready for Core Bootstrap execution."
		value := IntentState{
			SchemaVersion: 1, Workflow: "vnext", IntentID: options.IntentID,
			CatalogVersion: options.CatalogVersion, GraphVersion: options.GraphVersion,
			PlanRevision: options.Plan.Revision, PolicySnapshot: options.PolicySnapshot,
			CurrentStage: contract.Stage00, Status: Parked, ParkedReason: &reason,
			CreatedAt: createdAt, UpdatedAt: createdAt,
		}
		if err := writeUnlocked(projectDir, recordDir, value, options.Plan); err != nil {
			return err
		}
		result = Snapshot{RecordDir: recordDir, State: value, Plan: options.Plan}
		return nil
	})
	return result, err
}

// Store validates and atomically replaces each Core-owned file while holding
// the Workspace lock. Callers must supply a complete State and Plan pair.
func Store(ctx context.Context, projectDir, recordDir string, value IntentState, executionPlan contract.StageExecutionPlan) error {
	return lock.With(ctx, projectDir, lock.Options{}, func(context.Context) error {
		if _, err := Read(recordDir); err != nil {
			return err
		}
		return writeUnlocked(projectDir, recordDir, value, executionPlan)
	})
}

// RepairSummary regenerates only the non-authoritative Markdown mirror.
func RepairSummary(ctx context.Context, projectDir, recordDir string) error {
	return lock.With(ctx, projectDir, lock.Options{}, func(context.Context) error {
		snapshot, err := Read(recordDir)
		if err != nil {
			return err
		}
		summary, err := RenderSummary(snapshot.State, snapshot.Plan)
		if err != nil {
			return err
		}
		return fsx.AtomicWriteFile(SummaryPath(recordDir), []byte(summary), 0o644)
	})
}

// Read strictly loads a State and Plan and checks their binding.
func Read(recordDir string) (Snapshot, error) {
	stateContent, err := os.ReadFile(StatePath(recordDir))
	if err != nil {
		return Snapshot{}, fmt.Errorf("vNext State: cannot read %s: %w", StatePath(recordDir), err)
	}
	value, err := Decode(stateContent)
	if err != nil {
		return Snapshot{}, fmt.Errorf("vNext State %s: %w", StatePath(recordDir), err)
	}
	planContent, err := os.ReadFile(PlanPath(recordDir))
	if err != nil {
		return Snapshot{}, fmt.Errorf("Stage Execution Plan: cannot read %s: %w", PlanPath(recordDir), err)
	}
	executionPlan, err := contract.DecodeStageExecutionPlan(planContent)
	if err != nil {
		return Snapshot{}, fmt.Errorf("Stage Execution Plan %s: %w", PlanPath(recordDir), err)
	}
	if err := validateBinding(value, executionPlan); err != nil {
		return Snapshot{}, err
	}
	return Snapshot{RecordDir: recordDir, State: value, Plan: executionPlan}, nil
}

// Validate verifies persisted Core binding, Policy bytes, and Risk chain.
func Validate(projectDir, recordDir string) error {
	snapshot, err := Read(recordDir)
	if err != nil {
		return err
	}
	if _, err := policy.VerifyProjectArtifactReference(projectDir, snapshot.State.PolicySnapshot); err != nil {
		return err
	}
	return risk.ValidateArtifacts(projectDir, recordDir, snapshot.State.IntentID)
}

// InspectActive classifies the active Intent without automatic conversion.
func InspectActive(projectDir string) (Inspection, error) {
	root, err := filepath.Abs(projectDir)
	if err != nil {
		return Inspection{}, err
	}
	selectedSpace := workspace.ActiveSpace(root)
	intentsRoot, err := fsx.ResolveUnder(root, "aidlc/spaces/"+selectedSpace+"/intents", false)
	if err != nil {
		return Inspection{}, fmt.Errorf("vNext State: active Space is invalid: %w", err)
	}
	content, err := os.ReadFile(filepath.Join(intentsRoot, "active-intent"))
	if err != nil {
		return Inspection{}, fmt.Errorf("vNext State: no valid active Intent; run aidlc intent birth first")
	}
	selected := strings.TrimSpace(string(content))
	if selected == "" || strings.ContainsAny(selected, "/\\\x00") {
		return Inspection{}, fmt.Errorf("vNext State: no valid active Intent; run aidlc intent birth first")
	}
	recordDir, err := fsx.ResolveUnder(root, "aidlc/spaces/"+selectedSpace+"/intents/"+selected, false)
	if err != nil {
		return Inspection{}, fmt.Errorf("vNext State: invalid active Intent: %w", err)
	}
	if regularFile(StatePath(recordDir)) {
		return Inspection{Kind: InspectionVNext, RecordDir: recordDir, Selected: selected}, nil
	}
	oldPlan := regularFile(filepath.Join(recordDir, ".aidlc-plan.json"))
	oldSummary := false
	if summary, err := os.ReadFile(SummaryPath(recordDir)); err == nil {
		text := string(summary)
		oldSummary = strings.Contains(text, "## Scope Configuration") || strings.Contains(text, "## Stage Progress")
	}
	if oldPlan || oldSummary {
		return Inspection{Kind: InspectionUnsupported, RecordDir: recordDir, Selected: selected}, nil
	}
	return Inspection{Kind: InspectionIncomplete, RecordDir: recordDir, Selected: selected}, nil
}

// Resume returns the validated active vNext State and Plan.
func Resume(projectDir string) (Snapshot, error) {
	inspection, err := InspectActive(projectDir)
	if err != nil {
		return Snapshot{}, err
	}
	switch inspection.Kind {
	case InspectionUnsupported:
		return Snapshot{}, fmt.Errorf("unsupported pre-vNext Workflow State in Intent %s; automatic conversion is disabled; run aidlc intent birth to start a new vNext Intent", inspection.Selected)
	case InspectionIncomplete:
		return Snapshot{}, fmt.Errorf("vNext State: active Intent is not initialized for vNext: %s", inspection.Selected)
	}
	return Read(inspection.RecordDir)
}

// RenderSummary returns the human-readable non-authoritative State mirror.
func RenderSummary(value IntentState, executionPlan contract.StageExecutionPlan) (string, error) {
	if err := validateBinding(value, executionPlan); err != nil {
		return "", err
	}
	var builder strings.Builder
	builder.WriteString("# AI-DLC vNext State\n\n")
	fmt.Fprintf(&builder, "- Intent: %s\n- Current Stage: %s\n- Status: %s\n- Plan Revision: %d\n- Graph: %s\n", value.IntentID, value.CurrentStage, value.Status, value.PlanRevision, value.GraphVersion)
	if value.ParkedReason != nil {
		fmt.Fprintf(&builder, "- Parked Reason: %s\n", *value.ParkedReason)
	}
	if value.NotBefore != nil {
		fmt.Fprintf(&builder, "- Not Before: %s\n", *value.NotBefore)
	}
	if value.Deadline != nil {
		fmt.Fprintf(&builder, "- Deadline: %s\n", *value.Deadline)
	}
	builder.WriteString("\n## Stage Execution Plan\n\n")
	for _, decision := range executionPlan.StageDecisions {
		marker := "-"
		if decision.StageID == value.CurrentStage {
			marker = ">"
		}
		fmt.Fprintf(&builder, "%s %s: %s\n", marker, decision.StageID, decision.Disposition)
	}
	builder.WriteString("\n> This file is a human-readable mirror. Core-owned JSON files are authoritative.\n")
	return builder.String(), nil
}

func writeUnlocked(projectDir, recordDir string, value IntentState, executionPlan contract.StageExecutionPlan) error {
	if err := validateBinding(value, executionPlan); err != nil {
		return err
	}
	relative, err := filepath.Rel(projectDir, recordDir)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("vNext State record is outside the Project: %s", recordDir)
	}
	if _, err := fsx.EnsureDirUnder(projectDir, filepath.ToSlash(relative), 0o755); err != nil {
		return err
	}
	planContent, err := jsonx.MarshalCanonical(executionPlan)
	if err != nil {
		return err
	}
	stateContent, err := jsonx.MarshalCanonical(value)
	if err != nil {
		return err
	}
	summary, err := RenderSummary(value, executionPlan)
	if err != nil {
		return err
	}
	if err := fsx.AtomicWriteFile(PlanPath(recordDir), planContent, 0o644); err != nil {
		return err
	}
	if err := fsx.AtomicWriteFile(StatePath(recordDir), stateContent, 0o644); err != nil {
		return err
	}
	return fsx.AtomicWriteFile(SummaryPath(recordDir), []byte(summary), 0o644)
}

func validateBinding(value IntentState, executionPlan contract.StageExecutionPlan) error {
	if err := value.Validate(); err != nil {
		return err
	}
	if err := executionPlan.Validate(); err != nil {
		return err
	}
	if value.IntentID != executionPlan.IntentID {
		return fmt.Errorf("vNext State: Intent does not match Plan")
	}
	if value.GraphVersion != executionPlan.GraphVersion {
		return fmt.Errorf("vNext State: Graph does not match Plan")
	}
	if value.PlanRevision != executionPlan.Revision {
		return fmt.Errorf("vNext State: revision does not match Plan")
	}
	if value.PolicySnapshot != executionPlan.PolicySnapshot {
		return fmt.Errorf("vNext State: Effective Policy reference does not match Plan")
	}
	return nil
}

func regularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func oneLine(value, field string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s must be a non-empty single-line string", field)
	}
	return nil
}

func parseTimestamp(value, field string) (time.Time, error) {
	if err := oneLine(value, field); err != nil {
		return time.Time{}, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || !strings.HasSuffix(value, "Z") {
		return time.Time{}, fmt.Errorf("%s must be an ISO-8601 UTC timestamp", field)
	}
	return parsed, nil
}

func isoMilliseconds(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
