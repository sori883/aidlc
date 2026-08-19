# AI-DLC v2 再実装バグ是正コンテキスト

## 1. 文書情報

- 作成日: 2026-08-18
- 状態: 実装・検証完了（Stage 0〜9、AIDLC-006追加是正完了）
- 対象リポジトリ: `/Users/const/sori883/aidlc`
- 検査対象Workflow: `/Users/const/sori883/ai-dlc-cycle/05.ai-dlc-test`
- Intent: `260808-mvp`
- Scope: `mvp`
- 入力となる判定書: `30.結果AI判定_是正.md`

この文書は、再実装で生じたAI-DLC v2の不具合を是正すると同時に、
Codex以外のHarnessへ将来対応できる境界を維持するための実装コンテキストで
ある。本文の承認前は実装コードを変更しない。

## 2. 結論

今回の目標は、再実装由来の対象6件と、追加承認された本家由来のAIDLC-006に
関係するAI-DLC v2の
**観測可能な契約互換性**を回復することである。複合分類のAIDLC-004と
AIDLC-007は、再実装側の責務だけを是正する。

同じWorkflow入力、人間の回答、承認、失敗条件に対して、次が基準実装と
一致する状態を完了とする。

- Stage、Bolt、gateの実行順序
- 停止、再開、失敗時の選択肢
- Stateの現在位置と進捗
- Audit Eventの種類、順序、相関
- Sensorのpassed、failed、budget override分類
- 対象となるStage間の入出力契約
- 完了判定とDoctorの診断結果

内部の関数、クラス、ファイル構成を本家と同一にすることは目的ではない。
TypeScriptとBunで等価な動作を実装する。

## 3. 準拠基準

### 3.1 優先順位

仕様判断は次の順で行う。

1. 固定された本家AI-DLC v2のリポジトリとtagまたはcommit
2. 本リポジトリへ取り込まれたCore Protocol、Stage、State契約
3. `30.結果AI判定_是正.md`の修正確認条件
4. 現在のTypeScript実装

準拠元は、ローカルに保存された本家スナップショットを含む親リポジトリの
commit `6a8a8129446bd8df59edcc47d519ebccfcae793d` と、その中の
`02.本家ai-dlc` subtree `c5ffd3b32a5d8ea2947e16416f38ab85c6b292c4` に固定した。
ファイルhash、対象契約、Golden Traceの詳細は
`docs/aidlc-v2-upstream-baseline.md`に記録する。

### 3.2 本家由来バグの扱い

本家由来だけのバグは原則として修正しない。本家定義の不整合が再実装バグの修正を
妨げる場合は、独自に是正せず差分を記録して人間へ確認する。AIDLC-006の
Build/Test成果物名不一致は当初対象外だったが、2026-08-19にユーザーの明示承認を
得て追加対象とした。この例外はAIDLC-006だけに適用し、他の本家由来不整合へ
自動的に範囲を広げない。

### 3.3 Stage 0で確定した仕様

固定した本家の`stage-protocol.md`と`aidlc-bolt.ts`はともに、Boltを
Construction 3.1〜3.5の一周と定義している。3.6 Build and Testと
3.7 CI Pipelineは、全Bolt完了後にそれぞれ一度だけ実行する。

現行再実装内にある「Boltが3.1〜3.7を含む」と読める記述は、本家との仕様差では
なく再実装側のdriftとして是正する。対象6件について実装を妨げる未解決の仕様差は
ない。

## 4. 対象範囲

### 4.1 対象

| ID | 優先度 | 是正対象 |
|---|---:|---|
| AIDLC-001 | P0 | ConstructionのBolt実行機構 |
| AIDLC-002 | P0 | Sensor結果の誤分類 |
| AIDLC-003 | P1 | Sensorの条件付き入力、Review除外、証跡鮮度 |
| AIDLC-004 | P1 | Quality Gate宣言と生成CIの不一致を検出できない再実装側の検証不足 |
| AIDLC-005 | P1 | Doctorの実行意味検査 |
| AIDLC-006 | P1 | Build/Test成果物名の統一と限定的Stage lint |
| AIDLC-007 | P2 | 再実装側のAudit順序、Workspace移設耐性、skip表示 |

