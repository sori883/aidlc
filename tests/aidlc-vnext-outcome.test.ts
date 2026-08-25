import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  parseOutcomeEvaluation,
  parseOutcomeEvaluationProposal,
  parseOutcomeHumanDecision,
  renderOutcomeEvaluationHtml,
} from "../core/tools/aidlc-vnext-outcome-contract.ts";
import { loadOutcomeStageContract } from "../core/tools/aidlc-vnext-outcome.ts";

const ref = (artifact: string, name: string) => ({
  artifact,
  version: 1,
  source_of_truth: `aidlc/${name}.json`,
  sha256: `sha256:${"a".repeat(64)}`,
});

function proposal() {
  return {
    schema_version: 1,
    artifact: "outcome-evaluation-proposal",
    version: 1,
    proposal_id: "outcome-proposal-001",
    intent_id: "intent-001",
    work_request_sha256: `sha256:${"b".repeat(64)}`,
    observations: [{
      signal_id: "OUT-001",
      result: "achieved",
      evidence_refs: [ref("release-current", "release-current")],
      reason: "承認済みの結果が観測できた。",
      observed_at: "2026-08-25T08:00:00.000Z",
    }],
    reason: "最初の約束と現在の事実を比較した。",
    proposed_by: "ai",
  };
}

function evaluation() {
  return {
    schema_version: 1,
    artifact: "outcome-evaluation",
    version: 1,
    revision: 1,
    evaluation_id: "outcome-evaluation-001",
    intent_id: "intent-001",
    stage_id: "ST-09",
    disposition: "execute",
    work_request_ref: ref("outcome-work-request", "outcome-request"),
    outcome_evidence_ref: ref("outcome-evidence", "outcome-evidence"),
    gate_requirement_set_ref: ref("human-gate-requirements", "gate-requirements"),
    release_outcome: "released",
    signal_results: [{
      signal_id: "OUT-001",
      result: "achieved",
      evidence_refs: [ref("release-current", "release-current")],
      reason: "<script>alert(1)</script>",
      observed_at: "2026-08-25T08:00:00.000Z",
    }],
    overall_result: "achieved",
    reason: "狙った結果を確認した。",
    evaluated_at: "2026-08-25T08:01:00.000Z",
  };
}

test("ST-09 Stage Contract makes Outcome Evaluation terminal and mandatory", () => {
  const contract = loadOutcomeStageContract();
  assert.equal(contract.stage_id, "ST-09");
  assert.equal(contract.name, "Outcome Evaluation");
  assert.deepEqual(contract.outputs, [
    "outcome-work-request",
    "outcome-evidence",
    "outcome-evaluation",
    "outcome-html",
    "outcome-human-decision",
    "outcome-current",
    "follow-up-brief",
  ]);
  assert.equal("next_stage" in contract, false);
  assert.equal(contract.completion_criteria.some((entry) => /not_applicable.*reject/i.test(entry)), true);
});

test("Outcome contracts reject arbitrary routes, missing Evidence, and AI human decisions", () => {
  assert.equal(parseOutcomeEvaluationProposal(proposal()).observations[0]?.result, "achieved");
  assert.throws(
    () => parseOutcomeEvaluationProposal({ ...proposal(), next_stage: "ST-03" }),
    /unknown|next_stage/i,
  );
  const noEvidence = proposal();
  noEvidence.observations[0]!.evidence_refs = [];
  assert.throws(() => parseOutcomeEvaluationProposal(noEvidence), /evidence/i);
  assert.equal(parseOutcomeEvaluation(evaluation()).overall_result, "achieved");

  const decision = {
    schema_version: 1,
    artifact: "outcome-human-decision",
    version: 1,
    decision_id: "outcome-decision-001",
    intent_id: "intent-001",
    outcome_evaluation_ref: ref("outcome-evaluation", "outcome-evaluation"),
    gate_requirement_set_ref: ref("human-gate-requirements", "gate-requirements"),
    policy_acknowledgements: [],
    decision: "complete-with-outcome",
    reason: "部分達成を記録して終了する。",
    decided_by: "human",
    decided_at: "2026-08-25T08:02:00.000Z",
    not_before: null,
    deadline: null,
  };
  assert.equal(parseOutcomeHumanDecision(decision).decision, "complete-with-outcome");
  assert.throws(() => parseOutcomeHumanDecision({ ...decision, decided_by: "ai" }), /human/i);
});

test("Outcome HTML is derived from JSON and escapes human-controlled text", () => {
  const html = renderOutcomeEvaluationHtml(parseOutcomeEvaluation(evaluation()));
  assert.match(html, /ST-09/);
  assert.match(html, /Outcome Evaluation/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
