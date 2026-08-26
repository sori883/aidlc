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
3. Before Birth, ask the human about known Intent-specific risks. If there are
   any, write the confirmed JSON array and run
   `./.codex/tools/aidlc intent birth . "<label>" --risk-file <risks.json>`.
   Otherwise run `./.codex/tools/aidlc intent birth . "<label>"`.
4. Run `./.codex/tools/aidlc next .`

Do not ask for a Scope, work type, lightweight/enterprise profile, or free-form
route. Those controls do not exist in vNext.

## Policy and Intent risks

Human-readable Org, Team, and Project Markdown Memory remains guidance. The
adjacent `org-policy.json`, `team-policy.json`, and `project-policy.json` files
are the only machine-executed additional Human Gate rules. Never infer an
executable rule from Markdown and never use Policy to remove a fixed Gate or
change the Stage Graph.

Show the current Register with
`./.codex/tools/aidlc intent risk show .`. When new Evidence reveals a
risk, submit a strict add-or-increase proposal with
`./.codex/tools/aidlc intent risk propose . <proposal.json>`.
AI may add a risk or increase its severity, but may not reduce, dismiss,
resolve, or reactivate one. Only after an actual human decision may Codex run
`./.codex/tools/aidlc intent risk decide . <human-decision.json>`.
Never edit Risk Current or immutable revisions directly.

At ST-04, ST-05, ST-07, ST-08, and a human-decided ST-09, read the Policy section in
the generated review HTML. For every listed `requirement_id`, create one
`{"requirement_id":"...","acknowledged":true,"reason":"..."}` entry in a
JSON array from the human's actual decision. Pass that file to the approval
command. An old Gate table is invalid after the Risk Register changes.

## Core Directive

Core can return:

- `advanced`: Core completed a deterministic Stage. Show the completed Stage,
  Evidence, and new current Stage. Then run `next` once more.
- `work`: Core fixed the current Stage and prepared a validated work-request
  Artifact. Delegate that request through the mandatory Stage Delegation flow
  below, then submit the delegated result through the named Core command. Never
  add a route or authority field.
- `approval`: Core validated an ST-05 Build Contract candidate, ST-07 Runnable
  Candidate, or ST-08 Release Plan and generated its human review. Show the review and
  exact SHA-256. Run an approval or feedback command only after an actual human
  explicitly decides; never infer approval or the feedback route.
- `decision`: Core validated a non-achieved ST-09 Outcome Evaluation. Show its
  HTML and exact SHA-256. Only an actual human may continue observation, accept
  the recorded Outcome, or accept it while drafting a Follow-up Brief.
- `parked`: show the Stage ID and reason, then stop. Never bypass a Core stop or
  invent work outside the fixed Stage Contract.
- `done`: show the reason and stop.

## Stage Delegation

The fixed assignment source is
`.codex/aidlc-common/data/vnext-stage-delegation.json`. Read and validate the
entry matching the Directive's `stage` before dispatch. For every `work`
Directive, the Conductor must delegate the Stage work and must not create or
edit the Stage proposal inline.

Resolve the exact assignment with
`./.codex/tools/aidlc delegation show <ST-00..ST-09> <work|review>`.
Treat a missing or `null` required assignment as a broken distribution and
stop without producing Stage output.

Use the matching Codex custom Agent from
`.codex/agents/<agent-name>.toml`. Pass the Directive, Work Request or review
Artifact, Stage Contract, assignment entry, exact input and output paths,
mutation scope, relevant policy and Evidence paths, and the persona path. Tell
every participant to use `$aidlc-stage-work`. Pass paths and boundaries rather
than copying large file bodies.

Execute the assignment topology as follows:

- `subagent`: dispatch the lead for a bounded draft. Dispatch supports with the
  draft and their exact contribution boundaries. Send support contributions
  back to the lead for integration.
- `pipeline`: dispatch the lead, then each support serially. Each participant
  receives the prior result and may advance only the assigned output.
- `mob`: dispatch the lead for a draft, then dispatch supports independently
  against the same draft. Supports remain mutually blind. Send all
  contributions back to the lead for integration.

If `reviewer_agent` is present, dispatch it after integration with read-only
scope. `READY` permits submission. On `NOT-READY`, send only the findings and
bounded paths back to the lead, then review again up to
`reviewer_max_iterations`. If the limit is reached, stop and ask the human;
the Conductor must not repair the artifact itself.

Only the Conductor runs the Core submission command documented in the current
Stage section. Subagents must never run `aidlc next`, submit, approve, decide,
execute, or write State, Plan, Audit, Current pointers, or canonical revisions.
Do not fall back to inline Stage work when an assigned Agent, required Skill,
or delegation capability is unavailable. Report the missing distributed
capability and stop without mutating Stage output.

