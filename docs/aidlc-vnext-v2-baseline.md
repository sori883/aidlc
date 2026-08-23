# AI-DLC vNext: v2 Baseline

## 1. 目的

vNext実装前の正常なv2を記録し、再利用できる実行機構と置き換えるWorkflow資産を
判断するための出発点を示す。この文書はv2 Workflowを残すための互換基準ではない。

## 2. 検証対象

| 項目 | 値 |
|---|---|
| 検証日 | 2026-08-23 |
| Repository | `/Users/const/sori883/aidlc` |
| Branch | `codex/aidlc-vnext` |
| Commit | `cb4f0db61fca711c3b49251370568f3013148f41` |
| Package version | `0.6.2` |
| Runtime | Bun `1.3.14` |
| 実装言語 | TypeScript |
| Harness | Codex |

検証開始時点のtrackedファイルに未コミット変更はなかった。既存の未追跡ファイルは
Baseline検証の対象外とし、削除、上書き、commitを行っていない。

## 3. 実行コマンド

```bash
bun run release:check
```

`release:check`は次を順番に実行する。

1. version整合性検査
2. TypeScript typecheck
3. Stage Graph再コンパイル検査
4. Runtime Contract検査
5. 全Bun test

## 4. 検証結果

| Gate | 結果 | Evidence |
|---|---|---|
| Version | PASS | version sourceは`0.6.2`で一致 |
| TypeScript | PASS | `tsc --noEmit`成功 |
| Stage Graph | PASS | コンパイル済みGraphは最新、32 Stage |
| Runtime Contract | PASS | 46文書を検査し成功 |
| Test | PASS | 45ファイル、243 pass、0 fail |

Baseline全体の結果は**PASS**である。

## 5. vNextへ回収する性質

次の性質はv2 Workflowとの互換機能ではなく、vNextの実行エンジンとして回収する。

- StateとAuditはDomain Coreだけが更新する
- State、Audit、Planから決定的に再開できる
- 不正なStage定義、Graph、Artifact参照はfail closedで停止する
- Codex HarnessはCoreの経路判断を変更しない
- Workspace、Space、Intent、Installer、native binary、Codex Bundleの実績ある機構を再利用する
- 回収した機構にはvNext向けのunit、failure、resume、E2E testを用意する

一方、次はvNextへ置き換え、最終的に削除する。

- v2の32 Stage Catalog、Stage Graph、Scope Grid
- StageごとのApproval Gateを前提にした遷移
- v2 Construction Bolt固有のWorkflow意味
- v2 Stageから生成したSkillとStage文書
- v2 Workflowを開始、選択、継続する互換経路

進行中v2 Intentの継続、自動移行、互換読み込みは要件に含めない。旧Stateを
vNextとして推測変換せず、Doctorがunsupportedとして再開始を案内する。

## 6. Baselineの限界

この検証は現行v2の回帰基準である。次はまだ検証していない。

- vNext単一Workflowの実行
- vNext 10 Stage Graph
- Core管理のStage Execution PlanとStage disposition
- Design Brief、Workspace Context、Effective Policyからの決定的なRoute解決
- AI内部loop、Bolt loop、Outcome loopの再開
- Core検証済み・人間承認済みBolt Plan
- Runnable Candidate、Human Feedback、Accepted Baseline

これらは共通Contractの承認後、M1以降で個別に実装して検証する。最終配布物は
vNext Workflowだけを含み、v2とvNextを選択する仕組みは持たない。
