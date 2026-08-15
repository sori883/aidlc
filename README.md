# AI-DLC v2 for Codex

AI-DLC v2のStage、Agent、Sensor、Rule、ScopeをCodexから実行するためのTypeScript実装です。現在のリリースバージョンは`0.6.2`です。

AIが自由に次の作業を決めるのではなく、コンパイル済みのStage Graph、Scope、永続化されたStateに従ってWorkflowを進めます。人間は目的とScopeを伝え、質問に回答し、Stageの成果物を確認して承認します。

最初に対応しているハーネスはCodexです。

## 利用方法

用途に応じて次のどちらかを選択します。

| 用途 | 配布／実行方法 | Node.js | Bun |
|---|---|---:|---:|
| ユーザー向け | 初回・更新は`install.mjs`、Workflowは`.codex/tools/aidlc` | 配布時のみ必要 | 不要 |
| ソース／開発用 | `bun run ...` | 不要 | 必要 |

公開GitHub Releaseの`install.mjs`は、OSに合うネイティブバイナリ、Core Runtimeデータ、Codex Harnessを別々に取得してプロジェクトへ配置します。npm、npx、認証、トークンは使用しません。導入後のWorkspace、Intent、State、Doctor、Sensorなどは、すべてBunランタイム内蔵の単一実行ファイルが処理します。

ネイティブバイナリに含むのは、本家でBunから実行するTypeScriptコード、そのコード依存、Bunランタイムです。Stage、Rule、Sensor定義などのCoreデータと、`AGENTS.md`、Skills、Hooks、Agent TOMLなどのCodex Harnessは通常ファイルとして外部配置します。

## ユーザー向けの必要環境

- Node.js 22以上（初回導入と更新のみ）
- Codex Desktop、Codex CLI、またはCodex IDE Extension

Gitリポジトリである必要はありません。Git、Bun、npm、npx、pnpm、tsxを利用者がインストールする必要もありません。配布物は公開GitHub Releaseと公開リポジトリから匿名で取得します。

## 対応ターゲット

`0.6.2`ではInstallerが`os`、`cpu`、Linuxの`libc`に基づいて次の7種類から選択します。

| ターゲット | 用途 |
|---|---|
| `darwin-x64` | Intel Mac |
| `darwin-arm64` | Apple Silicon Mac |
| `linux-x64` | glibc系x64 Linux（古いCPUにも対応するbaselineビルド） |
| `linux-arm64` | glibc系ARM64 Linux |
| `linux-x64-musl` | musl系x64 Linux |
| `linux-arm64-musl` | musl系ARM64 Linux |
| `windows-x64` | x64 Windows |

開発用ビルド行列には`native`とLinux x64のmodern/baselineを含む9ターゲットがあります。GitHub Releaseでは互換性を優先し、glibc x64をbaselineへ統一します。

## AI-DLCをプロジェクトへ導入する

### 1. 公開GitHub Releaseから配置する

