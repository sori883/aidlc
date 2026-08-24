# AI-DLC vNext 実装マイルストーン

## 1. 目的

既存のAI-DLC v2実装から実行エンジンを回収しながら、10 StageとAI中心の反復モデルを持つ
AI-DLC vNextへ置き換える。

v2の実績がある基盤機能は再利用し、Workflowの意味、Stage構成、人間とAIの境界を
vNextとして再定義する。完成形ではv2 Workflowを残さず、vNextだけを提供する。

## 2. vNextで固定する設計方針

- JavaScriptランタイムとパッケージマネージャーはBunを使用する
- 実装言語はTypeScriptとする
- 最初に対応するHarnessはCodexとする
- vNextは次の10 Stageで構成する
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
- Stage Catalogと遷移GraphはCoreが所有し、AIはStageを追加、削除、選択、
  スキップしない
- 各Stageは`execute`、`reuse`、`not_applicable`のいずれかで処理する。
  AIは根拠を添えて候補を提案できるが、Coreが規則で決定し、判断不能時は人間へ戻す
- Work Typeを必須入力やRoute軸にしない。必要な作業はDesign Briefと
  Workspace Contextの事実から決める
- Lightweight／Enterpriseの二値Profileを設けない。組織、Space、TeamのMemoryと
  Intent固有リスクからEffective Policyを導出する
- 画面、技術レイヤーなどの固定Slice Strategyを設けない。ST-05で要求、Architecture、
  依存関係、受入条件からBolt Planを作る
- 人間が関与する主要境界はCo-Design、完成候補へのFeedback & Approval、
  不可逆・高リスク・収束不能などの例外判断とする
- ST-07はデフォルトではBoltごとに実行せず、全Boltを統合した
  Runnable Candidateに対して実行する
- AI内部loop、Bolt loop、Outcome loopをStateとAuditから再開可能にする
- AI内部のCheckpointと、人間承認後のAccepted Baselineを分離する
- v2とvNextを選択するWorkflow version selectorは実装しない
- 進行中v2 Intentの継続、自動移行、互換読み込みは要件に含めない

## 3. v2から回収する範囲

| 分類 | v2資産 | vNextでの扱い |
|---|---|---|
| そのまま活用 | Bun／TypeScript基盤、CLI、Installer、native binary配布 | 原則維持 |
| そのまま活用 | Harness ContractとCodex Adapterの責務分離 | 原則維持 |
| 活用 | Workspace、Space、Intent、Artifact、Memory | vNext Contractに合わせて再利用 |
| 拡張 | State、Audit、Doctor、Sensor | Stage判定、反復、人間判断の状態を追加 |
| 変更 | Stage Loader、Graph、Scope Loader、Orchestrator | 単一のvNext定義と遷移を実行 |
| 置換 | 32 Stage Catalog、Scope Grid、Stage Graph | vNextの10 Stage、Core Route、Effective Policyへ置換 |
| 再設計 | Stageごとの人間Approval Gate | Co-Design、ST-07、例外Gateへ集約 |
| 再設計 | Construction Bolt | vNext Bolt PlanとAI Convergenceの実行モデルへ移行 |

## 4. マイルストーン

### M0: v2 Baselineと回収境界の固定

**目的**

vNext開発の出発点を固定し、v2のどの実行機構を回収し、どのWorkflow定義を
置き換えるかを明文化する。

**主な作業**

- `origin/main`を基点としたvNext開発ブランチを使用する
- v2のtypecheck、Graph、Runtime Contract、testを実行する
- v2の32 Stageを棚卸しし、回収、統合、分割、置換、削除、新規作成を判断する
- State、Audit、Artifact、Sensor、Harness、Distributionの回収境界を整理する
- vNextの用語と識別子を確定する
- AI、Core、人間の進行権限とStageの軽量通過方式を確定する

**成果物**

- `docs/aidlc-vnext-milestones.md`
- `docs/aidlc-vnext-v2-recovery-map.md`
- `docs/aidlc-vnext-v2-baseline.md`
- `docs/aidlc-vnext-m0-boundaries.md`
- `docs/aidlc-vnext-m0-result.html`
- `docs/aidlc-vnext-ai-control-guide.html`

