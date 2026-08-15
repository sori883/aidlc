# AI-DLC Codex Harness

Use the `$aidlc` Skill when the user explicitly asks to start, resume, or run
AI-DLC. Use the matching generated Scope or Stage Skill only when the user
explicitly requests that narrower entry point.

Before the first AI-DLC command in a clone, run the following from the project
root when `.codex/node_modules/yaml` is absent:

```bash
bun install --cwd .codex --frozen-lockfile
```

Run every packaged AI-DLC command from the project root. The deterministic
engine owns routing, State, Audit, artifact paths, and approval transitions.
Never edit `aidlc-state.md` or Audit markdown directly, and never record a human
approval that did not occur.

When the runtime reports missing, malformed, or inconsistent AI-DLC state, run
`bun run --cwd .codex aidlc doctor check --project-dir ..` before proposing manual
edits. Use `doctor repair` only for findings marked `automatic`.
