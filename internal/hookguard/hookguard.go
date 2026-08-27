// Package hookguard enforces actor-independent Codex PreToolUse boundaries.
package hookguard

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/sori883/aidlc/internal/contract"
	"github.com/sori883/aidlc/internal/hookaudit"
	"github.com/sori883/aidlc/internal/platform/fsx"
	"github.com/sori883/aidlc/internal/platform/lock"
	stageruntime "github.com/sori883/aidlc/internal/stage/runtime"
	"github.com/sori883/aidlc/internal/stage/st06build"
	"github.com/sori883/aidlc/internal/workflow/state"
	"github.com/sori883/aidlc/internal/workspace"
)

const maxInputBytes = 16 * 1024 * 1024

var (
	shellMutation = regexp.MustCompile(`(?im)(^|[;&|()]\s*)(sudo\s+)?(rm|mv|cp|install|mkdir|rmdir|touch|truncate|tee|dd|chmod|chown|chgrp|ln|patch|gofmt|goimports|make)(\s|$)`)
	gitMutation   = regexp.MustCompile(`(?im)(^|[;&|()]\s*)(sudo\s+)?git\s+(add|rm|mv|checkout|switch|restore|reset|clean|apply|commit|merge|rebase|cherry-pick|stash)(\s|$)`)
	goMutation    = regexp.MustCompile(`(?im)(^|[;&|()]\s*)(sudo\s+)?go\s+(build|generate|install|fmt|mod\s+tidy)(\s|$)`)
	editMutation  = regexp.MustCompile(`(?im)(^|[;&|()]\s*)(sudo\s+)?(sed|perl)\b[^\n;&|]*\s-i(\s|$)`)
	scriptRunner  = regexp.MustCompile(`(?im)(^|[;&|()]\s*)(sudo\s+)?(python[0-9.]*|ruby|node|bash|sh|zsh|pwsh|powershell)(\s|$)`)
	managedToken  = regexp.MustCompile(`(^|[\s'"=;:&|()/])(?:\./)?aidlc(?:/|[\s'"=;:&|()]|$)`)
	authorityHook = regexp.MustCompile(`(?im)(^|[\s'"=;:&|()])(?:\./)?(?:\.codex/tools/)?aidlc(?:\.exe)?\s+hook\s+(receipt|freeze|subagent)(\s|$)`)
)

// Options identifies the Harness and supplies a test clock for denial evidence.
type Options struct {
	Harness string
	Clock   func() time.Time
}