**完了条件**

- 現行の`release:check`が成功する
- Stage知識の回収先、vNextで新規作成する能力、削除対象がレビュー可能になっている
- M1以降で変更するCore境界が特定されている
- AI、Core、人間の進行権限と、小さな変更を根拠付きで短く通過させる方針が
  レビュー可能になっている

### M1: 共通Stage ContractとCore権限基盤

**目的**

全10 Stageが従う共通Contractと、AI、Core、人間の更新権限を確定する。
この段階では有効なv2 Catalog／Graphを切り替えず、M2で安全に置換するための
型、validator、State／Audit境界を先に作る。

**主な作業**

- 共通Stage Contractの型、必須項目、検証規則を定義する
- Artifact versionとSource of Truthを定義する
- AI内部loopの終了理由とHuman Decision分類を定義する
- StateとAudit Eventの共通envelopeを定義する
- Stageごとの`execute`、`reuse`、`not_applicable`と、その根拠・Evidenceを表す
  共通Contractを定義する
- Stage Execution PlanをCoreだけが確定・更新できるようにする
- State、Plan、Doctor、Runtime Contractが共有できるvNext validatorを用意する
- vNext Contractのfixtureと、正常・不正・権限違反のcontract testを追加する
- v2 Workflowを選択する分岐や互換モードは追加しない

**成果物**

- `docs/aidlc-vnext-stage-contract.md`
- `docs/aidlc-vnext-m1-result.html`
- vNext Contract定義の配置規約
- Stage／Artifact／Stage Execution Plan／Directive／State／AuditのvNext共通型
- Contract validatorとunit／contract test

**完了条件**

- 共通ContractがStage固有の自由形式遷移を受け付けない
- vNext Contractに合わない定義をfail closedで拒否する
- Core以外によるStage disposition／遷移の確定を拒否できる
- AIがStage遷移やStage dispositionを直接確定できない
- 現行v2 Baseline testに意図しない回帰がない

### M2: vNext 10 Stage GraphとCore Route

**状態: 2026-08-23 実装・検証完了。結果は`docs/aidlc-vnext-m2-result.html`。**

**目的**

vNextの10 Stage、遷移、Stage disposition、Effective Policyを
決定的なCore定義としてコンパイルできるようにする。

**主な作業**

- 32 StageのCatalogとGraphをvNext 10 Stageへ置き換える
- Runtimeの有効なCatalog／GraphをvNextの単一配置へ切り替える
- v2 Scope Gridと9 Scope RouteをRuntime経路から外す
- Stage Execution PlanとCore Directiveのschemaを定義する
- `execute`、`reuse`、`not_applicable`の決定規則、根拠、Evidenceを定義する
- Design BriefとWorkspace ContextからStageで必要な作業を解決する
- 組織、Space、TeamのMemoryとIntent固有リスクからEffective Policyを導出する
- AI提案がなくてもCoreだけでRouteを検証できるようにする

**成果物**

- vNext Stage Catalog／Graph
- Stage Execution Plan／Core Directive／Stage dispositionのschema
- Effective Policy resolverとRoute validation test
- Loader／State／Plan／Doctor／OrchestratorのvNext Runtime接続

**完了条件**

- 10 Stage Graphが循環意図を含めて検証できる
- RuntimeがvNext以外のWorkflow定義を選択しない
- 小さな変更では不要な新規成果物を作らず、根拠を残して短く通過できる
- AIがStageを追加、削除、飛び越し、Stateへ遷移を直接記録できない
- Policy不足、未定義Route、根拠のない`not_applicable`を拒否できる

### M3: Design BriefとCo-Design（ST-00〜ST-05）

**進捗（2026-08-24）**

- ST-00 Bootstrapは詳細設計、TDD実装、Codex／native配布、Sandbox検証まで完了
- ST-01 Orientは詳細設計、TDD実装、Codex／native配布、Sandbox検証まで完了
- ST-02 Define Intentは詳細設計が承認され、TDD実装と配布・回帰検証を実施した
- 次はST-03 Requirements & Constraintsを詳細設計し、明示的承認後にST-03だけを実装する

