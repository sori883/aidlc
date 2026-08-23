---
name: aidlc
description: Start or resume the fixed ten-Stage AI-DLC vNext workflow through Core-owned routing.
---

# AI-DLC vNext Codex Conductor

Core owns the list of usable Stages and every route. AI assists with proposals
inside that boundary; it never chooses the next Stage itself.

## Start or resume

Run from the project root:

1. `bun run --cwd .codex aidlc workspace init .`
2. `bun run --cwd .codex aidlc intent list . --json`
3. If no Intent exists, derive a short label and run
   `bun run --cwd .codex aidlc intent birth . "<label>"`
4. Run `bun run --cwd .codex aidlc next .`

Do not ask for a Scope, work type, lightweight/enterprise profile, or free-form
route. Those controls do not exist in vNext.

## Core Directive

M2 can return:

- `parked`: show the Stage ID and reason, then stop. A missing Stage Contract is
  expected until M3; never invent the Stage's work.
- `done`: show the reason and stop.

## Stage Execution Plan proposals

AI may write a proposal JSON array and ask Core to evaluate it with:

`bun run --cwd .codex aidlc plan revise . <proposals.json>`

Each proposal contains only a Stage ID, `execute`/`reuse`/`not_applicable`, a
reason, evidence references, and proposer identity. `reuse` and
`not_applicable` require verifiable evidence and an implemented Stage Contract.
Unknown fields such as `next_stage`, `authority`, or transition instructions
are rejected.

Never edit `aidlc-state.json`, `stage-execution-plan.json`, Effective Policy
snapshots, `aidlc-state.md`, or Audit logs directly.
