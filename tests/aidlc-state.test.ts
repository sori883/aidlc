import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  birthIntentWithState,
  readIntentRegistry,
} from "../core/tools/aidlc-intent.ts";
import {
  completeCurrentStage,
  resumeIntentState,
  setConstructionIteration,
  skipCurrentStage,
  validateIntentState,
} from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";
import {
  auditShardName,
  cloneIdPath,
} from "../core/tools/aidlc-audit.ts";

function freshProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-state-"));
  initializeWorkspace(projectDir);
  return projectDir;
}

test("Intent Birth writes the v2 state contract and adjusted plan", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(
    projectDir,
    "Payment API",
    "default",
    "mvp",
  );

  const state = readFileSync(born.state.statePath, "utf8");
  const plan = JSON.parse(readFileSync(born.state.planPath, "utf8")) as Array<{
    slug: string;
    action: "EXECUTE" | "SKIP";
  }>;
  assert.equal(plan.length, 32);
  assert.equal(
    plan.find((stage) => stage.slug === "reverse-engineering")?.action,
    "EXECUTE",
  );
  assert.match(state, /- \*\*Project\*\*: Payment API/);
  assert.match(state, /- \*\*Project Type\*\*: Greenfield/);
  assert.match(state, /- \*\*Scope\*\*: mvp/);
  assert.match(state, /- \*\*State Version\*\*: 7/);
  assert.match(state, /- \[x\] workspace-scaffold — EXECUTE/);
  assert.match(state, /- \[x\] workspace-detection — EXECUTE/);
  assert.match(state, /- \[x\] state-init — EXECUTE/);
  assert.match(state, /- \[-\] intent-capture — EXECUTE/);
  assert.match(state, /- \[ \] reverse-engineering — SKIP/);
  assert.equal(born.state.completedStages, 3);
  assert.equal(
    born.state.totalStages,
    plan.filter((stage) => stage.action === "EXECUTE").length - 1,
  );
  validateIntentState(projectDir);

  const resume = resumeIntentState(projectDir);
  assert.equal(resume.currentStage, "intent-capture");
  assert.equal(resume.checkboxState, "in-progress");
  assert.equal(resume.completed, 3);
  assert.equal(resume.totalStages, born.state.totalStages);

  for (const directory of [
    "initialization",
    "ideation",
    "inception",
    "construction",
    "operation",
    "verification",
  ]) {
    assert.equal(existsSync(join(born.recordDir, directory)), true);
  }
  assert.equal(
    existsSync(join(projectDir, "aidlc", "spaces", "default", "knowledge")),
    true,
  );
  assert.equal(born.auditPath, join(born.recordDir, "audit", auditShardName(projectDir)));
  assert.deepEqual(readdirSync(join(born.recordDir, "audit")), [auditShardName(projectDir)]);
  assert.match(readFileSync(cloneIdPath(projectDir), "utf8"), /^[a-z0-9]{12}\n$/);

  const audit = readFileSync(born.auditPath, "utf8");
  assert.ok(audit.startsWith("# AI-DLC Audit Log\n"));
  assert.deepEqual(
    [...audit.matchAll(/^\*\*Event\*\*: ([A-Z_]+)$/gm)].map((match) => match[1]),
    [
      "WORKFLOW_STARTED",
      "PHASE_STARTED",
      "PHASE_SKIPPED",
      "STAGE_STARTED",
      "WORKSPACE_SCAFFOLDED",
      "STAGE_COMPLETED",
      "STAGE_STARTED",
      "WORKSPACE_SCANNED",
      "STAGE_COMPLETED",
      "STAGE_STARTED",
      "WORKSPACE_INITIALISED",
      "STAGE_COMPLETED",
      "PHASE_COMPLETED",
      "PHASE_VERIFIED",
      "PHASE_STARTED",
      "STAGE_STARTED",
    ],
  );
  assert.match(audit, /\*\*Stage\*\*: intent-capture/);
});

