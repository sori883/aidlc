// Package intent manages vNext Intent identity, registry, and active cursor.
package intent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/workflow/catalog"
	workflowplan "github.com/sori883/aidlc/internal/workflow/plan"
	"github.com/sori883/aidlc/internal/workflow/policy"
	"github.com/sori883/aidlc/internal/workflow/risk"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

const activePointer = "active-intent"

var (
	hexSuffix = regexp.MustCompile(`^[0-9a-f]+$`)
	datedName = regexp.MustCompile(`^\d{6}-(.+)$`)
	trimUUID  = regexp.MustCompile(`-`)
)

// RegistryEntry is the portable intents.json record.
type RegistryEntry struct {
	UUID    string   `json:"uuid"`
	Slug    string   `json:"slug"`
	DirName string   `json:"dirName,omitempty"`
	Repos   []string `json:"repos,omitempty"`
	Status  string   `json:"status"`
}

// Info joins registry and on-disk state for list/switch.
type Info struct {
	UUID    string
	Slug    string
	Status  string
	Repos   []string
	DirName string
	Active  bool
}

// Born is the identity portion of one newly-created Intent.
type Born struct {
	UUID      string
	Slug      string
	DirName   string
	RecordDir string
	Space     string
}

// BornWithState is a fully initialized vNext Intent.
type BornWithState struct {
	UUID            string                      `json:"uuid"`
	Slug            string                      `json:"slug"`
	DirName         string                      `json:"dirName"`
	RecordDir       string                      `json:"recordDir"`
	Space           string                      `json:"space"`
	State           state.IntentState           `json:"state"`
	Plan            contract.StageExecutionPlan `json:"plan"`
	PolicyPath      string                      `json:"policyPath"`
	AuditPath       string                      `json:"auditPath"`
	DesignBriefPath string                      `json:"designBriefPath"`
	RiskCurrentPath string                      `json:"riskCurrentPath"`
}

// BirthWorkflowOptions injects identity, clock, repositories, and initial Risks.
type BirthWorkflowOptions struct {
	Identity Options
	Repos    []string
	Risks    []risk.Seed
}

// Options injects nondeterministic sources for tests.
type Options struct {
	Clock func() time.Time
	UUID  func() (string, error)
}

// DesignBrief is the immutable initial purpose artifact.
type DesignBrief struct {
	SchemaVersion int    `json:"schema_version"`
	Artifact      string `json:"artifact"`
	Version       int    `json:"version"`
	IntentID      string `json:"intent_id"`
	Statement     string `json:"statement"`
	CreatedAt     string `json:"created_at"`
}

// Dir returns the Intent collection for a Space.
func Dir(projectDir, selectedSpace string) string {
	if selectedSpace == "" {
		selectedSpace = workspace.ActiveSpace(projectDir)
	}
	return filepath.Join(workspace.Root(projectDir), "spaces", selectedSpace, "intents")
}

// UUIDv7 returns a crypto/rand-backed RFC 9562 UUIDv7 identifier.
func UUIDv7() (string, error) {
	content := make([]byte, 16)
	if _, err := rand.Read(content); err != nil {
		return "", fmt.Errorf("generate Intent UUID: %w", err)
	}
	now := uint64(time.Now().UnixMilli())
	return uuidV7From(now, content), nil
}

// DateStamp renders the UTC YYMMDD prefix used by record directories.
func DateStamp(value time.Time) string {
	return value.UTC().Format("060102")
}

// ReadRegistry preserves the existing absent-or-malformed-as-empty behavior.
func ReadRegistry(projectDir, selectedSpace string) []RegistryEntry {
	content, err := os.ReadFile(filepath.Join(Dir(projectDir, selectedSpace), "intents.json"))
	if err != nil {
		return []RegistryEntry{}
	}
	var entries []RegistryEntry
	if err := json.Unmarshal(content, &entries); err != nil || entries == nil {
		return []RegistryEntry{}
	}
	return entries
}

