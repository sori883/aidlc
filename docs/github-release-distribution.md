# GitHub Release / native CLI distribution

## Decision

AI-DLC v2 is developed, tested, and compiled with Bun. End users use Node.js
22 or newer only to run the public `install.mjs`. No npm package, namespace,
registry authentication, Git checkout, or archive is part of distribution.

The native executable is compiled from `core/tools/aidlc.ts` and its reachable
TypeScript execution dependencies. It embeds Bun and code dependencies. It does
not embed Core data or Codex Harness files.

The supported project layout is:

```text
<project>/
├── .aidlc/
│   ├── bin/aidlc[.exe]
│   ├── runtime/core/
│   └── installation.json
├── .agents/
├── .codex/
├── AGENTS.md
└── aidlc/
```

| Area | Contents | Transport |
| --- | --- | --- |
| Native CLI | Bun runtime, integrated TypeScript commands, code dependencies | one OS-specific GitHub Release Asset |
| Core Runtime | Stages, Scopes, Rules, Sensors, contracts, shared knowledge | individual files from tagged `dist/project/` |
| Codex Harness | `AGENTS.md`, Skills, Hooks, Codex Agent configuration | individual files from tagged `dist/project/` |
| Workspace | Intents, state, memory, logs, generated artifacts | user/project-owned; never distributed |

The Core and Harness tree is generated and committed like upstream
`dist/<harness>/` output. Release tags make every raw file URL version-stable.

## Installer contract

```text
node install.mjs <install|update> [--project <dir>] [--harness codex]
  [--dry-run] [--json]
```

The Installer downloads `aidlc-distribution.json`, selects one binary using OS,
CPU, and Linux libc, downloads every external project file separately, verifies
the declared byte length and SHA-256, and smoke-runs the binary with `--version`.
It performs no project write until every download and preflight check succeeds.

Test-only origin overrides are `AIDLC_RELEASE_ROOT` and
`AIDLC_RAW_PROJECT_ROOT`. Production users do not set them.

## Runtime contract

After installation, all commands use the native executable directly:

```text
./.aidlc/bin/aidlc workspace init .
./.aidlc/bin/aidlc intent birth . "First Intent" --scope poc
./.aidlc/bin/aidlc orchestrate next --project-dir .
```

Generated Hooks and Skills do not invoke Bun, Node.js, npm, npx, or Git root
discovery. No executable `.ts` file is present in `dist/project/`.

## Update safety

`update` replaces only files still identical to the hashes recorded by the
previous installation. A changed managed file is a conflict and stops the
entire update. Workspace data under `aidlc/` is never managed or removed.

Network errors, invalid manifests, unsupported platforms, byte-length drift,
SHA-256 mismatch, failed native smoke tests, unsafe paths, symlink ancestors,
and user-file conflicts all fail before project mutation.
