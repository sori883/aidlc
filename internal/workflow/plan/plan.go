// Package plan creates and revises the Core-owned fixed Stage Execution Plan.
package plan

import (
	"fmt"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/workflow/policy"
)

const safeDefaultReason = "Core safe default: no verified basis exists to shorten this Stage."

// RevisionOptions supplies the evidence boundary for untrusted proposals.
type RevisionOptions struct {
	ProjectDir                 string
	StageContracts             []contract.StageContract
	DeterministicApplicability func(contract.StageDispositionProposal, contract.StageContract) bool
}

// Initial creates the safe execute decision for all ten fixed Stages.
func Initial(intentID, graphVersion string, policySnapshot contract.ArtifactReference) (contract.StageExecutionPlan, error) {
	decisions := make([]contract.CoreStageDecision, 0, len(contract.OrderedStageIDs))
	for _, stageID := range contract.OrderedStageIDs {
		decisions = append(decisions, contract.CoreStageDecision{
			SchemaVersion:     contract.SchemaVersion,
			DecisionID:        decisionID(stageID, 1),
			StageID:           stageID,
			Disposition:       contract.Execute,
			Reason:            safeDefaultReason,
			Evidence:          []contract.ArtifactReference{},
			DecisionAuthority: "core",
		})
	}
	result := contract.StageExecutionPlan{
		SchemaVersion:  contract.SchemaVersion,
		IntentID:       intentID,
		Revision:       1,
		GraphVersion:   graphVersion,
		PolicySnapshot: policySnapshot,
		StageDecisions: decisions,
	}
	if err := result.Validate(); err != nil {
		return contract.StageExecutionPlan{}, err
	}
	return result, nil
}

// Revise verifies every evidence reference and converts proposals into
// Core-authorized decisions without allowing a proposal to own routing.
func Revise(current contract.StageExecutionPlan, proposals []contract.StageDispositionProposal, options RevisionOptions) (contract.StageExecutionPlan, error) {
	if err := current.Validate(); err != nil {
		return contract.StageExecutionPlan{}, err
	}
	if len(proposals) == 0 {
		return contract.StageExecutionPlan{}, fmt.Errorf("Stage Execution Plan revision requires at least one proposal")
	}
	if _, err := policy.VerifyProjectArtifactReference(options.ProjectDir, current.PolicySnapshot); err != nil {
		return contract.StageExecutionPlan{}, err
	}
	contracts := make(map[contract.StageID]contract.StageContract, len(options.StageContracts))
	for index, stageContract := range options.StageContracts {
		if err := stageContract.Validate(); err != nil {
			return contract.StageExecutionPlan{}, fmt.Errorf("Stage Contract[%d]: %w", index, err)
		}
		if _, exists := contracts[stageContract.StageID]; exists {
			return contract.StageExecutionPlan{}, fmt.Errorf("Stage Contracts duplicate stage_id: %s", stageContract.StageID)
		}
		contracts[stageContract.StageID] = stageContract
	}
	byStage := make(map[contract.StageID]contract.StageDispositionProposal, len(proposals))
	for index, proposal := range proposals {
		if err := proposal.Validate(); err != nil {
			return contract.StageExecutionPlan{}, fmt.Errorf("Proposal[%d]: %w", index, err)
		}
		if _, exists := byStage[proposal.StageID]; exists {
			return contract.StageExecutionPlan{}, fmt.Errorf("Stage Execution Plan revision duplicate proposal for %s", proposal.StageID)
		}
		for _, evidence := range proposal.Evidence {
			if _, err := policy.VerifyProjectArtifactReference(options.ProjectDir, evidence); err != nil {
				return contract.StageExecutionPlan{}, err
			}
		}
		stageContract, exists := contracts[proposal.StageID]
		if err := validateDecisionRule(proposal, stageContract, exists, options.DeterministicApplicability); err != nil {
			return contract.StageExecutionPlan{}, err
		}
		byStage[proposal.StageID] = proposal
	}
	revision := current.Revision + 1
	decisions := make([]contract.CoreStageDecision, len(current.StageDecisions))
	copy(decisions, current.StageDecisions)
	for index, existing := range decisions {
		proposal, exists := byStage[existing.StageID]
		if !exists {
			continue
		}
		proposalID := proposal.ProposalID
		evidence := make([]contract.ArtifactReference, len(proposal.Evidence))
		copy(evidence, proposal.Evidence)
		decisions[index] = contract.CoreStageDecision{
			SchemaVersion:     contract.SchemaVersion,
			DecisionID:        decisionID(existing.StageID, revision),
			StageID:           existing.StageID,
			Disposition:       proposal.Disposition,
			Reason:            proposal.Reason,
			Evidence:          evidence,
			DecisionAuthority: "core",
			ProposalRef:       &proposalID,
		}
	}
	result := current
	result.Revision = revision
	result.StageDecisions = decisions
	if err := result.Validate(); err != nil {
		return contract.StageExecutionPlan{}, err
	}
	return result, nil
}

func validateDecisionRule(proposal contract.StageDispositionProposal, stageContract contract.StageContract, hasContract bool, deterministic func(contract.StageDispositionProposal, contract.StageContract) bool) error {
	if proposal.Disposition == contract.Execute {
		return nil
	}
	if proposal.StageID == contract.Stage00 && proposal.Disposition == contract.NotApplicable {
		return fmt.Errorf("Core decision ST-00: ST-00 cannot be not_applicable")
	}
	if !hasContract {
		return fmt.Errorf("Core decision %s: %s requires an implemented Stage Contract", proposal.StageID, proposal.Disposition)
	}
	if proposal.Disposition == contract.Reuse {
		declared := make(map[string]struct{}, len(stageContract.Inputs)+len(stageContract.Outputs))
		for _, input := range stageContract.Inputs {
			declared[input.Artifact] = struct{}{}
		}
		for _, output := range stageContract.Outputs {
			declared[output] = struct{}{}
		}
		for _, evidence := range proposal.Evidence {
			if _, exists := declared[evidence.Artifact]; !exists {
				return fmt.Errorf("Core decision %s: reuse Evidence %s is not declared by the Stage Contract", proposal.StageID, evidence.Artifact)
			}
		}
		return nil
	}
	hasHumanDecision := false
	for _, evidence := range proposal.Evidence {
		if evidence.Artifact == "human-decision" {
			hasHumanDecision = true
			break
		}
	}
	allowsException := false
	for _, decision := range stageContract.HumanDecisions {
		if decision == contract.Exception || decision == contract.ValueJudgment {
			allowsException = true
			break
		}
	}
	if hasHumanDecision && allowsException {
		return nil
	}
	if deterministic != nil && deterministic(proposal, stageContract) {
		return nil
	}
	return fmt.Errorf("Core decision %s: not_applicable requires verified human-decision Evidence or a deterministic applicability rule", proposal.StageID)
}

func decisionID(stageID contract.StageID, revision int) string {
	return fmt.Sprintf("core-%s-r%d", strings.ToLower(string(stageID)), revision)
}
