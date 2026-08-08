// Harness-neutral M7 Agent execution control. This module turns one M6
// run-stage Directive into deterministic Agent invocations. The adapter owns
// the actual inference transport (Codex spawn_agent in the primary harness);
// the executor owns ordering, result validation, Reviewer retries, and the
// success-only handoff to orchestrate:report.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type DoneDirective,
  type ErrorDirective,
  type RunStageDirective,
  validateDirective,
} from "./aidlc-directive.ts";
import {
  reportStageResult,
  resolveNextDirective,
} from "./aidlc-orchestrate.ts";
import {
  assertSteeringContext,
  type SteeringContext,
  type SteeringRuleContent,
} from "./aidlc-steering.ts";
import { ensureStageMemory } from "./aidlc-memory.ts";

export type AgentPurpose =
  | "build"
  | "support"
  | "advance"
  | "integrate"
  | "review"
  | "revise";

export type AgentResultStatus = "completed" | "failed" | "needs-human";
export type StageExecutionStatus = AgentResultStatus | "awaiting-approval";
export type ReviewerVerdict = "READY" | "NOT-READY";
export type ContextVisibility =
  | "inline"
  | "isolated"
  | "draft-only"
  | "upstream"
  | "all-artifacts"
  | "review-scope";
export type ExecutionTarget = "conductor" | "subagent";

export interface AgentStep {
  id: string;
  sequence: number;
  stage: string;
  phase: string;
  mode: RunStageDirective["mode"];
  role: string;
  purpose: AgentPurpose;
  execution_target: ExecutionTarget;
  depends_on: string[];
  context_visibility: ContextVisibility;
  persona_paths: string[];
  collaborators: string[];
  stage_file: string;
  memory_path: string;
  consumes: string[];
  produces: string[];
  rules_in_context: string[];
  sensors_applicable: string[];
  contribution_path?: string;
  reviewer_iteration?: number;
}

export interface AgentInvocation extends AgentStep {
  prior_results: AgentResult[];
  steering_bundle: string;
  rules_content: SteeringRuleContent[];
}

export interface AgentResult {
  invocation_id: string;
  role: string;
  purpose: AgentPurpose;
  status: AgentResultStatus;
  summary: string;
  output: string;
  reviewer_verdict?: ReviewerVerdict;
}

export interface ReviewerPolicy {
  role: string;
  max_iterations: number;
}

export interface StageExecutionPlan {
  stage: string;
  phase: string;
  mode: RunStageDirective["mode"];
  steps: AgentStep[];
  reviewer?: ReviewerPolicy;
}

export interface StageExecutionResult {
  stage: string;
  mode: RunStageDirective["mode"];
  status: StageExecutionStatus;
  results: AgentResult[];
  message: string;
  reviewer_iterations: number;
  report?: DoneDirective | ErrorDirective;
}

/** M11/M12 implement this with the Codex conductor's spawn_agent tool. */
export interface AgentAdapter {
  invoke(request: AgentInvocation): Promise<AgentResult>;
}

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(TOOL_DIR, "..");

function personaPath(role: string): string {
  return join(CORE_DIR, "agents", `${role}.md`);
}

function contributionPath(
  directive: RunStageDirective,
  role: string,
): string {
  return join(dirname(directive.memory_path), "contributions", `${role}.md`);
}

function assertRunStageDirective(
  directive: RunStageDirective,
): RunStageDirective {
  const validation = validateDirective(directive);
  if (!validation.valid) {
    throw new Error(`Invalid run-stage Directive: ${validation.errors.join("; ")}`);
  }
  if (validation.data.kind !== "run-stage") {
    throw new Error(`Expected run-stage Directive, got ${validation.data.kind}`);
  }
  if (!existsSync(directive.stage_file)) {
    throw new Error(`Stage file does not exist: ${directive.stage_file}`);
  }
  for (const role of [directive.lead_agent, ...directive.support_agents]) {
    const path = personaPath(role);
    if (!existsSync(path)) throw new Error(`Agent persona does not exist: ${path}`);
  }
  if (directive.reviewer !== undefined) {
    const path = personaPath(directive.reviewer);
    if (!existsSync(path)) throw new Error(`Reviewer persona does not exist: ${path}`);
  }
  return directive;
}

