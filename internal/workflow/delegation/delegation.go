package delegation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/jsonx"
)

const schemaVersion = 1

var (
	agentPattern = regexp.MustCompile(`^aidlc-[a-z0-9]+(?:-[a-z0-9]+)*-agent$`)
	skillPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
)

// Assignment describes one validated Stage Agent assignment.
type Assignment struct {
	Topology              string   `json:"topology"`
	LeadAgent             string   `json:"lead_agent"`
	SupportAgents         []string `json:"support_agents"`
	ReviewerAgent         *string  `json:"reviewer_agent"`
	ReviewerMaxIterations int      `json:"reviewer_max_iterations"`
	RequiredSkills        []string `json:"required_skills"`
	OptionalSkillPolicy   string   `json:"optional_skill_policy"`
	MutationScope         string   `json:"mutation_scope"`
	NestedDelegation      bool     `json:"nested_delegation"`
}

// Stage contains the work and review assignments for one Stage.
type Stage struct {
	StageID          contract.StageID `json:"stage_id"`
	WorkAssignment   *Assignment      `json:"work_assignment"`
	ReviewAssignment *Assignment      `json:"review_assignment"`
}

// Catalog is the fixed delegation catalog.
type Catalog struct {
	SchemaVersion  int     `json:"schema_version"`
	CatalogVersion string  `json:"catalog_version"`
	Stages         []Stage `json:"stages"`
}

type catalogDTO struct {
	SchemaVersion  *int        `json:"schema_version"`
	CatalogVersion *string     `json:"catalog_version"`
	Stages         *[]stageDTO `json:"stages"`
}

type stageDTO struct {
	StageID          *string         `json:"stage_id"`
	WorkAssignment   json.RawMessage `json:"work_assignment"`
	ReviewAssignment json.RawMessage `json:"review_assignment"`
}

type assignmentDTO struct {
	Topology              *string         `json:"topology"`
	LeadAgent             *string         `json:"lead_agent"`
	SupportAgents         *[]string       `json:"support_agents"`
	ReviewerAgent         json.RawMessage `json:"reviewer_agent"`
	ReviewerMaxIterations *int            `json:"reviewer_max_iterations"`
	RequiredSkills        *[]string       `json:"required_skills"`
	OptionalSkillPolicy   *string         `json:"optional_skill_policy"`
	MutationScope         *string         `json:"mutation_scope"`
	NestedDelegation      *bool           `json:"nested_delegation"`
}

// Load reads and validates the canonical delegation catalog beneath coreDir.
func Load(coreDir string) (Catalog, error) {
	path := filepath.Join(coreDir, "aidlc-common", "data", "vnext-stage-delegation.json")
	dto, err := jsonx.ReadFile[catalogDTO](path)
	if err != nil {
		return Catalog{}, fmt.Errorf("vNext Delegation Catalog: %w", err)
	}
	catalog, err := parseCatalog(dto)
	if err != nil {
		return Catalog{}, fmt.Errorf("vNext Delegation Catalog: %w", err)
	}
	return catalog, nil
}

// Find returns the assignment entry for stageID.
func (catalog Catalog) Find(stageID contract.StageID) (Stage, bool) {
	for _, stage := range catalog.Stages {
		if stage.StageID == stageID {
			return stage, true
		}
	}
	return Stage{}, false
}

