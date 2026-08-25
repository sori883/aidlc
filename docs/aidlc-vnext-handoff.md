# AI-DLC vNext 引き継ぎ

## 1. この文書の目的

AI-DLC vNextの検討を別のエージェントへ引き継ぐ。

現時点では、vNextの思想、全体フロー、固定10 StageのID、名前、Graph、共通Contract、
Core Route、ST-00 Bootstrap、ST-01 Orient、ST-02 Define Intent、
ST-03 Requirements & Constraints、ST-04 Architecture Decision、
ST-05 Build Contract、ST-06 Build & Converge、ST-07 Human Feedback & Approval、
ST-08 Release、終端ST-09 Outcome Evaluationまで実装済みである。

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
| 実装状況 | M0〜M5の固定10 Stage本文を実装・検証済み |
| 次の作業 | M6全体計画は承認済み。`docs/aidlc-vnext-m6-policy-gates-plan.html`をレビューし、明示承認後にM6をTDD実装する |

M0〜M2はcommit `c9e259a`、ST-00はcommit `714d5bb`、ST-01はcommit `5a0ee9c`、
ST-02はcommit `98b8c41`として`origin/codex/aidlc-vnext`へpush済みである。
ST-03、ST-04、ST-05、ST-06、ST-07、ST-08、ST-09は作業ツリーで実装・検証済みだが、まだcommit／pushしていない。
作業ツリーにはユーザー所有の`.vscode/`、生成確認用`dist/codex/`、
`docs/aidlc-vnext-visual-guide.html`がある。一括削除や無関係な上書きをしないこと。

M1では、固定10 Stage ID、共通Stage Contract、Artifact Reference、AI Proposal、
Core Stage Decision、Stage Execution Planの型とfail-closed validatorを作成した。

M2では、固定Catalog／Graph、Effective Policy snapshot、Core Plan revision、
vNext State／Audit／Directive／Doctor／Intentを接続した。旧32 Stage、Scope Grid、
9 Scopeと旧Stage本文はRuntime、Codex配布、native配布、CLIから外した。
M3の最初の実装としてST-00 Bootstrapを追加した。`next`はCoreだけで5項目を検査し、
canonical Bootstrap Receiptを保存して固定GraphでST-01へ進む。

ST-01 Orientは二段階で動く。CoreがDesign Brief、Bootstrap Receipt、選択Repositoryから
Workspace ProfileとOrient Work Requestを作り、`next`は`work` Directiveを返す。AIは
System Map PatchとCurrent Context候補だけを提案する。Coreはschema、未知field、秘密情報、
ID、relation、Evidence path／SHA-256、Repository境界、accepted baseline、base revisionを
検証し、合格時だけ共有CodeKBのimmutable System Map revision、`baseline.json`、Intent配下の
`current-context.json`を保存して固定GraphでST-02へ進む。System Map HTMLは標準生成しない。

ST-02 Define Intentも二段階で動く。CoreがDesign Brief、Current Context、Effective Policyの
pathとSHA-256を固定した`define-intent-work-request.json`を作り、AIは目的、期待結果、対象、
対象外、成功の見方、未知事項だけを`intent-definition-proposal`として提案する。Coreは
未知field、秘密情報、範囲重複、入力hash、後続Stageの設計・遷移指定を拒否し、合格時だけ
Intent配下へcanonical `intent-definition.json`を保存して固定GraphでST-03へ進む。
標準HTMLは生成しない。価値判断が未解決ならAIが提案前に人間へ確認し、AIはRouteを選ばない。

ST-03 Requirements & Constraintsも二段階で動く。CoreがIntent Definition、Current Context、
Effective PolicyのpathとSHA-256を固定し、要求coverageを列挙した
`requirements-work-request.json`を作る。AIは安定IDとJSON Pointer根拠を持つ機能要求、品質要求、
制約、不変条件、未確定事項だけを提案する。Coreは未知field、秘密情報、重複ID、壊れた参照、
coverage不足、blocking question、古いWork Request、後続Stage内容とRoute指定を拒否する。
合格時だけIntent配下へimmutable Requirements revisionと`current.json`を保存し、固定Graphで
ST-04へ進む。Requirementsの正本はJSONだけで、HTML／Markdownは人間の指示時にだけ生成する。

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

