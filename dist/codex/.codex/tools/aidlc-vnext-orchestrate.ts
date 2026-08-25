#!/usr/bin/env bun

import { loadVNextDefinitions } from "./aidlc-core-route.ts";
import { executeBootstrap } from "./aidlc-vnext-bootstrap.ts";
import { prepareOrient } from "./aidlc-vnext-orient.ts";
import { prepareDefineIntent } from "./aidlc-vnext-define-intent.ts";
import { prepareRequirements } from "./aidlc-vnext-requirements.ts";
import { prepareArchitecture } from "./aidlc-vnext-architecture.ts";
import {
  pendingBuildContractReview,
  prepareBuildContract,
} from "./aidlc-vnext-build-contract.ts";
import { prepareBuildConverge } from "./aidlc-vnext-build-converge.ts";
import {
  pendingCandidateReview,
  prepareCandidateReview,
} from "./aidlc-vnext-review.ts";
import {
  pendingAuthorizedRelease,
  pendingReleaseReview,
  prepareRelease,
} from "./aidlc-vnext-release.ts";
import {
  pendingOutcomeDecision,
  prepareOutcomeEvaluation,
} from "./aidlc-vnext-outcome.ts";
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
  if (state.current_stage === "ST-03") {
    const prepared = prepareRequirements(projectDir);
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "work",
      workflow: "vnext",
      stage: "ST-03",
      reason: "Core prepared the fixed ST-03 Requirements inputs; AI may propose traceable requirements and constraints only.",
      request: prepared.reference,
      graph_version: state.graph_version,
      plan_revision: state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-04") {
    const prepared = prepareArchitecture(projectDir);
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "work",
      workflow: "vnext",
      stage: "ST-04",
      reason: "Core prepared the fixed ST-04 Architecture inputs; AI may propose execute, reuse, or a verifiable not_applicable assessment only.",
      request: prepared.reference,
      graph_version: state.graph_version,
      plan_revision: state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-05") {
    const pending = pendingBuildContractReview(projectDir);
    if (pending !== null) {
      return parseVNextCoreDirective({
        schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
        kind: "approval",
        workflow: "vnext",
        stage: "ST-05",
        reason: "Core validated the Build Contract candidate. A human must approve this exact SHA-256 or request revision.",
        candidate: pending.candidate,
        review: pending.review,
        decisions: ["approve", "revise"],
        graph_version: state.graph_version,
        plan_revision: state.plan_revision,
        decision_authority: "core",
      });
    }
    const prepared = prepareBuildContract(projectDir);
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "work",
      workflow: "vnext",
      stage: "ST-05",
      reason: "Core prepared the fixed ST-05 inputs; AI may propose the Build Contract and Bolt DAG but cannot approve or choose a route.",
      request: prepared.reference,
      graph_version: state.graph_version,
      plan_revision: state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-06") {
    const prepared = prepareBuildConverge(projectDir);
    if (prepared.execution === "advanced") {
      if (prepared.currentReference === null) {
        throw new Error("ST-06 Build & Converge advanced without Build Current Evidence");
      }
      return parseVNextCoreDirective({
        schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
        kind: "advanced",
        workflow: "vnext",
        completed_stage: "ST-06",
        stage: prepared.state.current_stage,
        reason: "ST-06 had no executable Bolt; Core recorded the deterministic not_applicable result and advanced to ST-07.",
        evidence: [prepared.currentReference],
        graph_version: prepared.state.graph_version,
        plan_revision: prepared.state.plan_revision,
        decision_authority: "core",
      });
    }
    if (prepared.request === null || prepared.reference === null) {
      throw new Error("ST-06 Build & Converge did not produce a Bolt Work Request");
    }
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "work",
      workflow: "vnext",
      stage: "ST-06",
      reason: `Core selected ${prepared.request.bolt.bolt_id}; AI may implement only this Bolt in the supplied isolated Git worktrees.`,
      request: prepared.reference,
      graph_version: prepared.state.graph_version,
      plan_revision: prepared.state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-07") {
    let pending = pendingCandidateReview(projectDir);
    if (pending === null) {
      const prepared = prepareCandidateReview(projectDir);
      if (prepared.execution === "advanced") {
        if (prepared.currentReference === null) {
          throw new Error("ST-07 Human Feedback & Approval advanced without Review Current Evidence");
        }
        return parseVNextCoreDirective({
          schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
          kind: "advanced",
          workflow: "vnext",
          completed_stage: "ST-07",
          stage: prepared.state.current_stage,
          reason: "ST-07 had no Runnable Candidate; Core reused the exact ST-05 no-build approval and advanced to ST-08.",
          evidence: [prepared.currentReference],
          graph_version: prepared.state.graph_version,
          plan_revision: prepared.state.plan_revision,
          decision_authority: "core",
        });
      }
      pending = prepared.pending;
    }
    if (pending === null) throw new Error("ST-07 Human Feedback & Approval did not produce a pending Review");
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "approval",
      workflow: "vnext",
      stage: "ST-07",
      reason: "A human must approve this exact Runnable Candidate and Review Manifest, or classify feedback for one of the four fixed Graph edges.",
      candidate: pending.manifest.runnable_candidate_ref,
      review: pending.reviewReference,
      decisions: ["approve", "revise"],
      feedback_reasons: ["requirements_changed", "architecture_impact", "build_contract_impact", "candidate_defect"],
      graph_version: state.graph_version,
      plan_revision: state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-08") {
    const authorized = pendingAuthorizedRelease(projectDir);
    if (authorized !== null) {
      return parseVNextCoreDirective({
        schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
        kind: "parked",
        workflow: "vnext",
        stage: "ST-08",
        reason: "The exact Release Plan has human authority. Run the explicit Release execute action; Core will revalidate every Target before external operations.",
        graph_version: state.graph_version,
        plan_revision: state.plan_revision,
        decision_authority: "core",
      });
    }
    const pending = pendingReleaseReview(projectDir);
    if (pending !== null) {
      return parseVNextCoreDirective({
        schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
        kind: "approval",
        workflow: "vnext",
        stage: "ST-08",
        reason: "Core validated the Release Plan and observed every external Target. A human must authorize this exact Plan SHA-256 or request revision.",
        candidate: pending.planReference,
        review: pending.reviewReference,
        decisions: ["approve", "revise"],
        graph_version: state.graph_version,
        plan_revision: state.plan_revision,
        decision_authority: "core",
      });
    }
    const prepared = prepareRelease(projectDir);
    if (prepared.execution === "advanced") {
      if (prepared.currentReference === null) throw new Error("ST-08 Release advanced without Release Current Evidence");
      return parseVNextCoreDirective({
        schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
        kind: "advanced",
        workflow: "vnext",
        completed_stage: "ST-08",
        stage: prepared.state.current_stage,
        reason: "ST-08 had no Accepted Candidate; Core recorded deterministic not_applicable and advanced to ST-09.",
        evidence: [prepared.currentReference],
        graph_version: prepared.state.graph_version,
        plan_revision: prepared.state.plan_revision,
        decision_authority: "core",
      });
    }
    if (prepared.reference === null) throw new Error("ST-08 Release did not produce a Work Request");
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "work",
      workflow: "vnext",
      stage: "ST-08",
      reason: "Core prepared the fixed ST-08 inputs; AI may propose Targets and Steps only from the pinned Capability Snapshot.",
      request: prepared.reference,
      graph_version: prepared.state.graph_version,
      plan_revision: prepared.state.plan_revision,
      decision_authority: "core",
    });
  }
  if (state.current_stage === "ST-09") {
    const pending = pendingOutcomeDecision(projectDir);
    if (pending !== null) {
      return parseVNextCoreDirective({
        schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
        kind: "decision",
        workflow: "vnext",
        stage: "ST-09",
        reason: `Outcome is ${pending.evaluation.overall_result}; a human must continue observation or accept an honest terminal result.`,
        candidate: pending.evaluationReference,
        review: pending.htmlReference,
        decisions: [
          "continue-observation",
          "complete-with-outcome",
          "complete-and-draft-follow-up",
        ],
        graph_version: state.graph_version,
        plan_revision: state.plan_revision,
        decision_authority: "core",
      });
    }
    const prepared = prepareOutcomeEvaluation(projectDir);
    if (prepared.execution === "waiting") {
      return parseVNextCoreDirective({
        schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
        kind: "parked",
        workflow: "vnext",
        stage: "ST-09",
        reason: prepared.state.parked_reason ?? "ST-09 is waiting for its approved observation window.",
        graph_version: prepared.state.graph_version,
        plan_revision: prepared.state.plan_revision,
        decision_authority: "core",
      });
    }
    if (prepared.reference === null) throw new Error("ST-09 Outcome Evaluation did not produce a Work Request");
    return parseVNextCoreDirective({
      schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
      kind: "work",
      workflow: "vnext",
      stage: "ST-09",
      reason: "Core fixed every promised Outcome signal; AI may compare those signals with Project-bound Evidence only.",
      request: prepared.reference,
      graph_version: prepared.state.graph_version,
      plan_revision: prepared.state.plan_revision,
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
