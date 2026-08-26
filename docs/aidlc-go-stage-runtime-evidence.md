# Go Stage Runtime移行Evidence

## 1. 対象

本書はGo移行計画のStage 5で、ST-00からST-09までのRuntimeをTypeScript基準から
Goへ移植した検証記録である。Production launcher、Installer、配布物はこのStageでは
切り替えていない。実装はGo標準ライブラリだけを使用し、外部Go moduleは追加していない。

## 2. 実装境界

- 各StageのWork Request、Proposal、承認、Current、immutable revisionをGoの型とvalidatorで固定した
- 既存Artifactはraw bytesのSHA-256を検証してからstrict JSONとして読む
- currentとimmutable revisionの内容不一致、参照先改変、source baseline driftをfail closedで拒否する
- Stage遷移はStage packageから直接決定せず、Core-owned State／Plan更新とOrchestratorを経由する
- CLIの公開route、引数順、helpはTypeScript統合CLIと一致させた
- CLIとOrchestratorのmutation routeはreentrant Workspace lock内で実行する
- Doctorは完了済みST-00〜ST-09のcurrentと参照chainをread-onlyで検証する

## 3. Stage別Evidence

| Stage | TypeScript比較基準 | Go normal／failure／resume Evidence | Differential parser |
|---|---|---|---|
| ST-00 Bootstrap | `aidlc-vnext-bootstrap.ts` | canonical Receipt、Policy改変／Repository欠落、途中再開 | `parseBootstrapReceipt` |
| ST-01 Orient | `aidlc-vnext-orient.ts`／`aidlc-vnext-orient-contract.ts` | Map／Context確定、Profile改変／invalid Proposal、Work Request再利用 | `parseOrientProposal` |
| ST-02 Define Intent | `aidlc-vnext-define-intent.ts`／contract | Intent Definition確定、Work Request改変／invalid Proposal、Work Request再利用 | `parseIntentDefinitionProposal` |
| ST-03 Requirements | `aidlc-vnext-requirements.ts`／contract | Requirements確定、Work Request改変／invalid Proposal、Work Request再利用 | `parseRequirementsDefinitionProposal` |
| ST-04 Architecture | `aidlc-vnext-architecture.ts`／contract | execute／reuse／not_applicableとPolicy Gate、Work Request改変／invalid Proposal、再利用 | `parseArchitectureAssessmentProposal` |
| ST-05 Build Contract | `aidlc-vnext-build-contract.ts`／contract | execute／reuse／not_applicableとhuman approval、改変／invalid Proposal、再利用 | `parseBuildContractProposal` |
| ST-06 Build & Converge | `aidlc-vnext-build-converge.ts`／contract | isolated worktree、verifier、Candidate生成、契約外変更と同一失敗3回block、Session再利用 | `parseRunnableCandidate` |
| ST-07 Human Review | `aidlc-vnext-review.ts`／contract | exact Manifest approval／feedback route／skip、Manifest改変、pending review再利用 | `parseCandidateReviewDecision` |
| ST-08 Release | `aidlc-vnext-release.ts`／contract | Plan review、exact authority、Git promotion／reuse／skip、baseline drift／改変、attempt再開とrollback | `parseReleasePlanProposal` |
| ST-09 Outcome | `aidlc-vnext-outcome.ts`／contract | achieved自動完了、人間判断、複数観測cycle／reuse、改変／invalid Proposal、Work Request再利用 | `parseOutcomeEvaluationProposal` |

決定的fixtureと主要なE2Eは`internal/stage/stage_e2e_test.go`、build／review／release／outcomeの
E2Eは`internal/stage/stage_build_release_test.go`に置いた。TypeScript parser差分testは、Goが
生成したJSONをBun上の既存parserへ入力し、parse後の意味JSONが一致することを検査する。
ST-00固有のcanonical／tamper／resume testは`internal/stage/st00bootstrap/bootstrap_test.go`、
ST-08のforce-with-lease rollbackは`internal/stage/st08release/release_test.go`で直接検査する。

## 4. ローカルGate結果

2026-08-26、Go 1.26.4 darwin/arm64とBun 1.3.14で次を実行し、すべて成功した。

- `gofmt`差分なし
- `go vet ./...`
- `go test -count=1 ./...`
- `go test -race -count=1 ./...`
- `bun run release:check`（既存TypeScript 209 testを含む）
- `bun run bundle:check`
- `bun run distribution:check`
- `go run ./cmd/aidlc-dev stage2-poc --target all --output build/stage5-gate`

5 Target binaryはすべてGo 1.26.4、`CGO_ENABLED=0`、`-trimpath`、release用strip flagsで
生成し、format、build info、16MiB未満を検証した。

| Target | Format | Bytes |
|---|---|---:|
| darwin-amd64 | Mach-O | 8,871,584 |
| darwin-arm64 | Mach-O | 8,106,674 |
| linux-amd64 | ELF | 8,700,066 |
| linux-arm64 | ELF | 7,930,018 |
| windows-amd64 | PE | 8,960,000 |

Projectへ全5 Targetを配置したGit add／commit／clone round trip、darwin-arm64のPATH-less
native smoke、公開CLIのTypeScript差分も成功した。生成物はignore済み`build/`だけへ出力し、
追跡対象へ追加していない。

## 5. Stage 5完了判定

- ST-00〜ST-09のnormal／failure／resume経路: 成功
- TypeScript parser differential parity: 成功
- 完了後のGo Doctor: healthy
- 既存TypeScript／Bun Gate: 維持して成功
- Production launcher／Release経路: 未変更
- Installer／Distribution切り替え: Stage 6へ保留

remote Gateは同一Draft PRで確認し、成功後にG5を完了とする。
