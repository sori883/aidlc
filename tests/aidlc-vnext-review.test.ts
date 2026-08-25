import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  parseCandidateReviewDecision,
  parseReviewManifest,
  renderCandidateReviewHtml,
} from "../core/tools/aidlc-vnext-review-contract.ts";
import {
  loadCandidateReviewStageContract,
  selectFeedbackRoute,
} from "../core/tools/aidlc-vnext-review.ts";

const ref = (artifact: string, name: string) => ({
  artifact,
  version: 1,
  source_of_truth: `aidlc/${name}.json`,
  sha256: `sha256:${"a".repeat(64)}`,
});

function manifest() {
  return {
    schema_version: 1,
    artifact: "review-manifest",
    version: 1,
    intent_id: "intent-001",
    stage_id: "ST-07",
    disposition: "execute",
    build_current_ref: ref("build-current", "build-current"),
    runnable_candidate_ref: ref("runnable-candidate", "candidate"),
    requirements_ref: ref("requirements-definition", "requirements"),
    architecture_current_ref: ref("architecture-current", "architecture"),
    build_contract_ref: ref("build-contract", "build-contract"),
    effective_policy_ref: ref("effective-policy", "policy"),
    system_map_ref: ref("system-map", "system-map"),
    source_results: [{
      repository_id: "repo-app",
      source_ids: ["source-app"],
      source_locator: "app",
      base_revision: "1".repeat(40),
      candidate_revision: "2".repeat(40),
      changed_files: ["src/login.ts"],
    }],
    requirements: [{ requirement_id: "REQ-F-001", statement: "表示を変更する。" }],
    acceptance_criteria: [{
      criterion_id: "AC-001",
      requirement_ids: ["REQ-F-001"],
      given: "現在は送信。",
      when: "画面を表示する。",
      then: "ログインと表示される。",
      verifier_ids: ["VER-001"],
    }],
    machine_evidence_refs: [ref("verifier-evidence", "evidence")],
    human_checks: [{ verifier_id: "VER-H01", expected: "表示が自然である。" }],
    known_constraints: ["認証処理を変更しない。"],
    created_at: "2026-08-24T12:00:00.000Z",
  };
}

test("ST-07 Stage Contract fixes human review outputs and no next_stage", () => {
  const contract = loadCandidateReviewStageContract();
  assert.equal(contract.stage_id, "ST-07");
  assert.equal(contract.name, "Human Feedback & Approval");
  assert.deepEqual(contract.outputs, [
    "review-manifest",
    "review-html",
    "human-decision",
    "accepted-candidate",
    "feedback-current",
    "review-current",
  ]);
  assert.equal("next_stage" in contract, false);
});

test("review contracts reject unknown fields, AI decisions, and incomplete approval", () => {
  const parsed = parseReviewManifest(manifest());
  assert.equal(parsed.requirements[0]?.requirement_id, "REQ-F-001");
  assert.throws(() => parseReviewManifest({ ...manifest(), secret_token: "bad" }), /secret|unknown/i);

  const approval = {
    schema_version: 1,
    artifact: "human-decision",
    version: 1,
    decision_id: "review-decision-001",
    decision_kind: "candidate-review",
    intent_id: "intent-001",
    review_manifest_ref: ref("review-manifest", "manifest"),
    runnable_candidate_ref: ref("runnable-candidate", "candidate"),
    gate_requirement_set_ref: ref("human-gate-requirements", "gate-requirements"),
    policy_acknowledgements: [],
    decision: "approve-runnable-candidate",
    human_check_results: [{ verifier_id: "VER-H01", result: "passed", note: "確認した。" }],
    feedback_items: [],
    reason: "完成候補を承認する。",
    decided_by: "human",
    decided_at: "2026-08-24T12:01:00.000Z",
  };
  assert.equal(parseCandidateReviewDecision(approval).decision, "approve-runnable-candidate");
  assert.throws(() => parseCandidateReviewDecision({ ...approval, decided_by: "ai" }), /human/i);
  assert.throws(() => parseCandidateReviewDecision({
    ...approval,
    feedback_items: [{ feedback_id: "FB-001", summary: "矛盾する。", requirement_ids: ["REQ-F-001"], impacts: ["candidate_defect"] }],
  }), /feedback.*empty|approval/i);
});

test("Core selects the earliest fixed feedback Stage and rejects ambiguity", () => {
  assert.deepEqual(selectFeedbackRoute([
    { feedback_id: "FB-001", summary: "表示が崩れる。", requirement_ids: ["REQ-F-001"], impacts: ["candidate_defect"] },
    { feedback_id: "FB-002", summary: "成功条件を変える。", requirement_ids: ["REQ-F-001"], impacts: ["requirements_changed"] },
  ]), { stage: "ST-03", reason: "requirements_changed" });
  assert.deepEqual(selectFeedbackRoute([
    { feedback_id: "FB-001", summary: "Verifierを変える。", requirement_ids: ["REQ-F-001"], impacts: ["build_contract_impact"] },
    { feedback_id: "FB-002", summary: "構成も変える。", requirement_ids: ["REQ-F-001"], impacts: ["architecture_impact"] },
  ]), { stage: "ST-04", reason: "architecture_impact" });
  assert.throws(() => selectFeedbackRoute([]), /feedback/i);
});

test("static candidate review HTML escapes human-controlled text", () => {
  const value = manifest();
  value.requirements[0]!.statement = "<script>alert(1)</script>";
  const html = renderCandidateReviewHtml(parseReviewManifest(value));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /ST-07/);
  assert.match(html, /candidate revision/i);
});
