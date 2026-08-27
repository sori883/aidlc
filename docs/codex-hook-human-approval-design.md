# Codex Human Input Receipt and Review Freeze Design

## Scope

ST-HK-04 makes explicit human input a verifiable prerequisite for Human Gate mutations in
ST-04, ST-05, ST-07, ST-08, ST-09, and Intent Risk. The production implementation is the Go
package `internal/workflow/humanapproval`, the Codex adapter `internal/hookapproval`, and these
commands:

```bash
./.codex/tools/aidlc human-gate status .
./.codex/tools/aidlc human-gate prepare . human-action-proposal.json
./.codex/tools/aidlc human-gate apply . sha256:...
```

The approved implementation plan is `docs/codex-hook-human-approval-plan.md`.

## Authority flow

```text
Stage/Risk Core review
        │
        ▼
immutable Review Freeze ── pins subject, review, gate, graph, plan, allowed actions
        │
AI action proposal
        ▼
immutable Decision Envelope + escaped HTML ── exact action, reason, parameters
        │
human sends exact /aidlc-confirm line in Codex
        ▼
UserPromptSubmit Hook ── metadata-only Human Input Receipt
        │
human-gate apply validates one-time Proof
        ▼
Stage/Risk human decision artifact ── human_input_receipt_ref
        │
        ▼
immutable Resolution ── receipt + envelope + freeze + decision
```

Creating a proposal or Envelope grants no authority. A `PermissionRequest` approval is Tool
permission and is not treated as workflow approval. Only an exact `UserPromptSubmit` delivery can
create the Receipt used by Core.

## Persisted artifacts

Artifacts live below the active Intent's `artifacts/human-approval/` directory.

| Artifact | Mutability | Binding |
| --- | --- | --- |
| `current.json` | mutable pointer | active Freeze, Envelope, Review, Receipt, Resolution |
| `freeze.json` | immutable | Intent, scope, subject, review, optional Gate, Graph, Plan, actions, random code |
| `snapshots/*` | immutable | byte-identical subject, review, optional Gate copies |
| `envelope.json` | immutable | Freeze, subject SHA-256, action, reason, typed parameters |
| `review.html` | immutable | escaped human rendering and exact confirmation line |
| `receipts/*.json` | immutable | Freeze, Envelope, action, Harness, Session, Turn, observation time |
| `resolution.json` | immutable | Freeze, Envelope, Receipt, decision reference, outcome |

Raw prompts, transcripts, assistant responses, commands, patches, and Tool output are absent from
Receipt artifacts. The confirmation line and random confirmation code are also not copied into the
Receipt.

## Confirmation protocol

Core generates one line:

```text
/aidlc-confirm <freeze-id> <envelope-sha256> <confirmation-code>
```

Whitespace, token count, Freeze ID, Envelope digest, and confirmation code must match exactly.
An ordinary prompt is a no-op. An input beginning with `/aidlc-confirm` but failing validation is
blocked with the Codex `UserPromptSubmit` `decision: block` contract.

An unconsumed Receipt is idempotent only for the same Session and Turn. A different Session or Turn
cannot replace it. `human-gate apply` consumes the Receipt once; replay and stale Graph/Plan bindings
fail closed.

## Human actions

| Scope | Allowed actions | Parameter object |
| --- | --- | --- |
| ST-04 | `approve-architecture-policy`, `request-revision` | acknowledgements, or `{}` for revision |
| ST-05 | `approve-build-contract`, `request-revision` | acknowledgements, or `{}` for revision |
| ST-07 | `approve-runnable-candidate`, `request-changes` | acknowledgements, human checks, feedback items |
| ST-08 | `authorize-release`, `request-revision` | acknowledgements, or `{}` for revision |
| ST-09 | `continue-observation`, `complete-with-outcome`, `complete-and-draft-follow-up` | acknowledgements, not-before, deadline |
| RISK | `dismiss`, `resolve`, `set-severity` | decision ID, risk ID, optional severity, Evidence refs |

The Stage/Risk function receives an opaque Go `Proof`, not caller-supplied human reason or time.
Reason, parameters, and decision time are derived from the Envelope and Receipt.

## Stop behavior

The separate Codex `Stop` handler validates active Core State and Human Gate Current. A pending
Freeze emits:

```json
{"continue":false,"stopReason":"AI-DLC is awaiting explicit human action ..."}
```

No pending Freeze emits `{}`. Invalid pending state also emits `continue: false` with a generic
reason. This implements the current Codex contract and avoids relying on an assistant promise to
wait.

## Defense in depth

- Review sources and frozen snapshots must have the same SHA-256.
- Every ArtifactReference is Project-relative, hash-verified, and non-symlink.
- Current, Envelope, Receipt, Resolution, Intent, scope, action, Graph, and Plan bindings are checked.
- Human decision artifacts carry `human_input_receipt_ref`.
- Doctor validates Current and historical Receipt/Envelope/Freeze bindings.
- PreToolUse Guard denies direct Bash invocation of `hook receipt` and `hook freeze`.
- Legacy direct approval and risk-decision CLI routes fail with an instruction to use Human Gate.

## Trust boundary and limitations

Codex Hook delivery does not provide a cryptographically signed human identity. The Receipt proves
that the installed Codex Harness delivered the exact confirmation in a Session/Turn; it is not a
legal identity signature. A user or process with unrestricted filesystem/runtime access can still
attack the installed Harness. Distribution checksums, Hook trust review, protected runtime paths,
Core hashes, and Doctor checks reduce that risk but do not replace OS access control or signed
identity infrastructure.

Matching Hook handlers may run concurrently. Receipt, audit, and Stop handlers therefore share no
ordering assumption and serialize Core mutations through the Workspace lock.
