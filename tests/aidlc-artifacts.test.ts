import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "bun:test";
import {
  artifactOutputPaths,
  buildArtifactProducerIndex,
  resolveStageArtifacts,
  verifyStageArtifactEvidence,
} from "../core/tools/aidlc-artifacts.ts";
import {
  type CompiledStage,
  loadCompiledStageGraph,
  type ResolvedPlanStage,
  validateArtifactContracts,
} from "../core/tools/aidlc-graph.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { planFilePath, stateFilePath } from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function freshProject(
  options: { brownfield?: boolean; repos?: string[] } = {},
): { projectDir: string; graph: CompiledStage[] } {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-artifacts-"));
  if (options.brownfield) {
    writeFileSync(join(projectDir, "package.json"), '{"name":"fixture"}\n');
  }
  initializeWorkspace(projectDir);
  birthIntentWithState(
    projectDir,
    "Payment API",
    "default",
    "mvp",
    options.repos,
  );
  return { projectDir, graph: loadCompiledStageGraph() };
}

function stage(graph: readonly CompiledStage[], slug: string): CompiledStage {
  const result = graph.find((candidate) => candidate.slug === slug);
  assert.ok(result, `missing test stage ${slug}`);
  return result;
}

function materialize(projectDir: string, paths: readonly string[]): void {
  for (const path of paths) {
    const absolute = resolve(projectDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "# Test artifact\n", "utf8");
  }
}

function runtimeContext(projectDir: string): {
  plan: ResolvedPlanStage[];
  state: string;
  projectType: string;
} {
  const state = readFileSync(stateFilePath(projectDir), "utf8");
  return {
    plan: JSON.parse(readFileSync(planFilePath(projectDir), "utf8")) as
      ResolvedPlanStage[],
    state,
    projectType: /^- \*\*Project Type\*\*:\s*(.*)$/m
      .exec(state)?.[1]?.trim() ?? "Unknown",
  };
}

test("compiled artifact contracts have one earlier producer per consume", () => {
  const graph = loadCompiledStageGraph();
  assert.doesNotThrow(() => validateArtifactContracts(graph));
  const index = buildArtifactProducerIndex(graph);
  assert.equal(index.get("intent-statement")?.stage.slug, "intent-capture");
  assert.equal(index.get("frontend-components")?.optional, true);

  const duplicate = graph.map((candidate) => ({ ...candidate }));
  duplicate[1] = {
    ...duplicate[1]!,
    produces: [...duplicate[1]!.produces, "intent-statement"],
  };
  assert.throws(
    () => validateArtifactContracts(duplicate),
    /multiple producers/,
  );

  const unowned = graph.map((candidate) => ({ ...candidate }));
  unowned[1] = {
    ...unowned[1]!,
    consumes: [
      ...unowned[1]!.consumes,
      { artifact: "missing-contract", required: true },
    ],
  };
  assert.throws(
    () => validateArtifactContracts(unowned),
    /has no producer/,
  );
});

test("standard and per-unit outputs resolve inside the active Intent", () => {
  const { projectDir, graph } = freshProject();
  const intentCapture = stage(graph, "intent-capture");
  const functionalDesign = stage(graph, "functional-design");

  const standard = artifactOutputPaths(
    projectDir,
    intentCapture,
    "intent-statement",
  );
  assert.equal(standard.length, 1);
  assert.match(
    standard[0]!,
    /aidlc\/spaces\/default\/intents\/[^/]+\/ideation\/intent-capture\/intent-statement\.md$/,
  );

  const perUnit = artifactOutputPaths(
    projectDir,
    functionalDesign,
    "business-rules",
    { unit: "payments" },
  );
  assert.match(
    perUnit[0]!,
    /\/construction\/payments\/functional-design\/business-rules\.md$/,
  );
  assert.match(
    artifactOutputPaths(
      projectDir,
      functionalDesign,
      "business-rules",
    )[0]!,
    /\/construction\/\{unit-name\}\/functional-design\/business-rules\.md$/,
  );
});

test("reverse-engineering artifacts resolve to each Space codekb repo", () => {
  const { projectDir, graph } = freshProject({
    brownfield: true,
    repos: ["api", "worker"],
  });
  const reverseEngineering = stage(graph, "reverse-engineering");
  const paths = artifactOutputPaths(
    projectDir,
    reverseEngineering,
    "architecture",
  );

  assert.deepEqual(paths.map((path) => basename(dirname(path))), ["api", "worker"]);
  assert.ok(paths.every((path) =>
    path.includes("aidlc/spaces/default/codekb/") &&
    path.endsWith("/architecture.md")
  ));
  materialize(projectDir, [paths[0]!]);
  const evidence = verifyStageArtifactEvidence(projectDir, reverseEngineering);
  assert.equal(evidence.valid, false);
  assert.ok(evidence.missing.some((path) =>
    path.endsWith("/worker/architecture.md")
  ));
});

test("resolver filters conditional inputs and reports required missing inputs", () => {
  const { projectDir, graph } = freshProject();
  const context = runtimeContext(projectDir);
  const practices = resolveStageArtifacts(
    projectDir,
    stage(graph, "practices-discovery"),
    graph,
    context.plan,
    context.state,
    context.projectType,
  );
  assert.deepEqual(practices.consumes, []);
  assert.deepEqual(practices.consumesAbsent, []);

  const functional = resolveStageArtifacts(
    projectDir,
    stage(graph, "functional-design"),
    graph,
    context.plan,
    context.state,
    context.projectType,
    { unit: "payments" },
  );
  assert.ok(functional.consumesAbsent.length > 0);
  assert.ok(functional.consumesAbsent.every((entry) => entry.expected === false));
  assert.ok(functional.produces.every((path) =>
    path.includes("/construction/payments/functional-design/")
  ));
  assert.ok(functional.optionalProduces[0]?.endsWith("frontend-components.md"));

  const nfrForUi = resolveStageArtifacts(
    projectDir,
    stage(graph, "nfr-requirements"),
    graph,
    context.plan,
    context.state,
    context.projectType,
    { unit: "payments", unitKind: "ui" },
  );
  assert.equal(
    nfrForUi.consumesAbsent.some((entry) =>
      entry.path.endsWith("/functional-design/business-rules.md")
    ),
    false,
  );
});

test("required outputs block completion while optional outputs do not", () => {
  const { projectDir, graph } = freshProject();
  const functionalDesign = stage(graph, "functional-design");
  const withoutUnit = verifyStageArtifactEvidence(projectDir, functionalDesign);
  assert.equal(withoutUnit.valid, false);
  assert.match(withoutUnit.missing[0]!, /requires --unit/);

  const required = functionalDesign.produces.flatMap((artifact) =>
    artifactOutputPaths(projectDir, functionalDesign, artifact, {
      unit: "payments",
    })
  );
  materialize(projectDir, required);
  const withRequired = verifyStageArtifactEvidence(projectDir, functionalDesign, {
    unit: "payments",
  });
  assert.deepEqual(withRequired, { valid: true, missing: [] });
  assert.equal(
    artifactOutputPaths(
      projectDir,
      functionalDesign,
      "frontend-components",
      { unit: "payments" },
    ).some((path) => existsSync(resolve(projectDir, path))),
    false,
  );
});
