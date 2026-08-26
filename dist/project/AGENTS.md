# AI-DLC vNext Codex Harness

Use the `$aidlc` Skill when the user asks to start or resume AI-DLC.

Core owns the fixed ten-Stage Catalog, Graph, State, Stage Execution Plan, and
Audit. Never edit their JSON or Markdown files directly. AI may propose
`execute`, `reuse`, or `not_applicable`; it may not propose a destination Stage
or claim Core authority.

ST-00 through terminal ST-09 have implemented Stage Contracts. When `aidlc next`
returns `parked`, show the Core-owned reason and stop. Do not invent work beyond
the returned Directive.

## Stage Delegation

For every Core `work` Directive, the Conductor must delegate through the fixed
`.codex/aidlc-common/data/vnext-stage-delegation.json` assignment and the
matching Codex custom Agent. It must not replace a missing Agent with inline
work. Delegated agents are leaf participants, use `$aidlc-stage-work`, and may
mutate only their assigned proposal path or ST-06 worktree. Core owns routing,
State, Audit, acceptance, and every human or release authority boundary.
