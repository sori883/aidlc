import assert from "node:assert/strict";
import {
  mkdirSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  appendAuditEntry,
  auditFilePath,
} from "../core/tools/aidlc-audit.ts";
import {
  checkDoctor,
  repairDoctor,
} from "../core/tools/aidlc-doctor.ts";
import {
  birthIntentWithState,
} from "../core/tools/aidlc-intent.ts";
import { writeRunnerSkills } from "../core/tools/aidlc-runner-gen.ts";
import { fireSensor } from "../core/tools/aidlc-sensor.ts";
import { resumeIntentState } from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function freshHealthyProject(): {
  projectDir: string;
  recordDir: string;
} {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-doctor-"));
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(
    projectDir,
    "Doctor Fixture",
    "default",
    "mvp",
  );
  writeRunnerSkills({ skillsDir: join(projectDir, ".agents", "skills") });
  return { projectDir, recordDir: born.recordDir };
}

function replaceStateField(source: string, field: string, value: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(
    new RegExp(`^- \\*\\*${escaped}\\*\\*:[^\\n]*$`, "m"),
    `- **${field}**: ${value}`,
  );
}

test("Doctor reports a valid active workflow as healthy and resumable", () => {
  const { projectDir } = freshHealthyProject();
  const report = checkDoctor(projectDir);
  assert.equal(report.healthy, true, JSON.stringify(report.findings, null, 2));
  assert.equal(report.structuralHealth.healthy, true);
  assert.equal(report.executionHealth.audited, false);
  assert.deepEqual(report.findings, []);
  assert.match(report.recoveryActions[0] ?? "", /intent-capture/);
});

test("Doctor full audit separates structural and execution findings", () => {
  const { projectDir, recordDir } = freshHealthyProject();
  const statePath = join(recordDir, "aidlc-state.md");
  let state = readFileSync(statePath, "utf8");
  state = replaceStateField(state, "Project Root", "/moved/from/old-project");
  state = replaceStateField(state, "Status", "Completed");
  writeFileSync(statePath, state, "utf8");

  const boltPlan = join(recordDir, "inception", "delivery-planning", "bolt-plan.md");
  mkdirSync(join(recordDir, "inception", "delivery-planning"), { recursive: true });
  writeFileSync(boltPlan, "# Historical Bolt Plan\n", "utf8");

  for (let index = 0; index < 10; index += 1) {
    const fireId = `legacy-${index}`;
    appendAuditEntry(projectDir, recordDir, "SENSOR_FIRED", {
      Sensor: "required-sections",
      Stage: "intent-capture",
      "Fire ID": fireId,
    });
    appendAuditEntry(
      projectDir,
      recordDir,
      index < 2 ? "SENSOR_BUDGET_OVERRIDE" : "SENSOR_PASSED",
      {
        Sensor: "required-sections",
        Stage: "intent-capture",
        "Fire ID": fireId,
      },
    );
  }

  const qualityDir = join(recordDir, "construction", "ci-pipeline");
  mkdirSync(qualityDir, { recursive: true });
  writeFileSync(join(qualityDir, "quality-gate-manifest.json"), "not json\n", "utf8");

  const report = checkDoctor(projectDir, { fullAudit: true });
  assert.equal(report.executionHealth.audited, true);
  assert.equal(report.executionHealth.healthy, false);
  const ids = new Set(report.executionHealth.findings.map((entry) => entry.id));
  for (const id of [
    "execution.bolt-events-missing",
    "execution.autonomy-unset",
    "execution.sensor-override-ratio",
    "execution.sensor-receipts-missing",
    "execution.quality-gate-invalid",
    "execution.project-root-mismatch",
  ]) assert.ok(ids.has(id), id);
  assert.equal(
    report.executionHealth.findings.find(
      (entry) => entry.id === "execution.bolt-events-missing",
    )?.repair,
    "manual",
  );
});

test("Doctor full audit detects missing Fire IDs and non-unique terminal events", () => {
  const { projectDir, recordDir } = freshHealthyProject();
  appendAuditEntry(projectDir, recordDir, "SENSOR_FIRED", {
    Sensor: "required-sections",
    Stage: "intent-capture",
  });
  appendAuditEntry(projectDir, recordDir, "SENSOR_FIRED", {
    Sensor: "required-sections",
    Stage: "intent-capture",
    "Fire ID": "no-terminal",
  });
  appendAuditEntry(projectDir, recordDir, "SENSOR_FIRED", {
    Sensor: "required-sections",
    Stage: "intent-capture",
    "Fire ID": "duplicate-terminal",
  });
  for (const event of ["SENSOR_PASSED", "SENSOR_FAILED"] as const) {
    appendAuditEntry(projectDir, recordDir, event, {
      Sensor: "required-sections",
      Stage: "intent-capture",
      "Fire ID": "duplicate-terminal",
    });
  }
  const ids = new Set(
    checkDoctor(projectDir, { fullAudit: true }).executionHealth.findings
      .map((entry) => entry.id),
  );
  assert.ok(ids.has("execution.sensor-fire-id-missing"));
  assert.ok(ids.has("execution.sensor-terminal-missing"));
  assert.ok(ids.has("execution.sensor-terminal-duplicate"));
});

