# Codex PreToolUse Guard Design

## Status and scope

ST-HK-03 adds an actor-independent Tool boundary to the Codex Harness. The
production implementation is the Go package `internal/hookguard` and command:

```bash
./.codex/tools/aidlc hook guard <project-dir> --harness codex
```

The approved implementation plan is `docs/codex-hook-guard-plan.md`. Human
approval receipts and Stop Review Freeze control were added separately in
ST-HK-04; their source of truth is `docs/codex-hook-human-approval-design.md`.
Sensors were added separately in ST-HK-05; their source of truth is
`docs/codex-hook-sensor-design.md`. This Guard stage does not implement
heartbeat diagnostics.

## Codex event contract

The Guard is a separate `PreToolUse` command handler with the matcher
`^(Bash|apply_patch)$`. The metadata-only audit handler remains a separate,
broader handler. Codex may launch both handlers concurrently, so neither depends
on the other's ordering or output.

Allowed calls and Projects without an active vNext Intent produce no stdout. A
denied call exits successfully with only this event-specific JSON shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "AI-DLC Hook Guard: ..."
  }
}
```

The Guard never emits `allow`, `ask`, `updatedInput`, or exit code 2. Invalid
input, an unsupported delivery, or an invalid persisted ST-06 scope returns a
generic deny response rather than exposing validation detail and allowing the
Tool through after a Hook failure.

## Protected paths

For an active Intent outside ST-06, `apply_patch` may write normal Project files
but cannot write anything below the Project's `aidlc/` management root. This
single boundary covers State, Plan, Core Audit, Hook Journal, Work Requests,
Current pointers, revisions, reviews, candidates, approvals, receipts, and
Evidence without relying on an incomplete filename list.

The installed Harness authority files are protected as well:
`.codex/hooks.json`, `.codex/distribution-manifest.json`, `.codex/tools/`, and
`.codex/aidlc-common/`. Direct Bash invocation of the Human authority
`hook receipt` and `hook freeze` handlers is denied; normal lifecycle delivery
invokes those handlers without going through a Bash Tool call.

Patch paths must use the Codex patch envelope and Add, Update, Delete, or Move
headers. Every path must be normalized and relative to the Hook `cwd`, remain
inside the Project, and have no symlink ancestor. A malformed or pathless patch
is denied.

## ST-06 target scope

When persisted State says `ST-06`, the Guard validates the canonical active
Build Session and its current Bolt Work Request. It derives the allow-set from:

- `source_workspaces[].worktree_path`
- `bolt.targets[].source_id`
- `bolt.targets[].path`

An `apply_patch` path is allowed only when it belongs to the matching source
Worktree and equals a declared target or is below that target. Original source
repositories, another Bolt or attempt, integration Worktrees, and all other
Project files are denied.

A general Bash string is not a typed path mutation request. During ST-06,
mutation-capable Bash forms such as redirection, file commands, in-place
formatters, mutating Git operations, scripting runtimes, and build/generate
commands are denied. Read-only inspection and verifier-style commands remain
available. Agents use `apply_patch` for mutations so the Guard can check every
declared path. Core's existing changed-path collection remains authoritative and
catches changes made outside this Hook boundary.

## Actor and authority boundary

Current Codex `PreToolUse` input has Tool and session identity but no Agent role.
The Guard therefore does not infer Conductor, reviewer, or Stage Agent authority
and cannot create role-specific exceptions. The same persisted scope applies to
every actor.

The Guard does not transition State, revise the Plan, approve a candidate, run a
verifier, or execute a release. Core validation and Human decisions remain the
only workflow authorities.

## Root discovery

All Codex command handlers now walk parent directories from the session working
directory and select the first directory containing both the distribution
manifest and native launcher. They no longer call `git rev-parse`. This binds a
nested ST-06 Git Worktree and a non-Git Project to the installed AI-DLC Project,
not to whichever Git repository happens to contain the current directory.

## Denial evidence and privacy

Denied calls append `HOOK_GUARD_DENIED` to the active Intent's non-authoritative
Hook Journal. The row contains bounded session, turn, Tool, event, reason-code,
State identity, and normalized Project-relative path metadata. It has no field
for a command, patch body, prompt, task, transcript, Tool output, or secret.

Regular `HOOK_TOOL_BEFORE` observation and denial evidence have distinct stable
event identities, so concurrent handlers can record both without treating one as
a duplicate of the other.

## Defense in depth and limitations

`apply_patch` path enforcement is deterministic. Bash classification is
deliberately conservative but is not a complete shell parser and cannot prove
the effect of every variable expansion, child process, or indirect program.
Therefore the Hook is an early rejection boundary, not the Core source of truth.
Artifact hashes, reference verification, immutable artifacts, State/Plan
binding, Doctor checks, and ST-06 changed-path validation continue to fail closed.