対象はAIDLC-001、AIDLC-002、AIDLC-003、AIDLC-004の再実装部分、
AIDLC-005、追加承認されたAIDLC-006、AIDLC-007の再実装部分に限定する。

### 4.2 対象外

- Claude Code、GitHub Copilot用Harnessの実装そのもの
- AI-DLC全機能についての完全な本家差分解消
- AIDLC-004のMVP成果物固有の不正なCIファイルの直接修正
- AIDLC-007で環境移設により生じた過去のWorkflow記録の直接修正
- Operation Phaseの実行や実環境へのdeployment
- MVPアプリ固有のcoverage、依存脆弱性、credential準備
- 検査対象Workflowの成果物を直接書き換えて履歴を作り直すこと

既存Workflowは診断fixtureとして読み取り専用で使用する。修復検証が必要な場合は
一時コピーを使用する。

## 5. 現状の確認結果

### 5.1 Workflow証跡

検査対象Workflowでは次を確認した。

| 項目 | 結果 |
|---|---:|
| `SENSOR_FIRED` | 179 |
| `SENSOR_PASSED` | 158 |
| `SENSOR_FAILED` | 0 |
| `SENSOR_BUDGET_OVERRIDE` | 21 |
| `BOLT_STARTED` | 0 |
| `BOLT_COMPLETED` | 0 |
| `BOLT_FAILED` | 0 |
| `AUTONOMY_MODE_SET` | 0 |

Stateでは`Construction Autonomy Mode: unset`、`Worktree Path`と`Bolt Refs`は
空で、Project Rootは移設前の絶対パスを保持している。Bolt PlanにはB1〜B4が
存在する。

### 5.2 現行テスト

実装前baselineとして、型検査と関連47テストはすべて成功した。これは既存
テストが正常であることを示す一方、今回の不具合を捕捉する回帰契約が不足して
いることも示す。

### 5.3 Harness境界の状態

Harness中立化の土台として、JSON Directive、Core State/Audit、共通Sensor
Hook、`{{HARNESS_DIR}}` placeholderがある。

一方で、次のCodex固定が残っている。

- `Harness`型が`"codex"`だけを許可する
- 配布、Installation Manifest、CLI pathが`.codex/`固定である
- Runtime ContractがCodex Bundleを直接参照する
- Core Protocolに`TaskUpdate`、`PostToolUse`などのHarness固有操作がある
- Stage 1着手時点ではCore CLI routerが`aidlc-codex-hook.ts`を直接認識していた
- Core Protocolが未実装の`aidlc-bolt.ts`を参照する

新しいBolt実装をCodex Skillだけへ追加すると、この固定を強化してしまう。
したがって、共通CoreとHarness Adapterの境界を先に確定する。

## 6. 目標アーキテクチャ

### 6.1 責務

| 層 | 責務 | Harness固有情報 |
|---|---|---|
| Domain Core | Stage Graph、Bolt Plan、State、Audit、Sensor、Doctor、成果物契約 | 禁止 |
| Engine/CLI | 決定的な状態遷移と汎用Directiveの入出力 | Harness IDと能力記述だけ |
| Harness Contract | 質問、Agent委譲、Hook、並列性などの能力モデル | 抽象定義のみ |
| Harness Adapter | Skill、Agent設定、Hook payload、質問UI、配置規則 | 許可 |
| Distribution | Coreと選択Harnessの組合せ、所有Manifest | Harnessごとのlayoutを参照 |

### 6.2 共通Directive

Coreはツール名を指示せず、意図を表す既存の汎用Directiveを出す。

- Stageを実行する
- Agentへ委譲する
- 人間へ構造化質問を提示する
- gateを提示する
- Workflowを停止または完了する

Boltの開始、完了、失敗、autonomy、worktreeはDirectiveの種類を増やさず、Coreの
決定的commandとState/Audit遷移として扱う。Codex Adapterは汎用Directiveを
Skill、custom Agent、Hookへ変換する。将来のClaude CodeやCopilot Adapterも
同じDirectiveをそれぞれの操作へ変換する。

### 6.3 Capabilityとfallback

Harnessごとに少なくとも次の能力を宣言する。

- 構造化質問
- Agent委譲
- 並列Agent委譲
- write後Hook
- reviewer scope enforcement
- stop/wait通知