For an `approval` or `decision` Directive whose Stage has a
`review_assignment`, dispatch that assignment read-only before presenting the
Core-generated review. The delegated analysis is advisory to the human
decision; it cannot change the reviewed hash, replace the Core review, or imply
approval. Show the original Core review and exact SHA-256 together with clearly
separated advisory findings, then wait for the human.

ST-00 Bootstrap is Core-owned and automatic. It validates the active Intent,
Plan, fixed Catalog and Graph, Effective Policy, Workspace, selected Repository
roots, and recording paths. AI must not claim that ST-00 passed or write its
Bootstrap Receipt itself.

ST-01 Orient is a two-part Stage. Core prepares `workspace-profile.json` and
`orient-work-request.json`; AI observes only the Design Brief scope and writes
an `orient-proposal` containing a System Map Patch and Current Context proposal.
Submit it with:

`./.codex/tools/aidlc orient complete . <proposal.json>`

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

`./.codex/tools/aidlc define-intent complete . <proposal.json>`

Core alone writes `intent-definition.json`, pins the Design Brief and Current
Context digests, records Audit and State, and advances through the fixed ST-02
to ST-03 edge. ST-02 cannot be `not_applicable`; a small change receives a
small Intent Definition instead of skipping the Stage.

ST-03 Requirements & Constraints is a two-part Stage. Core prepares
`artifacts/requirements/requirements-work-request.json` from the pinned Intent
Definition, Current Context, and Effective Policy. AI proposes only observable
functional and quality requirements, constraints, invariants, and open
questions. Every item needs a stable category ID and one or more source JSON
Pointers. Cover every source listed in `coverage_required` without expanding
the Intent scope. Do not add architecture, test procedures, Bolt planning,
implementation instructions, or routes. If an unresolved question is blocking,
ask the human before submitting. Submit the proposal with:

`./.codex/tools/aidlc requirements complete . <proposal.json>`

Core rejects unknown fields, broken pointers, duplicate IDs, missing coverage,
blocking questions, and stale Work Request hashes. Core alone writes the
immutable `revisions/<revision>/requirements.json`, updates `current.json`,
records Audit and State, and advances through the fixed ST-03 to ST-04 edge.
ST-03 cannot be `not_applicable`; a small change receives a short Requirements
Definition. JSON is canonical; do not generate HTML or Markdown unless a human
explicitly asks.

ST-04 Architecture Decision is a two-part Stage. Core prepares
`artifacts/architecture/architecture-work-request.json` from the pinned
Requirements revision, Current Context, System Map, and Effective Policy. AI
must assess every `requirement_id` exactly once and propose one disposition:

- `execute`: provide one or more Architecture Decision drafts. Each impacted
  requirement must be covered. Keep proposed topology in `planned_changes`;
  never edit or mix it into the current System Map.
- `reuse`: reference an existing canonical `architecture-decision` and a
  `human-decision` that approves reuse for the exact current Intent and
  Requirements. Do not copy the old decision into a new revision.
- `not_applicable`: every assessment must have `architecture_impact: false`,
  and Evidence must pin the exact Requirements and System Map references. This
  is a Core-verified no-impact result, not permission for AI to skip a Stage.

Do not add detailed API fields, Database schema, test procedures, Bolt plans,
implementation instructions, secrets, or routes. Ask the human before
submitting provider/cost choices, destructive or migration choices,
security/compliance exceptions, requirement conflicts, or hard-to-reverse
decisions. Submit the proposal with:

`./.codex/tools/aidlc architecture complete . <proposal.json>`

If Core reports that ST-04 Policy approval is required, do not alter the
proposal to bypass it. Generate the exact human review with:

`./.codex/tools/aidlc architecture policy-review . <proposal.json>`

Show the generated review HTML and Proposal SHA-256 to the human. After the
human supplies a reason and one acknowledgement for every listed requirement,
submit:

`./.codex/tools/aidlc architecture policy-approve . <proposal-sha256> "<human reason>" <policy-acknowledgements.json>`

Core binds this approval to the reviewed Proposal, Effective Policy, and
current Risk Register. A changed Risk Register makes the old review stale.

Core rejects incomplete requirement coverage, dangling current entity IDs,
invalid disposition bodies, stale references, unapproved reuse, and tampered
artifacts. For `execute`, Core writes an immutable Architecture Decision
revision. For all three dispositions, Core writes Intent-local `current.json`,
revises the Core-owned Plan, records Audit and State, and advances only through
the fixed ST-04 to ST-05 edge. JSON is canonical. HTML is generated only when a
human Policy decision is actually required.

