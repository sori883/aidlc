# Codex Hook Audit — ST-HK-01

## Purpose

ST-HK-01 records metadata observed at Codex hook boundaries without granting
the hook layer any Core authority. Core continues to own the fixed Stage
Graph, Workflow State, Stage Execution Plan, approval decisions, and the
canonical Markdown Audit.

This stage implements observation only. It does not block tools, inject
context, route Stages, run sensors, continue stopped turns, or mutate Core
State.

## Data boundary

The records and ephemeral control marker have different authority:

| Record | Location | Authority |
|---|---|---|
| Core Audit | `aidlc/spaces/<space>/intents/<intent>/audit/*.md` | Canonical |
| Hook Journal | `aidlc/spaces/<space>/intents/<intent>/hook-audit/*.jsonl` | Observed, non-authoritative |
| Human Turn Marker | Operating-system temporary directory | Ephemeral, non-audit control state |

The Hook Journal is attached to the active vNext Intent at the time an event
is observed. Events received without an active vNext Intent are ignored.

## Observed events

| Codex event | Journal kind |
|---|---|
| `SessionStart` | `HOOK_SESSION_STARTED` |
| `SessionEnd` | `HOOK_SESSION_ENDED` |
| `SubagentStart` | `HOOK_SUBAGENT_STARTED` |
| `SubagentStop` | `HOOK_SUBAGENT_STOPPED` |
| `PreToolUse` | `HOOK_TOOL_BEFORE` |
| `PostToolUse` | `HOOK_TOOL_AFTER` |
| `PermissionRequest` | `HOOK_PERMISSION_REQUESTED` |
| `PreCompact` | `HOOK_COMPACTION_STARTED` |
| `PostCompact` | `HOOK_COMPACTION_COMPLETED` |
| `Stop` | `HOOK_STOP_OBSERVED` |

Tool events are limited in `hooks.json` to `Bash`, `apply_patch`,
`spawn_agent`, `request_user_input`, and `update_plan`.

`UserPromptSubmit` is deliberately not a Hook Journal event. The independent
`hook turn` handler updates one empty session-scoped marker in the
operating-system temporary directory. Project and Session identities appear
only as SHA-256 digests in its path. The marker has no content and is replaced
on each turn, so it stores neither prompt text, Turn ID, nor a turn count.

The independent Human Receipt handler persists only an exact generated
`/aidlc-confirm` confirmation. An ordinary prompt creates no Receipt and no
handler-health entry. Existing append-only Journal shards are not rewritten;
historical human-turn rows can remain in shards created by earlier versions.

## Privacy and normalization

The recorder persists identifiers and lifecycle metadata only. It never
persists prompt text, answers, Bash commands, patch bodies, tool responses,
model output, or transcript paths. For `apply_patch`, it extracts only safe,
Project-relative touched paths. Absolute, parent-traversing, malformed, or
out-of-Project paths are represented only by `excluded_path_count`.

Each JSONL row contains schema version, UTC timestamp, clone-local sequence,
event ID, normalized kind, Codex source event, harness, active Intent and Stage,
and the supported correlation identifiers present on that event.

## Reliability

- The existing Workspace lock serializes clone-local appends.
- Each clone writes its own `<host>-<clone>.jsonl` shard.
- Stable Codex identifiers produce a deterministic event ID.
- A short-lived claim in the operating-system temporary directory suppresses
  nearby duplicate deliveries. The event ID remains in the journal so readers
  can also collapse a duplicate after temporary state is lost.
- Journal writes are append-only and synced before success is returned.
- Recording failures return a normal error (`exit 1`), never the blocking
  hook exit code `2`.

## CLI

```text
aidlc hook record <project-dir> --harness codex
aidlc hook turn <project-dir> --harness codex
aidlc hook status <project-dir>
```

`record` consumes one Codex hook JSON object from standard input and produces
no standard output. It does not accept `UserPromptSubmit`; Codex routes that
event to `turn` and the independent Human Receipt handler. `status` reports
whether an active Intent has Hook Journal evidence and identifies its latest
local event.

## Deferred stages

The following remain outside ST-HK-01 and require separate approval:

- context injection and Stage-rule delivery;
- approval, reviewer-scope, review-freeze, and State-transition guards;
- sensor execution, plan synchronization, recovery, and Stop continuation;
- doctor heartbeat and trust diagnostics.
