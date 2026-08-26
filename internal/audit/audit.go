// Package audit implements append-only clone-local Audit shards.
package audit

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/workspace"
)

// CloneIDFile is the clone-local identity pointer.
const CloneIDFile = ".aidlc-clone-id"

// Event is one allowed Audit event identifier.
type Event string

const (
	WorkflowStarted       Event = "WORKFLOW_STARTED"
	WorkflowCompleted     Event = "WORKFLOW_COMPLETED"
	PhaseStarted          Event = "PHASE_STARTED"
	PhaseCompleted        Event = "PHASE_COMPLETED"
	PhaseVerified         Event = "PHASE_VERIFIED"
	PhaseSkipped          Event = "PHASE_SKIPPED"
	StageStarted          Event = "STAGE_STARTED"
	StageAwaitingApproval Event = "STAGE_AWAITING_APPROVAL"
	GateApproved          Event = "GATE_APPROVED"
	GateRejected          Event = "GATE_REJECTED"
	StageRevising         Event = "STAGE_REVISING"
	StageCompleted        Event = "STAGE_COMPLETED"
	StageSkipped          Event = "STAGE_SKIPPED"
	DecisionRecorded      Event = "DECISION_RECORDED"
	QuestionAnswered      Event = "QUESTION_ANSWERED"
	PracticesDiscovered   Event = "PRACTICES_DISCOVERED"
	PracticesAffirmed     Event = "PRACTICES_AFFIRMED"
	PracticesOverride     Event = "PRACTICES_OVERRIDE"
	PracticesSectionEmpty Event = "PRACTICES_SECTION_EMPTY"
	SensorFired           Event = "SENSOR_FIRED"
	SensorPassed          Event = "SENSOR_PASSED"
	SensorFailed          Event = "SENSOR_FAILED"
	SensorBudgetOverride  Event = "SENSOR_BUDGET_OVERRIDE"
	BoltStarted           Event = "BOLT_STARTED"
	BoltCompleted         Event = "BOLT_COMPLETED"
	BoltFailed            Event = "BOLT_FAILED"
	AutonomyModeSet       Event = "AUTONOMY_MODE_SET"
	RuleLearned           Event = "RULE_LEARNED"
	Recomposed            Event = "RECOMPOSED"
	WorktreeCreated       Event = "WORKTREE_CREATED"
	WorktreeMerged        Event = "WORKTREE_MERGED"
	WorktreeDiscarded     Event = "WORKTREE_DISCARDED"
	DoctorRepaired        Event = "DOCTOR_REPAIRED"
	WorkspaceScaffolded   Event = "WORKSPACE_SCAFFOLDED"
	WorkspaceScanned      Event = "WORKSPACE_SCANNED"
	WorkspaceInitialised  Event = "WORKSPACE_INITIALISED"
	PolicySnapshotCreated Event = "POLICY_SNAPSHOT_CREATED"
	PlanCreated           Event = "PLAN_CREATED"
	PlanRevised           Event = "PLAN_REVISED"
	RouteDecided          Event = "ROUTE_DECIDED"
	RouteBlocked          Event = "ROUTE_BLOCKED"
)

var headings = map[Event]string{
	WorkflowStarted: "Workflow Start", WorkflowCompleted: "Workflow Completion",
	PhaseStarted: "Phase Start", PhaseCompleted: "Phase Completion", PhaseVerified: "Phase Verification", PhaseSkipped: "Phase Skip",
	StageStarted: "Stage Start", StageAwaitingApproval: "Stage Awaiting Approval", GateApproved: "Gate Approved", GateRejected: "Gate Rejected",
	StageRevising: "Stage Revising", StageCompleted: "Stage Completion", StageSkipped: "Stage Skip",
	DecisionRecorded: "Decision Recorded", QuestionAnswered: "Question Answered",
	PracticesDiscovered: "Practices Discovered", PracticesAffirmed: "Practices Affirmed", PracticesOverride: "Practices Override", PracticesSectionEmpty: "Practices Section Empty",
	SensorFired: "Sensor Fired", SensorPassed: "Sensor Passed", SensorFailed: "Sensor Failed", SensorBudgetOverride: "Sensor Budget Override",
	BoltStarted: "Bolt Start", BoltCompleted: "Bolt Completion", BoltFailed: "Bolt Failure", AutonomyModeSet: "Construction Autonomy Mode Set",
	RuleLearned: "Rule Learned", Recomposed: "Execution Plan Recomposed", WorktreeCreated: "Worktree Created", WorktreeMerged: "Worktree Merged", WorktreeDiscarded: "Worktree Discarded",
	DoctorRepaired: "Doctor Repair", WorkspaceScaffolded: "Workspace Scaffolded", WorkspaceScanned: "Workspace Scanned", WorkspaceInitialised: "Workspace Initialised",
	PolicySnapshotCreated: "Effective Policy Snapshot Created", PlanCreated: "Stage Execution Plan Created", PlanRevised: "Stage Execution Plan Revised",
	RouteDecided: "Core Route Decision", RouteBlocked: "Core Route Blocked",
}

