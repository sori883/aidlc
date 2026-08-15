---
name: aidlc-bugfix
description: Run AI-DLC with the bugfix Scope fixed. Fix a specific bug.
---

<!-- generated-by: aidlc-runner-gen -->

# AI-DLC Scope Runner: bugfix

Read `../aidlc/SKILL.md` and follow the same engine loop with scope
`bugfix` fixed.

Run every command below from the repository root.

1. Ensure the workspace shell exists:
   `./.codex/tools/aidlc workspace init .`.
2. Inspect the active Intent with
   `./.codex/tools/aidlc intent list . --json`.
3. If no Intent exists, derive a concise label from `$ARGUMENTS` and birth it:
   `./.codex/tools/aidlc intent birth . "<label>" --scope bugfix`.
4. If an active Intent exists, read its Scope with
   `./.codex/tools/aidlc state resume .`. If it differs from
   `bugfix`, stop and explain that Scope is fixed at Intent Birth;
   never rewrite its plan implicitly.
5. Run the `$aidlc` forwarding loop until the engine returns `done`.
