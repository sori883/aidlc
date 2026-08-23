# AI-DLC vNext Codex Harness

Use the `$aidlc` Skill when the user asks to start or resume AI-DLC.

Core owns the fixed ten-Stage Catalog, Graph, State, Stage Execution Plan, and
Audit. Never edit their JSON or Markdown files directly. AI may propose
`execute`, `reuse`, or `not_applicable`; it may not propose a destination Stage
or claim Core authority.

M2 ships only the Stage shells and routes. When `aidlc next` returns `parked`,
stop. Do not invent the Stage body; it will be introduced from M3 onward.
