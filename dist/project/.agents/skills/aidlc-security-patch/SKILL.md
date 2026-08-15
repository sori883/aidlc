---
name: aidlc-security-patch
description: Run AI-DLC with the security-patch Scope fixed. CVE response.
---

<!-- generated-by: aidlc-runner-gen -->

# AI-DLC Scope Runner: security-patch

Read `../aidlc/SKILL.md` and follow the same engine loop with scope
`security-patch` fixed.

Run every command below from the repository root.

1. Ensure the workspace shell exists:
   `./.aidlc/bin/aidlc workspace init .`.
2. Inspect the active Intent with
   `./.aidlc/bin/aidlc intent list . --json`.
3. If no Intent exists, derive a concise label from `$ARGUMENTS` and birth it:
   `./.aidlc/bin/aidlc intent birth . "<label>" --scope security-patch`.
4. If an active Intent exists, read its Scope with
   `./.aidlc/bin/aidlc state resume .`. If it differs from
   `security-patch`, stop and explain that Scope is fixed at Intent Birth;
   never rewrite its plan implicitly.
5. Run the `$aidlc` forwarding loop until the engine returns `done`.