function stepFactory(directive: RunStageDirective): (
  role: string,
  purpose: AgentPurpose,
  dependsOn: string[],
  visibility: ContextVisibility,
  options?: {
    target?: ExecutionTarget;
    collaborators?: string[];
    contributionPath?: string;
    reviewerIteration?: number;
  },
) => AgentStep {
  let sequence = 0;
  return (role, purpose, dependsOn, visibility, options = {}) => {
    sequence += 1;
    const step: AgentStep = {
      id: `${directive.stage}:${sequence}:${role}:${purpose}`,
      sequence,
      stage: directive.stage,
      phase: directive.phase,
      mode: directive.mode,
      role,
      purpose,
      execution_target: options.target ?? "subagent",
      depends_on: dependsOn,
      context_visibility: visibility,
      persona_paths: options.target === "conductor"
        ? [...directive.inline_context_paths]
        : [personaPath(role)],
      collaborators: options.collaborators ?? [],
      stage_file: directive.stage_file,
      memory_path: directive.memory_path,
      consumes: [...directive.consumes],
      produces: [...directive.produces],
      rules_in_context: [...directive.rules_in_context],
      sensors_applicable: [...directive.sensors_applicable],
    };
    if (options.contributionPath !== undefined) {
      step.contribution_path = options.contributionPath;
    }
    if (options.reviewerIteration !== undefined) {
      step.reviewer_iteration = options.reviewerIteration;
    }
    return step;
  };
}

