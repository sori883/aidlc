# Codex Deterministic Sensor Design

## Status and scope

ST-HK-05 adds three Core-owned, standard-library-only Sensors. The production
implementation is `internal/sensor`; `internal/hooksensor` is only the Codex
`PostToolUse` adapter.

| Sensor | Trigger | Severity | Match |
|---|---|---|---|
| `go-format` | write | advisory | `*.go` |
| `json-valid` | write | advisory | `*.json` |
| `artifact-reference-integrity` | gate | blocking | Human Gate Artifact reference |

The catalog is compiled into the Go binary. Prompts, Agents, repository files,
and Hook input cannot define a Sensor or change its severity.

## Write-triggered Hook flow

Codex runs a separate `PostToolUse` command handler matching only
`^apply_patch$`. The adapter validates the completed patch envelope, resolves
Add/Update/Delete/Move paths relative to Hook `cwd`, rejects path escapes and
symlink ancestors, and fires every suffix match. Deleted files are recorded as
matched but are not evaluated.

Write failures are advisory evidence. They never return a Codex deny or block
decision and cannot undo a completed Tool call. Handler input errors also exit
successfully from the CLI after a bounded diagnostic on stderr.

The Sensor ledger separately records:

- the handler was invoked;
- how many paths matched;
- how many Sensors actually fired;
- each last terminal Sensor result.

This avoids treating a valid no-match invocation as proof that a Sensor fired.

## Human Gate flow

Before `humanapproval.Open` creates or reuses a Review Freeze, the blocking
Artifact-reference Sensor runs for the subject, rendered review, and optional
Gate Requirement Set. Each path must remain inside the Project, resolve without
a symlink boundary, be a regular file, and match its pinned canonical SHA-256.

Any failed binding prevents the Human Gate from opening. There is no Human
override because approving different bytes would invalidate the reviewed
subject. A new Artifact reference and Review Freeze are required instead.

## Evidence and deduplication

Every actual evaluation appends an atomic pair to Core Audit:

1. `SENSOR_FIRED`
2. exactly one of `SENSOR_PASSED`, `SENSOR_FAILED`, or
   `SENSOR_BUDGET_OVERRIDE`

Failure detail is stored as immutable canonical JSON below
`artifacts/sensors/findings/`. The ledger at
`artifacts/sensors/current.json` is a current diagnostic index, not workflow
authority.

The deduplication identity binds Sensor, Stage, trigger, Project-relative path,
actual input SHA-256, and—when applicable—the expected SHA-256. Inputs whose
digest is unavailable are evaluated again rather than incorrectly reused.

## Budgets and privacy

Input is limited to 8 MiB. Oversized files produce a paired budget-override
outcome and are never stored. Audit and finding evidence contain only bounded
finding text, identities, paths, and digests; file bodies, patch bodies,
prompts, transcripts, and Tool output are not persisted.

## Operations

```bash
./.codex/tools/aidlc sensor list
./.codex/tools/aidlc sensor describe go-format
./.codex/tools/aidlc sensor status .
./.codex/tools/aidlc sensor fire . go-format path/to/file.go
./.codex/tools/aidlc sensor fire . artifact-reference-integrity path/to/artifact.json sha256:...
```

The installed Project Hook is trusted and loaded by Codex. After an updated
`.codex/hooks.json` is installed, start a new trusted session if the current
session still uses the older Hook snapshot.
