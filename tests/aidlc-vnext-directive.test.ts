import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseVNextCoreDirective } from "../core/tools/aidlc-vnext-directive.ts";

const ref = (artifact: string) => ({
  artifact,
  version: 1,
  source_of_truth: `aidlc/${artifact}.json`,
  sha256: `sha256:${"a".repeat(64)}`,
});

const common = {
  schema_version: 1,
  workflow: "vnext",
  graph_version: "vnext-10-stage-graph-v1",
  plan_revision: 1,
  decision_authority: "core",
};

test("all six Core Directive kinds have a short reason and fixed human choices", () => {
  const values = [
    { ...common, kind: "advanced", completed_stage: "ST-00", stage: "ST-01", reason: "環境確認が完了し、固定GraphでST-01へ進みました。", evidence: [ref("bootstrap-receipt")] },
    { ...common, kind: "work", stage: "ST-03", reason: "要求だけを提案してください。", request: ref("requirements-work-request") },
    { ...common, kind: "approval", stage: "ST-05", reason: "HTMLと対象hashを確認してください。", candidate: ref("build-contract-candidate"), review: ref("build-contract-review"), decisions: ["approve", "revise"] },
    { ...common, kind: "decision", stage: "ST-09", reason: "観測結果を確認して終了方法を判断してください。", candidate: ref("outcome-evaluation"), review: ref("outcome-html"), decisions: ["continue-observation", "complete-with-outcome", "complete-and-draft-follow-up"] },
    { ...common, kind: "parked", stage: "ST-08", reason: "Target driftを解消してから新しいPlanを作ってください。" },
    { ...common, kind: "done", reason: "固定10 Stageが完了し、次Stageはありません。" },
  ];
  const parsed = values.map((value) => parseVNextCoreDirective(value));
  assert.deepEqual(parsed.map((entry) => entry.kind), ["advanced", "work", "approval", "decision", "parked", "done"]);
  assert.deepEqual((parsed[2] as { decisions: string[] }).decisions, ["approve", "revise"]);
  assert.deepEqual((parsed[3] as { decisions: string[] }).decisions, ["continue-observation", "complete-with-outcome", "complete-and-draft-follow-up"]);
});

test("Directive rejects AI authority, free routes, multiline prose, and invented choices", () => {
  const work = { ...common, kind: "work", stage: "ST-03", reason: "要求だけを提案してください。", request: ref("requirements-work-request") };
  assert.throws(() => parseVNextCoreDirective({ ...work, decision_authority: "ai" }), /authority.*core/i);
  assert.throws(() => parseVNextCoreDirective({ ...work, next_stage: "ST-09" }), /unknown.*next_stage/i);
  assert.throws(() => parseVNextCoreDirective({ ...work, reason: "一行目\n二行目" }), /single-line/i);
  assert.throws(() => parseVNextCoreDirective({ ...common, kind: "approval", stage: "ST-05", reason: "確認する。", candidate: ref("candidate"), review: ref("review"), decisions: ["approve", "skip"] }), /approve, revise/i);
});
