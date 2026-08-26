# AI-DLC vNext 共通Stage Contract

## 1. 目的

全10 Stageが従う共通形式と、AIの提案、Coreの確定判断、Stage Execution Planを
fail closedで検査するM1 Contractを定義する。

M1ではContractとvalidatorを既存v2 Runtimeから独立して実装する。有効なCatalog、
Graph、State、Audit、Doctor、Orchestratorへの接続はM2で行う。

## 2. 固定原則

1. Stage IDは`ST-00`〜`ST-09`の10個だけとする
2. Stage Contractは遷移先を持たない。遷移GraphはM2でCoreが所有する
3. AIはStage dispositionを提案できるが、確定判断を作らない
4. Coreだけが`CoreStageDecision`を確定する
5. `reuse`と`not_applicable`にはEvidenceが必要
6. Stage Execution Planは10 Stageすべてを固定順で含む
7. 未知field、欠落、未知enum、不正versionを拒否する
8. Human DecisionやApprovalをAIが代行した記録は作らない

## 3. 実装場所

| 種類 | path | 役割 |
|---|---|---|
| Go | `internal/contract/stage_contract.go` | 型、固定値、parser／validator |
| Go test | `internal/contract/stage_contract_test.go` | 正常系とfail-closed境界 |
| 技術資料 | `docs/aidlc-vnext-stage-contract.md` | field、所有権、M2接続境界 |

## 4. 共通Stage Contract

`VNextStageContract`は各Stage固有実装が必ず宣言する共通形式である。

| field | 型 | 条件 | 所有者 |
|---|---|---|---|
| `schema_version` | `1` | 現在は1だけ | Core Contract |
| `stage_id` | `ST-00`〜`ST-09` | 固定10 ID | Core Catalog |
| `name` | string | 空文字、複数行不可 | Stage設計 |
| `purpose` | string | 空文字、複数行不可 | Stage設計 |
| `inputs` | Artifact requirement[] | Artifact名重複不可 | Stage設計 |
| `outputs` | string[] | lowercase kebab-case、重複不可 | Stage設計 |
| `completion_criteria` | string[] | 1件以上 | Stage設計 |
| `stop_conditions` | string[] | 1件以上 | Stage設計 |
| `human_decisions` | HumanDecisionKind[] | enum、重複不可 | Stage設計 |
| `verifiers` | string[] | 1件以上 | Stage設計 |

Stage Contractに`next_stage`、`route`、`skip`などの遷移fieldを追加してはならない。
validatorは未知fieldとして拒否する。

### 4.1 Artifact requirement

| field | 型 | 条件 |
|---|---|---|
| `artifact` | string | lowercase kebab-case |
| `required` | boolean | trueまたはfalse |

### 4.2 Human Decision分類

| 値 | 意味 |
|---|---|
| `value_judgment` | 目的、優先順位、体験などの価値判断 |
| `exception` | Policyまたは標準手順からの例外判断 |
| `approval` | Design Contract、Candidate、Baselineなどの承認 |
| `release_authority` | 外部副作用を伴うRelease権限 |

## 5. Artifact Reference

`ArtifactReference`は再利用または該当なしの根拠を固定する。

| field | 型 | 条件 |
|---|---|---|
| `artifact` | string | lowercase kebab-case |
| `version` | integer | 1以上 |
| `source_of_truth` | string | 空文字、複数行不可 |
| `sha256` | string | `sha256:`＋64桁のlowercase hex |

`source_of_truth`だけでは内容変更を検出できないため、versionとdigestを同時に保持する。

## 6. AI提案とCore確定判断

提案と確定判断は別schemaとする。

```text
AI／人間／Coreの候補
    ↓ StageDispositionProposal
Validator
    ↓ 検査済み候補
Coreの決定規則
    ↓ CoreStageDecision
Stage Execution Plan
```

### 6.1 StageDispositionProposal

| field | 型 | 説明 |
|---|---|---|
| `schema_version` | `1` | Contract version |
| `proposal_id` | string | 提案識別子 |
| `stage_id` | Stage ID | 対象Stage |
| `disposition` | StageDisposition | 候補 |
| `reason` | string | 提案理由 |
| `evidence` | ArtifactReference[] | 根拠 |
| `proposed_by` | `ai`／`human`／`core` | 提案元 |

