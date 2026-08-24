# AI-DLC vNext: v2資産回収Map

## 1. 目的

v2の32 Stageに含まれる知識、Artifact、Verifier、実行機構を棚卸しし、vNextへ
回収するものと、置き換えまたは削除するものを示す。

このMapは32 Stageを10 Stageへ1対1で移行する表ではない。vNextの目的を優先し、
統合、分割、置換、削除、新規作成を許可する。

## 2. 判断ルール

| 判断 | 意味 |
|---|---|
| 回収 | v2の知識、Artifact、Verifier、実行機構をvNextへ持ち込む |
| 統合 | 複数のv2 Stageの責務を1つのvNext Stageで扱う |
| 分割 | 1つのv2 Stageの責務を複数のvNext Stageへ分ける |
| 置換 | 目的だけを参考にし、Stage Contractと遷移は新しく作る |
| 削除 | 独立Stageまたはv2固有の手順としては残さない |
| 新規 | v2に十分な責務がなく、vNextで新しく設計する |

次の原則をすべての判断に適用する。

- vNextの10 Stageを変更せず、v2 Stageを残すためのStageは追加しない
- v2 Stage名、番号、Phase、StageごとのApproval Gateは引き継がない
- 有用な質問、Artifact、Sensor、Reviewer、testの知識はStageを越えて回収できる
- 対応先のないv2 Stageは削除できる
- v2にないvNext能力は新しく設計する
- このMapはM0のCoverage Mapであり、各Stageの詳細Contractを確定しない
- AIは回収Mapや自由回答から次のStageを決めない。Coreが固定Graphと検証規則から
  Stage Execution Planを管理する
- 小さな変更でもStage自体は消さず、Coreが根拠とEvidenceを確認して`reuse`または
  `not_applicable`として短く通過させる

## 3. vNext 10 Stageから見た回収概要

| vNext Stage | 主なv2 Source | 回収する知識 | 新しく設計する中心要素 |
|---|---|---|---|
| ST-00 Bootstrap | 0.1〜0.3、1.5 | Workspace、検出、State初期化、実行能力 | 権限、予算、再開位置をまとめた開始Contract |
| ST-01 Orient | 0.2、1.2、2.1、2.2 | Brownfield解析、外部調査、既存Practices | Intentに必要な深さだけ調べるCurrent／System Map |
| ST-02 Define Intent | 1.1、1.4 | Intent、目的、Scope、成功基準 | Design BriefとWorkspace Contextの事実、許容リスク、Alignment判断 |
| ST-03 Requirements & Constraints | 1.2、1.3、1.6、2.2〜2.5、3.2 | 要求、NFR、制約、Mockup、利用例 | 変更に必要な深さ、未確定事項、機械検証可能な期待結果 |
| ST-04 Architecture Decision | 1.3、2.6、3.3、3.4 | 設計Driver、Application／NFR／Infra設計 | 選択肢、Evidence、可逆性、Human escalation |
| ST-05 Build Contract | 1.4〜1.7、2.4〜2.8、3.1、3.3、3.4 | User Story、設計、Unit、Delivery Plan | 統合Design Contract、合格条件、Bolt Plan、Build authority |
| ST-06 Build & Converge | 2.7、2.8、3.5〜3.7、4.6 | Unit実行、生成、test、CI、性能検証 | AI内部loop、停滞検出、Checkpoint、Runnable Candidate |
| ST-07 Human Feedback & Approval | v2全StageのGate、1.7、4.7 | Human review、変更要求、Feedback | 実物評価、Feedback分類、Accepted Baseline昇格 |
| ST-08 Release | 3.7、4.1〜4.5 | Pipeline、環境、Deployment、監視、復旧 | 外部副作用に対するRelease authorityとrollback判断 |
| ST-09 Outcome Evaluation | 4.4〜4.7 | 観測、Incident、性能、改善 | Intentとの成果比較、Learning、次のDesign Brief |

## 4. v2 32 Stageの棚卸し

### 4.1 Initialization

