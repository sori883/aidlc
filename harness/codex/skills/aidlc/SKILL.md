---
name: aidlc
description: Start, resume, or execute an AI-DLC workflow through the deterministic Stage engine.
---

# AI-DLC Codex Conductor

You are the Codex adapter around the deterministic AI-DLC engine. The engine
owns routing, paths, State, and Audit. You own inference, Agent collaboration,
human questions, and the quality of the Stage outputs. Never infer a route or
edit `aidlc-state.md` directly.

All stages follow `.codex/aidlc-common/protocols/stage-protocol.md` for
approval gates, question format, state tracking, and completion messages.
Read that protocol and this Skill's `lifecycle-rendering.md` Codex annex before
acting on every `run-stage` directive. Codex UI operations only mirror Core
State and Audit transitions.

Run every packaged command below from the repository root. If
`.codex/node_modules/yaml` is absent, first run
`bun install --cwd .codex --frozen-lockfile`.

## Start or resume

1. Ensure the workspace shell exists. This is idempotent:

   `bun run --cwd .codex aidlc workspace init ..`

2. Inspect the active Intent:

   `bun run --cwd .codex aidlc intent list .. --json`

3. If none exists, ask for a Scope when it was not supplied, derive a concise
   label from the user's full description, and run:

   `bun run --cwd .codex aidlc intent birth .. "<label>" --scope <scope>`

4. Continue with the forwarding loop. Existing Intent State is authoritative;
   do not silently change its Scope.

## Forwarding loop

Run:

`bun run --cwd .codex aidlc orchestrate next --project-dir ..`

Act on exactly one returned Directive, then call `next` again when instructed.

### Construction Bolt forwarding

When `print.message` starts with `BOLT_ACTION`, treat it as a Core-owned
automatic boundary, not as a human decision. Run only the named transition,
then call `orchestrate next` again:

- `BOLT_ACTION initialize`:
  `bun run --cwd .codex aidlc bolt init --project-dir ..`
- `BOLT_ACTION start B1` (or a comma-separated ready batch): obtain each Bolt
  slug and the approved `plan.worktree` values from `aidlc bolt show`. For each
  ID, create and verify its
  Worktree first:
  `bun run --cwd .codex aidlc worktree create --project-dir .. --slug <slug> --base <base>`
  followed by
  `bun run --cwd .codex aidlc worktree verify --project-dir .. --slug <slug> --event WORKTREE_CREATED`.
  Then forward the returned absolute `worktree_path` and branch as:
  `bun run --cwd .codex aidlc bolt start --project-dir .. --bolt <id> --worktree <worktree_path> --ref <branch>`.
  B1 is always the first and only ID in its initial batch. If the approved Way
  of Working has `enabled: false`, omit only the create/verify and
  `--worktree`/`--ref` parts; do not infer that exception from a Git error.
- `BOLT_ACTION integrate <id> <slug>`: use the approved target branch and merge
  strategy from `plan.worktree`, run
  `bun run --cwd .codex aidlc worktree merge --project-dir .. --slug <slug> --target <target> --strategy <squash|merge|rebase>`, then verify
  `WORKTREE_MERGED`. Forward its `commit_sha` with
  `bun run --cwd .codex aidlc bolt record-integration --project-dir .. --bolt <id> --ref <commit_sha>`.
  A conflict is a Bolt failure: preserve the Worktree, record `bolt fail` with
  the exact conflict summary, and ask for retry, skip, or abort.
- `BOLT_ACTION complete <id>`:
  `bun run --cwd .codex aidlc bolt complete --project-dir .. --bolt <id>`

Do not infer an ID. If a boundary message and `aidlc bolt show` disagree, stop
with the exact inconsistency instead of editing State.

For a Bolt-owned `run-stage`, State has a non-`none` Current Bolt and the
Directive has `gate: false`. Execute the Stage for the exact `unit`, but do not
open a Stage-level human gate. After its outputs and applicable Sensor checks
are complete, report:

`bun run --cwd .codex aidlc orchestrate report --project-dir .. --stage <stage> --unit <unit> --result completed`

The Core records the per-Bolt Stage/Unit cell and opens the Bolt gate only after
all applicable Stages 3.1 through 3.5 are settled. If Stage execution,
review, or required validation fails and cannot be corrected in the same turn,
record the failure once:

During `code-generation`, make application-code changes in the absolute
Worktree Path recorded for the Current Bolt. Keep declared AI-DLC record
artifacts at their engine-resolved paths. Never place generated application
code under the Intent record directory.

