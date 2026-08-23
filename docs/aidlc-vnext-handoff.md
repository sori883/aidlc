# AI-DLC vNext 引き継ぎ

## 1. この文書の目的

AI-DLC vNextの検討を別のエージェントへ引き継ぐ。

現時点では、vNextの思想、全体フロー、マイルストーンのドラフトまで存在する。
各Stageの詳細設計は完成していない。固定10 StageのID、名前、GraphはM2で確定したが、
マイルストーンや可視化に書かれた短い説明をStage本文として実装してはならない。

各Stageの目的、入力、出力、完了条件、AIの停止条件、人間の判断境界を、
ユーザーと一つずつ共同設計し、明示的な承認後に実装すること。

## 2. ユーザーの意図

- 完成形はvNextだけとし、v2 Workflowとの併存、選択、移行機能は作らない
- v2のWorkspace、State、Audit、Loader、Orchestrator、Doctor、Installer、Harnessなど、
  実績のある実行エンジンは回収してvNextの土台にしたい
- v2の32 Stage、Scope Grid、Stage遷移の意味はvNextの10 Stageへ置き換えたい
- vNextはv2より軽量にし、人間の確認や承認を必要な境界へ絞りたい
- 人間が最初に設計のたたき台を渡し、人間とAIで設計を具体化したい
- 設計が揃った後は、AIが実装、テスト、評価、修正を自律的に反復してほしい
- 人間は文章だけでなく、操作可能な完成物へFeedbackを返したい
- Feedbackの結果として、最終的なApprovalも残したい
- 全Boltごとに人間Gateを置くのではなく、統合されたRunnable Candidateを
  人間が確認する形を基本にしたい
- AIへ次のStageや自由な遷移を決めさせず、固定GraphとCore Directiveで進行を制御したい
- 小さな変更は重い資料を作らず、根拠を残して各Stageを短く通過できるようにしたい
- 各Stageの詳細は、今後ユーザーと人間判断を交えながら共同設計したい

## 3. 現在のGit状態

| 項目 | 状態 |
|---|---|
| Repository | `/Users/const/sori883/aidlc` |
| Branch | `codex/aidlc-vnext` |
| Base | `origin/main` |
| Base commit | `cb4f0db61fca711c3b49251370568f3013148f41` |
| 実装状況 | M0、M1、M2完了。Runtimeと配布経路はvNextのみ |
| 次のマイルストーン | M3。ST-00から1 Stageずつ詳細設計する |

作業ツリーにはM0〜M2の実装、文書、生成配布物と、ユーザー所有の`.vscode/`、
`docs/aidlc-vnext-visual-guide.html`がある。一括削除や無関係な上書きをしないこと。

M1では、固定10 Stage ID、共通Stage Contract、Artifact Reference、AI Proposal、
Core Stage Decision、Stage Execution Planの型とfail-closed validatorを作成した。

M2では、固定Catalog／Graph、Effective Policy snapshot、Core Plan revision、
vNext State／Audit／Directive／Doctor／Intentを接続した。旧32 Stage、Scope Grid、
9 Scopeと旧Stage本文はRuntime、Codex配布、native配布、CLIから外した。
Stage本文はまだ存在せず、`next`はST-00で`parked`を返す。

承認済みM0として`bun run release:check`を実行し、
version、typecheck、32 Stage Graph、46文書のRuntime Contract、45ファイル243 testが
すべて成功した。この結果は`docs/aidlc-vnext-v2-baseline.md`へ記録した。

承認済みM1として、対象test 18件、TypeScript typecheck、`bun run release:check`を実行した。
version、typecheck、現行32 Stage Graph、46文書のRuntime Contract、46ファイル261 testが
すべて成功した。M1結果は`docs/aidlc-vnext-m1-result.html`へ記録した。

承認済みM2として、`bun run release:check`を実行し、version、typecheck、固定10 Stage
Graph、23ファイル96 testがすべて成功した。Codex bundle、native binary、Installerも
vNext経路で検証した。指定サンドボックス`07.ai-dlc-make-test3`では、AI Proposalを
Core Plan revision 2へ確定し、ST-00の`parked`とDoctor healthyを確認した。

## 4. 参照資料

### リポジトリ内

- `docs/aidlc-vnext-milestones.md`
  - M0〜M7の進行案
  - 詳細仕様ではなく、議論の順番と完了条件のドラフトとして扱う
- `docs/aidlc-vnext-v2-baseline.md`
  - vNextへ回収するv2実行機構を判断するための検証結果
- `docs/aidlc-vnext-v2-recovery-map.md`
  - 32 Stageを1対1対応させず、回収、統合、分割、置換、削除、新規作成を判断するMap
- `docs/aidlc-vnext-m0-boundaries.md`
  - 原則維持、変更、置換、最終削除する実装境界
- `docs/aidlc-vnext-m0-result.html`
  - M0結果の初心者向け図解
- `docs/aidlc-vnext-ai-control-guide.html`
  - AI、Core、人間の進行権限と、小さな変更の通過方法を説明する図解
