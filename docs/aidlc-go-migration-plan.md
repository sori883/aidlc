# AI-DLC Go移行計画

## 1. 文書の状態

| 項目 | 内容 |
|---|---|
| 作成日 | 2026-08-26 |
| 対象Repository | `/Users/const/sori883/aidlc` |
| 基準Branch | `codex/aidlc-vnext` |
| G0 Baseline | `c6d67dc5fb32ca2e93869079d36d8769f69217d0` |
| Go移行Branch | `codex/go-runtime-migration` |
| Production Runtime | TypeScript 7.0.2／Bun 1.3.14。Go版へ未切り替え |
| 移行先 | Go 1.26.4 |
| 最初のHarness | Codex |
| 状態 | G0・G1・G2・G3・G4完了、G5 remote Gate確認中 |

本書は、AI-DLC vNextの実装をTypeScript／BunからGoへ段階的に移行するための
設計、互換境界、実装順序、検証Gateを定義する。Goへの一括書き換えは行わず、
TypeScript版を比較基準として残しながら、承認された段階ごとに置き換える。

## 2. 移行の目的

現在のネイティブCLIは、Bunの`--compile`によってBun Runtimeを内包するため、
AI-DLCのコード量とは無関係に約63MBの下限がある。実際に導入先へ配置された
`aidlc`は64,288,226 bytesであり、Gitの低メモリ環境で`git add`が強制終了した。

Go移行では、次を同時に満たす。

1. 導入先へBun、Node.js、GoをRuntime依存として要求しない
2. AI-DLCコマンドの実行にNode.jsを使用しない
3. cloneしたProjectだけで、対応OS上のAI-DLCを実行できる
4. Gitが扱う個々の実行ファイルを16MiB未満にする
5. 固定10 Stage、Core権限、State、Audit、Artifactの契約を維持する
6. 最初の対応HarnessをCodexに限定する
7. 既存Workspaceを推測変換、削除、再初期化しない

## 3. 採用する配布方式

### 3.1 1ターゲット1統合CLI

TypeScriptファイルやコマンドごとに実行ファイルを分けない。ソースコードはGo packageへ
分割し、配布物はOS／CPUごとに1本の統合CLIとする。

初期対応ターゲットは次の5種類とする。

| Target | GOOS | GOARCH | 追加条件 |
|---|---|---|---|
| darwin-amd64 | darwin | amd64 | `CGO_ENABLED=0` |
| darwin-arm64 | darwin | arm64 | `CGO_ENABLED=0` |
| linux-amd64 | linux | amd64 | `CGO_ENABLED=0`, `GOAMD64=v1` |
| linux-arm64 | linux | arm64 | `CGO_ENABLED=0` |
| windows-amd64 | windows | amd64 | `CGO_ENABLED=0` |

純粋なGo実装にして、Linuxのglibc／musl別配布を統合できるかをPoCで実証する。
実証できない場合はTarget Matrixを変更し、その理由を本書へ記録して再承認を得る。

### 3.2 導入先の構成

異なるOSの利用者が同じRepositoryをcloneして実行できるように、Projectには全Targetを
格納する。

```text
<project>/
├── .agents/
│   └── skills/
├── .codex/
│   ├── agents/
│   ├── aidlc-common/
│   ├── memory/
│   ├── tools/
│   │   ├── aidlc                         POSIX target selector
│   │   ├── aidlc.exe                     windows-amd64 Go CLI
│   │   └── bin/
│   │       ├── aidlc-darwin-amd64
│   │       ├── aidlc-darwin-arm64
│   │       ├── aidlc-linux-amd64
│   │       └── aidlc-linux-arm64
│   ├── hooks.json
│   ├── distribution-manifest.json
│   └── aidlc-installation.json
├── AGENTS.md
└── aidlc/                                 利用者所有Workspace
```

POSIXの`.codex/tools/aidlc`は、OSとCPUを判定して対応するGo CLIへ`exec`するだけの
小さなlauncherとする。Windowsでは`.codex/tools/aidlc.exe`を直接実行する。
AI-DLCの状態遷移、検証、ファイル更新などのApplication Logicをlauncherへ持たせない。

