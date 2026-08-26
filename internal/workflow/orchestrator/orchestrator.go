// Package orchestrator is the only owner of vNext Stage routing decisions.
package orchestrator

import (
	"context"
	"fmt"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/workflow/catalog"
	"github.com/sori883/aidlc/internal/workflow/directive"
	"github.com/sori883/aidlc/internal/workflow/policy"
	"github.com/sori883/aidlc/internal/workflow/state"
)

// Handler resolves work within one Stage but does not own Graph transitions.
type Handler interface {
	Resolve(context.Context, string, state.Snapshot) (directive.Core, error)
}

// HandlerFunc adapts a function to Handler.
type HandlerFunc func(context.Context, string, state.Snapshot) (directive.Core, error)

// Resolve implements Handler.
func (function HandlerFunc) Resolve(ctx context.Context, projectDir string, snapshot state.Snapshot) (directive.Core, error) {
	return function(ctx, projectDir, snapshot)
}

// Registry maps fixed Stage IDs to implemented runtimes.
type Registry map[contract.StageID]Handler

// Resolve validates Core State and returns exactly one Core Directive.
func Resolve(ctx context.Context, projectDir, coreDir string, handlers Registry) (directive.Core, error) {
	definitions, err := catalog.Load(coreDir)
	if err != nil {
		return directive.Core{}, err
	}
	snapshot, err := state.Resume(projectDir)
	if err != nil {
		return directive.Core{}, err
	}
	if err := state.Validate(projectDir, snapshot.RecordDir); err != nil {
		return directive.Core{}, err
	}
	if snapshot.State.CatalogVersion != definitions.Catalog.CatalogVersion {
		return directive.Core{}, fmt.Errorf("Core Route: State Catalog %s does not match %s", snapshot.State.CatalogVersion, definitions.Catalog.CatalogVersion)
	}
	if snapshot.State.GraphVersion != definitions.Graph.GraphVersion || snapshot.Plan.GraphVersion != definitions.Graph.GraphVersion {
		return directive.Core{}, fmt.Errorf("Core Route: persisted Graph does not match %s", definitions.Graph.GraphVersion)
	}
	if snapshot.State.Status == state.Completed {
		result := base(snapshot, directive.Done, "All fixed vNext Stages are complete.")
		return result, result.Validate()
	}
	decision, ok := decisionFor(snapshot.Plan, snapshot.State.CurrentStage)
	if !ok {
		return directive.Core{}, fmt.Errorf("Core Route: Plan has no decision for %s", snapshot.State.CurrentStage)
	}
	handler := handlers[snapshot.State.CurrentStage]
	if handler == nil {
		reason := fmt.Sprintf("%s is %s, but its Stage runtime is unavailable.", snapshot.State.CurrentStage, decision.Disposition)
		if snapshot.State.ParkedReason != nil {
			reason = *snapshot.State.ParkedReason
		}
		result := base(snapshot, directive.Parked, reason)
		stageID := snapshot.State.CurrentStage
		result.Stage = &stageID
		return result, result.Validate()
	}
	result, err := handler.Resolve(ctx, projectDir, snapshot)
	if err != nil {
		return directive.Core{}, err
	}
	if err := validateHandlerResult(projectDir, definitions.Graph, snapshot, result); err != nil {
		return directive.Core{}, err
	}
	return result, nil
}

func validateHandlerResult(projectDir string, graph catalog.StageGraph, snapshot state.Snapshot, result directive.Core) error {
	if err := result.Validate(); err != nil {
		return err
	}
	if result.GraphVersion != snapshot.State.GraphVersion || result.PlanRevision != snapshot.State.PlanRevision {
		return fmt.Errorf("Core Route: Stage Directive does not match persisted Graph and Plan")
	}
	if result.Kind == directive.Done {
		return fmt.Errorf("Core Route: Stage runtime cannot declare the Workflow done")
	}
	if result.Kind == directive.Advanced {
		if result.CompletedStage == nil || *result.CompletedStage != snapshot.State.CurrentStage || result.Stage == nil {
			return fmt.Errorf("Core Route: advanced Directive does not complete the current Stage")
		}
		if err := catalog.ValidateRoute(graph, catalog.RouteRequest{From: *result.CompletedStage, To: *result.Stage}); err != nil {
			return err
		}
		for _, evidence := range result.Evidence {
			if _, err := policy.VerifyProjectArtifactReference(projectDir, evidence); err != nil {
				return err
			}
		}
		return nil
	}
	if result.Stage == nil || *result.Stage != snapshot.State.CurrentStage {
		return fmt.Errorf("Core Route: Stage Directive does not target the current Stage")
	}
	return nil
}

func base(snapshot state.Snapshot, kind directive.Kind, reason string) directive.Core {
	return directive.Core{
		SchemaVersion:     1,
		Kind:              kind,
		Workflow:          "vnext",
		Reason:            reason,
		GraphVersion:      snapshot.State.GraphVersion,
		PlanRevision:      snapshot.State.PlanRevision,
		DecisionAuthority: "core",
	}
}

func decisionFor(executionPlan contract.StageExecutionPlan, stageID contract.StageID) (contract.CoreStageDecision, bool) {
	for _, decision := range executionPlan.StageDecisions {
		if decision.StageID == stageID {
			return decision, true
		}
	}
	return contract.CoreStageDecision{}, false
}