// Active resolves the cursor only when its state summary binding exists.
func Active(projectDir, selectedSpace string) string {
	root := Dir(projectDir, selectedSpace)
	if content, err := os.ReadFile(filepath.Join(root, activePointer)); err == nil {
		selected := strings.TrimSpace(string(content))
		if selected != "" && regularFile(filepath.Join(root, selected, "aidlc-state.md")) {
			return selected
		}
	}
	records := listRecordDirs(root)
	if len(records) == 1 {
		return records[0]
	}
	return ""
}

// List joins registry records with valid state directories.
func List(projectDir, selectedSpace string) []Info {
	if selectedSpace == "" {
		selectedSpace = workspace.ActiveSpace(projectDir)
	}
	registry := ReadRegistry(projectDir, selectedSpace)
	directories := listRecordDirs(Dir(projectDir, selectedSpace))
	selected := Active(projectDir, selectedSpace)
	claimed := make(map[string]struct{})
	result := make([]Info, 0, len(registry)+len(directories))
	for _, entry := range registry {
		dirName := ""
		for _, candidate := range directories {
			if recordMatches(entry, candidate) {
				dirName = candidate
				claimed[candidate] = struct{}{}
				break
			}
		}
		result = append(result, Info{
			UUID: entry.UUID, Slug: entry.Slug, Status: entry.Status,
			Repos: append([]string(nil), entry.Repos...), DirName: dirName, Active: dirName != "" && dirName == selected,
		})
	}
	for _, directory := range directories {
		if _, ok := claimed[directory]; ok {
			continue
		}
		result = append(result, Info{Slug: displaySlug(directory), Status: "unknown", DirName: directory, Active: directory == selected})
	}
	return result
}

// Switch selects an Intent by exact directory or unambiguous slug.
func Switch(ctx context.Context, projectDir, target, selectedSpace string) (Info, error) {
	if selectedSpace == "" {
		selectedSpace = workspace.ActiveSpace(projectDir)
	}
	intents := List(projectDir, selectedSpace)
	var match *Info
	for index := range intents {
		if intents[index].DirName == target {
			copy := intents[index]
			match = &copy
			break
		}
	}
	if match == nil {
		var bySlug []Info
		for _, candidate := range intents {
			if candidate.Slug == target && candidate.DirName != "" {
				bySlug = append(bySlug, candidate)
			}
		}
		if len(bySlug) > 1 {
			names := make([]string, 0, len(bySlug))
			for _, candidate := range bySlug {
				names = append(names, candidate.DirName)
			}
			return Info{}, fmt.Errorf("Ambiguous intent %q in space %q (%d matches). Use a full record directory name: %s", target, selectedSpace, len(bySlug), strings.Join(names, ", "))
		}
		if len(bySlug) == 1 {
			copy := bySlug[0]
			match = &copy
		}
	}
	if match == nil || match.DirName == "" {
		return Info{}, fmt.Errorf("Unknown intent %q in space %q", target, selectedSpace)
	}
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return Info{}, err
	}
	if _, err := fsx.ResolveUnder(projectRoot, "aidlc/spaces/"+selectedSpace+"/intents", false); err != nil {
		return Info{}, fmt.Errorf("resolve Intent collection safely: %w", err)
	}
	err = lock.With(ctx, projectDir, lock.Options{}, func(context.Context) error {
		return setActiveUnlocked(projectDir, selectedSpace, match.DirName)
	})
	if err != nil {
		return Info{}, err
	}
	match.Active = true
	return *match, nil
}

