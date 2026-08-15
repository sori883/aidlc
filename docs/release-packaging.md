# GitHub Release＋ネイティブバイナリ配布

## 配布モデル

AI-DLCは公開GitHub Releaseと、同じバージョンタグの`dist/project/`から
匿名で導入する。npm、npx、GitHub Packages、認証、トークン、配布用
archiveは使用しない。

```text
install.mjs
├── aidlc-distribution.json
├── aidlc-<platform>        → .codex/tools/aidlc[.exe]
└── dist/project/*
    ├── Core Runtime data   → .codex/
    └── Codex Harness       → AGENTS.md, .agents/, .codex/
```

ネイティブバイナリは、本家でBunから実行するTypeScriptコード、その
コード依存、Bunランタイムを含む。Stage、Rule、Sensor、Agent persona
などのCoreデータとCodex Harnessは含めず、通常ファイルとして配置する。

## 利用者の前提環境

- Node.js 22以上（導入・更新時のみ）
- Codex Desktop、Codex CLI、またはCodex IDE Extension
- GitHubへHTTPS接続できること

Git、Bun、npm、npx、pnpm、tsx、プロジェクトの`node_modules`は不要で、
導入先をGitリポジトリにする必要もない。

## 導入

バージョン固定のInstallerを公開Releaseから取得する。

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v0.6.1/install.mjs
node install.mjs install --harness codex --project .
```

Windows PowerShell:

```powershell
Invoke-WebRequest `
  "https://github.com/sori883/aidlc/releases/download/v0.6.1/install.mjs" `
  -OutFile "install.mjs"

node install.mjs install --harness codex --project .
```

配置結果:

```text
<project>/
├── .agents/
├── .codex/
│   ├── aidlc-common/, agents/, knowledge/, memory/
│   ├── scopes/, sensors/
│   ├── tools/aidlc[.exe]
│   ├── hooks.json
│   └── aidlc-installation.json
└── AGENTS.md
```

InstallerはManifestと全配布ファイルを取得し、サイズとSHA-256を検証する。
OS、CPU、Linux libcに合うバイナリ1個だけを取得し、PATHを空にした
`--version`検査へ成功してから対象プロジェクトを書き換える。

## 実行確認

```bash
./.codex/tools/aidlc --version
./.codex/tools/aidlc graph compile --check
./.codex/tools/aidlc workspace init .
./.codex/tools/aidlc intent birth . "First Intent" --scope poc
./.codex/tools/aidlc doctor check --project-dir .
```

Windowsの実体は`.codex/tools/aidlc.exe`である。PowerShellは生成済みSkillの
共通相対表記`./.codex/tools/aidlc`から`.exe`を解決し、Hookは明示的に
`aidlc.exe`を呼び出す。

## dry-runと競合保護

```bash
node install.mjs install --harness codex --project . --dry-run
```

次のいずれかは全体を停止する。

- HTTP失敗、タイムアウト、Manifest不正
- サイズまたはSHA-256不一致
- Native CLIの`--version`検査失敗
- 対応外OS／CPU／libc
- 配布先から脱出するpath、symlink、特殊ファイル
- 初回導入前から存在し、配布内容と異なるファイル
- 前回導入後に利用者が変更した管理対象ファイル

競合が一つでもあれば、バイナリ、Core、Harness、`aidlc-installation.json`を
一切変更しない。`aidlc/`配下のWorkspace、Intent、State、Audit、成果物は
常に利用者所有であり、Installerは読み書きしない。

## 更新

更新先バージョンのInstallerを取得する。

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v0.6.1/install.mjs
node install.mjs update --harness codex --project .
./.codex/tools/aidlc doctor check --project-dir .
```

前回記録したSHA-256と現在のファイルが一致する場合だけ置換する。通常更新は
自動削除と自動マージを行わず、新しい配布から消えた旧管理ファイルの追跡を
維持する。v0.6.0の旧`.aidlc`配置から更新する場合に限り、ハッシュが一致する
旧バイナリと旧Runtimeを削除する。変更済みファイルや未管理ファイルは削除しない。

## 開発者向け生成

外部Core／Harnessツリーを生成・検査する。

```bash
bun run distribution:write
bun run distribution:check
```

全7ターゲットとInstaller、Manifest、Checksumを生成する。

```bash
bun run package:github
```

成果物:

```text
build/github-release/
├── install.mjs
├── aidlc-distribution.json
├── SHA256SUMS
├── aidlc-darwin-x64
├── aidlc-darwin-arm64
├── aidlc-linux-x64
├── aidlc-linux-arm64
├── aidlc-linux-x64-musl
├── aidlc-linux-arm64-musl
└── aidlc-windows-x64.exe
```

ローカルHTTP E2E:

```bash
bun test tests/aidlc-github-distribution.test.ts
```

このテストは公開GitHubの代わりにローカルHTTPサーバーを使用し、匿名導入、
改ざん拒否、404時の無変更、dry-run、更新、競合保護、実行時Node/Bun不要を
検証する。

## Release運用

mainとReleaseのWorkflowを分離する。

1. mainへのpush（Pull Requestのマージを含む）で
   `.github/workflows/ci-main.yml`を起動する。
2. main Workflowが配布ツリー同期、型、Graph、Runtime Contract、全テストを
   検証する。
3. 成功したmainコミットへ、`package.json`と一致する新しい`v*`タグを付けて
   pushする。
4. `.github/workflows/release-github.yml`が、タグのコミットがmainに含まれ、
   同じコミットのmain Workflowが成功済みであることを確認する。
5. Release Workflowは試験を再実行せず、全配布物を生成し、Draft Releaseへ
   生Assetをアップロードしてから公開する。

例:

```bash
# main Workflowの成功をGitHub上で確認した後
git switch main
git pull --ff-only
git tag v0.6.1
git push origin v0.6.1
```

タグを試験完了前にpushした場合、Release Workflowは公開せず失敗する。main
試験の成功後に同じWorkflowを再実行できる。mainへ未マージのコミットを指す
タグ、version不一致、既存Releaseと同じタグも拒否する。公開済みタグは移動・
再利用せず、更新には`v0.6.1`のような新しいversionとタグを使用する。

GitHub Actionsの一時Artifactは使用しない。Release Assetは1ファイル2 GiB
未満、1 Release最大1,000 Assetであり、本配布は最大約95 MiB／ファイル、
10 Asset、合計約575 MiBである。GitHub公式仕様ではRelease全体の合計サイズと
帯域幅に上限はない。利用者が1回の導入で取得するのは対応OSのバイナリ1個、
Installer、Manifest、外部Core／Harness約0.74 MiBであり、全7バイナリを
ダウンロードするわけではない。正式版Assetは後から差し替えない。

上限の根拠: [GitHub Docs: About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas)
