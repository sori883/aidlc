package doctor

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/sori883/aidlc/internal/hookaudit"
	"github.com/sori883/aidlc/internal/hookhealth"
	"github.com/sori883/aidlc/internal/hooksubagent"
	"github.com/sori883/aidlc/internal/platform/jsonx"
	"github.com/sori883/aidlc/internal/sensor"
)

type hookConfiguration struct {
	Description string                 `json:"description"`
	Hooks       map[string][]hookGroup `json:"hooks"`
}

type hookGroup struct {
	Matcher  string        `json:"matcher"`
	Handlers []hookCommand `json:"hooks"`
}

type hookCommand struct {
	Type                   string `json:"type"`
	Command                string `json:"command"`
	CommandWindows         string `json:"commandWindows"`
	Timeout                int    `json:"timeout"`
	AdditionalContextLimit int    `json:"additionalContextLimit"`
}

type handlerExpectation struct {
	event   string
	handler string
	matcher string
	timeout int
	limit   int
}

var requiredHookEvents = []string{
	"SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop",
	"PreToolUse", "PostToolUse", "PermissionRequest", "PreCompact", "PostCompact", "Stop",
}

func checkHookRuntime(projectDir, recordDir string) []Finding {
	manifestPath := filepath.Join(projectDir, ".codex", "distribution-manifest.json")
	hooksPath := filepath.Join(projectDir, ".codex", "hooks.json")
	manifestExists, manifestErr := regularNonSymlink(manifestPath)
	hooksExists, hooksErr := regularNonSymlink(hooksPath)
	if !manifestExists && !hooksExists && os.IsNotExist(manifestErr) && os.IsNotExist(hooksErr) {
		return []Finding{finding(Info, "VNEXT_HOOK_RUNTIME_NOT_INSTALLED", "No installed Project-local Codex Hook runtime was found; Hook runtime diagnostics were skipped.", false)}
	}
	var findings []Finding
	if !manifestExists || !hooksExists {
		findings = append(findings, finding(Error, "VNEXT_HOOK_CONFIG_INVALID", "Installed Hook runtime requires regular non-symlink distribution-manifest.json and hooks.json files.", false))
		return findings
	}
	configuration, err := jsonx.ReadFile[hookConfiguration](hooksPath)
	if err != nil {
		findings = append(findings, finding(Error, "VNEXT_HOOK_CONFIG_INVALID", err.Error(), false))
		return findings
	}
	if err := validateHookConfiguration(configuration); err != nil {
		findings = append(findings, finding(Error, "VNEXT_HOOK_CONFIG_INVALID", err.Error(), false))
	} else {
		findings = append(findings, finding(Info, "VNEXT_HOOK_CONFIG_VALID", "Installed Codex Hook wiring contains each required AI-DLC handler, matcher, timeout, and Project locator exactly once. Codex must still trust and load this Project-local configuration.", false))
	}

	health, err := hookhealth.Inspect(recordDir)
	if err != nil {
		findings = append(findings, finding(Error, "VNEXT_HOOK_HEALTH_INVALID", err.Error(), false))
	} else if !health.Present {
		findings = append(findings, finding(Warning, "VNEXT_HOOK_HANDLERS_NOT_OBSERVED", "No handler-specific heartbeat has been recorded for the active Intent yet.", false))
	} else {
		findings = append(findings, hookHealthFindings(health)...)
	}

	auditStatus, err := hookaudit.Inspect(projectDir)
	if err != nil {
		findings = append(findings, finding(Error, "VNEXT_HOOK_JOURNAL_INVALID", err.Error(), false))
	} else if auditStatus.Entries == 0 {
		findings = append(findings, finding(Warning, "VNEXT_HOOK_EVENTS_NOT_OBSERVED", "The Hook audit handler has not recorded a lifecycle event for the active Intent.", false))
	} else {
		findings = append(findings, finding(Info, "VNEXT_HOOK_EVENTS_OBSERVED", fmt.Sprintf("Hook audit observed %d entries across %d shard(s), with %d duplicate event IDs.", auditStatus.Entries, auditStatus.Shards, auditStatus.DuplicateEvents), false))
	}

	sensorStatus, err := sensor.Inspect(recordDir)
	if err != nil {
		findings = append(findings, finding(Error, "VNEXT_SENSOR_LEDGER_INVALID", err.Error(), false))
	} else {
		findings = append(findings, sensorFindings(sensorStatus)...)
	}

	inventory, err := hooksubagent.InspectAll(projectDir)
	if err != nil {
		// No Receipt directory is a valid state before an Agent result. Any
		// present but invalid inventory is an error.
		if _, statErr := os.Lstat(filepath.Join(recordDir, "artifacts", "delegation", "current")); statErr == nil {
			findings = append(findings, finding(Error, "VNEXT_DELEGATION_RECEIPT_INVALID", err.Error(), false))
		} else {
			findings = append(findings, finding(Info, "VNEXT_DELEGATION_RECEIPT_NOT_OBSERVED", "No validated Stage Agent result Receipt exists for the active Intent yet.", false))
		}
	} else if inventory.ValidReceipts == 0 {
		findings = append(findings, finding(Info, "VNEXT_DELEGATION_RECEIPT_NOT_OBSERVED", "No validated Stage Agent result Receipt exists for the active Intent yet.", false))
	} else {
		findings = append(findings, finding(Info, "VNEXT_DELEGATION_RECEIPTS_VALID", fmt.Sprintf("%d current Stage Agent result Receipt(s) have valid immutable bindings.", inventory.ValidReceipts), false))
	}
	return findings
}

