# AI-DLC vNext M0: 実装回収・変更境界

## 1. 目的

v2の実装をすべて作り直さず、vNextで再利用する実行機構と、Workflowの意味を
置き換える場所を分離する。完成形のRuntimeはvNextだけを実行する。

## 2. 境界の判断

| 区分 | M0での意味 |
|---|---|
| 原則維持 | Workflowの意味に依存せず、vNextでも同じ責務を持つ |
| 拡張・変更 | 実装機構を回収するが、vNext Stateや遷移に合わせて変更する |
| 置換 | v2 Workflow固有の意味を持つため、vNext Contractへ作り替える |
| 最終削除 | vNextの代替が完成したあと、v2専用資産を削除する |

「原則維持」は無変更を保証しない。vNextのtestを通すための型や接続変更は許可する。

## 3. 原則維持する基盤

| 領域 | 主なpath | 回収する性質 |
|---|---|---|
| Bun／TypeScript基盤 | package.json、bun.lock、tsconfig.json | 開発、typecheck、test、native build |
| Runtime path解決 | core/tools/aidlc-runtime-paths.ts | source／bundle／nativeで同じ資産を解決する |
| CLI contract | core/tools/aidlc-cli-contract.ts、core/tools/contracts/ | CLIと文書のdriftを検出する |
| Workspace lock | core/tools/aidlc-workspace-lock.ts | State／Audit更新を直列化する |
| Workspace／Space | core/tools/aidlc-workspace*.ts、core/tools/aidlc-space.ts | project非依存のWorkspaceとSpace管理 |
| Intent identity | core/tools/aidlc-intent.ts | UUID、record directory、active Intent管理 |
| Harness境界 | core/tools/aidlc-harness-contract.ts、harness/registry.ts | CoreとCodex Adapterの責務分離 |
| Codex layout | harness/codex/aidlc-harness.ts | Codexのcapabilityと配置規約 |
| 配布 | installer/、core/tools/aidlc-distribution-contract.ts | 安全なinstall／updateとmanifest |
| Binary build | scripts/build-binaries.ts | Bun runtimeを含むnative binary生成 |
| Git Worktree | core/tools/aidlc-worktree.ts | 隔離した変更、検証、merge、失敗時保存 |
| Clone別Audit shard | core/tools/aidlc-audit.tsのfile／lock機構 | sequenceを持つappend-only記録 |

## 4. 拡張・変更するCore

| 領域 | 主なpath | vNextで必要な変更 |
|---|---|---|
| Stage Contract Loader | core/tools/aidlc-stage-loader.ts | 10 Stage共通Contractを型検証する |
| Graph／Route | core/tools/aidlc-graph.ts | 32 Stage＋Scope Gridを固定10 Stage Graphへ変更し、Core以外の遷移決定を拒否する |
| Scope解決 | core/tools/aidlc-scope-loader.ts | 9 ScopeのRoute選択を廃止し、再利用可能部分だけをEffective Policy／Context解決へ移す |
| Intent開始 | core/tools/aidlc-intent.ts | vNextのDesign Brief、所属Space、Workspace Contextを受け取る |
| State／Plan | core/tools/aidlc-state.ts | Stage Execution Plan、disposition、Checkpoint、Human待ち、Bolt、Baseline、resume cursorを保持する |
| Audit event | core/tools/aidlc-audit.ts | Stage判定根拠、loop、Checkpoint、Feedback、Baseline、Release、Outcome eventを追加する |
| Artifact | core/tools/aidlc-artifacts.ts | schema version、Source of Truth、Bolt／Candidate／Baseline参照を扱う |
| Directive | core/tools/aidlc-directive.ts | Coreが選んだStage、Bolt、Human Decision、Release authorityを表し、AIの自由遷移を受け付けない |
| Executor | core/tools/aidlc-executor.ts | Verifier／Reviewer／retryを共通loop policyへ接続する |
| Orchestrator | core/tools/aidlc-orchestrate.ts | Core Route、Stage disposition、ready Bolt scheduling、例外停止を実行する |
| Doctor | core/tools/aidlc-doctor.ts | vNext State／Plan／Audit／Stage判定／Bolt整合性を診断する |
| Sensor | core/tools/aidlc-sensor*.ts | vNext ArtifactとVerifier evidenceへ適用する |
| Rule／Memory | core/tools/aidlc-rule-loader.ts、core/tools/aidlc-memory.ts | 組織、Space、TeamのMemoryとIntent固有リスクからEffective Policyを導出する |
| Runner生成 | core/tools/aidlc-runner-gen.ts | Core Directiveに従う10 StageのCodex entry pointを生成する |
| Bundle／Contract | core/tools/aidlc-codex-bundle.ts、core/tools/aidlc-runtime-contract.ts | vNext資産だけを配布し、参照driftを検査する |
| Project layout | core/tools/aidlc-project-layout.ts | vNext dataとArtifact directoryを配置する |

## 5. 置き換えるWorkflow資産

