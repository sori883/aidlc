// Package hookaudit records non-authoritative metadata observed by Harness hooks.
package hookaudit

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/sori883/aidlc/internal/audit"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/workflow/state"
)

const (
	// SchemaVersion is the JSONL Hook Journal schema.
	SchemaVersion = 1
	// RedactionPolicy identifies the fixed metadata-only persistence policy.
	RedactionPolicy = "metadata-only-v1"
	maxInputBytes   = 16 * 1024 * 1024
	claimTTL        = 30 * time.Minute
)

// Kind is one normalized, non-authoritative Hook Journal event.
type Kind string

const (
	SessionStarted      Kind = "HOOK_SESSION_STARTED"
	SessionEnded        Kind = "HOOK_SESSION_ENDED"
	SubagentStarted     Kind = "HOOK_SUBAGENT_STARTED"
	SubagentStopped     Kind = "HOOK_SUBAGENT_STOPPED"
	ToolBefore          Kind = "HOOK_TOOL_BEFORE"
	ToolAfter           Kind = "HOOK_TOOL_AFTER"
	PermissionRequested Kind = "HOOK_PERMISSION_REQUESTED"
	CompactionStarted   Kind = "HOOK_COMPACTION_STARTED"
	CompactionCompleted Kind = "HOOK_COMPACTION_COMPLETED"
	StopObserved        Kind = "HOOK_STOP_OBSERVED"
	GuardDenied         Kind = "HOOK_GUARD_DENIED"
)

var kindByCodexEvent = map[string]Kind{
	"SessionStart":      SessionStarted,
	"SessionEnd":        SessionEnded,
	"SubagentStart":     SubagentStarted,
	"SubagentStop":      SubagentStopped,
	"PreToolUse":        ToolBefore,
	"PostToolUse":       ToolAfter,
	"PermissionRequest": PermissionRequested,
	"PreCompact":        CompactionStarted,
	"PostCompact":       CompactionCompleted,
	"Stop":              StopObserved,
}

// Entry is one stable Hook Journal JSONL row.
type Entry struct {
	SchemaVersion     int      `json:"schema_version"`
	Timestamp         string   `json:"timestamp"`
	CloneID           string   `json:"clone_id"`
	Sequence          int      `json:"sequence"`
	EventID           string   `json:"event_id"`
	Kind              Kind     `json:"kind"`
	Harness           string   `json:"harness"`
	SourceEvent       string   `json:"source_event"`
	SessionID         string   `json:"session_id"`
	TurnID            string   `json:"turn_id,omitempty"`
	ToolName          string   `json:"tool_name,omitempty"`
	ToolUseID         string   `json:"tool_use_id,omitempty"`
	AgentID           string   `json:"agent_id,omitempty"`
	AgentType         string   `json:"agent_type,omitempty"`
	Source            string   `json:"source,omitempty"`
	Reason            string   `json:"reason,omitempty"`
	Trigger           string   `json:"trigger,omitempty"`
	IntentID          string   `json:"intent_id"`
	Stage             string   `json:"stage"`
	StateStatus       string   `json:"state_status"`
	Paths             []string `json:"paths,omitempty"`
	ExcludedPathCount int      `json:"excluded_path_count,omitempty"`
	Redaction         string   `json:"redaction"`
}

// RecordOptions injects Harness identity and nondeterministic sources.
type RecordOptions struct {
	Harness string
	Clock   func() time.Time
}

// GuardDenial contains only the bounded metadata a Tool guard may persist.
// It intentionally has no command, patch, prompt, task, or Tool output field.
type GuardDenial struct {
	Harness    string
	SessionID  string
	TurnID     string
	ToolName   string
	ToolUseID  string
	ReasonCode string
	Paths      []string
	Clock      func() time.Time
}

// RecordResult describes whether one hook delivery produced a journal row.
type RecordResult struct {
	Recorded    bool   `json:"recorded"`
	Reason      string `json:"reason,omitempty"`
	EventID     string `json:"event_id,omitempty"`
	Kind        Kind   `json:"kind,omitempty"`
	SourceEvent string `json:"source_event,omitempty"`
	Path        string `json:"path,omitempty"`
	Sequence    int    `json:"sequence,omitempty"`
}