func validateHookConfiguration(configuration hookConfiguration) error {
	if configuration.Hooks == nil {
		return fmt.Errorf("Codex Hook configuration has no hooks map")
	}
	var expectations []handlerExpectation
	for _, event := range requiredHookEvents {
		matcher := ""
		switch event {
		case "PreToolUse", "PostToolUse":
			matcher = "^(Bash|apply_patch|spawn_agent|request_user_input|update_plan)$"
		case "PermissionRequest":
			matcher = "^(Bash|apply_patch)$"
		}
		handler := "record"
		if event == "UserPromptSubmit" {
			handler = "turn"
		}
		expectations = append(expectations, handlerExpectation{event: event, handler: handler, matcher: matcher, timeout: 3})
	}
	expectations = append(expectations,
		handlerExpectation{event: "SessionStart", handler: "inject", timeout: 3, limit: 12000},
		handlerExpectation{event: "SubagentStart", handler: "inject", timeout: 3, limit: 12000},
		handlerExpectation{event: "UserPromptSubmit", handler: "receipt", timeout: 3, limit: 2000},
		handlerExpectation{event: "SubagentStop", handler: "subagent", matcher: "^aidlc-.*-agent$", timeout: 5},
		handlerExpectation{event: "PreToolUse", handler: "guard", matcher: "^(Bash|apply_patch)$", timeout: 3},
		handlerExpectation{event: "PostToolUse", handler: "sensor", matcher: "^apply_patch$", timeout: 5},
		handlerExpectation{event: "Stop", handler: "freeze", timeout: 3},
	)
	for _, expected := range expectations {
		groups, ok := configuration.Hooks[expected.event]
		if !ok {
			return fmt.Errorf("Codex Hook configuration is missing %s", expected.event)
		}
		count := 0
		for _, group := range groups {
			for _, handler := range group.Handlers {
				token := "hook " + expected.handler
				if !strings.Contains(handler.Command, token) || !strings.Contains(handler.CommandWindows, token) {
					continue
				}
				count++
				if group.Matcher != expected.matcher || handler.Type != "command" || handler.Timeout != expected.timeout || handler.AdditionalContextLimit != expected.limit {
					return fmt.Errorf("Codex %s hook %s has an invalid matcher or handler contract", expected.event, expected.handler)
				}
				combined := handler.Command + handler.CommandWindows
				for _, required := range []string{"distribution-manifest.json", ".codex/tools/aidlc", "aidlc.exe"} {
					if !strings.Contains(combined, required) {
						return fmt.Errorf("Codex %s hook %s has an invalid Project locator", expected.event, expected.handler)
					}
				}
			}
		}
		if count != 1 {
			return fmt.Errorf("Codex %s hook %s count is %d, want exactly 1", expected.event, expected.handler, count)
		}
	}
	return nil
}

