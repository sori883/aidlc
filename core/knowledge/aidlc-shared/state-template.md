# AI-DLC vNext State

Core writes `aidlc-state.json` and `stage-execution-plan.json` as the
authoritative machine records. `aidlc-state.md` is only a human-readable mirror.

The State always names one of the fixed Stages `ST-00` through `ST-09`. The
Stage Execution Plan records `execute`, `reuse`, or `not_applicable` for every
Stage. AI may propose a decision; only Core may persist it or choose a route.

There is no Scope, work type, profile, or free-form next-Stage field.
