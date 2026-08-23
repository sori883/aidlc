import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  parseArtifactReference,
  parseCoreStageDecision,
  parseStageDispositionProposal,
  parseStageExecutionPlan,
  parseVNextStageContract,
  STAGE_CONTRACT_SCHEMA_VERSION,
  VNEXT_STAGE_IDS,
  type ArtifactReference,
  type CoreStageDecision,
} from "../core/tools/aidlc-stage-contract.ts";

const HASH = `sha256:${"a".repeat(64)}`;

function evidence(artifact = "system-map"): ArtifactReference {
  return {
    artifact,
    version: 1,
    source_of_truth: `records/${artifact}.md`,
    sha256: HASH,
  };
}

function stageContract(): Record<string, unknown> {
  return {
    schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
    stage_id: "ST-01",
    name: "Orient",
    purpose: "Understand the current system before deciding changes.",
    inputs: [{ artifact: "design-brief", required: true }],
    outputs: ["system-map"],
    completion_criteria: ["Current behavior is supported by evidence."],
    stop_conditions: ["Required repository access is unavailable."],
    human_decisions: ["exception"],
    verifiers: ["system-map-validator"],
  };
}

function proposal(): Record<string, unknown> {
  return {
    schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
    proposal_id: "proposal-st01-r1",
    stage_id: "ST-01",
    disposition: "reuse",
    reason: "The existing System Map is current for this Intent.",
    evidence: [evidence()],
    proposed_by: "ai",
  };
}

function decision(
  stageId: (typeof VNEXT_STAGE_IDS)[number],
  index: number,
): CoreStageDecision {
  return {
    schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
    decision_id: `decision-${stageId.toLowerCase()}-${index}`,
    stage_id: stageId,
    disposition: "execute",
    reason: `Core selected execute for ${stageId}.`,
    evidence: [],
    decision_authority: "core",
  };
}

function executionPlan(): Record<string, unknown> {
  return {
    schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
    intent_id: "intent-123",
    revision: 1,
    graph_version: "vnext-graph-draft-1",
    policy_snapshot: evidence("effective-policy"),
    stage_decisions: VNEXT_STAGE_IDS.map((stageId, index) =>
      decision(stageId, index)
    ),
  };
}

test("accepts a valid common Stage Contract", () => {
  const parsed = parseVNextStageContract(stageContract());
  assert.equal(parsed.stage_id, "ST-01");
  assert.deepEqual(parsed.outputs, ["system-map"]);
  assert.deepEqual(parsed.human_decisions, ["exception"]);
});

test("rejects transition fields in a Stage Contract", () => {
  assert.throws(
    () => parseVNextStageContract({ ...stageContract(), next_stage: "ST-02" }),
    /unknown field\(s\): next_stage/,
  );
});

test("rejects a Stage outside the fixed ten Stage IDs", () => {
  assert.throws(
    () => parseVNextStageContract({ ...stageContract(), stage_id: "ST-10" }),
    /stage_id: must be one of: ST-00, ST-01/,
  );
});

test("rejects incomplete completion criteria", () => {
  assert.throws(
    () => parseVNextStageContract({
      ...stageContract(),
      completion_criteria: [],
    }),
    /completion_criteria: must contain at least 1 item/,
  );
});

test("accepts an AI disposition proposal as an untrusted proposal", () => {
  const parsed = parseStageDispositionProposal(proposal());
  assert.equal(parsed.proposed_by, "ai");
  assert.equal(parsed.disposition, "reuse");
});

test("rejects padded identifiers instead of silently normalizing them", () => {
  assert.throws(
    () => parseStageDispositionProposal({
      ...proposal(),
      proposal_id: " proposal-st01-r1 ",
    }),
    /proposal_id: must be a non-empty single-line string/,
  );
});

test("rejects Core authority smuggled into an AI proposal", () => {
  assert.throws(
    () => parseStageDispositionProposal({
      ...proposal(),
      decision_authority: "core",
    }),
    /unknown field\(s\): decision_authority/,
  );
});

test("requires Evidence when reuse is proposed", () => {
  assert.throws(
    () => parseStageDispositionProposal({ ...proposal(), evidence: [] }),
    /reuse requires at least one evidence reference/,
  );
});

test("requires Evidence when not_applicable is proposed", () => {
  assert.throws(
    () => parseStageDispositionProposal({
      ...proposal(),
      disposition: "not_applicable",
      evidence: [],
    }),
    /not_applicable requires at least one evidence reference/,
  );
});

test("allows execute without prior Evidence", () => {
  const parsed = parseStageDispositionProposal({
    ...proposal(),
    disposition: "execute",
    evidence: [],
  });
  assert.equal(parsed.disposition, "execute");
});

test("accepts only Core as persisted decision authority", () => {
  const valid = decision("ST-01", 1);
  assert.equal(parseCoreStageDecision(valid).decision_authority, "core");
  assert.throws(
    () => parseCoreStageDecision({ ...valid, decision_authority: "ai" }),
    /decision_authority: must equal core/,
  );
});

test("accepts an Artifact reference with version and digest", () => {
  const parsed = parseArtifactReference(evidence());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sha256, HASH);
});

test("rejects an Artifact reference without a canonical sha256 digest", () => {
  assert.throws(
    () => parseArtifactReference({ ...evidence(), sha256: "abc" }),
    /must use sha256:<64 lowercase hex characters>/,
  );
});

test("accepts a plan containing all ten Stages in fixed order", () => {
  const parsed = parseStageExecutionPlan(executionPlan());
  assert.equal(parsed.stage_decisions.length, 10);
  assert.deepEqual(
    parsed.stage_decisions.map((entry) => entry.stage_id),
    VNEXT_STAGE_IDS,
  );
});

test("rejects a plan with a missing Stage", () => {
  const plan = executionPlan();
  const decisions = plan.stage_decisions as CoreStageDecision[];
  assert.throws(
    () => parseStageExecutionPlan({
      ...plan,
      stage_decisions: decisions.slice(0, -1),
    }),
    /must contain exactly 10 decisions/,
  );
});

test("rejects a plan that reorders the fixed Stages", () => {
  const plan = executionPlan();
  const decisions = [...(plan.stage_decisions as CoreStageDecision[])];
  const first = decisions[0];
  const second = decisions[1];
  assert.ok(first);
  assert.ok(second);
  decisions[0] = second;
  decisions[1] = first;
  assert.throws(
    () => parseStageExecutionPlan({ ...plan, stage_decisions: decisions }),
    /fixed Stage order cannot be changed/,
  );
});

test("rejects duplicate Core decision IDs", () => {
  const plan = executionPlan();
  const decisions = [...(plan.stage_decisions as CoreStageDecision[])];
  const first = decisions[0];
  const second = decisions[1];
  assert.ok(first);
  assert.ok(second);
  decisions[1] = { ...second, decision_id: first.decision_id };
  assert.throws(
    () => parseStageExecutionPlan({ ...plan, stage_decisions: decisions }),
    /contains duplicate decision_id/,
  );
});

test("rejects unknown fields in the Stage Execution Plan", () => {
  assert.throws(
    () => parseStageExecutionPlan({ ...executionPlan(), selected_by_ai: true }),
    /unknown field\(s\): selected_by_ai/,
  );
});
