# Codex SubagentStop Result Control Design

## Status and authority boundary

ST-HK-06 adds the Go package `internal/hooksubagent` and command:

```bash
./.codex/tools/aidlc hook subagent <project-dir> --harness codex
```

The Codex `SubagentStop` matcher is `^aidlc-.*-agent$`. The metadata-only audit
handler remains separate and may run concurrently. A validated Receipt proves
only that the Stage Agent return contract and current file bindings matched; it
does not mean Core accepted the work.

## Structured return contract

The last assistant message must contain exactly one single-line marker:

```text
AIDLC_STAGE_RESULT: {"schema_version":1,"agent_name":"aidlc-...-agent","stage_id":"ST-01","assignment_kind":"work","role":"lead","status":"completed","mutation_scope":"proposal-only","outputs":[],"reviewed_paths":[],"checks":[],"skills":["aidlc-stage-work"],"unresolved_questions":[]}
```

Unknown JSON fields, missing arrays, duplicate values, multiline values,
identity mismatches, missing required Skills, and invalid status/scope
combinations are rejected. Work returns `completed`; review returns `ready` or
`not-ready`; either may return `blocked` with at least one unresolved question.
Although a work assignment has one catalog mutation scope, its configured
`reviewer_agent` is always derived as `read-only` and uses review statuses.

## File binding

- `proposal-only`: every non-deleted output is a regular, non-symlink,
  Project-relative file with its current SHA-256. `aidlc/` and `.codex/` are
  forbidden.
- `assigned-worktree`: every output is inside a current ST-06 Build Session
  Worktree and one of the current Bolt target roots. Deleted files use a null
  digest. Core still performs authoritative Git changed-path collection.
- `read-only`: outputs must be empty. At least one reviewed Project-relative
  regular file and exact SHA-256 are required.

The Hook cannot prove the Conductor's conversationally assigned proposal path,
because Codex SubagentStop does not carry that trusted assignment. It therefore
enforces the fixed catalog boundary and protected roots; Core validates the
specific proposal it later receives.

## Bounded continuation

An invalid contract first returns:

```json
{"decision":"block","reason":"AI-DLC Stage result is invalid (...). ..."}
```

This continues only the subagent flow. A second invalid stop, or an input where
`stop_hook_active` is already true, returns common stop JSON with
`"continue":false`. The Conductor then receives an unvalidated result and must
not submit it to Core. The attempt ledger stores only Agent/Stage identities,
failure code, signature, count, and time—not the response or transcript.

Unexpected handler failures return `{}` to avoid trapping a subagent. This is
fail-open only for conversation control: the required immutable Receipt is
absent, so the Conductor and Core workflow must fail closed on acceptance.

## Receipt and privacy

Accepted markers create canonical immutable Receipts below
`artifacts/delegation/receipts/<agent-id>/` and a verified current pointer. The
Receipt contains the structured marker and bindings, never the full assistant
message or `agent_transcript_path`. Inspect it with:

```bash
./.codex/tools/aidlc delegation receipt . agent-123
```

Direct Bash invocation of `hook subagent` is denied by the PreToolUse Guard so
an Agent cannot manufacture a lifecycle delivery through the tool interface.
