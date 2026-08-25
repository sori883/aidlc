# Bun／ネイティブCLI構成

## 現在の構成

AI-DLC vNextの開発、型チェック、テスト、配布生成、ネイティブコンパイルはBunへ統一済みです。TypeScriptの入口は`core/tools/aidlc.ts`です。利用者は公開Installerの実行時だけNode.js 22以上を使い、導入後は`.codex/tools/aidlc`だけを実行します。

```text
TypeScript source
    ↓ Bun test / typecheck
fixed 10-Stage Core
    ↓ bun build --compile
native CLI
    ↓ install.mjs
project-local Codex runtime
```

## ビルド

```bash
bun install
bun run release:check
bun run binary:build
bun run binary:build:all
```

全ターゲットBuildではnative、macOS、Linux、Windows向けの形式とBuild Reportを検証します。実行可能なnative成果物は、PATHを空にした状態でversion、help、Graph、Workspace、Intent、Doctorを確認します。

## 配布

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v1.0.0/install.mjs
node install.mjs install --harness codex --project .
```

ネイティブCLIはコードとBunランタイムを内蔵します。固定Stage Catalog／Graph、Memory、Codex Skillは通常ファイルとして配布し、ManifestのSHA-256で保護します。導入先の`aidlc/`は利用者所有であり、配布物には含めません。

## 完了条件

- TypeScript型チェックに成功する。
- 固定10 StageのCatalog／Graphが一致する。
- 全自動テストに成功する。
- Codex bundleと`dist/project/`がsourceと一致する。
- 7種類のGitHub Release向けネイティブCLIを生成できる。
- ローカルHTTP試験で匿名導入、改ざん拒否、競合保護、更新を確認できる。

実際のタグ作成とGitHub公開は、これらの検証とは分離します。