Node.js 22以上を使用し、最初にバージョン固定のInstallerを取得します。

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v0.6.2/install.mjs
```

対象プロジェクトのルートで明示的にインストールします。

```bash
node install.mjs install --harness codex --project .
```

Installerは公開Releaseから現在のOS用バイナリ1個を、タグ`v0.6.2`の`dist/project/`からCoreデータとCodex Harnessを取得し、全SHA-256を検証します。既存の管理外ファイルと競合した場合や、通信・検証に失敗した場合は何も上書きせず終了します。

配置結果は次の構成です。

```text
<project>/
├── .agents/
├── .codex/
│   ├── aidlc-common/      # Stage、Rule、Graphなど
│   ├── agents/            # Agent定義
│   ├── knowledge/
│   ├── memory/
│   ├── scopes/
│   ├── sensors/
│   ├── tools/
│   │   ├── aidlc          # Windowsの実体はaidlc.exe
│   │   └── contracts/
│   ├── hooks.json
│   └── aidlc-installation.json
└── AGENTS.md
```

本家と同じくRuntimeとHarnessは`.codex/`へ展開し、本家のTypeScript CLIに相当するネイティブ実行ファイルだけを`.codex/tools/aidlc`へ配置します。`.codex/aidlc-installation.json`にはInstallerが管理するファイルのSHA-256、Releaseタグ、バイナリターゲットが記録されます。`aidlc/`はWorkspaceデータであり、この配布管理の対象外です。

### 2. ネイティブバイナリを確認する

macOS、Linux、Windows PowerShellで共通の相対表記を使用できます。

```bash
./.codex/tools/aidlc --version
./.codex/tools/aidlc graph compile --check
```

バージョンには`aidlc 0.6.2`、Graph検証には`32 stages`と表示されます。この時点ではWorkspaceがまだないため、Doctorの`workspace.missing`は異常ではありません。

### 3. Codexで開始する

1. Codex Desktopで対象プロジェクトを開きます。
2. 入力欄のSkillsから`AI-DLC`を選択します。
3. 作りたいものとScopeを自然文で依頼します。

例:

```text
AI-DLCを使って、ブログをMVPスコープで開発してください。
```

`/aidlc`を入力する必要はありません。Codex CLI／IDEでは`$aidlc`でも明示的に呼び出せます。

初回はCodexが次の処理を行います。

1. AI-DLC Workspaceを初期化する
2. `default` Spaceを作成する
3. 依頼内容に対応するIntentを作成する
4. 指定Scopeの実行計画を作成する
5. 最初のStageを開始する

人間が事前に`workspace init`や`intent birth`を実行する必要はありません。Scopeを指定しなかった場合はCodexが確認します。Hookの信頼確認が表示された場合は、内容を確認して許可してください。

WorkspaceとIntentが作成された後、配布資産とWorkflow Stateを診断します。

```bash
./.codex/tools/aidlc doctor check --project-dir .
```

## Workflowで生成されるファイル

最初のWorkflowを開始すると、対象プロジェクトに`aidlc/`が作成されます。

```text
aidlc/
├── active-space
└── spaces/
    └── default/
        ├── memory/
        ├── knowledge/
        ├── codekb/
        └── intents/
            ├── active-intent
            ├── intents.json
            └── <intent-record>/
                ├── aidlc-state.md
                ├── .aidlc-plan.json
                ├── audit/
                ├── initialization/
                ├── ideation/
                ├── inception/
                ├── construction/
                ├── operation/
                └── verification/
```

| ファイル／ディレクトリ | 役割 |
|---|---|
| `aidlc-state.md` | 現在のStage、完了状況、再開位置を保持する |
| `.aidlc-plan.json` | 選択Scopeから解決された実行計画を保持する |
| `audit/` | Workflow、Phase、Stage、承認などの監査イベントを記録する |
| 各Phaseディレクトリ | Stage成果物とStage Memoryを保存する |
| Spaceの`memory/` | 組織、チーム、プロジェクト、PhaseのRuleを保持する |
| Spaceの`knowledge/` | 人間やチームが管理する共有・Agent別知識を保持する |
| Spaceの`codekb/` | Brownfield解析でRepoごとのコード知識を保持する |

`aidlc-state.md`、`.aidlc-plan.json`、Audit Markdownは直接編集しないでください。StateとAuditはAI-DLCランタイムが更新します。

## Workflowを再開する

同じプロジェクトをCodexで開き、`AI-DLC` Skillを選択して依頼します。

```text
AI-DLCを使って、現在のIntentを再開してください。
```

現在位置は、プロジェクトルートから次のコマンドでも確認できます。

```bash
./.codex/tools/aidlc state resume .
```

Codexのセッションが変わっても、保存されたStateから再開します。

## Scopeの選び方

| Scope | 用途 |
|---|---|
| `feature` | 新機能を標準的な深さで開発する |
| `mvp` | 運用工程を省き、必要な中核機能を早く作る |
| `poc` | 実現可能性を短期間で検証する |
| `bugfix` | 特定の不具合を修正する |
| `refactor` | 既存コードの構造を改善する |
| `security-patch` | 脆弱性やCVEへ対応する |
| `infra` | インフラ、デプロイ、運用基盤を変更する |
| `workshop` | 研修や共同検討を、人間の確認を挟みながら進める |
| `enterprise` | 全Stageと監査証跡が必要な規制・大規模案件を扱う |

迷った場合、新機能は`feature`、小さく始める場合は`mvp`、技術検証だけなら`poc`が目安です。

## SpaceとIntent

- **Space**: チームやプロジェクトのMemory、Knowledge、Intentを分離する単位
- **Intent**: 1つの開発目的に対応するWorkflow記録

一覧表示:

```bash
./.codex/tools/aidlc space list .
./.codex/tools/aidlc intent list .
```

切り替え:

```bash
./.codex/tools/aidlc space switch . <space-name>
./.codex/tools/aidlc intent switch . <intent-name>
```

切り替えはアクティブな参照先だけを変更し、IntentのState本文やStatusを変更しません。

## 診断と復旧

Workspace、Intent、State、Plan、Audit、Unit DAG、生成SkillをDoctorで診断できます。

```bash
./.codex/tools/aidlc doctor check --project-dir .
```

Doctorが`automatic`と判定した項目だけを修復する場合:

```bash
./.codex/tools/aidlc doctor repair --project-dir .
```

`manual`と表示された問題は自動推測されません。診断内容を確認して人間が判断してください。

## 更新する

更新先バージョンのInstallerを取得し、対象プロジェクトのルートで実行します。

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v0.6.2/install.mjs
node install.mjs update --harness codex --project .
./.codex/tools/aidlc doctor check --project-dir .
```

