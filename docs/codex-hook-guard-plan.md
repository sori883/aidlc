# Codex Hook Guard 実装計画（ST-HK-03）

## 承認状態

- 対象: Codex Harness の `PreToolUse` Guard
- 実装言語: Go 1.26.4
- 外部 Go module: 追加しない
- 承認: 2026-08-27 にユーザー承認済み
- 実装順: ST-HK-01 監査、ST-HK-02 Context 注入に続く第3段階

## 目的

AI-DLC Core が所有する State、Stage Execution Plan、Core Audit、Hook Journal、
Current、revision、review、candidate などの正本を、Codex の通常 Tool 呼び出しから
直接変更できないようにする。また ST-06 では、Core が発行した現在の Bolt Work
Request が指定する Worktree と target だけへ変更範囲を限定する。

Guard は Core の検証を置き換えない。Hook を迂回した変更、Hook が解釈できない
shell の間接表現、Hook を持たない Harness、Hook 起動前の変更は、既存の hash、
参照、State/Plan binding、ST-06 changed-path 検証で fail closed にする。

## Codex 契約

Guard は `PreToolUse` の `Bash` と `apply_patch` だけを対象にする。拒否時は Codex の
現行イベント固有形式を stdout へ返し、終了コード 0 とする。

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "AI-DLC Hook Guard: ..."
  }
}
```

許可時と active vNext Intent がない場合は stdout を空にする。`allow`、`ask`、
`updatedInput`、旧 `decision: block`、終了コード 2 は使用しない。同じイベントの
監査 Hook と Guard Hook は Codex により並行起動されるため、相互の実行順には依存しない。

## 保護範囲

### 常時保護

active Intent の `aidlc/` 管理領域は Core-owned として直接変更を拒否する。これにより
少なくとも次を含む正本を保護する。

- `aidlc-state.json` と `aidlc-state.md`
- `stage-execution-plan.json`
- `audit/` と `hook-audit/`
- Stage ごとの Work Request、Current、revision、review、candidate、approval、receipt、Evidence
- active Space / Intent の選択情報と Risk Register の Current / revision

AI の proposal は Core が指示した Project 内の管理領域外のファイルへ作成し、既存 CLI に
渡す。Risk proposal は既存の Core コマンドを通す。

### ST-06 例外

Current Stage が `ST-06` のときだけ、検証済みの Build Session と現在 Bolt Work Request
を読み、各 `source_workspace.worktree_path` 配下のうち、その `source_id` に対応する
`bolt.targets[].path` とその子孫だけを許可する。別 Bolt、別 attempt、integration Worktree、
別 Source、別 target、Project 外は拒否する。

## Tool 判定

- `apply_patch`: patch header の Add / Update / Delete / Move path を全件抽出する。path が
  1件もない、形式不正、絶対 path、作業 directory 外、symlink で範囲外へ到達する入力は拒否する。
- `Bash`: 変更性のある command と、command 内に直接現れる保護 path / ST-06 Worktree path
  の組み合わせを拒否する。読み取り command は許可する。Bash は完全な shell parser ではないため、
  変数展開などの間接表現を完全なセキュリティ境界とは扱わない。

`PreToolUse` 入力には Agent role がないため、Conductor、reviewer、Stage Agent を推測して
例外扱いしない。判定は actor 非依存である。

## Root 解決

Hook handler は Git root に依存せず、現在 directory から親へ進み、次の両方を持つ最初の
directory を配布 Project root とする。

- `.codex/distribution-manifest.json`
- `.codex/tools/aidlc` または `.codex/tools/aidlc.exe`

これにより非 Git Project と、active Intent 配下に作られた ST-06 Git Worktree の両方で
同じ Project の Go runtime を起動する。監査と Context 注入も同じ root 解決へ統一する。

## 監査と秘匿

拒否時は既存の非権威 Hook Journal へ、event identity、Tool 名、拒否分類、対象の
Project 相対 path だけを追記する。command、patch 本文、prompt、task、Tool output、
秘密情報は保存しない。監査追記に失敗しても許可へフォールバックせず、拒否を維持した
汎用deny responseを返す。

## 実装対象

1. `internal/hookguard`: 入力検証、範囲解決、判定、Codex deny JSON
2. `internal/hookaudit`: metadata-only の Guard 拒否記録 API
3. `internal/cli`: `aidlc hook guard <project-dir> --harness codex`
4. `harness/codex/hooks.json`: `PreToolUse` Guard と ancestor root locator
5. 配布 bundle、README、運用手順、設計文書、テスト

## 完了条件

- Core-owned path への `apply_patch` が実行前に deny され、対象 byte が不変
- ST-06 の現在 Worktree / target 内だけを許可し、範囲外を deny
- active Intent なしは正常 no-op
- 拒否 JSON と Hook Journal に command / patch 本文が含まれない
- 非 Git Project と nested ST-06 Worktree から runtime を発見できる
- `gofmt`、`go vet`、`go test`、race test、native build、5 target package が成功
- `/tmp` の ZIP 展開 Project で、禁止 patch が deny され対象ファイルが変化しない

## 後続工程

Human approval Receipt / Review Freezeと`Stop`制御はST-HK-04として実装済みであり、
`docs/codex-hook-human-approval-design.md`を正本とする。Sensor実行とdebounce、
`SubagentStop`の独立制御、Doctor heartbeatは後続工程で個別に扱う。
