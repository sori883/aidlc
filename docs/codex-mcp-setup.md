# Codex MCP セットアップ

このリポジトリでは、Codex から次の MCP サーバーを利用します。

- Context7: 外部ライブラリや API の最新ドキュメントを検索する
- Serena: シンボル単位でコードを検索・解析する

MCP 接続設定はプロジェクト固有の `.codex/config.toml` に格納しています。Codex は、信頼済みのプロジェクトでのみプロジェクト固有設定を読み込みます。

Serena のプロジェクト設定は `.serena/project.yml` に格納しています。Goを解析対象とし、人間の作業領域である`work/`はインデックスから除外します。`.serena/.gitignore`により、cacheと端末固有の`project.local.yml`はバージョン管理されません。

## 構成

Context7 はリモート MCP サーバーへ接続します。共有設定は API キーなしの基本利用を前提とし、シークレットをリポジトリへ保存しません。

Serena はローカルの `serena` コマンドを STDIO MCP サーバーとして起動します。`--project-from-cwd` で現在の Git リポジトリを検出し、`--context=codex` で Codex 向けのツール構成を使用します。

## 前提条件

- ローカル版の Codex CLI、Codex アプリ、または Codex IDE 拡張
- 公式手順で導入した Serena（この環境での確認版: 1.6.1）
- Serena の管理に使用する `uv`
- Context7 へ接続できるネットワーク

Serena が未導入の場合は、公式手順に従ってインストールと初期化を行います。

```sh
uv tool install -p 3.13 serena-agent
serena init
```

導入済みかどうかは次のコマンドで確認できます。

```sh
serena --version
serena start-mcp-server --help
```

## 任意の Context7 API キー

API キーを使う場合は、Codex を起動する環境へ `CONTEXT7_API_KEY` を設定します。次は設定形式の例です。

```sh
export CONTEXT7_API_KEY="取得したAPIキー"
```

そのうえで、ユーザー固有の `~/.codex/config.toml` に認証設定を追加します。

```toml
[mcp_servers.context7]
bearer_token_env_var = "CONTEXT7_API_KEY"
```

`bearer_token_env_var` を指定した状態で環境変数が未設定だと、Context7 の初期化は失敗します。実運用では利用しているシークレット管理手段から環境変数を渡し、シークレットをプロジェクトの `.codex/config.toml`、追跡対象の `.env`、ドキュメントへ直接書き込まないでください。

## 接続確認

設定を追加・変更した後は、新しい Codex セッションを開始します。既に実行中のセッションへ新しい MCP ツールは追加されません。

1. リポジトリのルートで `codex mcp list` を実行します。
2. 一覧に `context7` と `serena` が `enabled` として表示されることを確認します。
3. Codex の入力欄で `/mcp` を実行し、両サーバーが接続済みであることを確認します。
4. Serena がプロジェクトを自動的に認識しない場合は、「Serena で現在のリポジトリをプロジェクトとして有効化し、初期指示を読んでください」と依頼します。

動作確認には、例えば次の依頼を使用できます。

- 「Context7でGo標準ライブラリの最新ドキュメントを調べてください」
- 「Serenaで`internal/`配下の主要なsymbolを一覧にしてください」

## トラブルシューティング

### Context7 に接続できない

- `https://mcp.context7.com/mcp` へのネットワーク接続を確認します。
- `CONTEXT7_API_KEY` を設定している場合は、値が有効か確認します。
- API キーを設定していない場合は、利用上限に達していないか確認します。

### Serena が起動しない

- `command -v serena` で Codex からコマンドを解決できるか確認します。
- `serena init` が完了しているか確認します。
- 起動に15秒以上かかる環境では、`.codex/config.toml` の `startup_timeout_sec` を増やします。
- Codex アプリからプロジェクトが自動認識されない場合は、上記の有効化依頼を実行します。

## 公式資料

- [OpenAI: Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Context7: MCP クライアント設定](https://github.com/upstash/context7/blob/master/docs/resources/all-clients.mdx)
- [Serena: Connecting Your MCP Client](https://github.com/oraios/serena/blob/main/docs/02-usage/030_clients.md)
- [Serena: Installation](https://github.com/oraios/serena/blob/main/docs/02-usage/010_installation.md)
