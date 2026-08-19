import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import {
  abortBolt,
  approveBoltGate,
  completeBolt,
  completeBoltStageUnit,
  currentBoltStage,
  failBolt,
  initializeBoltExecution,
  loadBoltExecution,
  nextBoltExecution,
  recordBoltIntegration,
  retryBolt,
  setBoltAutonomy,
  skipBolt,
  startBolt,
} from "../core/tools/aidlc-bolt.ts";
import { parseBoltPlan } from "../core/tools/aidlc-bolt-plan.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { resumeIntentState } from "../core/tools/aidlc-state.ts";
import type { UnitDag } from "../core/tools/aidlc-unit-graph.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";
import {
  boltWorktreePath,
  createWorktree,
  mergeWorktree,
} from "../core/tools/aidlc-worktree.ts";

const UNIT_DAG: UnitDag = {
  units: [
    { name: "foundation", depends_on: [] },
    { name: "experience", depends_on: ["foundation"] },
    { name: "worker", depends_on: ["foundation"] },
  ],
  batches: [["foundation"], ["experience", "worker"]],
};

const BOLT_PLAN = `# Bolt Plan

## Machine Contract

\`\`\`yaml
bolt_plan:
  version: 1
  worktree:
    enabled: false
    base_ref: main
    target_branch: main
    strategy: squash
  bolts:
    - id: B1
      slug: walking-skeleton
      units: [foundation, experience]
      depends_on: []
      walking_skeleton: true
      batch: 1
    - id: B2
      slug: background-worker
      units: [worker]
      depends_on: [B1]
      walking_skeleton: false
      batch: 2
    - id: B3
      slug: foundation-hardening
      units: [foundation]
      depends_on: [B1]
      walking_skeleton: false
      batch: 2
\`\`\`

## Rationale

Thin slices intentionally revisit foundation in B3.
`;

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function freshConstruction(worktreeEnabled = false): {
  projectDir: string;
  recordDir: string;
  statePath: string;
  auditPath: string;
  boltPlanPath: string;
} {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-bolt-"));
  if (worktreeEnabled) {
    git(projectDir, "init", "-b", "main");
    git(projectDir, "config", "user.email", "aidlc@example.test");
    git(projectDir, "config", "user.name", "AI-DLC Test");
  }
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "Bolt contract", "default", "mvp");
  const unitPath = join(
    born.recordDir,
    "inception",
    "units-generation",
    "unit-of-work-dependency.md",
  );
  write(
    unitPath,
    `# Units\n\n## Graph\n\n\`\`\`yaml\nunits:\n` +
      `  - name: foundation\n    depends_on: []\n` +
      `  - name: experience\n    depends_on: [foundation]\n` +
      `  - name: worker\n    depends_on: [foundation]\n\`\`\`\n`,
  );
  const boltPlanPath = join(
    born.recordDir,
    "inception",
    "delivery-planning",
    "bolt-plan.md",
  );
  write(
    boltPlanPath,
    worktreeEnabled
      ? BOLT_PLAN.replace("enabled: false", "enabled: true")
      : BOLT_PLAN,
  );

  let state = readFileSync(born.state.statePath, "utf8");
  state = state
    .replace(/- \*\*Lifecycle Phase\*\*:[^\n]*/, "- **Lifecycle Phase**: CONSTRUCTION")
    .replace(/- \*\*Current Stage\*\*:[^\n]*/, "- **Current Stage**: functional-design")
    .replace("- [-] intent-capture — EXECUTE", "- [ ] intent-capture — EXECUTE")
    .replace("- [ ] functional-design — EXECUTE", "- [-] functional-design — EXECUTE");
  writeFileSync(born.state.statePath, state, "utf8");
  if (worktreeEnabled) {
    writeFileSync(join(projectDir, "base.txt"), "base\n", "utf8");
    git(projectDir, "add", ".");
    git(projectDir, "commit", "-m", "initial");
  }
  return {
    projectDir,
    recordDir: born.recordDir,
    statePath: born.state.statePath,
    auditPath: born.auditPath,
    boltPlanPath,
  };
}

function finishBoltStages(projectDir: string, boltId: string): void {
  for (;;) {
    const cursor = currentBoltStage(projectDir, boltId);
    if (cursor === null) return;
    completeBoltStageUnit(
      projectDir,
      boltId,
      cursor.stage,
      cursor.unit,
    );
  }
}