## 4. Goソース構成

最終的なSource Treeは次を基準とする。移行中は既存TypeScriptと並存する。

```text
cmd/
├── aidlc/
│   └── main.go
└── aidlc-dev/
    └── main.go                 開発・配布生成専用。Projectには配布しない

internal/
├── cli/                        argv解析、route、stdout／stderr、exit code
├── contract/                   Artifact、Stage、Directiveの型とvalidator
├── platform/
│   ├── fsx/                    safe path、atomic write、symlink防御
│   ├── lock/                   Workspace lock
│   ├── digest/                 SHA-256
│   ├── jsonx/                  strict／canonical JSON
│   ├── process/                timeout付き外部command実行
│   └── runtimepath/            source／test／installed layout解決
├── workspace/                  Workspace初期化
├── space/                      Space identityとcurrent
├── intent/                     Intent birth／list／switch／risk
├── audit/                      append-only Audit
├── workflow/
│   ├── catalog/                固定10 Stage Catalog／Graph
│   ├── delegation/             Stage Agent assignment
│   ├── policy/                 Effective Policy／Human Gate
│   ├── state/                  State／Plan persistence
│   ├── directive/              Core Directive
│   └── orchestrator/           Core-owned route
├── stage/
│   ├── st00bootstrap/
│   ├── st01orient/
│   ├── st02defineintent/
│   ├── st03requirements/
│   ├── st04architecture/
│   ├── st05buildcontract/
│   ├── st06build/
│   ├── st07review/
│   ├── st08release/
│   └── st09outcome/
├── doctor/                     read-only診断と限定repair
├── harness/                    Harness Contract／Codex descriptor
├── bundle/                     Codex bundle generator
├── distribution/               Release／Project Manifest
├── installer/                  install／update planとatomic apply
└── version/                    version source of truth

testdata/                       Golden、invalid fixture、互換fixture
```

### 4.1 依存方向

Package cycleを避け、Core Authorityを構造で守るため、依存方向を次に限定する。

```text
cmd
  ↓
cli／doctor／installer／bundle
  ↓
workflow／stage／workspace／space／intent／audit
  ↓
contract
  ↓
platform
```

- `contract`はFilesystemやCLIへ依存しない
- `stage`同士を直接依存させない
- Stage遷移は`workflow/orchestrator`だけが決定する
- HarnessはCore判断を変更せず、表示と呼び出しへ変換する
- InstallerはWorkflow Stateや利用者Workspaceを変更しない
- `cmd/aidlc-dev`はProjectへ配布しない

## 5. 互換性Contract

言語移行で利用者向け契約を変更しない。

### 5.1 維持するもの

- `aidlc <noun> <command>`のCLI形式
- `.codex/tools/aidlc`というProject内の呼び出し位置
- stdoutのJSON schemaと意味
- stderrとexit codeの分類
- 固定10 Stage Catalog／Graph
- Workspace、Space、Intentの配置とidentity
- State、Plan、Audit、Artifactのschema version
- `source_of_truth`と`sha256:`参照
- Human GateとCore-only mutation
- Installerのconflict、unsafe path、symlink、hash保護
- `aidlc/`以下を利用者所有とする境界

### 5.2 JSON

Go版は次を必須とする。

- `json.Decoder.DisallowUnknownFields()`相当の未知field拒否
- trailing JSONの拒否
- integerとfloating-pointの混同防止
- enum、ID、path、digest、重複、固定順の明示的validator
- 2-space indentと末尾newline
- hash対象のfield順序を固定
- mapをhash対象へ使用する場合はkey順を固定

既存Artifactはraw bytesからSHA-256を計算し、検証後にparseする。読み取った既存Artifactを
Goのfield順で再serializeしてhashを変えない。

### 5.3 時刻、ID、Path

