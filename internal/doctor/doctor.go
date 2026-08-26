// Package doctor provides read-only vNext diagnostics and limited repair.
package doctor

import (
	"context"
	"fmt"
	"os"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st00bootstrap"
	"github.com/sori883/aidlc/internal/stage/st01orient"
	"github.com/sori883/aidlc/internal/stage/st02defineintent"
	"github.com/sori883/aidlc/internal/stage/st03requirements"
	"github.com/sori883/aidlc/internal/stage/st04architecture"
	"github.com/sori883/aidlc/internal/stage/st05buildcontract"
	"github.com/sori883/aidlc/internal/stage/st06build"
	"github.com/sori883/aidlc/internal/stage/st07review"
	"github.com/sori883/aidlc/internal/stage/st08release"
	"github.com/sori883/aidlc/internal/stage/st09outcome"
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
		if snapshot.State.CurrentStage != contract.Stage00 || snapshot.State.Status == state.Completed {
			if _, _, receiptErr := st00bootstrap.VerifyAt(projectDir, inspection.RecordDir); receiptErr != nil {
				report.Findings = append(report.Findings, finding(Error, "VNEXT_ST00_RECEIPT_INVALID", receiptErr.Error(), false))
			} else {
				report.Findings = append(report.Findings, finding(Info, "VNEXT_ST00_RECEIPT_VALID", "The immutable ST-00 Bootstrap Receipt and Audit binding are valid.", false))
			}
		}
		if stageErr := verifyCompletedStages(projectDir, inspection.RecordDir, snapshot); stageErr != nil {
			report.Findings = append(report.Findings, finding(Error, "VNEXT_STAGE_ARTIFACTS_INVALID", stageErr.Error(), false))
		} else if snapshot.State.CurrentStage != contract.Stage00 || snapshot.State.Status == state.Completed {
			report.Findings = append(report.Findings, finding(Info, "VNEXT_STAGE_ARTIFACTS_VALID", "All completed Go Stage outputs and their pinned Artifact references are valid.", false))
		}
	}
	entries, auditErr := audit.ReadOrdered(inspection.RecordDir)
	if auditErr != nil || len(entries) == 0 {
		report.Findings = append(report.Findings, finding(Error, "VNEXT_AUDIT_MISSING", "The Core Audit log is missing.", false))
	}
	return finish(report)
}