能力がない場合のfallbackを共通契約で固定する。

- 並列委譲なし: 同じblind briefを用いた逐次実行
- write後Hookなし: Stage完了前の明示的Sensor実行
- 構造化質問なし: 選択肢IDを保持したテキスト表示
- reviewer enforcementなし: directiveのread scopeと証跡による検査

fallbackによって変えてよいのは実行手段だけであり、State、Audit、成果物、
人間gateの意味は変えない。

### 6.4 パスと配布

Coreで`.codex`を固定値にしない。Harness Descriptorが次を提供する。

- Harness ID
- Runtime root
- executable path
- instruction、Agent、Hookの配置先
- Installation Manifestの配置先

今回の実HarnessはCodexだけであり、現在の配置との後方互換を維持する。
Manifest schemaは複数Harnessを表現可能にするが、未実装Harnessを選択した場合は
明示的にunsupportedとして停止する。

## 7. 実装原則

1. Coreの新規コードにCodex固有のtool名、payload、pathを入れない。
2. StateとAuditの更新は決定的なCore commandだけが行う。
3. AdapterはStateとAuditを直接編集しない。
4. Harness能力不足を成功として黙って扱わない。
5. 人間の承認、回答、Bolt成功を推測して記録しない。
6. 既存Workflowへ架空のBolt Eventを遡及追加しない。
7. すべての変更はTypeScriptで実装し、Bunで実行、検証する。
8. 各Stageで失敗を再現するtestを先に追加し、その後に実装する。
9. 各Stageの完了時に対象testと影響範囲のtestを実行する。
10. Codex Adapterは最初の適合Harnessとして完成させる。

## 8. 段階的実装計画

### Stage 0: 準拠版とGolden Traceの固定

目的: 実装中に基準が動かないようにする。

状態: 完了。固定内容は`docs/aidlc-v2-upstream-baseline.md`を参照する。

作業:

- 本家AI-DLC v2のrepository、tagまたはcommitを記録する
- Core Protocolと本家の差分を対象6件について整理する
- Bolt実行範囲3.1〜3.5と集約Stage 3.6〜3.7を確定する
- 正常系、失敗系、resume系のGolden Traceを定義する
- 仕様差が残る場合は実装を開始せず人間へ確認する

完了条件:

- 準拠元が一意に記録される
- 対象6件の期待State、Audit、Directive列が定義される
- 未解決の仕様差が0件になる

### Stage 1: Harness Architecture Contract

目的: 以後の修正をHarness-neutralなCoreへ実装できるようにする。

状態: 完了。実装済み境界と将来Adapter追加条件は
`docs/aidlc-v2-harness-architecture.md`を参照する。

作業:

- Harness DescriptorとCapability schemaを定義する
- 汎用DirectiveとAdapter責務を確定する
- Core ProtocolからCodex固有手順をCodex annexへ移す
- Sensor Hookを共通entrypointとCodex payload adapterへ分離する
- Distribution、Installer、Runtime ContractがHarness Descriptorを参照するようにする
- 最小のfake Harnessをtest内に実装する
- CoreへのCodex依存混入を検出するboundary testを追加する

後方互換:

- `--harness codex`と現在の`.codex/`配置を維持する
- Codex以外のHarnessはまだ配布しない

完了条件:

- Coreの状態遷移testがCodex Bundleなしで動作する
- fake HarnessとCodex Adapterが同じ論理Traceを生成する
- unsupported Harnessが明示的なerrorになる

### Stage 2: AIDLC-002 Sensor結果分類

目的: 品質違反をbudget overrideへ誤分類しない。

状態: 完了。checker protocolの`pass`を判定の正本とし、trailing logを除外して
最後の有効なJSONを採用する。timeout、spawn失敗、protocol不成立、およびcheckerが
明示したtool利用不能だけをbudget overrideとして維持する。

作業:

- stdoutを後方走査して最後の有効なJSON objectを取得する
- checker protocolとして`pass` booleanを必須にする
- `exit 0 + pass:true`をpassedとする
- `exit 1 + pass:false`をfailedとする
- timeout、spawn失敗、protocol違反だけをbudget overrideとする
- Fire IDごとの終端Event一意性を検査する

回帰test:

