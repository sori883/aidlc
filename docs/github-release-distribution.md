# GitHub Release / native CLI distribution

AI-DLC vNextはGo 1.26.4で開発、検証、cross-buildする。利用者のProjectでは
Node.js、Bun、GoをRuntime依存として要求しない。

## Installed layout

```text
<project>/
├── .agents/skills/aidlc/
├── .codex/
│   ├── aidlc-common/
│   ├── memory/
│   ├── tools/
│   │   ├── aidlc                         POSIX target selector
│   │   ├── aidlc.exe                     windows-amd64
│   │   └── bin/
│   │       ├── aidlc-darwin-amd64
│   │       ├── aidlc-darwin-arm64
│   │       ├── aidlc-linux-amd64
│   │       └── aidlc-linux-arm64
│   ├── hooks.json
│   └── aidlc-installation.json
├── AGENTS.md
└── aidlc/                                user-owned Workspace and artifacts
```

同じProjectを対応OS間でcloneできるよう全5 Targetを配置する。各Go CLIは16MiB未満で、
POSIX launcherがOS／CPUを選択し、Windowsは`aidlc.exe`を直接実行する。Project配布物に
実行可能なTypeScriptやJavaScript Runtimeは含めない。

## Installer safety

POSIX:

```bash
sh install.sh --harness codex --project . [--dry-run] [--json]
```

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --harness codex --project .
```

bootstrap scriptは`SHA256SUMS`でhost用Go CLIを検証してから`aidlc install`を実行する。
Go InstallerはDistribution Manifest、全Project file、全5 binaryのbyte長とSHA-256を検証し、
host binaryをPATHなしでsmokeしてから書き込む。unsafe path、symlink ancestor、対応外platform、
network failure、hash drift、利用者fileとのconflictはfail closedで拒否する。

`aidlc/` Workspace dataは管理しない。updateは前回のInstallation Manifestと現在のSHA-256が
一致するfileだけを置き換え、変更済みfileや未知のfileを削除しない。

## Runtime boundary

固定10 StageのCatalogとGraphはCore-ownedである。AIはStage-local proposalだけを作り、
Coreがstrict contractを通してcanonical revision、State、Audit、routeを管理する。

```bash
./.codex/tools/aidlc graph validate
./.codex/tools/aidlc workspace init .
./.codex/tools/aidlc intent birth . "First Intent"
./.codex/tools/aidlc next .
```

## Release creation

`go run ./cmd/aidlc-dev package-release --out build/github-release`はlocal release candidateだけを
生成する。`v1.0.0` tag作成とGitHub Release公開はRelease Gate完了後の別承認操作である。