- JavaScriptの`toISOString()`と同じUTC millisecond形式を維持する
- UUIDは`crypto/rand`からRFC 4122 version 4形式で生成する
- persisted pathは常にProject-relativeかつ`/`区切りとする
- Windowsの絶対path、drive、UNC、symlink ancestorをfail closedで扱う
- testではClock、ID source、Command runnerを注入可能にする

### 5.4 ProcessとLock

- 外部commandは`context`によるtimeoutを持つ
- cwd、argv、環境、期待exit codeを明示する
- shell文字列へ連結せず、argv配列で実行する
- Workspace lockは排他的生成、所有情報、timeout、cleanupを維持する
- atomic writeは同じdirectoryのtemporary fileからrenameする

## 6. プログラム変更範囲

### 6.1 Core CLI

現在の`core/tools/aidlc.ts`のrouteをGoの統合CLIへ移す。command名は維持し、内部の
TypeScript module名を利用者へ露出させない。

### 6.2 Domain Core

次の順で移植する。

1. version、CLI、error、runtime path
2. strict JSON、SHA-256、safe path、atomic write、Workspace lock
3. Stage Contract、Catalog、Graph、Delegation
4. Workspace、Space、Intent、Audit
5. Effective Policy、Risk、State、Plan、Directive
6. ST-00 Bootstrap
7. ST-01 Orient
8. ST-02 Define Intent
9. ST-03 Requirements & Constraints
10. ST-04 Architecture Decision
11. ST-05 Build Contract
12. ST-06 Build & Converge
13. ST-07 Human Feedback & Approval
14. ST-08 Release
15. ST-09 Outcome Evaluation
16. Orchestrator、Doctor、resumeの最終接続

### 6.3 Installer

最終的にNode.jsの`install.mjs`をGoへ置き換える。

- GitHub Releaseからhost用Go CLIを取得する小さな`install.sh`／`install.ps1`を用意する
- host用Go CLIが`install`／`update`を実行する
- install／updateは全5 TargetをProjectへ配置する
- Release Manifestのbytes／SHA-256を全Targetで検証する
- host用CLIは`--version`とsmokeを実行してからProjectを変更する
- 変更済み利用者ファイルは上書きしない
- 旧Bun binaryはprevious manifestのhashと一致する場合だけ置換する
- Workflow State、Audit、Artifact、`aidlc/`を移行・削除しない

移行中は既存Node InstallerをParity対象として残す。Go Installerのfailure test、local HTTP
test、update testが一致してからNode Installerを削除する。

### 6.4 Bundle／Release Tooling

`scripts/*.ts`と`core/tools/aidlc-codex-bundle.ts`の責務を`cmd/aidlc-dev`と
`internal/bundle`／`internal/distribution`へ移す。

- sourceからCodex bundleを決定的に生成する
- generated fileを手編集しない
- orphaned／missing／stale fileを検出する
- Project layoutとInstallation Manifestを生成する
- 5 Targetを`CGO_ENABLED=0`、`-trimpath`、release用ldflagsでbuildする
- format、size、version、native smoke、checksumを記録する
- GitHub Release候補をローカル生成する
- tag作成と公開は別の人間承認に保つ

## 7. プログラム以外の変更範囲

### 7.1 Root AGENTS.md

ルート`AGENTS.md`の開発ルールを次へ変更する。

- AI-DLC実装言語をGoとする
- Go 1.26.4を開発・CI Toolchainとする
- 標準ライブラリを優先する
- 外部Go module追加は事前に設計理由と承認を必要とする
- `gofmt`、`go vet`、`go test`をQuality Gateにする
- Codexを最初のHarnessとする
- docs配置、計画承認、1 Stageずつの説明を維持する

### 7.2 Codex Skill

Harness sourceのSkillからBun固有commandを外す。Core commandは
`{{AIDLC_COMMAND}}`のようなgenerator tokenで記述し、Project配布時に
`./.codex/tools/aidlc`へ解決する。

利用者向けcommandは変えない。

```bash
./.codex/tools/aidlc next .
./.codex/tools/aidlc state resume .
./.codex/tools/aidlc delegation validate
```

