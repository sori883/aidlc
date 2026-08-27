# Codex Human Approval Hook 実装計画（ST-HK-04）

## 承認状態

- 対象: Codex Harness の Human Input Receipt と Review Freeze
- 実装言語: Go 1.26.4
- 外部 Go module: 追加しない
- 承認: 2026-08-27 にユーザー承認済み
- 実装順: ST-HK-01 監査、ST-HK-02 Context 注入、ST-HK-03 Tool Guard に続く第4段階

## 目的

人間向けReviewを生成しただけ、チャットで承認らしい文章を観測しただけ、またはAIが
承認コマンドを組み立てただけでは、人間判断として扱わない。Coreが固定した対象と判断内容を
人間が確認し、Codexの`UserPromptSubmit` Hookが完全一致の確認入力を観測した場合だけ、
一度限り使用できるHuman Input Receiptを作る。

未解決のReview Freezeがある間は`Stop` Hookが`continue: false`を返し、AIによる承認待ちの
取りこぼしや自動続行を防ぐ。

## 実装範囲

1. 対象、Review、Gate Requirement Set、Graph、Plan revision、許可actionを固定するReview Freeze
2. AI提案のaction、reason、parameterを固定するDecision EnvelopeとHTML Review
3. Codex `UserPromptSubmit`から完全一致確認を受けるmetadata-only Human Input Receipt
4. Receiptのstale、改ざん、別対象、別action、再利用を拒否するProof
5. 人間判断ArtifactとReceiptを結ぶone-time Resolution
6. ST-04、ST-05、ST-07、ST-08、ST-09、Intent Riskへの統合
7. `human-gate status|prepare|apply`と旧直接承認経路の無効化
8. `Stop`による未解決Freezeの継続拒否
9. Doctor、Core Audit、配布、運用手順、異常系テスト

## 対象外

- Sensor実行、debounce、heartbeat
- `SubagentStop`を使う独立した継続制御
- 人間の法的本人確認、署名、外部Identity Provider連携
- Hookを提供しないHarnessへの移植

## 完了条件

- 通常プロンプトはReceiptを作らず、本文も保存しない
- 完全一致した`/aidlc-confirm`だけがReceiptを作る
- 改変した確認コード、古いFreeze、別Sessionからの重複Receipt、消費済みReceiptを拒否する
- ReceiptなしでStage/Riskの人間判断関数を呼べない
- 未解決Freeze中の`Stop`は`continue: false`、解決後は空のJSON objectを返す
- 人間判断Artifactが`human_input_receipt_ref`を持ち、Doctorが参照とhashを検証する
- `gofmt`、`go vet`、`go test`、race test、native build、5 target packageが成功する
- `/tmp`へ展開した配布ZIPでprepare、Hook Receipt、apply、Stop解除を再現できる

## 本家Issueから反映する失敗対策

- [Artifact verification #366](https://github.com/awslabs/aidlc-workflows/issues/366): Review対象を
  source pathだけでなくSHA-256とimmutable snapshotで固定する。
- [Stop bypass #427](https://github.com/awslabs/aidlc-workflows/issues/427): pending Freezeでは
  明示的に`continue: false`を返し、検証失敗時もfail closedにする。
- [Context clear skip #249](https://github.com/awslabs/aidlc-workflows/issues/249): 会話履歴でなく
  CoreのCurrent、Freeze、Graph version、Plan revisionを毎回再検証する。
