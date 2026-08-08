import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalScopeTable,
  canonicalStageTable,
  detectProject,
  renderScopeTable,
  renderStageTable,
} from "../core/tools/aidlc-utility.ts";
import { loadCompiledStageGraph } from "../core/tools/aidlc-graph.ts";

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
    "pnpm",
    [
      "exec",
      "tsx",
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
  assert.match(canonicalScopeTable(), /^<!-- BEGIN: compiled scope grid/);
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
  assert.match(canonicalStageTable(), /^<!-- BEGIN: compiled stage graph/);
  assert.match(canonicalStageTable(), /<!-- END: compiled stage graph -->$/);
});

test("scope-table and stage-table CLI commands emit their canonical regions", () => {
  for (const [command, expected] of [
    ["scope-table", canonicalScopeTable()],
    ["stage-table", canonicalStageTable()],
  ] as const) {
    const result = spawnSync(
      "pnpm",
      ["exec", "tsx", "core/tools/aidlc-utility.ts", command],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${expected}\n`);
  }
});
