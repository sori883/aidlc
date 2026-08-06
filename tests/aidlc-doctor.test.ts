import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditFilePath } from "../core/tools/aidlc-audit.ts";
import {
  checkDoctor,
  repairDoctor,
} from "../core/tools/aidlc-doctor.ts";
import {
  birthIntentWithState,
} from "../core/tools/aidlc-intent.ts";
import { writeRunnerSkills } from "../core/tools/aidlc-runner-gen.ts";
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
  assert.deepEqual(report.findings, []);
  assert.match(report.recoveryActions[0] ?? "", /intent-capture/);
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
