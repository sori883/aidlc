import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  parseReleaseAuthority,
  parseReleasePlan,
  parseReleasePlanProposal,
  renderReleaseReviewHtml,
} from "../core/tools/aidlc-vnext-release-contract.ts";
import { loadReleaseStageContract } from "../core/tools/aidlc-vnext-release.ts";

const ref = (artifact: string, name: string) => ({
  artifact,
  version: 1,
  source_of_truth: `aidlc/${name}.json`,
  sha256: `sha256:${"a".repeat(64)}`,
});

function proposal() {
  return {
    schema_version: 1,
    artifact: "release-plan-proposal",
    version: 1,
    proposal_id: "release-proposal-001",
    intent_id: "intent-001",
    work_request_sha256: `sha256:${"b".repeat(64)}`,
    disposition: "execute",
    targets: [{
      target_id: "TARGET-001",
      target_kind: "source",
      provider: "git",
      capability_id: "git-remote-source-promote",
      repository_id: "repo-app",
      locator: "origin#refs/heads/main",
      environment: null,
    }],
    steps: [{
      step_id: "STEP-001",
      target_id: "TARGET-001",
      operation: "source-promote",
      capability_id: "git-remote-source-promote",
      depends_on: [],
      desired_state: "2".repeat(40),
      post_release_check: "target-matches-desired",
      rollback_mode: "automatic",
    }],
    release_notes: ["ログイン表示を変更する。"],
    reason: "承認済みrevisionを正式なSourceへ昇格する。",
    proposed_by: "ai",
  };
}

function plan() {
  return {
    schema_version: 1,
    artifact: "release-plan",
    version: 1,
    revision: 1,
    intent_id: "intent-001",
    stage_id: "ST-08",
    disposition: "execute",
    work_request_ref: ref("release-work-request", "request"),
    review_current_ref: ref("review-current", "review-current"),
    accepted_candidate_ref: ref("accepted-candidate", "accepted-candidate"),
    effective_policy_ref: ref("effective-policy", "policy"),
    capability_snapshot_ref: ref("release-capability-snapshot", "capabilities"),
    targets: [{
      ...proposal().targets[0],
      observed_before: "1".repeat(40),
      observed_at: "2026-08-25T00:00:00.000Z",
    }],
    steps: proposal().steps,
    release_notes: proposal().release_notes,
    reason: proposal().reason,
    created_at: "2026-08-25T00:00:00.000Z",
  };
}

test("ST-08 Stage Contract fixes Release outputs and no next_stage", () => {
  const contract = loadReleaseStageContract();
  assert.equal(contract.stage_id, "ST-08");
  assert.equal(contract.name, "Release");
  assert.deepEqual(contract.outputs, [
    "release-capability-snapshot",
    "release-work-request",
    "release-plan",
    "release-html",
    "release-authority",
    "release-step-receipt",
    "release-receipt",
    "release-current",
    "deployment-map",
  ]);
  assert.equal("next_stage" in contract, false);
});

test("Release contracts reject shell commands, AI authority, and unknown fields", () => {
  assert.equal(parseReleasePlanProposal(proposal()).targets[0]?.provider, "git");
  assert.throws(() => parseReleasePlanProposal({ ...proposal(), argv: ["git", "push"] }), /unknown|argv/i);
  assert.throws(() => parseReleasePlanProposal({ ...proposal(), secret_token: "bad" }), /secret|unknown/i);
  assert.equal(parseReleasePlan(plan()).steps[0]?.rollback_mode, "automatic");

  const authority = {
    schema_version: 1,
    artifact: "release-authority",
    version: 1,
    authority_id: "release-authority-001",
    intent_id: "intent-001",
    release_plan_ref: ref("release-plan", "release-plan"),
    accepted_candidate_ref: ref("accepted-candidate", "accepted-candidate"),
    gate_requirement_set_ref: ref("human-gate-requirements", "gate-requirements"),
    policy_acknowledgements: [],
    decision: "authorize-release",
    reason: "このTargetへのReleaseを許可する。",
    decided_by: "human",
    decided_at: "2026-08-25T00:01:00.000Z",
  };
  assert.equal(parseReleaseAuthority(authority).decision, "authorize-release");
  assert.throws(() => parseReleaseAuthority({ ...authority, decided_by: "ai" }), /human/i);
});

test("Release review HTML escapes human-controlled text", () => {
  const value = plan();
  value.release_notes = ["<script>alert(1)</script>"];
  const html = renderReleaseReviewHtml(parseReleasePlan(value));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /ST-08/);
  assert.match(html, /refs\/heads\/main/);
});
