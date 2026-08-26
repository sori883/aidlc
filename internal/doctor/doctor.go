// Package doctor provides read-only vNext diagnostics and limited repair.
package doctor

import (
	"context"
	"fmt"
	"os"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/workflow/catalog"
	"github.com/sori883/aidlc/internal/workflow/state"
)

// Severity classifies one finding.
type Severity string

const (
	Error   Severity = "error"
	Warning Severity = "warning"
	Info    Severity = "info"
)

// Finding is one stable diagnostic result.
type Finding struct {
	Severity   Severity `json:"severity"`
	Code       string   `json:"code"`
	Message    string   `json:"message"`
	Repairable bool     `json:"repairable"`
}

// Report is the complete vNext diagnostic result.
type Report struct {
	Healthy  bool      `json:"healthy"`
	Workflow string    `json:"workflow"`
	Findings []Finding `json:"findings"`
}

// Check validates definitions, active State, Summary, Risk, Policy, and Audit.
func Check(projectDir, coreDir string) Report {
	report := Report{Workflow: "vnext", Findings: []Finding{}}
	definitions, err := catalog.Load(coreDir)
	if err != nil {
		report.Findings = append(report.Findings, finding(Error, "VNEXT_DEFINITIONS_INVALID", err.Error(), false))
	} else {
		report.Findings = append(report.Findings, finding(Info, "VNEXT_DEFINITIONS_VALID", fmt.Sprintf("Fixed Catalog %s and Graph %s are valid.", definitions.Catalog.CatalogVersion, definitions.Graph.GraphVersion), false))
	}
	inspection, err := state.InspectActive(projectDir)
	if err != nil {
		report.Findings = append(report.Findings, finding(Error, "VNEXT_ACTIVE_INTENT_INVALID", err.Error(), false))
		return finish(report)
	}
	if inspection.Kind == state.InspectionUnsupported {
		message := fmt.Sprintf("unsupported pre-vNext Workflow State in Intent %s; automatic conversion is disabled; run aidlc intent birth to start a new vNext Intent", inspection.Selected)
		report.Findings = append(report.Findings, finding(Error, "VNEXT_UNSUPPORTED_WORKFLOW_STATE", message, false))
		return finish(report)
	}
	if inspection.Kind == state.InspectionIncomplete {
		report.Findings = append(report.Findings, finding(Error, "VNEXT_ACTIVE_INTENT_INVALID", fmt.Sprintf("active Intent is not initialized for vNext: %s", inspection.Selected), false))
		return finish(report)
	}
	if err := state.Validate(projectDir, inspection.RecordDir); err != nil {
		report.Findings = append(report.Findings, finding(Error, "VNEXT_CORE_STATE_INVALID", err.Error(), false))
	} else {
		report.Findings = append(report.Findings, finding(Info, "VNEXT_CORE_STATE_VALID", "Core State, Stage Execution Plan, Effective Policy, and Intent Risk Register agree.", false))
	}
	snapshot, readErr := state.Read(inspection.RecordDir)
	if readErr == nil {
		expected, renderErr := state.RenderSummary(snapshot.State, snapshot.Plan)
		actual, summaryErr := os.ReadFile(state.SummaryPath(inspection.RecordDir))
		if renderErr != nil || summaryErr != nil {
			report.Findings = append(report.Findings, finding(Warning, "VNEXT_STATE_SUMMARY_MISSING", "The human-readable State summary is missing or unreadable.", true))
		} else if string(actual) != expected {
			report.Findings = append(report.Findings, finding(Warning, "VNEXT_STATE_SUMMARY_STALE", "The human-readable State summary does not match Core State.", true))
		}
	}
	entries, auditErr := audit.ReadOrdered(inspection.RecordDir)
	if auditErr != nil || len(entries) == 0 {
		report.Findings = append(report.Findings, finding(Error, "VNEXT_AUDIT_MISSING", "The Core Audit log is missing.", false))
	}
	return finish(report)
}

// Repair regenerates only the non-authoritative State summary.
func Repair(ctx context.Context, projectDir, coreDir string) (Report, error) {
	inspection, err := state.InspectActive(projectDir)
	if err != nil {
		return Report{}, err
	}
	if inspection.Kind != state.InspectionVNext {
		return Report{}, fmt.Errorf("Doctor repair requires an initialized vNext Intent")
	}
	if err := state.RepairSummary(ctx, projectDir, inspection.RecordDir); err != nil {
		return Report{}, err
	}
	if _, err := audit.Append(ctx, projectDir, inspection.RecordDir, audit.DoctorRepaired, []audit.Field{{Name: "Repair", Value: "Regenerated human-readable State summary"}}, nil); err != nil {
		return Report{}, err
	}
	return Check(projectDir, coreDir), nil
}

func finding(severity Severity, code, message string, repairable bool) Finding {
	return Finding{Severity: severity, Code: code, Message: message, Repairable: repairable}
}

func finish(report Report) Report {
	report.Healthy = true
	for _, item := range report.Findings {
		if item.Severity == Error {
			report.Healthy = false
			break
		}
	}
	return report
}
