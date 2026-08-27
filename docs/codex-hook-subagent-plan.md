# ST-HK-06 SubagentStop Control Plan

## Approved scope

The user approved completing all remaining Hook stages as one batch. ST-HK-06
validates the bounded return from an assigned AI-DLC Stage Agent.

1. Require one strict, single-line `AIDLC_STAGE_RESULT` JSON marker.
2. Bind Agent type, active Stage, assignment kind, role, required Skill,
   effective mutation scope, output paths, reviewed paths, and SHA-256 values.
3. Persist an immutable result Receipt without claiming Core acceptance.
4. Continue only the subagent once for a correctable invalid marker.
5. Release to the Conductor after the second stop or when Codex reports
   `stop_hook_active`, preventing a continuation loop.
6. Wire the handler only to `aidlc-*-agent` types, protect direct invocation,
   and add tests, documentation, distribution checks, and Go quality gates.

The Hook does not read or persist the agent transcript, accept work into Core,
transition State, make a Human decision, or extend an assignment.