test("Bolt Plan parser validates batches, Unit dependencies, and thin slices", () => {
  const plan = parseBoltPlan(BOLT_PLAN, UNIT_DAG, "bolt-plan.md");
  assert.equal(plan.schemaVersion, 1);
  assert.deepEqual(plan.batches, [["B1"], ["B2", "B3"]]);
  assert.equal(plan.bolts[0]?.walkingSkeleton, true);
  assert.deepEqual(plan.bolts[2]?.units, ["foundation"]);

  assert.throws(
    () => parseBoltPlan(BOLT_PLAN.replace("units: [worker]", "units: [missing]"), UNIT_DAG),
    /unknown Unit "missing"/,
  );
  assert.throws(
    () => parseBoltPlan(
      BOLT_PLAN.replace("depends_on: [B1]\n      walking_skeleton: false\n      batch: 2", "depends_on: []\n      walking_skeleton: false\n      batch: 2"),
      UNIT_DAG,
    ),
    /Unit dependency|batch/,
  );
  assert.throws(
    () => parseBoltPlan(BOLT_PLAN.replace("id: B3", "id: B2"), UNIT_DAG),
    /duplicate Bolt id "B2"/,
  );
  assert.throws(
    () => parseBoltPlan(BOLT_PLAN.replace("walking_skeleton: true", "walking_skeleton: false"), UNIT_DAG),
    /exactly one walking skeleton/,
  );
});

test("Bolt lifecycle is deterministic across gate, autonomy, parallel batch, failure, and retry", () => {
  const fixture = freshConstruction();
  const initialized = initializeBoltExecution(fixture.projectDir);
  assert.deepEqual(initialized.next.readyBoltIds, ["B1"]);
  assert.equal(initializeBoltExecution(fixture.projectDir).replay, true);

  startBolt(fixture.projectDir, "B1");
  assert.equal(resumeIntentState(fixture.projectDir).currentBolt, "B1");
  assert.equal(loadBoltExecution(fixture.projectDir).next.status, "running");
  finishBoltStages(fixture.projectDir, "B1");
  assert.equal(completeBolt(fixture.projectDir, "B1").status, "awaiting-gate");
  assert.equal(loadBoltExecution(fixture.projectDir).next.status, "awaiting-gate");
  assert.throws(() => completeBolt(fixture.projectDir, "B1"), /awaiting gate/);
  approveBoltGate(fixture.projectDir, "B1", "Approve");
  assert.equal(loadBoltExecution(fixture.projectDir).next.status, "awaiting-autonomy");
  assert.equal(approveBoltGate(fixture.projectDir, "B1", "Approve").replay, true);
  setBoltAutonomy(fixture.projectDir, "autonomous");
  assert.equal(setBoltAutonomy(fixture.projectDir, "autonomous").replay, true);
  assert.equal(loadBoltExecution(fixture.projectDir).next.status, "ready-to-complete");
  assert.equal(completeBolt(fixture.projectDir, "B1").status, "completed");
  assert.deepEqual(nextBoltExecution(fixture.projectDir).readyBoltIds, ["B2", "B3"]);

  startBolt(fixture.projectDir, "B2", {
    worktreePath: "/tmp/aidlc-b2",
    ref: "refs/heads/aidlc/background-worker",
  });
  startBolt(fixture.projectDir, "B3");
  failBolt(fixture.projectDir, "B2", "generation failed");
  finishBoltStages(fixture.projectDir, "B3");
  assert.equal(completeBolt(fixture.projectDir, "B3").status, "completed");
  assert.equal(nextBoltExecution(fixture.projectDir).status, "failed-awaiting-choice");
  retryBolt(fixture.projectDir, "B2");
  finishBoltStages(fixture.projectDir, "B2");
  assert.equal(completeBolt(fixture.projectDir, "B2").status, "ready-to-complete");
  recordBoltIntegration(fixture.projectDir, "B2", "deadbeef");
  assert.equal(completeBolt(fixture.projectDir, "B2").status, "completed");
  assert.equal(nextBoltExecution(fixture.projectDir).status, "all-complete");

  const execution = loadBoltExecution(fixture.projectDir);
  assert.equal(execution.state.bolts.find((bolt) => bolt.id === "B2")?.attempt, 2);
  assert.equal(execution.state.bolts.find((bolt) => bolt.id === "B3")?.status, "completed");
  const state = readFileSync(fixture.statePath, "utf8");
  assert.match(state, /- \*\*Construction Autonomy Mode\*\*: autonomous/);
  assert.match(state, /- \[x\] Bolt: B1 — walking-skeleton/);
  assert.match(state, /- \[x\] Bolt: B2 — background-worker/);
  assert.match(state, /- \[x\] Bolt: B3 — foundation-hardening/);

  const audit = readFileSync(fixture.auditPath, "utf8");
  assert.equal((audit.match(/\*\*Event\*\*: BOLT_STARTED/g) ?? []).length, 4);
  assert.equal((audit.match(/\*\*Event\*\*: BOLT_COMPLETED/g) ?? []).length, 3);
  assert.equal((audit.match(/\*\*Event\*\*: BOLT_FAILED/g) ?? []).length, 1);
  assert.equal((audit.match(/\*\*Event\*\*: AUTONOMY_MODE_SET/g) ?? []).length, 1);
});

