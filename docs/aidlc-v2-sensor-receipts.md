# AI-DLC v2 Sensor Receipt Contract

## 目的

Sensorのpass、failure、budget overrideを、その時点の成果物、意味入力、Sensor
実装に結び付ける。成果物が変わった後に古いpassを現在の品質証跡として扱わない。

## 保存場所

全outcomeは次へversion 1 JSON receiptを原子的に保存する。

```text
<record>/.aidlc-sensors/<stage>/receipts/<sensor>-<fire-id>.json
```

失敗とbudget overrideの人間向けMarkdown detailは従来どおり同じStageのSensor
directory直下へ保存する。

## Schema

主要fieldは次のとおり。

- `version`: receipt schema version
- `checker_protocol_version`: checker JSON protocol version
- `fire_id`: `SENSOR_FIRED`と終端Eventの相関ID
- `sensor`: Sensor ID
- `sensor_version`: Sensor manifest contentのSHA-256
- `stage`
- `outcome`: `passed`、`failed`、`budget-override`
- `output_path`と`output_sha256`
- `input_sha256`
- `inputs`: pathとSHA-256の安定順配列
- `checker_result`: checkerが返した構造化結果
- `created_at`

意味入力には対象成果物、同じdocument directoryのMarkdown、適用template、
Project、Scope、Project Type、compiled Stageのconsume/produce契約を含む。code Sensor
では対象fileと利用可能なpackage、TypeScript、lint設定を含む。

## Freshness

freshness検査は現在の同じsnapshotを再計算し、次を独立に比較する。

- `output-changed`
- `input-changed`
- `sensor-version-changed`

いずれかが一致しなければreceiptはstaleである。staleなpassは履歴として保持する
が、現在のpassとして数えない。Write/Edit hookによる新しいfireは新しいreceiptを
生成し、古いreceiptを上書きしない。

## 条件付き入力

`upstream-coverage`はArtifact resolverと同じ`applicableStageConsumes`を使用する。
StateのProject Typeと一致しない`conditional_on` inputは検査対象に含めない。

## Markdown除外

`claim-sources`は行単位で次を除外し、元の行番号を保持する。

- backtickまたはtilde fenced code
- 単一行または複数行のHTML comment
- `## Review`から次のH2直前、またはEOFまで

fence内の`## Review`はReview開始と解釈せず、Review後の次のH2と本文は検査対象へ
戻す。