**目的**

人間のDesign Briefを起点に、人間とAIが評価可能なDesign Contractを作る前半工程を実装する。

**主な作業**

- ST-00 BootstrapとST-01 Orientで実行環境とCurrentを確定する
- ST-02でDesign BriefからIntent、Scope、成功基準を揃える
- ST-03で機能要求、NFR、制約、未確定事項を整理する
- ST-04でArchitecture Decisionと必要Evidenceを確定する
- ST-05でDesign Contract、受入例、合格条件、Bolt Planを生成する
- Effective Policyに基づいてEvidence、Verifier、Human Gateを決める

**成果物**

- ST-00〜ST-05のStage定義
- Design Brief／Design Contract／Bolt PlanのArtifact contract
- Co-DesignのState、Audit、Codex rendering

**完了条件**

- GreenfieldとBrownfieldの両方でDesign Contractまで到達できる
- AIが推測してはいけない価値判断だけを人間へ質問する
- ST-05完了後に、AIが自走可能な合格条件と停止条件が存在する

### M4: Build & Convergeと3重ループ（ST-06）

**目的**

AIがBolt単位で実装、テスト、実行、仕様比較、修正を反復し、
全Boltを統合したRunnable Candidateへ収束できるようにする。

**主な作業**

- AI内部loopの試行、Evidence、Checkpointを永続化する
- Boltの依存関係、ready判定、完了判定を実装する
- AIが提案したBolt PlanをCoreがschema、要求coverage、DAG、受入条件、Verifier、
  統合条件について検査する
- 人間が承認したBolt Planのsnapshot／hashを固定する
- 全Bolt統合とRunnable Candidate生成を実装する
- 合格、仕様矛盾、収束不能、予算到達、重大リスクの停止理由を定義する
- 失敗・中断後のresumeを実装する
- v2 Construction Bolt／Worktree資産をvNext Bolt実行へ再利用する

**成果物**

- ST-06 Stage定義とConvergence contract
- Bolt execution stateとAI Checkpoint
- Worktree／Executor／Sensor統合
- 正常、失敗、再開、予算到達test

**完了条件**

- デフォルトではBoltごとの人間Gateなしで全Boltを処理できる
- 例外条件では理由とEvidenceを保持して人間へ停止できる
- セッションを跨いで同じBoltと試行位置から再開できる
- 全Bolt合格前にRunnable Candidateを完成扱いしない

### M5: Feedback、Approval、Release、Outcome（ST-07〜ST-09）

**目的**

人間が実物を評価し、Feedbackを適切なStageへ戻し、承認された成果物だけを
Accepted BaselineとしてReleaseとOutcomeへ接続する。

**主な作業**

- ST-07へRunnable Candidate、確認シナリオ、テストデータ、既知の制約を渡す
- ST-07のFeedbackをST-03の要求・制約とST-05の現行Contractへ必ず比較する
- 未変更の要求に違反した不具合はST-06、要求変更はST-03、Architecture影響は
  ST-04、受入条件／Bolt Plan影響はST-05へ戻す
- ST-03へ戻った場合、影響するST-04、ST-05、ST-06の成果物を失効または再評価する
- Feedbackと最終Approvalを同じStage内で区別してAuditする
- AI CheckpointをAccepted Baselineへ昇格する
- ST-08のRelease GateをEffective Policyと外部副作用から決定する
- ST-09で利用結果を次のDesign Brief／Intentへ接続する

**成果物**

- ST-07〜ST-09 Stage定義
- Feedback classificationとBaseline promotion contract
- Release／Outcome State、Audit、test

**完了条件**

- ST-07が全Bolt統合後にだけ通常起動する
- Feedbackによる戻り先が決定的か、判断不能として人間へ提示される
- ApprovalなしにAccepted Baselineへ昇格しない
- ST-07の結果がST-03と矛盾したままAccepted Baselineへ昇格しない

