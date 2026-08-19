import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "bun:test";
import { runSensorFireHook } from "../core/hooks/aidlc-sensor-fire.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  runSensorChecker,
  stripIgnoredMarkdown,
} from "../core/tools/aidlc-sensor-checkers.ts";
import {
  classifySensorProcessResult,
  fireSensor,
  listSensorReceipts,
  parseCheckerProtocolResult,
  readSensorReceipt,
  sensorReceiptFreshness,
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

test("checker protocol survives trailing logs and classifies pass:false as failed", () => {
  const failed = { pass: false, findings: ["missing heading"] };
  assert.deepEqual(
    parseCheckerProtocolResult(
      `$ bun checker\n${JSON.stringify(failed)}\nerror: script exited with code 1\n`,
    ),
    failed,
  );
  assert.deepEqual(
    classifySensorProcessResult({
      code: 1,
      stdout: `${JSON.stringify(failed)}\nELIFECYCLE\n`,
      stderr: "package manager diagnostics\n",
      timedOut: false,
    }),
    { outcome: "failed", checkerResult: failed },
  );
  assert.deepEqual(
    classifySensorProcessResult({
      code: 0,
      stdout: `${JSON.stringify(failed)}\n`,
      stderr: "",
      timedOut: false,
    }),
    { outcome: "failed", checkerResult: failed },
  );
});

test("only unavailable or invalid checker protocol becomes budget override", () => {
  const cases = [
    {
      process: { code: null, stdout: "", stderr: "", timedOut: true },
      reason: "timeout",
    },
    {
      process: {
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: "ENOENT",
      },
      reason: "spawn-failed",
    },
    {
      process: { code: 1, stdout: "not json\n", stderr: "", timedOut: false },
      reason: "invalid-checker-protocol",
    },
    {
      process: {
        code: 1,
        stdout: '{"findings":[]}\n',
        stderr: "",
        timedOut: false,
      },
      reason: "invalid-checker-protocol",
    },
  ] as const;
  for (const entry of cases) {
    const result = classifySensorProcessResult(entry.process);
    assert.equal(result.outcome, "budget-override");
    assert.equal(result.reason, entry.reason);
  }
});

test("valid checker failures use protocol exit zero", () => {
  const { projectDir, recordDir } = freshIntent();
  const output = write(
    join(recordDir, "ideation", "intent-capture", "intent-statement.md"),
    "# Intent\n\n## Summary\n\nOnly one section.\n",
  );
  const result = spawnSync(process.execPath, [
    join(import.meta.dir, "../core/tools/aidlc-sensor-required-sections.ts"),
    "--stage",
    "intent-capture",
    "--file-path",
    output,
    "--project-dir",
    projectDir,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pass, false);
});

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

test("upstream coverage excludes consumes for a different Project Type", () => {
  const { projectDir, recordDir } = freshIntent();
  const stories = write(
    join(recordDir, "inception", "user-stories", "stories.md"),
    "# Stories\n\n## Inputs\n\nDerived from `requirements.md` and `team-practices.md`.\n\n" +
      "## Stories\n\nA user story.\n",
  );
  const result = runSensorChecker("upstream-coverage", {
    projectDir,
    stage: "user-stories",
    filePath: stories,
  });
  assert.equal(result.project_type, "greenfield");
  assert.deepEqual(result.applicable_artifacts, ["requirements", "team-practices"]);
  assert.equal(result.pass, true);
});

test("claim source filtering ignores fences, comments, and only the Review H2 range", () => {
  const { projectDir, recordDir } = freshIntent();
  const directory = join(recordDir, "ideation", "intent-capture");
  write(
    join(directory, "intent-capture-questions.md"),
    "# Questions\n\nA. Accept assumptions\n",
  );
  const claims = write(
    join(directory, "intent-statement.md"),
    "# Intent\n\n## Summary\n\nPayment flow. [desc]\n\n" +
      "```markdown\nUntagged example claim.\n## Review\nStill fenced.\n```\n\n" +
      "<!--\nUntagged hidden claim.\n" +
      "-->\n\n## Review\n\nUntagged reviewer prose.\n\n" +
      "## Decision\n\nSupported decision. [scope]\n\n" +
      "## Assumptions & Open Questions\n\nNone. [assumption]\n",
  );
  const stripped = stripIgnoredMarkdown(readFileSync(claims, "utf8"));
  assert.doesNotMatch(stripped, /reviewer prose|example claim|hidden claim/);
  assert.match(stripped, /## Decision\n\nSupported decision/);
  assert.equal(runSensorChecker("claim-sources", {
    projectDir,
    stage: "intent-capture",
    filePath: claims,
  }).pass, true);

  writeFileSync(
    claims,
    readFileSync(claims, "utf8").replace(
      "Supported decision. [scope]",
      "Untagged claim after Review.",
    ),
    "utf8",
  );
  const failed = runSensorChecker("claim-sources", {
    projectDir,
    stage: "intent-capture",
    filePath: claims,
  });
  assert.equal(failed.pass, false);
  assert.match(String((failed.findings as string[]).join("\n")), /:23: claim has no source tag/);
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
  assert.ok(passed.receipt_path);
  assert.equal(passed.receipt_fresh, true);
  const passedReceipt = readSensorReceipt(join(projectDir, passed.receipt_path!));
  assert.equal(passedReceipt.output_path, relative(projectDir, output));
  assert.match(passedReceipt.output_sha256, /^[a-f0-9]{64}$/);
  assert.match(passedReceipt.input_sha256, /^[a-f0-9]{64}$/);
  assert.match(passedReceipt.sensor_version, /^[a-f0-9]{64}$/);

  writeFileSync(output, "# Intent\n\n## Summary\n\nText.\n", "utf8");
  const stale = sensorReceiptFreshness(projectDir, passedReceipt);
  assert.equal(stale.fresh, false);
  assert.ok(stale.reasons.includes("output-changed"));
  assert.ok(stale.reasons.includes("input-changed"));
  const failed = await fireSensor(
    projectDir,
    "required-sections",
    "intent-capture",
    output,
  );
  assert.equal(failed.outcome, "failed");
  assert.ok(failed.detail_path);
  assert.ok(failed.receipt_path);
  assert.equal(failed.receipt_fresh, true);
  assert.equal(existsSync(join(projectDir, failed.detail_path)), true);
  const receipts = listSensorReceipts(projectDir);
  assert.equal(receipts.length, 2);
  assert.equal(receipts.filter((entry) => entry.freshness.fresh).length, 1);

  const audit = readFileSync(auditPath, "utf8");
  assert.equal((audit.match(/\*\*Event\*\*: SENSOR_FIRED/g) ?? []).length, 2);
  assert.equal((audit.match(/\*\*Event\*\*: SENSOR_PASSED/g) ?? []).length, 1);
  assert.equal((audit.match(/\*\*Event\*\*: SENSOR_FAILED/g) ?? []).length, 1);
  assert.match(audit, new RegExp(`\\*\\*Fire ID\\*\\*: ${failed.fire_id}`));
  for (const fireId of [passed.fire_id, failed.fire_id]) {
    const terminalBlocks = audit.split("\n---\n").filter((block) =>
      block.includes(`**Fire ID**: ${fireId}`) &&
      /\*\*Event\*\*: SENSOR_(?:PASSED|FAILED|BUDGET_OVERRIDE)/.test(block)
    );
    assert.equal(terminalBlocks.length, 1, fireId);
  }
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

test("a Sensor receipt becomes stale when a semantic sibling input changes", async () => {
  const { projectDir, recordDir } = freshIntent();
  const directory = join(recordDir, "ideation", "intent-capture");
  const output = write(
    join(directory, "intent-statement.md"),
    "# Intent\n\n## Summary\n\nText.\n\n## Risks\n\nNone.\n",
  );
  const fired = await fireSensor(
    projectDir,
    "required-sections",
    "intent-capture",
    output,
  );
  const receipt = readSensorReceipt(join(projectDir, fired.receipt_path!));
  write(join(directory, "additional-context.md"), "# Context\n\n## A\n\nA.\n\n## B\n\nB.\n");
  const freshness = sensorReceiptFreshness(projectDir, receipt);
  assert.equal(freshness.fresh, false);
  assert.deepEqual(freshness.reasons, ["input-changed"]);
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