| v2資産 | path | vNextでの置換先 |
|---|---|---|
| 32 Stage Catalog | core/aidlc-common/data/stage-catalog.json | 10 Stage Catalog |
| 32 Stage Graph | core/aidlc-common/data/stage-graph.json | 10 Stageとloop returnを持つGraph／Route |
| Scope Grid | core/aidlc-common/data/scope-grid.json | 廃止し、Effective Policy ContractとStage applicability規則へ置換 |
| 32 Stage本文 | core/aidlc-common/stages/ | ST-00〜ST-09のStage Contract |
| 9 Scope定義 | core/scopes/ | 直接の置換先を作らず、必要な規則だけをContext／Policyへ回収 |
| Stage Protocol | core/aidlc-common/protocols/stage-protocol.md | vNext共通Stage Protocol |
| Phase Memory | core/memory/phases/ | vNext Stage／loopに沿うMemory context |
| Stage生成Skill | harness/codex/skills/aidlc/と生成物 | vNext lifecycle／question／feedback rendering |
| Agent割当 | core/agents/ | 10 Stage Contractに基づくlead／support／reviewer |
| Scope／Stage prior | core/tools/data/ars-priors.json | 決定的なStage disposition規則へ回収するか、不要なら廃止 |

## 6. v2 Boltから回収するもの

v2 Construction Boltの名前と実行機構は回収するが、Workflow上の意味は
vNext Boltとして再定義する。

vNext Boltは、利用価値または検証価値を前進させる、独立して実装・検証可能な
最小の増分とする。Database、API、Backend、Frontend、testを一つのBoltに
またがって含められ、画面や技術レイヤーへ固定分割しない。

### 回収する機構

- Unit／Bolt依存関係のDAG検証
- ready判定とtopological batch
- Worktreeの作成、検証、merge、失敗時保存
- attempt、failure、resumeの永続化
- 並列実行後に成功結果を保持する考え方
- Audit-first mutation

### 置き換える意味

- walking skeleton後のautonomy選択
- BoltごとのApproval Gate
- v2 Construction Stageを各Boltで反復する順序
- v2 Stage名と密結合したBOLT_STARTED、BOLT_COMPLETEDの状態
- Delivery Planningのbolt-plan.mdをSource of TruthとするContract

### vNextでの置換方針

| v2 | vNext |
|---|---|
| Unit／Bolt | vNext Bolt |
| Bolt Plan | ST-05のBuild Contractに含むBolt Plan＋DAG |
| Bolt attempt | Bolt attempt＋AI loop attempt |
| Bolt completion | VerifierによるBolt acceptance |
| Bolt Worktree | Bolt execution workspace |
| 全Bolt完了 | Runnable Candidate integration ready |

この置換の詳細はST-05とST-06の設計時に確定する。

## 7. 最終削除する資産

次は代替となるvNext testとRuntimeが完成したあとに削除する。

- v2の32 Stage definitionとcompiled Graph
- v2 Scope Gridと9 Scope runner
- Stageごとの標準Approval Gateを強制するProtocol
- v2固有のPhase／Stage名を前提にしたState fields
- v2 Construction Boltのlifecycle分岐
- v2 Stage／Scopeから生成されたCodex Skill
- v2専用のGolden TraceとE2E scenario
- v2 Workflowを開始または継続するCLI／Doctor分岐

削除をM1で一括実行しない。代替機能がtestで証明された単位から段階的に外し、M7で
配布物にv2 Workflowが残っていないことを検証する。

## 8. testの扱い

### 維持・適応するtest

- Workspace、Space、Intent identity
- Workspace lockとAudit ordering
- Installer、Distribution、native binary
- Harness ContractとCodex layout
- Worktree isolationとmerge
- fail closed、atomic write、Doctor repair boundary

### vNext testへ置き換えるtest

- 32 Stage GraphとScope Grid
- v2 Stage Loader
- StageごとのApproval lifecycle
- v2 Unit／Bolt進行
- 9 Scope E2E
- v2 Stage Skill生成

test数243件を固定目標にはしない。v2 testを削除する前に、回収する性質を証明する
vNext testが存在することを条件にする。

## 9. 実装順序

M0で回収境界を決め、M1で共通Stage ContractとRuntimeの共通型を作る。
M2で10 Stage、Core Route、Stage disposition、Effective Policyへ定義を置き換え、
M3以降でStageを実装する。
M7でv2 Workflow資産を削除し、vNextだけをReleaseする。

## 10. M1へ渡す変更候補

M1では、まず次を詳細設計の対象にする。

1. 共通Stage Contractの型とvalidator
2. Artifact versionとSource of Truth
3. `execute`、`reuse`、`not_applicable`と決定根拠のContract
4. Stage Execution PlanとCore Directiveの権限境界
5. Human DecisionとAI loop終了理由
6. State／Audit eventの共通envelope
7. Loader、State、Plan、Doctorが共有するvNext Runtime Contract

具体的なTypeScriptファイルとschemaは、この設計をユーザーが承認した後に確定する。
