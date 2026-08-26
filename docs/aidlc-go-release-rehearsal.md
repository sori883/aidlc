# AI-DLC Go Release Rehearsal Evidence

## 結論

Go移行計画のStage 8 release rehearsalは成功した。GitHubへpush済みのclean commitから、
固定5 Targetのnative CLI、schema 2 Manifest、Installer、Project Git round trip、固定9 Assetを
再構成できる。PR merge、tag作成、GitHub Release作成／公開は実施していない。

## Sourceと環境

- Branch: `codex/go-runtime-migration`
- clean checkout: `77da14306108e4740c3288a348d3f58059239e68`
- clone source: `https://github.com/sori883/aidlc.git`
- local host: Go 1.26.4、darwin-arm64
- Stage 7 remote Gate: GitHub Actions run `32950628084`
- 外部Go module: なし

Repository外の一時directoryへremote branchをfresh cloneし、HEAD完全一致と開始時／終了時の
`git status --short --untracked-files=all`が空であることを確認した。Go build cacheとtest tempも
同じRepository外の一時領域へ置いた。検証後の一時成果物は削除せずmacOS Trashへ移したため、
Repositoryや利用者のProjectには残していない。

## Clean checkout Gate

fresh clone内で次を成功させた。

```bash
git ls-files -z -- '*.go' ':(exclude)work/**' | xargs -0 gofmt -l
go vet ./...
go test -count=1 ./...
go test -race -count=1 ./...
go run ./cmd/aidlc-dev bundle check --out dist/project
```

通常・race testはいずれも、fresh install、idempotent update、bootstrap installer、全5 binary
checksum、installed launcherのPATHなし`--version`、conflict／tamper／symlink拒否を含む。

## Project cloneとnative Target

`stage2-poc --target all`で全5 Targetをbuildし、一時Projectへ配置して`git add`、commit、cloneを
行い、clone先のdarwin-arm64 CLIをPATHなしで実行した。

| Target | Format | Bytes | native smoke |
|---|---:|---:|---:|
| darwin-amd64 | Mach-O | 8,963,584 | remote run成功 |
| darwin-arm64 | Mach-O | 8,191,138 | local／remote成功 |
| linux-amd64 | ELF | 8,798,370 | remote run成功 |
| linux-arm64 | ELF | 8,061,090 | remote run成功 |
| windows-amd64 | PE | 9,055,232 | remote run成功 |

`git_round_trip`は`true`で、全binaryは16MiB未満である。remote run `32950628084`では各Targetの
native runner上で同じCLI proofとInstaller／Release候補E2Eが成功した。

## Release candidate整合性

clean checkoutから生成したManifest SHA-256は次のとおりである。

```text
7b691c07ba56ad394779f636401fb69c0aa12e753463d088a96206745c049b19
```

Release Asset集合は次の9個に固定される。

```text
SHA256SUMS
aidlc-distribution.json
aidlc-darwin-amd64
aidlc-darwin-arm64
aidlc-linux-amd64
aidlc-linux-arm64
aidlc-windows-amd64.exe
install.ps1
install.sh
```

`SHA256SUMS`の8 entryを`shasum -a 256 -c`で再検証した。Checksum file自身を除く全Assetを
pinしている。versionはCLI、Manifest、tag candidateのすべてで`1.0.0`／`v1.0.0`に一致した。

同じclean commitから別output directoryへ候補を再生成し、上記9 Assetがすべてbyte一致する
ことを確認した。Stage 7のcommit前local候補はGo build infoに`vcs.modified=true`と旧HEADを
埋め込むためdigestが異なる。clean `77da143`同士は同一digestとなる。本書のdigestは
`77da143` rehearsal candidateのEvidenceであり、実際の公開Assetは承認された最終tag commitから
再生成して、そのChecksumを正とする。

## Immutable boundary

- 同じnon-empty output directoryへの2回目のpackagingはfail closedで拒否した
- Release workflowはglobではなく固定9 Assetだけをuploadする
- Release workflowは同名GitHub Releaseが既に存在する場合に停止する
- main Gateも全5 native runnerのCLI／Installer proofを要求する
- tagがGo versionと一致し、tag commitがmainに含まれ、同commitのmain Gateが成功するまで停止する
- 既存tag／Assetを上書きする経路は用意しない

本リハーサルはlocal candidate生成と検証までである。Draft PR #26はmergeせず、`v1.0.0` tagと
GitHub Releaseも作成／公開していない。