ST-05 Build Contract has a proposal and approval boundary. Core prepares
`artifacts/build-contract/build-contract-work-request.json` from the pinned
Requirements, Architecture Current, Current Context, System Map, and Effective
Policy. AI assesses every requirement for build impact and proposes one of:

- `execute`: change contracts, acceptance criteria, verifier definitions, a
  dependency-based Bolt DAG, and an integration contract. A small change uses
  one short contract and one Bolt. Do not force frontend/backend or walking
  skeleton slices.
- `reuse`: an exact compatible, already approved canonical Build Contract.
- `not_applicable`: no implementation content, every assessment has
  `build_impact: false`, and Evidence pins Requirements and Architecture
  Current. This still needs final human confirmation.

Command verifiers use an argv array plus repository source and relative cwd.
Never execute a verifier in ST-05, place secrets in a proposal, assign batch
numbers, claim approval, or choose the next Bolt or Stage. Submit a proposal:

`./.codex/tools/aidlc build-contract review . <proposal.json>`

Core validates requirement traceability, repository boundaries, verifier
references, DAG cycles, cross-Bolt dependencies, and parallel target conflicts.
It derives execution batches and writes an escaped static
`review/build-contract-review.html`. When Core returns `approval`, show that
file and SHA-256. Only after the human explicitly approves, run:

`./.codex/tools/aidlc build-contract approve . <candidate-sha256> <reason> [policy-acknowledgements.json]`

Approval is bound to the exact candidate SHA-256. Core then writes the human
decision, immutable Build Contract revision for `execute` (or an exact reuse/no
work Current), Plan, Audit, and State, and advances only through ST-05 to ST-06.
The review HTML is a deliberate human-approval output; System Map remains
JSON-only by default.

ST-06 Build & Converge executes only the human-approved Build Contract. When
`aidlc next` returns an ST-06 `work` Directive, Core has selected exactly one
ready Bolt and written its canonical `artifacts/build/bolts/<bolt-id>/work-request.json`.
Read that request and edit only its listed targets, using the supplied
`source_workspaces[].worktree_path`. These are isolated Git worktrees; do not
edit the ordinary Repository working tree or choose another Bolt.

After implementing and locally checking the selected Bolt, submit the exact
Bolt to Core:

`./.codex/tools/aidlc build verify . <bolt-id>`

Core rejects changed paths outside the approved targets and runs only the
verifier argv/cwd or machine assertion shown in the approved ST-05 review. A
failed check creates an immutable attempt checkpoint and returns the same Bolt
for repair. Three identical failure signatures park the Stage. Do not bypass
that stop, alter checkpoints, or request another Bolt yourself.

On pass, Core commits and fast-forwards the Bolt into the Intent integration
worktree. It then either returns the next dependency-ready Bolt or, after all
Bolts and integration verifiers pass, creates `runnable-candidate.json`, writes
Build Current, and advances only through the fixed ST-06 to ST-07 edge.
`human-at-st07` checks remain explicitly deferred; ST-06 never claims human
approval. If Build Contract Current is `not_applicable`, Core deterministically
records no build work and advances without creating a Git worktree or Runnable
Candidate.

If an earlier canonical Runnable Candidate is available for the exact same
Intent, Build Contract, source revisions, changed-file set, and passed
Checkpoint Evidence, ask Core to validate reuse with:

`./.codex/tools/aidlc build reuse . <runnable-candidate.json> <reason>`

Never claim compatibility from a filename or description. Core must verify the
Artifact digest, Git revisions, diff, and Evidence references before it records
the ST-06 `reuse` disposition.

ST-07 Human Feedback & Approval snapshots the exact Runnable Candidate and
generates a short escaped `artifacts/review/review.html`. Show that Review HTML,
the Review Manifest SHA-256, the changed source revisions, every
`human-at-st07` check, and known constraints. Do not modify the Candidate while
it is awaiting a decision.

After an actual human approves every human check, run:

`./.codex/tools/aidlc review approve . <review-manifest-sha256> <reason> [human-checks.json] [policy-acknowledgements.json]`

If the human requests changes, record one or more feedback items with a known
requirement ID and at least one confirmed impact, then run:

`./.codex/tools/aidlc review feedback . <review-manifest-sha256> <feedback.json> <reason>`

The four allowed impacts are `requirements_changed`, `architecture_impact`,
`build_contract_impact`, and `candidate_defect`. AI may explain a classification
but must not confirm it for the human. Core deterministically selects the
earliest affected fixed Stage and invalidates that Stage through ST-07. A
`candidate_defect` starts a new isolated ST-06 cycle from the rejected Candidate;
older Candidate and Evidence snapshots remain immutable.