// BirthRecord creates identity and registry state. Workflow State, Policy, and
// Plan initialization are deliberately connected by Workflow Core in Stage 4.
func BirthRecord(ctx context.Context, projectDir, label, selectedSpace string, repos []string, options Options) (Born, error) {
	if err := validateLabel(label); err != nil {
		return Born{}, err
	}
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return Born{}, err
	}
	if selectedSpace == "" {
		selectedSpace = workspace.ActiveSpace(projectRoot)
	}
	var born Born
	err = lock.With(ctx, projectRoot, lock.Options{}, func(lockContext context.Context) error {
		spaceDir := filepath.Join(workspace.Root(projectRoot), "spaces", selectedSpace)
		info, err := os.Lstat(spaceDir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Space %q does not exist in %s. Initialize the workspace first", selectedSpace, workspace.Root(projectRoot))
		}
		slug := workspace.Slugify(label, 24)
		if workspace.IsReservedName(slug) {
			return fmt.Errorf("%q is a reserved name and cannot be an intent label", slug)
		}
		uuidSource := options.UUID
		if uuidSource == nil {
			uuidSource = UUIDv7
		}
		uuid, err := uuidSource()
		if err != nil {
			return err
		}
		clock := options.Clock
		now := time.Now()
		if clock != nil {
			now = clock()
		}
		root := Dir(projectRoot, selectedSpace)
		if _, err := fsx.EnsureDirUnder(projectRoot, "aidlc/spaces/"+selectedSpace+"/intents", 0o755); err != nil {
			return err
		}
		dirName, recordDir, err := createUnique(root, DateStamp(now)+"-"+slug)
		if err != nil {
			return err
		}
		complete := false
		defer func() {
			if !complete {
				_ = os.RemoveAll(recordDir)
			}
		}()
		stateSummary := filepath.Join(recordDir, "aidlc-state.md")
		file, err := os.OpenFile(stateSummary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return err
		}
		if _, err := file.WriteString("# AI-DLC State Tracking\n"); err != nil {
			_ = file.Close()
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
		entry := RegistryEntry{UUID: uuid, Slug: slug, DirName: dirName, Repos: append([]string(nil), repos...), Status: "in-flight"}
		if err := appendRegistryUnlocked(projectRoot, selectedSpace, entry); err != nil {
			return err
		}
		if err := setActiveUnlocked(projectRoot, selectedSpace, dirName); err != nil {
			return err
		}
		born = Born{UUID: uuid, Slug: slug, DirName: dirName, RecordDir: recordDir, Space: selectedSpace}
		complete = true
		return nil
	})
	return born, err
}

