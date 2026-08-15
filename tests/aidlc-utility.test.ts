import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  canonicalScopeTable,
  canonicalStageTable,
  detectProject,
  renderScopeTable,
  renderStageTable,
  resolveCodekbPath,
} from "../core/tools/aidlc-utility.ts";
import { loadCompiledStageGraph } from "../core/tools/aidlc-graph.ts";
import {
  birthIntent,
  birthIntentWithState,
} from "../core/tools/aidlc-intent.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function brownfieldFixture(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-utility-"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src", "main.ts"), "export {};\n", "utf8");
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ dependencies: { react: "latest" } }),
    "utf8",
  );
  writeFileSync(join(projectDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  return projectDir;
}

test("detectProject returns the upstream scan and resolved Scope registries", () => {
  const projectDir = brownfieldFixture();
  const before = readdirSync(projectDir).sort();
  const result = detectProject(projectDir);

  assert.equal(result.projectType, "Brownfield");
  assert.equal(result.languages, "TypeScript");
  assert.equal(result.frameworks, "React");
  assert.equal(result.buildSystem, "pnpm (package.json)");
  assert.match(result.scopesDir, /\/core\/scopes$/);
  assert.match(result.scopeGridPath, /\/core\/aidlc-common\/data\/scope-grid\.json$/);
  assert.deepEqual(result.scopes, [
    "bugfix",
    "enterprise",
    "feature",
    "infra",
    "mvp",
    "poc",
    "refactor",
    "security-patch",
    "workshop",
  ]);
  assert.deepEqual(readdirSync(projectDir).sort(), before);
});

test("utility detect --json works without an initialized AI-DLC Workspace", () => {
  const projectDir = brownfieldFixture();
  const result = spawnSync(
    process.execPath,
    [
      "core/tools/aidlc-utility.ts",
      "detect",
      "--project-dir",
      projectDir,
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.projectType, "Brownfield");
  assert.equal(payload.languages, "TypeScript");
  assert.equal(payload.buildSystem, "pnpm (package.json)");
});

test("scope-table is deterministic, alphabetical, and covers all Scope rows", () => {
  const first = renderScopeTable();
  assert.equal(renderScopeTable(), first);
  const rows = first.split("\n").slice(2);
  assert.equal(rows.length, 9);
  assert.deepEqual(
    rows.map((row) => row.split("|")[1]?.trim()),
    [
      "bugfix",
      "enterprise",
      "feature",
      "infra",
      "mvp",
      "poc",
      "refactor",
      "security-patch",
      "workshop",
    ],
  );
  assert.match(first, /\| workshop\s+\| Standard\s+\| Minimal\s+\|/);
  assert.match(
    canonicalScopeTable(),
    /^<!-- BEGIN: compiled scope grid - do NOT hand-edit -->/,
  );
  assert.doesNotMatch(canonicalScopeTable(), /\bbun\b/);
  assert.match(canonicalScopeTable(), /<!-- END: compiled scope grid -->$/);
});

test("stage-table names every compiled Stage exactly once in graph order", () => {
  const graph = loadCompiledStageGraph();
  const table = renderStageTable();
  const rows = table.split("\n").slice(2);
  assert.equal(rows.length, graph.length);
  assert.deepEqual(
    rows.map((row) => row.split("|")[1]?.trim()),
    graph.map((stage) => stage.slug),
  );
  for (const stage of graph) {
    assert.equal(
      rows.filter((row) => row.startsWith(`| ${stage.slug} |`)).length,
      1,
    );
  }
  assert.match(
    canonicalStageTable(),
    /^<!-- BEGIN: compiled stage graph - do NOT hand-edit -->/,
  );
  assert.doesNotMatch(canonicalStageTable(), /\bbun\b/);
  assert.match(canonicalStageTable(), /<!-- END: compiled stage graph -->$/);
});

test("scope-table and stage-table CLI commands emit their canonical regions", () => {
  for (const [command, expected] of [
    ["scope-table", canonicalScopeTable()],
    ["stage-table", canonicalStageTable()],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      ["core/tools/aidlc-utility.ts", command],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${expected}\n`);
  }
});

test("resolveCodekbPath uses the only Repo recorded by the active Intent", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-utility-codekb-"));
  initializeWorkspace(projectDir);
  birthIntent(projectDir, "Payment API", "default", "mvp", ["payment-api"]);

  assert.deepEqual(resolveCodekbPath(projectDir), {
    space: "default",
    repo: "payment-api",
    dir: "aidlc/spaces/default/codekb/payment-api",
  });
});

test("codekb-path is read-only and honours explicit Repo and JSON output", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-utility-codekb-"));
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(
    projectDir,
    "Payment API",
    "default",
    "mvp",
    ["payment-api"],
  );
  const before = readdirSync(projectDir).sort();
  const beforePlan = readFileSync(born.state.planPath, "utf8");
  const beforeState = readFileSync(born.state.statePath, "utf8");
  const beforeAudit = readFileSync(born.auditPath, "utf8");
  const plain = spawnSync(
    process.execPath,
    [
      "core/tools/aidlc-utility.ts",
      "codekb-path",
      "--project-dir",
      projectDir,
      "--repo",
      "payment-api",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, "aidlc/spaces/default/codekb/payment-api/\n");

  const json = spawnSync(
    process.execPath,
    [
      "core/tools/aidlc-utility.ts",
      "codekb-path",
      "--project-dir",
      projectDir,
      "--repo",
      "payment-api",
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    space: "default",
    repo: "payment-api",
    dir: "aidlc/spaces/default/codekb/payment-api",
  });
  assert.deepEqual(readdirSync(projectDir).sort(), before);
  assert.equal(readFileSync(born.state.planPath, "utf8"), beforePlan);
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);
  assert.equal(readFileSync(born.auditPath, "utf8"), beforeAudit);
});

test("codekb-path defaults to the project basename and rejects path traversal", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-utility-codekb-"));
  assert.equal(
    resolveCodekbPath(projectDir).repo,
    projectDir.split("/").at(-1),
  );
  assert.throws(
    () => resolveCodekbPath(projectDir, "../outside"),
    /Repository name must be one non-empty path segment/,
  );
});