承認済みST-00としてTDDを実施した。先に未実装module、旧`parked`、Bundle欠落を示す
REDを確認し、その後Contract、Receipt、Core executor、`advanced` Directive、Doctor、
Codex Harness、native配布を実装した。`bun run release:check`は24ファイル107 testが
すべて成功した。指定サンドボックスではPlan revision 2を維持したまま
`ST-00 advanced → ST-01 parked → Doctor healthy`を確認した。

承認済みST-01としてTDDを実施した。未実装moduleのREDから始め、ST-01 Contract、
Design Brief永続化、Workspace Profile、`work` Directive、System Map／Patch／baseline／
Current Context contract、厳格validator、immutable revision、resume／Doctor検証、Codex／
native配布を実装した。`bun run release:check`は25ファイル117 testがすべて成功した。
指定サンドボックスでは新しい試験Intentで
`ST-00 advanced → ST-01 work → Doctor healthy`を確認し、最後に元のactive Intentへ戻した。

承認済みST-02としてTDDを実施した。未実装moduleと中断復旧failureのREDから始め、
ST-02 Contract、Define Intent Work Request、Intent Definition Proposal／正本contract、
厳格validator、固定ST-03遷移、resume／Doctor検証、中断後の冪等再開、Codex／native配布を
実装した。`bun run release:check`は26ファイル125 testがすべて成功した。
指定サンドボックスへ生成済みCodex bundleを配置し、`intent-definition.json`だけが保存され、
`ST-03 parked → Doctor healthy`となることを確認した。

承認済みST-03としてTDDを実施した。未実装moduleのREDから始め、ST-03 Contract、
Requirements Work Request、Proposal／Definition／Current contract、安定ID、source JSON Pointer、
Intent coverage、immutable revision、固定ST-04遷移、resume／Doctor検証、中断後の冪等再開、
Codex／native配布を実装した。Codex SkillのProject pathも実行試験で修正し、
`bun run release:check`は27ファイル136 testがすべて成功した。指定サンドボックスでは
Requirements revision 1と`current.json`を保存し、`ST-04 parked → Doctor healthy`を確認した。
承認済みST-04としてTDDを実施した。未実装moduleのREDから始め、ST-04 Contract、
Architecture Work Request、Assessment Proposal／Decision／Current contract、`execute`／`reuse`／
`not_applicable`の相互排他、全Requirement coverage、現在entity参照、immutable revision、
人間承認付きreuse、Core Plan改訂、固定ST-05遷移、resume／Doctor検証、中断後の冪等再開、
Codex／native配布を実装した。`bun run release:check`は28ファイル145 testがすべて成功した。
指定サンドボックスでは構成影響なしをCoreが検証して`not_applicable`を記録し、
Plan revision 2、`ST-05 parked → Doctor healthy`を確認した。active Intentは試験用ST-05のままでよい。

承認済みST-05としてTDDを実施した。未実装moduleのREDから始め、ST-05 Contract、
Build Contract Work Request／Proposal／Candidate／Current、Requirement trace、command Verifier、
依存関係ベースのBolt DAG、Core導出Batch、`execute`／`reuse`／`not_applicable`、静的Review HTML、
候補SHA-256へ固定した人間Approval、`approval` Directive、固定ST-06遷移、resume／Doctor検証、
中断後の冪等再開、Codex／native配布を実装した。`bun run release:check`は29ファイル156 testが
すべて成功した。指定Sandboxでは既存ST-03確認Intentに製造対象がない候補を作り、Coreが検証した
CandidateとReview HTML、`approval` Directive、Doctor healthyを確認した。AIは人間承認を代行せず、
実際の承認後にPlan revision 3、固定ST-06遷移、Doctor healthyを確認した。この時点ではactive
IntentがST-06 parkedになった。候補SHA-256は
`sha256:28cc7f4162929533c2ff8bcd49f9acb076e459d326ef1c222d02c14eda95ddee`。

承認済みST-06としてTDDを実施した。未実装moduleのREDから始め、ST-06 Contract、厳格な
Build Session／Bolt Work Request／Attempt Checkpoint／Verifier Evidence／Runnable Candidate／
Build Current contract、Coreのready Bolt選択、Intent専用Git worktree、対象外diff拒否、
command／artifact／localhost runtime Verifier、同一failure signature 3回停止、複数Repository、
全Bolt後の統合検証、`execute`／厳格な`reuse`／決定的`not_applicable`、固定ST-07遷移、
resume／Doctor改ざん検知、CLI、Codex／native配布を実装した。ST-05 Review HTMLも、承認前に
正確な対象path、argv、cwd、timeout、終了条件を読めるよう補強した。指定Sandboxでは
製造対象なしをCoreが処理し、Build Current
`sha256:4d7c2ebedfe0ec9dafe6e23b725e004c2310e1ab77cde9606ace823026e1e3ee`、
Plan revision 4、固定ST-07遷移、Doctor healthyを確認した。active IntentはST-07 parkedである。
`bun run release:check`は30ファイル168 testがすべて成功し、Codex bundleと`dist/project`も
同期済みである。

