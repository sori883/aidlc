# AI-DLC v2 本家準拠ベースライン

## 1. 固定した準拠元

Stage 0では、次のローカルスナップショットを今回の再実装バグ是正における
本家AI-DLC v2の準拠元として固定する。

| 項目 | 固定値 |
|---|---|
| 親repository | `https://github.com/sori883/ai-dlc-cycle.git` |
| 親commit | `6a8a8129446bd8df59edcc47d519ebccfcae793d` |
| commit日時 | `2026-08-17T22:34:59+09:00` |
| commit subject | `Initial AI-DLC cycle snapshot` |
| 本家snapshot path | `02.本家ai-dlc` |
| snapshot subtree | `c5ffd3b32a5d8ea2947e16416f38ab85c6b292c4` |
| ローカルpath | `/Users/const/sori883/ai-dlc-cycle/02.本家ai-dlc` |

今回の判断に直接使う主要ファイルもhashで固定する。

| ファイル | SHA-256 |
|---|---|
| `.codex/tools/aidlc-bolt.ts` | `ca88170318e2d11e4ac86ccb8ea9c070a2dc12076a3d86789cbaecff9d082c48` |
| `.codex/tools/aidlc-sensor.ts` | `d848f5c607e4ab3b613d108d3a0a14d58db38abf0e309ad57e69a37d4189825a` |
| `.codex/aidlc-common/protocols/stage-protocol.md` | `f803e1cf2b9482ae089e5685e26543852d7179403d8bbbba8b9d2b5cd32a7f78` |

このスナップショットには「Harnessが変わってもCore Engine、State、Audit、
Refereeは同じで、Harness shellだけを差し替える」という方針がある。したがって、
今回の新規ロジックはHarness-neutralなCoreへ置き、Codex固有処理をAdapterへ隔離する。

## 2. Stage 0で解消した仕様差

本家のprotocolとBolt toolは、次を同じ意味で定義している。

- 1 BoltはConstruction Stage 3.1〜3.5の一周である
- Stage 3.6 Build and Testと3.7 CI Pipelineは、全Bolt完了後に一度ずつ実行する
- 最初のwalking skeletonは常にgateする
- walking-skeleton gate後、ladderを一度だけ提示する
- autonomyは`autonomous`または`gated`としてStateとAuditへ同時に記録する
- Bolt失敗時はautonomyにかかわらず停止し、retry、skip、abortを人間へ提示する
- Bolt lifecycleの一次Eventは`BOLT_STARTED`、`BOLT_COMPLETED`、
  `BOLT_FAILED`、`AUTONOMY_MODE_SET`である
- abortは新しいEventを増やさず、`BOLT_FAILED`のreasonで区別する

現行再実装の記述や動作がこれと異なる部分は再実装側のdriftとして扱う。
当初対象の6件には、実装前に追加判断が必要な未解決差分はない。AIDLC-006は
2026-08-19の追加承認により、判定書の修正確認条件を準拠基準として対象へ加えた。

## 3. 対象別の観測可能な互換契約

| ID | 本家または判定書から固定する期待値 | 今回の実装境界 |
|---|---|---|
| AIDLC-001 | Boltは3.1〜3.5。B1 gateとladderは各一度。開始、完了、失敗、autonomyがState/Auditに残り、全Bolt後だけ3.6/3.7へ進む | Core Bolt command、State/Audit、resume、Codex Adapter接続 |
| AIDLC-002 | 有効なchecker結果の`pass:false`は`SENSOR_FAILED`。実行不能またはprotocolを評価できない場合だけbudget override | process出力解析と終端Event分類 |
| AIDLC-003 | `conditional_on`で適用入力だけを検査し、Review sectionだけをclaim対象外にする。古いpassを現在の証跡として使わない | 入力選択、Review除外、receipt/hash |
| AIDLC-004 | 品質宣言と生成CIの不一致を検出する。生成されたMVPのCI自体は変更しない | Quality Gate Manifestと検査器 |
| AIDLC-005 | 構造上validでも、Bolt証跡欠落、Sensor異常、CI不一致などをexecution unhealthyとして検出する | Doctor full audit |
| AIDLC-006 | Build and Testの成果物名を`build-test-results.md`へ統一し、Stage本文とfrontmatterの不一致をlintで拒否する | Build and Test Stage、Stage artifact filename lint、Graph/配布物 |
| AIDLC-007 | lock取得後のAudit順序、移設可能なpath、skip表示を再現可能にする。過去Workflowを書き換えない | Audit sequence、root repair、`[S]`表示 |

AIDLC-006のlintはBuild and Testに限定する。全Stageへの一括適用や、判定書で別IDに
分類される既存の成果物名不整合は対象へ含めない。

## 4. Golden Trace

### 4.1 正常系

次の順序を論理Traceとして固定する。同一ステップ内のworktree補助Eventは、
対応するBolt Eventとの相関を保つ。

