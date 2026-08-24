import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrderedAuditEntries } from "../core/tools/aidlc-audit.ts";
import { checkVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import {
  bootstrapReceiptPath,
  executeBootstrap,
  loadBootstrapStageContract,
  parseBootstrapReceipt,
} from "../core/tools/aidlc-vnext-bootstrap.ts";
import { parseVNextCoreDirective } from "../core/tools/aidlc-vnext-directive.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
import { reviseActiveVNextPlan } from "../core/tools/aidlc-vnext-plan.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextPlanAt,
  writeVNextStateAt,
} from "../core/tools/aidlc-vnext-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

const fixtures: string[] = [];

function fixture(repos?: string[]) {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-bootstrap-"));
  fixtures.push(projectDir);
  initializeWorkspace(projectDir);
  for (const repo of repos ?? []) mkdirSync(join(projectDir, repo), { recursive: true });
  const born = birthIntentWithState(
    projectDir,
    "bootstrap test",
    "default",
    repos,
  );
  return { projectDir, born };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("ST-00 Contract fixes its safety boundary without owning a route", () => {
  const contract = loadBootstrapStageContract();
  assert.equal(contract.stage_id, "ST-00");
  assert.equal(contract.name, "Bootstrap");
  assert.deepEqual(contract.outputs, ["bootstrap-receipt"]);
  assert.deepEqual(
    contract.inputs.map((input) => input.artifact),
    ["stage-execution-plan", "vnext-state", "effective-policy"],
  );
  assert.equal(contract.human_decisions.includes("approval"), false);
  assert.equal("next_stage" in contract, false);
});

test("Core executes ST-00, persists one Receipt, and advances to ST-01", () => {
  const { projectDir, born } = fixture(["app"]);
  const result = executeBootstrap(projectDir, { createdAt: "2026-08-23T00:00:00.000Z" });

  assert.equal(result.execution, "executed");
  assert.equal(result.receipt.result, "ready");
  assert.equal(result.receipt.intent_id, born.uuid);
  assert.equal(result.receipt.space, "default");
  assert.equal(result.receipt.harness, "codex");
  assert.deepEqual(result.receipt.repository_roots, ["app"]);
  assert.equal(result.receipt.checks.length, 5);
  assert.equal(existsSync(bootstrapReceiptPath(born.recordDir)), true);
  assert.equal(result.reference.artifact, "bootstrap-receipt");

  const state = readVNextStateAt(born.recordDir);
  assert.equal(state.current_stage, "ST-01");
  assert.equal(state.status, "parked");
  assert.equal(state.parked_reason, "ST-01 Orient is ready for Core preparation.");

  const events = readOrderedAuditEntries(born.recordDir);
  assert.equal(events.filter((entry) => entry.event === "STAGE_STARTED").length, 1);
  assert.equal(events.filter((entry) => entry.event === "STAGE_COMPLETED").length, 1);
  assert.equal(
    events.some((entry) =>
      entry.event === "ROUTE_DECIDED" && entry.fields["Current Stage"] === "ST-01"
    ),
    true,
  );
});

test("Receipt parser is fail-closed for unknown fields and reordered checks", () => {
  const { projectDir } = fixture();
  const receipt = executeBootstrap(projectDir).receipt;
  assert.throws(
    () => parseBootstrapReceipt({ ...receipt, approved_by_ai: true }),
    /unknown field\(s\): approved_by_ai/,
  );
  assert.throws(
    () => parseBootstrapReceipt({ ...receipt, checks: [...receipt.checks].reverse() }),
    /fixed check order/,
  );
});

test("Policy tampering stops ST-00 without a Receipt or route mutation", () => {
  const { projectDir, born } = fixture();
  writeFileSync(born.policyPath, `${readFileSync(born.policyPath, "utf8")} `, "utf8");

  assert.throws(() => executeBootstrap(projectDir), /SHA-256 does not match/);
  assert.equal(existsSync(bootstrapReceiptPath(born.recordDir)), false);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-00");
});

test("a missing selected Repository stops ST-00", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-bootstrap-"));
  fixtures.push(projectDir);
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(
    projectDir,
    "missing repository",
    "default",
    ["missing-app"],
  );

  assert.throws(() => executeBootstrap(projectDir), /Repository root does not exist/);
  assert.equal(existsSync(bootstrapReceiptPath(born.recordDir)), false);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-00");
});

