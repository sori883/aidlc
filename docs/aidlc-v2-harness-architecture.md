# AI-DLC v2 Harness Architecture Contract

## 1. 目的

AI-DLCのStage、Bolt、State、Audit、Sensorの意味をHarnessから分離し、Codex、
Claude Code、GitHub Copilotなどで実行手段が異なっても、同じ論理Traceを維持する。

今回実装する実AdapterはCodexだけである。未実装Harnessの能力やpathは推測しない。

## 2. 責務境界

| 層 | 所有するもの | 所有しないもの |
|---|---|---|
| Domain Core | Directive、Stage/Bolt遷移、State、Audit、Sensor判定 | 製品固有tool名、event payload、配置path |
| Harness Contract | capability、layout、fallback規則 | 個別製品の実行コード |
| Harness Adapter | payload変換、質問・Agent・進捗UI、Hook登録 | State/Auditの直接編集、経路判断 |
| Distribution | Descriptorに基づく配置、Manifest、native CLI path | Domain判断 |

CoreのDirectiveはAdapterを通過しても同一objectとして保持する。Adapterが変えてよい
のは`strategy`、つまり実行手段だけである。

## 3. Descriptor schema

Descriptorは次を宣言する。

- `id`、`displayName`
- `capabilities`
  - `structuredQuestions`
  - `agentDelegation`
  - `parallelAgentDelegation`
  - `postWriteHook`
  - `reviewerScopeEnforcement`
  - `stopWaitNotification`
- `layout`
  - runtime root
  - native executable path
  - project instruction path
  - Skill、Agent、Hookの配置path
  - Installation ManifestとProject Layout Manifestのpath

pathはproject-relativeで、`..`、absolute path、Windows drive pathを拒否する。
parallel delegationはagent delegationなしに宣言できない。

## 4. Codex Adapter

Codex Descriptorは現行互換の配置を宣言する。

| 項目 | 値 |
|---|---|
| Harness ID | `codex` |
| Runtime root | `.codex` |
| Native CLI | `.codex/tools/aidlc` |
| Project instruction | `AGENTS.md` |
| Skills | `.agents/skills` |
| Agents | `.codex/agents` |
| Hook config | `.codex/hooks.json` |
| Installation Manifest | `.codex/aidlc-installation.json` |

現在のAdapter能力は、構造化質問、Agent委譲、並列委譲、post-write Hook、
stop/wait通知を有効とする。reviewer scopeの強制Hookはこの再実装に存在しないため
`false`とし、委譲briefによるfallbackを使う。

Codexのtask UIと`PostToolUse` payloadは
`harness/codex/skills/aidlc/lifecycle-rendering.md`および
`harness/codex/hooks/aidlc-sensor-fire.ts`だけで扱う。Core Hookには共通Write/Edit
payloadだけを渡す。

## 5. Capability fallback

| 論理Directive | 能力あり | 能力なし |
|---|---|---|
| `ask` | structured question | option IDを保つtext question |
| `dispatch-subagent` | delegated agent | inline sequential |
| `invoke-swarm` | parallel agents | sequential agents、委譲自体がなければinline sequential |
| non-inline `run-stage` | declared topology | delegatedまたはinline sequential |
| post-write Sensor | registered Hook | Stage完了前の明示実行 |
| reviewer enforcement | enforcement Adapter | read scopeをbriefと証跡で検査 |

fallbackはDirective kind、State、Audit、成果物、gateの意味を変更しない。

## 6. 配布とInstaller

- Codex pathの固定値はCodex Descriptorから取得する
- Installation Manifestは将来のHarness IDを保持できる
- 実際のinstall選択は`harness/registry.ts`に登録済みのAdapterだけを許可する
- 現在のregistryは`codex`だけで、その他は`Unsupported Harness`として停止する
- generated project distributionもDescriptorのruntime root、manifest、CLI pathを使う

この分離により、schemaが将来IDを保存できることと、未実装Harnessを誤って実行可能と
扱わないことを両立する。

## 7. 将来Adapterの追加条件

Claude CodeまたはGitHub Copilotを追加するときは、対象となる具体的な実行製品を
先に固定し、次を追加する。

1. Descriptorと正確なcapability宣言
2. Directive renderer
3. 質問、Agent、Hook、進捗表示のpayload Adapter
4. 配布layout renderer
5. registry登録
6. fake Harnessと共通のconformance test

Domain Coreへ製品名、環境変数、payload schemaを追加してはならない。

## 8. Stage 1検証

- fake HarnessとCodexでDirective kindの論理Traceが一致する
- capability不足時のfallbackが明示される
- unsafe Descriptorと矛盾したcapabilityを拒否する
- unsupported Harnessをregistryで拒否する
- Core ProtocolにCodex lifecycle operation名が残っていない
- Domain CoreにCodex importやpayload環境変数が混入していない
- Runtime ContractとProject Distributionがfake runtime rootを解釈できる
- 現行Codex Bundle、Installer、native project layoutの回帰testが成功する
