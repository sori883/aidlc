# Project core
- AI-DLC vNext Go implementation for the Codex harness, with a fixed ten-stage lifecycle and Core-owned authority boundaries.
- Source map: CLI in `cmd/aidlc` and `internal/cli`; stage runtime in `internal/stage`; workflow state/policy in `internal/workflow` and audit in `internal/audit`; Codex adapters in `internal/hook*`; bundling/install/distribution in `internal/bundle`, `internal/installer`, and `internal/distribution`.
- Repository may have user-owned dirty changes; preserve unrelated edits.
- Toolchain and dependency policy: `mem:tech_stack`.
- Repository-specific code/artifact conventions: `mem:conventions`.
- Common developer commands: `mem:suggested_commands`.
- Required completion gates: `mem:task_completion`.
