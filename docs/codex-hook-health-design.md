# Codex Hook Health and Doctor Design

## Evidence model

ST-HK-07 deliberately separates six questions:

| Question | Evidence |
|---|---|
| Did Codex deliver a lifecycle event? | metadata-only Hook Journal |
| Did a specific AI-DLC handler run? | handler heartbeat ledger |
| Did a changed path match a Sensor? | Sensor observation `matched` |
| Did the Sensor evaluate bytes? | Sensor observation `fired` and `SENSOR_FIRED` |
| What was the deterministic result? | paired terminal Sensor Audit and finding |
| Was a Stage Agent result binding valid? | immutable delegation result Receipt |

No one row is substituted for another. In particular, a `PostToolUse` Journal
entry does not prove the Sensor handler ran, and a Sensor handler invocation
with no matching path does not produce fake `SENSOR_FIRED` evidence.

## Handler heartbeat

Production Hook CLI routes update
`artifacts/hook-health/current.json` after their handler returns. The ledger
contains handler, source event, invocation/success/failure counts, bounded last
outcome/failure code, and time. It never stores prompts, commands, patches,
Tool output, last assistant messages, or transcripts.

The ephemeral Human Turn handler is intentionally excluded from this ledger.
An ordinary Human Receipt no-op is also excluded. Therefore a normal question
does not leave a persistent invocation count or last-observed timestamp.

Supported handler identities are fixed: `audit`, `context`, `guard`,
`human-receipt`, `review-freeze`, `sensor`, and `subagent`. Heartbeat write
failure cannot change the lifecycle handler's allow/deny/stop response.

## Installed configuration validation

When both `.codex/distribution-manifest.json` and `.codex/hooks.json` identify
an installed Project runtime, Doctor verifies:

- ten persistent lifecycle events have exactly one audit handler, while
  `UserPromptSubmit` has one ephemeral Turn Marker handler and no audit handler;
- context, Human Receipt, Review Freeze, Guard, Sensor, and Subagent result
  handlers each occur exactly once on the correct event;
- each required matcher, timeout, and additional-context limit;
- both POSIX and Windows commands use the distribution manifest and installed
  native launcher ancestor locator.

Missing, duplicate, malformed, symlinked, or miswired required handlers are
errors. Additional non-AI-DLC handlers are not rejected.

When no installed Project-local runtime exists, Doctor emits an informational
skip. A valid file does not prove Codex trusted or loaded it; only subsequent
Journal and heartbeat evidence can demonstrate observed activity. Project-local
Hooks must be reviewed/trusted, and an updated configuration may require a new
Codex session.

## Severity

- Error: invalid installed wiring, corrupt health/Sensor/Receipt evidence, or
  other invalid Core bindings. `healthy` becomes false.
- Warning: valid wiring but a required handler has not yet been observed,
  handler failures exist, a Sensor path matched without fire, a current Sensor
  finding failed, or a budget override occurred.
- Info: valid wiring, heartbeat present, no-match observation, actual Sensor
  fire, valid Hook Journal activity, or valid delegation Receipts.

Not-yet-observed is expected in a new Intent and does not make Core unhealthy.

## Operations

```bash
./.codex/tools/aidlc hook status .
./.codex/tools/aidlc sensor status .
./.codex/tools/aidlc doctor check .
```

`hook status` preserves the Hook Journal summary and adds `handler_health`,
`sensors`, and `delegation_results`. Doctor is read-only for every Hook health
artifact; repair does not rewrite Hook wiring or evidence.
