---
name: aidlc-init
description: Create an AI-DLC Intent and run the complete Initialization phase.
---

<!-- generated-by: aidlc-runner-gen -->

# AI-DLC Initialization

Create one Intent. Initialization is atomic; its three bootstrap Stages are not
available as isolated Stage runners.

Run every command below from the repository root.

1. Ensure the workspace shell exists:

   `./.codex/tools/aidlc workspace init .`

2. Parse `$ARGUMENTS` as an optional `--scope <name>` and a free-form
   description. Scope defaults to `poc`.
3. Derive a concise two-to-four word label from the description. If no
   description exists, use the scope name.
4. Run:

   `./.codex/tools/aidlc intent birth . "<label>" --scope <scope>`

5. Print the result and stop. Continue later with `$aidlc`.