承認済みST-07としてTDDを実施した。未実装moduleのREDから始め、ST-07 Contract、厳格な
Review Manifest／Human Decision／Accepted Candidate／Feedback Current contract、escaped静的Review
HTML、人間確認項目の全件合格、候補と上流正本へのSHA-256固定、4種類の固定Feedback経路、
最も手前のStageを選ぶ決定規則、却下候補のimmutable保存、承認後だけのSystem Map source revision
昇格、resume／Doctor改ざん検知、CLI、Codex／native配布を実装した。`candidate_defect`では、
却下候補を開始点としてST-06の新しいcycleとattempt 2を作り、修正版を別のReview Manifestで
再確認・承認できるところまで接続した。`bun run release:check`は31ファイル178 testがすべて
成功した。指定SandboxではST-06の製造対象なしを根拠にST-07も決定的に通過し、Plan revision 5、
固定ST-08遷移、Doctor healthyを確認した。active IntentはST-08 parkedである。

承認済みST-08としてTDDを実施した。厳格なCapability Snapshot／Work Request／Release Plan／
Human Release Authority／Step Receipt／Release Receipt／Release Current／Deployment Map contract、
escaped Release確認HTML、初期Git Source昇格adapter、人間承認と実行の分離、実行直前Target drift検知、
複数Repository途中失敗時の逆順rollback、Deployment Mapのimmutable revision、resume／Doctor改ざん検知、
厳格なRelease reuse検証、CLI、Codex／native配布を実装した。`bun test`は32ファイル187 testがすべて成功した。指定Sandboxでは
Accepted Candidateなしを根拠にST-08を決定的に通過し、Plan revision 6、固定ST-09遷移、Doctor healthyを
確認した。このST-08実装時点ではactive IntentをST-09 parkedに置き、ST-09本文へは進めなかった。

承認済みST-09としてTDDを実施した。固定signal付きOutcome Work Request、Project-bound Outcome
Evidence、4値のOutcome Evaluation、JSON正本から生成するescaped HTML、全件達成時だけの自動完了、
未達・一部達成・判断不能に対する三つの人間判断、not_before／deadline付きparkと再開、Follow-up Brief
案、terminal Outcome Current、State completed／`done`、resume／Doctor改ざん検知、CLI、Codex／native配布を
実装した。ST-09から過去Stageへのedgeと自動新Intent作成は追加していない。`bun run release:check`は
33ファイル193 testがすべて成功し、Codex bundleと`dist/project`も同期済みである。指定Sandboxでは
ST-09 Work Request revision 1を生成し、Doctor healthyを確認した。active IntentはST-09でEvidence提案待ちである。

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
- `docs/aidlc-vnext-st00-plan.html`
  - 承認済みST-00詳細設計とTDD実装計画
- `docs/aidlc-vnext-st00-result.html`
  - ST-00実装、Core境界、Receipt、試験結果の初心者向け図解
- `docs/aidlc-vnext-st01-plan.html`
  - 承認済みST-01詳細設計。累積観測Map、CodeKB配置、固定Current Context、JSON-only方針
- `docs/aidlc-vnext-st01-result.html`
  - ST-01実装、validator、保存先、試験結果の初心者向け図解
- `docs/aidlc-vnext-st02-plan.html`
  - 承認済みST-02詳細設計。Define Intentの責務、人間確認境界、JSON-only方針
- `docs/aidlc-vnext-st02-result.html`
  - ST-02実装、厳格validator、固定遷移、中断復旧、試験結果の初心者向け図解
- `docs/aidlc-vnext-st03-plan.html`
  - 承認済みST-03詳細設計。要求の5分類、根拠参照、immutable revision、JSON-only方針
- `docs/aidlc-vnext-st03-result.html`
  - ST-03実装、coverage validator、固定遷移、中断復旧、試験結果の初心者向け図解
- `docs/aidlc-vnext-st04-plan.html`
  - 承認済みST-04詳細設計。3つの処理方法、現在像と将来案の分離、人間判断境界