// Status summarizes Hook Journal evidence for the active Intent.
type Status struct {
	Active          bool   `json:"active"`
	IntentID        string `json:"intent_id,omitempty"`
	Stage           string `json:"stage,omitempty"`
	JournalDir      string `json:"journal_dir,omitempty"`
	Shards          int    `json:"shards"`
	Entries         int    `json:"entries"`
	UniqueEvents    int    `json:"unique_events"`
	DuplicateEvents int    `json:"duplicate_events"`
	Latest          *Entry `json:"latest,omitempty"`
}

type codexInput struct {
	SessionID     string `json:"session_id"`
	TurnID        string `json:"turn_id"`
	CWD           string `json:"cwd"`
	HookEventName string `json:"hook_event_name"`
	Source        string `json:"source"`
	Reason        string `json:"reason"`
	Trigger       string `json:"trigger"`
	ToolName      string `json:"tool_name"`
	ToolUseID     string `json:"tool_use_id"`
	AgentID       string `json:"agent_id"`
	AgentType     string `json:"agent_type"`
	ToolInput     struct {
		Command string `json:"command"`
	} `json:"tool_input"`
}

// Record validates and appends one Codex hook delivery. It never mutates Core
// State or the canonical Core Audit.
func Record(ctx context.Context, projectDir string, input io.Reader, options RecordOptions) (RecordResult, error) {
	projectRoot, err := requireProject(projectDir)
	if err != nil {
		return RecordResult{}, err
	}
	if options.Harness == "" {
		options.Harness = "codex"
	}
	if options.Harness != "codex" {
		return RecordResult{}, fmt.Errorf("unsupported Hook harness: %s", options.Harness)
	}
	delivery, err := decodeCodex(input)
	if err != nil {
		return RecordResult{}, err
	}
	if err := validateCWD(projectRoot, delivery.CWD); err != nil {
		return RecordResult{}, err
	}
	kind, ok := kindByCodexEvent[delivery.HookEventName]
	if !ok {
		return RecordResult{}, fmt.Errorf("unsupported Codex hook event: %s", delivery.HookEventName)
	}
	if err := validateDelivery(delivery, kind); err != nil {
		return RecordResult{}, err
	}
	eventID, stable, err := eventID(options.Harness, delivery)
	if err != nil {
		return RecordResult{}, err
	}

	result := RecordResult{EventID: eventID, Kind: kind, SourceEvent: delivery.HookEventName}
	err = lock.With(ctx, projectRoot, lock.Options{MaxRetries: 60, Retry: 25 * time.Millisecond}, func(context.Context) error {
		inspection, inspectErr := state.InspectActive(projectRoot)
		if inspectErr != nil || inspection.Kind != state.InspectionVNext {
			result.Reason = "no_active_vnext_intent"
			return nil
		}
		snapshot, readErr := state.Read(inspection.RecordDir)
		if readErr != nil {
			return fmt.Errorf("read active vNext State for Hook Audit: %w", readErr)
		}
		if stable && claimed(projectRoot, eventID) {
			result.Reason = "duplicate_delivery"
			return nil
		}
		path, initializeErr := initializeJournal(projectRoot, inspection.RecordDir)
		if initializeErr != nil {
			return initializeErr
		}
		sequence, sequenceErr := nextSequence(path)
		if sequenceErr != nil {
			return sequenceErr
		}
		paths, excluded := []string(nil), 0
		if delivery.ToolName == "apply_patch" {
			paths, excluded = extractPatchPaths(projectRoot, delivery.ToolInput.Command)
		}
		now := time.Now()
		if options.Clock != nil {
			now = options.Clock()
		}
		entry := Entry{
			SchemaVersion: SchemaVersion, Timestamp: isoMilliseconds(now),
			CloneID: audit.CloneID(projectRoot), Sequence: sequence, EventID: eventID,
			Kind: kind, Harness: options.Harness, SourceEvent: delivery.HookEventName,
			SessionID: delivery.SessionID, TurnID: delivery.TurnID,
			ToolName: delivery.ToolName, ToolUseID: delivery.ToolUseID,
			AgentID: delivery.AgentID, AgentType: delivery.AgentType,
			Source: delivery.Source, Reason: delivery.Reason, Trigger: delivery.Trigger,
			IntentID: snapshot.State.IntentID, Stage: string(snapshot.State.CurrentStage),
			StateStatus: string(snapshot.State.Status), Paths: paths,
			ExcludedPathCount: excluded, Redaction: RedactionPolicy,
		}
		if appendErr := appendEntry(path, entry); appendErr != nil {
			return appendErr
		}
		if stable {
			rememberClaim(projectRoot, eventID)
			pruneClaims(projectRoot, now)
		}
		result.Recorded = true
		result.Path = path
		result.Sequence = sequence
		return nil
	})
	return result, err
}

