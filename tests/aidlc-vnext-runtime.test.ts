import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVNextDoctor, repairVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
import { reviseActiveVNextPlan } from "../core/tools/aidlc-vnext-plan.ts";
import {
  readVNextPlanAt,
  readVNextStateAt,
  resumeVNextIntent,
  validateVNextIntentAt,
  vNextPlanPath,
  vNextStatePath,
  vNextStateSummaryPath,
} from "../core/tools/aidlc-vnext-state.ts";
import { birthIntentWithState, readIntentRegistry } from "../core/tools/aidlc-intent.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

const fixtures: string[] = [];

function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-runtime-"));
  fixtures.push(projectDir);
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "change login copy");
  return { projectDir, born };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("birth creates one vNext Intent with Core-owned State, Plan, and Policy", () => {
  const { projectDir, born } = fixture();
  assert.equal(existsSync(vNextStatePath(born.recordDir)), true);
  assert.equal(existsSync(vNextPlanPath(born.recordDir)), true);
  assert.equal(existsSync(vNextStateSummaryPath(born.recordDir)), true);
  assert.equal(existsSync(born.policyPath), true);

  const state = readVNextStateAt(born.recordDir);
  const plan = readVNextPlanAt(born.recordDir);
  assert.equal(state.workflow, "vnext");
  assert.equal(state.current_stage, "ST-00");
  assert.equal(state.status, "parked");
  assert.equal(plan.stage_decisions.length, 10);
  assert.equal(plan.stage_decisions.every((decision) => decision.disposition === "execute"), true);
  assert.equal(plan.stage_decisions.every((decision) => decision.decision_authority === "core"), true);
  assert.equal("scope" in state, false);
  assert.equal("work_type" in state, false);
  assert.equal("scope" in plan, false);
  assert.equal("scope" in (readIntentRegistry(projectDir)[0] ?? {}), false);

  const audit = readFileSync(born.auditPath, "utf8");
  assert.match(audit, /Effective Policy Snapshot Created/);
  assert.match(audit, /Stage Execution Plan Created/);
  assert.match(audit, /Core Route Decision/);
  assert.doesNotMatch(audit, /Core Route Blocked/);
  assert.equal(state.parked_reason, "ST-00 is ready for Core Bootstrap execution.");
});

test("next lets Core complete ST-00 and then issues the fixed ST-01 work request", () => {
  const { projectDir } = fixture();
  const advanced = resolveVNextDirective(projectDir);
  assert.equal(advanced.kind, "advanced");
  assert.equal(advanced.workflow, "vnext");
  assert.equal(advanced.decision_authority, "core");
  assert.equal("completed_stage" in advanced && advanced.completed_stage, "ST-00");
  assert.equal("stage" in advanced && advanced.stage, "ST-01");

  const work = resolveVNextDirective(projectDir);
  assert.equal(work.kind, "work");
  assert.equal("stage" in work && work.stage, "ST-01");
  assert.equal("request" in work && work.request.artifact, "orient-work-request");
  assert.equal(work.decision_authority, "core");
});

test("Core revises an AI execute proposal without accepting a route instruction", () => {
  const { projectDir, born } = fixture();
  const proposalPath = join(projectDir, "proposals.json");
  writeFileSync(
    proposalPath,
    `${JSON.stringify([{
      schema_version: 1,
      proposal_id: "proposal-st-03-1",
      stage_id: "ST-03",
      disposition: "execute",
      reason: "Requirements need fresh verification.",
      evidence: [],
      proposed_by: "ai",
    }], null, 2)}\n`,
  );
  const revised = reviseActiveVNextPlan(projectDir, proposalPath);
  assert.equal(revised.revision, 2);
  assert.equal(revised.stage_decisions[3]?.proposal_ref, "proposal-st-03-1");
  assert.equal(revised.stage_decisions[3]?.decision_authority, "core");
  assert.equal(readVNextStateAt(born.recordDir).plan_revision, 2);

  writeFileSync(
    proposalPath,
    `${JSON.stringify([{
      schema_version: 1,
      proposal_id: "proposal-smuggles-route",
      stage_id: "ST-03",
      disposition: "execute",
      reason: "Attempt to choose a destination.",
      evidence: [],
      proposed_by: "ai",
      next_stage: "ST-09",
    }])}\n`,
  );
  assert.throws(
    () => reviseActiveVNextPlan(projectDir, proposalPath),
    /unknown field\(s\): next_stage/,
  );
});

test("Doctor detects Policy tampering and repairs only the human State mirror", () => {
  const { projectDir, born } = fixture();
  assert.equal(checkVNextDoctor(projectDir).healthy, true);

  writeFileSync(vNextStateSummaryPath(born.recordDir), "# stale\n", "utf8");
  const stale = checkVNextDoctor(projectDir);
  assert.equal(stale.healthy, true);
  assert.equal(
    stale.findings.some((entry) => entry.code === "VNEXT_STATE_SUMMARY_STALE"),
    true,
  );
  assert.equal(repairVNextDoctor(projectDir).healthy, true);
  assert.match(
    readFileSync(vNextStateSummaryPath(born.recordDir), "utf8"),
    /- Current Stage: ST-00/,
  );

  writeFileSync(born.policyPath, `${readFileSync(born.policyPath, "utf8")} `, "utf8");
  const tampered = checkVNextDoctor(projectDir);
  assert.equal(tampered.healthy, false);
  assert.equal(
    tampered.findings.some((entry) => entry.code === "VNEXT_CORE_STATE_INVALID"),
    true,
  );
});

test("resume fails closed when State and Plan disagree", () => {
  const { projectDir, born } = fixture();
  const state = readVNextStateAt(born.recordDir);
  writeFileSync(
    vNextStatePath(born.recordDir),
    `${JSON.stringify({ ...state, graph_version: "invented-graph" }, null, 2)}\n`,
  );
  assert.throws(() => validateVNextIntentAt(projectDir, born.recordDir), /Graph does not match Plan/);
  assert.throws(() => resumeVNextIntent(projectDir), /Graph does not match Plan/);
});
