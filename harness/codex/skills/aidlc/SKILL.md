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

Core can return:

- `advanced`: Core completed a deterministic Stage. Show the completed Stage,
  Evidence, and new current Stage. Then run `next` once more.
- `work`: Core fixed the current Stage and prepared a validated work-request
  Artifact. Read that request, produce only its requested proposal, and submit
  it through the named Core command. Never add a route or authority field.
- `parked`: show the Stage ID and reason, then stop. A missing Stage Contract is
  expected for Stages that are not implemented yet; never invent their work.
- `done`: show the reason and stop.

ST-00 Bootstrap is Core-owned and automatic. It validates the active Intent,
Plan, fixed Catalog and Graph, Effective Policy, Workspace, selected Repository
roots, and recording paths. AI must not claim that ST-00 passed or write its
Bootstrap Receipt itself.

ST-01 Orient is a two-part Stage. Core prepares `workspace-profile.json` and
`orient-work-request.json`; AI observes only the Design Brief scope and writes
an `orient-proposal` containing a System Map Patch and Current Context proposal.
Submit it with:

`bun run --cwd .codex aidlc orient complete . <proposal.json>`

Core strictly validates source snapshots, Evidence paths and SHA-256 digests,
IDs and references, accepted-baseline perspective, and `base_revision`. Core
alone writes the immutable shared JSON System Map revision, `baseline.json`,
the Intent-local `current-context.json`, Audit, State, and the fixed ST-01 to
ST-02 route. Do not generate System Map HTML unless a human explicitly asks.

ST-02 Define Intent is also a two-part Stage. Core prepares
`define-intent-work-request.json`. AI then proposes only the Intent purpose,
expected outcomes, in-scope work, exclusions, success signals, and known
unknowns. If a value judgment, priority choice, or ambiguous goal cannot be
resolved from the human request, ask the human before submitting the proposal.
Do not add detailed requirements, architecture, Bolt planning, implementation,
or route instructions. Submit the proposal with:

`bun run --cwd .codex aidlc define-intent complete . <proposal.json>`

Core alone writes `intent-definition.json`, pins the Design Brief and Current
Context digests, records Audit and State, and advances through the fixed ST-02
to ST-03 edge. ST-02 cannot be `not_applicable`; a small change receives a
small Intent Definition instead of skipping the Stage.

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