test("Doctor full audit detects stale Sensor receipts", async () => {
  const { projectDir, recordDir } = freshHealthyProject();
  const output = join(recordDir, "ideation", "intent-capture", "intent-statement.md");
  mkdirSync(join(recordDir, "ideation", "intent-capture"), { recursive: true });
  writeFileSync(output, "# Intent\n\n## A\n\nA.\n\n## B\n\nB.\n", "utf8");
  await fireSensor(projectDir, "required-sections", "intent-capture", output);
  writeFileSync(output, "# Changed after Sensor pass\n", "utf8");
  const report = checkDoctor(projectDir, { fullAudit: true });
  assert.ok(
    report.executionHealth.findings.some(
      (entry) => entry.id === "execution.sensor-receipt-stale",
    ),
  );
});

test("Doctor initializes a missing Workspace without touching project files", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-doctor-empty-"));
  writeFileSync(join(projectDir, "README.md"), "# Existing project\n", "utf8");
  writeRunnerSkills({ skillsDir: join(projectDir, ".agents", "skills") });
  const checked = checkDoctor(projectDir);
  assert.equal(checked.healthy, false);
  assert.equal(existsSync(join(projectDir, "aidlc")), false);
  const repaired = repairDoctor(projectDir);
  assert.equal(repaired.healthy, true, JSON.stringify(repaired, null, 2));
  assert.equal(repaired.repairs.includes("workspace.missing"), true);
  assert.equal(readFileSync(join(projectDir, "README.md"), "utf8"), "# Existing project\n");
  assert.equal(
    readFileSync(join(projectDir, "aidlc", "active-space"), "utf8"),
    "default\n",
  );
});

test("Doctor ignores host metadata added to the distributed Memory seeds", () => {
  const { projectDir } = freshHealthyProject();
  const copiedCore = join(mkdtempSync(join(tmpdir(), "aidlc-doctor-core-")), "core");
  cpSync("core", copiedCore, { recursive: true });
  writeFileSync(join(copiedCore, "memory", ".DS_Store"), "host metadata", "utf8");

  const checked = checkDoctor(projectDir, { coreDir: copiedCore });
  assert.equal(checked.healthy, true, JSON.stringify(checked.findings, null, 2));
  assert.equal(
    existsSync(
      join(projectDir, "aidlc", "spaces", "default", "memory", ".DS_Store"),
    ),
    false,
  );

  const repaired = repairDoctor(projectDir, { coreDir: copiedCore });
  assert.equal(repaired.healthy, true, JSON.stringify(repaired.findings, null, 2));
  assert.deepEqual(repaired.repairs, []);
});

test("Doctor regenerates a drifted compiled graph from valid definitions", () => {
  const { projectDir } = freshHealthyProject();
  const copiedCore = join(mkdtempSync(join(tmpdir(), "aidlc-doctor-core-")), "core");
  cpSync("core", copiedCore, { recursive: true });
  const graphPath = join(copiedCore, "aidlc-common", "data", "stage-graph.json");
  writeFileSync(graphPath, `${readFileSync(graphPath, "utf8")}\n`, "utf8");
  const checked = checkDoctor(projectDir, { coreDir: copiedCore });
  assert.equal(
    checked.findings.some((entry) => entry.id === "definitions.compiled-drift"),
    true,
  );
  const repaired = repairDoctor(projectDir, { coreDir: copiedCore });
  assert.equal(repaired.healthy, true, JSON.stringify(repaired, null, 2));
  assert.equal(repaired.repairs.includes("definitions.compiled-drift"), true);
});

