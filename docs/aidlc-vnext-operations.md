# AI-DLC vNext 開始・再開・障害対応

## 開始

プロジェクト直下で次を実行する。

```bash
./.codex/tools/aidlc workspace init .
./.codex/tools/aidlc intent list . --json
./.codex/tools/aidlc intent birth . "短い目的"
./.codex/tools/aidlc next .
```

既知のIntentリスクがある場合は、確認済みのJSON配列を渡す。

```bash
./.codex/tools/aidlc intent birth . "短い目的" --risk-file risks.json
```

`next`が返すStageはCoreが固定CatalogとGraphから決める。AIや人間が任意の
次Stageを入力する操作はない。

## Stage Agent委譲

`work`が返ると、親AgentはConductorとして次の割当を確認し、Stage作業を
カスタムAgentへ委譲する。親Agentが成果物をインラインで代行する運用はしない。

```bash
./.codex/tools/aidlc delegation validate
./.codex/tools/aidlc delegation show ST-03 work
./.codex/tools/aidlc delegation show ST-07 review
```

各Agentは`$aidlc-stage-work`を使う。`proposal-only`は指定proposalだけ、
`assigned-worktree`はST-06で指定されたworktreeとBolt targetだけ、
`read-only`は変更なしという意味である。Agentは別Agentへ再委譲せず、Coreの
`next`、`complete`、`approve`、`decide`、`execute`を実行しない。

Agentの最終応答は、Skillで定義された単一行の`AIDLC_STAGE_RESULT` JSON markerで
終える。`SubagentStop` HookはAgent、Stage、割当、role、scope、Skill、path、SHA-256を
検証する。不正ならSubagentだけに1回訂正を求め、再度不正なら無限継続を避けて
Conductorへ戻す。work assignment内の`reviewer_agent`は常に`read-only`である。

Conductorは提出前に、Hookが作った不変Receiptを確認する。

```bash
./.codex/tools/aidlc delegation receipt . agent-123
```

Receiptはreturn contractの検証済み証跡であり、Core受入れ済みという意味ではない。

割当Agentまたは必須Skillが見つからない場合は、インライン作業へ切り替えず停止し、
配布の欠落として扱う。`approval`と`decision`前のAgent所見は人間への参考情報で、
Coreが生成したReview、SHA-256、人間の判断を置き換えない。

## 再開

```bash
./.codex/tools/aidlc state resume .
./.codex/tools/aidlc next .
```

`approval`、`decision`、`parked`が返った場合は、表示された理由と再開条件を
人間へ示して停止する。承認を推測しない。

## Risk Register

```bash
./.codex/tools/aidlc intent risk show .
./.codex/tools/aidlc intent risk propose . risk-proposal.json
```

AI proposalはリスク追加とseverity上昇だけを行える。低下、dismiss、resolveは
理由とEvidenceを持つ人間Decisionだけが行える。人間Decisionは下記Human Gateを通す。
`intent risk decide`は無効である。Currentやrevisionを直接編集しない。

## Human Gate

ST-04、ST-05、ST-07、ST-08、ST-09、Intent Riskの人間判断はすべて同じReceipt経路を使う。
StageのReview commandは対象、Review HTML、Gate Requirement Set、Graph、Plan revisionを
Review Freezeへ固定する。Riskでは`human-gate prepare`時に現在のRisk Registerを固定する。

まずCoreが生成した元のReview HTMLと対象SHA-256を人間へ示す。次に判断内容を
`human-action-proposal.json`へ書く。共通fieldは次のとおりである。

```json
{
  "schema_version": 1,
  "artifact": "human-action-proposal",
  "version": 1,
  "intent_id": "...",
  "scope": "ST-05",
  "subject_sha256": "sha256:...",
  "action": "approve-build-contract",
  "reason": "人間が確認する判断理由",
  "parameters": {
    "policy_acknowledgements": []
  },
  "proposed_by": "ai"
}
```

Policy追加確認がある場合は、全requirement IDについて次の配列を`parameters`内へ入れる。

```json
[
  {
    "requirement_id": "rule-id:risk-id",
    "acknowledged": true,
    "reason": "人間が確認した内容"
  }
]
```

Risk Registerが更新された後の古い確認表は使えない。新しいReviewを生成して再確認する。

Action Proposalをprepareする。

```bash
./.codex/tools/aidlc human-gate prepare . human-action-proposal.json
```