// BirthWithState creates a complete vNext Intent and lets Core persist the safe
// initial route. It never converts or overwrites an existing Intent.
func BirthWithState(ctx context.Context, projectDir, coreDir, label, selectedSpace string, options BirthWorkflowOptions) (BornWithState, error) {
	if err := validateLabel(label); err != nil {
		return BornWithState{}, err
	}
	definitions, err := catalog.Load(coreDir)
	if err != nil {
		return BornWithState{}, err
	}
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return BornWithState{}, err
	}
	if selectedSpace == "" {
		selectedSpace = workspace.ActiveSpace(projectRoot)
	}
	var result BornWithState
	err = lock.With(ctx, projectRoot, lock.Options{}, func(lockContext context.Context) error {
		born, err := BirthRecord(lockContext, projectRoot, label, selectedSpace, options.Repos, options.Identity)
		if err != nil {
			return err
		}
		now := time.Now()
		if options.Identity.Clock != nil {
			now = options.Identity.Clock()
		}
		startedAt := now.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		clock := func() time.Time { return now }
		auditPath, err := audit.Initialize(lockContext, projectRoot, born.RecordDir)
		if err != nil {
			return err
		}
		if _, err := audit.Append(lockContext, projectRoot, born.RecordDir, audit.WorkflowStarted, []audit.Field{{Name: "Workflow", Value: "vNext"}, {Name: "Request", Value: "/aidlc " + label}}, clock); err != nil {
			return err
		}
		if err := EnsureBirthDirectories(projectRoot, born.RecordDir, selectedSpace, []string{"artifacts"}); err != nil {
			return err
		}
		if _, err := audit.Append(lockContext, projectRoot, born.RecordDir, audit.WorkspaceScaffolded, []audit.Field{{Name: "Request", Value: "/aidlc " + label}, {Name: "Details", Value: "vNext Intent record and artifact directories ensured"}}, clock); err != nil {
			return err
		}
		designBriefPath, err := WriteDesignBrief(born.RecordDir, born.UUID, label, startedAt)
		if err != nil {
			return err
		}
		writtenPolicy, err := policy.Write(projectRoot, born.RecordDir, born.UUID, policy.BuildOptions{CreatedAt: startedAt})
		if err != nil {
			return err
		}
		if _, err := audit.Append(lockContext, projectRoot, born.RecordDir, audit.PolicySnapshotCreated, []audit.Field{{Name: "Snapshot ID", Value: writtenPolicy.Snapshot.SnapshotID}, {Name: "Revision", Value: fmt.Sprint(writtenPolicy.Snapshot.Revision)}, {Name: "Source Priority", Value: "org > team > project"}}, clock); err != nil {
			return err
		}
		writtenRisk, err := risk.Initialize(lockContext, projectRoot, born.RecordDir, born.UUID, risk.Options{Risks: options.Risks, CreatedAt: startedAt})
		if err != nil {
			return err
		}
		if _, err := audit.Append(lockContext, projectRoot, born.RecordDir, audit.DecisionRecorded, []audit.Field{{Name: "Decision", Value: "Intent Risk Register Created"}, {Name: "Revision", Value: fmt.Sprint(writtenRisk.Register.Revision)}, {Name: "Risk Count", Value: fmt.Sprint(len(writtenRisk.Register.Risks))}, {Name: "Decision Authority", Value: "core"}}, clock); err != nil {
			return err
		}
		executionPlan, err := workflowplan.Initial(born.UUID, definitions.Graph.GraphVersion, writtenPolicy.Reference)
		if err != nil {
			return err
		}
		initialized, err := state.Initialize(lockContext, projectRoot, born.RecordDir, state.InitializeOptions{IntentID: born.UUID, CatalogVersion: definitions.Catalog.CatalogVersion, GraphVersion: definitions.Graph.GraphVersion, PolicySnapshot: writtenPolicy.Reference, Plan: executionPlan, CreatedAt: startedAt})
		if err != nil {
			return err
		}
		if _, err := audit.Append(lockContext, projectRoot, born.RecordDir, audit.PlanCreated, []audit.Field{{Name: "Revision", Value: fmt.Sprint(executionPlan.Revision)}, {Name: "Decision Authority", Value: "core"}, {Name: "Stage Count", Value: fmt.Sprint(len(executionPlan.StageDecisions))}, {Name: "Safe Default", Value: "execute"}}, clock); err != nil {
			return err
		}
		if _, err := audit.Append(lockContext, projectRoot, born.RecordDir, audit.RouteDecided, []audit.Field{{Name: "Current Stage", Value: string(initialized.State.CurrentStage)}, {Name: "Graph", Value: initialized.State.GraphVersion}, {Name: "Decision Authority", Value: "core"}}, clock); err != nil {
			return err
		}
		result = BornWithState{
			UUID: born.UUID, Slug: born.Slug, DirName: born.DirName, RecordDir: born.RecordDir, Space: born.Space,
			State: initialized.State, Plan: executionPlan, PolicyPath: writtenPolicy.Path,
			AuditPath: auditPath, DesignBriefPath: designBriefPath, RiskCurrentPath: risk.CurrentPath(born.RecordDir),
		}
		return nil
	})
	return result, err
}

