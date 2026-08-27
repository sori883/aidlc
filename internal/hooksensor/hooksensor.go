// Package hooksensor adapts Codex PostToolUse apply_patch deliveries to the
// deterministic Core-owned Sensor catalog.
package hooksensor

import (
	"bufio"
	"context"
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

	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/lock"
	"github.com/sori883/aidlc/internal/sensor"
	"github.com/sori883/aidlc/internal/workflow/state"
)

const maxInputBytes = 16 * 1024 * 1024

// Options identifies the Harness and supplies deterministic time in tests.
type Options struct {
	Harness string
	Clock   func() time.Time
}

// Result summarizes one non-authoritative Hook observation.
type Result struct {
	Observed      bool     `json:"observed"`
	Stage         string   `json:"stage,omitempty"`
	ObservationID string   `json:"observation_id,omitempty"`
	Paths         []string `json:"paths"`
	Matched       int      `json:"matched"`
	Fired         int      `json:"fired"`
	Failed        int      `json:"failed"`
	Deduplicated  int      `json:"deduplicated"`
}

type codexInput struct {
	SessionID     string `json:"session_id"`
	TurnID        string `json:"turn_id"`
	CWD           string `json:"cwd"`
	HookEventName string `json:"hook_event_name"`
	ToolName      string `json:"tool_name"`
	ToolUseID     string `json:"tool_use_id"`
	ToolInput     struct {
		Command string `json:"command"`
	} `json:"tool_input"`
}

type patchPath struct {
	absolute string
	relative string
}

// Observe validates one Codex PostToolUse delivery, resolves the paths the
// completed apply_patch named, and fires every matching write Sensor. Write
// Sensors are advisory: their result is evidence and never a Hook denial.
func Observe(ctx context.Context, projectDir string, input io.Reader, options Options) (Result, error) {
	projectRoot, err := realDirectory(projectDir)
	if err != nil {
		return Result{}, err
	}
	if options.Harness == "" {
		options.Harness = "codex"
	}
	if options.Harness != "codex" {
		return Result{}, fmt.Errorf("unsupported Hook harness: %s", options.Harness)
	}
	delivery, err := decodeCodex(input)
	if err != nil {
		return Result{}, err
	}
	cwd, err := validateDelivery(projectRoot, delivery)
	if err != nil {
		return Result{}, err
	}
	paths, err := patchPaths(projectRoot, cwd, delivery.ToolInput.Command)
	if err != nil {
		return Result{}, fmt.Errorf("Sensor Hook patch paths: %w", err)
	}

	result := Result{Observed: true, ObservationID: delivery.ToolUseID, Paths: make([]string, 0, len(paths))}
	err = lock.With(ctx, projectRoot, lock.Options{MaxRetries: 60, Retry: 25 * time.Millisecond}, func(lockContext context.Context) error {
		inspection, inspectErr := state.InspectActive(projectRoot)
		if inspectErr != nil || inspection.Kind != state.InspectionVNext {
			return nil
		}
		snapshot, readErr := state.Read(inspection.RecordDir)
		if readErr != nil {
			return fmt.Errorf("read active vNext State for Sensor Hook: %w", readErr)
		}
		result.Stage = string(snapshot.State.CurrentStage)
		for _, path := range paths {
			result.Paths = append(result.Paths, path.relative)
			definitions := sensor.MatchWrite(path.relative)
			result.Matched += len(definitions)
			info, statErr := os.Lstat(path.absolute)
			if os.IsNotExist(statErr) {
				continue
			}
			if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("Sensor Hook path must be a regular non-symlink file: %s", path.relative)
			}
			for _, definition := range definitions {
				fired, fireErr := sensor.Fire(lockContext, sensor.Request{
					ProjectDir: projectRoot, RecordDir: inspection.RecordDir,
					Stage: result.Stage, SensorID: definition.ID, Trigger: sensor.TriggerWrite,
					Path: path.relative, ObservationID: delivery.ToolUseID,
				}, sensor.Options{Clock: options.Clock})
				if fireErr != nil {
					return fmt.Errorf("fire Sensor %s for %s: %w", definition.ID, path.relative, fireErr)
				}
				if fired.Fired {
					result.Fired++
				}
				if fired.Deduplicated {
					result.Deduplicated++
				}
				if fired.Outcome == "failed" {
					result.Failed++
				}
			}
		}
		return sensor.RecordObservation(lockContext, projectRoot, inspection.RecordDir, "sensor", "PostToolUse", result.Stage, delivery.ToolUseID, result.Matched, result.Fired, sensor.Options{Clock: options.Clock})
	})
	return result, err
}

