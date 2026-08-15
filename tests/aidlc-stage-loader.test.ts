import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import {
  loadStageCatalog,
  loadStages,
} from "../core/tools/aidlc-stage-loader.ts";

const MINIMAL_STAGE = `---
slug: sample-stage
phase: initialization
execution: ALWAYS
condition: Always runs
lead_agent: orchestrator
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
sensors: []
scopes:
  - feature
inputs: none
outputs: none
---

# Sample Stage
`;

function fixture(): { root: string; catalogPath: string; stagesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "aidlc-stage-loader-"));
  const stagesDir = join(root, "stages");
  const phaseDir = join(stagesDir, "initialization");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "sample-stage.md"), MINIMAL_STAGE);
  const catalogPath = join(root, "stage-catalog.json");
  writeFileSync(
    catalogPath,
    JSON.stringify([
      { slug: "sample-stage", number: "0.1", name: "Sample Stage" },
    ]),
  );
  return { root, catalogPath, stagesDir };
}

test("loads the real catalog and all stage definitions", () => {
  const stages = loadStages();
  assert.equal(stages.length, 32);
  assert.deepEqual(
    [stages[0]?.slug, stages[0]?.number, stages[0]?.name],
    ["workspace-scaffold", "0.1", "Workspace Scaffold"],
  );
  assert.equal(stages.at(-1)?.slug, "feedback-optimization");
  assert.ok(stages.every((stage) => stage.sourcePath.endsWith(`${stage.slug}.md`)));
});

test("loads nested stage frontmatter values", () => {
  const stage = loadStages().find((entry) => entry.slug === "nfr-requirements");
  assert.ok(stage);
  assert.deepEqual(stage.produces_kinds?.["performance-requirements"], [
    "service",
    "ui",
  ]);
  assert.equal(stage.consumes.at(-1)?.conditional_on, "brownfield");
});

test("matches the structural fields in the compiled stage graph", () => {
  const stages = loadStages();
  const graph = JSON.parse(
    readFileSync("core/aidlc-common/data/stage-graph.json", "utf8"),
  ) as Array<Record<string, unknown>>;
  const graphBySlug = new Map(graph.map((entry) => [entry.slug, entry]));
  const structuralKeys = [
    "slug",
    "number",
    "name",
    "phase",
    "execution",
    "condition",
    "lead_agent",
    "support_agents",
    "mode",
    "reviewer",
    "reviewer_max_iterations",
    "for_each",
    "workspace_requires",
    "produces",
    "optional_produces",
    "produces_kinds",
    "consumes",
    "requires_stage",
    "sensors",
    "scopes",
    "inputs",
    "outputs",
  ] as const;

  assert.equal(graph.length, stages.length);
  for (const stage of stages) {
    const graphStage = graphBySlug.get(stage.slug);
    assert.ok(graphStage, `missing graph stage: ${stage.slug}`);
    for (const key of structuralKeys) {
      assert.deepEqual(
        stage[key],
        graphStage[key],
        `${stage.slug}.${key} differs from stage-graph.json`,
      );
    }
  }
});

test("rejects duplicate catalog numbers", () => {
  const { catalogPath } = fixture();
  writeFileSync(
    catalogPath,
    JSON.stringify([
      { slug: "first", number: "0.1", name: "First" },
      { slug: "second", number: "0.1", name: "Second" },
    ]),
  );
  assert.throws(() => loadStageCatalog(catalogPath), /duplicate number "0\.1"/);
});

test("rejects a stage that is missing from the catalog", () => {
  const { catalogPath, stagesDir } = fixture();
  writeFileSync(catalogPath, "[]");
  assert.throws(
    () => loadStages({ catalogPath, stagesDir }),
    /missing from catalog: sample-stage/,
  );
});

test("combines catalog identity with stage frontmatter", () => {
  const { catalogPath, stagesDir } = fixture();
  const stages = loadStages({ catalogPath, stagesDir });
  assert.equal(stages[0]?.number, "0.1");
  assert.equal(stages[0]?.name, "Sample Stage");
  assert.deepEqual(stages[0]?.scopes, ["feature"]);
});