var (
	clonePattern = regexp.MustCompile(`^[a-z0-9]{1,32}$`)
	hostPattern  = regexp.MustCompile(`[^a-z0-9-]+`)
	sequenceLine = regexp.MustCompile(`^\*\*Sequence\*\*:[ \t]*(\d+)[ \t]*$`)
	fieldLine    = regexp.MustCompile(`^\*\*([^*]+)\*\*:[ \t]*(.*)$`)
	cloneSuffix  = regexp.MustCompile(`-([a-z0-9]{1,32})\.md$`)
	cacheMu      sync.Mutex
	cloneIDs     = make(map[string]string)
	shardNames   = make(map[string]string)
)

// Field preserves the contract-defined output order.
type Field struct {
	Name  string
	Value string
}

// BatchEntry is one event in an atomic related append.
type BatchEntry struct {
	Event  Event
	Fields []Field
}

// AppendResult describes one appended event.
type AppendResult struct {
	Appended  bool
	Event     Event
	Timestamp string
	CloneID   string
	Sequence  int
	Path      string
}

// BatchResult describes an appended related sequence.
type BatchResult struct {
	Appended  bool
	Events    []Event
	Timestamp string
	CloneID   string
	Sequences []int
	Path      string
}

// OrderedEntry is one parsed Audit block.
type OrderedEntry struct {
	Event          string
	Timestamp      string
	CloneID        string
	Sequence       int
	LegacySequence bool
	Fields         map[string]string
	Path           string
	Block          string
}

// Clock supplies a deterministic timestamp in tests.
type Clock func() time.Time

// CloneIDPath returns the clone-local identity file.
func CloneIDPath(projectDir string) string {
	return filepath.Join(workspace.Root(projectDir), CloneIDFile)
}

// CloneID returns or creates the stable clone-local identity.
func CloneID(projectDir string) string {
	projectRoot, _ := filepath.Abs(projectDir)
	projectRoot = filepath.Clean(projectRoot)
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if cached := cloneIDs[projectRoot]; cached != "" {
		return cached
	}
	path := CloneIDPath(projectRoot)
	info, statErr := os.Lstat(path)
	if content, err := os.ReadFile(path); statErr == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && err == nil {
		value := strings.TrimSpace(string(content))
		if clonePattern.MatchString(value) {
			cloneIDs[projectRoot] = value
			return value
		}
	}
	minted := randomHex(6)
	settled := minted
	if parent, err := os.Lstat(filepath.Dir(path)); err == nil && parent.IsDir() && parent.Mode()&os.ModeSymlink == 0 {
		if file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644); err == nil {
			_, writeErr := file.WriteString(minted + "\n")
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				_ = os.Remove(path)
			}
			if content, err := os.ReadFile(path); err == nil && clonePattern.MatchString(strings.TrimSpace(string(content))) {
				settled = strings.TrimSpace(string(content))
			}
		}
	}
	cloneIDs[projectRoot] = settled
	return settled
}

// ShardName returns the host-and-clone shard name.
func ShardName(projectDir string) string {
	projectRoot, _ := filepath.Abs(projectDir)
	projectRoot = filepath.Clean(projectRoot)
	cacheMu.Lock()
	if cached := shardNames[projectRoot]; cached != "" {
		cacheMu.Unlock()
		return cached
	}
	cacheMu.Unlock()
	host, _ := os.Hostname()
	host = strings.ToLower(host)
	host = hostPattern.ReplaceAllString(host, "-")
	host = strings.Trim(host, "-")
	if len(host) > 48 {
		host = strings.TrimRight(host[:48], "-")
	}
	if host == "" {
		host = "host"
	}
	name := host + "-" + CloneID(projectRoot) + ".md"
	cacheMu.Lock()
	shardNames[projectRoot] = name
	cacheMu.Unlock()
	return name
}

// FilePath returns the current clone's Intent shard path.
func FilePath(projectDir, recordDir string) string {
	absoluteRecord, _ := filepath.Abs(recordDir)
	return filepath.Join(filepath.Clean(absoluteRecord), "audit", ShardName(projectDir))
}

