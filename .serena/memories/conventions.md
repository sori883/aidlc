# Conventions
- Fixed ST-00..ST-09 Stage Catalog; Core owns graph, state, execution plan, audit, routing, and authority boundaries.
- Never hand-edit Core-owned runtime JSON/Markdown artifacts.
- Codex Hook Journal is observed/non-authoritative; Core Audit is canonical.
- Hook payloads persist bounded metadata only, never raw prompts, responses, command bodies, tool output, or patch bodies.
- Tests use `testing.T.TempDir()`.
- Design, milestone, compliance, and operational documents belong under `docs/`.
- `work/` is human-owned and normally excluded from agent access.