Approval is bound to the Candidate, Review Manifest, Requirements,
Architecture Current, Build Contract, Effective Policy, System Map, and Git
revisions. Core promotes the accepted source revisions to a new JSON-only
System Map revision and advances only to ST-08. ST-07 never releases, deploys,
or changes Production. When ST-06 is `not_applicable`, Core reuses the exact
ST-05 no-build human decision and advances without a duplicate review.

ST-08 Release is proposal, authority, and execution in that order. Core first
creates `artifacts/release/work-request.json` plus a pinned Capability Snapshot.
AI may propose only structured Targets and Steps using a listed `capability_id`;
never propose shell commands, credential values, an arbitrary provider adapter,
or a destination Stage. Submit the JSON proposal with:

`./.codex/tools/aidlc release review . <proposal.json>`

Core re-observes every Target, pins an immutable Release Plan, and generates
`artifacts/release/review/release.html`. Show that HTML to the human. Only the
exact Plan SHA-256 can be authorized:

`./.codex/tools/aidlc release authorize . <release-plan-sha256> <reason> [policy-acknowledgements.json]`

Authorization alone performs no external operation. After explicit human
instruction to execute, run:

`./.codex/tools/aidlc release execute .`

If a prior immutable Release Current may already satisfy the exact Candidate,
ask Core to validate Candidate revisions, Policy digest, Plan, Authority,
Receipt, Deployment Map, and the live external Target before reuse:

`./.codex/tools/aidlc release reuse . <release-current.json> <reason>`

Never infer reuse from a filename, version label, or old Receipt alone.

Core revalidates Target and Deployment Map state immediately before execution.
The initial installed capability promotes an Accepted Candidate Git revision to
an observed remote branch. Success records immutable Step Receipts, Release
Receipt, Release Current, and a JSON-only CodeKB Deployment Map. If a later
Source promotion fails, Core attempts the approved automatic rollback in reverse
order. A completed rollback is a recorded ST-08 outcome; a preflight mismatch or
ambiguous rollback stays blocked in ST-08 and requires a fresh authority. Core
advances only through the fixed ST-08 to ST-09 edge. If ST-07 has no Accepted
Candidate, ST-08 is deterministically `not_applicable`.

ST-09 Outcome Evaluation is terminal and mandatory. Core creates
`artifacts/outcome/work-request.json` by fixing every Intent expected outcome,
success signal, Requirement, and available approved acceptance criterion to a
stable signal ID. AI must assess every listed signal exactly once using only
Project-bound Evidence references; it must not add shell commands, routes,
authority, or a new Intent instruction. Submit the proposal with:

`./.codex/tools/aidlc outcome evaluate . <proposal.json>`

Core writes immutable Outcome Evidence and Evaluation JSON plus a derived,
escaped `artifacts/outcome/outcome.html`. If every signal is `achieved` and the
ST-09 Gate Requirement Set is empty, Core may write Outcome Current and complete
the Intent automatically. If Policy adds an ST-09 confirmation, even an
achieved result waits for the human. A
`rolled_back` Release can never be auto-achieved. For `partially_achieved`,
`not_achieved`, or `inconclusive`, show the HTML and exact Evaluation SHA-256,
then wait for the human. The three decisions are:

- `continue-observation`: remain in ST-09 with an explicit `not_before` and
  optional deadline; Core never sleeps in-process.
- `complete-with-outcome`: honestly close with the recorded result.
- `complete-and-draft-follow-up`: close and create only a Follow-up Brief draft.

Run the human's exact decision with:

`./.codex/tools/aidlc outcome decide . <evaluation-sha256> <decision> <reason> [policy-acknowledgements.json] [not-before] [deadline]`

The Follow-up Brief never creates or activates a new Intent. ST-09 has no
backward Graph edge and rejects `not_applicable`. After terminal completion,
`aidlc next` returns `done`.

## Stage Execution Plan proposals

AI may write a proposal JSON array and ask Core to evaluate it with:

`./.codex/tools/aidlc plan revise . <proposals.json>`

Each proposal contains only a Stage ID, `execute`/`reuse`/`not_applicable`, a
reason, evidence references, and proposer identity. `reuse` and
`not_applicable` require verifiable evidence and an implemented Stage Contract.
Unknown fields such as `next_stage`, `authority`, or transition instructions
are rejected.

Never edit `aidlc-state.json`, `stage-execution-plan.json`, Effective Policy
snapshots, Risk Register revisions, Gate Requirement Sets, `aidlc-state.md`, or
Audit logs directly.
