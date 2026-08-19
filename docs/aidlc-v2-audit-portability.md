# Audit順序とWorkspace移設契約

## Audit commit順序

Audit timestampはWorkspace lock取得後、対象shardの初期化後に生成する。各Eventは
次の相関情報を持つ。

- `Timestamp`: lock内で確定したISO timestamp
- `Clone ID`: `.aidlc-clone-id`由来のclone-local ID
- `Sequence`: shard内で1から単調増加する整数

batch appendは一つのlockで連続sequenceを予約する。同じWorkspaceへ複数processが
同時追記しても、同一shardのsequenceは重複・逆転しない。

## 複数clone shard

`readOrderedAuditEntries`は、`Clone ID`、`Sequence`、`Timestamp`、shard pathの順に
安定整列する。分散clone間で時計の完全同期を仮定せず、clone内の因果順をsequence
で優先する。

旧Audit blockにはClone IDとSequenceがない。その場合はshard名からClone IDを取得し、
物理block順をlegacy sequenceとして扱う。旧shardへの新規追記は既存Event数の次から
採番し、過去証跡を書き換えない。

## portable evidence path

project root内にある永続証跡pathはPOSIX形式のproject-relative pathで保存する。
今回の対象はWorktree Audit、Bolt StateのWorktree path、Workspace scanのNested Root
である。project外のpathは意味を失わないよう絶対pathを維持する。CLIのworktree
情報は相対pathを現在のproject rootで解決し、従来どおり絶対pathを返す。

Sensorのoutput、input、receipt pathはStage 5からproject-relativeである。

## Project Root repair

Doctor `repair --full`は、active IntentのStateに保存されたProject Rootが現在の
project rootと異なる場合だけautomatic repairを行う。変更するのは
`- **Project Root**:`の1行だけである。

次は修復しない。

- Stage、Unit、Boltの進捗
- autonomyや承認
- Auditの過去Event
- project外を指す証跡path

修復後は通常の`DOCTOR_REPAIRED` Eventを新しいsequenceで追記する。

## skip marker

StageとBoltのskipは`[S]`を正規表現とする。State template、parser、遷移処理、
resume testで同じ表示を使用し、`[?]`は承認待ちだけを表す。
