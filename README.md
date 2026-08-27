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

## Stage作業のAgent委譲

Codexの親AgentはConductorとしてCore Directiveを受け取り、固定の
`vnext-stage-delegation.json`に従って各Stageの作業を役割別Agentへ委譲します。
親AgentはStage成果物をインラインで代行しません。

- ST-00はCoreが自動実行します。
- ST-01〜ST-06、ST-08、ST-09のAI作業はlead Agentへ委譲します。
- ST-03以降の重要な提案はsupport／reviewerの独立した視点を通します。
- ST-07は読み取り専用Agentが確認し、最終判断は人間が行います。
- すべてのStage Agentは`$aidlc-stage-work`を使い、再委譲しません。
- State、Audit、Stage遷移、承認、外部実行の権限は引き続きCoreと人間にあります。

割当の確認:

```bash
./.codex/tools/aidlc delegation validate
./.codex/tools/aidlc delegation show ST-06 work
./.codex/tools/aidlc delegation receipt . agent-123
```

## インストール

導入後のProjectには全5 TargetのGo CLIが入り、Node.js、Bun、GoのRuntimeは不要です。

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v1.0.0/install.sh
sh install.sh --harness codex --project .
```

Windows PowerShell:

```powershell
Invoke-WebRequest "https://github.com/sori883/aidlc/releases/download/v1.0.0/install.ps1" -OutFile "install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --harness codex --project .
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

## Codex Hook監査、Human Receipt、コンテキスト注入、Tool Guard、Sensor

Codex Harnessは、セッション、対象Tool、サブエージェント、compaction、Stopの
メタデータを、active Intentの`hook-audit/*.jsonl`へ記録します。通常の質問を含む
`UserPromptSubmit`はHook監査へ記録しません。人間ターンはOSの一時領域にある空の
セッションマーカーを上書き更新するだけで、質問本文、Session ID、Turn ID、質問回数を
永続化しません。Hook監査は観測証跡であり、Core Audit、Stage遷移、承認状態を変更する
権限を持ちません。

同じHarnessは`SessionStart`でactive Intentの現在地と再開方法を、
`SubagentStart`で現在のStage Contract、固定Agent割当、変更可能範囲、必須Skillを
Codexへ追加コンテキストとして渡します。compaction後も会話上の記憶を推測せず、
永続化されたStateとPlanを再読込します。Agentの役割が複数候補になる場合は候補を
すべて示し、Hook自身は役割を決めません。

コンテキスト注入は読み取り専用で、prompt、Agent task、コマンド、patch、Tool出力を
保存または再注入しません。Tool入力の書き換えやStage遷移も行いません。

ST-04、ST-05、ST-07、ST-08、ST-09、Intent Riskの人間判断では、Coreが対象、
Review、Gate、Graph、Plan revisionをReview Freezeとして固定します。AIが提案した
action、reason、parametersはDecision EnvelopeとHTMLに固定され、人間がCodexへ
生成済みの`/aidlc-confirm ...`を完全一致で送ったときだけ、`UserPromptSubmit` Hookが
Human Input Receiptを作ります。生のプロンプトは保存しません。

人間判断は次の共通経路だけで適用します。従来の`approve`、`authorize`、`decide`などの
直接承認コマンドは、人間入力を証明できないため無効です。

```bash
./.codex/tools/aidlc human-gate status .
./.codex/tools/aidlc human-gate prepare . human-action-proposal.json
# 人間が生成済み /aidlc-confirm ... をCodexのメッセージとして送る
./.codex/tools/aidlc human-gate apply . sha256:...
```

未解決のReview Freezeがある間、`Stop` Hookは`continue: false`を返します。Receiptは
対象、action、Session、Turn、Graph、Plan revisionへ固定され、一度だけ使用できます。

`PreToolUse`の別handlerは、`apply_patch`によるCore-ownedな`aidlc/`管理領域への
直接変更を実行前に拒否します。ST-06では、現在のBolt Work Requestが指定した
Worktreeとtargetだけを許可します。変更pathを確定できないBash変更コマンドは
ST-06中に拒否し、path単位で検査できる`apply_patch`を要求します。許可時は何も返さず、
拒否時だけCodexの`permissionDecision: deny`を返します。

`PreToolUse`入力にはAgent roleがないため、GuardはConductorやStage Agentを推測せず、
全actorへ同じ規則を適用します。Hookは補助境界であり、Coreのhash、参照、State/Plan
binding、ST-06 changed-path検証も引き続き正本です。