// RecordGuardDenial appends a metadata-only guard decision to the same
// non-authoritative Hook Journal used by lifecycle observations.
func RecordGuardDenial(ctx context.Context, projectDir string, denial GuardDenial) (RecordResult, error) {
	projectRoot, err := requireProject(projectDir)
	if err != nil {
		return RecordResult{}, err
	}
	if denial.Harness == "" {
		denial.Harness = "codex"
	}
	if denial.Harness != "codex" {
		return RecordResult{}, fmt.Errorf("unsupported Hook harness: %s", denial.Harness)
	}
	for name, value := range map[string]string{
		"session_id": denial.SessionID, "turn_id": denial.TurnID,
		"tool_name": denial.ToolName, "tool_use_id": denial.ToolUseID,
		"reason_code": denial.ReasonCode,
	} {
		if err := metadata(value, name, 256); err != nil {
			return RecordResult{}, err
		}
	}
	if denial.SessionID == "" || denial.ToolUseID == "" || denial.ReasonCode == "" {
		return RecordResult{}, fmt.Errorf("Hook Guard denial requires session_id, tool_use_id, and reason_code")
	}
	if denial.ToolName != "Bash" && denial.ToolName != "apply_patch" {
		return RecordResult{}, fmt.Errorf("Hook Guard denial has unsupported tool_name: %s", denial.ToolName)
	}
	if len(denial.Paths) > 64 {
		return RecordResult{}, fmt.Errorf("Hook Guard denial has too many paths")
	}
	paths := append([]string(nil), denial.Paths...)
	for _, value := range paths {
		if len(value) > 1024 {
			return RecordResult{}, fmt.Errorf("Hook Guard denial path is too long")
		}
		if err := fsx.ValidateRelative(value); err != nil {
			return RecordResult{}, fmt.Errorf("Hook Guard denial path: %w", err)
		}
	}
	sort.Strings(paths)
	paths = compactStrings(paths)

	digest := sha256.Sum256([]byte(strings.Join([]string{
		denial.Harness, "HookGuardDenied", denial.SessionID, denial.ToolUseID,
	}, "\x00")))
	eventID := "sha256:" + hex.EncodeToString(digest[:])
	result := RecordResult{EventID: eventID, Kind: GuardDenied}
	err = lock.With(ctx, projectRoot, lock.Options{MaxRetries: 60, Retry: 25 * time.Millisecond}, func(context.Context) error {
		inspection, inspectErr := state.InspectActive(projectRoot)
		if inspectErr != nil || inspection.Kind != state.InspectionVNext {
			result.Reason = "no_active_vnext_intent"
			return nil
		}
		snapshot, readErr := state.Read(inspection.RecordDir)
		if readErr != nil {
			return fmt.Errorf("read active vNext State for Hook Guard Audit: %w", readErr)
		}
		if claimed(projectRoot, eventID) {
			result.Reason = "duplicate_delivery"
			return nil
		}
		path, initializeErr := initializeJournal(projectRoot, inspection.RecordDir)
		if initializeErr != nil {
			return initializeErr
		}
		sequence, sequenceErr := nextSequence(path)
		if sequenceErr != nil {
			return sequenceErr
		}
		now := time.Now()
		if denial.Clock != nil {
			now = denial.Clock()
		}
		entry := Entry{
			SchemaVersion: SchemaVersion, Timestamp: isoMilliseconds(now),
			CloneID: audit.CloneID(projectRoot), Sequence: sequence, EventID: eventID,
			Kind: GuardDenied, Harness: denial.Harness, SourceEvent: "PreToolUse",
			SessionID: denial.SessionID, TurnID: denial.TurnID,
			ToolName: denial.ToolName, ToolUseID: denial.ToolUseID,
			Reason: denial.ReasonCode, IntentID: snapshot.State.IntentID,
			Stage: string(snapshot.State.CurrentStage), StateStatus: string(snapshot.State.Status),
			Paths: paths, Redaction: RedactionPolicy,
		}
		if appendErr := appendEntry(path, entry); appendErr != nil {
			return appendErr
		}
		rememberClaim(projectRoot, eventID)
		pruneClaims(projectRoot, now)
		result.Recorded = true
		result.Path = path
		result.Sequence = sequence
		return nil
	})
	return result, err
}

