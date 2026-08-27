# ST-HK-07 Hook Health and Doctor Plan

## Approved scope

The user approved completing all remaining Hook stages as one batch. ST-HK-07
adds operational diagnostics without turning Hook observation into workflow
authority.

1. Record metadata-only per-handler invocation, success, failure, and last
   outcome heartbeat counts.
2. Keep lifecycle delivery, handler invocation, Sensor path match, Sensor fire,
   Sensor terminal result, and Stage Agent Receipt as distinct evidence.
3. Validate every required installed Codex handler, matcher, timeout, context
   limit, and ancestor Project locator exactly once.
4. Extend `hook status` and `doctor check` with the separated health views.
5. Classify not-yet-observed runtime activity as warning/info and invalid
   persisted evidence or Hook wiring as error.
6. Add tests, operations documentation, distribution checks, and Go quality
   gates.

Doctor remains read-only. `doctor repair` continues to repair only the
non-authoritative State summary.