- JSON後に`ELIFECYCLE`等の行が出る
- stderrへpackage manager logが出る
- JSONなし、壊れたJSON、timeout、spawn失敗
- 同一Fire IDで終端Eventが一つだけになる

完了条件:

- 判定書の代表ケースが`SENSOR_FAILED`になる
- 既存の利用不能toolはbudget overrideのままになる

### Stage 3: AIDLC-001 Bolt Core Contract

状態: 完了。機械可読なBolt Plan、State Version 8、Bolt lifecycle、Audit、
失敗時選択、再開、旧Stateの保守的移行を実装した。詳細は
`docs/aidlc-v2-bolt-contract.md`を参照する。

目的: Delivery Planを決定的なConstruction実行計画へ変換する。

作業:

- `bolt-plan.md`へ機械可読なfenced YAML blockを定義する
- Bolt ID、slug、Units、依存Bolt、walking skeleton、実行batchをparseする
- Unit DAGとの参照整合、依存関係、循環、空Boltを検査する
- 同じUnitが複数Boltに現れるthin-slice planを許可する
- Current Bolt、Bolt進捗、autonomy、worktree、refをState契約へ追加する
- `BOLT_STARTED`、`BOLT_COMPLETED`、`BOLT_FAILED`、
  `AUTONOMY_MODE_SET`をAudit taxonomyへ追加する
- start、complete、fail、retry、skip、abortの原子的状態遷移を実装する

移行方針:

- 完了済み旧WorkflowへBolt Eventを捏造しない
- Bolt証跡がない完了済みWorkflowはDoctorがexecution unhealthyとして報告する
- Construction途中の旧Workflowは進捗を推測せずmanual migrationとして停止する

完了条件:

- Bolt PlanとStateだけから次に実行すべきBoltを一意に決定できる
- crash後も同じBolt境界から再開できる
- 不正なBolt PlanではConstructionを開始しない

### Stage 4: AIDLC-001 EngineとCodex Adapter接続

状態: 完了。Boltごとの3.1〜3.5反復、Stage/Unit cursor、B1 gate、
autonomy ladder、失敗時選択、Worktree統合待ち、全Bolt後の3.6解放をCoreへ
接続した。Codex SkillはCore DirectiveとBolt commandの表示・転送だけを担当する。
統合fixtureを含む全220 testが合格した。

目的: Bolt Core Contractを実際のCodex実行へ接続する。

作業:

- 既存の汎用DirectiveとBolt Core commandを接続する
- B1を単独で最初に実行する
- B1完了後に必須gateを一度だけ提示する
- gate承認直後にladderを一度だけ提示する
- autonomyを`autonomous`または`gated`として永続化する
- 後続Boltを依存関係と選択modeに従って実行する
- Bolt単位でworktreeをcreate、verify、mergeまたはpreserveする
- 失敗時はmodeに関係なくretry、skip、abortを提示する
- 全Bolt完了前はBuild and Testへ進めない
- Unit単位の完了承認をBolt単位へ置き換える

Codex Adapter:

- Codex SkillへConstruction forwarding flowを追加する
- custom Agent委譲と質問表示だけをCodex固有処理とする
- Boltの判断とState更新はCore commandへ委譲する

完了条件:

- B1 gateとladderがそれぞれ一回だけ発生する
- B1〜B4の開始・完了Eventが対になる
- failure後に後続Boltへ自動進行しない
- resume時にgateやladderを重複表示しない

### Stage 5: AIDLC-003 Sensor意味検査と証跡鮮度

状態: 完了。Project Typeに基づく共通consume filter、行番号を保持するReview・
fence・comment除外、全outcome共通のhash付きSensor receipt、fresh/stale判定を
実装した。成果物またはsemantic input変更後の旧passはfreshと判定されない。
配布同期後の全223 testが合格した。receipt契約は
`docs/aidlc-v2-sensor-receipts.md`を参照する。

目的: Sensorのfalse positiveと古いpassを排除する。

作業:

- Project Typeと`conditional_on`から適用入力を決定する共通関数を使う
- `## Review`を次のH2またはEOFまで行単位で除外する
- fenced code、comment、Review後の本文をfixtureで検証する
- 全Sensor fireへ構造化receiptを保存する
- receiptへoutput hash、input hash、Sensor version、checker protocolを記録する
- 現在のhashと一致しないreceiptをstaleにする