// EnsureBirthDirectories materializes the lazy per-Intent directories.
func EnsureBirthDirectories(projectDir, recordDir, selectedSpace string, phases []string) error {
	projectRoot, err := filepath.Abs(projectDir)
	if err != nil {
		return err
	}
	recordRelative, err := filepath.Rel(projectRoot, recordDir)
	if err != nil || recordRelative == ".." || strings.HasPrefix(recordRelative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("Intent record must be inside the Project: %s", recordDir)
	}
	for _, phase := range phases {
		if phase == "" || strings.ContainsAny(phase, "/\\") {
			return fmt.Errorf("invalid Intent phase directory: %q", phase)
		}
		if _, err := fsx.EnsureDirUnder(projectRoot, filepath.ToSlash(filepath.Join(recordRelative, phase)), 0o755); err != nil {
			return err
		}
	}
	for _, relative := range []string{
		filepath.ToSlash(filepath.Join(recordRelative, "verification")),
		"aidlc/spaces/" + selectedSpace + "/knowledge",
	} {
		if _, err := fsx.EnsureDirUnder(projectRoot, relative, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// WriteDesignBrief writes the canonical immutable initial purpose artifact.
func WriteDesignBrief(recordDir, intentID, statement, createdAt string) (string, error) {
	if err := validateLabel(statement); err != nil {
		return "", err
	}
	brief := DesignBrief{SchemaVersion: 1, Artifact: "design-brief", Version: 1, IntentID: intentID, Statement: statement, CreatedAt: createdAt}
	content, err := jsonx.MarshalCanonical(brief)
	if err != nil {
		return "", err
	}
	artifacts := filepath.Join(recordDir, "artifacts")
	if err := os.MkdirAll(artifacts, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(artifacts, "design-brief.json")
	if err := fsx.AtomicWriteFile(path, content, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func appendRegistryUnlocked(projectDir, selectedSpace string, entry RegistryEntry) error {
	root := Dir(projectDir, selectedSpace)
	registry := ReadRegistry(projectDir, selectedSpace)
	registry = append(registry, entry)
	content, err := jsonx.MarshalCanonical(registry)
	if err != nil {
		return err
	}
	return fsx.AtomicWriteFile(filepath.Join(root, "intents.json"), content, 0o644)
}

func setActiveUnlocked(projectDir, selectedSpace, dirName string) error {
	if dirName == "" || strings.ContainsAny(dirName, "/\\\x00") {
		return fmt.Errorf("invalid active Intent directory: %q", dirName)
	}
	root := Dir(projectDir, selectedSpace)
	return fsx.AtomicWriteFile(filepath.Join(root, activePointer), []byte(dirName+"\n"), 0o644)
}

func listRecordDirs(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return []string{}
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() && regularFile(filepath.Join(root, entry.Name(), "aidlc-state.md")) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

func createUnique(root, base string) (string, string, error) {
	for attempt := 1; attempt < 1000; attempt++ {
		dirName := base
		if attempt > 1 {
			dirName = fmt.Sprintf("%s-%d", base, attempt)
		}
		recordDir := filepath.Join(root, dirName)
		if err := os.Mkdir(recordDir, 0o755); err == nil {
			return dirName, recordDir, nil
		} else if !errors.Is(err, fs.ErrExist) {
			return "", "", err
		}
	}
	return "", "", fmt.Errorf("Could not find a free intent record directory for %q in %s", base, root)
}

func recordMatches(entry RegistryEntry, dirName string) bool {
	if entry.DirName != "" {
		return entry.DirName == dirName
	}
	if !strings.HasPrefix(dirName, entry.Slug+"-") {
		return false
	}
	suffix := strings.TrimPrefix(dirName, entry.Slug+"-")
	uuid := trimUUID.ReplaceAllString(entry.UUID, "")
	return hexSuffix.MatchString(suffix) && len(suffix) <= len(uuid) && strings.HasSuffix(uuid, suffix)
}

func displaySlug(dirName string) string {
	if match := datedName.FindStringSubmatch(dirName); match != nil {
		return match[1]
	}
	parts := strings.Split(dirName, "-")
	if len(parts) > 1 && hexSuffix.MatchString(parts[len(parts)-1]) {
		return strings.Join(parts[:len(parts)-1], "-")
	}
	return dirName
}

func regularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func validateLabel(label string) error {
	if label == "" || strings.TrimSpace(label) != label || strings.ContainsAny(label, "\r\n\x00") {
		return fmt.Errorf("Intent label must be a non-empty single-line Design Brief")
	}
	return nil
}

func uuidV7From(milliseconds uint64, random []byte) string {
	content := make([]byte, 16)
	copy(content, random)
	content[0] = byte(milliseconds >> 40)
	content[1] = byte(milliseconds >> 32)
	content[2] = byte(milliseconds >> 24)
	content[3] = byte(milliseconds >> 16)
	content[4] = byte(milliseconds >> 8)
	content[5] = byte(milliseconds)
	content[6] = (content[6] & 0x0f) | 0x70
	content[8] = (content[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(content)
	return hexValue[:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:]
}