`PostToolUse`の`apply_patch`では、Go formatとJSON構文を標準ライブラリの決定的Sensorで
確認します。Human Gateを開く直前には、対象・Review・Gate要件の実ファイルを保存済み
SHA-256へ強制照合します。書込みSensorは助言、Gate Sensorはblockingです。

Stage Agentは最終応答を単一行の`AIDLC_STAGE_RESULT` JSON markerで終えます。
`SubagentStop` HookがStage、割当、role、scope、Skill、path、SHA-256を検証し、不変Receiptを
作ります。不正ならSubagentだけに1回訂正を求め、再失敗時は無限継続を避けてConductorへ
戻します。ReceiptはCore受入れではなく、return contract検証の証跡です。

永続処理を担当するhandlerはメタデータだけのheartbeatを残します。通常質問のTurn
Marker更新とReceipt no-opはheartbeat対象外です。`hook status`と`doctor check`は、
event配送、handler呼出し、Sensor path一致、実発火、terminal結果、Agent Receiptを
別々に診断します。未観測はwarning/info、設定欠落・重複・改ざんはerrorです。

インストールまたは更新後はCodexの`/hooks`で定義を確認して信頼し、新しいSessionで
動作を確認します。

```bash
./.codex/tools/aidlc hook status .
```

監査の詳細は[docs/codex-hook-audit-design.md](docs/codex-hook-audit-design.md)、
注入内容は[docs/codex-hook-context-design.md](docs/codex-hook-context-design.md)、
Guardの計画と境界は[docs/codex-hook-guard-plan.md](docs/codex-hook-guard-plan.md)と
[docs/codex-hook-guard-design.md](docs/codex-hook-guard-design.md)、Human Receiptは
[docs/codex-hook-human-approval-plan.md](docs/codex-hook-human-approval-plan.md)と
[docs/codex-hook-human-approval-design.md](docs/codex-hook-human-approval-design.md)、Sensorは
[docs/codex-hook-sensor-design.md](docs/codex-hook-sensor-design.md)、Agent return制御は
[docs/codex-hook-subagent-design.md](docs/codex-hook-subagent-design.md)、診断は
[docs/codex-hook-health-design.md](docs/codex-hook-health-design.md)を参照してください。

## 保存場所

```text
<project>/
├── .codex/                       配布RuntimeとネイティブCLI
│   ├── agents/                   Stage AgentのpersonaとCodex設定
│   └── tools/                    POSIX launcherと全5 TargetのGo CLI
├── .agents/skills/
│   ├── aidlc/                    Conductor Skill
│   └── aidlc-stage-work/         Stage Agent共通Skill
├── AGENTS.md                     Codex向けの共通指示
└── aidlc/
    ├── memory/                   組織・チーム・プロジェクトのMemory／Policy
    └── spaces/<space>/
        ├── memory/codekb/        Evidence付きの共有System Map
        └── intents/<intent>/     Plan、State、成果物、Receipt、Sensor、Core Audit、Hook監査・health
```

System Mapの正本はJSONです。HTMLは人間から指示された場合だけ生成します。IntentのCurrent Contextは、使用したSystem Map revisionとSHA-256を固定参照します。

## 更新と旧State

```bash
./.codex/tools/aidlc update --harness codex --project .
./.codex/tools/aidlc doctor check .
```

Installerは、前回の記録と一致する管理対象だけを更新します。`aidlc/`内のWorkspaceや成果物は利用者所有で、Installerは削除しません。

pre-vNext形式のWorkflow Stateは自動変換しません。Doctorは`VNEXT_UNSUPPORTED_WORKFLOW_STATE`を返し、旧ファイルを保持します。新しいvNext IntentをBirthして再開してください。

## 開発

開発環境はGo 1.26.4です。外部Go moduleは使っていません。

```bash
git ls-files -z -- '*.go' ':(exclude)work/**' | xargs -0 gofmt -w
go vet ./...
go test -count=1 ./...
go test -race -count=1 ./...
go run ./cmd/aidlc-dev bundle write --out dist/project
go run ./cmd/aidlc-dev bundle check --out dist/project
go run ./cmd/aidlc-dev package-release --out build/github-release
```

`package-release`はローカルに公開候補を生成します。タグ作成やGitHub Release公開は別の明示的な作業です。

詳しい配布手順は[docs/release-packaging.md](docs/release-packaging.md)、1.0.0の変更点は[docs/aidlc-vnext-1.0.0-release-notes.md](docs/aidlc-vnext-1.0.0-release-notes.md)を参照してください。