完了条件:

- GreenfieldでBrownfield専用artifactを要求しない
- Review本文をclaimとして検査しない
- Review後の本文は検査対象へ戻る
- 成果物変更後の旧passを現在のpassとして扱わない

### Stage 6: AIDLC-004 Quality Gate ManifestとCI検査

状態: 完了。provider拡張可能なManifest、GitHub Actionsの意味検査、安定した
aggregate check、fresh runner要件、`workflow_run`参照先の整合検査を実装した。
既存MVPのCI成果物は変更していない。配布同期後の全227 test、型検査、graph、
runtime contract、distribution checkが合格した。詳細は
`docs/aidlc-v2-quality-gate-manifest.md`を参照する。

目的: 品質宣言と生成CIを機械的に一致させる。

作業:

- provider拡張可能なQuality Gate Manifest schemaを定義する
- 最初のproviderとしてGitHub Actionsを実装する
- Node、workerd、browser、coverage、build、architecture、security gateを表現する
- Manifest、package scripts、workflow jobs、trigger、required checkを照合する
- fresh runnerに必要なruntime、package manager、frozen installを検査する
- stable aggregate checkを検査する
- `Quality`対`CI-Q`を含む壊れたworkflow fixtureを追加する
- YAML構造検査とactionlint相当の検査責務を分離する

完了条件:

- 必須jobやscriptを削除すると検査が失敗する
- 実在しないworkflow名をtriggerに指定すると失敗する
- 空runnerで再現不能なjobをreadyと判定しない

### Stage 7: AIDLC-005 Doctor Execution Audit

状態: 完了。`--full`で構造健全性と実行健全性を分離し、Bolt、autonomy、
Sensor相関・receipt鮮度、Quality Gate、Project Rootを横断検査する。判定対象の
実Workflowへread-onlyで適用し、Bolt Event 0件、autonomy未設定、override
21/179、receipt欠落、Quality Gate Manifest欠落、Project Root不一致を検出した。
詳細は`docs/aidlc-v2-doctor-execution-audit.md`を参照する。

目的: 構造上healthyでも実行意味が壊れている状態を検出する。

作業:

- `structural health`と`execution health`を分離する
- full audit modeでState、Audit、Sensor receipt、成果物を横断する
- Bolt PlanがあるのにBolt Eventがない状態を検出する
- Construction完了時のautonomy `unset`を検出する
- Sensor Fire IDの欠落、重複終端、異常なoverride比率を検出する
- stale Sensor receiptを検出する
- Quality Gate ManifestとCIの不一致を検出する
- Project Rootの移設を検出する

完了条件:

- 検査対象Workflowの一時コピーに対して、少なくともBolt証跡欠落、autonomy、
  Sensor分類、Project Root、CI不一致を報告する
- 自動修復可能と人間判断が必要なfindingを区別する
- 承認やBolt成功をDoctorが推測して修復しない

### Stage 8: AIDLC-007 監査と移設耐性の整合

状態: 完了。Audit timestampのlock内生成、clone-local sequence、複数shardの
決定的読取、project内証跡の相対path化、Project Rootの1行限定修復を実装した。
6並行processの追記でもsequenceの逆転・重複がないことを確認した。StageとBoltの
skip markerは既に`[S]`で統一されていたため、その契約と回帰testを維持した。
詳細は`docs/aidlc-v2-audit-portability.md`を参照する。

目的: 再実装側の監査順序、Workspace移設、State表示の再現性を改善する。

作業:

- Audit timestampをworkspace lock取得後に生成する
- Auditへ単調増加sequenceを追加する
- 分散したclone shardは`clone id + sequence + timestamp`で順序を保持する
- 永続証跡のパスを可能な範囲でworkspace-relativeにする
- Project Root移設をdeterministic repairとして提供する
- skip markerを`[S]`へ統一する

完了条件:

- 同一Workspaceの並行追記でsequenceが逆転、重複しない
- Workspace移設後にDoctor checkと安全なrepairが成功する
- State説明と実表示が一致する

### Stage 9: 総合E2E、配布、将来Harness適合性

