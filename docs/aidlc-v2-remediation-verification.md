# AI-DLC v2再実装バグ是正 検証結果

## 結果

2026-08-18に対象範囲の実装と検証を完了した。

- `bun run release:check`: 45 test file、234 test合格
- native binaryとPATHなしGitHub配布を含む重点suite: 7 file、51 test合格
- `bun run distribution:check`: `dist/project`同期済み
- `git diff --check`: 問題なし
- 判定対象WorkflowへのDoctor full audit: read-onlyで期待findingを検出

## 対象別の証明

| ID | 是正内容 | 主な自動検証 |
|---|---|---|
| AIDLC-001 | Bolt Plan、3.1〜3.5反復、B1 gate、autonomy、failure、resume、全Bolt後の3.6/3.7 | `aidlc-bolt.test.ts`、`aidlc-orchestrate.test.ts` |
| AIDLC-002 | checker `pass`を正本とする結果分類、trailing log、終端Event一意性 | `aidlc-sensor-runtime.test.ts` |
| AIDLC-003 | conditional consume、Review除外、hash-bound receiptとstale判定 | `aidlc-artifacts.test.ts`、`aidlc-sensor-runtime.test.ts` |
| AIDLC-004 再実装側 | Quality Gate ManifestとGitHub Actions意味検査 | `aidlc-quality-gate.test.ts` |
| AIDLC-005 | Doctor structural/execution health分離、横断full audit | `aidlc-doctor.test.ts` |
| AIDLC-006 | Build/Test成果物名を`build-test-results.md`へ統一し、Stage本文・frontmatter・Graph・CI consumeの不一致を拒否 | `aidlc-stage-loader.test.ts`、`aidlc-artifacts.test.ts` |
| AIDLC-007 再実装側 | lock内timestamp、sequence、clone順序、移設修復、`[S]` | `aidlc-audit-ordering.test.ts`、`aidlc-state.test.ts`、`aidlc-doctor.test.ts` |

## Harnessと配布

- Coreの状態遷移はCodex lifecycle操作やpayloadへ依存しない
- fake HarnessとCodex Descriptorが同じCore契約へ適合する
- 未実装Harness IDは黙ってCodex扱いせずunsupportedで停止する
- Codex bundleへCore、contract、Skill annexを配布する
- native binaryをproject-localで実行できる
- GitHub配布版はruntimeのPATHにBun、Node、npm、Gitがなくても導入・実行できる

主な検証は`aidlc-harness-contract.test.ts`、`aidlc-codex-bundle.test.ts`、
`aidlc-binary.test.ts`、`aidlc-github-distribution.test.ts`で行った。

## 実Workflowのread-only診断

`/Users/const/sori883/ai-dlc-cycle/05.ai-dlc-test`へDoctor `--full`を適用し、
次のhistorical inconsistencyを検出した。

- Bolt開始・完了Eventがともに0件
- Construction autonomyが`unset`
- Sensor budget overrideが21/179で、hash-bound receiptがない
- State Project Rootが移設前path
- 完了したCI PipelineにQuality Gate Manifestがない

Doctorはこれらを診断しただけで、対象WorkflowへEvent、承認、autonomy、receiptを
追加していない。

## 継続している対象外

- 過去MVPの不正なCIファイルを直接修正していない
- 過去WorkflowのState、Audit、成果物を書き換えていない
- Claude Code、GitHub Copilot Adapterそのものは実装していない

将来Harnessは既存Coreを変更せず、Descriptor、Directive Adapter、配置、能力fallback、
共通conformance testを追加して対応する。

## 2026-08-19 ローカルRelease再受入

初回受入で検出したnative Runtime Contractと`.DS_Store`誤診断を修正し、
`/Users/const/sori883/ai-dlc-cycle/06.ai-dlc-test2`を空の状態から再試験した。

- `bun run release:check`: typecheck、Graph、Contract、45 file、237 test合格
- 配布関連重点suite: 7 file、41 test合格
- `bun run distribution:check`: `dist/project`同期済み
- darwin-arm64 native Release生成と全SHA-256検証: 合格
- local HTTP transport経由のdry-run、新規install: 合格
- PATHなしのversion、Graph、native Runtime Contract: 合格
- Workspace初期化、POC Intent birth、State resume、Orchestrator next: 合格
- Doctor `--full`: structural/executionともにhealthy
- `.codex/memory/.DS_Store`を後から配置したDoctor回帰: healthy、Workspaceへ複製なし
- idempotent update: written 0、conflict 0
- `AGENTS.md`変更時のupdate: conflictで停止し、native binaryを不変に保持
- 競合fixture除去後のupdate、Contract、Doctor再検査: 合格

ローカルRelease受入判定は合格。公開、tag、push、deployは実施していない。
この再受入時点ではAIDLC-006および過去WorkflowのState、Audit、成果物を変更していない。

## 2026-08-19 Lunaレビュー指摘のクローズ

Luna独立レビューの2 findingを追加修正し、次を確認した。

- native統合CLIをHarness executable pathとrouteから解析する
- native文書の不正command、flag、`--result`をそれぞれContract findingにする
- fake Harness executable pathでも同じ解析を行う
- Project Rootに`$&`、``$` ``、`$'`が同時に含まれても文字どおり修復する
- StateのProject Root以外は変更しない
- 重点suite: 7 file、42 test合格
- `bun run release:check`: typecheck、Graph、Contract、45 file、239 test合格
- darwin-arm64 native Releaseと全SHA-256: 合格
- `06.ai-dlc-test2`のnative更新: 1 file更新、176 file不変
- 実native negative fixture: missing-command、missing-flag、missing-resultの3 finding、
  終了コード1
- fixture除去後の更新: 0 file更新、177 file不変
- 最終native Contract: 46文書でvalid
- 最終Doctor `--full`: structural/executionともにhealthy

negative fixtureは検査後に削除した。公開、tag、push、deployは実施していない。

## 2026-08-19 AIDLC-006追加是正

追加承認されたAIDLC-006について、次を確認した。

- Build and Testの`produces`、`outputs`、本文、Stage Graphを
  `build-test-results.md`へ統一
- CI Pipelineの`consumes: build-test-results`と実際の解決pathが一致
- `outputs`または本文を旧名`test-results.md`へ戻したfixtureはStage lintで失敗
- lintはBuild and Testだけへ適用し、他Stageの既存不整合は変更していない
- `bun run distribution:check`: `dist/project`同期済み
- `bun run release:check`: typecheck、Graph、Contract、45 file、243 test合格
- darwin-arm64 native Release生成、全SHA-256、native `--version`: 合格
- `06.ai-dlc-test2`のlocal HTTP更新: Stage定義、Graph、native binaryの3 file更新、
  174 file不変、競合0
- 配布先のGraph、Runtime Contract、Doctor `--full`: 合格、structural/executionともにhealthy
- 配布先Build and Testから独立した旧名`test-results.md`参照が消えている
- 再度のidempotent update: 0 file更新、177 file不変、競合0

既存WorkflowのState、Audit、生成済み成果物は変更していない。公開、tag、deployは
実施していない。