test("set-construction-iteration validates and persists Runtime State without Audit", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const beforePlan = readFileSync(born.state.planPath, "utf8");
  const beforeAudit = readFileSync(born.auditPath, "utf8");

  const update = setConstructionIteration(projectDir, "unit-major");
  assert.equal(update.constructionIteration, "unit-major");
  assert.match(
    readFileSync(born.state.statePath, "utf8"),
    /## Runtime State\n- \*\*Construction Iteration\*\*: unit-major/,
  );
  assert.equal(readFileSync(born.state.planPath, "utf8"), beforePlan);
  assert.equal(readFileSync(born.auditPath, "utf8"), beforeAudit);

  const cli = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "core/tools/aidlc-state.ts",
      "set-construction-iteration",
      "stage-major",
      "--project-dir",
      projectDir,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), {
    updated: true,
    construction_iteration: "stage-major",
  });
  assert.equal(
    (readFileSync(born.state.statePath, "utf8")
      .match(/Construction Iteration/g) ?? []).length,
    1,
  );
  assert.match(
    readFileSync(born.state.statePath, "utf8"),
    /- \*\*Construction Iteration\*\*: stage-major/,
  );
  assert.equal(readFileSync(born.state.planPath, "utf8"), beforePlan);
  assert.equal(readFileSync(born.auditPath, "utf8"), beforeAudit);

  const invalid = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "core/tools/aidlc-state.ts",
      "set-construction-iteration",
      "bogus",
      "--project-dir",
      projectDir,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid construction iteration/);
});

test("brownfield routing starts with reverse-engineering", () => {
  const projectDir = freshProject();
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src", "index.ts"), "export const ok = true;\n");

  const born = birthIntentWithState(
    projectDir,
    "Fix checkout",
    "default",
    "bugfix",
  );
  const plan = JSON.parse(readFileSync(born.state.planPath, "utf8")) as Array<{
    slug: string;
    action: "EXECUTE" | "SKIP";
  }>;

  assert.equal(born.state.projectType, "Brownfield");
  assert.equal(born.state.firstStage, "reverse-engineering");
  assert.equal(
    plan.find((stage) => stage.slug === "reverse-engineering")?.action,
    "EXECUTE",
  );
});

test("Intent Birth rejects an invalid scope before minting a record", () => {
  const projectDir = freshProject();

  assert.throws(
    () => birthIntentWithState(projectDir, "Payment API", "default", "missing"),
    /Unknown scope/,
  );
  assert.deepEqual(readIntentRegistry(projectDir), []);
  assert.equal(existsSync(cloneIdPath(projectDir)), false);
});

test("multiple Intents in one clone use the same audit shard identity", () => {
  const projectDir = freshProject();
  const first = birthIntentWithState(projectDir, "Payment API", "default", "poc");
  const second = birthIntentWithState(projectDir, "Admin API", "default", "poc");

  assert.equal(basename(first.auditPath), basename(second.auditPath));
  assert.equal(basename(first.auditPath), auditShardName(projectDir));
  assert.equal(readdirSync(join(first.recordDir, "audit")).length, 1);
  assert.equal(readdirSync(join(second.recordDir, "audit")).length, 1);
});

