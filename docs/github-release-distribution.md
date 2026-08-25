# GitHub Release / native CLI distribution

AI-DLC vNext is developed, tested, and compiled with Bun. End users need Node.js 22 or newer only for `install.mjs`; the installed workflow runs through one project-local native CLI.

## Installed layout

```text
<project>/
├── .agents/skills/aidlc/
├── .codex/
│   ├── aidlc-common/
│   ├── memory/
│   ├── tools/aidlc[.exe]
│   ├── hooks.json
│   └── aidlc-installation.json
├── AGENTS.md
└── aidlc/                  user-owned Workspace and artifacts
```

The executable embeds the Bun runtime and reachable TypeScript code. Fixed Stage data, Memory defaults, and Codex instructions remain normal hashed files. No executable TypeScript is shipped in `dist/project/`.

## Installer safety

```text
node install.mjs <install|update> --harness codex --project <dir>
  [--dry-run] [--json]
```

The Installer downloads the distribution Manifest, selects one native binary by OS, CPU, and Linux libc, verifies every byte length and SHA-256, and smoke-runs `--version` before mutation. Unsafe paths, symlink ancestors, unsupported platforms, network failures, hash drift, and user-file conflicts fail closed.

`aidlc/` Workspace data is never managed by the Installer. An update replaces only files that still match the previous Installation Manifest. Cleanup of a previously managed installation layout is allowed only for unchanged recorded files; Workflow State is neither converted nor deleted.

## Runtime boundary

The fixed ten-Stage Catalog and Graph are Core-owned. AI proposes Stage-local work and never selects the next Stage. System Map JSON and Intent artifacts are validated by strict contracts before Core writes canonical revisions.

```bash
./.codex/tools/aidlc graph validate
./.codex/tools/aidlc workspace init .
./.codex/tools/aidlc intent birth . "First Intent"
./.codex/tools/aidlc next .
```

## Release creation

`bun run package:github` creates local release candidates. Creating a `v1.0.0` tag or publishing a GitHub Release is a separate authorized operation after the Release Gate passes.
