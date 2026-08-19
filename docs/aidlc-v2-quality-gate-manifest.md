# Quality Gate Manifest契約

## 目的

CI Pipeline Stageが宣言した品質ゲートと、実際のpackage scriptおよびCI設定が
一致することを、承認前に機械検査する。これはAIDLC-004の再実装側の検証不足を
是正するものであり、過去のMVP成果物や本家側のCI定義を直接修正しない。

## 配置と実行

Manifestはactive Intentの次の場所へ保存する。

`construction/ci-pipeline/quality-gate-manifest.json`

Core CLIは次で検査する。

```sh
bun core/tools/aidlc-quality-gate.ts check --project-dir <project-root>
```

CI Pipeline Stageのgateは、この検査が成功するまで開かない。

## Schema version 1

必須項目は次のとおり。

- `provider.id`: CI provider。現在の実装は`github-actions`
- `package.path`: project rootから見たpackage manifest
- `package.manager`: `bun`、`npm`、`pnpm`、`yarn`
- `workflows`: 正式なWorkflow名とproject-relative path
- `gates`: gate ID、種別、必須性、script、Workflow、job、runtime
- `aggregate`: 集約Workflow、job、安定したrequired check名
- `required_checks`: branch protection等で要求するcheck名

gate種別は`node-test`、`workerd-test`、`browser-test`、`coverage`、`build`、
`architecture`、`security`を表現できる。Manifestはprovider中立の宣言を保持し、
provider固有の解釈はvalidatorへ分離する。

## GitHub Actions検査

GitHub Actions providerは、文字列の有無ではなくYAML構造を解析して次を照合する。

- Workflowファイルが存在し、宣言名と`name`が一致する
- triggerとjobが存在し、jobにfresh runnerが指定される
- package scriptが存在し、対象jobから実行される
- runtimeとpackage managerがjob内で準備される
- lockfile固定installが実行される
- 必須gate jobがaggregate jobの`needs`にすべて含まれる
- required check名が`Workflow名 / Job名`と一致する
- `workflow_run.workflows`が実在する宣言済みWorkflow名を参照する

これにより、例えば`Quality`を生成したのに`CI-Q`の完了を待つ設定は失敗する。

## actionlintとの責務分離

組み込み検査はManifestとの意味整合を担当する。`--actionlint`を指定した場合だけ
外部actionlintを追加実行し、結果を`passed`、`failed`、`unavailable`で独立して
報告する。actionlintが利用不能であることを、意味検査の成功として代用しない。

## 将来provider

GitLab CI等を追加するときはManifestの共通schemaを変えず、provider validatorを
追加する。未実装providerは明示的な`provider.unsupported` findingとなり、黙って
成功しない。