func verifyCompletedStages(projectDir, recordDir string, snapshot state.Snapshot) error {
	completed := func(stageID contract.StageID) bool {
		if snapshot.State.Status == state.Completed {
			return true
		}
		return stageIndex(stageID) < stageIndex(snapshot.State.CurrentStage)
	}
	intentID := snapshot.State.IntentID
	if completed(contract.Stage01) {
		value, _, _, err := stageruntime.ReadCanonical[st01orient.CurrentContext](projectDir, st01orient.CurrentContextPath(recordDir), "current-context", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage01, err, "Current Context belongs to another Intent")
		}
		if err := verifyReferences(projectDir, value.DesignBriefRef, value.WorkspaceProfileRef, value.SystemMapRef); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage01, err)
		}
	}
	if completed(contract.Stage02) {
		value, _, _, err := stageruntime.ReadCanonical[st02defineintent.Definition](projectDir, st02defineintent.DefinitionPath(recordDir), "intent-definition", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage02, err, "Intent Definition belongs to another Intent")
		}
		if err := verifyReferences(projectDir, value.DesignBriefRef, value.CurrentContextRef, value.EffectivePolicyRef); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage02, err)
		}
	}
	if completed(contract.Stage03) {
		value, _, _, err := stageruntime.ReadCanonical[st03requirements.Current](projectDir, st03requirements.CurrentPath(recordDir), "requirements-current", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage03, err, "Requirements Current belongs to another Intent")
		}
		if err := verifyReferences(projectDir, value.RequirementsRef); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage03, err)
		}
	}
	if completed(contract.Stage04) {
		value, _, _, err := stageruntime.ReadCanonical[st04architecture.Current](projectDir, st04architecture.CurrentPath(recordDir), "architecture-current", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage04, err, "Architecture Current belongs to another Intent")
		}
		refs := []contract.ArtifactReference{value.RequirementsRef, value.CurrentContextRef, value.SystemMapRef, value.EffectivePolicyRef}
		refs = append(refs, value.Evidence...)
		if value.ArchitectureRef != nil {
			refs = append(refs, *value.ArchitectureRef)
		}
		if err := verifyReferences(projectDir, refs...); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage04, err)
		}
	}
	if completed(contract.Stage05) {
		value, _, _, err := stageruntime.ReadCanonical[st05buildcontract.Current](projectDir, st05buildcontract.CurrentPath(recordDir), "build-contract-current", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage05, err, "Build Contract Current belongs to another Intent")
		}
		refs := []contract.ArtifactReference{value.CandidateRef, value.ApprovalRef, value.RequirementsRef, value.ArchitectureCurrentRef, value.CurrentContextRef, value.SystemMapRef, value.EffectivePolicyRef}
		if value.BuildContractRef != nil {
			refs = append(refs, *value.BuildContractRef)
		}
		if err := verifyReferences(projectDir, refs...); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage05, err)
		}
	}
	if completed(contract.Stage06) {
		value, _, _, err := stageruntime.ReadCanonical[st06build.Current](projectDir, st06build.CurrentPath(recordDir), "build-current", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage06, err, "Build Current belongs to another Intent")
		}
		refs := []contract.ArtifactReference{value.BuildContractCurrentRef}
		if value.RunnableCandidateRef != nil {
			refs = append(refs, *value.RunnableCandidateRef)
		}
		if err := verifyReferences(projectDir, refs...); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage06, err)
		}
	}
	if completed(contract.Stage07) {
		value, _, _, err := stageruntime.ReadCanonical[st07review.Current](projectDir, st07review.CurrentPath(recordDir), "review-current", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage07, err, "Review Current belongs to another Intent")
		}
		refs := []contract.ArtifactReference{value.HumanDecisionRef}
		for _, ref := range []*contract.ArtifactReference{value.ReviewManifestRef, value.AcceptedCandidateRef, value.FeedbackCurrentRef} {
			if ref != nil {
				refs = append(refs, *ref)
			}
		}
		if err := verifyReferences(projectDir, refs...); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage07, err)
		}
	}
	if completed(contract.Stage08) {
		value, _, _, err := stageruntime.ReadCanonical[st08release.Current](projectDir, st08release.CurrentPath(recordDir), "release-current", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage08, err, "Release Current belongs to another Intent")
		}
		refs := []contract.ArtifactReference{value.ReviewCurrentRef}
		for _, ref := range []*contract.ArtifactReference{value.AcceptedCandidateRef, value.ReleasePlanRef, value.ReleaseAuthorityRef, value.ReleaseReceiptRef, value.DeploymentMapRef} {
			if ref != nil {
				refs = append(refs, *ref)
			}
		}
		if err := verifyReferences(projectDir, refs...); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage08, err)
		}
	}
	if completed(contract.Stage09) {
		value, _, _, err := stageruntime.ReadCanonical[st09outcome.Current](projectDir, st09outcome.CurrentPath(recordDir), "outcome-current", 1)
		if err != nil || value.IntentID != intentID {
			return stageError(contract.Stage09, err, "Outcome Current belongs to another Intent")
		}
		refs := []contract.ArtifactReference{value.WorkRequestRef, value.OutcomeEvidenceRef, value.OutcomeEvaluationRef}
		for _, ref := range []*contract.ArtifactReference{value.HumanDecisionRef, value.FollowUpBriefRef} {
			if ref != nil {
				refs = append(refs, *ref)
			}
		}
		if err := verifyReferences(projectDir, refs...); err != nil {
			return fmt.Errorf("%s: %w", contract.Stage09, err)
		}
	}
	return nil
}

func verifyReferences(projectDir string, refs ...contract.ArtifactReference) error {
	for _, ref := range refs {
		if _, err := stageruntime.ReadReference(projectDir, ref); err != nil {
			return err
		}
	}
	return nil
}

func stageIndex(stageID contract.StageID) int {
	for index, candidate := range contract.OrderedStageIDs {
		if candidate == stageID {
			return index
		}
	}
	return -1
}

func stageError(stageID contract.StageID, err error, fallback string) error {
	if err != nil {
		return fmt.Errorf("%s: %w", stageID, err)
	}
	return fmt.Errorf("%s: %s", stageID, fallback)
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
