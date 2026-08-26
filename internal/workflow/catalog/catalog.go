package catalog

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/jsonx"
)

const (
	catalogSchemaVersion = 1
	graphSchemaVersion   = 1
)

// StageCatalogEntry describes one fixed workflow Stage.
type StageCatalogEntry struct {
	StageID contract.StageID `json:"stage_id"`
	Name    string           `json:"name"`
}

// StageCatalog is the canonical ordered ten-Stage catalog.
type StageCatalog struct {
	SchemaVersion  int                 `json:"schema_version"`
	CatalogVersion string              `json:"catalog_version"`
	Stages         []StageCatalogEntry `json:"stages"`
}

// ForwardEdge is one fixed forward transition.
type ForwardEdge struct {
	From contract.StageID `json:"from"`
	To   contract.StageID `json:"to"`
}

// FeedbackEdge is one fixed ST-07 feedback transition.
type FeedbackEdge struct {
	From   contract.StageID `json:"from"`
	To     contract.StageID `json:"to"`
	Reason string           `json:"reason"`
}

// StageGraph is the canonical fixed workflow graph.
type StageGraph struct {
	SchemaVersion  int              `json:"schema_version"`
	GraphVersion   string           `json:"graph_version"`
	CatalogVersion string           `json:"catalog_version"`
	EntryStage     contract.StageID `json:"entry_stage"`
	TerminalStage  contract.StageID `json:"terminal_stage"`
	ForwardEdges   []ForwardEdge    `json:"forward_edges"`
	FeedbackEdges  []FeedbackEdge   `json:"feedback_edges"`
}

// Definitions contains a validated catalog and graph.
type Definitions struct {
	Catalog StageCatalog
	Graph   StageGraph
}

var expectedFeedbackEdges = [...]FeedbackEdge{
	{From: contract.Stage07, To: contract.Stage03, Reason: "requirements_changed"},
	{From: contract.Stage07, To: contract.Stage04, Reason: "architecture_impact"},
	{From: contract.Stage07, To: contract.Stage05, Reason: "build_contract_impact"},
	{From: contract.Stage07, To: contract.Stage06, Reason: "candidate_defect"},
}

// Load reads and validates the canonical definitions beneath coreDir.
func Load(coreDir string) (Definitions, error) {
	catalogPath := filepath.Join(coreDir, "aidlc-common", "data", "vnext-stage-catalog.json")
	graphPath := filepath.Join(coreDir, "aidlc-common", "data", "vnext-stage-graph.json")

	stageCatalog, err := jsonx.ReadFile[StageCatalog](catalogPath)
	if err != nil {
		return Definitions{}, fmt.Errorf("vNext Stage Catalog: %w", err)
	}
	if err := validateCatalog(stageCatalog); err != nil {
		return Definitions{}, fmt.Errorf("vNext Stage Catalog: %w", err)
	}
	stageGraph, err := jsonx.ReadFile[StageGraph](graphPath)
	if err != nil {
		return Definitions{}, fmt.Errorf("vNext Stage Graph: %w", err)
	}
	if err := validateGraph(stageGraph); err != nil {
		return Definitions{}, fmt.Errorf("vNext Stage Graph: %w", err)
	}
	if stageGraph.CatalogVersion != stageCatalog.CatalogVersion {
		return Definitions{}, fmt.Errorf(
			"vNext definitions: Graph catalog_version %s does not match Catalog %s",
			stageGraph.CatalogVersion,
			stageCatalog.CatalogVersion,
		)
	}
	return Definitions{Catalog: stageCatalog, Graph: stageGraph}, nil
}

func validateCatalog(stageCatalog StageCatalog) error {
	if stageCatalog.SchemaVersion != catalogSchemaVersion {
		return fmt.Errorf("schema_version must equal %d", catalogSchemaVersion)
	}
	if err := requireOneLine(stageCatalog.CatalogVersion, "catalog_version"); err != nil {
		return err
	}
	if len(stageCatalog.Stages) != len(contract.OrderedStageIDs) {
		return fmt.Errorf("stages must contain exactly %d stages", len(contract.OrderedStageIDs))
	}
	names := make(map[string]struct{}, len(stageCatalog.Stages))
	for index, expected := range contract.OrderedStageIDs {
		stage := stageCatalog.Stages[index]
		if stage.StageID != expected {
			return fmt.Errorf("stages[%d].stage_id must equal %s; fixed Stage order cannot be changed", index, expected)
		}
		if err := requireOneLine(stage.Name, fmt.Sprintf("stages[%d].name", index)); err != nil {
			return err
		}
		if _, exists := names[stage.Name]; exists {
			return fmt.Errorf("stages contains duplicate name: %s", stage.Name)
		}
		names[stage.Name] = struct{}{}
	}
	return nil
}

func validateGraph(stageGraph StageGraph) error {
	if stageGraph.SchemaVersion != graphSchemaVersion {
		return fmt.Errorf("schema_version must equal %d", graphSchemaVersion)
	}
	if err := requireOneLine(stageGraph.GraphVersion, "graph_version"); err != nil {
		return err
	}
	if err := requireOneLine(stageGraph.CatalogVersion, "catalog_version"); err != nil {
		return err
	}
	if stageGraph.EntryStage != contract.Stage00 {
		return fmt.Errorf("entry_stage must equal ST-00")
	}
	if stageGraph.TerminalStage != contract.Stage09 {
		return fmt.Errorf("terminal_stage must equal ST-09")
	}
	if len(stageGraph.ForwardEdges) != len(contract.OrderedStageIDs)-1 {
		return fmt.Errorf("forward_edges must contain exactly %d edge(s)", len(contract.OrderedStageIDs)-1)
	}
	for index := 0; index < len(contract.OrderedStageIDs)-1; index++ {
		edge := stageGraph.ForwardEdges[index]
		if edge.From != contract.OrderedStageIDs[index] || edge.To != contract.OrderedStageIDs[index+1] {
			return fmt.Errorf(
				"forward_edges[%d] must equal %s->%s; fixed Route cannot be changed",
				index,
				contract.OrderedStageIDs[index],
				contract.OrderedStageIDs[index+1],
			)
		}
	}
	if len(stageGraph.FeedbackEdges) != len(expectedFeedbackEdges) {
		return fmt.Errorf("feedback_edges must contain exactly %d edge(s)", len(expectedFeedbackEdges))
	}
	for index, expected := range expectedFeedbackEdges {
		actual := stageGraph.FeedbackEdges[index]
		if actual != expected {
			return fmt.Errorf(
				"feedback_edges[%d] must equal %s->%s:%s; fixed Route cannot be changed",
				index,
				expected.From,
				expected.To,
				expected.Reason,
			)
		}
	}
	return nil
}

func requireOneLine(value, field string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s must be a non-empty single-line string", field)
	}
	return nil
}
