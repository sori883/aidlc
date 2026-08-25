# AI-DLC vNext 1.0.0 Release Notes

AI-DLC vNext 1.0.0は、固定10 Stageを最初から最後まで実行できる最初のvNext専用リリースです。

## できること

- Coreが固定Catalog／Graphから次のStageを決定する。
- ST-00からST-09まで、提案・検証・人間承認・記録をつなぐ。
- Evidence付きSystem MapをSpace共有JSONとして累積し、Intentからrevision固定で参照する。
- Org／Team／Project PolicyとIntent Riskを、人間の承認Gateへ反映する。
- Build ContractのBolt DAGに従い、隔離Git worktreeで実装と検証を行う。
- Codex向けSkillとネイティブCLIを安全なInstallerで配布する。

## 大きな変更

旧Workflow用のStage、Scope、Agent、Sensor、YAML契約をRuntimeから削除しました。vNextではWork Typeやlightweight／enterprise profileを選ばず、同じ10 Stageを成果物の大きさで調整します。

pre-vNext形式のWorkflow Stateは自動変換しません。Doctorは`VNEXT_UNSUPPORTED_WORKFLOW_STATE`を返し、元ファイルを変更せず保持します。新しいvNext IntentをBirthしてください。

System Mapの標準出力はJSONだけです。人間向けHTMLは、依頼されたときに対象revisionから生成します。

## 導入

```bash
curl -fsSLO https://github.com/sori883/aidlc/releases/download/v1.0.0/install.mjs
node install.mjs install --harness codex --project .
./.codex/tools/aidlc workspace init .
./.codex/tools/aidlc intent birth . "First Intent"
./.codex/tools/aidlc next .
```

この文書は公開候補の説明です。GitタグとGitHub Releaseの公開は別の承認作業です。