func parseCatalog(dto catalogDTO) (Catalog, error) {
	if dto.SchemaVersion == nil || *dto.SchemaVersion != schemaVersion {
		return Catalog{}, fmt.Errorf("schema_version must equal %d", schemaVersion)
	}
	if dto.CatalogVersion == nil {
		return Catalog{}, fmt.Errorf("catalog_version is required")
	}
	if err := requireOneLine(*dto.CatalogVersion, "catalog_version"); err != nil {
		return Catalog{}, err
	}
	if dto.Stages == nil {
		return Catalog{}, fmt.Errorf("stages must be an array")
	}
	stages := make([]Stage, 0, len(*dto.Stages))
	for index, rawStage := range *dto.Stages {
		context := fmt.Sprintf("stages[%d]", index)
		if rawStage.StageID == nil {
			return Catalog{}, fmt.Errorf("%s.stage_id is required", context)
		}
		stageID, err := contract.ParseStageID(*rawStage.StageID)
		if err != nil {
			return Catalog{}, fmt.Errorf("%s.stage_id %w", context, err)
		}
		work, err := parseAssignment(rawStage.WorkAssignment, context+".work_assignment")
		if err != nil {
			return Catalog{}, err
		}
		review, err := parseAssignment(rawStage.ReviewAssignment, context+".review_assignment")
		if err != nil {
			return Catalog{}, err
		}
		stages = append(stages, Stage{StageID: stageID, WorkAssignment: work, ReviewAssignment: review})
	}
	if err := validateCoverage(stages); err != nil {
		return Catalog{}, err
	}
	return Catalog{SchemaVersion: schemaVersion, CatalogVersion: *dto.CatalogVersion, Stages: stages}, nil
}

func parseAssignment(raw json.RawMessage, context string) (*Assignment, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("%s is required", context)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	dto, err := jsonx.Decode[assignmentDTO](raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", context, err)
	}
	if dto.Topology == nil || dto.LeadAgent == nil || dto.SupportAgents == nil ||
		dto.ReviewerMaxIterations == nil || dto.RequiredSkills == nil ||
		dto.OptionalSkillPolicy == nil || dto.MutationScope == nil ||
		dto.NestedDelegation == nil || len(dto.ReviewerAgent) == 0 {
		return nil, fmt.Errorf("%s contains a missing required field", context)
	}
	if err := requireAllowed(*dto.Topology, []string{"subagent", "pipeline", "mob"}, context+".topology"); err != nil {
		return nil, err
	}
	if err := requirePattern(*dto.LeadAgent, agentPattern, context+".lead_agent"); err != nil {
		return nil, err
	}
	if err := validateArray(*dto.SupportAgents, agentPattern, context+".support_agents"); err != nil {
		return nil, err
	}

	var reviewer *string
	if !bytes.Equal(bytes.TrimSpace(dto.ReviewerAgent), []byte("null")) {
		value, err := jsonx.Decode[string](dto.ReviewerAgent)
		if err != nil {
			return nil, fmt.Errorf("%s.reviewer_agent: %w", context, err)
		}
		if err := requirePattern(value, agentPattern, context+".reviewer_agent"); err != nil {
			return nil, err
		}
		reviewer = &value
	}

	iterations := *dto.ReviewerMaxIterations
	if iterations < 0 || iterations > 3 {
		return nil, fmt.Errorf("%s.reviewer_max_iterations must be an integer from 0 through 3", context)
	}
	if (reviewer == nil && iterations != 0) || (reviewer != nil && iterations < 1) {
		return nil, fmt.Errorf("%s.reviewer_max_iterations must be zero without a reviewer and positive with a reviewer", context)
	}
	participants := append([]string{*dto.LeadAgent}, (*dto.SupportAgents)...)
	if reviewer != nil {
		participants = append(participants, *reviewer)
	}
	if duplicate := duplicateValue(participants); duplicate != "" {
		return nil, fmt.Errorf("%s contains duplicate participant: %s", context, duplicate)
	}
	if (*dto.Topology == "pipeline" || *dto.Topology == "mob") && len(*dto.SupportAgents) == 0 {
		return nil, fmt.Errorf("%s.support_agents %s requires at least one support agent", context, *dto.Topology)
	}
	if err := validateArray(*dto.RequiredSkills, skillPattern, context+".required_skills"); err != nil {
		return nil, err
	}
	if !contains(*dto.RequiredSkills, "aidlc-stage-work") {
		return nil, fmt.Errorf("%s.required_skills must include aidlc-stage-work", context)
	}
	if *dto.OptionalSkillPolicy != "task-matched" {
		return nil, fmt.Errorf("%s.optional_skill_policy must equal task-matched", context)
	}
	if err := requireAllowed(*dto.MutationScope, []string{"proposal-only", "assigned-worktree", "read-only"}, context+".mutation_scope"); err != nil {
		return nil, err
	}
	if *dto.NestedDelegation {
		return nil, fmt.Errorf("%s.nested_delegation must be false", context)
	}
	return &Assignment{
		Topology:              *dto.Topology,
		LeadAgent:             *dto.LeadAgent,
		SupportAgents:         *dto.SupportAgents,
		ReviewerAgent:         reviewer,
		ReviewerMaxIterations: iterations,
		RequiredSkills:        *dto.RequiredSkills,
		OptionalSkillPolicy:   "task-matched",
		MutationScope:         *dto.MutationScope,
		NestedDelegation:      false,
	}, nil
}