出力された`reviewReference`のHTMLでaction、reason、parameters、Envelope SHA-256を人間が
確認する。人間はHTMLに表示された`/aidlc-confirm ...`の1行を、shell commandではなく
Codexへの新しいメッセージとして完全一致で送る。`UserPromptSubmit` Hookが成功すると、
Codexの追加コンテキストへReceipt SHA-256とapply commandが返る。

```bash
./.codex/tools/aidlc human-gate apply . sha256:...
```

Receiptは一度だけ使える。別action、別対象、古いGraph/Plan、改ざん、再利用は拒否される。
未解決中は`human-gate status .`で確認でき、`Stop` Hookは`continue: false`を返す。

Actionとparameterの対応は次のとおり。

- ST-04: `approve-architecture-policy` + acknowledgements、または`request-revision` + `{}`
- ST-05: `approve-build-contract` + acknowledgements、または`request-revision` + `{}`
- ST-07: `approve-runnable-candidate` / `request-changes` + acknowledgements、human checks、feedback items
- ST-08: `authorize-release` + acknowledgements、または`request-revision` + `{}`
- ST-09: `continue-observation` / `complete-with-outcome` / `complete-and-draft-follow-up`
- RISK: `dismiss` / `resolve` / `set-severity` + decision ID、risk ID、severity、Evidence refs

旧`architecture policy-approve`、`build-contract approve`、`review approve|feedback`、
`release authorize`、`outcome decide`、`intent risk decide`は意図的に失敗する。

## 診断

```bash
./.codex/tools/aidlc doctor check .
```

改ざん、hash不一致、Human Receipt/Envelope/Freezeの不一致、外部Target drift、
StateとPlanの不一致はfail closedになる。
`doctor repair`が直すのは人間向けStateミラーだけで、正本JSONやEvidenceは直さない。

## Codex Hook監査、Human Receipt、コンテキスト注入、Tool Guard、Sensorの確認

インストールまたは更新後にCodexの`/hooks`を開き、Project Hookの内容を確認して
信頼する。Hook定義を更新した場合は再確認が必要になる。現在のSessionが古い設定を
読み込んでいる場合は、新しいSessionを開始する。

```bash
./.codex/tools/aidlc hook status .
```

`active: true`かつ`entries`が1以上なら、active IntentにHook観測証跡がある。
保存先は`aidlc/spaces/<space>/intents/<intent>/hook-audit/*.jsonl`である。
Hook Journalは非権威の観測記録であり、Core AuditやStateを直接変更しない。

`UserPromptSubmit`には一時Turn Marker handlerとReceipt handlerが独立して設定され、
監査handlerは設定されない。通常入力ではOSの一時領域にある空のセッションマーカーだけを
上書きし、Hook Journal、Receipt、handler healthには永続記録を作らない。質問本文、
Session ID、Turn ID、質問回数もマーカーへ保存しない。pending Envelopeの完全一致確認では
`hookSpecificOutput.hookEventName: UserPromptSubmit`と、Receipt SHA-256を含む
`additionalContext`を返す。不正またはstaleな`/aidlc-confirm`は`decision: block`になる。

`Stop`には監査handlerとFreeze handlerが独立して設定される。pending中は
`continue: false`、解決後またはHuman Gateなしでは`{}`を返す。Receipt/Freeze handlerを
AIがBashから直接起動する試みはPreToolUse Guardが拒否する。

詳細は`docs/codex-hook-human-approval-design.md`を参照する。

`SessionStart`と`SubagentStart`では、監査handlerとは別の読み取り専用handlerが
active Intentの永続コンテキストをCodexへ渡す。両handlerは同じHook入力を独立に
受け取り、Workspace lockでState/Planの一貫したsnapshotを使用する。

手動確認では、まずactive Intentを作成した一時Projectで次を実行する。

```bash
printf '%s\n' '{"session_id":"manual-context","cwd":"'"$PWD"'","hook_event_name":"SessionStart","source":"startup"}' \
  | ./.codex/tools/aidlc hook inject . --harness codex
```

出力の`hookSpecificOutput.hookEventName`が`SessionStart`であり、
`additionalContext`にactive Intent、Current Stage、State/Plan相対path、`next`が
含まれることを確認する。active Intentがない場合はstdoutなしで正常終了する。

Subagentでは固定割当を確認し、未割当なら作業停止、複数候補ならConductorの正確な
assignmentを待つ。Context handlerは`updatedInput`や`permissionDecision`を返さず、
Agent task、prompt、コマンド、patch、Tool出力を注入または保存しない。

