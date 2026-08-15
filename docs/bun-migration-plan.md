# Bun／ネイティブCLI移行計画

## 目的

AI-DLC自身の開発、生成、テスト、ネイティブコンパイルをBunへ統一する。利用者はNode.jsを公開GitHub Installerにだけ使用し、導入後のWorkflowはプロジェクトローカルの単一ネイティブバイナリで実行する。

## 準拠方針

- 本家AI-DLC v2のTypeScript実装と統合CLIを基準にする。
- 開発時はBunでTypeScriptを直接実行する。
- `bun build --compile`でOS別のネイティブCLIを生成する。
- バイナリは`core/tools/aidlc.ts`を入口とし、Codex Harnessをコンパイルしない。
- Core Runtime、Codex Harness、Workspaceデータの所有境界を分離する。
- 利用者向けアーカイブとnpmパッケージは生成せず、公開GitHub Releaseとタグ固定の通常ファイルを運搬層に使用する。
- 最初の対応HarnessはCodexとする。

## 完成したステージ

| Stage | 内容 | 状態 |
|---|---|---|
| 1 | Bun開発基盤とTypeScriptテスト | 完了 |
| 2 | 統合CLIと同一プロセス委譲 | 完了 |
| 3 | Harness-neutralネイティブバイナリ | 完了 |
| 4 | Core Runtime／Codex Harness分離 | 完了 |
| 5 | 公開GitHub Installerとプロジェクト単位配布 | 完了 |

## Stage 1: Bun開発基盤

- 依存管理を`bun.lock`へ移行した。
- rootとCodex TypeScriptランタイムのコマンドをBunへ移行した。
- テストを`bun:test`へ移行した。
- 型チェック、Graph、Contract、全テストを`bun run release:check`へ統合した。

## Stage 2: 統合CLI

`core/tools/aidlc.ts`がWorkspace、Intent、State、Graph、Orchestrator、Doctor、Sensorなどのコマンドを公開する。開発時は個別TypeScriptツールをBun子プロセスとして実行し、コンパイル時は各ツールの`main(argv)`を同じバイナリ内で呼び出す。

Sensor checkerはタイムアウトと障害分離のため、同じバイナリを`__sensor-script`として子プロセス起動する。利用者環境のPATHにBunやNode.jsは必要ない。

## Stage 3: Harness-neutralネイティブバイナリ

ビルド入口はCodex生成物ではなく`core/tools/aidlc.ts`である。

```bash
bun run binary:build
bun run binary:build:all
```

ビルド行列:

- native
- darwin-x64
- darwin-arm64
- linux-x64
- linux-arm64
- linux-x64-musl
- linux-arm64-musl
- linux-x64-baseline
- windows-x64

コンパイル成功、10 MiB超の実行ファイル、Mach-O／ELF／PE形式、version、help、Graph、Sensor、Workspace、Intent、Doctor、Orchestrator、Sensor自己再実行、Codex Hookを検証する。実行可能なnative成果物はPATHを空にしてSmoke Testを行う。

## Stage 4: Core Runtime／Codex Harness分離

導入後のレイアウト:

```text
<project>/
├── .aidlc/
│   ├── bin/aidlc[.exe]
│   ├── runtime/core/
│   └── installation.json
├── .agents/
├── .codex/
├── AGENTS.md
└── aidlc/
```

- `.aidlc/bin`: コード依存とBunランタイムを内蔵した実行ファイル
- `.aidlc/runtime/core`: Stage、Scope、Rule、Sensor、Agent persona、契約、共有知識
- `.agents`、`.codex`、`AGENTS.md`: Codex Harness
- `aidlc`: 利用者所有のWorkspace、Intent、State、Audit、成果物

バイナリは自身の`.aidlc/bin`配置から`.aidlc/runtime/core`とプロジェクトルートを解決する。SkillとHookは`./.aidlc/bin/aidlc`を直接実行し、Git root探索を行わない。

## Stage 5: 公開GitHub Installer

公開Releaseの`install.mjs`をNode.js 22以上で一度だけ実行する。

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v0.6.0/install.mjs
node install.mjs install --harness codex --project .
```

Installerは公開Release ManifestからOS、CPU、Linux libcに合うCLI Assetを
1個選ぶ。Core RuntimeデータとCodex Harnessはタグ固定の`dist/project/`から
通常ファイルとして個別取得する。全サイズとSHA-256を事前検査し、管理外変更
との競合が一つでもあれば何も書き込まない。前回の所有情報とRelease情報は
`.aidlc/installation.json`へ記録する。

ローカルHTTPサーバーでGitHub配布を再現し、認証、npm、Gitなしの一時
プロジェクトへ導入する。PATHを空にしてversion、Graph、Workspace、Intent、
Doctorを実行し、改ざん、404、dry-run、競合時に無変更であることをRelease
Gateに含める。

mainへのマージ時に`.github/workflows/ci-main.yml`でRelease Gateを実行する。
`v*`タグのpush時は`.github/workflows/release-github.yml`が、タグのmain包含、
version一致、同じコミットのmain試験成功、既存Release不在を確認し、試験を
重複実行せず配布物の生成と公開だけを行う。

## 公開上の残条件

- `v0.6.0`タグと公開GitHub Release Assetを実際に作成する。
- macOS、Linux、Windowsのnative jobで各ホスト用実行テストを行う。
- Repository SettingsでImmutable Releasesを有効化する。

詳細は[GitHub Release＋ネイティブバイナリ配布](release-packaging.md)を参照する。
