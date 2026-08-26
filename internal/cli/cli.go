package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/intent"
	"github.com/sori883/aidlc/internal/platform/runtimepath"
	"github.com/sori883/aidlc/internal/space"
	"github.com/sori883/aidlc/internal/version"
	"github.com/sori883/aidlc/internal/workflow/catalog"
	"github.com/sori883/aidlc/internal/workflow/delegation"
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
		created, err := space.Create(context.Background(), args[2], args[3], filepath.Join(resolvedCore, "memory"))
		if err != nil {
			return writeError(stderr, err.Error())
		}
		_, _ = fmt.Fprintf(stdout, "Space created: %s\n", created.Name)
		return 0

	case args[0] == "space" && args[1] == "switch":
		if len(args) != 4 {
			return writeError(stderr, "Usage: aidlc-space list <project-dir> [--json]\n       aidlc-space create <project-dir> <name>\n       aidlc-space switch <project-dir> <name>")
		}
		selected, err := space.Switch(context.Background(), args[2], args[3])
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
		selected, err := intent.Switch(context.Background(), args[2], args[3], selectedSpace)
		if err != nil {
			return writeError(stderr, err.Error())
		}
		_, _ = fmt.Fprintf(stdout, "Active intent → %s (space: %s)\n", selected.DirName, selectedSpace)
		return 0
	default:
		return writeError(
			stderr,
			fmt.Sprintf("aidlc: Go migration Stage 2 does not implement '%s %s'", args[0], args[1]),
		)
	}
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
