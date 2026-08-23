import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  allowedFeedbackTargets,
  loadVNextDefinitions,
  nextForwardStage,
  parseVNextStageCatalog,
  parseVNextStageGraph,
  validateCoreRoute,
} from "../core/tools/aidlc-core-route.ts";

function definitions() {
  return loadVNextDefinitions();
}

test("loads exactly the fixed ten Stage Catalog entries", () => {
  const { catalog } = definitions();
  assert.equal(catalog.stages.length, 10);
  assert.deepEqual(
    catalog.stages.map((stage) => stage.stage_id),
    ["ST-00", "ST-01", "ST-02", "ST-03", "ST-04", "ST-05", "ST-06", "ST-07", "ST-08", "ST-09"],
  );
});

test("loads the fixed forward Route and four ST-07 feedback routes", () => {
  const { graph } = definitions();
  assert.equal(graph.forward_edges.length, 9);
  assert.equal(nextForwardStage(graph, "ST-00"), "ST-01");
  assert.equal(nextForwardStage(graph, "ST-09"), null);
  assert.deepEqual(allowedFeedbackTargets(graph), [
    { stage_id: "ST-03", reason: "requirements_changed" },
    { stage_id: "ST-04", reason: "architecture_impact" },
    { stage_id: "ST-05", reason: "build_contract_impact" },
    { stage_id: "ST-06", reason: "candidate_defect" },
  ]);
});

test("accepts only fixed forward transitions", () => {
  const { graph } = definitions();
  validateCoreRoute(graph, { from: "ST-03", to: "ST-04" });
  assert.throws(
    () => validateCoreRoute(graph, { from: "ST-03", to: "ST-05" }),
    /transition ST-03->ST-05 is not allowed/,
  );
});

test("accepts an ST-07 return only with the matching reason", () => {
  const { graph } = definitions();
  validateCoreRoute(graph, {
    from: "ST-07",
    to: "ST-03",
    feedback_reason: "requirements_changed",
  });
  assert.throws(
    () => validateCoreRoute(graph, {
      from: "ST-07",
      to: "ST-03",
      feedback_reason: "candidate_defect",
    }),
    /transition ST-07->ST-03 is not allowed/,
  );
});

test("rejects feedback metadata on a forward transition", () => {
  const { graph } = definitions();
  assert.throws(
    () => validateCoreRoute(graph, {
      from: "ST-07",
      to: "ST-08",
      feedback_reason: "candidate_defect",
    }),
    /forward transition must not include feedback_reason/,
  );
});

test("rejects a Catalog with a missing or reordered Stage", () => {
  const { catalog } = definitions();
  assert.throws(
    () => parseVNextStageCatalog({
      ...catalog,
      stages: catalog.stages.slice(0, -1),
    }),
    /must contain exactly 10 stages/,
  );
  const reordered = [...catalog.stages];
  [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
  assert.throws(
    () => parseVNextStageCatalog({ ...catalog, stages: reordered }),
    /fixed Stage order cannot be changed/,
  );
});

test("rejects an unknown Catalog field", () => {
  const { catalog } = definitions();
  assert.throws(
    () => parseVNextStageCatalog({ ...catalog, selected_by_ai: true }),
    /unknown field\(s\): selected_by_ai/,
  );
});

test("rejects any extra, missing, or reordered Graph edge", () => {
  const { graph } = definitions();
  assert.throws(
    () => parseVNextStageGraph({
      ...graph,
      forward_edges: graph.forward_edges.slice(0, -1),
    }),
    /must contain exactly 9 edge/,
  );
  const changed = graph.forward_edges.map((edge, index) =>
    index === 0 ? { from: "ST-00", to: "ST-02" } : edge
  );
  assert.throws(
    () => parseVNextStageGraph({ ...graph, forward_edges: changed }),
    /fixed Route cannot be changed/,
  );
});
