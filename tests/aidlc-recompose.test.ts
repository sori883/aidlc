import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  addStagesToExecutionPlan,
  completeCurrentStage,
  planFilePath,
  resumeIntentState,
  stateFilePath,
} from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function runningBugfix(): ReturnType<typeof birthIntentWithState> & { projectDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-recompose-"));
  initializeWorkspace(projectDir);
  return {
    projectDir,
    ...birthIntentWithState(projectDir, "Fix payment bug", "default", "bugfix"),
  };
}

test("recompose adds a pending forward Stage to Plan, State, routing, and Audit", () => {
  const fixture = runningBugfix();
  const before = resumeIntentState(fixture.projectDir);
  assert.equal(before.currentStage, "requirements-analysis");
  assert.equal(before.nextStage, "code-generation");

  const result = addStagesToExecutionPlan(fixture.projectDir, ["user-stories"]);
  const plan = JSON.parse(readFileSync(planFilePath(fixture.projectDir), "utf8")) as
    Array<{ slug: string; action: string }>;
  const state = readFileSync(stateFilePath(fixture.projectDir), "utf8");
  const audit = readFileSync(fixture.auditPath, "utf8");

  assert.deepEqual(result.added, ["user-stories"]);
  assert.equal(result.currentStage, "requirements-analysis");
  assert.equal(result.nextStage, "user-stories");
  assert.equal(plan.find((stage) => stage.slug === "user-stories")?.action, "EXECUTE");
  assert.match(state, /^- \[ \] user-stories — EXECUTE$/m);
  assert.match(state, /^- \*\*Next Stage\*\*: user-stories$/m);
  assert.match(state, /^- \*\*Stages to Execute\*\*: .*2\.4/m);
  assert.doesNotMatch(state, /^- \*\*Stages to Skip\*\*: .*user-stories/m);
  assert.match(audit, /\*\*Event\*\*: RECOMPOSED/);
  assert.match(audit, /\*\*Stages added\*\*: user-stories/);

  completeCurrentStage(fixture.projectDir, "requirements-analysis");
  assert.equal(resumeIntentState(fixture.projectDir).currentStage, "user-stories");
});

test("recompose CLI accepts --add and returns the recomposed plan as JSON", () => {
  const fixture = runningBugfix();
  const result = spawnSync(
    process.execPath,
    [
      "core/tools/aidlc-utility.ts",
      "recompose",
      "--project-dir",
      fixture.projectDir,
      "--add",
      "user-stories",
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(payload.added, ["user-stories"]);
  assert.equal(payload.nextStage, "user-stories");
});

test("recompose rejects invalid, active, already executing, and starved Stages", () => {
  const fixture = runningBugfix();
  assert.throws(
    () => addStagesToExecutionPlan(fixture.projectDir, ["missing-stage"]),
    /unknown Stage/,
  );
  assert.throws(
    () => addStagesToExecutionPlan(fixture.projectDir, ["requirements-analysis"]),
    /only a pending Stage/,
  );
  assert.throws(
    () => addStagesToExecutionPlan(fixture.projectDir, ["code-generation"]),
    /already executes/,
  );
  assert.throws(
    () => addStagesToExecutionPlan(fixture.projectDir, ["application-design"]),
    /required Stage "refined-mockups" is skipped/,
  );
});

test("recompose rejects an anchor move, autonomous execution, and completed workflow without mutation", () => {
  const anchorFixture = runningBugfix();
  const anchorState = readFileSync(stateFilePath(anchorFixture.projectDir), "utf8");
  assert.throws(
    () => addStagesToExecutionPlan(anchorFixture.projectDir, ["functional-design"]),
    /walking-skeleton anchor/,
  );
  assert.equal(readFileSync(stateFilePath(anchorFixture.projectDir), "utf8"), anchorState);

  const autonomous = runningBugfix();
  const autonomousState = readFileSync(stateFilePath(autonomous.projectDir), "utf8")
    .replace(
      "- **Construction Autonomy Mode**: unset",
      "- **Construction Autonomy Mode**: autonomous",
    );
  writeFileSync(stateFilePath(autonomous.projectDir), autonomousState, "utf8");
  const autonomousPlan = readFileSync(planFilePath(autonomous.projectDir), "utf8");
  assert.throws(
    () => addStagesToExecutionPlan(autonomous.projectDir, ["user-stories"]),
    /Construction Autonomy Mode is autonomous/,
  );
  assert.equal(readFileSync(stateFilePath(autonomous.projectDir), "utf8"), autonomousState);
  assert.equal(readFileSync(planFilePath(autonomous.projectDir), "utf8"), autonomousPlan);

  const completed = runningBugfix();
  const completedState = readFileSync(stateFilePath(completed.projectDir), "utf8")
    .replace("- **Status**: Running", "- **Status**: Completed");
  writeFileSync(stateFilePath(completed.projectDir), completedState, "utf8");
  assert.throws(
    () => addStagesToExecutionPlan(completed.projectDir, ["user-stories"]),
    /workflow Status is not Running/,
  );
  assert.equal(readFileSync(stateFilePath(completed.projectDir), "utf8"), completedState);
});
