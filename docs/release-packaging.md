# AI-DLC vNext 1.0.0 配布手順

## 配布するもの

GitHub Releaseには、Node.js 22で動く`install.mjs`、配布Manifest、Checksum、7種類のネイティブCLIを置きます。Codex Skillと固定10 Stageのデータは、同じタグの`dist/project/`からInstallerが取得します。

```text
build/github-release/
├── install.mjs
├── aidlc-distribution.json
├── SHA256SUMS
├── aidlc-darwin-x64
├── aidlc-darwin-arm64
├── aidlc-linux-x64
├── aidlc-linux-arm64
├── aidlc-linux-x64-musl
├── aidlc-linux-arm64-musl
└── aidlc-windows-x64.exe
```

利用者が一度に取得するネイティブCLIは、自分のOSに合う1個だけです。

## 利用者のインストール

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v1.0.0/install.mjs
node install.mjs install --harness codex --project .
```

Windows PowerShell:

```powershell
Invoke-WebRequest "https://github.com/sori883/aidlc/releases/download/v1.0.0/install.mjs" -OutFile "install.mjs"
node install.mjs install --harness codex --project .
```

Installerは全ファイルの長さとSHA-256、ネイティブCLIの`--version`を確認してから書き込みます。HTTP失敗、改ざん、対応外OS、危険なpath、symlink、利用者ファイルとの競合が一つでもあれば書き込みません。

## 開発者のRelease Gate

```bash
bun run version:check
bun run release:check
bun run bundle:write
bun run bundle:check
bun run distribution:write
bun run distribution:check
bun run binary:build:all
bun run package:github
```

`version:check`は、root package、統合CLI、Codex Runtime、README、Installer URLがすべて`1.0.0`であることを確認します。`release:check`は型、固定Graph、全テストを検証します。

## 更新時の保護

`update`は前回記録したSHA-256と現在の内容が一致する管理対象だけを置き換えます。変更済み・未管理のファイルは削除しません。過去の管理済み配置を整理する処理は残しますが、pre-vNext Workflow Stateの変換や削除は行いません。

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v1.0.0/install.mjs
node install.mjs update --harness codex --project .
./.codex/tools/aidlc doctor check .
```

## 公開境界

`bun run package:github`はローカル成果物の生成までです。実際のタグ作成とGitHub Release公開は、Release Gate完了後に別途明示的な承認を得て実施します。公開済みタグとAssetは差し替えません。