// Inspect reads Hook Journal evidence for the active vNext Intent.
func Inspect(projectDir string) (Status, error) {
	projectRoot, err := requireProject(projectDir)
	if err != nil {
		return Status{}, err
	}
	status := Status{Shards: 0, Entries: 0, UniqueEvents: 0, DuplicateEvents: 0}
	err = lock.With(context.Background(), projectRoot, lock.Options{}, func(context.Context) error {
		inspection, inspectErr := state.InspectActive(projectRoot)
		if inspectErr != nil || inspection.Kind != state.InspectionVNext {
			return nil
		}
		snapshot, readErr := state.Read(inspection.RecordDir)
		if readErr != nil {
			return readErr
		}
		status.Active = true
		status.IntentID = snapshot.State.IntentID
		status.Stage = string(snapshot.State.CurrentStage)
		status.JournalDir = filepath.Join(inspection.RecordDir, "hook-audit")
		entries, readEntriesErr := readEntries(status.JournalDir)
		if readEntriesErr != nil {
			return readEntriesErr
		}
		status.Shards = entries.shards
		status.Entries = len(entries.values)
		seen := make(map[string]struct{}, len(entries.values))
		for index := range entries.values {
			entry := entries.values[index]
			if _, exists := seen[entry.EventID]; exists {
				status.DuplicateEvents++
			} else {
				seen[entry.EventID] = struct{}{}
			}
			if status.Latest == nil || later(entry, *status.Latest) {
				copy := entry
				status.Latest = &copy
			}
		}
		status.UniqueEvents = len(seen)
		return nil
	})
	return status, err
}

func requireProject(projectDir string) (string, error) {
	root, err := filepath.Abs(projectDir)
	if err != nil {
		return "", fmt.Errorf("resolve Hook project: %w", err)
	}
	root = filepath.Clean(root)
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve Hook project real path: %w", err)
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Hook project must be a real directory: %s", root)
	}
	return root, nil
}