func validateCoverage(stages []Stage) error {
	if len(stages) != len(contract.OrderedStageIDs) {
		return fmt.Errorf("stages must contain exactly %d entries", len(contract.OrderedStageIDs))
	}
	requiredWork := map[contract.StageID]bool{
		contract.Stage01: true,
		contract.Stage02: true,
		contract.Stage03: true,
		contract.Stage04: true,
		contract.Stage05: true,
		contract.Stage06: true,
		contract.Stage08: true,
		contract.Stage09: true,
	}
	for index, expected := range contract.OrderedStageIDs {
		stage := stages[index]
		if stage.StageID != expected {
			return fmt.Errorf("stages[%d].stage_id must equal %s", index, expected)
		}
		if expected == contract.Stage00 {
			if stage.WorkAssignment != nil || stage.ReviewAssignment != nil {
				return fmt.Errorf("stages[%d] ST-00 is Core-owned and cannot delegate", index)
			}
			continue
		}
		if requiredWork[expected] && stage.WorkAssignment == nil {
			return fmt.Errorf("stages[%d].work_assignment must delegate AI work", index)
		}
		if expected == contract.Stage07 {
			if stage.WorkAssignment != nil {
				return fmt.Errorf("stages[%d].work_assignment ST-07 has review work only", index)
			}
			if stage.ReviewAssignment == nil {
				return fmt.Errorf("stages[%d].review_assignment must delegate independent review", index)
			}
		}
		if stage.ReviewAssignment != nil && stage.ReviewAssignment.MutationScope != "read-only" {
			return fmt.Errorf("stages[%d].review_assignment.mutation_scope must be read-only", index)
		}
		if stage.WorkAssignment != nil {
			expectedScope := "proposal-only"
			if expected == contract.Stage06 {
				expectedScope = "assigned-worktree"
			}
			if stage.WorkAssignment.MutationScope != expectedScope {
				return fmt.Errorf("stages[%d].work_assignment.mutation_scope must equal %s", index, expectedScope)
			}
		}
	}
	return nil
}

func requireOneLine(value, context string) error {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%s must be a non-empty single-line string", context)
	}
	return nil
}

func requirePattern(value string, pattern *regexp.Regexp, context string) error {
	if err := requireOneLine(value, context); err != nil {
		return err
	}
	if !pattern.MatchString(value) {
		return fmt.Errorf("%s has an invalid format", context)
	}
	return nil
}

func requireAllowed(value string, allowed []string, context string) error {
	if err := requireOneLine(value, context); err != nil {
		return err
	}
	if !contains(allowed, value) {
		return fmt.Errorf("%s must be one of: %s", context, strings.Join(allowed, ", "))
	}
	return nil
}

func validateArray(values []string, pattern *regexp.Regexp, context string) error {
	for index, value := range values {
		if err := requirePattern(value, pattern, fmt.Sprintf("%s[%d]", context, index)); err != nil {
			return err
		}
	}
	if duplicate := duplicateValue(values); duplicate != "" {
		return fmt.Errorf("%s contains duplicate value: %s", context, duplicate)
	}
	return nil
}

func duplicateValue(values []string) string {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			return value
		}
		seen[value] = struct{}{}
	}
	return ""
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