func hookHealthFindings(status hookhealth.Status) []Finding {
	var findings []Finding
	present := map[string]bool{}
	for _, entry := range status.Entries {
		present[entry.Handler+"\x00"+entry.SourceEvent] = true
		if entry.Failures > 0 && entry.LastFailureCode != "" {
			findings = append(findings, finding(Warning, "VNEXT_HOOK_HANDLER_FAILURE", fmt.Sprintf("Handler %s for %s has %d failure(s); last outcome is %s.", entry.Handler, entry.SourceEvent, entry.Failures, entry.LastOutcome), false))
		}
	}
	required := []string{
		"context\x00SessionStart", "context\x00SubagentStart", "guard\x00PreToolUse",
		"human-receipt\x00UserPromptSubmit", "review-freeze\x00Stop",
		"sensor\x00PostToolUse", "subagent\x00SubagentStop",
	}
	var missing []string
	for _, key := range required {
		if !present[key] {
			missing = append(missing, strings.ReplaceAll(key, "\x00", "/"))
		}
	}
	if len(missing) > 0 {
		findings = append(findings, finding(Warning, "VNEXT_HOOK_HANDLERS_NOT_OBSERVED", "No heartbeat has yet been observed for: "+strings.Join(missing, ", ")+".", false))
	}
	findings = append(findings, finding(Info, "VNEXT_HOOK_HEARTBEAT_PRESENT", fmt.Sprintf("Handler heartbeat contains %d handler/event pair(s).", len(status.Entries)), false))
	return findings
}

func sensorFindings(status sensor.Status) []Finding {
	if !status.Present {
		return []Finding{finding(Warning, "VNEXT_SENSOR_HANDLER_NOT_OBSERVED", "No Sensor handler observation or Sensor result exists for the active Intent yet.", false)}
	}
	var findings []Finding
	for _, observation := range status.Observations {
		switch {
		case observation.Matched == 0:
			findings = append(findings, finding(Info, "VNEXT_SENSOR_HANDLER_OBSERVED_NO_MATCH", fmt.Sprintf("Sensor handler %s observed %s, but no configured path matched.", observation.Handler, observation.SourceEvent), false))
		case observation.Fired == 0:
			findings = append(findings, finding(Warning, "VNEXT_SENSOR_MATCHED_NOT_FIRED", fmt.Sprintf("Sensor handler matched %d path(s) for %s but fired no Sensor.", observation.Matched, observation.SourceEvent), false))
		default:
			findings = append(findings, finding(Info, "VNEXT_SENSOR_FIRED", fmt.Sprintf("Sensor handler last matched %d path(s) and fired %d Sensor(s) for %s.", observation.Matched, observation.Fired, observation.SourceEvent), false))
		}
	}
	failed := 0
	budget := 0
	for _, entry := range status.Entries {
		if entry.Outcome == "failed" {
			failed++
		}
		if entry.Outcome == "budget-override" {
			budget++
		}
	}
	if failed > 0 {
		findings = append(findings, finding(Warning, "VNEXT_SENSOR_FINDINGS_PRESENT", fmt.Sprintf("%d current Sensor binding(s) have a failed terminal result.", failed), false))
	}
	if budget > 0 {
		findings = append(findings, finding(Warning, "VNEXT_SENSOR_BUDGET_OVERRIDE_PRESENT", fmt.Sprintf("%d current Sensor binding(s) exceeded the deterministic input budget.", budget), false))
	}
	return findings
}

func regularNonSymlink(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return false, fmt.Errorf("path is not a regular non-symlink file: %s", path)
	}
	return true, nil
}
