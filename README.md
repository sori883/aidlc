# AI-DLC v2 for Codex

AI-DLC v2のStage、Agent、Sensor、Rule、Scopeを、Codexから実行するためのTypeScript実装です。

AIが自由に次の作業を決めるのではなく、コンパイル済みのStage Graph、Scope、永続化されたStateに従ってWorkflowを進めます。人間は目的とScopeを伝え、質問に回答し、Stageの成果物を確認して承認します。

## 必要な環境

- Node.js
- pnpm 11系
- Codex
- Git（リポジトリを取得する場合）

このリポジトリを開発する場合は、最初に依存関係をインストールします。

```bash
pnpm install --frozen-lockfile
```

## 最短で始める

### 1. Codex用バンドルを生成する

このリポジトリで、空の出力先を指定して実行します。

```bash
pnpm bundle:write --out /absolute/path/to/my-project
```

出力先には、Codexランタイム、Agent、Skill、Stage定義などが生成されます。

> バンドルWriterは、利用者のファイルを守るため、管理対象ではない非空ディレクトリを上書きしません。新規プロジェクトでは空または存在しないディレクトリを指定してください。

既存プロジェクトへ導入する場合は、最初に空のステージングディレクトリへ生成し、次の生成物を既存プロジェクトのルートへマージします。

- `AGENTS.md`
- `aidlc-bundle.json`
- `.codex/`
- `.agents/`

既存ファイルと衝突する場合は、上書き前に内容を確認してください。マージ後は、後述のDoctorで配布物の欠損や変更を検査できます。

### 2. 配布ランタイムの依存関係をインストールする

対象プロジェクトのルートで実行します。

```bash
pnpm --dir .codex install --frozen-lockfile
```

### 3. CodexでWorkflowを開始する

対象プロジェクトをCodex Desktopで開き、入力欄のSkillsから`AI-DLC`を選択して依頼します。青い`AI-DLC`チップが表示されていれば選択済みです。

```text
Payment APIをMVPスコープで開発してください。
```

`/aidlc`を入力する必要はありません。Codex CLI／IDEでは`$aidlc`でも明示的に呼び出せます。

Scopeを指定しなかった場合、Codexが確認します。初回はWorkspaceとIntentが作成され、2回目以降は保存済みのStateから再開します。初回にHookの信頼確認が表示された場合は、内容を確認して許可してください。

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

## 人間が行うこと

Workflowの経路、State、Audit、成果物パスはエンジンが管理します。人間は主に次の判断を行います。

1. 作りたいものと制約を説明する
2. Codexからの不足情報の質問に回答する
3. Stageごとに生成された成果物を確認する
4. 学習候補をRuleとして残すか判断する
5. 成果物に問題がなければ明示的に承認する

通常のStageは人間の承認ゲートを持ちます。Codexへ「承認します」など明確に伝えるまで、エンジンは次のStageを完了扱いにしません。

`aidlc-state.md`やAuditのMarkdownは直接編集しないでください。また、実際には行っていない承認を記録しないでください。

## 再開する

同じプロジェクトをCodex Desktopで開き、再度`AI-DLC` Skillを選択します。

```text
現在のIntentを再開してください。
```

現在位置は、対象プロジェクトのルートから次のコマンドでも確認できます。

```bash
pnpm --dir .codex run state resume ..
```

Stateには、現在のStage、次のStage、完了数、Scope、Unit実行位置が保存されています。Codexのセッションが変わっても、このStateから再開します。

## SpaceとIntent

- **Space**: チームやプロジェクトのMemory、Knowledge、Intentを分離する単位
- **Intent**: 1つの開発目的に対応するWorkflow記録

一覧表示は次のコマンドで行います。

```bash
pnpm --dir .codex run space list ..
pnpm --dir .codex run intent list ..
```

Spaceを追加・切り替える場合は次のように実行します。

```bash
pnpm --dir .codex run space create .. team-a
pnpm --dir .codex run space switch .. team-a
```

Intentを手動で作成・切り替える場合は次のように実行します。

```bash
pnpm --dir .codex run intent birth .. "Payment API" --scope mvp
pnpm --dir .codex run intent switch .. <intent-name>
```

切り替え操作はアクティブな参照先だけを変更し、IntentのState本文やStatusを変更しません。

## 診断と復旧

Workspace、Intent、State、Plan、Audit、Unit DAG、生成SkillなどをDoctorで診断できます。

```bash
pnpm --dir .codex run doctor check --project-dir ..
```

JSONで取得する場合は`--json`を付けます。

```bash
pnpm --dir .codex run doctor check --project-dir .. --json
```

Doctorが`automatic`と判定した項目だけを修復する場合は、次を実行します。

```bash
pnpm --dir .codex run doctor repair --project-dir ..
```

複数Intentからの選択、曖昧な進捗、承認状態、利用者が記述した定義や成果物は自動推測しません。`manual`と表示された問題は、診断内容を確認して人間が判断してください。

## 生成される主なファイル

```text
my-project/
├── AGENTS.md
├── aidlc-bundle.json
├── .codex/
│   ├── package.json
│   ├── tools/
│   ├── agents/
│   ├── aidlc-common/
│   └── hooks/
├── .agents/
│   └── skills/
└── aidlc/
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

主な役割は次のとおりです。

| ファイル／ディレクトリ | 役割 |
|---|---|
| `aidlc-state.md` | 現在のStage、完了状況、再開位置を保持する |
| `.aidlc-plan.json` | 選択Scopeから解決された実行計画を保持する |
| `audit/` | Workflow、Phase、Stage、修復などの監査イベントを記録する |
| 各Phaseディレクトリ | Stage成果物とStage Memoryを保存する |
| Spaceの`memory/` | 組織、チーム、プロジェクト、PhaseのRuleを保持する |
| Spaceの`knowledge/` | 人間やチームが管理する共有・Agent別知識を保持する |
| Spaceの`codekb/` | Brownfield解析でRepoごとのコード知識を保持する |

Stage MemoryからSpace Knowledgeへの自動昇格は行いません。Knowledgeは人間またはチームが管理します。

## 開発者向けコマンド

このリポジトリ自体を変更した場合は、リリース検証を一括実行します。

```bash
pnpm release:check
```

このコマンドは次を順番に実行します。

- TypeScriptの型チェック
- 32 Stageのコンパイル済みGraph整合性チェック
- 全自動テスト

個別に実行する場合は次のコマンドを使用します。

```bash
pnpm typecheck
pnpm graph:check
pnpm test
```

バンドルを生成・検証する場合は次のように実行します。

```bash
pnpm bundle:write --out ./dist/codex
pnpm bundle:check --out ./dist/codex
```

## 現在の対応範囲

- AI-DLC v2のStage Graph、Scope、Agent、Sensor、Rule、Memory、State、Audit
- Greenfield／BrownfieldのWorkspace検出
- Unitおよび複数Repoの実行状態
- Codex Agent／Skill／Hookの生成と配布
- 中断再開とDoctorによる診断・安全な復旧
- 全9 ScopeのE2E検証

最初に対応しているハーネスはCodexです。