状態: 完了。`bun run release:check`で45 test file、234 testが合格した。
native binary、PATHなしGitHub配布、Codex bundle、fake Harness適合性の重点51 testも
再実行して全件合格し、`dist/project`の同期と`git diff --check`を確認した。検証対応表は
`docs/aidlc-v2-remediation-verification.md`を参照する。

目的: 修正がsource実行だけでなく配布版でも成立することを証明する。

作業:

- fresh MVP fixtureでB1、ladder、後続Bolt、集約Stageを実行する
- gated、autonomous、failure retry、skip、abort、resumeを検証する
- Sensor分類、鮮度、CI検査、Doctorを同じWorkflowで検証する
- native binaryとCodex Bundleへ新契約が含まれることを検査する
- PATHを空にした配布E2Eを実行する
- fake Harness conformance suiteを再実行する
- `bun run release:check`を実行する

完了条件:

- 対象6件の修正確認条件がすべて自動testで証明される
- CodexでGolden Traceと一致する
- Core testがCodex Adapterなしでも成功する
- native配布とsource実行の結果が一致する

## 9. Test戦略

### 9.1 testの層

| 層 | 主な検証 |
|---|---|
| Unit | parser、分類、hash、State transition、Directive validation |
| Contract | Core/Harness境界、Stage artifact、Manifest、Audit taxonomy |
| Integration | Orchestrator、worktree、Sensor process、Doctor full audit |
| E2E | fresh MVP、resume、failure、native distribution |
| Fixture regression | 今回のMVP記録で起きた具体的な失敗 |

### 9.2 必須Golden Trace

正常系:

1. B1 start
2. B1 stages 3.1〜3.5
3. B1 gate
4. ladder
5. autonomy set
6. 後続Boltを依存順に実行
7. 全Bolt complete
8. Build and Test
9. CI Pipeline
10. Construction verified

失敗系:

1. Bolt start
2. code generation failure
3. `BOLT_FAILED`
4. retry、skip、abortを人間へ提示
5. 選択されるまで後続へ進まない

resume系:

- B1実行途中
- B1 gate待ち
- ladder待ち
- 後続Bolt実行途中
- failure選択待ち
- 全Bolt完了後、Build and Test開始前

各位置で再実行してもEvent、gate、質問が重複しないことを検証する。

## 10. 互換性とmigration

### 10.1 State version

Bolt進捗とSensor receiptを導入するためState schema versionを更新する。
旧versionの扱いを明示し、黙って新形式として解釈しない。

### 10.2 完了済みWorkflow

- StateをCompletedのまま保持する
- 不足するBolt証跡を生成しない
- Doctorのexecution healthでhistorical inconsistencyとして報告する
- 成果物hashがない旧Sensor結果はlegacy/unverifiableとして区別する

### 10.3 実行途中Workflow

- Construction開始前はdeterministic migrationを許可する
- Construction開始後でBolt証跡がない場合はmanual findingとする
- 人間の選択なしにUnit進捗をBolt進捗へ割り当てない

### 10.4 Distribution

- 現行Codex利用者のinstall/updateを壊さない
- managed fileの競合保護を維持する
- 将来のHarness追加時もCore binaryを再設計しない
- Harness固有ファイルだけを選択して導入できるManifestを目標とする

## 11. Stageごとの進め方

各Stageは次の手順で進める。

1. そのStageの目的と変更範囲をユーザーへ説明する
2. 失敗を再現するtestを追加して失敗を確認する
3. 最小の実装を行う
4. 対象test、関連test、型検査を実行する
5. 変更ファイル、挙動、未解決事項を報告する
6. 次Stageへ進む

計画全体は2026-08-18に明示的な承認を得た。Stage 0で基準を固定してからStage 1〜9を
順に実施し、当初対象外のAIDLC-006と過去MVP成果物を変更せず完了した。その後、
2026-08-19にAIDLC-006だけを追加修正する計画について別途承認を得た。

## 12. 最終完了条件

次をすべて満たした時点で是正完了とする。

- AIDLC-001、002、003、004の再実装部分、005、007の再実装部分、および
  追加承認された006について、
  修正確認条件を自動testで証明した
- AIDLC-006についてStage定義、Graph、生成指示、実成果物path、下流consumeを
  `build-test-results.md`へ統一した
