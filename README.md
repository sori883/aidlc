# AI-DLC vNext for Codex

AI-DLC vNextは、AIに開発の行き先を自由に決めさせず、Coreが固定した10個のStageに沿って作業を進めるCodex向け開発基盤です。現在のリリースバージョンは`1.0.0`です。

AIは各Stageの成果物を提案できます。ただし、次のStage、実行順、承認の要否、完了判定はCoreが決めます。人間の判断が必要な場面では、Coreが生成したHTMLを確認してから承認します。

## 10個のStage

| Stage | 人間向けの意味 | 主な結果 |
| --- | --- | --- |
| ST-00 | 開始できる状態か確認する | Bootstrap Receipt |
| ST-01 | 現在のシステムを把握する | System Map、Current Context |
| ST-02 | 今回の目的を言葉にする | Intent Definition |
| ST-03 | 必要なことと制約を整理する | Requirements |
| ST-04 | 作り方の大きな判断をする | Architecture Decision |
| ST-05 | 実装内容と確認方法を合意する | Build Contract、Bolt DAG |
| ST-06 | 合意済みのBoltを実装する | Runnable Candidate |
| ST-07 | 人間が結果を確認する | Accepted Candidate |
| ST-08 | リリースを承認して実行する | Release Outcome |
| ST-09 | 狙った成果を確認する | Outcome Evaluation |

Stageの一覧と遷移は固定Catalog／Graphが正本です。AIはStageの追加、削除、並べ替えを行いません。小さな変更でもStage自体は変わらず、各Stageの成果物が短くなります。

## インストール

導入・更新時だけNode.js 22以上が必要です。導入後の実行にBun、npm、npxは不要です。

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v1.0.0/install.mjs
node install.mjs install --harness codex --project .
```

Windows PowerShell:

```powershell
Invoke-WebRequest "https://github.com/sori883/aidlc/releases/download/v1.0.0/install.mjs" -OutFile "install.mjs"
node install.mjs install --harness codex --project .
```

InstallerはOSに合うネイティブCLIとCodex用ファイルを取得し、サイズとSHA-256を確認してから配置します。管理外ファイルとの競合や検証失敗がある場合は、プロジェクトを書き換えません。

## 最初のIntentを始める

プロジェクトのルートで実行します。

```bash
./.codex/tools/aidlc --version
./.codex/tools/aidlc graph validate
./.codex/tools/aidlc workspace init .
./.codex/tools/aidlc intent birth . "最初のIntent"
./.codex/tools/aidlc next .
```

以後は、`next`が返すCore Directiveに従います。

```bash
./.codex/tools/aidlc next .
./.codex/tools/aidlc state resume .
./.codex/tools/aidlc intent risk show .
./.codex/tools/aidlc doctor check .
```

- `work`: AIが指定された成果物候補だけを作り、指定されたCoreコマンドへ提出します。
- `approval`: 人間が生成済みHTMLとSHA-256を確認して判断します。
- `advanced`: Coreが固定Graph上で次のStageへ進めました。
- `parked`: 安全上の理由で停止しています。AIは迂回しません。
- `done`: Intentが完了しています。

## 保存場所

```text
<project>/
├── .codex/                       配布RuntimeとネイティブCLI
├── .agents/skills/aidlc/         Codex Skill
├── AGENTS.md                     Codex向けの共通指示
└── aidlc/
    ├── memory/                   組織・チーム・プロジェクトのMemory／Policy
    └── spaces/<space>/
        ├── memory/codekb/        Evidence付きの共有System Map
        └── intents/<intent>/     Plan、State、成果物、Audit
```

System Mapの正本はJSONです。HTMLは人間から指示された場合だけ生成します。IntentのCurrent Contextは、使用したSystem Map revisionとSHA-256を固定参照します。

## 更新と旧State

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v1.0.0/install.mjs
node install.mjs update --harness codex --project .
./.codex/tools/aidlc doctor check .
```

Installerは、前回の記録と一致する管理対象だけを更新します。`aidlc/`内のWorkspaceや成果物は利用者所有で、Installerは削除しません。

pre-vNext形式のWorkflow Stateは自動変換しません。Doctorは`VNEXT_UNSUPPORTED_WORKFLOW_STATE`を返し、旧ファイルを保持します。新しいvNext IntentをBirthして再開してください。

## 開発

開発環境はBunとTypeScriptです。

```bash
bun install
bun run release:check
bun run bundle:write
bun run distribution:write
bun run binary:build:all
bun run package:github
```

`package:github`はローカルに公開候補を生成します。タグ作成やGitHub Release公開は別の明示的な作業です。

詳しい配布手順は[docs/release-packaging.md](docs/release-packaging.md)、1.0.0の変更点は[docs/aidlc-vnext-1.0.0-release-notes.md](docs/aidlc-vnext-1.0.0-release-notes.md)を参照してください。