Proposalには`decision_authority`、`next_stage`、State更新fieldが存在しない。
AI出力にこれらが混ざった場合は未知fieldとして拒否する。

### 6.2 CoreStageDecision

| field | 型 | 説明 |
|---|---|---|
| `schema_version` | `1` | Contract version |
| `decision_id` | string | Core判断識別子 |
| `stage_id` | Stage ID | 対象Stage |
| `disposition` | StageDisposition | 確定結果 |
| `reason` | string | Coreが採用した理由 |
| `evidence` | ArtifactReference[] | 検査済み根拠 |
| `decision_authority` | `core` | `core`以外を拒否 |
| `proposal_ref` | string、任意 | 元Proposalの識別子 |

M1のvalidatorはpersist済みDecisionの形式を検査する。AIがCore文字列を偽装できない
Runtime上の呼び出し境界、State／Audit書き込み権限はM2で接続する。

## 7. Stage disposition

| 値 | 意味 | Evidence |
|---|---|---|
| `execute` | 今回、新しい作業を行う | 事前Evidenceは0件でもよい |
| `reuse` | 既存Artifactまたは判断を再利用する | 1件以上必須 |
| `not_applicable` | 今回のIntentには該当しない | 1件以上必須 |

`reuse`と`not_applicable`を無言のスキップとして扱わない。理由とEvidenceの両方が
揃わない場合、ProposalとDecisionを拒否する。

## 8. Stage Execution Plan

`StageExecutionPlan`は、固定10 Stageの作業深度をCoreが確定したsnapshotである。
Runtimeの現在位置、進捗、loop cursorはStateの責務であり、このPlanへ混在させない。

| field | 型 | 条件 |
|---|---|---|
| `schema_version` | `1` | 現在は1だけ |
| `intent_id` | string | 対象Intent |
| `revision` | integer | 1以上。再計画時に増やす |
| `graph_version` | string | M2の固定Graph version |
| `policy_snapshot` | ArtifactReference | Effective Policy snapshot |
| `stage_decisions` | CoreStageDecision[] | 10件、固定順、decision ID重複不可 |

固定順は次のとおり。

```text
ST-00 → ST-01 → ST-02 → ST-03 → ST-04
  → ST-05 → ST-06 → ST-07 → ST-08 → ST-09
```

この順序は主要な前進順を示す。ST-07からST-03／04／05／06へ戻るGraphと
invalidated Artifactの処理はM2およびM5で実装する。

## 9. fail-closed検査

M1 validatorは次を拒否する。

- objectではない入力
- 未知field
- schema version不一致
- 固定10 Stage外のID
- 空文字、前後空白、または複数行の識別値
- Artifact名の形式違反
- 重複Artifact、enum、Evidence、decision ID
- completion criteria、stop condition、verifierの空配列
- 不明なHuman Decision分類
- 不明なStage disposition
- `reuse`／`not_applicable`のEvidence不足
- Core Decisionの`decision_authority`が`core`以外
- Stage Execution Planの不足、余分、重複、順序変更
- 不正なArtifact versionまたはSHA-256 digest

## 10. M1 test

`internal/contract/stage_contract_test.go`で次を検証する。

- 正常なStage Contract
- 遷移fieldの拒否
- 未定義Stage IDの拒否
- completion criteria不足の拒否
- AI Proposalの正常parse
- ProposalへのCore authority混入の拒否
- `reuse`／`not_applicable`のEvidence不足拒否
- `execute`のEvidence 0件許可
- `core`以外のDecision authority拒否
- Artifact version／digest
- 10 Stage固定順Plan
- Stage不足、順序変更、decision ID重複、未知fieldの拒否

## 11. M2へ渡すもの

M2では、このM1 Contractを次へ接続する。

1. vNext 10 Stage Catalog／Graph Loader
2. Stage Execution Plan生成とrevision
3. Effective Policy resolverとsnapshot
4. Core Directive生成
5. State／AuditのCore-only mutation
6. Orchestratorの次Stage決定
7. DoctorのPlan／State／Audit整合性診断
8. Codex Harnessへのread-only表示

M2接続が完了するまで、M1 Contractは既存v2 Runtimeの挙動を変更しない。