詳細は`docs/codex-hook-context-design.md`を参照する。

`SubagentStop`の構造化return、Receipt、1回限定continuationの詳細は
`docs/codex-hook-subagent-design.md`を参照する。

### Tool Guard

`PreToolUse`のGuard handlerは`Bash`と`apply_patch`だけに一致する。active Intentの
`aidlc/`管理領域を直接変更する`apply_patch`を拒否し、ST-06では現在のBolt Work
Requestが指定するWorktreeとtarget以外を拒否する。ST-06中の変更性Bash commandは、
pathを完全に確定できないため拒否する。

手動確認ではactive Intentがある一時Projectのルートで、State相対pathを使って次を実行する。

```bash
state_path="$(find aidlc/spaces -name aidlc-state.json -type f | head -n 1)"
before="$(shasum -a 256 "$state_path")"
printf '%s\n' '{"session_id":"manual-guard","turn_id":"manual-turn","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_use_id":"manual-call","tool_input":{"command":"*** Begin Patch\\n*** Update File: '"$state_path"'\\n@@\\n-invalid\\n+blocked\\n*** End Patch"}}' \
  | ./.codex/tools/aidlc hook guard . --harness codex
after="$(shasum -a 256 "$state_path")"
test "$before" = "$after"
```

出力は`hookSpecificOutput.hookEventName: PreToolUse`、
`permissionDecision: deny`でなければならない。Guard command自身はpatchを実行しないため、
StateのSHA-256は不変である。Codex統合時は、このdenyを受けた`apply_patch`本体が開始されない。
許可時とactive Intentなしではstdoutなしで正常終了する。拒否証跡にはreason codeと
Project相対pathだけを保存し、commandやpatch本文は保存しない。

Project root探索はGitに依存せず、現在directoryから親方向へ
`.codex/distribution-manifest.json`と`.codex/tools/aidlc`を探す。このため非Git Projectと
ST-06 nested Worktreeの両方で同じRuntimeを起動できる。

詳細は`docs/codex-hook-guard-design.md`を参照する。

### Sensor

`PostToolUse`では、監査handlerとは別に`apply_patch`専用Sensor handlerが動く。
変更後の`*.go`はGo構文と`go/format`一致、`*.json`は単一の正しいJSON値であることを
確認する。これらは助言的Evidenceであり、完了済みTool callを拒否・取消ししない。

Human Gateを開く直前には、対象、Review HTML、任意のGate Requirement Setを
保存済みSHA-256へ照合するblocking Sensorが必ず動く。不一致時はGateを開かず、
Human overrideも行わない。正しいArtifact referenceとReviewを再生成する。

```bash
./.codex/tools/aidlc sensor list
./.codex/tools/aidlc sensor status .
./.codex/tools/aidlc sensor fire . go-format path/to/file.go
```

`sensor status`はhandler観測数、path一致数、実発火数、最後の結果を別々に表示する。
詳細は`docs/codex-hook-sensor-design.md`を参照する。

### Hook healthとDoctor

`hook status`はHook Journalだけでなく、`handler_health`、`sensors`、
`delegation_results`を同時に返す。Codexがeventを配送したこと、個別handlerが動いたこと、
Sensorのpathが一致したこと、Sensorが実発火したこと、Agent result Receiptができたことは
別のEvidenceであり、相互に代用しない。

`doctor check`はインストール済み`.codex/hooks.json`について必須handlerの欠落・重複、
matcher、timeout、context limit、Project root探索を確認する。設定破損やEvidence改ざんは
error、まだhandlerが呼ばれていない状態はwarning/infoである。設定が正しくてもCodexが
信頼・読込み済みとは限らないため、更新後はProject Hookを確認し、必要なら新しいSessionを
開始する。

詳細は`docs/codex-hook-health-design.md`を参照する。

## 配布前Quality Gate

```bash
git ls-files -z -- '*.go' ':(exclude)work/**' | xargs -0 gofmt -w
go vet ./...
go test -count=1 ./...
go test -race -count=1 ./...
go run ./cmd/aidlc-dev bundle check --out dist/project
go test -count=1 -run TestPackageBuildsFiveTargetReleaseCandidate ./internal/distribution
CGO_ENABLED=0 go build -trimpath -o build/go/aidlc ./cmd/aidlc
```

一つでも失敗した場合はRelease候補にしない。