### 7.3 Agent

Stage Agentのpersona、lead／support／reviewer割当、mutation scope、Core権限境界は
変更しない。変更するのは次に限定する。

- 配布Manifest生成
- Agent TOML／persona／required Skillの存在検査
- TypeScript固有pathを参照する開発説明
- test implementation

`vnext-stage-delegation.json`を引き続きStage DelegationのSource of Truthとする。

### 7.4 Documents

本書に加え、次を更新する。

- `README.md`
- `docs/bun-migration-plan.md`
- `docs/github-release-distribution.md`
- `docs/release-packaging.md`
- `docs/aidlc-vnext-milestones.md`
- `docs/aidlc-vnext-stage-contract.md`
- `docs/aidlc-vnext-operations.md`
- Release NotesとHandoff資料

`docs/bun-migration-plan.md`は削除せず、Go移行によりsupersededとなった履歴資料として
明記する。HTML Guideはcanonical JSON、Skill、Agent、CLI commandとのdriftを検査する。

### 7.5 CI

移行中のCIはGoとBunを併用する。

```text
TypeScript baseline gates
        +
Go format／vet／test／build
        +
TypeScript ↔ Go differential parity
```

完全移行後はBun／Node setup、`package.json`、`bun.lock`、`tsconfig.json`、TypeScriptの
実装・testを削除する。Node Installer testもGo Installer testへ置き換える。

## 8. Test戦略

### 8.1 移行中の二重実行

各Go commandについて、TypeScript版と同じfixture／一時Projectを使い、次を比較する。

- exit code
- stdout JSONの意味と、契約対象ではbyte表現
- stderr分類
- 生成されたfile set
- Artifact raw bytesとSHA-256
- State revisionとcurrent Stage
- Audit event順序
- failure時に書き込みがないこと

### 8.2 Go test分類

- pure validator unit test
- invalid／unknown field contract test
- filesystem safety test
- atomic write／lock concurrency test
- Stageごとのnormal／failure／resume test
- Orchestrator route test
- Installer plan／apply／transport test
- generated bundle drift test
- native binary smoke test
- full vNext E2E test

fixtureは`testdata/`へ置き、Test専用のProduction分岐を追加しない。

### 8.3 Binary Gate

各Targetで次を満たす。

- individual binary `< 16 MiB`
- expected Mach-O／ELF／PE format
- Bun、Node.js、GoをPATHから外した状態で実行可能
- `--version`、help、graph、delegation、workspace、intent、doctorが成功
- Projectへ全Targetを配置して`git add`が成功
- cloneしたProjectでnative Targetを実行可能
- corrupted binary／Manifest／Project assetをfail closedで拒否

16MiB Gateを超えた場合、全体移植を続けず、原因と代替案をレビューする。

## 9. 実行Stage

### Stage 0: 現行変更の確定（G0完了）

Go変更を混ぜる前に、未コミット変更を基準Branchへ確定した。本Stageは完了済みで、
復帰点は`c6d67dc5fb32ca2e93869079d36d8769f69217d0`とする。このcommitは
`origin/codex/aidlc-vnext`へpush済みであり、G1開始時の作業ツリーはcleanである。

確定した変更は主に次の2系統である。

1. vNext Stage Agent Delegation、Agent persona、共有Stage Skill、Guide、test
2. 開発用beginner HTML Agent／Skill、Guide、test

実行手順:

1. `git status`と変更対象を再確認する
2. 秘密情報、大容量ファイル、意図しない生成物を検査する
3. `git diff --check`
4. `bun run release:check`
5. `bun run bundle:check`
6. `bun run distribution:check`
7. Gate後に生成済み`dist/`を含む全未コミット変更をcommitする
8. `origin/codex/aidlc-vnext`へpushする
9. local HEADとorigin HEADの一致を確認する
10. `git status --short`が空であることを確認する

この手順はG0で完了した。G0 Baselineは以降のGo移行で変更せず、rollbackの基準とする。

### Stage 1: Go開発環境（G1完了）