// Result is empty for an allowed call or a Project without an active Intent.
type Result struct {
	Denied      bool
	ReasonCode  string
	Reason      string
	Paths       []string
	AuditFailed bool
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

type hookSpecificOutput struct {
	HookEventName            string `json:"hookEventName"`
	PermissionDecision       string `json:"permissionDecision"`
	PermissionDecisionReason string `json:"permissionDecisionReason"`
}

type response struct {
	HookSpecificOutput hookSpecificOutput `json:"hookSpecificOutput"`
}

type protectedScope struct {
	ProjectRoot    string
	ProtectedRoots []string
	Stage          contract.StageID
	Targets        []allowedTarget
}

type allowedTarget struct {
	Workspace string
	Target    string
}

// Guard validates and evaluates one Codex PreToolUse delivery. It does not
// mutate Core State, Plan, Core Audit, or Stage artifacts.
func Guard(ctx context.Context, projectDir string, input io.Reader, options Options) (Result, error) {
	projectRoot, err := requireProject(projectDir)
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

	var result Result
	err = lock.With(ctx, projectRoot, lock.Options{MaxRetries: 60, Retry: 25 * time.Millisecond}, func(context.Context) error {
		inspection, inspectErr := state.InspectActive(projectRoot)
		if inspectErr != nil {
			activePointer := filepath.Join(workspace.Root(projectRoot), "spaces", workspace.ActiveSpace(projectRoot), "intents", "active-intent")
			if info, statErr := os.Lstat(activePointer); statErr == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
				return fmt.Errorf("Hook Guard: active Intent pointer exists but cannot be validated")
			}
			return nil
		}
		if inspection.Kind != state.InspectionVNext {
			return nil
		}
		snapshot, readErr := state.Read(inspection.RecordDir)
		if readErr != nil {
			return fmt.Errorf("read active vNext State for Hook Guard: %w", readErr)
		}
		scope := protectedScope{
			ProjectRoot: projectRoot,
			ProtectedRoots: []string{
				filepath.Join(projectRoot, "aidlc"),
				filepath.Join(projectRoot, ".codex", "hooks.json"),
				filepath.Join(projectRoot, ".codex", "distribution-manifest.json"),
				filepath.Join(projectRoot, ".codex", "tools"),
				filepath.Join(projectRoot, ".codex", "aidlc-common"),
			},
			Stage: snapshot.State.CurrentStage,
		}
		if scope.Stage == contract.Stage06 {
			targets, targetErr := loadST06Targets(projectRoot, inspection.RecordDir, snapshot)
			if targetErr != nil {
				return targetErr
			}
			scope.Targets = targets
		}
		switch delivery.ToolName {
		case "apply_patch":
			result = guardPatch(scope, cwd, delivery.ToolInput.Command)
		case "Bash":
			result = guardBash(scope, cwd, delivery.ToolInput.Command)
		}
		return nil
	})
	if err != nil || !result.Denied {
		return result, err
	}

	_, auditErr := hookaudit.RecordGuardDenial(ctx, projectRoot, hookaudit.GuardDenial{
		Harness: options.Harness, SessionID: delivery.SessionID, TurnID: delivery.TurnID,
		ToolName: delivery.ToolName, ToolUseID: delivery.ToolUseID,
		ReasonCode: result.ReasonCode, Paths: result.Paths, Clock: options.Clock,
	})
	if auditErr != nil {
		result.AuditFailed = true
		result.Reason = "AI-DLC Hook Guard: denied because the action could not be validated; denial evidence could not be recorded."
	}
	return result, nil
}

// MarshalResponse returns the exact current Codex PreToolUse deny contract.
func MarshalResponse(result Result) ([]byte, error) {
	if !result.Denied {
		return nil, nil
	}
	if result.Reason == "" {
		return nil, fmt.Errorf("Hook Guard denial reason is empty")
	}
	content, err := json.Marshal(response{HookSpecificOutput: hookSpecificOutput{
		HookEventName: "PreToolUse", PermissionDecision: "deny",
		PermissionDecisionReason: result.Reason,
	}})
	if err != nil {
		return nil, fmt.Errorf("encode Codex Hook Guard response: %w", err)
	}
	return append(content, '\n'), nil
}

// MarshalFailureResponse fails closed when the guard input or persisted scope
// cannot be validated. It deliberately omits the underlying error and input.
func MarshalFailureResponse() []byte {
	content, _ := MarshalResponse(Result{Denied: true, Reason: "AI-DLC Hook Guard: denied because the Tool call or active Core scope could not be validated."})
	return content
}

func guardPatch(scope protectedScope, cwd, command string) Result {
	paths, err := patchPaths(scope.ProjectRoot, cwd, command)
	if err != nil {
		return denial("invalid_patch", "AI-DLC Hook Guard: denied an invalid or unscoped apply_patch request.", nil)
	}
	for _, item := range paths {
		if scope.Stage == contract.Stage06 {
			if !targetAllowed(item.absolute, scope.Targets) {
				return denial("st06_target_scope", "AI-DLC Hook Guard: denied a path outside the current ST-06 Bolt Work Request target scope.", relativePaths(paths))
			}
			continue
		}
		if protectedPath(item.absolute, scope.ProtectedRoots) {
			return denial("core_owned_path", "AI-DLC Hook Guard: denied a direct change to Core-owned AI-DLC state or Harness runtime files.", relativePaths(paths))
		}
	}
	return Result{}
}

