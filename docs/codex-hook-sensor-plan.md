# ST-HK-05 Codex Sensor Implementation Plan

## Approved scope

The user approved completing all remaining Hook stages as one batch. ST-HK-05
adds deterministic Sensors without giving Hooks workflow authority.

1. Implement a standard-library-only built-in Sensor catalog and immutable
   finding evidence.
2. Run advisory Go-format and JSON-validity Sensors after a successful Codex
   `apply_patch`.
3. Run a blocking Artifact-reference integrity Sensor before every Human Gate
   Review Freeze.
4. Deduplicate identical input bindings, but never deduplicate unavailable
   digests or a different expected digest.
5. Add CLI inspection and explicit-fire commands, Codex wiring, tests,
   documentation, distribution checks, and all Go quality gates.

ST-HK-05 does not add AI-authored Sensor definitions, external processes,
network calls, Human overrides, Stage routing, or Core State mutation.