- `docs/aidlc-vnext-m1-plan.html`
  - M1の実装範囲、非対象、承認Gateを説明する初心者向け計画
- `docs/aidlc-vnext-stage-contract.md`
  - M1共通Contractのfield、所有権、fail-closed規則、M2接続境界
- `docs/aidlc-vnext-m1-result.html`
  - M1実装と検証結果の初心者向け図解
- `docs/aidlc-vnext-m2-implementation-plan.html`
  - 承認済みM2実装計画
- `docs/aidlc-vnext-m2-result.html`
  - M2実装とサンドボックス検証結果の初心者向け図解
- `docs/aidlc-vnext-visual-guide.html`
  - 未追跡ファイル。所有者とcommit可否を確認するまで変更しない
- `docs/aidlc-v2-harness-architecture.md`
  - v2のDomain Core／Harness Contract／Codex Adapterの責務境界
- `docs/aidlc-v2-upstream-baseline.md`
  - v2準拠動作とGolden Trace
- `core/aidlc-common/data/vnext-stage-catalog.json`
- `core/aidlc-common/data/vnext-stage-graph.json`
- `core/tools/aidlc-core-route.ts`
- `core/tools/aidlc-effective-policy.ts`
- `core/tools/aidlc-vnext-state.ts`
- `core/tools/aidlc-vnext-orchestrate.ts`
- `harness/codex/skills/aidlc/SKILL.md`

### リポジトリ外の設計可視化

`/Users/const/sori883/obsidian/contents/10.PJ/02.RDNova/01.AIでの開発解消に向けて/sp4/vNext設計/AI-DLC-vNext設計.html`

このHTMLで表現されている内容も設計ドラフトであり、Stage Contractの確定仕様ではない。

## 5. 現時点で合意に近い全体方針

以下は方向性としてユーザーと確認済み。ただし、実装schemaや個別Stageの詳細は未確定。

### 5.0 v2の扱い

- Release後に利用できるWorkflowはvNextだけとする
- v2とvNextを選択するWorkflow version selectorは実装しない
- 進行中v2 Intentの継続、自動移行、互換読み込みは要件に含めない
- v2から回収するのはStage内容ではなく、Workspace、State、Audit、Loader、
  Orchestrator、Doctor、Installer、Codex Harnessなどの実行機構とする
- 回収した機構も、vNext Contractに合わない部分は変更または削除する

### 5.1 10 Stageの大枠

- ST-00 Bootstrap
- ST-01 Orient
- ST-02 Frame Intent
- ST-03 Requirements & Constraints
- ST-04 Architecture Decision
- ST-05 Build Contract
- ST-06 Build & Converge
- ST-07 Human Feedback & Approval
- ST-08 Release
- ST-09 Outcome Evaluation

### 5.2 進行権限と入力

- 10 StageのCatalogとGraphは固定し、CoreがStage Execution Planを管理する
- AIはStageを追加、削除、選択、スキップしたり、State／Auditへ遷移を直接記録しない
- AIは各Stageで必要な成果物と、`execute`、`reuse`、`not_applicable`の候補を
  根拠付きで提案できる
- Coreは固定規則で候補を検証して決定する。判断不能時はfail closedで人間へ戻す
- Work Typeを必須入力またはRoute軸にしない。将来必要なら、Routingに使わない
  派生tagとしてのみ検討する
- Lightweight／Enterpriseの二値Profileを設けない。組織、Space、TeamのMemoryと
  Intent固有リスクからEffective Policyを導出する
- 画面、技術レイヤーなどの固定Slice Strategyを設けない
- Intent開始時の主要入力はDesign Brief、Workspace Context、Effective Policyとする

### 5.3 Boltと反復の大枠

- AI内部loop
- Bolt loop
- Outcome loop

AI内部のCheckpointと、人間承認後のAccepted Baselineは分離する。
ST-07はデフォルトでBolt loopの外側に置く。

ST-05でAIは、要求、Architecture、依存関係、受入条件からBolt Planを提案する。
Coreはschema、要求coverage、DAG、受入条件、Verifier、統合条件を検査し、人間が
Build Contractを承認する。ST-06ではCoreがreadyなBoltを指定し、AIは指定された
Bolt内の実装方法だけを選ぶ。

### 5.4 小さな変更の扱い

固定10 Stageは、10個の重い資料を常に新規作成するという意味ではない。
Coreは各Stageを必ずチェックし、次のいずれかを根拠とEvidence付きで記録する。

- `execute`: 新しい調査、設計、実装、判断が必要
- `reuse`: 既存Artifactまたは既存判断をそのまま使用
- `not_applicable`: 今回のIntentに該当しない

例えば表示文字だけの変更では、ST-01は対象箇所の確認、ST-02は目的の短文確定、
ST-03は変更前後と非変更範囲の受入条件、ST-04は既存構成の再利用として短く処理できる。
AIは短縮を提案できるが、採用と記録はCoreが行う。