func guardBash(scope protectedScope, cwd, command string) Result {
	if authorityHook.MatchString(command) {
		return denial("hook_handler_invocation", "AI-DLC Hook Guard: denied direct invocation of a Human authority Hook handler; only Codex lifecycle delivery may invoke it.", nil)
	}
	if !mutationCapable(command) {
		return Result{}
	}
	if scope.Stage == contract.Stage06 {
		return denial("st06_bash_mutation", "AI-DLC Hook Guard: denied a mutation-capable Bash command during ST-06; use apply_patch so every path can be checked against the current Bolt targets.", nil)
	}
	if protectedPath(cwd, scope.ProtectedRoots) || referencesProtectedArea(command, scope) {
		return denial("core_owned_path", "AI-DLC Hook Guard: denied a Bash mutation targeting Core-owned AI-DLC state or Harness runtime files.", nil)
	}
	return Result{}
}

func loadST06Targets(projectRoot, recordDir string, snapshot state.Snapshot) ([]allowedTarget, error) {
	if snapshot.State.Status != state.Ready {
		return nil, fmt.Errorf("Hook Guard: ST-06 State is not ready for assigned work")
	}
	session, _, _, err := stageruntime.ReadCanonical[st06build.Session](projectRoot, st06build.SessionPath(recordDir), "build-session", 1)
	if err != nil {
		return nil, fmt.Errorf("validate ST-06 Build Session for Hook Guard: %w", err)
	}
	if session.IntentID != snapshot.State.IntentID || session.StageID != contract.Stage06 || session.Disposition != contract.Execute || session.Status != "active" || session.CurrentBoltID == nil {
		return nil, fmt.Errorf("Hook Guard: ST-06 Build Session is not active and bound to the current Intent")
	}
	if session.SchemaVersion != 1 || session.Artifact != "build-session" || session.Version != 1 || session.SessionID == "" {
		return nil, fmt.Errorf("Hook Guard: ST-06 Build Session has an invalid schema identity")
	}
	request, _, _, err := stageruntime.ReadCanonical[st06build.WorkRequest](projectRoot, st06build.WorkRequestPath(recordDir, *session.CurrentBoltID), "bolt-work-request", 1)
	if err != nil {
		return nil, fmt.Errorf("validate ST-06 Work Request for Hook Guard: %w", err)
	}
	if request.IntentID != snapshot.State.IntentID || request.SessionID != session.SessionID || request.StageID != contract.Stage06 || request.Bolt.BoltID != *session.CurrentBoltID || request.Attempt < 1 {
		return nil, fmt.Errorf("Hook Guard: ST-06 Work Request is not bound to the current Build Session")
	}
	if request.SchemaVersion != 1 || request.Artifact != "bolt-work-request" || request.Version != 1 || request.RequestedOutput != "repository-changes" {
		return nil, fmt.Errorf("Hook Guard: ST-06 Work Request has an invalid schema identity")
	}
	worktreesRoot := filepath.Join(st06build.RootDir(recordDir), "worktrees")
	var targets []allowedTarget
	for _, workspace := range request.SourceWorkspaces {
		root, err := realDirectory(workspace.WorktreePath)
		if err != nil || !pathWithin(root, worktreesRoot) {
			return nil, fmt.Errorf("Hook Guard: ST-06 source Worktree is invalid")
		}
		matched := false
		for _, target := range request.Bolt.Targets {
			if target.SourceID != workspace.SourceID {
				continue
			}
			portable := filepath.ToSlash(target.Path)
			absolute, resolveErr := fsx.ResolveUnder(root, portable, true)
			if resolveErr != nil {
				return nil, fmt.Errorf("Hook Guard: ST-06 target is invalid: %w", resolveErr)
			}
			targets = append(targets, allowedTarget{Workspace: root, Target: filepath.Clean(absolute)})
			matched = true
		}
		if !matched {
			return nil, fmt.Errorf("Hook Guard: ST-06 source Worktree has no Bolt target")
		}
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("Hook Guard: ST-06 Work Request has no allowed target")
	}
	sort.Slice(targets, func(i, j int) bool {
		if targets[i].Workspace == targets[j].Workspace {
			return targets[i].Target < targets[j].Target
		}
		return targets[i].Workspace < targets[j].Workspace
	})
	return targets, nil
}

type patchPath struct {
	absolute string
	relative string
}

