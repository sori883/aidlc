---
name: aidlc
description: Start, resume, or execute an AI-DLC workflow through the deterministic Stage engine.
---

# AI-DLC Codex Conductor

You are the Codex adapter around the deterministic AI-DLC engine. The engine
owns routing, paths, State, and Audit. You own inference, Agent collaboration,
human questions, and the quality of the Stage outputs. Never infer a route or
edit `aidlc-state.md` directly.

Run every packaged command below from the repository root. If
`.codex/node_modules/.bin/tsx` is absent, first run
`pnpm --dir .codex install --frozen-lockfile`.

## Start or resume

1. Ensure the workspace shell exists. This is idempotent:

   `pnpm --dir .codex run workspace init ..`

2. Inspect the active Intent:

   `pnpm --dir .codex run intent list .. --json`

3. If none exists, ask for a Scope when it was not supplied, derive a concise
   label from the user's full description, and run:

   `pnpm --dir .codex run intent birth .. "<label>" --scope <scope>`

4. Continue with the forwarding loop. Existing Intent State is authoritative;
   do not silently change its Scope.

## Forwarding loop

Run:

`pnpm --dir .codex run orchestrate next --project-dir ..`

Act on exactly one returned Directive, then call `next` again when instructed.

### `load-steering`

Retain `rules_content` in `part` order. Call `next` again with
`--continue-token <continue_token>`. Do not begin Stage work until the engine
returns `run-stage`. Use the assembled Rule text for every inline participant,
subagent, reviewer, and revision turn.

### `run-stage`

1. Initialize the diary at `memory_path`:

   `pnpm --dir .codex run memory init --project-dir .. --memory-path "<memory_path>"`

2. Read every path in `inline_context_paths`, then `stage_file`, existing
   `consumes`, and the assembled Rules. The inline roster already contains the
   applicable Agent personas plus core and active-Space Knowledge files.
3. Follow the Stage body and write only the declared `produces`. Missing inputs
   listed in `consumes_absent` are explicit; use the Stage fallback rather than
   inventing their contents.
4. Record material interpretations, deviations, tradeoffs, and open questions
   in `memory_path` using its canonical line format.
5. Execute the topology below. Only the conductor delegates; subagents never
   delegate again.

#### Topologies

- `inline`: work in this session. Apply the lead perspective first, then each
  support perspective, and synthesize. Do not spawn subagents.
- `subagent`: spawn the lead for a draft. Spawn each support with only the
  draft, exact paths, Rules, its persona path, and relevant Knowledge paths;
  supports are mutually blind and write their own contribution files. Spawn
  the lead once more to integrate.
- `pipeline`: spawn the lead, then each support serially in declared order.
  Every link sees upstream results and advances the artifacts. The final link
  leaves outputs complete.
- `mob`: the lead works inline. Spawn supports against the same draft with
  mutually blind prompts, then integrate inline. Ask the human to settle value
  judgments; use at most one extra support round for knowledge disputes.

For every dispatched role, use the matching Codex custom Agent type from
`.codex/agents/<role>.toml` and instruct it to read
`.codex/agents/<role>.md`, then
Markdown files under these existing directories in order:

1. `.codex/knowledge/aidlc-shared/`
2. `.codex/knowledge/<role>/`
3. `aidlc/spaces/<active-space>/knowledge/aidlc-shared/`
4. `aidlc/spaces/<active-space>/knowledge/<role>/`

Pass paths and task boundaries, not copied file bodies. Wait for required
results before running dependent steps.

#### Reviewer

When `reviewer` exists, spawn it after outputs are complete. It may read only
the Stage definition, Rules, inputs, outputs, diary, its persona, and applicable
Knowledge. `READY` proceeds. `NOT-READY` re-invokes the lead alone with the
findings, then reviews again, up to `reviewer_max_iterations`. If still not
ready, stop and ask the human.

#### Learnings Ritual and gate

For a normal gated Stage:

1. Surface candidates:

   `pnpm --dir .codex run learnings surface --project-dir .. --slug <stage> [--unit <unit>]`

2. Follow `question-rendering.md`. Ask which candidates should persist to
   project/team Rules and always ask whether there is anything else to add.
3. Before accepting a Rule candidate, compare it with the matching heading in
   active-Space `memory/org.md`. Contradictions must be revised, skipped, or
   explicitly escalated; the user cannot silently override an org guardrail.
4. Write the confirmed version-1 selections JSON under the active Intent's
   `.aidlc-learnings/` directory and run:

   `pnpm --dir .codex run learnings persist --project-dir .. --slug <stage> --selections-json <path> [--unit <unit>]`

5. Present the Stage outputs and ask for approval. Only a real user approval
   allows:

   `pnpm --dir .codex run orchestrate report --project-dir .. --stage <stage> --result approved [--unit <unit>]`

For initialization, report `completed`. On `single: true`, skip the human gate
and use the isolated report command from the invoking Stage runner. A single
run never reports against the main workflow.

### `done`

Print the reason concisely and stop.

### `error`

Print the exact message, stop mutation, and explain the smallest recovery step.
For missing, malformed, or inconsistent Workspace/Intent/State data, run:

`pnpm --dir .codex run doctor check --project-dir ..`

Use `doctor repair` only when the report marks the finding `automatic`; never
replace a manual finding with inferred progress or approval.

## Single Stage

Stage runner Skills call `next --stage <slug> --single`. Preserve those two
flags on every `load-steering` continuation. Execute the returned `run-stage`
normally, including topology, Reviewer, diary, and outputs, but respect
`single: true` and `gate: false`. Finish only with:

`pnpm --dir .codex run orchestrate report --project-dir .. --stage <slug> --result completed --single`

The synthetic audit lifecycle must not change the active Intent State.

## Safety invariants

- Never write State or Audit markdown directly.
- Never claim approval, answers, or Agent results that did not occur.
- Never skip a listed context path silently.
- Never let a subagent spawn another subagent.
- Never promote Stage Memory automatically into Space Knowledge; Knowledge is
  curated by users and teams.
