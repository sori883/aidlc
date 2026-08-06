import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { runSensorFireHook } from "../core/hooks/aidlc-sensor-fire.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  runSensorChecker,
} from "../core/tools/aidlc-sensor-checkers.ts";
import {
  fireSensor,
  type SensorFireResult,
} from "../core/tools/aidlc-sensor.ts";
import {
  completeCurrentStage,
  resumeIntentState,
} from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function freshIntent(): {
  projectDir: string;
  recordDir: string;
  auditPath: string;
} {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-sensor-runtime-"));
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(
    projectDir,
    "Payment API",
    "default",
    "mvp",
  );
  return {
    projectDir,
    recordDir: born.recordDir,
    auditPath: born.auditPath,
  };
}

function write(path: string, source: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  return path;
}

test("document checkers validate headings, Unit edges, coverage, and claim tags", () => {
  const { projectDir, recordDir } = freshIntent();
  const intentDir = join(recordDir, "ideation", "intent-capture");
  const questions = write(
    join(intentDir, "intent-capture-questions.md"),
    "# Questions\n\nA. Accept assumptions\n",
  );
  assert.ok(questions);
  const claims = write(
    join(intentDir, "intent-statement.md"),
    "# Intent\n\n## Summary\n\nPayment API. [desc]\n\n" +
      "## Assumptions & Open Questions\n\nNone. [assumption]\n",
  );
  const required = runSensorChecker("required-sections", {
    projectDir,
    stage: "intent-capture",
    filePath: claims,
  });
  assert.equal(required.pass, true);
  assert.equal(runSensorChecker("claim-sources", {
    projectDir,
    stage: "intent-capture",
    filePath: claims,
  }).pass, true);

  writeFileSync(claims, "# Intent\n\n## Summary\n\nUntagged claim.\n", "utf8");
  assert.equal(runSensorChecker("required-sections", {
    projectDir,
    stage: "intent-capture",
    filePath: claims,
  }).pass, false);
  assert.equal(runSensorChecker("claim-sources", {
    projectDir,
    stage: "intent-capture",
    filePath: claims,
  }).pass, false);

  const market = write(
    join(recordDir, "ideation", "market-research", "market-analysis.md"),
    "# Market\n\n## Evidence\n\nDerived from `intent-statement.md`.\n\n## Result\n\nOK.\n",
  );
  assert.equal(runSensorChecker("upstream-coverage", {
    projectDir,
    stage: "market-research",
    filePath: market,
  }).pass, true);
  writeFileSync(market, "# Market\n\n## Evidence\n\nNone.\n\n## Result\n\nOK.\n");
  assert.equal(runSensorChecker("upstream-coverage", {
    projectDir,
    stage: "market-research",
    filePath: market,
  }).pass, false);

  const dependency = write(
    join(recordDir, "inception", "units-generation", "unit-of-work-dependency.md"),
    "# Units\n\n## Graph\n\n```yaml\nunits:\n  - name: api\n    depends_on: [api]\n```\n\n## Notes\n\nTest.\n",
  );
  const dag = runSensorChecker("required-sections", {
    projectDir,
    stage: "units-generation",
    filePath: dependency,
  });
  assert.equal(dag.pass, false);
  assert.equal(dag.edge_block, "malformed");
});

test("code checkers use budget override when configured tools are unavailable", () => {
  const { projectDir } = freshIntent();
  const source = write(join(projectDir, "src", "index.ts"), "export const ok = true;\n");
  const lint = runSensorChecker("linter", {
    projectDir,
    stage: "code-generation",
    filePath: source,
  });
  const types = runSensorChecker("type-check", {
    projectDir,
    stage: "code-generation",
    filePath: source,
  });
  assert.equal(lint.budget_override, true);
  assert.equal(types.budget_override, true);
});

test("dispatcher pairs audit rows and writes failure detail without blocking", async () => {
  const { projectDir, recordDir, auditPath } = freshIntent();
  const output = write(
    join(recordDir, "ideation", "intent-capture", "intent-statement.md"),
    "# Intent\n\n## Summary\n\nText.\n\n## Risks\n\nNone.\n",
  );
  const statePath = join(recordDir, "aidlc-state.md");
  const stateBefore = readFileSync(statePath, "utf8");

  const passed = await fireSensor(
    projectDir,
    "required-sections",
    "intent-capture",
    output,
  );
  assert.equal(passed.outcome, "passed");
  assert.match(passed.fire_id, /^[a-f0-9]{8}$/);

  writeFileSync(output, "# Intent\n\n## Summary\n\nText.\n", "utf8");
  const failed = await fireSensor(
    projectDir,
    "required-sections",
    "intent-capture",
    output,
  );
  assert.equal(failed.outcome, "failed");
  assert.ok(failed.detail_path);
  assert.equal(existsSync(join(projectDir, failed.detail_path)), true);

  const audit = readFileSync(auditPath, "utf8");
  assert.equal((audit.match(/\*\*Event\*\*: SENSOR_FIRED/g) ?? []).length, 2);
  assert.equal((audit.match(/\*\*Event\*\*: SENSOR_PASSED/g) ?? []).length, 1);
  assert.equal((audit.match(/\*\*Event\*\*: SENSOR_FAILED/g) ?? []).length, 1);
  assert.match(audit, new RegExp(`\\*\\*Fire ID\\*\\*: ${failed.fire_id}`));
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);

  const before = readFileSync(auditPath, "utf8");
  await assert.rejects(
    () => fireSensor(projectDir, "linter", "intent-capture", output),
    /not bound/,
  );
  assert.equal(readFileSync(auditPath, "utf8"), before);
});

test("unavailable code tooling closes a fire with budget override", async () => {
  const { projectDir, auditPath } = freshIntent();
  while (resumeIntentState(projectDir).currentStage !== "code-generation") {
    const current = resumeIntentState(projectDir).currentStage;
    assert.notEqual(current, "none");
    completeCurrentStage(projectDir, current);
  }
  const source = write(join(projectDir, "src", "index.ts"), "export const ok = true;\n");
  const result = await fireSensor(
    projectDir,
    "linter",
    "code-generation",
    source,
  );
  assert.equal(result.outcome, "budget-override");
  assert.ok(result.detail_path);
  const audit = readFileSync(auditPath, "utf8");
  assert.match(audit, /\*\*Event\*\*: SENSOR_FIRED/);
  assert.match(audit, /\*\*Event\*\*: SENSOR_BUDGET_OVERRIDE/);
});

test("Write/Edit hook selects graph-bound matching Sensors and stays advisory", async () => {
  const { projectDir, recordDir } = freshIntent();
  const output = write(
    join(recordDir, "ideation", "intent-capture", "intent-statement.md"),
    "# Intent\n",
  );
  const calls: string[] = [];
  const result = await runSensorFireHook(
    projectDir,
    { tool_name: "Write", tool_input: { file_path: output } },
    async (_project, id, stage, path): Promise<SensorFireResult> => {
      calls.push(id);
      return {
        id,
        fire_id: "1234abcd",
        stage,
        output_path: relative(projectDir, path),
        outcome: "failed",
      };
    },
  );
  assert.equal(result.skipped, false);
  assert.deepEqual(calls, [
    "claim-sources",
    "required-sections",
    "upstream-coverage",
  ]);
  assert.equal(result.fired.every((fire) => fire.outcome === "failed"), true);
  assert.equal(
    existsSync(join(projectDir, ".aidlc-hooks-health", "sensor-fire.last")),
    true,
  );
});