test("failed Bolt can be skipped or aborted without advancing implicitly", () => {
  const fixture = freshConstruction();
  initializeBoltExecution(fixture.projectDir);
  startBolt(fixture.projectDir, "B1");
  finishBoltStages(fixture.projectDir, "B1");
  completeBolt(fixture.projectDir, "B1");
  approveBoltGate(fixture.projectDir, "B1", "Approve");
  setBoltAutonomy(fixture.projectDir, "autonomous");
  completeBolt(fixture.projectDir, "B1");

  startBolt(fixture.projectDir, "B2");
  failBolt(fixture.projectDir, "B2", "broken");
  skipBolt(fixture.projectDir, "B2", "not required", "Skip");
  assert.deepEqual(nextBoltExecution(fixture.projectDir).readyBoltIds, ["B3"]);

  startBolt(fixture.projectDir, "B3");
  failBolt(fixture.projectDir, "B3", "broken again");
  abortBolt(fixture.projectDir, "B3", "stop construction", "Abort");
  assert.equal(nextBoltExecution(fixture.projectDir).status, "aborted");
  retryBolt(fixture.projectDir, "B3");
  finishBoltStages(fixture.projectDir, "B3");
  completeBolt(fixture.projectDir, "B3");
  assert.equal(nextBoltExecution(fixture.projectDir).status, "all-complete");
  assert.match(readFileSync(fixture.statePath, "utf8"), /- \[S\] Bolt: B2/);
});

test("a Worktree-backed Bolt cannot complete before verified integration", () => {
  const fixture = freshConstruction(true);
  initializeBoltExecution(fixture.projectDir);
  const created = createWorktree({
    projectDir: fixture.projectDir,
    slug: "walking-skeleton",
    base: "main",
  });
  const worktreePath = boltWorktreePath(fixture.projectDir, "walking-skeleton");
  startBolt(fixture.projectDir, "B1", {
    worktreePath,
    ref: String(created.branch),
  });
  finishBoltStages(fixture.projectDir, "B1");
  assert.equal(completeBolt(fixture.projectDir, "B1").status, "awaiting-gate");
  approveBoltGate(fixture.projectDir, "B1", "Approve");
  setBoltAutonomy(fixture.projectDir, "autonomous");
  assert.equal(completeBolt(fixture.projectDir, "B1").status, "ready-to-complete");

  writeFileSync(join(worktreePath, "walking.txt"), "walking skeleton\n", "utf8");
  git(worktreePath, "add", "walking.txt");
  git(worktreePath, "commit", "-m", "walking skeleton");
  const merged = mergeWorktree({
    projectDir: fixture.projectDir,
    slug: "walking-skeleton",
    target: "main",
    strategy: "squash",
  });
  const integrated = recordBoltIntegration(
    fixture.projectDir,
    "B1",
    String(merged.commit_sha),
  );
  assert.equal(integrated.status, "ready-to-complete");
  assert.equal(completeBolt(fixture.projectDir, "B1").status, "completed");
  const run = loadBoltExecution(fixture.projectDir).state.bolts[0]!;
  assert.equal(run.worktreeStatus, "merged");
  assert.equal(run.ref, merged.commit_sha);
  assert.equal(run.worktreePath, ".aidlc/worktrees/bolt-walking-skeleton");
});

test("invalid plan and audit failure leave State unchanged", () => {
  const invalid = freshConstruction();
  writeFileSync(
    invalid.boltPlanPath,
    BOLT_PLAN.replace("units: [worker]", "units: [unknown]"),
    "utf8",
  );
  const beforeInvalid = readFileSync(invalid.statePath, "utf8");
  assert.throws(() => initializeBoltExecution(invalid.projectDir), /unknown Unit/);
  assert.equal(readFileSync(invalid.statePath, "utf8"), beforeInvalid);

  const brokenAudit = freshConstruction();
  initializeBoltExecution(brokenAudit.projectDir);
  const beforeStart = readFileSync(brokenAudit.statePath, "utf8");
  rmSync(brokenAudit.auditPath);
  mkdirSync(brokenAudit.auditPath);
  assert.throws(
    () => startBolt(brokenAudit.projectDir, "B1"),
    /EISDIR|illegal operation on a directory/,
  );
  assert.equal(readFileSync(brokenAudit.statePath, "utf8"), beforeStart);
});

test("pre-Bolt State v7 migrates deterministically but in-flight plan drift stops", () => {
  const fixture = freshConstruction();
  writeFileSync(
    fixture.statePath,
    readFileSync(fixture.statePath, "utf8").replace(
      "- **State Version**: 8",
      "- **State Version**: 7",
    ),
    "utf8",
  );
  const auditBefore = readFileSync(fixture.auditPath, "utf8");
  initializeBoltExecution(fixture.projectDir);
  assert.match(readFileSync(fixture.statePath, "utf8"), /- \*\*State Version\*\*: 8/);
  assert.equal(readFileSync(fixture.auditPath, "utf8"), auditBefore);

  writeFileSync(
    fixture.boltPlanPath,
    BOLT_PLAN.replace("slug: foundation-hardening", "slug: foundation-revised"),
    "utf8",
  );
  assert.throws(
    () => loadBoltExecution(fixture.projectDir),
    /manual migration|required|Invalid Bolt execution state/,
  );
});