func decodeCodex(input io.Reader) (codexInput, error) {
	limited := &io.LimitedReader{R: input, N: maxInputBytes + 1}
	content, err := io.ReadAll(limited)
	if err != nil {
		return codexInput{}, fmt.Errorf("read Codex hook input: %w", err)
	}
	if len(content) == 0 || len(content) > maxInputBytes {
		return codexInput{}, fmt.Errorf("Codex hook input must contain one JSON object no larger than %d bytes", maxInputBytes)
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	var value codexInput
	if err := decoder.Decode(&value); err != nil {
		return codexInput{}, fmt.Errorf("decode Codex hook input: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return codexInput{}, fmt.Errorf("Codex hook input must contain exactly one JSON object")
	}
	return value, nil
}

func validateDelivery(value codexInput, kind Kind) error {
	for name, text := range map[string]string{
		"session_id": value.SessionID, "turn_id": value.TurnID,
		"source": value.Source, "reason": value.Reason, "trigger": value.Trigger,
		"tool_name": value.ToolName, "tool_use_id": value.ToolUseID,
		"agent_id": value.AgentID, "agent_type": value.AgentType,
	} {
		if err := metadata(text, name, 256); err != nil {
			return err
		}
	}
	if value.SessionID == "" {
		return fmt.Errorf("Codex hook session_id is required")
	}
	switch kind {
	case ToolBefore, ToolAfter, PermissionRequested:
		if value.ToolName == "" {
			return fmt.Errorf("Codex %s tool_name is required", value.HookEventName)
		}
	case SubagentStarted, SubagentStopped:
		if value.AgentID == "" {
			return fmt.Errorf("Codex %s agent_id is required", value.HookEventName)
		}
	}
	return nil
}

func metadata(value, name string, maximum int) error {
	if len(value) > maximum {
		return fmt.Errorf("Codex hook %s is too long", name)
	}
	for _, current := range value {
		if current == '\x00' || current == '\r' || current == '\n' || unicode.IsControl(current) {
			return fmt.Errorf("Codex hook %s contains a control character", name)
		}
	}
	return nil
}

func validateCWD(projectRoot, cwd string) error {
	if cwd == "" {
		return nil
	}
	absolute, err := filepath.Abs(cwd)
	if err != nil {
		return fmt.Errorf("resolve Codex hook cwd: %w", err)
	}
	absolute, err = filepath.EvalSymlinks(filepath.Clean(absolute))
	if err != nil {
		return fmt.Errorf("resolve Codex hook cwd real path: %w", err)
	}
	relative, err := filepath.Rel(projectRoot, filepath.Clean(absolute))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return fmt.Errorf("Codex hook cwd is outside the Project")
	}
	return nil
}

func eventID(harness string, value codexInput) (string, bool, error) {
	identity := []string{harness, value.HookEventName, value.SessionID}
	stable := true
	switch value.HookEventName {
	case "PreToolUse", "PostToolUse", "PermissionRequest":
		if value.ToolUseID == "" {
			stable = false
		} else {
			identity = append(identity, value.ToolUseID)
		}
	case "SubagentStart", "SubagentStop":
		identity = append(identity, value.AgentID)
	case "PreCompact", "PostCompact":
		if value.TurnID == "" {
			stable = false
		} else {
			identity = append(identity, value.TurnID)
		}
	case "Stop":
		stable = false
	case "SessionStart":
		if value.Source == "compact" {
			stable = false
		} else {
			identity = append(identity, value.Source)
		}
	case "SessionEnd":
		identity = append(identity, value.Reason)
	}
	if stable {
		digest := sha256.Sum256([]byte(strings.Join(identity, "\x00")))
		return "sha256:" + hex.EncodeToString(digest[:]), true, nil
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", false, fmt.Errorf("generate Hook event identity: %w", err)
	}
	digest := sha256.Sum256(random)
	return "sha256:" + hex.EncodeToString(digest[:]), false, nil
}

func initializeJournal(projectRoot, recordDir string) (string, error) {
	directory := filepath.Join(recordDir, "hook-audit")
	if err := os.Mkdir(directory, 0o755); err != nil && !os.IsExist(err) {
		return "", fmt.Errorf("create Hook Journal directory: %w", err)
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Hook Journal directory must be a real directory: %s", directory)
	}
	name := strings.TrimSuffix(audit.ShardName(projectRoot), ".md") + ".jsonl"
	path := filepath.Join(directory, name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err == nil {
		return path, file.Close()
	}
	if !os.IsExist(err) {
		return "", fmt.Errorf("create Hook Journal shard: %w", err)
	}
	info, err = os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Hook Journal shard must be a regular file: %s", path)
	}
	return path, nil
}

func nextSequence(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	maximum := 0
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		if len(strings.TrimSpace(scanner.Text())) == 0 {
			continue
		}
		var entry Entry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil || entry.SchemaVersion != SchemaVersion || entry.Sequence < 1 {
			return 0, fmt.Errorf("Hook Journal contains an invalid row at line %d", line)
		}
		if entry.Sequence > maximum {
			maximum = entry.Sequence
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return maximum + 1, nil
}

func appendEntry(path string, entry Entry) error {
	content, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	content = append(content, '\n')
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open Hook Journal shard: %w", err)
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return fmt.Errorf("append Hook Journal entry: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync Hook Journal entry: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close Hook Journal shard: %w", err)
	}
	return nil
}

func extractPatchPaths(projectRoot, patch string) ([]string, int) {
	if patch == "" {
		return nil, 0
	}
	prefixes := []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "}
	seen := map[string]struct{}{}
	excluded := 0
	scanner := bufio.NewScanner(strings.NewReader(patch))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		candidate := ""
		for _, prefix := range prefixes {
			if strings.HasPrefix(scanner.Text(), prefix) {
				candidate = strings.TrimSpace(strings.TrimPrefix(scanner.Text(), prefix))
				break
			}
		}
		if candidate == "" {
			continue
		}
		portable := filepath.ToSlash(candidate)
		if err := fsx.ValidateRelative(portable); err != nil {
			excluded++
			continue
		}
		if _, err := fsx.ResolveUnder(projectRoot, portable, true); err != nil {
			excluded++
			continue
		}
		seen[portable] = struct{}{}
	}
	paths := make([]string, 0, len(seen))
	for path := range seen {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths, excluded
}

func compactStrings(values []string) []string {
	if len(values) < 2 {
		return values
	}
	result := values[:1]
	for _, value := range values[1:] {
		if value != result[len(result)-1] {
			result = append(result, value)
		}
	}
	return result
}

func claimDirectory(projectRoot string) string {
	digest := sha256.Sum256([]byte(projectRoot))
	return filepath.Join(os.TempDir(), ".aidlc-hook-"+hex.EncodeToString(digest[:8]), "claims")
}

func claimPath(projectRoot, eventID string) string {
	return filepath.Join(claimDirectory(projectRoot), strings.TrimPrefix(eventID, "sha256:"))
}

func claimed(projectRoot, eventID string) bool {
	path := claimPath(projectRoot, eventID)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	if time.Since(info.ModTime()) > claimTTL {
		_ = os.Remove(path)
		return false
	}
	return true
}

func rememberClaim(projectRoot, eventID string) {
	directory := claimDirectory(projectRoot)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return
	}
	file, err := os.OpenFile(claimPath(projectRoot, eventID), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_ = file.Close()
	}
}