/** Convert a run-stage topology into the deterministic base invocation DAG. */
export function buildStageExecutionPlan(
  rawDirective: RunStageDirective,
): StageExecutionPlan {
  const directive = assertRunStageDirective(rawDirective);
  const add = stepFactory(directive);
  const steps: AgentStep[] = [];
  const lead = directive.lead_agent;
  const supports = directive.support_agents;

  if (directive.mode === "inline") {
    steps.push(add(lead, "build", [], "inline", {
      target: "conductor",
      collaborators: [...supports],
    }));
  } else if (directive.mode === "subagent") {
    const draft = add(lead, "build", [], "isolated", {
      target: "subagent",
    });
    steps.push(draft);
    const contributions = supports.map((role) =>
      add(role, "support", [draft.id], "draft-only", {
        target: "subagent",
        contributionPath: contributionPath(directive, role),
      })
    );
    steps.push(...contributions);
    if (contributions.length > 0) {
      steps.push(add(
        lead,
        "integrate",
        [draft.id, ...contributions.map((step) => step.id)],
        "all-artifacts",
        { target: "subagent" },
      ));
    }
  } else if (directive.mode === "pipeline") {
    const roles = [lead, ...supports];
    for (const [index, role] of roles.entries()) {
      steps.push(add(
        role,
        index === 0 ? "build" : "advance",
        steps.map((step) => step.id),
        index === 0 ? "isolated" : "upstream",
        { target: "subagent" },
      ));
    }
  } else if (directive.mode === "mob") {
    const draft = add(lead, "build", [], "inline", {
      target: "conductor",
    });
    steps.push(draft);
    const contributions = supports.map((role) =>
      add(role, "support", [draft.id], "draft-only", {
        target: "subagent",
        contributionPath: contributionPath(directive, role),
      })
    );
    steps.push(...contributions);
    steps.push(add(
      lead,
      "integrate",
      [draft.id, ...contributions.map((step) => step.id)],
      "all-artifacts",
      { target: "conductor" },
    ));
  } else {
    throw new Error(
      `Execution mode "${directive.mode}" is reserved but not implemented in M7`,
    );
  }

  const plan: StageExecutionPlan = {
    stage: directive.stage,
    phase: directive.phase,
    mode: directive.mode,
    steps,
  };
  if (directive.reviewer !== undefined) {
    plan.reviewer = {
      role: directive.reviewer,
      max_iterations: directive.reviewer_max_iterations ?? 2,
    };
  }
  return plan;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Validate the untrusted inference result before it can affect control flow. */
export function validateAgentResult(
  value: unknown,
  request: AgentInvocation,
): AgentResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Agent result must be an object, got ${describe(value)}`);
  }
  const result = value as Record<string, unknown>;
  const expected = {
    invocation_id: request.id,
    role: request.role,
    purpose: request.purpose,
  } as const;
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (result[field] !== expectedValue) {
      throw new Error(
        `Agent result ${field} must be "${expectedValue}", got ${JSON.stringify(result[field])}`,
      );
    }
  }
  if (![
    "completed",
    "failed",
    "needs-human",
  ].includes(String(result.status))) {
    throw new Error(`Agent result has invalid status: ${JSON.stringify(result.status)}`);
  }
  for (const field of ["summary", "output"] as const) {
    if (typeof result[field] !== "string" || result[field].trim() === "") {
      throw new Error(`Agent result ${field} must be a non-empty string`);
    }
  }
  if (
    result.reviewer_verdict !== undefined &&
    result.reviewer_verdict !== "READY" &&
    result.reviewer_verdict !== "NOT-READY"
  ) throw new Error("Agent result reviewer_verdict must be READY or NOT-READY");

  if (request.purpose === "review" && result.status === "completed") {
    if (result.reviewer_verdict === undefined) {
      throw new Error("Completed Reviewer result requires reviewer_verdict");
    }
    const marker = `**Reviewer:** ${request.role}`;
    const firstLine = (result.output as string).trimStart().split(/\r?\n/, 1)[0];
    if (firstLine !== marker) {
      throw new Error(
        `Reviewer result must start with identity marker "${marker}"`,
      );
    }
  }
  return result as unknown as AgentResult;
}

async function invokeStep(
  step: AgentStep,
  results: readonly AgentResult[],
  steering: SteeringContext,
  adapter: AgentAdapter,
): Promise<AgentResult> {
  const byId = new Map(results.map((result) => [result.invocation_id, result]));
  const priorResults = step.depends_on.map((id) => {
    const result = byId.get(id);
    if (result === undefined) {
      throw new Error(`Invocation "${step.id}" is missing dependency result "${id}"`);
    }
    return result;
  });
  const request: AgentInvocation = {
    ...step,
    prior_results: priorResults,
    steering_bundle: steering.bundle,
    rules_content: steering.rules_content.map((rule) => ({ ...rule })),
  };
  return validateAgentResult(await adapter.invoke(request), request);
}

function terminalResult(
  directive: RunStageDirective,
  status: StageExecutionStatus,
  results: AgentResult[],
  message: string,
  reviewerIterations: number,
): StageExecutionResult {
  return {
    stage: directive.stage,
    mode: directive.mode,
    status,
    results,
    message,
    reviewer_iterations: reviewerIterations,
  };
}

function successfulResult(
  directive: RunStageDirective,
  results: AgentResult[],
  message: string,
  reviewerIterations: number,
): StageExecutionResult {
  return terminalResult(
    directive,
    directive.gate === true ? "awaiting-approval" : "completed",
    results,
    directive.gate === true
      ? `${message} Human approval is required before State can advance.`
      : message,
    reviewerIterations,
  );
}

/** Execute one stage through an injected inference adapter without State mutation. */
export async function executeStage(
  projectDir: string,
  rawDirective: RunStageDirective,
  steering: SteeringContext,
  adapter: AgentAdapter,
): Promise<StageExecutionResult> {
  const directive = assertRunStageDirective(rawDirective);
  assertSteeringContext(directive, steering);
  ensureStageMemory(projectDir, directive.memory_path);
  const plan = buildStageExecutionPlan(directive);
  const results: AgentResult[] = [];
  let reviewerIterations = 0;

  try {
    for (const step of plan.steps) {
      const result = await invokeStep(step, results, steering, adapter);
      results.push(result);
      if (result.status !== "completed") {
        return terminalResult(
          directive,
          result.status,
          results,
          `Agent "${result.role}" returned ${result.status} during ${result.purpose}.`,
          reviewerIterations,
        );
      }
    }

    if (plan.reviewer === undefined) {
      return successfulResult(
        directive,
        results,
        `Stage "${directive.stage}" Agent execution completed.`,
        reviewerIterations,
      );
    }

    let nextSequence = plan.steps.length;
    for (
      let iteration = 1;
      iteration <= plan.reviewer.max_iterations;
      iteration += 1
    ) {
      reviewerIterations = iteration;
      nextSequence += 1;
      const reviewStep: AgentStep = {
        id: `${directive.stage}:${nextSequence}:${plan.reviewer.role}:review`,
        sequence: nextSequence,
        stage: directive.stage,
        phase: directive.phase,
        mode: directive.mode,
        role: plan.reviewer.role,
        purpose: "review",
        execution_target: "subagent",
        // Reviewer scope is path-bounded: it reads the stage definition,
        // consumes, and produced artifacts, never other Agents' raw responses.
        depends_on: [],
        context_visibility: "review-scope",
        persona_paths: [personaPath(plan.reviewer.role)],
        collaborators: [],
        stage_file: directive.stage_file,
        memory_path: directive.memory_path,
        consumes: [...directive.consumes],
        produces: [...directive.produces],
        rules_in_context: [...directive.rules_in_context],
        sensors_applicable: [...directive.sensors_applicable],
        reviewer_iteration: iteration,
      };
      const review = await invokeStep(reviewStep, results, steering, adapter);
      results.push(review);
      if (review.status !== "completed") {
        return terminalResult(
          directive,
          review.status,
          results,
          `Reviewer "${review.role}" returned ${review.status}.`,
          reviewerIterations,
        );
      }
      if (review.reviewer_verdict === "READY") {
        return successfulResult(
          directive,
          results,
          `Stage "${directive.stage}" passed Reviewer iteration ${iteration}.`,
          reviewerIterations,
        );
      }
      if (iteration === plan.reviewer.max_iterations) {
        return terminalResult(
          directive,
          "needs-human",
          results,
          `Reviewer "${review.role}" remained NOT-READY after ${iteration} iterations.`,
          reviewerIterations,
        );
      }

      nextSequence += 1;
      const revisionStep: AgentStep = {
        id: `${directive.stage}:${nextSequence}:${directive.lead_agent}:revise`,
        sequence: nextSequence,
        stage: directive.stage,
        phase: directive.phase,
        mode: directive.mode,
        role: directive.lead_agent,
        purpose: "revise",
        execution_target: "subagent",
        depends_on: [review.invocation_id],
        context_visibility: "all-artifacts",
        persona_paths: [personaPath(directive.lead_agent)],
        collaborators: [],
        stage_file: directive.stage_file,
        memory_path: directive.memory_path,
        consumes: [...directive.consumes],
        produces: [...directive.produces],
        rules_in_context: [...directive.rules_in_context],
        sensors_applicable: [...directive.sensors_applicable],
      };
      const revision = await invokeStep(revisionStep, results, steering, adapter);
      results.push(revision);
      if (revision.status !== "completed") {
        return terminalResult(
          directive,
          revision.status,
          results,
          `Lead "${revision.role}" returned ${revision.status} during revision.`,
          reviewerIterations,
        );
      }
    }
  } catch (error) {
    return terminalResult(
      directive,
      "failed",
      results,
      error instanceof Error ? error.message : String(error),
      reviewerIterations,
    );
  }

  return terminalResult(
    directive,
    "failed",
    results,
    `Internal: no terminal execution result for "${directive.stage}".`,
    reviewerIterations,
  );
}

/** Execute and report only a verified completed Agent result. */
export async function executeStageAndReport(
  projectDir: string,
  directive: RunStageDirective,
  steering: SteeringContext,
  adapter: AgentAdapter,
): Promise<StageExecutionResult> {
  const execution = await executeStage(projectDir, directive, steering, adapter);
  if (execution.status !== "completed") return execution;
  const report = reportStageResult(projectDir, {
    stage: directive.stage,
    result: "completed",
    ...(directive.unit === undefined ? {} : { unit: directive.unit }),
  });
  if (report.kind === "error") {
    return {
      ...execution,
      status: "failed",
      message: `Agent execution completed, but State transition failed: ${report.message}`,
      report,
    };
  }
  return { ...execution, report };
}

/** Commit a gated execution only after the Conductor obtained human approval. */
export function reportApprovedStageExecution(
  projectDir: string,
  directive: RunStageDirective,
  execution: StageExecutionResult,
  userInput: string,
): StageExecutionResult {
  if (execution.stage !== directive.stage || execution.mode !== directive.mode) {
    return {
      ...execution,
      status: "failed",
      message: "Approval result does not match the run-stage Directive.",
    };
  }
  if (directive.gate !== true || execution.status !== "awaiting-approval") {
    return {
      ...execution,
      status: "failed",
      message:
        `Stage "${directive.stage}" is not awaiting approval; refusing an approval report.`,
    };
  }
  const report = reportStageResult(projectDir, {
    stage: directive.stage,
    result: "approved",
    userInput,
    ...(directive.unit === undefined ? {} : { unit: directive.unit }),
  });
  if (report.kind === "error") {
    return {
      ...execution,
      status: "failed",
      message: `Approval was obtained, but State transition failed: ${report.message}`,
      report,
    };
  }
  return {
    ...execution,
    status: "completed",
    message: `Stage "${directive.stage}" was approved and State advanced.`,
    report,
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "plan") {
    console.error("Usage: aidlc-executor plan [--project-dir <project-dir>]");
    process.exitCode = 1;
    return;
  }
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  let directive = resolveNextDirective(projectDir);
  let steeringBeats = 0;
  while (directive.kind === "load-steering") {
    steeringBeats += 1;
    if (steeringBeats > 100) {
      console.error("Steering did not converge within 100 directives.");
      process.exitCode = 1;
      return;
    }
    directive = resolveNextDirective(projectDir, {
      continueToken: directive.continue_token,
    });
  }
  if (directive.kind !== "run-stage") {
    console.log(JSON.stringify(directive, null, 2));
    return;
  }
  try {
    console.log(JSON.stringify(buildStageExecutionPlan(directive), null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    }, null, 2));
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