func patchPaths(projectRoot, cwd, patch string) ([]patchPath, error) {
	if patch == "" || !strings.Contains(patch, "*** Begin Patch") || !strings.Contains(patch, "*** End Patch") {
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
		absolute = filepath.Clean(absolute)
		if !pathWithin(absolute, projectRoot) {
			return nil, fmt.Errorf("patch path is outside Project")
		}
		relative, err := filepath.Rel(projectRoot, absolute)
		if err != nil {
			return nil, err
		}
		values = append(values, patchPath{absolute: absolute, relative: filepath.ToSlash(relative)})
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

func targetAllowed(candidate string, targets []allowedTarget) bool {
	for _, target := range targets {
		if pathWithin(candidate, target.Workspace) && pathWithin(candidate, target.Target) {
			return true
		}
	}
	return false
}

func mutationCapable(command string) bool {
	if strings.Contains(command, ">") {
		return true
	}
	return shellMutation.MatchString(command) || gitMutation.MatchString(command) || goMutation.MatchString(command) || editMutation.MatchString(command) || scriptRunner.MatchString(command)
}

func referencesProtectedArea(command string, scope protectedScope) bool {
	portable := filepath.ToSlash(command)
	for _, root := range scope.ProtectedRoots {
		if strings.Contains(portable, filepath.ToSlash(root)) {
			return true
		}
	}
	return managedToken.MatchString(portable) || strings.Contains(portable, ".codex/hooks.json") ||
		strings.Contains(portable, ".codex/distribution-manifest.json") || strings.Contains(portable, ".codex/tools/") ||
		strings.Contains(portable, ".codex/aidlc-common/")
}

func protectedPath(candidate string, roots []string) bool {
	for _, root := range roots {
		if pathWithin(candidate, root) {
			return true
		}
	}
	return false
}

func relativePaths(values []patchPath) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, value.relative)
	}
	return result
}

func denial(code, reason string, paths []string) Result {
	return Result{Denied: true, ReasonCode: code, Reason: reason, Paths: paths}
}

func pathWithin(candidate, root string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func requireProject(projectDir string) (string, error) {
	return realDirectory(projectDir)
}

func realDirectory(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve directory: %w", err)
	}
	absolute, err = filepath.EvalSymlinks(filepath.Clean(absolute))
	if err != nil {
		return "", fmt.Errorf("resolve directory real path: %w", err)
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("directory must be a real directory: %s", absolute)
	}
	return absolute, nil
}

func decodeCodex(input io.Reader) (codexInput, error) {
	limited := &io.LimitedReader{R: input, N: maxInputBytes + 1}
	content, err := io.ReadAll(limited)
	if err != nil {
		return codexInput{}, fmt.Errorf("read Codex Hook Guard input: %w", err)
	}
	if len(content) == 0 || len(content) > maxInputBytes {
		return codexInput{}, fmt.Errorf("Codex Hook Guard input must contain one bounded JSON object")
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	var value codexInput
	if err := decoder.Decode(&value); err != nil {
		return codexInput{}, fmt.Errorf("decode Codex Hook Guard input: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return codexInput{}, fmt.Errorf("Codex Hook Guard input must contain exactly one JSON object")
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
		return "", fmt.Errorf("Codex Hook Guard requires session_id, tool_use_id, and cwd")
	}
	if value.HookEventName != "PreToolUse" {
		return "", fmt.Errorf("unsupported Codex Hook Guard event: %s", value.HookEventName)
	}
	if value.ToolName != "Bash" && value.ToolName != "apply_patch" {
		return "", fmt.Errorf("unsupported Codex Hook Guard tool: %s", value.ToolName)
	}
	if value.ToolInput.Command == "" {
		return "", fmt.Errorf("Codex Hook Guard tool_input.command is required")
	}
	cwd, err := realDirectory(value.CWD)
	if err != nil || !pathWithin(cwd, projectRoot) {
		return "", fmt.Errorf("Codex Hook Guard cwd is outside the Project")
	}
	return cwd, nil
}

func metadata(value, name string, maximum int) error {
	if len(value) > maximum {
		return fmt.Errorf("Codex Hook Guard %s is too long", name)
	}
	for _, current := range value {
		if current == '\x00' || current == '\r' || current == '\n' || unicode.IsControl(current) {
			return fmt.Errorf("Codex Hook Guard %s contains a control character", name)
		}
	}
	return nil
}