func pruneClaims(projectRoot string, now time.Time) {
	directory := claimDirectory(projectRoot)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		info, infoErr := entry.Info()
		if infoErr == nil && info.Mode().IsRegular() && now.Sub(info.ModTime()) > claimTTL {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
	}
}

type journalEntries struct {
	shards int
	values []Entry
}

func readEntries(directory string) (journalEntries, error) {
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return journalEntries{values: []Entry{}}, nil
	}
	if err != nil {
		return journalEntries{}, err
	}
	result := journalEntries{values: []Entry{}}
	for _, candidate := range entries {
		if !candidate.Type().IsRegular() || !strings.HasSuffix(candidate.Name(), ".jsonl") {
			continue
		}
		result.shards++
		path := filepath.Join(directory, candidate.Name())
		file, err := os.Open(path)
		if err != nil {
			return journalEntries{}, err
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		line := 0
		for scanner.Scan() {
			line++
			if len(strings.TrimSpace(scanner.Text())) == 0 {
				continue
			}
			var entry Entry
			if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil || entry.SchemaVersion != SchemaVersion || entry.EventID == "" || entry.Sequence < 1 {
				_ = file.Close()
				return journalEntries{}, fmt.Errorf("invalid Hook Journal row: %s:%d", path, line)
			}
			result.values = append(result.values, entry)
		}
		if err := scanner.Err(); err != nil {
			_ = file.Close()
			return journalEntries{}, err
		}
		if err := file.Close(); err != nil {
			return journalEntries{}, err
		}
	}
	return result, nil
}

func later(left, right Entry) bool {
	if left.Timestamp != right.Timestamp {
		return left.Timestamp > right.Timestamp
	}
	if left.CloneID != right.CloneID {
		return left.CloneID > right.CloneID
	}
	return left.Sequence > right.Sequence
}

func isoMilliseconds(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
