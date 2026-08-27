---
name: aidlc-stage-work
description: Perform an exact delegated AI-DLC vNext Stage assignment from the Conductor; use only for bounded Stage work or review, never for routing the workflow.
---

# AI-DLC vNext Stage Worker

Use this Skill only after the AI-DLC Conductor delegates an exact Stage assignment.
Core owns Stage selection, transitions, State, Audit, acceptance, and approval authority.

## Read the assignment

Before working, read the exact paths supplied by the Conductor in this order:

1. the Core Directive and Work Request or review Artifact;
2. `.codex/aidlc-common/data/vnext-stage-delegation.json` and the current Stage entry;
3. the current Stage Contract under `.codex/aidlc-common/stages/`;
4. your persona at `.codex/agents/<agent-name>.md`;
5. only the policy, memory, source, and Evidence paths explicitly passed to you.

Stop and report the mismatch if the Stage, role, assignment kind, hashes, or paths do not agree. Do not repair or reinterpret the assignment.

## Skill routing

Always follow this Skill. Also use another available Skill when the assignment explicitly names it or when its description clearly matches the requested artifact or verification work. This is the `task-matched` policy. Do not install a missing Skill or plugin, silently substitute an unrelated Skill, or broaden the Stage to make a Skill applicable. Report a missing required capability to the Conductor.

## Mutation scope

- `proposal-only`: write only the exact proposal or contribution path assigned by the Conductor. Do not change product source, canonical artifacts, State, Plan, Audit, or Current pointers.
- `assigned-worktree`: change only the supplied Git worktree and the selected Bolt target paths. Run only the approved or repository-standard checks needed for that Bolt.
- `read-only`: do not modify files, execute mutating commands, submit decisions, or approve anything. Return evidence-backed findings to the Conductor.

Never run `aidlc next`, any `complete`, `approve`, `decide`, `execute`, State, Plan, or Audit command. The Conductor submits completed work to Core.

## Participation

- Lead: create the bounded draft or implementation and integrate only the contribution files or findings the Conductor passes back.
- Support: inspect only the supplied draft and context, then return an independent contribution. Do not edit the lead's canonical proposal unless the Conductor explicitly assigns an isolated contribution path.
- Reviewer: begin with `**Reviewer:** <agent-name>`, then return `READY` or `NOT-READY`. Every blocking finding must cite a passed path, ID, contract rule, command result, or Evidence reference.

You operate as a leaf participant and must not spawn or delegate to another agent. Ask the Conductor to coordinate any additional perspective.

## Return contract

Return concise findings for the Conductor, then end with exactly one single-line
marker. Do not put the marker in a code fence and do not emit a second marker.

```text
AIDLC_STAGE_RESULT: {"schema_version":1,"agent_name":"aidlc-...-agent","stage_id":"ST-00","assignment_kind":"work","role":"lead","status":"completed","mutation_scope":"proposal-only","outputs":[],"reviewed_paths":[],"checks":[],"skills":["aidlc-stage-work"],"unresolved_questions":[]}
```

Use the exact active Stage, assignment kind, role, and mutation scope supplied
by the Conductor and fixed catalog. Work status is `completed` or `blocked`.
Review assignment and `reviewer` role status is `ready`, `not-ready`, or
`blocked`; a `reviewer` role is always `read-only`. A blocked result must have
at least one unresolved question; every other result must list a performed
check.

For each changed file, `outputs` contains its Project-relative portable `path`,
`status` (`added`, `modified`, `renamed`, or `deleted`), and current canonical
`sha256`. A deleted ST-06 output uses `"sha256":null`. A read-only result has no
outputs and instead lists every reviewed Project-relative path and SHA-256 in
`reviewed_paths`. Always emit all five arrays, including empty arrays.

The SubagentStop Hook validates this marker and may ask once for a corrected
one. A validated Receipt means only that the return contract and file bindings
matched; it does not mean Core accepted the work. Do not address the human as
though you were the Conductor and do not claim Core acceptance.
