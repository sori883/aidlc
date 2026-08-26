# AI-DLC Go Installer／Distribution Evidence

## 対象

- Branch: `codex/go-runtime-migration`
- Stage: Stage 6（Installer／Distribution）
- Toolchain: Go 1.26.4 darwin/arm64、Bun 1.3.14
- Module: `github.com/sori883/aidlc`
- 外部Go module: なし

本Evidenceは、Go版Installer、Codex Project bundle、5 Target配布契約、
GitHub Release候補生成を検証した結果である。tag作成、GitHub Release公開、
Production CLIの切り替えはStage 6に含めていない。

## 配布契約

Distribution Manifestは`aidlc-github-distribution` schema 2とした。旧Bun版の
host binary 1本だけを導入する契約から、異なるOSで同じProjectをcloneして使えるよう、
次の情報を固定する必要があるためである。

- 初期対応5 Targetの完全な行列と順序
- Release Asset名とProject内配置先
- GOOS／GOARCHとMach-O／ELF／PE形式
- 各binaryおよび各Project fileのbyte長とSHA-256
- POSIX target selectorとWindows executable

Installation Manifestは既存schema 1を読み取り可能なままschema 2を書き、更新互換を
維持する。Project layout Manifestもschema 2とし、launcher、全5 binary、Core、Harnessの
配置を宣言する。Manifestの未知field、危険path、重複、並び替え、16MiB以上のbinary、
TypeScript file、`aidlc/` Workspace管理をfail closedで拒否する。

## Installer安全境界

POSIX `install.sh`とWindows `install.ps1`は、`SHA256SUMS`とhost用Go CLIだけを取得し、
SHA-256確認後に`aidlc install`へ制御を渡す。Go Installerは次の順序を固定する。

1. `SHA256SUMS`でDistribution Manifestを検証する
2. strict JSONとしてschema 2 Manifestを検証する
3. Project fileと全5 binaryをbyte長・SHA-256付きで取得する
4. host binaryをPATHなしで`--version` smokeする
5. 既存Installation Manifestと現在のfile hashから更新計画を作る
6. 書き込み直前に再計画し、driftまたはconflictがあれば無変更で停止する
7. 各fileをatomic writeし、Installation Manifestを最後に書く

未管理file、利用者が変更した管理対象、symlink ancestor、改ざんAssetは上書きしない。
古い管理対象は、前回記録したSHA-256から変更されていない場合だけ削除する。
user-owned `aidlc/` Workspaceはfresh install、update、cleanupの対象外である。

## Bundle／Release候補

`cmd/aidlc-dev`へ次を追加した。

```text
aidlc-dev bundle write --out <dir>
aidlc-dev bundle check --out <dir>
aidlc-dev package-release --out <dir>
```

Bundleはsourceから46 fileを決定的に生成し、Bun commandを
`./.codex/tools/aidlc`へ解決する。TypeScript runtimeは含めない。生成先に正当なlayout
Manifestがなければ既存directoryを上書きせず、stale／missing／orphaned fileとsymlinkを
検出する。

Release packagerは`CGO_ENABLED=0`、`-trimpath`、`-s -w`で全5 Targetをbuildし、
format、Go build info、size、native `--version`を確認する。Release Assetは固定リストだけを
checksum対象にし、`.DS_Store`などの意図しないtop-level entryがあれば候補生成を拒否する。

ローカルRelease候補の測定値は次のとおりである。

| Target | Format | Bytes | Project path |
|---|---:|---:|---|
| darwin-amd64 | Mach-O | 8,963,584 | `.codex/tools/bin/aidlc-darwin-amd64` |
| darwin-arm64 | Mach-O | 8,191,138 | `.codex/tools/bin/aidlc-darwin-arm64` |
| linux-amd64 | ELF | 8,798,370 | `.codex/tools/bin/aidlc-linux-amd64` |
| linux-arm64 | ELF | 8,061,090 | `.codex/tools/bin/aidlc-linux-arm64` |
| windows-amd64 | PE | 9,054,208 | `.codex/tools/aidlc.exe` |

全binaryは16MiB未満である。検証時のDistribution Manifest SHA-256は
`cdd84fdf9cadddae305cacb52391bfd5e956d9fff0e1bc02f4da6e6f2c848b29`だった。

## 検証結果

次をローカルで成功させた。

```bash
gofmt
go vet ./...
go test -count=1 ./...
go test -race -count=1 ./...
go run ./cmd/aidlc-dev bundle write --out build/stage6-final-project
go run ./cmd/aidlc-dev bundle check --out build/stage6-final-project
go run ./cmd/aidlc-dev package-release --out build/stage6-reviewed-release
sh -n installer/install.sh
bun run release:check
bun run bundle:check
bun run distribution:check
git diff --check
```

Go testはlocal HTTPを使い、fresh install、idempotent install、safe update、conflict、
tamper、symlink、bootstrap installer、installed launcher、全5 binary checksumを検証した。
既存Bun Gateは209 testを含めて維持し、すべて成功した。

`go list -m all`は`github.com/sori883/aidlc`だけであり、外部Go moduleは追加していない。
`build/`は`.gitignore`でRepository rootから除外される。Go build／module cacheはRepository外、
Go testのfixtureは`testing.T.TempDir()`、開発PoCとnative smokeの一時fileはOS tempへ配置して
終了時に削除するため、追加のcache／test temporary ignoreは不要である。

GitHub Actions run `32947254181`でGo／TypeScript quality Gateと全5 native runner上の
Release候補生成、Installer E2E、host launcher smokeが成功し、G6を完了した。