// Initialize ensures the current shard exists with its canonical header.
func Initialize(ctx context.Context, projectDir, recordDir string) (string, error) {
	var path string
	err := lock.With(ctx, projectDir, lock.Options{}, func(lockContext context.Context) error {
		var err error
		path, err = initializeUnlocked(projectDir, recordDir)
		return err
	})
	return path, err
}

// Append appends one canonical event while holding the Workspace lock.
func Append(ctx context.Context, projectDir, recordDir string, event Event, fields []Field, clock Clock) (AppendResult, error) {
	var result AppendResult
	err := lock.With(ctx, projectDir, lock.Options{}, func(lockContext context.Context) error {
		path, err := initializeUnlocked(projectDir, recordDir)
		if err != nil {
			return err
		}
		timestamp := isoMilliseconds(now(clock))
		cloneID := CloneID(projectDir)
		sequence, err := nextSequence(path)
		if err != nil {
			return err
		}
		block, err := render(event, fields, timestamp, cloneID, sequence)
		if err != nil {
			return err
		}
		if err := appendContent(path, block); err != nil {
			return err
		}
		result = AppendResult{Appended: true, Event: event, Timestamp: timestamp, CloneID: cloneID, Sequence: sequence, Path: path}
		return nil
	})
	return result, err
}

// AppendBatch appends a related sequence with one shared timestamp.
func AppendBatch(ctx context.Context, projectDir, recordDir string, entries []BatchEntry, clock Clock) (BatchResult, error) {
	if len(entries) == 0 {
		return BatchResult{}, fmt.Errorf("Audit batch must contain at least one event")
	}
	var result BatchResult
	err := lock.With(ctx, projectDir, lock.Options{}, func(lockContext context.Context) error {
		path, err := initializeUnlocked(projectDir, recordDir)
		if err != nil {
			return err
		}
		timestamp := isoMilliseconds(now(clock))
		cloneID := CloneID(projectDir)
		first, err := nextSequence(path)
		if err != nil {
			return err
		}
		var builder strings.Builder
		result = BatchResult{Appended: true, Timestamp: timestamp, CloneID: cloneID, Path: path}
		for index, entry := range entries {
			sequence := first + index
			block, err := render(entry.Event, entry.Fields, timestamp, cloneID, sequence)
			if err != nil {
				return err
			}
			builder.WriteString(block)
			result.Events = append(result.Events, entry.Event)
			result.Sequences = append(result.Sequences, sequence)
		}
		return appendContent(path, builder.String())
	})
	return result, err
}

// ReadOrdered reads every shard in deterministic clone/sequence order.
func ReadOrdered(recordDir string) ([]OrderedEntry, error) {
	directory := filepath.Join(recordDir, "audit")
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return []OrderedEntry{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read Audit directory: %w", err)
	}
	var result []OrderedEntry
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		filePath := filepath.Join(directory, entry.Name())
		content, err := os.ReadFile(filePath)
		if err != nil {
			return nil, err
		}
		blocks := regexp.MustCompile(`(?m)^---\s*$`).Split(string(content), -1)
		legacyIndex := 0
		for _, block := range blocks {
			fields := parseFields(block)
			event := fields["Event"]
			if event == "" {
				continue
			}
			legacyIndex++
			sequence, err := strconv.Atoi(fields["Sequence"])
			legacy := err != nil || sequence < 1
			if legacy {
				sequence = legacyIndex
			}
			cloneID := fields["Clone ID"]
			if cloneID == "" {
				cloneID = cloneFromShard(entry.Name())
			}
			result = append(result, OrderedEntry{
				Event: event, Timestamp: fields["Timestamp"], CloneID: cloneID, Sequence: sequence,
				LegacySequence: legacy, Fields: fields, Path: filePath, Block: block,
			})
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		left, right := result[i], result[j]
		if left.CloneID != right.CloneID {
			return left.CloneID < right.CloneID
		}
		if left.Sequence != right.Sequence {
			return left.Sequence < right.Sequence
		}
		if left.Timestamp != right.Timestamp {
			return left.Timestamp < right.Timestamp
		}
		return left.Path < right.Path
	})
	return result, nil
}

// PortableEvidencePath retains external absolute paths and stores Project-owned
// evidence with '/' separators.
func PortableEvidencePath(projectDir, input string) string {
	projectRoot, _ := filepath.Abs(projectDir)
	absolute := input
	if !filepath.IsAbs(absolute) {
		absolute = filepath.Join(projectRoot, input)
	}
	absolute, _ = filepath.Abs(absolute)
	relative, err := filepath.Rel(projectRoot, absolute)
	if err == nil && relative == "." {
		return "."
	}
	if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
		return filepath.ToSlash(relative)
	}
	return absolute
}

