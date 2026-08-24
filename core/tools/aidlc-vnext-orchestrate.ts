#!/usr/bin/env bun

import { loadVNextDefinitions } from "./aidlc-core-route.ts";
import { executeBootstrap } from "./aidlc-vnext-bootstrap.ts";
import { prepareOrient } from "./aidlc-vnext-orient.ts";
import { prepareDefineIntent } from "./aidlc-vnext-define-intent.ts";
import {
  parseVNextCoreDirective,
  VNEXT_DIRECTIVE_SCHEMA_VERSION,
  type VNextCoreDirective,
} from "./aidlc-vnext-directive.ts";
import { resumeVNextIntent } from "./aidlc-vnext-state.ts";

export function resolveVNextDirective(projectDir: string): VNextCoreDirective {
  const definitions = loadVNextDefinitions();
  const { state, plan } = resumeVNextIntent(projectDir);
  if (state.catalog_version !== definitions.catalog.catalog_version) {
    throw new Error(
      `Core Route: State Catalog ${state.catalog_version} does not match ` +
        `${definitions.catalog.catalog_version}`,
    );
  }
  if (
    state.graph_version !== definitions.graph.graph_version ||
    plan.graph_version !== definitions.graph.graph_version
  ) {
    throw new Error(
      `Core Route: persisted Graph does not match ${definitions.graph.graph_version}`,
    );
  }
  if (state.status === "completed") {
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "done",
      workflow: "vnext",
      reason: "All fixed vNext Stages are complete.",
      graph_version: state.graph_version,
      plan_revision: state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-00") {
    const completed = executeBootstrap(projectDir);
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "advanced",
      workflow: "vnext",
      completed_stage: "ST-00",
      stage: completed.state.current_stage,
      reason: "ST-00 Bootstrap completed; Core advanced to ST-01.",
      evidence: [completed.reference],
      graph_version: completed.state.graph_version,
      plan_revision: completed.state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-01") {
    const prepared = prepareOrient(projectDir);
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "work",
      workflow: "vnext",
      stage: "ST-01",
      reason: "Core prepared the fixed ST-01 Orient inputs; AI may propose Map observations and Intent context only.",
      request: prepared.reference,
      graph_version: state.graph_version,
      plan_revision: state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-02") {
    const prepared = prepareDefineIntent(projectDir);
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "work",
      workflow: "vnext",
      stage: "ST-02",
      reason: "Core prepared the fixed ST-02 Define Intent inputs; AI may propose the bounded Intent Definition only.",
      request: prepared.reference,
      graph_version: state.graph_version,
      plan_revision: state.plan_revision,
      decision_authority: "core",
    });
  }
  const decision = plan.stage_decisions.find(
    (candidate) => candidate.stage_id === state.current_stage,
  );
  if (decision === undefined) {
    throw new Error(`Core Route: Plan has no decision for ${state.current_stage}`);
  }
  return parseVNextCoreDirective({
    schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
    kind: "parked",
    workflow: "vnext",
    stage: state.current_stage,
    reason: state.parked_reason ??
      `${state.current_stage} is ${decision.disposition}, but its Stage runtime is unavailable.`,
    graph_version: state.graph_version,
    plan_revision: state.plan_revision,
    decision_authority: "core",
  });
}

export function main(argv: string[]): void {
  const [command, projectDir, ...rest] = argv;
  if (command !== "next" || projectDir === undefined || rest.length !== 0) {
    console.error("Usage: aidlc next <project-dir>");
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(resolveVNextDirective(projectDir))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