- `docs/aidlc-vnext-st04-result.html`
  - ST-04実装、3方式validator、Core Plan改訂、固定遷移、試験結果の初心者向け図解
- `docs/aidlc-vnext-st05-plan.html`
  - 承認済みST-05詳細設計。Build Contract、Bolt DAG、Verifier、人間承認境界
- `docs/aidlc-vnext-st05-result.html`
  - ST-05実装、Core導出Batch、Approval Directive、固定遷移、試験結果の初心者向け図解
- `docs/aidlc-vnext-st06-plan.html`
  - 承認済みST-06詳細設計。Bolt実行、Git worktree、Verifier、収束停止条件
- `docs/aidlc-vnext-st06-result.html`
  - ST-06実装、Runnable Candidate、再試行、固定ST-07遷移、試験結果の初心者向け図解
- `docs/aidlc-vnext-st07-plan.html`
  - 承認済みST-07詳細設計。人間Review、Approval、4種類の固定Feedback経路
- `docs/aidlc-vnext-st07-result.html`
  - ST-07実装、差戻し再製造、Accepted Candidate、固定ST-08遷移、試験結果の初心者向け図解
- `docs/aidlc-vnext-st08-plan.html`
  - 承認済みST-08詳細設計。Release Target、Capability、Authority、Receipt、rollback、Deployment Map
- `docs/aidlc-vnext-st08-result.html`
  - ST-08実装、Git Source昇格、rollback、Deployment Map、固定ST-09遷移の初心者向け図解
- `docs/aidlc-vnext-st09-plan.html`
  - 承認済みST-09実装前設計。成功条件とOutcomeの比較、観測待ち、人間判断、Intent完了条件
- `docs/aidlc-vnext-st09-result.html`
  - ST-09実装、Outcome評価、観測待ち、人間判断、Intent終端、試験結果の初心者向け図解
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
- `core/tools/aidlc-vnext-bootstrap.ts`
- `core/tools/aidlc-vnext-orient-contract.ts`
- `core/tools/aidlc-vnext-orient.ts`
- `core/tools/aidlc-vnext-define-intent-contract.ts`
- `core/tools/aidlc-vnext-define-intent.ts`
- `core/tools/aidlc-vnext-requirements-contract.ts`
- `core/tools/aidlc-vnext-requirements.ts`
- `core/aidlc-common/stages/st-00-bootstrap.json`
- `core/aidlc-common/stages/st-01-orient.json`
- `core/aidlc-common/stages/st-02-define-intent.json`
- `core/aidlc-common/stages/st-03-requirements-constraints.json`
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
- ST-02 Define Intent
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

ST-05のBuild ContractとApproval境界、ST-06のBolt実行とRunnable Candidate境界、ST-07の
Human FeedbackとAccepted Candidate境界、ST-08のRelease Authorityと外部作用境界、ST-09の
Outcome観測とIntent終端境界は確定済みである。次は固定10 Stage全体を一つの製品として扱い、
E2E、UX、運用性、性能、配布品質に関する人間判断を共同設計する。

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
3. マイルストーンを完成仕様として扱わず、次にM6の品質Gate設計計画を提示する
4. 一度に10 Stageを設計せず、一つのStageまたは一つの横断Contractずつ進める
5. M1共通Contract、M2 Core Route、ST-00〜ST-09の実装を前提にし、小変更、依存機能、Release、
   Outcomeを含む代表E2Eと運用上の停止・再開をユーザーと確定する
6. 各設計を`docs/`へ保存し、ユーザーの明示的承認後にTypeScript実装へ進む
7. 実装中もStageごとに結果とtestを説明する

## 9. 次に提案する設計セッション

次のエージェントは、いきなり最適化や配布変更を始めず、まず次をユーザーへ提示する。

**テーマ: M6 E2E、UX、運用性、性能、品質Gateの詳細設計**

- 小さな文字変更、依存関係を持つ機能追加、Release、Outcomeの代表E2E
- 中断、再開、差戻し、外部drift、改ざん時の運用手順
- 初心者がDirective、HTML、JSON成果物を迷わず扱えるUX
- 大規模Repositoryや複数Repositoryで計測する性能指標
- Release候補に要求する品質Gateと残課題

設計を初心者向けHTMLで説明し、ユーザーの明示的承認後にM6だけを実装する。
AIは行き先を決めず、M2の固定GraphとCore Directiveを使う。