test("advance and skip persist a deterministic resume point", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(
    projectDir,
    "Payment API",
    "default",
    "mvp",
  );
  const plan = JSON.parse(readFileSync(born.state.planPath, "utf8")) as Array<{
    slug: string;
    action: "EXECUTE" | "SKIP";
  }>;
  const executable = plan
    .filter((stage) => stage.action === "EXECUTE")
    .map((stage) => stage.slug)
    .filter((slug) => !["workspace-scaffold", "workspace-detection", "state-init"].includes(slug));
  const [first, second, third] = executable;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);

  const advanced = completeCurrentStage(projectDir, first);
  assert.equal(advanced.nextStage, second);
  assert.equal(resumeIntentState(projectDir).currentStage, second);

  const skipped = skipCurrentStage(projectDir, second, "not needed for this iteration");
  assert.equal(skipped.nextStage, third);
  const resume = resumeIntentState(projectDir);
  assert.equal(resume.currentStage, third);
  assert.equal(resume.checkboxState, "in-progress");

  const state = readFileSync(born.state.statePath, "utf8");
  assert.match(state, new RegExp(`- \\[x\\] ${first} — EXECUTE`));
  assert.match(
    state,
    new RegExp(`- \\[S\\] ${second} — SKIP: not needed for this iteration`),
  );
  const transitionAudit = readFileSync(born.auditPath, "utf8");
  assert.deepEqual(
    [...transitionAudit.matchAll(/^\*\*Event\*\*: ([A-Z_]+)$/gm)]
      .map((match) => match[1])
      .slice(-4),
    [
      "STAGE_COMPLETED",
      "STAGE_STARTED",
      "STAGE_SKIPPED",
      "STAGE_STARTED",
    ],
  );
  assert.ok(transitionAudit.includes(`**Stage**: ${first}`));
  assert.match(
    transitionAudit,
    /\*\*Reason\*\*: not needed for this iteration/,
  );
  validateIntentState(projectDir);
});

test("finishing the plan completes the Intent registry entry", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(
    projectDir,
    "Tiny spike",
    "default",
    "poc",
  );

  for (;;) {
    const resume = resumeIntentState(projectDir);
    if (resume.status === "Completed") break;
    completeCurrentStage(projectDir, resume.currentStage);
  }

  const resume = resumeIntentState(projectDir);
  assert.equal(resume.status, "Completed");
  assert.equal(resume.currentStage, "none");
  assert.equal(readIntentRegistry(projectDir)[0]?.status, "complete");
  const audit = readFileSync(born.auditPath, "utf8");
  assert.deepEqual(
    [...audit.matchAll(/^\*\*Event\*\*: ([A-Z_]+)$/gm)]
      .map((match) => match[1])
      .slice(-4),
    [
      "STAGE_COMPLETED",
      "PHASE_COMPLETED",
      "PHASE_VERIFIED",
      "WORKFLOW_COMPLETED",
    ],
  );
  assert.match(audit, /\*\*Details\*\*: Scope: poc, \d+ stages completed/);
  validateIntentState(projectDir);
});

test("skipping the final stage records workflow completion with its reason", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(
    projectDir,
    "Disposable spike",
    "default",
    "poc",
  );

  for (;;) {
    const resume = resumeIntentState(projectDir);
    if (resume.nextStage === "none") {
      skipCurrentStage(projectDir, resume.currentStage, "result already proven");
      break;
    }
    completeCurrentStage(projectDir, resume.currentStage);
  }

  assert.equal(resumeIntentState(projectDir).status, "Completed");
  const audit = readFileSync(born.auditPath, "utf8");
  assert.deepEqual(
    [...audit.matchAll(/^\*\*Event\*\*: ([A-Z_]+)$/gm)]
      .map((match) => match[1])
      .slice(-4),
    [
      "STAGE_SKIPPED",
      "PHASE_COMPLETED",
      "PHASE_VERIFIED",
      "WORKFLOW_COMPLETED",
    ],
  );
  assert.match(audit, /\*\*Reason\*\*: result already proven/);
  assert.equal(readIntentRegistry(projectDir)[0]?.status, "complete");
});

test("an audit append failure leaves State unchanged", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(
    projectDir,
    "Audit failure",
    "default",
    "poc",
  );
  const before = readFileSync(born.state.statePath, "utf8");
  const current = resumeIntentState(projectDir).currentStage;

  rmSync(born.auditPath);
  mkdirSync(born.auditPath);

  assert.throws(
    () => completeCurrentStage(projectDir, current),
    /EISDIR|illegal operation on a directory/,
  );
  assert.equal(readFileSync(born.state.statePath, "utf8"), before);
  assert.equal(resumeIntentState(projectDir).currentStage, current);
});
