import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  loadVNextDelegationCatalog,
  parseVNextDelegationCatalog,
  type StageAgentAssignment,
} from "../core/tools/aidlc-vnext-delegation-contract.ts";
import { VNEXT_STAGE_IDS } from "../core/tools/aidlc-stage-contract.ts";

const root = resolve(import.meta.dir, "..");

function assignments(
  catalog: ReturnType<typeof loadVNextDelegationCatalog>,
): StageAgentAssignment[] {
  return catalog.stages.flatMap((stage) =>
    [stage.work_assignment, stage.review_assignment].filter(
      (assignment): assignment is StageAgentAssignment => assignment !== null,
    )
  );
}

test("defines a complete fixed ten-Stage delegation catalog", () => {
  const catalog = loadVNextDelegationCatalog();
  assert.deepEqual(
    catalog.stages.map((stage) => stage.stage_id),
    VNEXT_STAGE_IDS,
  );

  const bootstrap = catalog.stages[0]!;
  assert.equal(bootstrap.stage_id, "ST-00");
  assert.equal(bootstrap.work_assignment, null);
  assert.equal(bootstrap.review_assignment, null);

  for (const stageId of ["ST-01", "ST-02", "ST-03", "ST-04", "ST-05", "ST-06", "ST-08", "ST-09"]) {
    const stage = catalog.stages.find((candidate) => candidate.stage_id === stageId);
    assert.notEqual(stage, undefined, stageId);
    assert.notEqual(stage!.work_assignment, null, `${stageId} must delegate AI work`);
  }

  const review = catalog.stages.find((stage) => stage.stage_id === "ST-07")!;
  assert.equal(review.work_assignment, null);
  assert.notEqual(review.review_assignment, null);
  assert.equal(review.review_assignment!.mutation_scope, "read-only");
});

test("requires the shared Stage Worker Skill and forbids nested delegation", () => {
  const catalog = loadVNextDelegationCatalog();
  for (const assignment of assignments(catalog)) {
    assert.equal(assignment.required_skills.includes("aidlc-stage-work"), true);
    assert.equal(assignment.optional_skill_policy, "task-matched");
    assert.equal(assignment.nested_delegation, false);
  }

  const build = catalog.stages.find((stage) => stage.stage_id === "ST-06")!;
  assert.equal(build.work_assignment!.lead_agent, "aidlc-developer-agent");
  assert.equal(build.work_assignment!.mutation_scope, "assigned-worktree");

  for (const stage of catalog.stages) {
    if (stage.review_assignment !== null) {
      assert.equal(stage.review_assignment.mutation_scope, "read-only");
    }
  }
});

test("rejects unknown fields, unsafe agents, duplicate roles, and nested delegation", () => {
  const valid = loadVNextDelegationCatalog();

  assert.throws(
    () => parseVNextDelegationCatalog({ ...valid, extra: true }),
    /unknown field/,
  );

  const unsafe = structuredClone(valid);
  unsafe.stages[1]!.work_assignment!.lead_agent = "../unsafe";
  assert.throws(() => parseVNextDelegationCatalog(unsafe), /invalid format/);

  const duplicate = structuredClone(valid);
  const assignment = duplicate.stages[3]!.work_assignment!;
  assignment.support_agents = [assignment.lead_agent];
  assert.throws(() => parseVNextDelegationCatalog(duplicate), /duplicate participant/);

  const nested = structuredClone(valid) as unknown as Record<string, unknown>;
  const stages = nested.stages as Array<Record<string, unknown>>;
  const work = stages[1]!.work_assignment as Record<string, unknown>;
  work.nested_delegation = true;
  assert.throws(() => parseVNextDelegationCatalog(nested), /must be false/);
});

test("integrated CLI validates and resolves the exact Stage assignment", () => {
  const validate = spawnSync(
    process.execPath,
    ["core/tools/aidlc.ts", "delegation", "validate"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(validate.status, 0, validate.stderr);
  assert.deepEqual(JSON.parse(validate.stdout), {
    valid: true,
    schema_version: 1,
    catalog_version: "1.0.0",
    stage_count: 10,
  });

  const show = spawnSync(
    process.execPath,
    ["core/tools/aidlc.ts", "delegation", "show", "ST-06", "work"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(show.status, 0, show.stderr);
  const assignment = JSON.parse(show.stdout) as StageAgentAssignment;
  assert.equal(assignment.lead_agent, "aidlc-developer-agent");
  assert.equal(assignment.mutation_scope, "assigned-worktree");
});