1. `codex/go-runtime-migration`Branchを作成する
2. 本書をGo移行Branchへ配置する
3. Root `AGENTS.md`をGo方針へ変更する
4. `go.mod`を追加する
5. Go 1.26.4をCIへ追加する
6. `gofmt`、`go vet`、`go test`、native buildの空でないGateを用意する
7. build output、cache、test temporary fileのignoreを確認する
8. Production commandの挙動はまだ切り替えない

G1は`fd601366069c4d8e26da5754212082e67652f5bc`で完了した。Go 1.26.4の
format／vet／test／native build Gateと既存TypeScript／Bun Gateをともに通し、
`origin/codex/go-runtime-migration`へpush済みである。

### Stage 2: Vertical Slice PoC（G2完了）

最初に次だけをGoで実装する。

- `aidlc --version`
- `aidlc help`
- `aidlc graph validate`
- `aidlc delegation validate`
- `aidlc delegation show`
- `aidlc workspace init`

5 Targetをbuildし、size、format、PATH-less実行、Project同梱、`git add`、clone実行を
測定する。全Gateが通ったEvidenceをレビューし、承認後にDomain移植へ進む。

ローカルでは5 Targetのbuild、16MiB未満、Mach-O／ELF／PE形式、Go build info、
Projectへの同梱、Git add／commit／clone、darwin-arm64のPATH-less native smoke、
TypeScript版との出力・Workspace差分比較を完了した。G2はGitHub Actions上の
5 Target native smokeもPR #26のGitHub Actionsで完了し、G2を完了した。

### Stage 3: Platform／Domain Foundation（G3完了）

- strict JSON
- SHA-256
- safe path／symlink防御
- atomic write
- Workspace lock
- Workspace／Space／Intent／Audit

TypeScriptとGoの差分testをすべて通す。

Go標準ライブラリだけでPlatform primitive、Workspace／Space／Intent identity／Auditを
実装し、ローカルのunit／race／TypeScript差分、全5 Target cross-build、約2.77〜3.03MBの
Binary Gateを完了した。PR #26のGo／TypeScript quality Gateと5 Target native smokeも
すべて成功し、G3を完了した。

### Stage 4: Workflow Core（G4完了）

- Stage Contract
- Catalog／Graph
- Delegation
- Effective Policy／Risk／Human Gate
- State／Plan／Directive
- Core Orchestrator／Doctor

Core-only mutationとfail-closed境界をGo testで固定する。

Go標準ライブラリだけでStage Contract、Effective Policy、Intent Risk、Human Gate、
Stage Execution Plan、State、Directive、Core Orchestrator、Doctorを実装した。Core以外の
persisted decision authority、固定Graph外のroute、未検証Evidence、古いRisk revisionの
Policy acknowledgement、Project外／symlink path、immutable Artifactの置換をfail closedで
拒否するunit testを追加した。`intent birth`、`intent risk`、`state`、`plan`、`next`、
`doctor`をGo CLIへ接続し、既存Production launcherは変更していない。

ローカルでは`gofmt`、`go vet ./...`、`go test ./...`、`go test -race ./...`、既存Bun
209 test、bundle／distribution check、全5 Target cross-buildを完了した。Binaryは約
3.11〜3.41MBで16MiB未満、native PATH-less smokeではIntent Birth、State、Doctor、
Orchestratorまで実行した。PR #26のremote Gateも成功し、G4を完了した。

### Stage 5: Stage Runtime（G5 remote Gate確認中）

ST-00からST-09まで1 Stageずつ移植する。各Stageで次を行う。

1. Contract／input／outputを確認する
2. TypeScript parity fixtureを固定する
3. Go実装とunit／failure／resume testを追加する
4. differential testを通す
5. Stage単位の差分とEvidenceを記録する

Go標準ライブラリだけでST-00〜ST-09を実装し、CLI、Core Orchestrator、Doctorへ接続した。
normal／failure／resume、immutable参照とcurrentの改変拒否、ST-06の3回同一失敗block、
ST-08のexact authority／baseline drift／rollback、ST-09の複数観測cycleと人間判断をGo testで
固定した。Go生成JSONを既存TypeScript parserへ入力するStage別differential testも成功した。

