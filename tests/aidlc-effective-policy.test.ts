import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "bun:test";
import {
  buildEffectivePolicySnapshot,
  parseEffectivePolicySnapshot,
  verifyProjectArtifactReference,
  writeEffectivePolicySnapshot,
} from "../core/tools/aidlc-effective-policy.ts";
import {
  createInitialStageExecutionPlan,
  loadVNextDefinitions,
  reviseStageExecutionPlan,
} from "../core/tools/aidlc-core-route.ts";
import {
  STAGE_CONTRACT_SCHEMA_VERSION,
  type ArtifactReference,
  type StageDispositionProposal,
  type VNextStageContract,
} from "../core/tools/aidlc-stage-contract.ts";

function fixture(): { projectDir: string; recordDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-policy-"));
  const memoryDir = join(projectDir, "aidlc", "spaces", "default", "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(projectDir, "aidlc", "active-space"), "default\n");
  writeFileSync(join(memoryDir, "org.md"), "# Org\n\nALWAYS test.\n");
  writeFileSync(join(memoryDir, "team.md"), "# Team\n\nUse Bun.\n");
  writeFileSync(join(memoryDir, "project.md"), "# Project\n\nTypeScript.\n");
  const recordDir = join(projectDir, "aidlc", "spaces", "default", "intents", "intent-1");
  mkdirSync(recordDir, { recursive: true });
  return { projectDir, recordDir };
}

function hash(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function artifact(
  projectDir: string,
  path: string,
  artifactName: string,
): ArtifactReference {
  const content = readFileSync(path);
  return {
    artifact: artifactName,
    version: 1,
    source_of_truth: relative(projectDir, path),
    sha256: hash(content),
  };
}

function proposal(
  stageId: StageDispositionProposal["stage_id"],
  disposition: StageDispositionProposal["disposition"],
  evidence: ArtifactReference[],
): StageDispositionProposal {
  return {
    schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
    proposal_id: `proposal-${stageId.toLowerCase()}-${disposition}`,
    stage_id: stageId,
    disposition,
    reason: `AI proposes ${disposition} for ${stageId}.`,
    evidence,
    proposed_by: "ai",
  };
}

function stageContract(stageId: VNextStageContract["stage_id"]): VNextStageContract {
  return {
    schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
    stage_id: stageId,
    name: "Test Stage",
    purpose: "Test deterministic Core plan revision.",
    inputs: [{ artifact: "system-map", required: true }],
    outputs: [],
    completion_criteria: ["The test condition passes."],
    stop_conditions: ["Required evidence is unavailable."],
    human_decisions: ["exception"],
    verifiers: ["test-verifier"],
  };
}

test("snapshots org, team, and project Memory in fixed priority order", () => {
  const { projectDir } = fixture();
  const snapshot = buildEffectivePolicySnapshot(projectDir, "intent-1", {
    createdAt: "2026-08-23T00:00:00.000Z",
  });
  assert.deepEqual(snapshot.source_priority, ["org", "team", "project", "intent_risk"]);
  assert.deepEqual(snapshot.sources.map((source) => source.layer), ["org", "team", "project"]);
  assert.match(snapshot.sources[0]?.content ?? "", /ALWAYS test/);
  rmSync(projectDir, { recursive: true, force: true });
});

test("writes an immutable policy snapshot reference and verifies its digest", () => {
  const { projectDir, recordDir } = fixture();
  const written = writeEffectivePolicySnapshot(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-23T00:00:00.000Z",
  });
  assert.equal(written.reference.artifact, "effective-policy");
  assert.equal(verifyProjectArtifactReference(projectDir, written.reference), written.path);
  writeFileSync(written.path, "tampered\n");
  assert.throws(
    () => verifyProjectArtifactReference(projectDir, written.reference),
    /sha256 mismatch/,
  );
  rmSync(projectDir, { recursive: true, force: true });
});

test("rejects a malformed policy source order or unknown field", () => {
  const { projectDir } = fixture();
  const snapshot = buildEffectivePolicySnapshot(projectDir, "intent-1", {
    createdAt: "2026-08-23T00:00:00.000Z",
  });
  assert.throws(
    () => parseEffectivePolicySnapshot({
      ...snapshot,
      source_priority: ["team", "org", "project", "intent_risk"],
    }),
    /must use org, team, project, intent_risk order/,
  );
  assert.throws(
    () => parseEffectivePolicySnapshot({ ...snapshot, profile: "enterprise" }),
    /unknown field\(s\): profile/,
  );
  rmSync(projectDir, { recursive: true, force: true });
});

test("creates a safe initial Plan with execute for all ten Stages", () => {
  const { projectDir, recordDir } = fixture();
  const policy = writeEffectivePolicySnapshot(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-23T00:00:00.000Z",
  });
  const graph = loadVNextDefinitions().graph;
  const plan = createInitialStageExecutionPlan(
    "intent-1",
    graph.graph_version,
    policy.reference,
  );
  assert.equal(plan.stage_decisions.length, 10);
  assert.ok(plan.stage_decisions.every((decision) => decision.disposition === "execute"));
  rmSync(projectDir, { recursive: true, force: true });
});