func initializeUnlocked(projectDir, recordDir string) (string, error) {
	if err := requireRecordUnderWorkspace(projectDir, recordDir); err != nil {
		return "", err
	}
	auditDir := filepath.Join(recordDir, "audit")
	if err := os.Mkdir(auditDir, 0o755); err != nil && !os.IsExist(err) {
		return "", fmt.Errorf("create Audit directory: %w", err)
	}
	info, err := os.Lstat(auditDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Audit directory must not be a symlink: %s", auditDir)
	}
	path := FilePath(projectDir, recordDir)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err == nil {
		if _, writeErr := file.WriteString("# AI-DLC Audit Log\n"); writeErr != nil {
			_ = file.Close()
			return "", writeErr
		}
		if err := file.Close(); err != nil {
			return "", err
		}
		return path, nil
	}
	if !os.IsExist(err) {
		return "", fmt.Errorf("create Audit shard: %w", err)
	}
	info, err = os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Audit shard must be a regular file: %s", path)
	}
	return path, nil
}

func requireRecordUnderWorkspace(projectDir, recordDir string) error {
	workspaceRoot := workspace.Root(projectDir)
	absoluteRecord, err := filepath.Abs(recordDir)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(workspaceRoot, absoluteRecord)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return fmt.Errorf("Audit record must be inside the Workspace: %s", absoluteRecord)
	}
	if _, err := fsx.ResolveUnder(workspaceRoot, filepath.ToSlash(relative), false); err != nil {
		return fmt.Errorf("resolve Audit record safely: %w", err)
	}
	info, err := os.Lstat(absoluteRecord)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Audit record must be a real directory: %s", absoluteRecord)
	}
	return nil
}

func render(event Event, fields []Field, timestamp, cloneID string, sequence int) (string, error) {
	heading, ok := headings[event]
	if !ok {
		return "", fmt.Errorf("unknown Audit event: %s", event)
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "\n## %s\n", heading)
	fmt.Fprintf(&builder, "**Timestamp**: %s\n", timestamp)
	fmt.Fprintf(&builder, "**Clone ID**: %s\n", cloneID)
	fmt.Fprintf(&builder, "**Sequence**: %d\n", sequence)
	fmt.Fprintf(&builder, "**Event**: %s\n", event)
	seen := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		if field.Name == "" || strings.ContainsAny(field.Name, "\r\n*") {
			return "", fmt.Errorf("invalid Audit field name: %q", field.Name)
		}
		if _, exists := seen[field.Name]; exists {
			return "", fmt.Errorf("duplicate Audit field: %s", field.Name)
		}
		seen[field.Name] = struct{}{}
		value := strings.ReplaceAll(strings.ReplaceAll(field.Value, "\r\n", "\\n"), "\n", "\\n")
		fmt.Fprintf(&builder, "**%s**: %s\n", field.Name, value)
	}
	builder.WriteString("\n---\n")
	return builder.String(), nil
}

func nextSequence(path string) (int, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	maximum := 0
	legacyFloor := 0
	scanner := bufio.NewScanner(strings.NewReader(string(content)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "**Event**:") {
			legacyFloor++
		}
		if match := sequenceLine.FindStringSubmatch(line); match != nil {
			if value, err := strconv.Atoi(match[1]); err == nil && value > maximum {
				maximum = value
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	if legacyFloor > maximum {
		maximum = legacyFloor
	}
	return maximum + 1, nil
}

func appendContent(path, content string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func parseFields(block string) map[string]string {
	fields := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(block))
	for scanner.Scan() {
		if match := fieldLine.FindStringSubmatch(scanner.Text()); match != nil {
			fields[strings.TrimSpace(match[1])] = strings.TrimSpace(match[2])
		}
	}
	return fields
}

func cloneFromShard(name string) string {
	if match := cloneSuffix.FindStringSubmatch(name); match != nil {
		return match[1]
	}
	return strings.TrimSuffix(name, ".md")
}

func now(clock Clock) time.Time {
	if clock != nil {
		return clock()
	}
	return time.Now()
}

func isoMilliseconds(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func randomHex(bytesCount int) string {
	content := make([]byte, bytesCount)
	if _, err := rand.Read(content); err != nil {
		panic(fmt.Sprintf("secure randomness unavailable: %v", err))
	}
	return hex.EncodeToString(content)
}