test("Doctor repairs deterministic Workspace, Intent, plan, Audit, and State drift", () => {
  const { projectDir, recordDir } = freshHealthyProject();
  const orgPath = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "memory",
    "org.md",
  );
  writeFileSync(orgPath, "# Custom organization policy\n", "utf8");
  rmSync(join(projectDir, "aidlc", "spaces", "default", "memory", "team.md"));
  rmSync(join(projectDir, "aidlc", "spaces", "default", "intents", "active-intent"));
  rmSync(join(recordDir, ".aidlc-plan.json"));
  rmSync(join(recordDir, "ideation"), { recursive: true });
  rmSync(auditFilePath(projectDir, recordDir));
  rmSync(
    join(projectDir, ".agents", "skills", "aidlc-feasibility"),
    { recursive: true },
  );
  const statePath = join(recordDir, "aidlc-state.md");
  writeFileSync(
    statePath,
    replaceStateField(readFileSync(statePath, "utf8"), "Completed", "999"),
    "utf8",
  );

  const before = checkDoctor(projectDir);
  assert.equal(before.healthy, false);
  assert.equal(
    before.findings.some((entry) => entry.id === "intent.active-pointer-invalid"),
    true,
  );
  const repaired = repairDoctor(projectDir);
  assert.equal(repaired.healthy, true, JSON.stringify(repaired, null, 2));
  assert.deepEqual(repaired.repairFailures, []);
  for (const id of [
    "workspace.memory-missing",
    "intent.active-pointer-invalid",
    "intent.scaffold-missing",
    "intent.audit-missing",
    "state.plan-invalid",
    "state.derived-drift",
    "distribution.skills-drift",
  ]) {
    assert.equal(repaired.repairs.includes(id), true, id);
  }
  assert.equal(readFileSync(orgPath, "utf8"), "# Custom organization policy\n");
  assert.equal(existsSync(join(recordDir, "ideation")), true);
  assert.equal(existsSync(auditFilePath(projectDir, recordDir)), true);
  assert.match(
    readFileSync(auditFilePath(projectDir, recordDir), "utf8"),
    /\*\*Event\*\*: DOCTOR_REPAIRED/,
  );
  assert.equal(resumeIntentState(projectDir).completed, 3);
  const second = repairDoctor(projectDir);
  assert.deepEqual(second.repairs, []);
  assert.equal(second.healthy, true);
});

test("Doctor refuses to infer ambiguous State progress", () => {
  const { projectDir, recordDir } = freshHealthyProject();
  const statePath = join(recordDir, "aidlc-state.md");
  const original = readFileSync(statePath, "utf8");
  const corrupted = original.replace(
    "- [ ] feasibility — EXECUTE",
    "- [-] feasibility — EXECUTE",
  );
  writeFileSync(statePath, corrupted, "utf8");
  const checked = checkDoctor(projectDir);
  const finding = checked.findings.find(
    (entry) => entry.id === "state.progress-ambiguous",
  );
  assert.equal(finding?.repair, "manual");
  const repaired = repairDoctor(projectDir);
  assert.equal(repaired.healthy, false);
  assert.equal(repaired.repairs.includes("state.progress-ambiguous"), false);
  assert.equal(readFileSync(statePath, "utf8"), corrupted);
});

test("Doctor does not choose between multiple Intent records", () => {
  const { projectDir } = freshHealthyProject();
  birthIntentWithState(projectDir, "Second Intent", "default", "poc");
  const pointer = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "intents",
    "active-intent",
  );
  rmSync(pointer);
  const report = repairDoctor(projectDir);
  const finding = report.findings.find(
    (entry) => entry.id === "intent.active-pointer-invalid",
  );
  assert.equal(finding?.repair, "manual");
  assert.equal(existsSync(pointer), false);
});

test("Doctor deterministically repairs only the moved Project Root field", () => {
  const original = freshHealthyProject();
  const moved = mkdtempSync(join(tmpdir(), "aidlc-doctor-moved-"));
  cpSync(original.projectDir, moved, { recursive: true });
  const statePath = join(
    moved,
    "aidlc",
    "spaces",
    "default",
    "intents",
    original.recordDir.split("/").at(-1) ?? "",
    "aidlc-state.md",
  );
  const before = readFileSync(statePath, "utf8");
  assert.match(before, new RegExp(`- \\*\\*Project Root\\*\\*: ${original.projectDir}`));

  const checked = checkDoctor(moved, { fullAudit: true });
  assert.equal(
    checked.executionHealth.findings.find(
      (entry) => entry.id === "execution.project-root-mismatch",
    )?.repair,
    "automatic",
  );
  const repaired = repairDoctor(moved, { fullAudit: true });
  assert.ok(repaired.repairs.includes("execution.project-root-mismatch"));
  assert.equal(repaired.executionHealth.healthy, true, JSON.stringify(repaired, null, 2));
  const after = readFileSync(statePath, "utf8");
  assert.equal(after, before.replace(original.projectDir, moved));
});

test("Doctor preserves replacement tokens in a moved Project Root", () => {
  const original = freshHealthyProject();
  const moved = mkdtempSync(join(tmpdir(), "aidlc-doctor-$&-$`-$'-"));
  cpSync(original.projectDir, moved, { recursive: true });
  const statePath = join(
    moved,
    "aidlc",
    "spaces",
    "default",
    "intents",
    original.recordDir.split("/").at(-1) ?? "",
    "aidlc-state.md",
  );
  const before = readFileSync(statePath, "utf8");

  const repaired = repairDoctor(moved, { fullAudit: true });
  assert.ok(repaired.repairs.includes("execution.project-root-mismatch"));
  assert.equal(repaired.executionHealth.healthy, true, JSON.stringify(repaired, null, 2));
  const after = readFileSync(statePath, "utf8");
  assert.equal(after, before.replace(original.projectDir, () => moved));
  assert.ok(after.includes(`- **Project Root**: ${moved}\n`));
});