| v2 | vNextでの候補 | 判断 | 回収内容 |
|---|---|---|---|
| 0.1 Workspace Scaffold | ST-00 | 回収＋統合 | idempotentなWorkspace／Intent領域作成を回収する |
| 0.2 Workspace Detection | ST-00、ST-01 | 分割 | 環境検出はST-00、Current理解はST-01へ分ける |
| 0.3 State Initialization | ST-00 | 機構回収＋Contract置換 | 原子的State／Plan初期化を使い、vNext Stateへ置き換える |

### 4.2 Ideation

| v2 | vNextでの候補 | 判断 | 回収内容 |
|---|---|---|---|
| 1.1 Intent Capture & Framing | ST-02 | 統合 | 目的、Stakeholder、質問の知識をIntent Definitionへ統合する |
| 1.2 Market Research | ST-01、ST-03 | 分割＋独立Stage削除 | 外部CurrentはST-01、制約EvidenceはST-03で必要時だけ扱う |
| 1.3 Feasibility & Constraints | ST-03、ST-04 | 分割 | 制約はST-03、技術判断とEvidenceはST-04へ分ける |
| 1.4 Scope Definition | ST-02、ST-05 | 分割 | Intentの範囲はST-02、Build／Boltの範囲はST-05へ分ける |
| 1.5 Team Formation | ST-00、ST-05 | 分割＋独立Stage削除 | 実行能力はST-00、委任境界はST-05で扱う |
| 1.6 Rough Mockups | ST-03、ST-05 | Artifact回収＋独立Stage削除 | 期待体験と受入例の入力Artifactとして必要時だけ使う |
| 1.7 Approval & Handoff | ST-05、ST-07 | 置換 | Build authorityはST-05、完成物ApprovalはST-07へ分離する |

### 4.3 Inception

| v2 | vNextでの候補 | 判断 | 回収内容 |
|---|---|---|---|
| 2.1 Reverse Engineering | ST-01 | 統合 | Repo解析、System Map、Brownfield Evidenceを回収する |
| 2.2 Practices Discovery | ST-01、ST-03 | 分割＋Gate削除 | 現行PracticesはST-01、守る制約はST-03へ分ける |
| 2.3 Requirements Analysis | ST-03 | 統合 | 機能要求、制約、未確定事項の分析を回収する |
| 2.4 User Stories | ST-03、ST-05 | 分割 | 利用者の振る舞いはST-03、受入例はST-05へ分ける |
| 2.5 Refined Mockups | ST-03、ST-05 | Artifact回収＋独立Stage削除 | 画面要求と確認シナリオの入力として回収する |
| 2.6 Application Design | ST-04 | 統合 | Application境界と構造判断をArchitecture Decisionへ統合する |
| 2.7 Units Generation | ST-05、ST-06 | 置換＋分割 | UnitのDAG知識をBolt PlanとBolt実行へ作り替える |
| 2.8 Delivery Planning | ST-05、ST-06 | 置換＋分割 | 依存、順序、Worktree計画をBuild Contractと実行へ分ける |

### 4.4 Construction

| v2 | vNextでの候補 | 判断 | 回収内容 |
|---|---|---|---|
| 3.1 Functional Design | ST-05 | 統合 | 実装可能な機能設計をDesign Contractへ統合する |
| 3.2 NFR Requirements | ST-03 | 統合 | NFRと測定条件をRequirements & Constraintsへ統合する |
| 3.3 NFR Design | ST-04、ST-05 | 分割 | NFR判断はST-04、Verifierと合格条件はST-05へ分ける |
| 3.4 Infrastructure Design | ST-04、ST-05 | 分割 | Infra判断はST-04、Build／Release条件はST-05へ分ける |
| 3.5 Code Generation | ST-06 | 機構回収＋遷移置換 | Agent実行、Worktree、EvidenceをConvergence loopで使う |
| 3.6 Build and Test | ST-06 | 統合 | build、test、failure evidenceをVerifierとして回収する |
| 3.7 CI Pipeline | ST-06、ST-08 | 分割 | Build検証はST-06、Release経路はST-08へ分ける |

### 4.5 Operation

