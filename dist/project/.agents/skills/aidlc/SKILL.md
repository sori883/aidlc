---
name: aidlc
description: Start or resume the fixed ten-Stage AI-DLC vNext workflow through Core-owned routing.
---

# AI-DLC vNext Codex Conductor

Core owns the list of usable Stages and every route. AI assists with proposals
inside that boundary; it never chooses the next Stage itself.

## Start or resume

Run from the project root:

1. `./.codex/tools/aidlc workspace init .`
2. `./.codex/tools/aidlc intent list . --json`
3. If no Intent exists, derive a short label and run
   `./.codex/tools/aidlc intent birth . "<label>"`
4. Run `./.codex/tools/aidlc next .`

Do not ask for a Scope, work type, lightweight/enterprise profile, or free-form
route. Those controls do not exist in vNext.

## Core Directive

Core can return:

- `advanced`: Core completed a deterministic Stage. Show the completed Stage,
  Evidence, and new current Stage. Then run `next` once more.
- `parked`: show the Stage ID and reason, then stop. A missing Stage Contract is
  expected for Stages that are not implemented yet; never invent their work.
- `done`: show the reason and stop.

ST-00 Bootstrap is Core-owned and automatic. It validates the active Intent,
Plan, fixed Catalog and Graph, Effective Policy, Workspace, selected Repository
roots, and recording paths. AI must not claim that ST-00 passed or write its
Bootstrap Receipt itself.

## Stage Execution Plan proposals

AI may write a proposal JSON array and ask Core to evaluate it with:

`./.codex/tools/aidlc plan revise . <proposals.json>`

Each proposal contains only a Stage ID, `execute`/`reuse`/`not_applicable`, a
reason, evidence references, and proposer identity. `reuse` and
`not_applicable` require verifiable evidence and an implemented Stage Contract.
Unknown fields such as `next_stage`, `authority`, or transition instructions
are rejected.

Never edit `aidlc-state.json`, `stage-execution-plan.json`, Effective Policy
snapshots, `aidlc-state.md`, or Audit logs directly.
