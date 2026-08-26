# AI-DLC vNext 1.0.0 配布手順

## 配布するもの

GitHub ReleaseにはPOSIX／PowerShell bootstrap、schema 2 Distribution Manifest、Checksum、
5種類のGo CLIを置く。Codex Skillと固定10 Stage dataは同じtagの`dist/project/`から取得する。

```text
build/github-release/
├── install.sh
├── install.ps1
├── aidlc-distribution.json
├── SHA256SUMS
├── aidlc-darwin-amd64
├── aidlc-darwin-arm64
├── aidlc-linux-amd64
├── aidlc-linux-arm64
└── aidlc-windows-amd64.exe
```

Installerは全5 binaryをProjectへ格納するため、異なる対応OSでも同じProjectをcloneして使える。

## 利用者のインストール

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v1.0.0/install.sh
sh install.sh --harness codex --project .
```

Windows PowerShell:

```powershell
Invoke-WebRequest "https://github.com/sori883/aidlc/releases/download/v1.0.0/install.ps1" -OutFile "install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --harness codex --project .
```

InstallerはManifest、全file、全binaryの長さとSHA-256、host CLIの`--version`を確認してから
書き込む。HTTP failure、tamper、unsupported OS、unsafe path、symlink、user file conflictが
一つでもあればProjectを書き換えない。

## 開発者のRelease Gate

```bash
git ls-files -z -- '*.go' ':(exclude)work/**' | xargs -0 gofmt -w
go vet ./...
go test -count=1 ./...
go test -race -count=1 ./...
go run ./cmd/aidlc-dev bundle write --out dist/project
go run ./cmd/aidlc-dev bundle check --out dist/project
go run ./cmd/aidlc-dev package-release --out build/github-release
```

packagerは`CGO_ENABLED=0`、`-trimpath`、`-s -w`で固定5 Targetをbuildし、Mach-O／ELF／PE、
Go build info、16MiB Gate、native PATH-less smoke、checksum、固定Asset集合を検証する。
main Gateはdarwin-amd64、darwin-arm64、linux-amd64、linux-arm64、windows-amd64のnative
runnerでもCLIとInstaller／Release候補E2Eを成功させる。tag workflowは同commitのmain Gate成功を
確認するまで公開しない。

## 更新時の保護

```bash
./.codex/tools/aidlc update --harness codex --project .
./.codex/tools/aidlc doctor check .
```

`update`は前回記録したSHA-256と現在の内容が一致する管理対象だけを置き換える。変更済み・
未管理fileは削除しない。pre-vNext Workflow Stateは変換も削除もしない。

## 公開境界

`package-release`はlocal artifact生成までである。tag作成とGitHub Release公開は、Release Gate
完了後に別途明示的な承認を得て実施する。公開済みtagとAssetは差し替えない。

Go移行時のclean checkout rehearsal結果は
[`docs/aidlc-go-release-rehearsal.md`](aidlc-go-release-rehearsal.md)に記録している。