| 順序 | Core action / Directive | State | 必須Audit |
|---:|---|---|---|
| 1 | B1を選択し、`run-stage`または`dispatch-subagent`で3.1〜3.5を開始 | Current Bolt=`B1`, status=`running` | `BOLT_STARTED(B1, walking_skeleton=true)` |
| 2 | B1の3.1〜3.5を完了 | B1の実行結果を保持 | まだ`BOLT_COMPLETED`にしない |
| 3 | `present-gate`でwalking-skeleton gateを提示 | gate待ちを永続化 | 通常のgate Event |
| 4 | gate承認後、`ask`でladderを一度だけ提示 | ladder待ちを永続化 | 承認Event |
| 5 | autonomy回答をCore commandへ渡す | Construction Autonomy Mode=`autonomous`または`gated` | `AUTONOMY_MODE_SET` |
| 6 | B1を完了 | B1=`completed`, Current Boltを解除 | `BOLT_COMPLETED(B1)` |
| 7 | 依存を満たす後続Boltを順次またはbatchで実行 | 各Bolt=`running`から`completed` | Boltごとに対応する`BOLT_STARTED`、`BOLT_COMPLETED` |
| 8 | 全Bolt完了を確認 | 全Bolt=`completed` | 未完了Bolt Eventなし |
| 9 | `run-stage`で3.6 Build and Testを一度実行 | Current Stage=`3.6` | 通常のStage Event |
| 10 | `run-stage`で3.7 CI Pipelineを一度実行 | Current Stage=`3.7` | 通常のStage Event |
| 11 | Constructionをverifyして次Phaseへ進む | Construction=`completed` | 通常のPhase/Stage Event |

Invariant:

- B1 gate前に後続Boltを開始しない
- ladder回答前に後続Boltを開始しない
- 全Bolt完了前に3.6または3.7を開始しない
- B1 gate、ladder、autonomy Eventはそれぞれ一度だけ
- 各開始済みBoltは一つの完了または未解決失敗状態を持つ
- AdapterがStateやAuditを直接編集しない

### 4.2 失敗系

| 順序 | Core action / Directive | State | 必須Audit |
|---:|---|---|---|
| 1 | Boltを開始 | status=`running` | `BOLT_STARTED` |
| 2 | 3.1〜3.5の処理が失敗 | status=`failed-awaiting-choice` | `BOLT_FAILED` |
| 3 | `ask`でretry、skip、abortを提示 | choice待ちを永続化 | 人間回答前に完了Eventを出さない |
| 4a | retry | 同じBoltを再実行可能状態へ戻す | 新しい試行と相関する開始Event |
| 4b | skip | Bolt=`skipped`、表示は`[S]` | skipの理由と人間回答を記録 |
| 4c | abort | Workflowを停止し、worktreeは明示選択なしに破棄しない | `BOLT_FAILED` reason=`aborted` |

Invariant: retry、skip、abortが選ばれるまで後続Boltや3.6へ進まない。

### 4.3 Resume系

次のcheckpointから再開できることを固定する。

1. B1の3.1〜3.5実行途中
2. B1 gate待ち
3. ladder回答待ち
4. 後続Bolt実行途中
5. failure選択待ち
6. 全Bolt完了後、3.6開始前

resume時は、既存のStateとAuditから次のactionを一意に決める。同じ
`BOLT_STARTED`、B1 gate、ladder、`AUTONOMY_MODE_SET`、人間質問を重複させない。

### 4.4 Sensor終端Trace

各`SENSOR_FIRED`のFire IDには、次のいずれか一つだけを対応させる。

| checker観測結果 | 終端Event |
|---|---|
| 有効なJSON、`pass:true` | `SENSOR_PASSED` |
| 有効なJSON、`pass:false` | `SENSOR_FAILED` |
| timeout、spawn失敗、または有効なchecker protocolを取得不能 | `SENSOR_BUDGET_OVERRIDE` |

stdoutのJSONより後にpackage managerの補助行が出ても、最後の有効なJSON objectを
採用する。exit codeだけで`pass:false`をbudget overrideへ変換しない。1 Fire IDに
複数の終端Eventを記録しない。

### 4.5 DoctorとAudit Trace

- Doctorは`structural health`と`execution health`を別々に返す
- Bolt Planがある完了WorkflowにBolt Eventがなければexecution unhealthyとする
- Construction完了時にautonomyが`unset`ならexecution unhealthyとする
- Sensor receiptのhashが現在の入出力と一致しなければstaleとする
- Quality Gate ManifestとCIの不一致をfindingにする
- Project Root移設をfindingにし、安全なroot更新以外を推測修復しない
- Audit timestampとsequenceはworkspace lock取得後に確定する
- 同一workspaceではsequenceを重複、逆転させない

## 5. Directive互換方針

固定した本家のDirective unionは、Bolt専用kindを持たない。今回もBolt専用の
Harness操作をCore公開契約へ追加せず、既存の`run-stage`、`dispatch-subagent`、
`invoke-swarm`、`present-gate`、`ask`、`print`、`error`、`done`、`parked`を使う。

Bolt lifecycleはHarness-neutralなCore commandが所有し、Adapterは上記Directiveを
Harness操作へ変換する。この境界により、CodexのSkillやHookをClaude Codeや
GitHub Copilotへ透過的に流用しようとせず、同じCore Traceへ別Adapterを接続できる。

## 6. Stage 0完了判定

- 準拠元commit、subtree、主要ファイルhashを固定した
- 当初対象6件のState、Audit、Directive、終端分類を定義した
- Bolt 3.1〜3.5と集約Stage 3.6〜3.7を本家で確認した
- 当初対象6件の未解決仕様差は0件である
- 追加承認されたAIDLC-006の成果物名契約と限定的lint境界を明記した

以上により、承認済み計画のStage 1へ進行できる。
