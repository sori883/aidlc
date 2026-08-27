package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/doctor"
	"github.com/sori883/aidlc/internal/hookapproval"
	"github.com/sori883/aidlc/internal/hookaudit"
	"github.com/sori883/aidlc/internal/hookcontext"
	"github.com/sori883/aidlc/internal/hookguard"
	"github.com/sori883/aidlc/internal/hookhealth"
	"github.com/sori883/aidlc/internal/hooksensor"
	"github.com/sori883/aidlc/internal/hooksubagent"
	"github.com/sori883/aidlc/internal/hookturn"
	"github.com/sori883/aidlc/internal/installer"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/platform/runtimepath"
	"github.com/sori883/aidlc/internal/sensor"
	"github.com/sori883/aidlc/internal/space"
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
	"github.com/sori883/aidlc/internal/version"
	"github.com/sori883/aidlc/internal/workflow/catalog"
	"github.com/sori883/aidlc/internal/workflow/delegation"
	"github.com/sori883/aidlc/internal/workflow/gate"
	"github.com/sori883/aidlc/internal/workflow/orchestrator"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/risk"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

// Options supplies resolved runtime assets for tests and development tooling.
type Options struct {
	CoreDir        string
	HookRuntimeDir string
	Stdin          io.Reader
}

type route struct {
	Noun     string
	Commands []string
	Summary  string
}

var routes = []route{
	{Noun: "architecture", Commands: []string{"prepare", "complete", "policy-review", "policy-approve"}, Summary: "prepare, review, and validate ST-04 Architecture work"},
	{Noun: "build-contract", Commands: []string{"prepare", "review", "approve"}, Summary: "prepare, review, and approve ST-05 Build Contract work"},
	{Noun: "build", Commands: []string{"prepare", "verify", "reuse"}, Summary: "prepare, verify, or reuse validated ST-06 build work"},
	{Noun: "doctor", Commands: []string{"check", "repair"}, Summary: "diagnose and repair vNext Core state"},
	{Noun: "define-intent", Commands: []string{"prepare", "complete"}, Summary: "prepare and validate ST-02 Define Intent work"},
	{Noun: "delegation", Commands: []string{"receipt", "show", "validate"}, Summary: "inspect Stage Agent assignments and validated result Receipts"},
	{Noun: "graph", Commands: []string{"show", "catalog", "validate"}, Summary: "inspect the fixed vNext Catalog and Graph"},
	{Noun: "hook", Commands: []string{"freeze", "guard", "inject", "receipt", "record", "sensor", "status", "subagent", "turn"}, Summary: "enforce Human Gates, Tool and Agent result scope, inject context, observe turns, run Sensors, or record Hook evidence"},
	{Noun: "human-gate", Commands: []string{"status", "prepare", "apply"}, Summary: "freeze, confirm, and consume explicit Human Gate actions"},
	{Noun: "intent", Commands: []string{"birth", "list", "switch", "risk"}, Summary: "create and select Intents or manage the active Intent Risk Register"},
	{Noun: "orchestrate", Commands: []string{"next"}, Summary: "resolve the next Core-owned vNext action"},
	{Noun: "orient", Commands: []string{"prepare", "complete"}, Summary: "prepare and validate ST-01 Orient work"},
	{Noun: "outcome", Commands: []string{"prepare", "evaluate", "decide", "reuse"}, Summary: "observe, evaluate, and complete terminal ST-09 Outcome work"},
	{Noun: "plan", Commands: []string{"show", "revise"}, Summary: "inspect or revise the Core-owned Stage Execution Plan"},
	{Noun: "requirements", Commands: []string{"prepare", "complete"}, Summary: "prepare and validate ST-03 Requirements work"},
	{Noun: "release", Commands: []string{"prepare", "review", "authorize", "execute", "reuse"}, Summary: "plan, authorize, execute, or verify reuse of ST-08 Release results"},
	{Noun: "review", Commands: []string{"prepare", "approve", "feedback"}, Summary: "prepare and decide ST-07 Candidate review work"},
	{Noun: "sensor", Commands: []string{"list", "describe", "fire", "status"}, Summary: "inspect or explicitly run deterministic vNext Sensors"},
	{Noun: "space", Commands: []string{"create", "list", "switch"}, Summary: "create and select Spaces"},
	{Noun: "state", Commands: []string{"show", "resume", "check"}, Summary: "inspect the Core-owned vNext State"},
	{Noun: "workspace", Commands: []string{"init"}, Summary: "initialize an AI-DLC Workspace"},
}

// Run executes the Stage 2 Go CLI.
func Run(args []string, stdout, stderr io.Writer) int {
	return RunWithOptions(args, stdout, stderr, Options{Stdin: os.Stdin})
}

// RunWithOptions executes the CLI with explicit runtime options.
func RunWithOptions(args []string, stdout, stderr io.Writer, options Options) int {
	normalized := append([]string{}, args...)
	if len(normalized) > 0 && normalized[0] == "next" {
		normalized = append([]string{"orchestrate", "next"}, normalized[1:]...)
	}
	if len(normalized) >= 3 && stageRuntimeNoun(normalized[0]) {
		code := 1
		err := lock.With(context.Background(), normalized[2], lock.Options{}, func(ctx context.Context) error {
			code = runWithContext(ctx, normalized, stdout, stderr, options)
			return nil
		})
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return code
	}
	return runWithContext(context.Background(), normalized, stdout, stderr, options)
}

