import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import {
  checkQualityGates,
  parseQualityGateManifest,
} from "../core/tools/aidlc-quality-gate.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  activeIntentRecordDir,
  completeCurrentStage,
  resumeIntentState,
} from "../core/tools/aidlc-state.ts";
import {
  reportStageResult,
  resolveNextDirective,
} from "../core/tools/aidlc-orchestrate.ts";
import { ensureStageMemory } from "../core/tools/aidlc-memory.ts";
import { persistLearnings } from "../core/tools/aidlc-learnings.ts";

const GATES = [
  ["node", "node-test", "test:node"],
  ["workerd", "workerd-test", "test:workerd"],
  ["browser", "browser-test", "test:browser"],
  ["coverage", "coverage", "test:coverage"],
  ["build", "build", "build"],
  ["architecture", "architecture", "check:architecture"],
  ["security", "security", "check:security"],
] as const;

function write(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
}

function workflow(): string {
  const jobs = GATES.map(([id, _kind, script]) => `  ${id}:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm run ${script}
`).join("");
  return `name: Quality
on: [push, pull_request]
jobs:
${jobs}  quality:
    name: Quality
    runs-on: ubuntu-latest
    needs: [${GATES.map(([id]) => id).join(", ")}]
    steps:
      - run: echo ready
`;
}

function manifest(provider = "github-actions"): Record<string, unknown> {
  return {
    version: 1,
    provider: { id: provider },
    package: { path: "package.json", manager: "pnpm" },
    workflows: [
      { name: "Quality", path: ".github/workflows/quality.yml" },
      { name: "Trusted Preview", path: ".github/workflows/preview.yml" },
    ],
    gates: GATES.map(([id, kind, script]) => ({
      id,
      kind,
      required: true,
      script,
      workflow: "Quality",
      job: id,
      runtime: "node",
    })),
    aggregate: {
      workflow: "Quality",
      job: "quality",
      required_check: "Quality / Quality",
    },
    required_checks: ["Quality / Quality"],
  };
}

function fixture(): { projectDir: string; manifestPath: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-quality-gate-"));
  write(
    join(projectDir, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      scripts: Object.fromEntries(GATES.map(([_id, _kind, script]) => [script, "echo ok"])),
    }, null, 2)}\n`,
  );
  write(join(projectDir, ".github", "workflows", "quality.yml"), workflow());
  write(
    join(projectDir, ".github", "workflows", "preview.yml"),
    `name: Trusted Preview
on:
  workflow_run:
    workflows: [Quality]
    types: [completed]
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - run: echo preview
`,
  );
  const manifestPath = join(projectDir, "quality-gate-manifest.json");
  write(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
  return { projectDir, manifestPath };
}

test("GitHub Actions provider validates all required gates and stable aggregate check", () => {
  const { projectDir } = fixture();
  const result = checkQualityGates(projectDir, {
    manifestPath: "quality-gate-manifest.json",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.actionlint.status, "not-requested");
});

test("semantic validation catches missing jobs, scripts, fresh-runner setup, and workflow names", () => {
  const { projectDir, manifestPath } = fixture();
  const packagePath = join(projectDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  delete packageJson.scripts["test:browser"];
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const qualityPath = join(projectDir, ".github", "workflows", "quality.yml");
  writeFileSync(
    qualityPath,
    readFileSync(qualityPath, "utf8")
      .replace(/  workerd:\n[\s\S]*?(?=  browser:)/, "")
      .replace("      - uses: actions/setup-node@v4\n", "")
      .replace("      - run: pnpm install --frozen-lockfile\n", "")
      .replace(", security]", "]"),
    "utf8",
  );
  const previewPath = join(projectDir, ".github", "workflows", "preview.yml");
  writeFileSync(
    previewPath,
    readFileSync(previewPath, "utf8").replace("workflows: [Quality]", "workflows: [CI-Q]"),
    "utf8",
  );
  const result = checkQualityGates(projectDir, { manifestPath });
  assert.equal(result.valid, false);
  const codes = new Set(result.findings.map((row) => row.code));
  for (const code of [
    "gate.job-missing",
    "gate.script-missing",
    "gate.runtime-not-prepared",
    "gate.frozen-install-missing",
    "aggregate.need-missing",
    "workflow-run.target-missing",
  ]) assert.ok(codes.has(code), code);
});

test("schema validation and provider validation remain separate", () => {
  assert.throws(
    () => parseQualityGateManifest('{"version":1}', "manifest.json"),
    /provider must be an object/,
  );
  const { projectDir, manifestPath } = fixture();
  writeFileSync(manifestPath, `${JSON.stringify(manifest("gitlab-ci"), null, 2)}\n`);
  const unsupported = checkQualityGates(projectDir, { manifestPath });
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.findings[0]?.code, "provider.unsupported");

  writeFileSync(
    join(projectDir, ".github", "workflows", "quality.yml"),
    "name: Quality\njobs:\n  broken: [\n",
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
  const malformed = checkQualityGates(projectDir, { manifestPath });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.findings.some((row) => row.code === "workflow.yaml-invalid"));
});

test("CI Pipeline cannot open its Stage gate before semantic validation passes", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-quality-stage-"));
  initializeWorkspace(projectDir);
  birthIntentWithState(projectDir, "Quality pipeline", "default", "mvp");
  while (resumeIntentState(projectDir).currentStage !== "ci-pipeline") {
    const current = resumeIntentState(projectDir).currentStage;
    assert.notEqual(current, "none");
    completeCurrentStage(projectDir, current);
  }
  const blocked = reportStageResult(projectDir, {
    stage: "ci-pipeline",
    result: "awaiting-approval",
  });
  assert.equal(blocked.kind, "error");
  if (blocked.kind === "error") assert.match(blocked.message, /Quality Gate|ENOENT/);

  write(
    join(projectDir, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      scripts: Object.fromEntries(GATES.map(([_id, _kind, script]) => [script, "echo ok"])),
    }, null, 2)}\n`,
  );
  write(join(projectDir, ".github", "workflows", "quality.yml"), workflow());
  write(
    join(projectDir, ".github", "workflows", "preview.yml"),
    "name: Trusted Preview\non:\n  workflow_run:\n    workflows: [Quality]\njobs:\n  preview:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preview\n",
  );
  const outputDir = join(activeIntentRecordDir(projectDir), "construction", "ci-pipeline");
  for (const name of ["ci-config.md", "quality-gates.md", "ci-pipeline-questions.md"]) {
    write(join(outputDir, name), `# ${name}\n\n## A\n\nA.\n\n## B\n\nB.\n`);
  }
  write(
    join(outputDir, "quality-gate-manifest.json"),
    `${JSON.stringify(manifest(), null, 2)}\n`,
  );

  let directive = resolveNextDirective(projectDir);
  while (directive.kind === "load-steering") {
    directive = resolveNextDirective(projectDir, {
      continueToken: directive.continue_token,
    });
  }
  assert.equal(directive.kind, "run-stage");
  if (directive.kind !== "run-stage") return;
  ensureStageMemory(projectDir, directive.memory_path);
  const learningsDir = join(activeIntentRecordDir(projectDir), ".aidlc-learnings");
  const selections = join(learningsDir, "ci-pipeline-selections.json");
  write(selections, `${JSON.stringify({
    version: 1,
    stage: "ci-pipeline",
    anything_to_add_answered: true,
    selections: [],
  }, null, 2)}\n`);
  persistLearnings(projectDir, "ci-pipeline", selections);

  const ready = reportStageResult(projectDir, {
    stage: "ci-pipeline",
    result: "awaiting-approval",
  });
  assert.equal(ready.kind, "done");
});