func decodeCodex(input io.Reader) (codexInput, error) {
	limited := &io.LimitedReader{R: input, N: maxInputBytes + 1}
	content, err := io.ReadAll(limited)
	if err != nil {
		return codexInput{}, fmt.Errorf("read Codex Sensor Hook input: %w", err)
	}
	if len(content) == 0 || len(content) > maxInputBytes {
		return codexInput{}, fmt.Errorf("Codex Sensor Hook input must contain one bounded JSON object")
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	var value codexInput
	if err := decoder.Decode(&value); err != nil {
		return codexInput{}, fmt.Errorf("decode Codex Sensor Hook input: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return codexInput{}, fmt.Errorf("Codex Sensor Hook input must contain exactly one JSON object")
	}
	return value, nil
}

func validateDelivery(projectRoot string, value codexInput) (string, error) {
	for name, text := range map[string]string{
		"session_id": value.SessionID, "turn_id": value.TurnID,
		"tool_name": value.ToolName, "tool_use_id": value.ToolUseID,
	} {
		if err := metadata(text, name, 256); err != nil {
			return "", err
		}
	}
	if value.SessionID == "" || value.ToolUseID == "" || value.CWD == "" {
		return "", fmt.Errorf("Codex Sensor Hook requires session_id, tool_use_id, and cwd")
	}
	if value.HookEventName != "PostToolUse" {
		return "", fmt.Errorf("unsupported Codex Sensor Hook event: %s", value.HookEventName)
	}
	if value.ToolName != "apply_patch" {
		return "", fmt.Errorf("unsupported Codex Sensor Hook tool: %s", value.ToolName)
	}
	if value.ToolInput.Command == "" {
		return "", fmt.Errorf("Codex Sensor Hook tool_input.command is required")
	}
	cwd, err := realDirectory(value.CWD)
	if err != nil || !pathWithin(cwd, projectRoot) {
		return "", fmt.Errorf("Codex Sensor Hook cwd is outside the Project")
	}
	return cwd, nil
}

func patchPaths(projectRoot, cwd, patch string) ([]patchPath, error) {
	if !strings.Contains(patch, "*** Begin Patch") || !strings.Contains(patch, "*** End Patch") {
		return nil, fmt.Errorf("missing patch envelope")
	}
	prefixes := []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "}
	var values []patchPath
	scanner := bufio.NewScanner(strings.NewReader(patch))
	scanner.Buffer(make([]byte, 4096), maxInputBytes)
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
			return nil, err
		}
		absolute, err := fsx.ResolveUnder(cwd, portable, true)
		if err != nil {
			return nil, err
		}
		if !pathWithin(absolute, projectRoot) {
			return nil, fmt.Errorf("patch path is outside Project")
		}
		relative, err := filepath.Rel(projectRoot, absolute)
		if err != nil {
			return nil, err
		}
		values = append(values, patchPath{absolute: filepath.Clean(absolute), relative: filepath.ToSlash(relative)})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(values) == 0 {
		return nil, fmt.Errorf("patch has no file path")
	}
	sort.Slice(values, func(i, j int) bool { return values[i].relative < values[j].relative })
	result := values[:0]
	for _, value := range values {
		if len(result) == 0 || result[len(result)-1].absolute != value.absolute {
			result = append(result, value)
		}
	}
	return result, nil
}

func realDirectory(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	absolute, err = filepath.EvalSymlinks(filepath.Clean(absolute))
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("directory must be a real directory: %s", absolute)
	}
	return absolute, nil
}

func pathWithin(candidate, root string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func metadata(value, name string, maximum int) error {
	if len(value) > maximum {
		return fmt.Errorf("Codex Sensor Hook %s is too long", name)
	}
	for _, current := range value {
		if current == '\x00' || current == '\r' || current == '\n' || unicode.IsControl(current) {
			return fmt.Errorf("Codex Sensor Hook %s contains a control character", name)
		}
	}
	return nil
}
