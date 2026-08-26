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
	"github.com/sori883/aidlc/internal/installer"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/platform/runtimepath"
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
	CoreDir string
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
	{Noun: "delegation", Commands: []string{"show", "validate"}, Summary: "inspect and validate fixed vNext Stage Agent assignments"},
	{Noun: "graph", Commands: []string{"show", "catalog", "validate"}, Summary: "inspect the fixed vNext Catalog and Graph"},
	{Noun: "intent", Commands: []string{"birth", "list", "switch", "risk"}, Summary: "create and select Intents or manage the active Intent Risk Register"},
	{Noun: "orchestrate", Commands: []string{"next"}, Summary: "resolve the next Core-owned vNext action"},
	{Noun: "orient", Commands: []string{"prepare", "complete"}, Summary: "prepare and validate ST-01 Orient work"},
	{Noun: "outcome", Commands: []string{"prepare", "evaluate", "decide", "reuse"}, Summary: "observe, evaluate, and complete terminal ST-09 Outcome work"},
	{Noun: "plan", Commands: []string{"show", "revise"}, Summary: "inspect or revise the Core-owned Stage Execution Plan"},
	{Noun: "requirements", Commands: []string{"prepare", "complete"}, Summary: "prepare and validate ST-03 Requirements work"},
	{Noun: "release", Commands: []string{"prepare", "review", "authorize", "execute", "reuse"}, Summary: "plan, authorize, execute, or verify reuse of ST-08 Release results"},
	{Noun: "review", Commands: []string{"prepare", "approve", "feedback"}, Summary: "prepare and decide ST-07 Candidate review work"},
	{Noun: "space", Commands: []string{"create", "list", "switch"}, Summary: "create and select Spaces"},
	{Noun: "state", Commands: []string{"show", "resume", "check"}, Summary: "inspect the Core-owned vNext State"},
	{Noun: "workspace", Commands: []string{"init"}, Summary: "initialize an AI-DLC Workspace"},
}

// Run executes the Stage 2 Go CLI.
func Run(args []string, stdout, stderr io.Writer) int {
	return RunWithOptions(args, stdout, stderr, Options{})
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
		decision, err := risk.DecodeDecision(content)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		register, err := risk.Decide(ctx, args[3], snapshot.RecordDir, decision, "")
		if err != nil {
			return writeError(stderr, err.Error())
		}
		if _, err := audit.Append(ctx, args[3], snapshot.RecordDir, audit.DecisionRecorded, []audit.Field{{Name: "Decision", Value: string(decision.Action)}, {Name: "Risk", Value: decision.RiskID}, {Name: "Revision", Value: fmt.Sprint(register.Revision)}, {Name: "Decision Authority", Value: "human"}}, nil); err != nil {
			return writeError(stderr, err.Error())
		}
		return writeJSON(stdout, stderr, struct {
			Register risk.Register `json:"register"`
		}{register}, true)

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
			if len(args) < 5 || len(args) > 6 {
				return writeError(stderr, "Usage: aidlc architecture policy-approve <project-dir> <proposal-sha256> <reason> [acknowledgements.json]")
			}
			acks, err := readOptionalJSON[[]gate.Acknowledgement](args, 5)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			result, err := st04architecture.ApprovePolicy(ctx, args[2], resolvedCore, args[3], args[4], acks, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
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
			if len(args) < 5 || len(args) > 6 {
				return writeError(stderr, "Usage: aidlc build-contract approve <project-dir> <candidate-sha256> <reason> [acknowledgements.json]")
			}
			acks, err := readOptionalJSON[[]gate.Acknowledgement](args, 5)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			result, err := st05buildcontract.Approve(ctx, args[2], resolvedCore, args[3], args[4], acks, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
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
			if len(args) < 5 || len(args) > 7 {
				return writeError(stderr, "Usage: aidlc review approve <project-dir> <manifest-sha256> <reason> [human-checks.json] [acknowledgements.json]")
			}
			checks, err := readOptionalJSON[[]st07review.HumanCheckResult](args, 5)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			acks, err := readOptionalJSON[[]gate.Acknowledgement](args, 6)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			result, err := st07review.Approve(ctx, args[2], resolvedCore, args[3], args[4], checks, acks, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
		case "feedback":
			if len(args) != 6 {
				return writeError(stderr, "Usage: aidlc review feedback <project-dir> <manifest-sha256> <feedback.json> <reason>")
			}
			items, err := readJSONFile[[]st07review.FeedbackItem](args[4])
			if err != nil {
				return writeError(stderr, err.Error())
			}
			result, err := st07review.Feedback(ctx, args[2], resolvedCore, args[3], args[5], items, []st07review.HumanCheckResult{}, "")
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
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
			if len(args) < 5 || len(args) > 7 {
				return writeError(stderr, "Usage: aidlc release authorize <project-dir> <plan-sha256> <reason> [acknowledgements.json] [decided-at]")
			}
			acks, decidedAt, err := readOptionalAcknowledgementsAndTime(args, 5)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			result, err := st08release.Authorize(ctx, args[2], resolvedCore, args[3], args[4], acks, decidedAt)
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
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
			if len(args) < 6 || len(args) > 10 {
				return writeError(stderr, "Usage: aidlc outcome decide <project-dir> <evaluation-sha256> <decision> <reason> [acknowledgements.json] [not-before] [deadline] [decided-at]")
			}
			acks := []gate.Acknowledgement{}
			optionalIndex := 6
			if len(args) > optionalIndex {
				if info, statErr := os.Stat(args[optionalIndex]); statErr == nil && info.Mode().IsRegular() {
					acks, err = readJSONFile[[]gate.Acknowledgement](args[optionalIndex])
					if err != nil {
						return writeError(stderr, err.Error())
					}
					optionalIndex++
				}
			}
			var notBefore, deadline *string
			if len(args) > optionalIndex {
				notBefore = &args[optionalIndex]
			}
			if len(args) > optionalIndex+1 {
				deadline = &args[optionalIndex+1]
			}
			decidedAt := ""
			if len(args) > optionalIndex+2 {
				decidedAt = args[optionalIndex+2]
			}
			result, err := st09outcome.Decide(ctx, args[2], resolvedCore, st09outcome.DecideOptions{EvaluationSHA256: args[3], Decision: args[4], Reason: args[5], PolicyAcknowledgements: acks, NotBefore: notBefore, Deadline: deadline, DecidedAt: decidedAt})
			if err != nil {
				return writeError(stderr, err.Error())
			}
			return writeJSON(stdout, stderr, result, true)
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
	case "orient", "define-intent", "requirements", "architecture", "build-contract", "build", "review", "release", "outcome", "orchestrate":
		return true
	default:
		return false
	}
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