test("accepts execute from an AI proposal but persists a Core decision", () => {
  const { projectDir, recordDir } = fixture();
  const policy = writeEffectivePolicySnapshot(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-23T00:00:00.000Z",
  });
  const graph = loadVNextDefinitions().graph;
  const initial = createInitialStageExecutionPlan("intent-1", graph.graph_version, policy.reference);
  const revised = reviseStageExecutionPlan(
    initial,
    [proposal("ST-02", "execute", [])],
    { projectDir },
  );
  assert.equal(revised.revision, 2);
  const decision = revised.stage_decisions[2];
  assert.equal(decision?.decision_authority, "core");
  assert.equal(decision?.proposal_ref, "proposal-st-02-execute");
  rmSync(projectDir, { recursive: true, force: true });
});

test("accepts reuse only for verified Evidence declared by an implemented Contract", () => {
  const { projectDir, recordDir } = fixture();
  const evidencePath = join(recordDir, "system-map.md");
  writeFileSync(evidencePath, "# System Map\n");
  const evidence = artifact(projectDir, evidencePath, "system-map");
  const policy = writeEffectivePolicySnapshot(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-23T00:00:00.000Z",
  });
  const graph = loadVNextDefinitions().graph;
  const initial = createInitialStageExecutionPlan("intent-1", graph.graph_version, policy.reference);
  assert.throws(
    () => reviseStageExecutionPlan(
      initial,
      [proposal("ST-01", "reuse", [evidence])],
      { projectDir },
    ),
    /reuse requires an implemented Stage Contract/,
  );
  const revised = reviseStageExecutionPlan(
    initial,
    [proposal("ST-01", "reuse", [evidence])],
    { projectDir, stageContracts: [stageContract("ST-01")] },
  );
  assert.equal(revised.stage_decisions[1]?.disposition, "reuse");
  rmSync(projectDir, { recursive: true, force: true });
});

test("rejects tampered reuse Evidence", () => {
  const { projectDir, recordDir } = fixture();
  const evidencePath = join(recordDir, "system-map.md");
  writeFileSync(evidencePath, "# System Map\n");
  const evidence = artifact(projectDir, evidencePath, "system-map");
  const policy = writeEffectivePolicySnapshot(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-23T00:00:00.000Z",
  });
  const initial = createInitialStageExecutionPlan(
    "intent-1",
    loadVNextDefinitions().graph.graph_version,
    policy.reference,
  );
  writeFileSync(evidencePath, "tampered\n");
  assert.throws(
    () => reviseStageExecutionPlan(
      initial,
      [proposal("ST-01", "reuse", [evidence])],
      { projectDir, stageContracts: [stageContract("ST-01")] },
    ),
    /sha256 mismatch/,
  );
  rmSync(projectDir, { recursive: true, force: true });
});

test("requires verified human Evidence for not_applicable until a deterministic rule exists", () => {
  const { projectDir, recordDir } = fixture();
  const genericPath = join(recordDir, "system-map.md");
  writeFileSync(genericPath, "# System Map\n");
  const policy = writeEffectivePolicySnapshot(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-23T00:00:00.000Z",
  });
  const initial = createInitialStageExecutionPlan(
    "intent-1",
    loadVNextDefinitions().graph.graph_version,
    policy.reference,
  );
  assert.throws(
    () => reviseStageExecutionPlan(
      initial,
      [proposal("ST-04", "not_applicable", [artifact(projectDir, genericPath, "system-map")])],
      { projectDir, stageContracts: [stageContract("ST-04")] },
    ),
    /requires a verified human-decision Evidence/,
  );
  const humanPath = join(recordDir, "human-decision.md");
  writeFileSync(humanPath, "# Human Decision\n\nArchitecture is unchanged.\n");
  const revised = reviseStageExecutionPlan(
    initial,
    [proposal(
      "ST-04",
      "not_applicable",
      [artifact(projectDir, humanPath, "human-decision")],
    )],
    { projectDir, stageContracts: [stageContract("ST-04")] },
  );
  assert.equal(revised.stage_decisions[4]?.disposition, "not_applicable");
  rmSync(projectDir, { recursive: true, force: true });
});