`bun run --cwd .codex aidlc bolt fail --project-dir .. --bolt <id> --reason "<exact summary>"`

For `present-gate` whose `stage` is `bolt:<id>`, show the Bolt outputs and ask
for a real approval. Forward the exact response with one of:

- approve:
  `bun run --cwd .codex aidlc bolt approve-gate --project-dir .. --bolt <id> --user-input "<exact response>"`
- reject:
  `bun run --cwd .codex aidlc bolt reject-gate --project-dir .. --bolt <id> --user-input "<exact response>"`

When `ask` requests the Construction autonomy ladder, ask exactly once and
forward the selected mode:

`bun run --cwd .codex aidlc bolt set-autonomy --project-dir .. --mode <autonomous|gated>`

When `ask` reports a failed Bolt, present `retry`, `skip`, and `abort`. Never
choose on the user's behalf. Forward the exact choice as follows:

- retry: `bun run --cwd .codex aidlc bolt retry --project-dir .. --bolt <id>`
- skip: `bun run --cwd .codex aidlc bolt skip --project-dir .. --bolt <id> --reason "<reason>" --user-input "<exact response>"`
- abort: `bun run --cwd .codex aidlc bolt abort --project-dir .. --bolt <id> --reason "<reason>" --user-input "<exact response>"`

After every forwarded transition, call `orchestrate next`; do not synthesize a
Bolt completion, gate approval, autonomy answer, or failure recovery.

### `load-steering`

Retain `rules_content` in `part` order. Call `next` again with
`--continue-token <continue_token>`. Do not begin Stage work until the engine
returns `run-stage`. Use the assembled Rule text for every inline participant,
subagent, reviewer, and revision turn.

### `run-stage`

1. Initialize the diary at `memory_path`:

   `bun run --cwd .codex aidlc memory init --project-dir .. --memory-path "<memory_path>"`

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

For a normal gated Stage (`gate` is not `false` and it is not a `bolt:<id>`
gate):

1. Surface candidates:

   `bun run --cwd .codex aidlc learnings surface --project-dir .. --slug <stage> [--unit <unit>]`

2. Follow `question-rendering.md`. Ask which candidates should persist to
   project/team Rules and always ask whether there is anything else to add.
3. Before accepting a Rule candidate, compare it with the matching heading in
   active-Space `memory/org.md`. Contradictions must be revised, skipped, or
   explicitly escalated; the user cannot silently override an org guardrail.
4. Write the confirmed version-1 selections JSON under the active Intent's
   `.aidlc-learnings/` directory and run:

   `bun run --cwd .codex aidlc learnings persist --project-dir .. --slug <stage> --selections-json <path> [--unit <unit>]`

5. Present the Stage outputs and ask for approval. Only a real user approval
   allows:

   `bun run --cwd .codex aidlc orchestrate report --project-dir .. --stage <stage> --result approved [--unit <unit>]`

For initialization, report `completed`. On `single: true`, skip the human gate
and use the isolated report command from the invoking Stage runner. A single
run never reports against the main workflow.

### `done`

Print the reason concisely and stop.

### `print`

Handle `BOLT_ACTION` as specified above. Otherwise print `message` exactly and
continue only when the message instructs it.

### `present-gate` and `ask`

Handle Bolt gates, the autonomy ladder, and failure choices as specified in
Construction Bolt forwarding. For other stages, use `question-rendering.md`
and never infer the user's answer.

### `error`

Print the exact message, stop mutation, and explain the smallest recovery step.
For missing, malformed, or inconsistent Workspace/Intent/State data, run:

`bun run --cwd .codex aidlc doctor check --project-dir .. --full`

Use `doctor repair` only when the report marks the finding `automatic`; never
replace a manual finding with inferred progress or approval.

## Single Stage

Stage runner Skills call `next --stage <slug> --single`. Preserve those two
flags on every `load-steering` continuation. Execute the returned `run-stage`
normally, including topology, Reviewer, diary, and outputs, but respect
`single: true` and `gate: false`. Finish only with:

`bun run --cwd .codex aidlc orchestrate report --project-dir .. --stage <slug> --result completed --single`

The synthetic audit lifecycle must not change the active Intent State.

## Safety invariants

- Never write State or Audit markdown directly.
- Never claim approval, answers, or Agent results that did not occur.
- Never skip a listed context path silently.
- Never let a subagent spawn another subagent.
- Never promote Stage Memory automatically into Space Knowledge; Knowledge is
  curated by users and teams.