| v2 | vNextでの候補 | 判断 | 回収内容 |
|---|---|---|---|
| 4.1 Deployment Pipeline | ST-08 | 統合 | Release手順、Gate、rollback情報を回収する |
| 4.2 Environment Provisioning | ST-08 | 統合 | 対象環境とprovisioning evidenceを必要時に扱う |
| 4.3 Deployment Execution | ST-08 | 統合 | 外部副作用を伴う実行と結果記録を回収する |
| 4.4 Observability Setup | ST-08、ST-09 | 分割 | 監視準備はST-08、観測結果はST-09へ分ける |
| 4.5 Incident Response | ST-08、ST-09 | Artifact回収＋独立Stage削除 | rollback準備とOutcome evidenceとして必要時に扱う |
| 4.6 Performance Validation | ST-06、ST-09 | 分割 | Release前VerifierはST-06、利用後結果はST-09へ分ける |
| 4.7 Feedback & Optimization | ST-07、ST-09 | 置換＋分割 | 実物FeedbackはST-07、成果改善はST-09へ分ける |

## 5. vNextで新規設計する能力

v2に部分的な類似機能があっても、次はvNextの意味として新しくContract化する。

| 新規能力 | 主なStage | v2だけでは不足する点 |
|---|---|---|
| Core管理のStage Execution Plan | 全Stage | v2のStage定義はあるが、AI提案とCoreの遷移権限が十分に分離されていない |
| Stage disposition | 全Stage | `execute`、`reuse`、`not_applicable`を根拠とEvidence付きで決定する共通Contractがない |
| Effective Policy | 全Stage | 組織、Space、TeamのMemoryとIntent固有リスクを優先順位付きで統合するContractがない |
| Design BriefからDesign ContractへのCo-Design | ST-02〜ST-05 | v2 ArtifactがStageごとに分散し、委任境界が一つに固定されない |
| Build authority | ST-05 | Stage完了承認と、AIへBuildを委任する判断が区別されない |
| AI内部Convergence loop | ST-06 | 実装、test、評価、修正の共通終了理由がない |
| 停滞、予算、矛盾、不可逆性による停止 | ST-06 | retryとHuman escalationの共通Contractがない |
| AI Checkpoint | ST-06 | AI内部の作業点と人間承認済みBaselineが分離されていない |
| Bolt PlanとCore scheduling | ST-05、ST-06 | AI提案をCoreがcoverage、DAG、受入条件、Verifierについて検査し、ready Boltだけを指示するContractがない |
| Runnable Candidate | ST-06 | 全Bolt統合後に人間が操作できる完成候補のContractがない |
| 実物Feedbackの分類と戻り先 | ST-07 | ST-03の要求とST-05の現行Contractを比較し、ST-03／04／05／06へ決定的に戻す規則がない |
| Accepted Baseline promotion | ST-07 | 人間承認後だけ成果物とDesign ContractをBaseline化する仕組みがない |
| 外部副作用に基づくRelease authority | ST-08 | Effective Policyと不可逆性から人間判断を決める共通規則がない |
| Outcome loop | ST-09 | 利用結果を次のDesign Brief／Intentへ接続する共通Contractがない |

ST-07では、FeedbackをST-03の要求・制約とST-05の現行Contractへ必ず比較する。
未変更の要求に違反する場合はST-06、要求変更はST-03、Architecture影響はST-04、
受入条件またはBolt Planへの影響はST-05へ戻す。ST-03へ戻った場合は、影響する
ST-04、ST-05、ST-06の成果物を失効または再評価する。規則で分類できない場合は
AIに戻り先を決めさせず、人間へ確認する。

## 6. M0で確定することと、確定しないこと

### M0で確定する

- v2 StageをvNextへ1対1対応させない
- v2のStage番号、Phase、Gate構造を残さない
- 回収候補と削除候補
- vNextで新規設計が必要な能力
- M1以降で詳細設計する順序

### M0では確定しない

- 各vNext Stageの最終的な入力、出力、schema
- Human Decisionの最終enum
- Convergence loopの試行回数、時間、費用
- Bolt PlanとBolt Contractの最終粒度
- 各v2 Artifactを実際に残すかどうか

これらは共通Stage Contractと各Stageの詳細設計で、人間の承認を得て確定する。
