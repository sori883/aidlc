# Doctor Execution Audit契約

## 目的

Doctorの従来の構造検査を維持しつつ、State、Audit、Sensor receipt、成果物、CIを
横断する実行意味検査を追加する。診断はread-onlyであり、人間の承認、autonomyの
選択、Bolt成功を過去へ遡って生成しない。

## 実行方法

通常の構造検査:

```sh
bun core/tools/aidlc-doctor.ts check --project-dir <project-root>
```

構造検査と実行監査:

```sh
bun core/tools/aidlc-doctor.ts check --project-dir <project-root> --full
```

JSON reportは従来の`healthy`と`findings`に加え、次を返す。

- `structuralHealth`: 常に監査済み。定義、Workspace、Intent、State構造、配布を検査
- `executionHealth`: `--full`時だけ監査済み。実行証跡の意味整合を検査

`healthy`は、構造検査と、実施された場合の実行監査がともにhealthyの場合だけ
trueになる。

## 実行finding

### Boltとautonomy

- Bolt PlanとConstruction証跡があるのに`BOLT_STARTED`または
  `BOLT_COMPLETED`がない
- Construction完了時に`Construction Autonomy Mode`が`unset`

これらは過去の人間判断を必要とするため`manual`であり、Doctor repairは変更しない。

### Sensor

- Sensor EventにFire IDがない
- 同一Fire IDの`SENSOR_FIRED`重複
- Fireに終端Eventがない、終端Eventが複数、またはFireなしの孤立終端
- 10 Fire以上でbudget overrideが10%を超える
- Audit Fireに対応するhash-bound receiptがない
- receiptのoutput、input、Sensor versionが現在値と一致しない

override比率は異常の診断信号であり、それだけで過去結果をfailedへ書き換えない。
stale receiptは再fireで置き換える必要があるが、Doctor自身は再実行しない。

### Quality Gate

CI Pipelineが適用される完了WorkflowでQuality Gate Manifestがない場合、CI品質を
検証不能として報告する。ManifestがあればStage 6のprovider validatorを再利用し、
package script、Workflow、job、runtime、aggregate checkの不一致を報告する。

### Project Root

StateのProject Rootと現在のproject rootが違う場合、移設として報告する。Stage 8
で、active IntentのProject Root 1行だけを現在のrootへ置換するautomatic repairを
追加した。他のState進捗やAudit証跡は変更しない。

## 判定対象Workflowでの確認

`/Users/const/sori883/ai-dlc-cycle/05.ai-dlc-test`へread-onlyでfull auditを実行し、
次を確認した。

- `BOLT_STARTED=0`、`BOLT_COMPLETED=0`
- Construction autonomyが`unset`
- Sensor budget overrideが`21/179`、receiptは179 Fire分欠落
- State Project Rootが移設前パス
- 完了済みCI PipelineのQuality Gate Manifestが欠落

対象WorkflowのState、Audit、成果物は変更していない。
