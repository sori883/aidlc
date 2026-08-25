# AI-DLC vNext 開始・再開・障害対応

## 開始

プロジェクト直下で次を実行する。

```bash
./.codex/tools/aidlc workspace init .
./.codex/tools/aidlc intent list . --json
./.codex/tools/aidlc intent birth . "短い目的"
./.codex/tools/aidlc next .
```

既知のIntentリスクがある場合は、確認済みのJSON配列を渡す。

```bash
./.codex/tools/aidlc intent birth . "短い目的" --risk-file risks.json
```

`next`が返すStageはCoreが固定CatalogとGraphから決める。AIや人間が任意の
次Stageを入力する操作はない。

## 再開

```bash
./.codex/tools/aidlc state resume .
./.codex/tools/aidlc next .
```

`approval`、`decision`、`parked`が返った場合は、表示された理由と再開条件を
人間へ示して停止する。承認を推測しない。

## Risk Register

```bash
./.codex/tools/aidlc intent risk show .
./.codex/tools/aidlc intent risk propose . risk-proposal.json
./.codex/tools/aidlc intent risk decide . human-risk-decision.json
```

AI proposalはリスク追加とseverity上昇だけを行える。低下、dismiss、resolveは
理由とEvidenceを持つ人間Decisionだけが行える。Currentやrevisionを直接編集しない。

## Human Gate

ST-04、ST-05、ST-07、ST-08、ST-09では、Policy追加確認がある場合に生成されたHTMLを開き、対象SHA-256と
Policy追加確認を人間へ示す。追加確認がある場合は、全requirement IDについて
次の配列を作り、各承認コマンドへ渡す。

```json
[
  {
    "requirement_id": "rule-id:risk-id",
    "acknowledged": true,
    "reason": "人間が確認した内容"
  }
]
```

Risk Registerが更新された後の古い確認表は使えない。新しいReviewを生成して
再確認する。

ST-04は通常どおり`architecture complete`を先に実行する。CoreがPolicy承認を
要求した場合だけ、同じ提案をReviewし、表示されたSHA-256を人間承認へ固定する。

```bash
./.codex/tools/aidlc architecture policy-review . architecture-proposal.json
./.codex/tools/aidlc architecture policy-approve . sha256:... "人間の理由" policy-acknowledgements.json
```

## 診断

```bash
./.codex/tools/aidlc doctor check .
```

改ざん、hash不一致、外部Target drift、StateとPlanの不一致はfail closedになる。
`doctor repair`が直すのは人間向けStateミラーだけで、正本JSONやEvidenceは直さない。

## 配布前Quality Gate

```bash
bun run version:check
bun run typecheck
bun run graph:check
bun test
bun run bundle:check
bun run distribution:check
bun run binary:build
```

一つでも失敗した場合はRelease候補にしない。