### M6: Codex HarnessとEnd-to-End

**目的**

CodexからvNextを開始、再開、実行、Feedback、承認できる利用体験を完成させる。

**主な作業**

- Codex Skillとlifecycle renderingをvNext Directiveへ対応させる
- Design Brief開始、Co-Design質問、進捗、例外停止、ST-07を表示する
- Codex HookとSensor receiptの互換性を検証する
- Installer、Bundle、native binaryへvNext資産を含める
- 小さな文字変更、依存関係を持つ機能追加、仮説検証、外部ReleaseのE2Eを追加する

**成果物**

- vNext対応Codex Harness
- Codex Bundle／Installer／Distribution更新
- E2E testと利用手順

**完了条件**

- Codexで新規IntentをvNextとして開始・再開できる
- 小さな変更が根拠付きで短く通過し、複雑な変更が必要な成果物を生成して完走する
- Effective PolicyとIntent固有リスクによるHuman Gate差がE2Eで確認できる
- Runtime、Bundle、Installer、Distributionの回帰testが成功する

### M7: v2 Workflow削除とvNext Release

**目的**

不要になったv2 Workflow資産と互換経路を残さず、vNextだけを安全にReleaseする。

**主な作業**

- v2の32 Stage定義、Scope Grid、生成Stage Skillを削除する
- v2専用のGate、Bolt、互換分岐のうちvNextで不要なものを削除する
- 旧v2 StateをvNextとして読み込まず、Doctorでunsupportedと明示する
- 配布物にvNext Workflowだけが含まれることを検証する
- README、運用手順、Release Notes、versionを更新する

**成果物**

- v2資産削除一覧とDoctor診断
- vNext単一Workflow設定
- Release packageとRelease Notes

**完了条件**

- Runtime、Harness、配布物からv2 Workflowを開始できない
- 旧v2 Stateは推測変換せず、再開始が必要だと明示する
- `release:check`と全ターゲットのpackage検証が成功する
- vNextの導入、開始、再開、Feedback、Release手順が文書化されている

## 5. 依存関係

```text
M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7
```

- M1は全Stageの共通ContractとCore権限の土台となるため、後続実装より先に完了する
- M3とM4はArtifact contractを介して接続するため、ST-05の出力を先に固定する
- M5のBaseline promotionはM4のCheckpoint contractに依存する
- M6はCoreの意味を変更せず、M2〜M5のDirectiveをCodexへ写像する
- M7でv2 Workflow資産を削除し、vNextだけを配布する

## 6. 横断的な品質条件

各マイルストーンで次を満たす。

- StateとAuditをHarnessまたはAgentが直接編集しない
- Approval、Feedback、質問回答を実際の人間入力なしに記録しない
- 回収したv2実行機構の性質をvNext向けtestで維持する
- 置き換え対象のv2 Stage／Scope testは、対応するvNext testが揃ってから削除する
- 新しいCore判断に決定的なunit testを追加する
- Codex固有処理をDomain Coreへ混入させない
- 設計変更と運用手順を`docs/`へ記録する
- TypeScriptのtypecheck、Graph、Runtime Contract、関連testを通過させる

## 7. ブランチと統合方針

- 開発ブランチ: `codex/aidlc-vnext`
- 基点: `origin/main`
- マイルストーンごとに、Core contract、Stage data、Harness、Distributionを分けてcommitする
- 回収した実行機構のtestが通らない状態を次のマイルストーンへ持ち越さない
- Workflow選択分岐を追加せず、vNextの単一経路へ段階的に置き換える
- 未追跡の`.vscode/`と`docs/aidlc-vnext-visual-guide.html`は、別途明示されるまでcommit対象にしない

## 8. 次に着手する作業

M3のST-03として、次の順に進める。

1. ST-02のIntent Definitionと固定済み入力参照を確認する
2. 機能要求、非機能要求、制約、未確定事項の責務境界を詳細設計する
3. 初心者向けHTMLでST-03の処理と非対象をレビュー可能にする
4. 明示的承認後にST-03だけをTDD実装する
