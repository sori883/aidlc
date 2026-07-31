import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkCompiledStageGraph,
  compileStageGraph,
  loadCompiledScopeGrid,
  loadCompiledStageGraph,
  resolvePlanForScope,
  subgraphForScope,
  validateStageDependencies,
  writeCompiledStageGraph,
} from "../core/tools/aidlc-graph.ts";
import type { LoadedStage } from "../core/tools/aidlc-stage-loader.ts";

test("compiles all stages with resolved rules and sensors", () => {
  const result = compileStageGraph();
  assert.equal(result.stages.length, 32);
  assert.equal(result.stages[0]?.slug, "workspace-scaffold");
  assert.ok(result.stages.every((stage) => !Object.hasOwn(stage, "sourcePath")));
  assert.ok(result.stages.every((stage) => stage.rules_in_context.length >= 3));
  assert.deepEqual(
    result.stages.find((stage) => stage.slug === "code-generation")
      ?.rules_in_context,
    [
      { path: "aidlc/spaces/default/memory/org.md", scope: "org" },
      { path: "aidlc/spaces/default/memory/team.md", scope: "team" },
      { path: "aidlc/spaces/default/memory/project.md", scope: "project" },
      {
        path: "aidlc/spaces/default/memory/phases/construction.md",
        scope: "phase",
      },
    ],
  );
  assert.ok(result.stages.some((stage) => stage.sensors_applicable.length > 0));
  assert.deepEqual(
    result.stages.find((stage) => stage.slug === "code-generation")
      ?.sensors_applicable,
    [
      {
        id: "linter",
        path: ".codex/sensors/aidlc-linter.md",
        matches: "**/*.{ts,js}",
      },
      {
        id: "type-check",
        path: ".codex/sensors/aidlc-type-check.md",
        matches: "**/*.{ts,tsx}",
      },
    ],
  );
});

test("transposes stage scopes to the existing scope grid", () => {
  const result = compileStageGraph();
  const expected = readFileSync(
    "core/aidlc-common/data/scope-grid.json",
    "utf8",
  );
  assert.equal(result.scopeGridJson, expected);
  assert.equal(result.scopeGrid.bugfix?.stages["workspace-scaffold"], "EXECUTE");
  assert.equal(result.scopeGrid.bugfix?.stages["intent-capture"], "SKIP");
});

test("rejects an unknown stage dependency", () => {
  const stage = {
    ...compileStageGraph().stages[0],
    sourcePath: "/fixture/sample.md",
    requires_stage: ["missing-stage"],
  } as LoadedStage;
  assert.throws(
    () => validateStageDependencies([stage]),
    /unknown requires_stage "missing-stage"/,
  );
});

test("graph compilation rejects missing agent definitions", () => {
  const agentsDir = mkdtempSync(join(tmpdir(), "aidlc-empty-agents-"));
  assert.throws(
    () => compileStageGraph({ agentsDir }),
    /unknown lead_agent "aidlc-product-agent"/,
  );
});

test("graph compilation rejects missing scope definitions", () => {
  const scopesDir = mkdtempSync(join(tmpdir(), "aidlc-empty-scopes-"));
  assert.throws(
    () => compileStageGraph({ scopesDir }),
    /unknown scopes\[0\] "enterprise"/,
  );
});

test("writes both files and detects drift", () => {
  const directory = mkdtempSync(join(tmpdir(), "aidlc-graph-"));
  const graphPath = join(directory, "stage-graph.json");
  const scopeGridPath = join(directory, "scope-grid.json");
  const result = writeCompiledStageGraph({ graphPath, scopeGridPath });

  assert.equal(readFileSync(graphPath, "utf8"), result.graphJson);
  assert.equal(readFileSync(scopeGridPath, "utf8"), result.scopeGridJson);
  assert.deepEqual(
    checkCompiledStageGraph({ graphPath, scopeGridPath }).staleFiles,
    [],
  );

  writeFileSync(graphPath, "[]\n");
  assert.deepEqual(
    checkCompiledStageGraph({ graphPath, scopeGridPath }).staleFiles,
    [graphPath],
  );
});

test("resolves every scope to an ordered EXECUTE/SKIP plan", () => {
  const graph = loadCompiledStageGraph();
  const grid = loadCompiledScopeGrid();

  for (const [scope, entry] of Object.entries(grid)) {
    const plan = resolvePlanForScope(scope);
    assert.equal(plan.length, graph.length);
    assert.deepEqual(
      plan.map(({ slug, action }) => ({ slug, action })),
      graph.map((stage) => ({
        slug: stage.slug,
        action: entry.stages[stage.slug],
      })),
    );
  }
});

test("returns only the executable subgraph for a scope", () => {
  const plan = resolvePlanForScope("bugfix");
  const subgraph = subgraphForScope("bugfix");

  assert.equal(plan.length, 32);
  assert.equal(plan.filter(({ action }) => action === "EXECUTE").length, 7);
  assert.deepEqual(
    subgraph.map(({ slug }) => slug),
    plan
      .filter(({ action }) => action === "EXECUTE")
      .map(({ slug }) => slug),
  );
  assert.equal(plan[0]?.slug, "workspace-scaffold");
  assert.equal(plan[0]?.action, "EXECUTE");
  assert.equal(
    plan.find(({ slug }) => slug === "intent-capture")?.action,
    "SKIP",
  );
});

test("resolver rejects an unknown scope", () => {
  assert.throws(
    () => resolvePlanForScope("missing-scope"),
    /Unknown scope: "missing-scope"\. Valid scopes:/,
  );
});

test("runtime loaders reject malformed compiled data", () => {
  const directory = mkdtempSync(join(tmpdir(), "aidlc-resolver-"));
  const graphPath = join(directory, "stage-graph.json");
  const scopeGridPath = join(directory, "scope-grid.json");

  writeFileSync(graphPath, "{}\n");
  assert.throws(
    () => loadCompiledStageGraph({ graphPath }),
    /expected an array/,
  );

  writeFileSync(scopeGridPath, '{"poc":{"stages":{"sample":"RUN"}}}\n');
  assert.throws(
    () => loadCompiledScopeGrid({ scopeGridPath }),
    /must be EXECUTE or SKIP/,
  );
});
