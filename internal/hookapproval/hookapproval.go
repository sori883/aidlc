// Package hookapproval connects Codex UserPromptSubmit and Stop deliveries to
// the Core-owned Human Approval Receipt protocol.
package hookapproval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/sori883/aidlc/internal/workflow/humanapproval"
	"github.com/sori883/aidlc/internal/workflow/state"
)

const maxInputBytes = 16 * 1024 * 1024

type Options struct {
	Harness string
	Clock   func() time.Time
}

type CaptureResult struct {
	Matched           bool   `json:"matched"`
	ReceiptSHA256     string `json:"receipt_sha256,omitempty"`
	AdditionalContext string `json:"additional_context,omitempty"`
}

type FreezeResult struct {
	Pending    bool   `json:"pending"`
	StopReason string `json:"stop_reason,omitempty"`
}

type codexInput struct {
	SessionID     string `json:"session_id"`
	TurnID        string `json:"turn_id"`
	CWD           string `json:"cwd"`
	HookEventName string `json:"hook_event_name"`
	Prompt        string `json:"prompt"`
}

type userPromptResponse struct {
	HookSpecificOutput struct {
		HookEventName     string `json:"hookEventName"`
		AdditionalContext string `json:"additionalContext"`
	} `json:"hookSpecificOutput"`
}

type blockResponse struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

type stopResponse struct {
	Continue   bool   `json:"continue"`
	StopReason string `json:"stopReason"`
}

// Capture consumes only an exact /aidlc-confirm UserPromptSubmit delivery.
func Capture(ctx context.Context, projectDir string, input io.Reader, options Options) (CaptureResult, error) {
	projectRoot, err := requireProject(projectDir)
	if err != nil {
		return CaptureResult{}, err
	}
	delivery, err := decodeCodex(input)
	if err != nil {
		return CaptureResult{}, err
	}
	if delivery.HookEventName != "UserPromptSubmit" {
		return CaptureResult{}, fmt.Errorf("unsupported Human Receipt Hook event: %s", delivery.HookEventName)
	}
	if err := validateDelivery(projectRoot, delivery, true); err != nil {
		return CaptureResult{}, err
	}
	if !strings.HasPrefix(delivery.Prompt, "/aidlc-confirm") {
		return CaptureResult{}, nil
	}
	inspection, err := state.InspectActive(projectRoot)
	if err != nil || inspection.Kind != state.InspectionVNext {
		return CaptureResult{Matched: true}, fmt.Errorf("Human Receipt requires an active vNext Intent")
	}
	snapshot, err := state.Read(inspection.RecordDir)
	if err != nil {
		return CaptureResult{Matched: true}, err
	}
	current, freeze, _, err := humanapproval.ReadCurrent(projectRoot, inspection.RecordDir)
	if err != nil {
		return CaptureResult{Matched: true}, err
	}
	if current.Status != humanapproval.StatusPending || (freeze.Scope != humanapproval.ScopeRisk && freeze.Scope != string(snapshot.State.CurrentStage)) {
		return CaptureResult{Matched: true}, fmt.Errorf("Human Receipt is stale for the active Stage")
	}
	harness := options.Harness
	if harness == "" {
		harness = "codex"
	}
	at := now(options.Clock)
	captured, err := humanapproval.Capture(ctx, projectRoot, inspection.RecordDir, harness, delivery.SessionID, delivery.TurnID, delivery.Prompt, at)
	if err != nil {
		return CaptureResult{Matched: true}, err
	}
	if !captured.Matched || captured.ReceiptReference == nil {
		return CaptureResult{Matched: true}, fmt.Errorf("Human Receipt confirmation was not recorded")
	}
	message := "AI-DLC recorded the exact Human Input Receipt " + captured.ReceiptReference.SHA256 + ". Apply only this Receipt with: ./.codex/tools/aidlc human-gate apply . " + captured.ReceiptReference.SHA256
	return CaptureResult{Matched: true, ReceiptSHA256: captured.ReceiptReference.SHA256, AdditionalContext: message}, nil
}

