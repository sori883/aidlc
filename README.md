# AI-DLC v2 for Codex

AI-DLC v2のStage、Agent、Sensor、Rule、Scopeを、Codexから実行するためのTypeScript実装です。

AIが自由に次の作業を決めるのではなく、コンパイル済みのStage Graph、Scope、永続化されたStateに従ってWorkflowを進めます。人間は目的とScopeを伝え、質問に回答し、Stageの成果物を確認して承認します。

## 必要な環境

- Node.js
- pnpm 11系
- Git
- Codex Desktop、Codex CLI、またはCodex IDE Extension

## 新しいプロジェクトへ導入する

以下では、AI-DLCリポジトリと同じ親ディレクトリに`my-project`を作る例を使用します。別の場所へ導入する場合は、`../my-project`を任意の導入先に置き換えてください。

### 1. AI-DLC本体を取得する

```bash
git clone https://github.com/sori883/aidlc.git
cd aidlc
pnpm install --frozen-lockfile
```

### 2. Codex用バンドルを生成する

導入先は、空または存在しないフォルダーを指定します。macOSが作成する`.DS_Store`だけが存在するフォルダーも使用できます。

```bash
pnpm bundle:write --out ../my-project
```

このコマンドは、CodexからAI-DLCを実行するためのSkill、Agent、Stage定義、TypeScriptランタイムを導入先へ生成します。

> バンドルWriterは利用者のファイルを守るため、`aidlc-bundle.json`がない非空フォルダーを上書きしません。既存プロジェクトへ初めて導入する場合は、後述の「既存プロジェクトへ導入する」を参照してください。

### 3. 配布ランタイムの依存関係をインストールする

```bash
pnpm --dir ../my-project/.codex install --frozen-lockfile
```

`tsx`と`yaml`は`.codex/node_modules/`へ導入されます。グローバルインストールは不要です。

### 4. 導入結果を検査する

```bash
pnpm bundle:check --out ../my-project
pnpm --dir ../my-project/.codex run contract check
```

次の2つが表示されれば導入成功です。

```text
Codex bundle is in sync at .../my-project.
Runtime contract is valid (46 documents checked).
```

### 5. Codex Desktopで開始する

1. Codex Desktopで生成した`my-project`をプロジェクトとして開きます。
2. 入力欄のSkillsから`AI-DLC`を選択します。
3. 作りたいものとScopeを自然文で依頼します。

例：

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

## 生成されるファイル

バンドル生成直後は次の構成になります。

```text
my-project/
├── AGENTS.md
├── aidlc-bundle.json
├── .agents/
│   └── skills/
│       └── aidlc/
└── .codex/
    ├── package.json
    ├── tools/
    ├── agents/
    ├── aidlc-common/
    ├── knowledge/
    ├── sensors/
    └── hooks/
```

最初のWorkflowを開始すると、さらに`aidlc/`が作成されます。

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

## AI-DLCを更新する

AI-DLCリポジトリのルートで本体を更新し、同じ出力先にもう一度バンドルを生成します。

```bash
git switch main
git pull --ff-only
pnpm install --frozen-lockfile

pnpm bundle:write --out ../my-project
pnpm --dir ../my-project/.codex install --frozen-lockfile
pnpm bundle:check --out ../my-project
```

更新時に削除されるのは、以前の`aidlc-bundle.json`でAI-DLC生成物として管理され、最新版では不要になったファイルだけです。利用者のソースコードや`aidlc/`内のState、Audit、成果物は保持されます。

## 既存プロジェクトへ導入する

初回のバンドル生成は、管理対象ではない非空フォルダーを上書きしません。既存プロジェクトへ導入する場合は、空のステージングフォルダーへ生成して、次をプロジェクトルートへマージします。

- `AGENTS.md`
- `aidlc-bundle.json`
- `.agents/`
- `.codex/`

既存の`AGENTS.md`や`.codex/`と衝突する場合は、上書き前に内容を確認してください。マージ後はプロジェクトルートで次を実行します。

```bash
pnpm --dir .codex install --frozen-lockfile
pnpm --dir .codex run contract check
pnpm --dir .codex run doctor check --project-dir ..
```

## Workflowを再開する

同じプロジェクトをCodexで開き、`AI-DLC` Skillを選択して依頼します。

```text
AI-DLCを使って、現在のIntentを再開してください。
```

現在位置は、プロジェクトルートから次のコマンドでも確認できます。

```bash
pnpm --dir .codex run state resume ..
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

一覧表示：

```bash
pnpm --dir .codex run space list ..
pnpm --dir .codex run intent list ..
```

切り替え：

```bash
pnpm --dir .codex run space switch .. <space-name>
pnpm --dir .codex run intent switch .. <intent-name>
```

切り替えはアクティブな参照先だけを変更し、IntentのState本文やStatusを変更しません。

## 診断と復旧

Workspace、Intent、State、Plan、Audit、Unit DAG、生成SkillをDoctorで診断できます。

```bash
pnpm --dir .codex run doctor check --project-dir ..
```

Doctorが`automatic`と判定した項目だけを修復する場合は、次を実行します。

```bash
pnpm --dir .codex run doctor repair --project-dir ..
```

`manual`と表示された問題は自動推測されません。診断内容を確認して人間が判断してください。

## 開発者向け検査

このリポジトリ自体を変更した場合は、リリース検査を一括実行します。

```bash
pnpm release:check
```

このコマンドは次を順番に実行します。

- TypeScriptの型チェック
- 32 Stageのコンパイル済みGraph整合性チェック
- Stage／Agent本文とCLI実装のRuntime Contractチェック
- 全自動テスト

現在は、全9 Scope、Doctor、Codexバンドル生成、実Stage本文のCLI実行をE2Eで検証しています。最初に対応しているハーネスはCodexです。