- 本家準拠版と対象契約の差分が0件、または承認済み差分として記録された
- BoltのState、Audit、gate、resumeがGolden Traceと一致した
- Sensorの全Fire IDが一つの終端結果を持ち、stale passを識別できた
- Doctorが構造健全性と実行健全性を正しく分離した
- Codex Adapter以外にCore動作が依存していないことをfake Harnessで証明した
- 現行Codex install/update互換性を維持した
- `bun run release:check`と配布E2Eが成功した
- 検査対象Workflow自体を直接改変していない

## 13. 将来のHarness追加手順

Claude CodeまたはGitHub Copilot対応時は、CoreのStage、Bolt、State、Auditを
変更せず、次だけを追加する。

1. Harness Descriptor
2. Directive Adapter
3. Agent、question、Hookの設定とrenderer
4. 配置layoutとInstaller mapping
5. 共通conformance suiteの期待値
6. Harness固有の不足能力に対する宣言済みfallback test

実際の追加時には、対象製品の具体的な実行面を固定する。例えばCopilotは
IDE機能、CLI、coding agentで能力が異なるため、単に`copilot`という名前だけで
Adapter仕様を推測しない。

## 14. ローカルRelease受入で検出した追加是正

2026-08-19の`06.ai-dlc-test2`初回受入では、再実装した配布・診断境界に次の2件を
検出した。この節の追加是正にはAIDLC-006を含めない。

1. native配布ではTypeScript runtime toolを単一実行ファイルへ置換するが、Runtime
   Contractがsource fileの存在を要求していた
2. macOSが配布後に作成する`.DS_Store`をDoctorが必須Memory seedと誤認した

是正方針は次のとおりとする。

- Runtime ContractはHarness種別ではなく実装形態`source`/`native`を区別する
- `native`では同梱CLI contractを実装能力の検証根拠とし、contract欠落は引き続き
  `missing-tool`として停止する
- source/capability drift検査は`source`実装に限定する
- Memory seedの管理対象判定をWorkspaceとDoctorで共有し、`.DS_Store`を初期化、
  欠落診断、修復のすべてから除外する
- Codex固有条件をCoreへ追加せず、将来Harnessも同じ実装形態契約を使用する

修正後はsource test、native project layout test、実native binaryによるローカルRelease
受入を行い、両findingが解消したことを確認する。

## 15. Luna再レビューの追加是正

2026-08-19のLuna独立レビューで、前節の修正後にも次の検査・修復境界が残ることを
確認した。

1. Runtime ContractのCLI解析が変換前の`{{HARNESS_DIR}}/tools/aidlc-*.ts`形式だけを
   対象とし、配布後の`./<runtimeRoot>/tools/aidlc <noun> <command>`を検査しない
2. DoctorのProject Root修復が`String.replace`の置換文字列へpathを直接渡し、`$&`、
   ``$` ``、`$'`を置換tokenとして解釈する

追加是正では、Harness Descriptorのexecutable pathと統合CLI routeを用いてnative
呼び出しをtool contractへ対応付け、command、flag、`--result`を検査する。未知nounも
黙って無視しない。State fieldの置換は関数置換とし、Project Rootを文字どおり保持する。

このLunaレビュー対応自体にはAIDLC-006、Harness固有のDomain判断、過去Workflow改変を
含めない。AIDLC-006は次節の独立した追加承認に基づいて修正する。

## 16. AIDLC-006の追加是正

2026-08-19の追加承認により、本家由来のAIDLC-006だけを例外的に対象へ加えた。

- Build and Testのfrontmatter `produces`を正本とし、成果物名を
  `build-test-results.md`へ統一する
- Stage本文と`outputs`が正本から導かれる名前を参照することをStage loaderで検査する
- lintの適用対象はBuild and Testに限定し、他Stageの既存不整合を同時修正しない
- 意図的に旧名`test-results.md`へ戻したfixtureが失敗することを検証する
- Build and Testの実出力pathとCI Pipelineのconsume pathが一致することを検証する
- GraphとCodex配布物を再生成し、ローカルRelease受入まで確認する

この変更はHarness-neutralなStage loaderとStage定義に置き、Codex固有Adapterへ
成果物名判断を追加しない。将来のClaude Code、GitHub Copilot Adapterも同じCore契約を
利用する。