// Freeze returns continue:false only while an unresolved Review Freeze exists.
func Freeze(_ context.Context, projectDir string, input io.Reader, options Options) (FreezeResult, error) {
	projectRoot, err := requireProject(projectDir)
	if err != nil {
		return FreezeResult{}, err
	}
	delivery, err := decodeCodex(input)
	if err != nil {
		return FreezeResult{}, err
	}
	if delivery.HookEventName != "Stop" {
		return FreezeResult{}, fmt.Errorf("unsupported Review Freeze Hook event: %s", delivery.HookEventName)
	}
	if err := validateDelivery(projectRoot, delivery, false); err != nil {
		return FreezeResult{}, err
	}
	if options.Harness != "" && options.Harness != "codex" {
		return FreezeResult{}, fmt.Errorf("unsupported Review Freeze harness: %s", options.Harness)
	}
	inspection, err := state.InspectActive(projectRoot)
	if err != nil {
		return FreezeResult{}, nil
	}
	if inspection.Kind != state.InspectionVNext {
		return FreezeResult{}, nil
	}
	snapshot, err := state.Read(inspection.RecordDir)
	if err != nil {
		return FreezeResult{Pending: true}, err
	}
	current, freeze, _, err := humanapproval.ReadCurrent(projectRoot, inspection.RecordDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return FreezeResult{}, nil
		}
		return FreezeResult{Pending: true}, err
	}
	if current.Status != humanapproval.StatusPending {
		return FreezeResult{}, nil
	}
	if freeze.IntentID != snapshot.State.IntentID || (freeze.Scope != humanapproval.ScopeRisk && freeze.Scope != string(snapshot.State.CurrentStage)) {
		return FreezeResult{Pending: true}, fmt.Errorf("pending Review Freeze does not bind active Core State")
	}
	reason := "AI-DLC is awaiting explicit human action for " + freeze.Scope + " subject " + freeze.SubjectRef.SHA256 + ". The Review Freeze remains pending; do not continue or auto-approve."
	return FreezeResult{Pending: true, StopReason: reason}, nil
}

func MarshalCaptureResponse(result CaptureResult) ([]byte, error) {
	if !result.Matched {
		return nil, nil
	}
	if result.AdditionalContext == "" {
		return nil, fmt.Errorf("Human Receipt additional context is empty")
	}
	value := userPromptResponse{}
	value.HookSpecificOutput.HookEventName = "UserPromptSubmit"
	value.HookSpecificOutput.AdditionalContext = result.AdditionalContext
	content, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return append(content, '\n'), nil
}

func MarshalCaptureFailureResponse() []byte {
	content, _ := json.Marshal(blockResponse{Decision: "block", Reason: "AI-DLC Human Gate rejected an invalid, stale, or unrecordable confirmation. Re-open the current Decision Review and submit its exact confirmation line."})
	return append(content, '\n')
}

func MarshalFreezeResponse(result FreezeResult) ([]byte, error) {
	if !result.Pending {
		return []byte("{}\n"), nil
	}
	if result.StopReason == "" {
		return nil, fmt.Errorf("Review Freeze stop reason is empty")
	}
	content, err := json.Marshal(stopResponse{Continue: false, StopReason: result.StopReason})
	if err != nil {
		return nil, err
	}
	return append(content, '\n'), nil
}

func MarshalFreezeFailureResponse() []byte {
	content, _ := json.Marshal(stopResponse{Continue: false, StopReason: "AI-DLC stopped because the pending Human Gate could not be validated. Repair Core state before continuing."})
	return append(content, '\n')
}

func decodeCodex(input io.Reader) (codexInput, error) {
	limited := &io.LimitedReader{R: input, N: maxInputBytes + 1}
	content, err := io.ReadAll(limited)
	if err != nil {
		return codexInput{}, err
	}
	if len(content) == 0 || len(content) > maxInputBytes {
		return codexInput{}, fmt.Errorf("Codex Hook input must contain one bounded JSON object")
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	var value codexInput
	if err := decoder.Decode(&value); err != nil {
		return codexInput{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return codexInput{}, fmt.Errorf("Codex Hook input must contain exactly one JSON object")
	}
	return value, nil
}

func validateDelivery(projectRoot string, value codexInput, prompt bool) error {
	for field, text := range map[string]string{"session_id": value.SessionID, "turn_id": value.TurnID} {
		if err := metadata(text, field, 256); err != nil {
			return err
		}
	}
	if value.SessionID == "" {
		return fmt.Errorf("Codex Hook session_id is required")
	}
	if prompt && value.Prompt == "" {
		return fmt.Errorf("Codex UserPromptSubmit prompt is required")
	}
	if value.CWD == "" {
		return nil
	}
	absolute, err := filepath.Abs(value.CWD)
	if err != nil {
		return err
	}
	absolute, err = filepath.EvalSymlinks(filepath.Clean(absolute))
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(projectRoot, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return fmt.Errorf("Codex Hook cwd is outside the Project")
	}
	return nil
}

func requireProject(projectDir string) (string, error) {
	root, err := filepath.Abs(projectDir)
	if err != nil {
		return "", err
	}
	root, err = filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Hook project must be a real directory")
	}
	return root, nil
}

func metadata(value, field string, maximum int) error {
	if len(value) > maximum {
		return fmt.Errorf("Codex Hook %s is too long", field)
	}
	for _, current := range value {
		if current == '\x00' || current == '\r' || current == '\n' || unicode.IsControl(current) {
			return fmt.Errorf("Codex Hook %s contains a control character", field)
		}
	}
	return nil
}

func now(clock func() time.Time) string {
	value := time.Now()
	if clock != nil {
		value = clock()
	}
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
