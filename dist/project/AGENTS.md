# AI-DLC Codex Harness

Use the `$aidlc` Skill when the user explicitly asks to start, resume, or run
AI-DLC. Use the matching generated Scope or Stage Skill only when the user
explicitly requests that narrower entry point.

The project-local native AI-DLC executable contains every code dependency; do not run a package installer.

Run every packaged AI-DLC command from the project root. The deterministic
engine owns routing, State, Audit, artifact paths, and approval transitions.
Never edit `aidlc-state.md` or Audit markdown directly, and never record a human
approval that did not occur.

When the runtime reports missing, malformed, or inconsistent AI-DLC state, run
`./.codex/tools/aidlc doctor check --project-dir .` before proposing manual
edits. Use `doctor repair` only for findings marked `automatic`.
