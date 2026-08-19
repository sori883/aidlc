# AI-DLC v2 Bolt Core Contract

## 目的

本書は、Harnessに依存しないConstruction Boltの機械契約を固定する。
Codex、将来のClaude Code、GitHub Copilotはいずれもこの契約を利用し、
製品固有の質問表示、Agent起動、tool呼出しだけをAdapterで扱う。

## Bolt Plan

`inception/delivery-planning/bolt-plan.md`は、人間向け説明に加えて次のfenced
YAMLを一つ持つ。

```yaml
bolt_plan:
  version: 1
  worktree:
    enabled: true
    base_ref: main
    target_branch: main
    strategy: squash
  bolts:
    - id: B1
      slug: walking-skeleton
      units: [api, ui]
      depends_on: []
      walking_skeleton: true
      batch: 1
```

Coreは次を検査する。

- ID、slug、Units、依存Bolt、walking skeleton、batch以外のfieldを許可しない
- Worktreeの有効・無効、base ref、target branch、統合方式を機械的に固定する
- B1だけをwalking skeletonとし、依存なしの最初のbatchに置く
- Unit DAGの全Unitを少なくとも一つのBoltが参照する
- 不明なUnit、依存Bolt、自己依存、循環、重複ID・slugを拒否する
- cross-Unit依存は、同一Boltまたは推移的に先行するBoltで満たす
- 同じUnitが複数Boltに現れるthin sliceを許可する
- 宣言batchが依存関係から決まるbatchと一致する

正規化したPlanにはSHA-256 hashを付け、実行開始後のPlan driftを停止する。

## 実行State

State Version 8では、`aidlc-state.md`の人間向けfieldと、コメント境界内の
fenced JSONを同時に保持する。

```text
<!-- AIDLC_BOLT_STATE_START -->
...
<!-- AIDLC_BOLT_STATE_END -->
```

JSONが正本であり、人間向けfieldは同じ原子的更新で投影する。主要項目は次の
とおり。

- Plan hash
- Construction autonomy mode
- Boltごとのstatus、attempt、gate、failure
- Worktree pathと統合ref
- Worktree status（none、active、merged、preserved）
- Current Boltと次の決定的action

Stage 4では、同じUnitの過去Bolt完了を再利用しないため、Boltごとの3.1〜3.5と
Unit進捗をこのJSONへ追加する。既存のStage・Unit行は表示用投影とし、次の実行を
決める正本にはしない。

## Lifecycle

Bolt statusは次を取る。

- `pending`
- `running`
- `awaiting-gate`
- `awaiting-autonomy`
- `ready-to-complete`
- `completed`
- `failed`
- `skipped`
- `aborted`

B1は必ず最初に単独で開始する。3.1〜3.5完了後に一度だけgateへ進み、その承認後
に一度だけautonomy ladderへ進む。後続Boltは`autonomous`ならgate不要、`gated`
ならBoltごとにgateを必要とする。失敗時はmodeによらず停止し、人間の
`retry`、`skip`、`abort`を待つ。

全Boltが`completed`または人間が明示した`skipped`になるまで、3.6 Build and
Testと3.7 CI Pipelineは開始できない。

Worktreeが有効なPlanでは、Worktreeの作成と検証後だけBoltを開始できる。Bolt
gateが必要な場合は統合前に承認を取り、検証済みの統合commit refをStateへ記録
してからBoltを完了する。失敗、skip、abortではWorktreeを自動削除せず保存する。

## Auditと冪等性

一次Eventは次のとおり。

- `BOLT_STARTED`
- `BOLT_COMPLETED`
- `BOLT_FAILED`
- `AUTONOMY_MODE_SET`

Gateと人間回答は既存の`GATE_APPROVED`、`GATE_REJECTED`、
`QUESTION_ANSWERED`を利用する。EventはBolt IDとattemptで相関し、再開時に同じ
Eventを重複生成しない。Audit appendが失敗した場合はStateを書かない。

## 移行

- Construction開始前のState Version 7だけをVersion 8へ決定的に更新できる
- 3.1〜3.5が開始済みでBolt証跡がない旧Workflowはmanual migrationで停止する
- 完了済み旧WorkflowへBolt Eventや承認を遡及生成しない
- 実行開始後のBolt Plan変更は自動対応せず停止する

この保守的方針により、観測されていない成功、承認、UnitとBoltの対応を捏造しない。