更新前のハッシュと一致する管理対象ファイルだけを置換します。利用者が編集した`AGENTS.md`、Skill、Hookなどがある場合は、競合パスを表示して全更新を中止します。v0.6.0からの更新では、改変されていない旧`.aidlc/bin`と`.aidlc/runtime`だけを移行後に削除します。未管理ファイルと、プロジェクトの`aidlc/`にあるWorkspace、Intent、State、Audit、成果物は削除・更新しません。

詳しい導入、更新、ローカルHTTP配布テストは[GitHub Release＋ネイティブバイナリ配布](docs/release-packaging.md)を参照してください。

## 開発者向けセットアップ

ここからの手順はAI-DLC自体を開発する人向けです。Bun 1.3系とGitが必要です。

```bash
git clone https://github.com/sori883/aidlc.git
cd aidlc
bun install --frozen-lockfile
```

### ソースからCodexバンドルを生成する

空または存在しない導入先を指定します。

```bash
bun run bundle:write --out ../my-project
bun install --cwd ../my-project/.codex --frozen-lockfile
bun run bundle:check --out ../my-project
bun run --cwd ../my-project/.codex aidlc contract check
```

ソース生成バンドルは開発用TypeScriptランタイムを含むため、生成先でもBunによる依存インストールが必要です。ユーザー向けバイナリ配布物にはこの手順はありません。

バンドルWriterは`aidlc-bundle.json`がない非空フォルダーを上書きしません。既存プロジェクトへ導入する場合は空のステージングフォルダーへ生成し、`AGENTS.md`、`aidlc-bundle.json`、`.agents/`、`.codex/`を内容確認のうえマージしてください。

### 開発検査

```bash
bun run release:check
```

このコマンドはバージョン整合性、型チェック、32 StageのGraph整合性、46文書のRuntime Contract、全自動テストを実行します。全9 Scope、Doctor、Codexバンドル生成、実Stage本文のCLI実行をE2Eで検証します。

### バイナリをビルドする

現在の開発ホスト向け:

```bash
bun run binary:build
```

9ターゲットすべて:

```bash
bun run binary:build:all
```

成果物は`build/binaries/<target>/`へ生成されます。実行ファイルはHarness-neutralです。`project-layout/`はSmoke Test用の分離済みCore Runtime／Codex Harnessであり、バイナリには埋め込まれません。

### GitHub Release配布物を作る

追跡するCore Runtime／Codex Harness配布ツリーを更新します。

```bash
bun run distribution:write
bun run distribution:check
```

公開用の全ターゲット、Installer、Manifest、SHA256SUMSを生成します。

```bash
bun run package:github
```

外部のCoreデータとCodex Harnessは`dist/project/`、Release Assetは`build/github-release/`へ生成されます。npmパッケージや利用者向けアーカイブは作成しません。

現在の開発ホストだけで公開HTTP相当の配布E2Eを実行します。

```bash
bun test tests/aidlc-github-distribution.test.ts
```

`main`へ変更がマージされると`.github/workflows/ci-main.yml`がRelease Gateを
実行します。そのコミットの試験成功後に、`package.json`と同じバージョンの
`v*`タグを設定してpushすると、`.github/workflows/release-github.yml`が
配布物だけを生成してGitHub Releaseを公開します。mainへ未マージのタグ、
試験未完了／失敗のコミット、既存Releaseと同じタグは公開されません。

リリース行列とCIの詳細は[Bun移行計画](docs/bun-migration-plan.md)、配布物の運用手順は[GitHub Release＋ネイティブバイナリ配布](docs/release-packaging.md)を参照してください。