func runWithContext(ctx context.Context, args []string, stdout, stderr io.Writer, options Options) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, _ = io.WriteString(stdout, renderHelp(false))
		return 0
	}
	if args[0] == "--version" || args[0] == "-V" || args[0] == "version" {
		if len(args) != 1 {
			return writeError(stderr, "aidlc: version does not accept arguments")
		}
		_, _ = fmt.Fprintf(stdout, "aidlc %s\n", version.Version)
		return 0
	}
	if args[0] == "help" {
		_, _ = io.WriteString(stdout, renderHelp(len(args) > 1 && args[1] == "--all"))
		return 0
	}
	if args[0] == "next" {
		args = append([]string{"orchestrate", "next"}, args[1:]...)
	}
	if args[0] == "install" || args[0] == "update" {
		return runInstaller(ctx, args, stdout, stderr)
	}

	selected, ok := findRoute(args[0])
	if !ok {
		return writeError(stderr, fmt.Sprintf("aidlc: unknown command or noun '%s'", args[0]))
	}
	if len(args) < 2 {
		return writeError(stderr, fmt.Sprintf("aidlc: missing command for '%s'", selected.Noun))
	}
	if !contains(selected.Commands, args[1]) {
		return writeError(stderr, fmt.Sprintf("aidlc: unknown command '%s' for '%s'", args[1], selected.Noun))
	}

	coreDir := options.CoreDir
	resolveCore := func() (string, error) {
		if coreDir != "" {
			return filepath.Abs(coreDir)
		}
		return runtimepath.CoreDir()
	}

	switch {
	case args[0] == "human-gate":
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return runHumanGate(ctx, args, stdout, stderr, resolvedCore)

	case args[0] == "graph" && args[1] == "show":
		if len(args) != 2 {
			return writeError(stderr, "Usage: aidlc graph <show|catalog|validate>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		definitions, err := catalog.Load(resolvedCore)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result := struct {
			Catalog     catalog.StageCatalog `json:"catalog"`
			Graph       catalog.StageGraph   `json:"graph"`
			CatalogPath string               `json:"catalogPath"`
			GraphPath   string               `json:"graphPath"`
		}{
			Catalog: definitions.Catalog, Graph: definitions.Graph,
			CatalogPath: filepath.Join(resolvedCore, "aidlc-common", "data", "vnext-stage-catalog.json"),
			GraphPath:   filepath.Join(resolvedCore, "aidlc-common", "data", "vnext-stage-graph.json"),
		}
		return writeJSON(stdout, stderr, result, true)

	case args[0] == "graph" && args[1] == "catalog":
		if len(args) != 2 {
			return writeError(stderr, "Usage: aidlc graph <show|catalog|validate>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		definitions, err := catalog.Load(resolvedCore)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, definitions.Catalog, true)

	case args[0] == "graph" && args[1] == "validate":
		if len(args) != 2 {
			return writeError(stderr, "Usage: aidlc graph <show|catalog|validate>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		definitions, err := catalog.Load(resolvedCore)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result := struct {
			Valid          bool   `json:"valid"`
			Workflow       string `json:"workflow"`
			CatalogVersion string `json:"catalog_version"`
			GraphVersion   string `json:"graph_version"`
		}{
			Valid:          true,
			Workflow:       "vnext",
			CatalogVersion: definitions.Catalog.CatalogVersion,
			GraphVersion:   definitions.Graph.GraphVersion,
		}
		return writeJSON(stdout, stderr, result, false)

	case args[0] == "delegation" && args[1] == "validate":
		if len(args) != 2 {
			return writeError(stderr, "Delegation CLI: validate does not accept arguments")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		delegationCatalog, err := delegation.Load(resolvedCore)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result := struct {
			Valid          bool   `json:"valid"`
			SchemaVersion  int    `json:"schema_version"`
			CatalogVersion string `json:"catalog_version"`
			StageCount     int    `json:"stage_count"`
		}{
			Valid:          true,
			SchemaVersion:  delegationCatalog.SchemaVersion,
			CatalogVersion: delegationCatalog.CatalogVersion,
			StageCount:     len(delegationCatalog.Stages),
		}
		return writeJSON(stdout, stderr, result, true)

	case args[0] == "delegation" && args[1] == "show":
		if len(args) < 3 || len(args) > 4 {
			return writeError(stderr, "Delegation CLI: usage: delegation show <ST-00..ST-09> [work|review]")
		}
		stageID, err := contract.ParseStageID(args[2])
		if err != nil {
			return writeError(stderr, "Delegation CLI stage: "+err.Error())
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		delegationCatalog, err := delegation.Load(resolvedCore)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		stage, ok := delegationCatalog.Find(stageID)
		if !ok {
			return writeError(stderr, fmt.Sprintf("Delegation CLI stage: %s is missing", stageID))
		}
		if len(args) == 3 {
			return writeJSON(stdout, stderr, stage, true)
		}
		switch args[3] {
		case "work":
			return writeJSON(stdout, stderr, stage.WorkAssignment, true)
		case "review":
			return writeJSON(stdout, stderr, stage.ReviewAssignment, true)
		default:
			return writeError(stderr, "Delegation CLI assignment: must be work or review")
		}

	case args[0] == "delegation" && args[1] == "receipt":
		if len(args) != 4 {
			return writeError(stderr, "Usage: aidlc delegation receipt <project-dir> <agent-id>")
		}
		current, receipt, err := hooksubagent.Inspect(args[2], args[3])
		if err != nil {
			return writeError(stderr, "aidlc: Delegation Receipt: "+err.Error())
		}
		result := struct {
			Current hooksubagent.CurrentReceipt `json:"current"`
			Receipt hooksubagent.Receipt        `json:"receipt"`
		}{Current: current, Receipt: receipt}
		return writeJSON(stdout, stderr, result, true)

	case args[0] == "sensor" && args[1] == "list":
		if len(args) != 2 {
			return writeError(stderr, "Usage: aidlc sensor list")
		}
		return writeJSON(stdout, stderr, sensor.List(), true)

	case args[0] == "sensor" && args[1] == "describe":
		if len(args) != 3 {
			return writeError(stderr, "Usage: aidlc sensor describe <sensor-id>")
		}
		definition, ok := sensor.Describe(args[2])
		if !ok {
			return writeError(stderr, "aidlc: unknown Sensor: "+args[2])
		}
		return writeJSON(stdout, stderr, definition, true)

	case args[0] == "sensor" && args[1] == "status":
		if len(args) != 3 {
			return writeError(stderr, "Usage: aidlc sensor status <project-dir>")
		}
		inspection, err := state.InspectActive(args[2])
		if err != nil || inspection.Kind != state.InspectionVNext {
			if err == nil {
				err = fmt.Errorf("active Intent is not a vNext Intent")
			}
			return writeError(stderr, "aidlc: Sensor: "+err.Error())
		}
		status, err := sensor.Inspect(inspection.RecordDir)
		if err != nil {
			return writeError(stderr, "aidlc: Sensor: "+err.Error())
		}
		return writeJSON(stdout, stderr, status, true)

	case args[0] == "sensor" && args[1] == "fire":
		if len(args) < 5 || len(args) > 6 {
			return writeError(stderr, "Usage: aidlc sensor fire <project-dir> <sensor-id> <path> [expected-sha256]")
		}
		definition, ok := sensor.Describe(args[3])
		if !ok {
			return writeError(stderr, "aidlc: unknown Sensor: "+args[3])
		}
		inspection, err := state.InspectActive(args[2])
		if err != nil || inspection.Kind != state.InspectionVNext {
			if err == nil {
				err = fmt.Errorf("active Intent is not a vNext Intent")
			}
			return writeError(stderr, "aidlc: Sensor: "+err.Error())
		}
		snapshot, err := state.Read(inspection.RecordDir)
		if err != nil {
			return writeError(stderr, "aidlc: Sensor: "+err.Error())
		}
		request := sensor.Request{ProjectDir: args[2], RecordDir: inspection.RecordDir, Stage: string(snapshot.State.CurrentStage), SensorID: definition.ID, Trigger: definition.Trigger, Path: args[4], ObservationID: "manual"}
		if definition.Trigger == sensor.TriggerGate {
			if len(args) != 6 {
				return writeError(stderr, "aidlc: gate Sensor requires expected-sha256")
			}
			projectRoot, absErr := filepath.Abs(args[2])
			inputPath := args[4]
			if !filepath.IsAbs(inputPath) {
				inputPath = filepath.Join(projectRoot, inputPath)
			}
			portable, relativeErr := filepath.Rel(projectRoot, filepath.Clean(inputPath))
			if absErr != nil || relativeErr != nil {
				return writeError(stderr, "aidlc: Sensor: cannot resolve input path")
			}
			reference := contract.ArtifactReference{Artifact: "manual-sensor-input", Version: 1, SourceOfTruth: filepath.ToSlash(portable), SHA256: args[5]}
			request.Path = reference.SourceOfTruth
			request.ExpectedRef = &reference
		} else if len(args) != 5 {
			return writeError(stderr, "aidlc: write Sensor does not accept expected-sha256")
		}
		result, err := sensor.Fire(ctx, request, sensor.Options{})
		if err != nil {
			return writeError(stderr, "aidlc: Sensor: "+err.Error())
		}
		if code := writeJSON(stdout, stderr, result, true); code != 0 {
			return code
		}
		if result.Blocking && !result.Passed {
			return 1
		}
		return 0

	case args[0] == "workspace" && args[1] == "init":
		if len(args) > 3 {
			return writeError(stderr, "Usage: aidlc-workspace init [project-dir]")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		projectDir := "."
		if len(args) == 3 {
			projectDir = args[2]
		}
		result, err := workspace.Initialize(projectDir, filepath.Join(resolvedCore, "memory"))
		if err != nil {
			return writeError(stderr, err.Error())
		}
		_, _ = fmt.Fprintf(
			stdout,
			"Initialized AI-DLC workspace at %s (%d files created, %d preserved).\n",
			result.WorkspaceDir,
			len(result.CreatedFiles),
			len(result.PreservedFiles),
		)
		return 0

	case args[0] == "space" && args[1] == "list":
		if len(args) < 3 || len(args) > 4 || (len(args) == 4 && args[3] != "--json") {
			return writeError(stderr, "Usage: aidlc-space list <project-dir> [--json]\n       aidlc-space create <project-dir> <name>\n       aidlc-space switch <project-dir> <name>")
		}
		spaces := space.List(args[2])
		selected := workspace.DefaultSpace
		for _, candidate := range spaces {
			if candidate.Active {
				selected = candidate.Name
				break
			}
		}
		if len(args) == 4 {
			result := struct {
				Active string       `json:"active"`
				Spaces []space.Info `json:"spaces"`
			}{Active: selected, Spaces: spaces}
			return writeJSON(stdout, stderr, result, false)
		}
		var builder strings.Builder
		builder.WriteString("Spaces:\n")
		for _, candidate := range spaces {
			marker := " "
			if candidate.Active {
				marker = "*"
			}
			_, _ = fmt.Fprintf(&builder, "%s %s\n", marker, candidate.Name)
		}
		_, _ = io.WriteString(stdout, builder.String())
		return 0

	case args[0] == "space" && args[1] == "create":
		if len(args) != 4 {
			return writeError(stderr, "Usage: aidlc-space list <project-dir> [--json]\n       aidlc-space create <project-dir> <name>\n       aidlc-space switch <project-dir> <name>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		created, err := space.Create(ctx, args[2], args[3], filepath.Join(resolvedCore, "memory"))
		if err != nil {
			return writeError(stderr, err.Error())
		}
		_, _ = fmt.Fprintf(stdout, "Space created: %s\n", created.Name)
		return 0

	case args[0] == "space" && args[1] == "switch":
		if len(args) != 4 {
			return writeError(stderr, "Usage: aidlc-space list <project-dir> [--json]\n       aidlc-space create <project-dir> <name>\n       aidlc-space switch <project-dir> <name>")
		}
		selected, err := space.Switch(ctx, args[2], args[3])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		_, _ = fmt.Fprintf(stdout, "Active space → %s\n", selected.Name)
		return 0

	case args[0] == "intent" && args[1] == "list":
		if len(args) < 3 || len(args) > 4 || (len(args) == 4 && args[3] != "--json") {
			return writeError(stderr, "Usage: aidlc-intent list <project-dir> [--json]\n       aidlc-intent birth <project-dir> <label> [--risk-file risks.json]\n       aidlc-intent switch <project-dir> <intent>")
		}
		selectedSpace := workspace.ActiveSpace(args[2])
		intents := intent.List(args[2], selectedSpace)
		selected := ""
		for _, candidate := range intents {
			if candidate.Active {
				selected = candidate.DirName
				break
			}
		}
		if len(args) == 4 {
			type intentJSON struct {
				UUID    string   `json:"uuid"`
				Slug    string   `json:"slug"`
				Status  string   `json:"status"`
				Repos   []string `json:"repos"`
				DirName *string  `json:"dirName"`
				Active  bool     `json:"active"`
			}
			items := make([]intentJSON, 0, len(intents))
			for _, candidate := range intents {
				var dirName *string
				if candidate.DirName != "" {
					value := candidate.DirName
					dirName = &value
				}
				repos := candidate.Repos
				if repos == nil {
					repos = []string{}
				}
				items = append(items, intentJSON{
					UUID: candidate.UUID, Slug: candidate.Slug, Status: candidate.Status,
					Repos: repos, DirName: dirName, Active: candidate.Active,
				})
			}
			result := struct {
				Active  *string      `json:"active"`
				Space   string       `json:"space"`
				Intents []intentJSON `json:"intents"`
			}{Space: selectedSpace, Intents: items}
			if selected != "" {
				result.Active = &selected
			}
			return writeJSON(stdout, stderr, result, false)
		}
		if len(intents) == 0 {
			_, _ = fmt.Fprintf(stdout, "No intents in space %q yet.\n", selectedSpace)
			return 0
		}
		var builder strings.Builder
		_, _ = fmt.Fprintf(&builder, "Intents in space %q:\n", selectedSpace)
		for _, candidate := range intents {
			marker := " "
			if candidate.Active {
				marker = "*"
			}
			name := candidate.DirName
			if name == "" {
				name = candidate.Slug
			}
			_, _ = fmt.Fprintf(&builder, "%s %s  [%s]\n", marker, name, candidate.Status)
		}
		_, _ = io.WriteString(stdout, builder.String())
		return 0

	case args[0] == "intent" && args[1] == "switch":
		if len(args) != 4 {
			return writeError(stderr, "Usage: aidlc-intent list <project-dir> [--json]\n       aidlc-intent birth <project-dir> <label> [--risk-file risks.json]\n       aidlc-intent switch <project-dir> <intent>")
		}
		selectedSpace := workspace.ActiveSpace(args[2])
		selected, err := intent.Switch(ctx, args[2], args[3], selectedSpace)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		_, _ = fmt.Fprintf(stdout, "Active intent → %s (space: %s)\n", selected.DirName, selectedSpace)
		return 0

	case args[0] == "intent" && args[1] == "birth":
		valid := len(args) == 4 || (len(args) == 6 && args[4] == "--risk-file")
		if !valid {
			return writeError(stderr, "Usage: aidlc-intent list <project-dir> [--json]\n       aidlc-intent birth <project-dir> <label> [--risk-file risks.json]\n       aidlc-intent switch <project-dir> <intent>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		var seeds []risk.Seed
		if len(args) == 6 {
			content, err := os.ReadFile(args[5])
			if err != nil {
				return writeError(stderr, err.Error())
			}
			seeds, err = jsonx.Decode[[]risk.Seed](content)
			if err != nil {
				return writeError(stderr, "risk file: "+err.Error())
			}
			for index, seed := range seeds {
				if err := seed.Validate(); err != nil {
					return writeError(stderr, fmt.Sprintf("risk-file[%d]: %v", index, err))
				}
			}
		}
		born, err := intent.BirthWithState(ctx, args[2], resolvedCore, args[3], workspace.ActiveSpace(args[2]), intent.BirthWorkflowOptions{Risks: seeds})
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, born, true)

	case args[0] == "intent" && args[1] == "risk":
		if len(args) < 4 || len(args) > 5 || (args[2] != "show" && args[2] != "propose" && args[2] != "decide") || (args[2] == "show" && len(args) != 4) || (args[2] != "show" && len(args) != 5) {
			return writeError(stderr, "Usage: aidlc intent risk show <project-dir>\n       aidlc intent risk propose <project-dir> <proposal.json>\n       aidlc intent risk decide <project-dir> <human-decision.json>")
		}
		snapshot, err := state.Resume(args[3])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		if args[2] == "show" {
			register, reference, current, err := risk.ReadCurrent(args[3], snapshot.RecordDir)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			result := struct {
				Register  risk.Register              `json:"register"`
				Reference contract.ArtifactReference `json:"reference"`
				Current   risk.Current               `json:"current"`
			}{Register: register, Reference: reference, Current: current}
			return writeJSON(stdout, stderr, result, true)
		}
		if args[2] == "decide" {
			return writeError(stderr, "Direct human Risk decisions are disabled; use 'aidlc human-gate prepare' and 'aidlc human-gate apply' with a Codex Human Input Receipt")
		}
		content, err := os.ReadFile(args[4])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		if args[2] == "propose" {
			proposal, err := risk.DecodeProposal(content)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			register, err := risk.Propose(ctx, args[3], snapshot.RecordDir, proposal, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			if _, err := audit.Append(ctx, args[3], snapshot.RecordDir, audit.DecisionRecorded, []audit.Field{{Name: "Decision", Value: "Intent Risk Proposal Accepted"}, {Name: "Proposal", Value: proposal.ProposalID}, {Name: "Revision", Value: fmt.Sprint(register.Revision)}, {Name: "Decision Authority", Value: "core"}}, nil); err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, struct {
				Register risk.Register `json:"register"`
			}{register}, true)
		}
		return writeError(stderr, "Direct human Risk decisions are disabled; use the Human Gate Receipt flow")

	case args[0] == "state" && (args[1] == "show" || args[1] == "resume" || args[1] == "check"):
		if len(args) != 3 {
			return writeError(stderr, "Usage: aidlc state <show|resume|check> <project-dir>")
		}
		if args[1] == "check" {
			inspection, err := state.InspectActive(args[2])
			if err != nil {
				return writeError(stderr, err.Error())
			}
			if inspection.Kind != state.InspectionVNext {
				return writeError(stderr, "vNext State: active Intent is not initialized for vNext")
			}
			if err := state.Validate(args[2], inspection.RecordDir); err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, struct {
				Valid    bool   `json:"valid"`
				Workflow string `json:"workflow"`
			}{true, "vnext"}, false)
		}
		resumed, err := state.Resume(args[2])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result := struct {
			State state.IntentState           `json:"state"`
			Plan  contract.StageExecutionPlan `json:"plan"`
		}{resumed.State, resumed.Plan}
		return writeJSON(stdout, stderr, result, true)

	case args[0] == "plan" && args[1] == "show":
		if len(args) != 3 {
			return writeError(stderr, "Usage: aidlc plan show <project-dir>\n       aidlc plan revise <project-dir> <proposals.json> [--contracts <dir>]")
		}
		resumed, err := state.Resume(args[2])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, resumed.Plan, true)

	case args[0] == "plan" && args[1] == "revise":
		if len(args) != 4 && !(len(args) == 6 && args[4] == "--contracts") {
			return writeError(stderr, "Usage: aidlc plan show <project-dir>\n       aidlc plan revise <project-dir> <proposals.json> [--contracts <dir>]")
		}
		content, err := os.ReadFile(args[3])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		proposals, err := jsonx.Decode[[]contract.StageDispositionProposal](content)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		contractDir := filepath.Join(resolvedCore, "aidlc-common", "stages")
		if len(args) == 6 {
			contractDir = args[5]
		}
		contracts, err := readStageContracts(contractDir)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		resumed, err := state.Resume(args[2])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		revised, err := workflowplan.Revise(resumed.Plan, proposals, workflowplan.RevisionOptions{ProjectDir: args[2], StageContracts: contracts})
		if err != nil {
			return writeError(stderr, err.Error())
		}
		revisedState := resumed.State
		revisedState.PlanRevision = revised.Revision
		revisedState.UpdatedAt = time.Now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		if err := state.Store(ctx, args[2], resumed.RecordDir, revisedState, revised); err != nil {
			return writeError(stderr, err.Error())
		}
		if _, err := audit.Append(ctx, args[2], resumed.RecordDir, audit.PlanRevised, []audit.Field{{Name: "From Revision", Value: fmt.Sprint(resumed.Plan.Revision)}, {Name: "To Revision", Value: fmt.Sprint(revised.Revision)}, {Name: "Decision Authority", Value: "core"}, {Name: "Proposal Count", Value: fmt.Sprint(len(proposals))}}, nil); err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, revised, true)

	case args[0] == "orchestrate" && args[1] == "next":
		if len(args) != 3 {
			return writeError(stderr, "Usage: aidlc next <project-dir>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result, err := orchestrator.Resolve(ctx, args[2], resolvedCore, orchestrator.Registry{
			contract.Stage00: st00bootstrap.Handler{CoreDir: resolvedCore},
			contract.Stage01: st01orient.Handler{CoreDir: resolvedCore},
			contract.Stage02: st02defineintent.Handler{CoreDir: resolvedCore},
			contract.Stage03: st03requirements.Handler{CoreDir: resolvedCore},
			contract.Stage04: st04architecture.Handler{CoreDir: resolvedCore},
			contract.Stage05: st05buildcontract.Handler{CoreDir: resolvedCore},
			contract.Stage06: st06build.Handler{CoreDir: resolvedCore},
			contract.Stage07: st07review.Handler{CoreDir: resolvedCore},
			contract.Stage08: st08release.Handler{CoreDir: resolvedCore},
			contract.Stage09: st09outcome.Handler{CoreDir: resolvedCore},
		})
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, result, false)

	case args[0] == "orient" && (args[1] == "prepare" || args[1] == "complete"):
		if (args[1] == "prepare" && len(args) != 3) || (args[1] == "complete" && len(args) != 4) {
			return writeError(stderr, "Usage: aidlc orient prepare <project-dir>\n       aidlc orient complete <project-dir> <proposal.json>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		if args[1] == "prepare" {
			result, err := st01orient.Prepare(ctx, args[2], resolvedCore, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		}
		content, err := os.ReadFile(args[3])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result, err := st01orient.Complete(ctx, args[2], resolvedCore, content, "")
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, result, true)

	case args[0] == "define-intent" && (args[1] == "prepare" || args[1] == "complete"):
		if (args[1] == "prepare" && len(args) != 3) || (args[1] == "complete" && len(args) != 4) {
			return writeError(stderr, "Usage: aidlc define-intent prepare <project-dir>\n       aidlc define-intent complete <project-dir> <proposal.json>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		if args[1] == "prepare" {
			result, err := st02defineintent.Prepare(ctx, args[2], resolvedCore, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		}
		content, err := os.ReadFile(args[3])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result, err := st02defineintent.Complete(ctx, args[2], resolvedCore, content, "")
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, result, true)

	case args[0] == "requirements" && (args[1] == "prepare" || args[1] == "complete"):
		if (args[1] == "prepare" && len(args) != 3) || (args[1] == "complete" && len(args) != 4) {
			return writeError(stderr, "Usage: aidlc requirements prepare <project-dir>\n       aidlc requirements complete <project-dir> <proposal.json>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		if args[1] == "prepare" {
			result, err := st03requirements.Prepare(ctx, args[2], resolvedCore, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		}
		content, err := os.ReadFile(args[3])
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result, err := st03requirements.Complete(ctx, args[2], resolvedCore, content, "")
		if err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, result, true)

	case args[0] == "architecture":
		if len(args) < 3 {
			return writeError(stderr, "Usage: aidlc architecture <prepare|complete|policy-review|policy-approve> <project-dir> [proposal.json|proposal-sha reason [acknowledgements.json]]")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		switch args[1] {
		case "prepare":
			if len(args) != 3 {
				return writeError(stderr, "Usage: aidlc architecture prepare <project-dir>")
			}
			result, err := st04architecture.Prepare(ctx, args[2], resolvedCore, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "complete", "policy-review":
			if len(args) != 4 {
				return writeError(stderr, "Usage: aidlc architecture "+args[1]+" <project-dir> <proposal.json>")
			}
			content, err := os.ReadFile(args[3])
			if err != nil {
				return writeError(stderr, err.Error())
			}
			if args[1] == "complete" {
				result, err := st04architecture.Complete(ctx, args[2], resolvedCore, content, "")
				if err != nil {
					return writeError(stderr, err.Error())
				}
				return writeJSON(stdout, stderr, result, true)
			}
			result, err := st04architecture.ReviewPolicy(ctx, args[2], resolvedCore, content, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "policy-approve":
			return writeError(stderr, "Direct approval is disabled; use 'aidlc human-gate prepare' and 'aidlc human-gate apply' with a Codex Human Input Receipt")
		}

	case args[0] == "build-contract":
		if len(args) < 3 {
			return writeError(stderr, "Usage: aidlc build-contract <prepare|review|approve> <project-dir> [...]")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		switch args[1] {
		case "prepare":
			if len(args) != 3 {
				return writeError(stderr, "Usage: aidlc build-contract prepare <project-dir>")
			}
			result, err := st05buildcontract.Prepare(ctx, args[2], resolvedCore, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "review":
			if len(args) != 4 {
				return writeError(stderr, "Usage: aidlc build-contract review <project-dir> <proposal.json>")
			}
			content, err := os.ReadFile(args[3])
			if err != nil {
				return writeError(stderr, err.Error())
			}
			result, err := st05buildcontract.Review(ctx, args[2], resolvedCore, content, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "approve":
			return writeError(stderr, "Direct approval is disabled; use the Human Gate Receipt flow")
		}

	case args[0] == "build":
		if len(args) < 3 {
			return writeError(stderr, "Usage: aidlc build <prepare|verify|reuse> <project-dir> [...]")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		switch args[1] {
		case "prepare":
			if len(args) != 3 {
				return writeError(stderr, "Usage: aidlc build prepare <project-dir>")
			}
			result, err := st06build.Prepare(ctx, args[2], resolvedCore, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "verify":
			if len(args) < 4 || len(args) > 5 {
				return writeError(stderr, "Usage: aidlc build verify <project-dir> <bolt-id> [verified-at]")
			}
			at := ""
			if len(args) == 5 {
				at = args[4]
			}
			result, err := st06build.Verify(ctx, args[2], resolvedCore, args[3], at)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "reuse":
			if len(args) < 5 || len(args) > 6 {
				return writeError(stderr, "Usage: aidlc build reuse <project-dir> <candidate.json> <reason> [reused-at]")
			}
			at := ""
			if len(args) == 6 {
				at = args[5]
			}
			result, err := st06build.Reuse(ctx, args[2], resolvedCore, args[3], args[4], at)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		}

	case args[0] == "review":
		if len(args) < 3 {
			return writeError(stderr, "Usage: aidlc review <prepare|approve|feedback> <project-dir> [...]")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		switch args[1] {
		case "prepare":
			if len(args) != 3 {
				return writeError(stderr, "Usage: aidlc review prepare <project-dir>")
			}
			result, err := st07review.Prepare(ctx, args[2], resolvedCore, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "approve":
			return writeError(stderr, "Direct approval is disabled; use the Human Gate Receipt flow")
		case "feedback":
			return writeError(stderr, "Direct feedback is disabled; use the Human Gate Receipt flow")
		}

	case args[0] == "release":
		if len(args) < 3 {
			return writeError(stderr, "Usage: aidlc release <prepare|review|authorize|execute|reuse> <project-dir> [...]")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		switch args[1] {
		case "prepare":
			if len(args) != 3 {
				return writeError(stderr, "Usage: aidlc release prepare <project-dir>")
			}
			result, err := st08release.Prepare(ctx, args[2], resolvedCore, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "review":
			if len(args) < 4 || len(args) > 5 {
				return writeError(stderr, "Usage: aidlc release review <project-dir> <proposal.json> [reviewed-at]")
			}
			content, err := os.ReadFile(args[3])
			if err != nil {
				return writeError(stderr, err.Error())
			}
			reviewedAt := ""
			if len(args) == 5 {
				reviewedAt = args[4]
			}
			result, err := st08release.Review(ctx, args[2], resolvedCore, content, reviewedAt)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "authorize":
			return writeError(stderr, "Direct release authority is disabled; use the Human Gate Receipt flow")
		case "execute":
			if len(args) > 4 {
				return writeError(stderr, "Usage: aidlc release execute <project-dir> [executed-at]")
			}
			at := ""
			if len(args) == 4 {
				at = args[3]
			}
			result, err := st08release.Execute(ctx, args[2], resolvedCore, at)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "reuse":
			if len(args) < 5 || len(args) > 6 {
				return writeError(stderr, "Usage: aidlc release reuse <project-dir> <release-current.json> <reason> [reused-at]")
			}
			at := ""
			if len(args) == 6 {
				at = args[5]
			}
			result, err := st08release.Reuse(ctx, args[2], resolvedCore, args[3], args[4], at)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		}

	case args[0] == "outcome":
		if len(args) < 3 {
			return writeError(stderr, "Usage: aidlc outcome <prepare|evaluate|decide|reuse> <project-dir> [...]")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		switch args[1] {
		case "prepare":
			if len(args) > 4 {
				return writeError(stderr, "Usage: aidlc outcome prepare <project-dir> [prepared-at]")
			}
			at := ""
			if len(args) == 4 {
				at = args[3]
			}
			result, err := st09outcome.Prepare(ctx, args[2], resolvedCore, st09outcome.PrepareOptions{PreparedAt: at})
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "evaluate":
			if len(args) < 4 || len(args) > 5 {
				return writeError(stderr, "Usage: aidlc outcome evaluate <project-dir> <proposal.json> [evaluated-at]")
			}
			content, err := os.ReadFile(args[3])
			if err != nil {
				return writeError(stderr, err.Error())
			}
			at := ""
			if len(args) == 5 {
				at = args[4]
			}
			result, err := st09outcome.Evaluate(ctx, args[2], resolvedCore, content, at)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "decide":
			return writeError(stderr, "Direct Outcome decisions are disabled; use the Human Gate Receipt flow")
		case "reuse":
			if len(args) < 5 || len(args) > 6 {
				return writeError(stderr, "Usage: aidlc outcome reuse <project-dir> <outcome-current.json> <reason> [reused-at]")
			}
			at := ""
			if len(args) == 6 {
				at = args[5]
			}
			result, err := st09outcome.Reuse(ctx, args[2], resolvedCore, args[3], args[4], at)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		}

	case args[0] == "doctor" && (args[1] == "check" || args[1] == "repair"):
		if len(args) != 3 {
			return writeError(stderr, "Usage: aidlc doctor <check|repair> <project-dir>")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		report := doctor.Check(args[2], resolvedCore)
		if args[1] == "repair" {
			report, err = doctor.Repair(ctx, args[2], resolvedCore)
			if err != nil {
				return writeError(stderr, err.Error())
			}
		}
		if code := writeJSON(stdout, stderr, report, true); code != 0 {
			return code
		}
		if !report.Healthy {
			return 1
		}
		return 0

	case args[0] == "hook" && args[1] == "guard":
		if len(args) != 3 && len(args) != 5 {
			return writeError(stderr, "Usage: aidlc hook guard <project-dir> [--harness codex]")
		}
		harness := "codex"
		if len(args) == 5 {
			if args[3] != "--harness" || args[4] == "" {
				return writeError(stderr, "Usage: aidlc hook guard <project-dir> [--harness codex]")
			}
			harness = args[4]
		}
		if options.Stdin == nil {
			return writeError(stderr, "aidlc: Hook input is unavailable on standard input")
		}
		result, err := hookguard.Guard(ctx, args[2], options.Stdin, hookguard.Options{Harness: harness})
		outcome := "allowed"
		if result.Denied {
			outcome = "denied"
		}
		if err != nil {
			outcome = "handler-failed"
		}
		recordHookHealth(ctx, args[2], "guard", "PreToolUse", outcome, err)
		var content []byte
		if err != nil {
			content = hookguard.MarshalFailureResponse()
		} else {
			content, err = hookguard.MarshalResponse(result)
			if err != nil {
				content = hookguard.MarshalFailureResponse()
			}
		}
		if len(content) == 0 {
			return 0
		}
		if _, err := stdout.Write(content); err != nil {
			return writeError(stderr, "aidlc: Hook Guard: write response: "+err.Error())
		}
		return 0

	case args[0] == "hook" && args[1] == "receipt":
		if len(args) != 3 && len(args) != 5 {
			return writeError(stderr, "Usage: aidlc hook receipt <project-dir> [--harness codex]")
		}
		harness := "codex"
		if len(args) == 5 {
			if args[3] != "--harness" || args[4] == "" {
				return writeError(stderr, "Usage: aidlc hook receipt <project-dir> [--harness codex]")
			}
			harness = args[4]
		}
		if options.Stdin == nil {
			return writeError(stderr, "aidlc: Hook input is unavailable on standard input")
		}
		result, err := hookapproval.Capture(ctx, args[2], options.Stdin, hookapproval.Options{Harness: harness})
		outcome := "no-confirmation"
		if result.Matched {
			outcome = "receipt-recorded"
		}
		if err != nil {
			outcome = "handler-failed"
		}
		if result.Matched || err != nil {
			recordHookHealth(ctx, args[2], "human-receipt", "UserPromptSubmit", outcome, err)
		}
		var content []byte
		if err != nil {
			content = hookapproval.MarshalCaptureFailureResponse()
		} else {
			content, err = hookapproval.MarshalCaptureResponse(result)
			if err != nil {
				content = hookapproval.MarshalCaptureFailureResponse()
			}
		}
		if len(content) == 0 {
			return 0
		}
		if _, err := stdout.Write(content); err != nil {
			return writeError(stderr, "aidlc: Human Receipt Hook: write response: "+err.Error())
		}
		return 0

	case args[0] == "hook" && args[1] == "turn":
		if len(args) != 3 && len(args) != 5 {
			return writeError(stderr, "Usage: aidlc hook turn <project-dir> [--harness codex]")
		}
		harness := "codex"
		if len(args) == 5 {
			if args[3] != "--harness" || args[4] == "" {
				return writeError(stderr, "Usage: aidlc hook turn <project-dir> [--harness codex]")
			}
			harness = args[4]
		}
		if options.Stdin == nil {
			return writeError(stderr, "aidlc: Hook input is unavailable on standard input")
		}
		_, err := hookturn.Observe(ctx, args[2], options.Stdin, hookturn.Options{
			Harness: harness, RuntimeDir: options.HookRuntimeDir,
		})
		if err != nil {
			return writeError(stderr, "aidlc: Human Turn Hook: "+err.Error())
		}
		return 0

	case args[0] == "hook" && args[1] == "freeze":
		if len(args) != 3 && len(args) != 5 {
			return writeError(stderr, "Usage: aidlc hook freeze <project-dir> [--harness codex]")
		}
		harness := "codex"
		if len(args) == 5 {
			if args[3] != "--harness" || args[4] == "" {
				return writeError(stderr, "Usage: aidlc hook freeze <project-dir> [--harness codex]")
			}
			harness = args[4]
		}
		if options.Stdin == nil {
			return writeError(stderr, "aidlc: Hook input is unavailable on standard input")
		}
		result, err := hookapproval.Freeze(ctx, args[2], options.Stdin, hookapproval.Options{Harness: harness})
		outcome := "no-pending-gate"
		if result.Pending {
			outcome = "gate-pending"
		}
		if err != nil {
			outcome = "handler-failed"
		}
		recordHookHealth(ctx, args[2], "review-freeze", "Stop", outcome, err)
		var content []byte
		if err != nil {
			content = hookapproval.MarshalFreezeFailureResponse()
		} else {
			content, err = hookapproval.MarshalFreezeResponse(result)
			if err != nil {
				content = hookapproval.MarshalFreezeFailureResponse()
			}
		}
		if _, err := stdout.Write(content); err != nil {
			return writeError(stderr, "aidlc: Review Freeze Hook: write response: "+err.Error())
		}
		return 0

	case args[0] == "hook" && args[1] == "inject":
		if len(args) != 3 && len(args) != 5 {
			return writeError(stderr, "Usage: aidlc hook inject <project-dir> [--harness codex]")
		}
		harness := "codex"
		if len(args) == 5 {
			if args[3] != "--harness" || args[4] == "" {
				return writeError(stderr, "Usage: aidlc hook inject <project-dir> [--harness codex]")
			}
			harness = args[4]
		}
		if options.Stdin == nil {
			return writeError(stderr, "aidlc: Hook input is unavailable on standard input")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result, err := hookcontext.Inject(ctx, args[2], resolvedCore, options.Stdin, hookcontext.Options{Harness: harness})
		outcome := "no-active-context"
		if result.Injected {
			outcome = "injected"
		}
		if err != nil {
			outcome = "handler-failed"
		}
		recordHookHealth(ctx, args[2], "context", result.HookEventName, outcome, err)
		if err != nil {
			return writeError(stderr, "aidlc: Hook Context: "+err.Error())
		}
		content, err := hookcontext.MarshalResponse(result)
		if err != nil {
			return writeError(stderr, "aidlc: Hook Context: "+err.Error())
		}
		if len(content) == 0 {
			return 0
		}
		if _, err := stdout.Write(content); err != nil {
			return writeError(stderr, "aidlc: Hook Context: write response: "+err.Error())
		}
		return 0

	case args[0] == "hook" && args[1] == "record":
		if len(args) != 3 && len(args) != 5 {
			return writeError(stderr, "Usage: aidlc hook record <project-dir> [--harness codex]")
		}
		harness := "codex"
		if len(args) == 5 {
			if args[3] != "--harness" || args[4] == "" {
				return writeError(stderr, "Usage: aidlc hook record <project-dir> [--harness codex]")
			}
			harness = args[4]
		}
		if options.Stdin == nil {
			return writeError(stderr, "aidlc: Hook input is unavailable on standard input")
		}
		recorded, err := hookaudit.Record(ctx, args[2], options.Stdin, hookaudit.RecordOptions{Harness: harness})
		if err == nil {
			outcome := "recorded"
			if !recorded.Recorded {
				outcome = recorded.Reason
			}
			recordHookHealth(ctx, args[2], "audit", recorded.SourceEvent, outcome, nil)
		}
		if err != nil {
			return writeError(stderr, "aidlc: Hook Audit: "+err.Error())
		}
		return 0

	case args[0] == "hook" && args[1] == "sensor":
		if len(args) != 3 && len(args) != 5 {
			return writeError(stderr, "Usage: aidlc hook sensor <project-dir> [--harness codex]")
		}
		harness := "codex"
		if len(args) == 5 {
			if args[3] != "--harness" || args[4] == "" {
				return writeError(stderr, "Usage: aidlc hook sensor <project-dir> [--harness codex]")
			}
			harness = args[4]
		}
		if options.Stdin == nil {
			return writeError(stderr, "aidlc: Hook input is unavailable on standard input")
		}
		observed, err := hooksensor.Observe(ctx, args[2], options.Stdin, hooksensor.Options{Harness: harness})
		outcome := "no-match"
		if observed.Fired > 0 {
			outcome = "fired"
		} else if observed.Matched > 0 {
			outcome = "matched-not-fired"
		}
		if err != nil {
			outcome = "handler-failed"
		}
		recordHookHealth(ctx, args[2], "sensor", "PostToolUse", outcome, err)
		if err != nil {
			// PostToolUse write Sensors are advisory. A handler failure is reported
			// to stderr for diagnostics but must not block the completed Tool call.
			_, _ = fmt.Fprintln(stderr, "aidlc: Sensor Hook advisory failure: "+err.Error())
		}
		return 0

	case args[0] == "hook" && args[1] == "subagent":
		if len(args) != 3 && len(args) != 5 {
			return writeError(stderr, "Usage: aidlc hook subagent <project-dir> [--harness codex]")
		}
		harness := "codex"
		if len(args) == 5 {
			if args[3] != "--harness" || args[4] == "" {
				return writeError(stderr, "Usage: aidlc hook subagent <project-dir> [--harness codex]")
			}
			harness = args[4]
		}
		if options.Stdin == nil {
			return writeError(stderr, "aidlc: Hook input is unavailable on standard input")
		}
		resolvedCore, err := resolveCore()
		if err != nil {
			return writeError(stderr, err.Error())
		}
		result, err := hooksubagent.Validate(ctx, args[2], resolvedCore, options.Stdin, hooksubagent.Options{Harness: harness})
		outcome := string(result.Status)
		if err != nil {
			outcome = "handler-failed"
		}
		recordHookHealth(ctx, args[2], "subagent", "SubagentStop", outcome, err)
		content := hooksubagent.MarshalFailureResponse()
		if err == nil {
			content, err = hooksubagent.MarshalResponse(result)
			if err != nil {
				content = hooksubagent.MarshalFailureResponse()
			}
		}
		if _, err := stdout.Write(content); err != nil {
			return writeError(stderr, "aidlc: SubagentStop Hook: write response: "+err.Error())
		}
		return 0

	case args[0] == "hook" && args[1] == "status":
		if len(args) != 3 {
			return writeError(stderr, "Usage: aidlc hook status <project-dir>")
		}
		auditStatus, err := hookaudit.Inspect(args[2])
		if err != nil {
			return writeError(stderr, "aidlc: Hook Audit: "+err.Error())
		}
		result := struct {
			hookaudit.Status
			HandlerHealth     hookhealth.Status             `json:"handler_health"`
			Sensors           sensor.Status                 `json:"sensors"`
			DelegationResults hooksubagent.ReceiptInventory `json:"delegation_results"`
		}{Status: auditStatus, HandlerHealth: hookhealth.Status{Entries: []hookhealth.Entry{}}, Sensors: sensor.Status{}}
		inspection, inspectErr := state.InspectActive(args[2])
		if inspectErr == nil && inspection.Kind == state.InspectionVNext {
			result.HandlerHealth, err = hookhealth.Inspect(inspection.RecordDir)
			if err != nil {
				return writeError(stderr, "aidlc: Hook Health: "+err.Error())
			}
			result.Sensors, err = sensor.Inspect(inspection.RecordDir)
			if err != nil {
				return writeError(stderr, "aidlc: Sensor: "+err.Error())
			}
			result.DelegationResults, err = hooksubagent.InspectAll(args[2])
			if err != nil {
				return writeError(stderr, "aidlc: Delegation Receipt: "+err.Error())
			}
		}
		return writeJSON(stdout, stderr, result, true)
	default:
		return writeError(
			stderr,
			fmt.Sprintf("aidlc: command is not implemented: '%s %s'", args[0], args[1]),
		)
	}
	return writeError(stderr, fmt.Sprintf("aidlc: command is not implemented: '%s %s'", args[0], args[1]))
}

func stageRuntimeNoun(noun string) bool {
	switch noun {
	case "orient", "define-intent", "requirements", "architecture", "build-contract", "build", "review", "release", "outcome", "orchestrate", "human-gate":
		return true
	default:
		return false
	}
}

func recordHookHealth(ctx context.Context, projectDir, handler, sourceEvent, outcome string, handlerErr error) {
	if sourceEvent == "" || outcome == "" {
		return
	}
	failureCode := ""
	if handlerErr != nil {
		failureCode = "handler-error"
	}
	_ = hookhealth.Record(ctx, projectDir, hookhealth.Observation{
		Handler: handler, SourceEvent: sourceEvent, Succeeded: handlerErr == nil,
		Outcome: outcome, FailureCode: failureCode,
	})
}

func readStageContracts(directory string) ([]contract.StageContract, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("Stage Contract directory is not a directory: %s", directory)
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	contracts := make([]contract.StageContract, 0, len(names))
	for index, name := range names {
		content, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			return nil, err
		}
		value, err := contract.DecodeStageContract(content)
		if err != nil {
			return nil, fmt.Errorf("Stage Contract[%d] %s: %w", index, name, err)
		}
		contracts = append(contracts, value)
	}
	return contracts, nil
}

func readJSONFile[T any](path string) (T, error) {
	var zero T
	content, err := os.ReadFile(path)
	if err != nil {
		return zero, err
	}
	return jsonx.Decode[T](content)
}

func readOptionalJSON[T ~[]E, E any](args []string, index int) (T, error) {
	if len(args) <= index {
		return T{}, nil
	}
	return readJSONFile[T](args[index])
}

func readOptionalAcknowledgementsAndTime(args []string, index int) ([]gate.Acknowledgement, string, error) {
	acknowledgements := []gate.Acknowledgement{}
	if len(args) <= index {
		return acknowledgements, "", nil
	}
	if info, err := os.Stat(args[index]); err == nil && info.Mode().IsRegular() {
		value, readErr := readJSONFile[[]gate.Acknowledgement](args[index])
		if readErr != nil {
			return nil, "", readErr
		}
		decidedAt := ""
		if len(args) > index+1 {
			decidedAt = args[index+1]
		}
		return value, decidedAt, nil
	}
	if len(args) > index+1 {
		return acknowledgements, args[index+1], nil
	}
	return acknowledgements, args[index], nil
}

func runInstaller(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	projectDir := "."
	harness := "codex"
	dryRun := false
	jsonOutput := false
	for index := 1; index < len(args); index++ {
		switch args[index] {
		case "--project", "--harness":
			if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
				return writeError(stderr, args[index]+" requires a value")
			}
			if args[index] == "--project" {
				projectDir = args[index+1]
			} else {
				harness = args[index+1]
			}
			index++
		case "--dry-run":
			dryRun = true
		case "--json":
			jsonOutput = true
		default:
			return writeError(stderr, "Unknown option: "+args[index]+"\nUsage: aidlc <install|update> [--project <directory>] [--harness codex] [--dry-run] [--json]")
		}
	}
	result, err := installer.Run(ctx, installer.Options{Command: args[0], ProjectDir: projectDir, Harness: harness, DryRun: dryRun, ReleaseRoot: os.Getenv("AIDLC_RELEASE_ROOT"), ProjectRoot: os.Getenv("AIDLC_RAW_PROJECT_ROOT")})
	if err != nil {
		return writeError(stderr, err.Error())
	}
	if jsonOutput {
		code := writeJSON(stdout, stderr, result, true)
		if code != 0 {
			return code
		}
		if len(result.Conflicts) != 0 {
			return 1
		}
		return 0
	}
	if len(result.Conflicts) != 0 {
		_, _ = fmt.Fprintf(stderr, "AI-DLC %s stopped; existing files would be overwritten:\n", result.Command)
		for _, path := range result.Conflicts {
			_, _ = fmt.Fprintf(stderr, "  - %s\n", path)
		}
		return 1
	}
	action := "Installed"
	if result.DryRun {
		action = "Would install"
	}
	_, _ = fmt.Fprintf(stdout, "%s AI-DLC %s in %s\nNative CLI: ./%s\n%d file(s) written; %d unchanged; %d obsolete file(s) removed.\n", action, result.Version, result.Project, result.Executable, len(result.Written), len(result.Unchanged), len(result.Removed))
	return 0
}

func renderHelp(all bool) string {
	var builder strings.Builder
	builder.WriteString("aidlc <noun> <command> [args]\n\n")
	builder.WriteString("Common commands:\n")
	builder.WriteString("  aidlc next [args]       resolve the next Workflow action\n")
	builder.WriteString("  aidlc install [options] install AI-DLC into a Project\n")
	builder.WriteString("  aidlc update [options]  safely update an installed Project\n")
	builder.WriteString("  aidlc doctor check      diagnose the active Workspace\n")
	builder.WriteString("  aidlc state resume      show the persisted resume point\n")
	builder.WriteString("  aidlc --help            show this help\n")
	builder.WriteString("  aidlc --version         show the AI-DLC version\n")
	if all {
		builder.WriteString("\nAll command groups:\n")
		for _, route := range routes {
			_, _ = fmt.Fprintf(
				&builder,
				"  %-18s %s — %s\n",
				route.Noun,
				strings.Join(route.Commands, ", "),
				route.Summary,
			)
		}
	}
	return builder.String()
}

func writeJSON(stdout, stderr io.Writer, value any, pretty bool) int {
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	if pretty {
		encoder.SetIndent("", "  ")
	}
	if err := encoder.Encode(value); err != nil {
		return writeError(stderr, fmt.Sprintf("aidlc: write JSON: %v", err))
	}
	return 0
}

func writeError(stderr io.Writer, message string) int {
	_, _ = fmt.Fprintln(stderr, message)
	return 1
}

func findRoute(noun string) (route, bool) {
	for _, candidate := range routes {
		if candidate.Noun == noun {
			return candidate, true
		}
	}
	return route{}, false
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