test("ST-00 rejects not_applicable even when Evidence exists", () => {
  const { projectDir, born } = fixture();
  const plan = readVNextPlanAt(born.recordDir);
  const decisions = plan.stage_decisions.map((decision) =>
    decision.stage_id === "ST-00"
      ? {
        ...decision,
        disposition: "not_applicable" as const,
        reason: "AI attempted to skip the mandatory safety check.",
        evidence: [{ ...plan.policy_snapshot, artifact: "human-decision" }],
      }
      : decision
  );
  writeVNextPlanAt(born.recordDir, { ...plan, stage_decisions: decisions });

  assert.throws(() => executeBootstrap(projectDir), /ST-00 cannot be not_applicable/);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-00");
});

test("an interrupted transition reuses the canonical Receipt without duplicate completion", () => {
  const { projectDir, born } = fixture();
  const first = executeBootstrap(projectDir, { createdAt: "2026-08-23T00:00:00.000Z" });
  const state = readVNextStateAt(born.recordDir);
  const plan = readVNextPlanAt(born.recordDir);
  writeVNextStateAt(born.recordDir, {
    ...state,
    current_stage: "ST-00",
    status: "parked",
    parked_reason: "Recovering an interrupted ST-00 route commit.",
    updated_at: "2026-08-23T00:00:01.000Z",
  }, plan);

  const second = executeBootstrap(projectDir, { createdAt: "2026-08-23T00:00:02.000Z" });
  assert.equal(second.execution, "reused");
  assert.deepEqual(second.reference, first.reference);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-01");
  assert.equal(
    readOrderedAuditEntries(born.recordDir)
      .filter((entry) => entry.event === "STAGE_COMPLETED").length,
    1,
  );
});

test("a non-canonical or edited Receipt cannot be reused", () => {
  const { projectDir, born } = fixture();
  executeBootstrap(projectDir);
  const state = readVNextStateAt(born.recordDir);
  const plan = readVNextPlanAt(born.recordDir);
  writeVNextStateAt(born.recordDir, {
    ...state,
    current_stage: "ST-00",
    status: "parked",
    parked_reason: "Recovering an interrupted ST-00 route commit.",
    updated_at: new Date().toISOString(),
  }, plan);
  const path = bootstrapReceiptPath(born.recordDir);
  writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");

  assert.throws(() => executeBootstrap(projectDir), /Receipt is not canonical|Receipt was modified/);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-00");
});

test("Doctor detects Receipt tampering after ST-00 completed", () => {
  const { projectDir, born } = fixture();
  executeBootstrap(projectDir);
  const path = bootstrapReceiptPath(born.recordDir);
  writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");

  const report = checkVNextDoctor(projectDir);
  assert.equal(report.healthy, false);
  assert.equal(
    report.findings.some((entry) => entry.code === "VNEXT_ST00_RECEIPT_INVALID"),
    true,
  );
});

test("advanced Directive cannot carry AI authority or an invented route", () => {
  const { projectDir } = fixture();
  const directive = resolveVNextDirective(projectDir);
  assert.equal(directive.kind, "advanced");
  assert.throws(
    () => parseVNextCoreDirective({ ...directive, decision_authority: "ai" }),
    /decision_authority.*must equal core/,
  );
  assert.throws(
    () => parseVNextCoreDirective({ ...directive, next_stage: "ST-09" }),
    /unknown field\(s\): next_stage/,
  );
});

test("Plan revision rejects an AI proposal to omit mandatory ST-00", () => {
  const { projectDir, born } = fixture();
  const plan = readVNextPlanAt(born.recordDir);
  const proposalPath = join(projectDir, "skip-st00.json");
  writeFileSync(proposalPath, `${JSON.stringify([{
    schema_version: 1,
    proposal_id: "ai-skip-st00",
    stage_id: "ST-00",
    disposition: "not_applicable",
    reason: "AI attempted to omit the mandatory safety check.",
    evidence: [{ ...plan.policy_snapshot, artifact: "human-decision" }],
    proposed_by: "ai",
  }], null, 2)}\n`);

  assert.throws(
    () => reviseActiveVNextPlan(projectDir, proposalPath),
    /ST-00 cannot be not_applicable/,
  );
});