ローカルでは`gofmt`、`go vet ./...`、通常／race Go test、既存Bun 209 test、bundle／
distribution check、全5 Target cross-build、Project Git round trip、native PATH-less smokeを
完了した。Binaryは約7.93〜8.96MBで16MiB未満である。詳細は
`docs/aidlc-go-stage-runtime-evidence.md`に記録した。G5はPR #26のremote Gate確認中とする。

### Stage 6: Installer／Distribution

- Go Installer
- 5 Target Project layout
- POSIX launcher／Windows executable
- Manifest schemaとsafe update
- Codex bundle generator
- GitHub Release packaging
- local HTTP／tamper／conflict／update E2E

### Stage 7: Cutover

1. `.codex/tools/aidlc`をGo版へ切り替える
2. Skill／Agent／Docs／generated distをGo commandへ揃える
3. CIの主GateをGoへ切り替える
4. 全Parity／E2E／Distribution Gateを実行する
5. TypeScript／Bunを削除する前の最終差分レビューを記録する
6. 全削除条件を確認してTypeScript実装、Bun設定、Node Installerを削除する

### Stage 8: Release Rehearsal

- clean checkoutから全Target build
- fresh install／update／clone
- macOS／Linux／Windows native smoke
- Project Git add／commit test
- version／checksum／Manifest一致
- Release Assetのimmutable boundary確認
- Release candidate report作成

tag作成とGitHub Release公開は、本Stageの完了後に別途明示的な人間承認を得る。

## 10. 削除条件

次をすべて満たすまでTypeScript／Bunを削除しない。

- 全CLI routeがGo版に存在する
- 全10 Stageのnormal／failure／resumeがGo testで成功する
- TypeScriptとのdifferential parityが成功する
- 既存vNext WorkspaceをGo版Doctorがhealthyと判定する
- Go版Installerのfresh／idempotent／update／conflict／tamper testが成功する
- 5 Targetのnative smokeが成功する
- 各binaryが16MiB未満である
- Projectに全Targetを含めてGit add／clone／native実行が成功する
- Skill、Agent、AGENTS、Docs、generated distにBun／TypeScript Runtime参照が残らない
- rollback可能なcommit境界が存在する
- 本PR内のTypeScript削除承認が記録されている

## 11. Rollback方針

- Stage 0の現行TypeScript baseline commitを不変の復帰点とする
- Go移行は別Branchで実施する
- 各Stageを独立commitにして、一括revertを不要にする
- 移行中はTypeScriptのRelease経路を壊さない
- Go版が未完了の間は既存Project配布をTypeScript版native CLIのまま維持する
- Artifact schema migrationをGo言語移行と同時に行わない
- user-owned Workspaceをrollback対象に含めない

## 12. 承認Gate

| Gate | 承認対象 | 状態 |
|---|---|---|
| G0 | 現行変更の検証、commit、push | 完了 |
| G1 | Go環境、package境界、CI skeleton | 完了 |
| G2 | Vertical Sliceのsize／compatibility Evidence | 完了 |
| G3 | Platform／Domain Foundation | 完了 |
| G4 | Workflow Core | 完了 |
| G5 | 各StageのGo移植。ST-00〜ST-09を個別確認 | remote Gate確認中 |
| G6 | Installer／Distribution切り替え | 未着手 |
| G7 | TypeScript／Bun削除 | 未着手 |
| G8 | tag作成／GitHub Release公開 | 未着手 |

2026-08-26に、Stage 2以降を追加の承認待ちなしでStage単位に検証し、同一Branch・
単一Draft PRで継続するユーザー承認を得た。以降のGateは停止点ではなく技術的な
進行条件として扱い、失敗時は当該Stage内で修正する。PR merge、tag作成、GitHub Release
公開はこの承認に含めず、別の明示的な人間承認に保つ。