### 5.5 ST-07とST-03の整合性

ST-07はFeedbackをST-03の要求・制約とST-05の現行Contractへ必ず比較する。

- 未変更の要求にCandidateが違反する: defectとしてST-06へ戻す
- 人間が要求を変更する: ST-03へ戻し、影響するST-04、ST-05、ST-06を失効または再評価する
- Architectureへの影響がある: ST-04へ戻す
- 受入条件またはBolt Planへの影響がある: ST-05へ戻す
- 規則で分類できない: AIに戻り先を決めさせず、人間へ確認する

## 6. 人間の判断が必要になる想定箇所

### 6.1 vNextを利用する人間の判断

| 境界 | 人間が判断すること | AIが先に行うこと |
|---|---|---|
| Design Brief | 目的、期待する体験、譲れない制約 | 情報整理、矛盾・不足の検出 |
| Co-Design／ST-05 | Design ContractとBolt Planが人間の意図と合っているか | 要求、制約、受入例、合格条件、依存関係へ具体化 |
| ST-06例外 | 仕様矛盾、収束不能、予算超過、不可逆変更、リスク受容 | 修正試行、Evidence収集、選択肢提示 |
| ST-07 | 実物へのFeedbackと最終Approval | Runnable Candidate、確認シナリオ、既知制約の提示 |
| ST-08 | 外部環境へReleaseしてよいか | 検証、影響範囲、rollback情報の提示 |
| ST-09 | 継続、終了、次の投資・Intent | OutcomeとDesign Contractの比較 |

通常のBolt提案、実装、テスト、評価、修正はAIが行う。ただしStage遷移、
Stage disposition、ready Boltの選択はCoreが行う。人間へ戻す条件は、
AIが情報を持っていないことではなく、価値判断、権限、不可逆性、リスク受容が
必要な場合として設計する。

### 6.2 vNext自体を設計するために必要な人間判断

次はまだ確定していない。該当マイルストーンの実装前に、ユーザーと決めること。

1. 各Stageの責務境界と、隣接Stageへ渡すArtifact
2. Design BriefとDesign Contractの必須項目
3. Co-Design完了時の「確認」と「Approval」の意味
4. AI内部loopの評価器、改善停滞、試行回数、時間、費用の停止条件
5. Boltの粒度、依存関係、統合完了の定義
6. Runnable Candidateが満たすべき起動性、データ、確認シナリオ
7. ST-08で人間Approvalを要求する外部副作用の境界

## 7. 各Stageで共同設計する項目

Stageごとに、最低限次をユーザーと確認する。名前と一行説明だけで実装を開始しない。

1. **目的**: このStageが存在する理由
2. **開始条件**: 何が揃ったら開始できるか
3. **入力**: 必須／任意ArtifactとSource of Truth
4. **AIの作業**: 分析、生成、Verifier、Reviewer、反復
5. **出力**: Artifact名、schema、保存場所、version
6. **完了条件**: 機械判定できる条件と、人間判断が必要な条件
7. **失敗・停止条件**: retry、戻り先、escalation、budget
8. **人間境界**: 質問、Feedback、Approval、Release authority
9. **State／Audit**: 永続化する状態とEvent
10. **Harness表示**: Codexで人間に何を見せるか
11. **Stage disposition**: `execute`、`reuse`、`not_applicable`の根拠とEvidence
12. **Effective Policy**: このStageに適用する組織・Project・Team規則とIntent固有リスク
13. **Test**: unit、contract、resume、failure、E2Eの期待値

## 8. 次のエージェントの進め方

1. ルート`AGENTS.md`を読み、実装前承認とBun／TypeScript要件に従う
2. `work/`はユーザーの明示指示がない限り読まない
3. マイルストーンを完成仕様として扱わず、最初にST-00の詳細設計計画を提示する
4. 一度に10 Stageを設計せず、一つのStageまたは一つの横断Contractずつ進める
5. M1共通ContractとM2 Core Routeを前提にし、ST-00から順に目的、入出力、
   完了条件、人間境界をユーザーと確定する
7. 各設計を`docs/`へ保存し、ユーザーの明示的承認後にTypeScript実装へ進む
8. 実装中もStageごとに結果とtestを説明する

## 9. 次に提案する最初の設計セッション

次のエージェントは、いきなりLoaderやStage定義を変更しないこと。まず次をユーザーへ提示する。

**テーマ: ST-00 Bootstrapの詳細設計**

- ST-00が確認する実行環境とWorkspace条件
- 必須入力と、再利用できるEvidence
- `execute`、`reuse`、`not_applicable`のStage固有規則
- ST-01へ渡すArtifactと完了条件
- AIが止まる条件と、人間判断が必要な例外
- State／Audit EventとCodex表示
- unit、contract、resume、failure、E2E test

設計を初心者向けHTMLで説明し、ユーザーの明示的承認後にST-00だけを実装する。
AIは行き先を決めず、M2の固定GraphとCore Directiveを使う。
