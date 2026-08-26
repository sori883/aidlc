# AI-DLC Go Cutover Evidence

## 対象とrollback境界

- Branch: `codex/go-runtime-migration`
- Stage: Stage 7（Production cutover）
- Cutover直前commit: `c34f7fca452695b1957edc2e361ab5af32b8837c`
- Cutover commit: `92517d7042ce66013806ce1ce662d59fa5129e34`
- Native E2E timeout修正commit: `77da14306108e4740c3288a348d3f58059239e68`
- Stage 6 remote Gate: GitHub Actions run `32947254181`、全job成功
- Stage 7 remote Gate: GitHub Actions run `32950628084`、全job成功
- Toolchain: Go 1.26.4
- 外部Go module: なし

`c34f7fc`はGo Installer／Distributionと旧Production Runtimeが共存する独立rollback点である。
Stage 7の削除はこのcommitより後だけに置き、Stage 0 baseline
`c6d67dc5fb32ca2e93869079d36d8769f69217d0`も変更していない。

## 削除前レビュー

TypeScript／Bun削除前に次を確認した。

| 削除条件 | Evidence |
|---|---|
| 全CLI routeがGoに存在 | `help --all`、CLI unit test、Stage 2 native proof |
| ST-00〜ST-09 normal／failure／resume | `internal/stage`の通常・race test |
| differential parity | Stage 5／6直前のGo testとBun 209 test、Stage別parser parity |
| 既存vNext Workspace | Repository rootには既存Workspaceなし。未初期化をDoctorがfail closedし、一時ProjectのDoctor E2Eはhealthy |
| Installer安全性 | fresh、idempotent、update、conflict、tamper、symlink、bootstrap E2E |
| 5 Target native smoke | run `32947254181`のdarwin／linux／windows全runner |
| binary size | 全5 Targetが16MiB未満 |
| Project Git round trip | Stage 2 native proofのgit add／commit／clone／native実行 |
| Runtime参照整合 | Harness source、Agent、現行docs、CI、Release workflow、`dist/project`をGo commandへ更新 |
| rollback可能commit | `c34f7fc` |
| 削除承認 | 2026-08-26に本PR内の全Stage実施を追加承認不要で許可された |

削除直前のlocal Gateでは`go vet ./...`、通常・race Go test、既存Bun 209 test、
旧bundle／distribution checkが成功した。Stage 6 remote GateではGo／TypeScript qualityと
全5 native Installer proofが成功した。

## Cutover変更

- Production CLI helpへ`install`／`update`を公開した
- Harness sourceの全commandを`./.codex/tools/aidlc`へ変更した
- `dist/project`をschema 2 Go bundleへ再生成した
- POSIX launcherと全5 binary Project pathをlayout Manifestへ固定した
- main／PR／tag CIをGo 1.26.4のformat、vet、test、race、native build、bundle、packagingへ変更した
- GitHub Release workflowを固定9 AssetのGo packagerへ変更した
- README、operations、Stage Contract、Installer／Release docs、Release NotesをGo正本へ更新した
- Serenaの解析言語をGoへ変更した
- tracked TypeScript／JavaScript 133 fileと、旧generated bundleを含む計184 fileを削除した
- `package.json`、`bun.lock`、`tsconfig.json`、Node Installerを削除した

`docs/bun-migration-plan.md`と過去Milestone／Stage Evidenceにある旧Runtime記述は、
supersededまたは履歴Evidenceと明記して保持した。現行手順としては参照しない。

## Cutover後のlocal Gate

次を成功させた。

```bash
go vet ./...
go test -count=1 ./...
go test -race -count=1 ./...
go run ./cmd/aidlc-dev bundle check --out dist/project
go run ./cmd/aidlc-dev package-release --out build/stage7-release
sh -n installer/install.sh
git diff --check
```

`go list -m all`は`github.com/sori883/aidlc`だけである。Release候補は固定9 Asset、
native smoke成功、Manifest SHA-256
`d709a8a1f036840f4962b9183ecb429c9d0007878258306eead207302b989818`となった。
これはcommit前のlocal候補で、Go build infoは`c34f7fc`、`vcs.modified=true`を記録している。
clean checkoutから作るrehearsal候補のdigestはStage 8 Evidenceを正とする。

| Target | Format | Bytes |
|---|---:|---:|
| darwin-amd64 | Mach-O | 8,963,584 |
| darwin-arm64 | Mach-O | 8,191,138 |
| linux-amd64 | ELF | 8,798,370 |
| linux-arm64 | ELF | 8,061,090 |
| windows-amd64 | PE | 9,055,232 |

最初のcutover run `32949886440`ではmacOS Intelの全5 Target cross-buildがtestの2分上限を
超えたため、Production処理を変えずE2E contextだけをCLIと同じ5分へ修正した。再実行run
`32950628084`ではGo qualityとdarwin-amd64、darwin-arm64、linux-amd64、linux-arm64、
windows-amd64の全native CLI／Installer proofが成功し、G7を完了した。

tag作成、GitHub Release作成／公開、PR mergeは実施していない。
