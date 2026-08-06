import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import type {
  LoadSteeringDirective,
  RunStageDirective,
} from "../core/tools/aidlc-directive.ts";
import {
  type AgentAdapter,
  type AgentInvocation,
  type AgentResult,
  buildStageExecutionPlan,
  executeStage,
  executeStageAndReport,
  reportApprovedStageExecution,
} from "../core/tools/aidlc-executor.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  persistLearnings,
  surfaceLearnings,
} from "../core/tools/aidlc-learnings.ts";
import { appendStageMemoryEntry } from "../core/tools/aidlc-memory.ts";
import { resolveNextDirective } from "../core/tools/aidlc-orchestrate.ts";
import {
  assembleSteeringContext,
  steeringBundleDigest,
  type SteeringContext,
} from "../core/tools/aidlc-steering.ts";
import {
  activeIntentRecordDir,
  resumeIntentState,
} from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function fixture(
  mode: RunStageDirective["mode"],
  options: { reviewer?: boolean; maxIterations?: number } = {},
): RunStageDirective {
  const lead = "aidlc-architect-agent";
  const supports = ["aidlc-aws-platform-agent", "aidlc-compliance-agent"];
  const inlineRoles = mode === "inline"
    ? [lead, ...supports]
    : mode === "mob" ? [lead] : [];
  return {
    kind: "run-stage",
    stage: "feasibility",
    phase: "ideation",
    lead_agent: lead,
    support_agents: supports,
    mode,
    inline_context_paths: inlineRoles.map((role) =>
      resolve("core", "agents", `${role}.md`)
    ),
    gate: true,
    memory_path: "aidlc/spaces/default/intents/example/ideation/feasibility/memory.md",
    consumes: ["aidlc/example/intent-statement.md"],
    produces: ["aidlc/example/feasibility-assessment.md"],
    rules_in_context: ["aidlc/spaces/default/memory/org.md"],
    sensors_applicable: ["required-sections"],
    stage_file: resolve(
      "core",
      "aidlc-common",
      "stages",
      "ideation",
      "feasibility.md",
    ),
    next_stage: "Scope Definition",
    ...(options.reviewer
      ? {
          reviewer: "aidlc-product-lead-agent",
          reviewer_max_iterations: options.maxIterations ?? 2,
        }
      : {}),
  };
}

function resultFor(
  request: AgentInvocation,
  options: {
    status?: AgentResult["status"];
    verdict?: AgentResult["reviewer_verdict"];
  } = {},
): AgentResult {
  const status = options.status ?? "completed";
  const output = request.purpose === "review"
    ? `**Reviewer:** ${request.role}\n\nVerdict: ${options.verdict ?? "READY"}`
    : `${request.role} completed ${request.purpose}`;
  return {
    invocation_id: request.id,
    role: request.role,
    purpose: request.purpose,
    status,
    summary: `${request.purpose}: ${status}`,
    output,
    ...(options.verdict === undefined
      ? {}
      : { reviewer_verdict: options.verdict }),
  };
}

function fixtureSteering(directive: RunStageDirective): SteeringContext {
  const rulesContent = [{
    path: directive.rules_in_context[0] ?? "",
    text: "# Org Rules\n\n## Mandated\n\nUse verified evidence.\n",
  }];
  return {
    stage: directive.stage,
    bundle: steeringBundleDigest(directive.rules_in_context, rulesContent),
    rules_content: rulesContent,
  };
}

function resolveRunnable(projectDir: string): {
  directive: RunStageDirective;
  steering: SteeringContext;
} {
  const loads: LoadSteeringDirective[] = [];
  let directive = resolveNextDirective(projectDir);
  while (directive.kind === "load-steering") {
    loads.push(directive);
    directive = resolveNextDirective(projectDir, {
      continueToken: directive.continue_token,
    });
  }
  assert.equal(directive.kind, "run-stage");
  if (directive.kind !== "run-stage") {
    throw new Error("Expected run-stage Directive.");
  }
  return {
    directive,
    steering: assembleSteeringContext(directive, loads),
  };
}

class RecordingAdapter implements AgentAdapter {
  readonly requests: AgentInvocation[] = [];

  constructor(
    private readonly handler: (
      request: AgentInvocation,
      index: number,
    ) => AgentResult | Promise<AgentResult>,
  ) {}

  async invoke(request: AgentInvocation): Promise<AgentResult> {
    this.requests.push(request);
    return await this.handler(request, this.requests.length - 1);
  }
}

function freshProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-executor-"));
  initializeWorkspace(projectDir);
  return projectDir;
}

function executionFixture(
  mode: RunStageDirective["mode"],
  options: { reviewer?: boolean; maxIterations?: number } = {},
): { projectDir: string; directive: RunStageDirective } {
  const projectDir = freshProject();
  birthIntentWithState(projectDir, "Executor fixture", "default", "mvp");
  const directive = fixture(mode, options);
  directive.memory_path = relative(
    projectDir,
    join(activeIntentRecordDir(projectDir), "ideation", "feasibility", "memory.md"),
  );
  return { projectDir, directive };
}

function materialize(projectDir: string, paths: readonly string[]): void {
  for (const path of paths) {
    const absolute = resolve(projectDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "# Test artifact\n", "utf8");
  }
}

function confirmLearningGate(
  projectDir: string,
  directive: RunStageDirective,
  selectFirst = false,
): void {
  const dir = join(activeIntentRecordDir(projectDir), ".aidlc-learnings");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${directive.stage}-selections.json`);
  const surfaced = surfaceLearnings(projectDir, directive.stage, directive.unit);
  const first = surfaced.candidates[0];
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    stage: directive.stage,
    anything_to_add_answered: true,
    selections: selectFirst && first !== undefined
      ? [{
          id: first.id,
          scope: "project",
          heading: "Corrections",
          admission: "clear",
        }]
      : [],
  }, null, 2)}\n`, "utf8");
  persistLearnings(projectDir, directive.stage, path, directive.unit);
}

test("execution plans encode the four upstream communication topologies", () => {
  const inline = buildStageExecutionPlan(fixture("inline"));
  assert.equal(inline.steps.length, 1);
  assert.equal(inline.steps[0]?.execution_target, "conductor");
  assert.equal(inline.steps[0]?.purpose, "build");
  assert.deepEqual(inline.steps[0]?.collaborators, [
    "aidlc-aws-platform-agent",
    "aidlc-compliance-agent",
  ]);
  assert.equal(inline.steps[0]?.persona_paths.length, 3);

  const subagent = buildStageExecutionPlan(fixture("subagent"));
  assert.deepEqual(subagent.steps.map((step) => step.purpose), [
    "build",
    "support",
    "support",
    "integrate",
  ]);
  assert.ok(subagent.steps.every((step) => step.execution_target === "subagent"));
  assert.deepEqual(subagent.steps[1]?.depends_on, [subagent.steps[0]?.id]);
  assert.deepEqual(subagent.steps[2]?.depends_on, [subagent.steps[0]?.id]);
  assert.deepEqual(subagent.steps[3]?.depends_on, subagent.steps.slice(0, 3).map(
    (step) => step.id,
  ));
  assert.match(subagent.steps[1]?.contribution_path ?? "", /contributions/);

  const pipeline = buildStageExecutionPlan(fixture("pipeline"));
  assert.deepEqual(pipeline.steps.map((step) => step.purpose), [
    "build",
    "advance",
    "advance",
  ]);
  assert.deepEqual(pipeline.steps.map((step) => step.depends_on.length), [0, 1, 2]);
  assert.equal(pipeline.steps.some((step) => step.contribution_path !== undefined), false);

  const mob = buildStageExecutionPlan(fixture("mob"));
  assert.deepEqual(mob.steps.map((step) => step.execution_target), [
    "conductor",
    "subagent",
    "subagent",
    "conductor",
  ]);
  assert.deepEqual(mob.steps.slice(1, 3).map((step) => step.context_visibility), [
    "draft-only",
    "draft-only",
  ]);
  assert.deepEqual(mob.steps[3]?.depends_on, mob.steps.slice(0, 3).map(
    (step) => step.id,
  ));
});

test("every topology delivers loaded Rule text to every Agent invocation", async () => {
  for (const mode of ["inline", "subagent", "pipeline", "mob"] as const) {
    const { projectDir, directive } = executionFixture(mode);
    const steering = fixtureSteering(directive);
    const adapter = new RecordingAdapter((request) => resultFor(request));

    const execution = await executeStage(projectDir, directive, steering, adapter);

    assert.equal(execution.status, "awaiting-approval");
    assert.ok(adapter.requests.length >= 1);
    assert.ok(adapter.requests.every((request) =>
      request.steering_bundle === steering.bundle &&
      request.rules_content[0]?.text === steering.rules_content[0]?.text &&
      request.memory_path === directive.memory_path
    ));
    assert.equal(existsSync(resolve(projectDir, directive.memory_path)), true);
  }
});

test("Reviewer NOT-READY re-invokes the lead and retries until READY", async () => {
  const adapter = new RecordingAdapter((request) => {
    if (request.purpose === "review") {
      return resultFor(request, {
        verdict: request.reviewer_iteration === 1 ? "NOT-READY" : "READY",
      });
    }
    return resultFor(request);
  });

  const { projectDir, directive } = executionFixture(
    "inline",
    { reviewer: true, maxIterations: 2 },
  );
  const execution = await executeStage(
    projectDir,
    directive,
    fixtureSteering(directive),
    adapter,
  );

  assert.equal(execution.status, "awaiting-approval");
  assert.equal(execution.reviewer_iterations, 2);
  assert.deepEqual(adapter.requests.map((request) => request.purpose), [
    "build",
    "review",
    "revise",
    "review",
  ]);
  assert.equal(adapter.requests[1]?.execution_target, "subagent");
  assert.equal(adapter.requests[2]?.role, "aidlc-architect-agent");
  assert.deepEqual(adapter.requests[1]?.prior_results, []);
  assert.deepEqual(adapter.requests[2]?.prior_results.map(
    (result) => result.invocation_id,
  ), [adapter.requests[1]?.id]);
  assert.deepEqual(adapter.requests[3]?.prior_results, []);
  assert.ok(adapter.requests.every((request) =>
    request.steering_bundle === fixtureSteering(directive).bundle &&
    request.rules_content.length === 1
  ));
});

test("Reviewer exhaustion stops with needs-human", async () => {
  const adapter = new RecordingAdapter((request) =>
    resultFor(request, {
      ...(request.purpose === "review" ? { verdict: "NOT-READY" } : {}),
    })
  );

  const { projectDir, directive } = executionFixture(
    "inline",
    { reviewer: true, maxIterations: 2 },
  );
  const execution = await executeStage(
    projectDir,
    directive,
    fixtureSteering(directive),
    adapter,
  );

  assert.equal(execution.status, "needs-human");
  assert.equal(execution.reviewer_iterations, 2);
  assert.match(execution.message, /remained NOT-READY/);
});

test("malformed Reviewer output is rejected before completion", async () => {
  const adapter = new RecordingAdapter((request) => {
    const result = resultFor(request, {
      ...(request.purpose === "review" ? { verdict: "READY" } : {}),
    });
    return request.purpose === "review"
      ? { ...result, output: "Verdict: READY" }
      : result;
  });

  const { projectDir, directive } = executionFixture("inline", { reviewer: true });
  const execution = await executeStage(
    projectDir,
    directive,
    fixtureSteering(directive),
    adapter,
  );

  assert.equal(execution.status, "failed");
  assert.match(execution.message, /identity marker/);
});

test("gated Agent success waits for approval, then reports and advances State", async () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const { directive, steering } = resolveRunnable(projectDir);
  const current = resumeIntentState(projectDir).currentStage;
  const adapter = new RecordingAdapter((request) =>
    resultFor(request, {
      ...(request.purpose === "review" ? { verdict: "READY" } : {}),
    })
  );

  const execution = await executeStageAndReport(
    projectDir,
    directive,
    steering,
    adapter,
  );

  assert.equal(execution.status, "awaiting-approval");
  assert.equal(execution.report, undefined);
  assert.equal(resumeIntentState(projectDir).currentStage, current);

  materialize(projectDir, directive.produces);
  appendStageMemoryEntry(projectDir, directive.memory_path, {
    heading: "Interpretations",
    summary: "Keep the first API narrow",
    context: "The MVP should minimize initial integration risk",
    timestamp: "2026-08-06T05:06:07Z",
  });
  confirmLearningGate(projectDir, directive, true);
  const approved = reportApprovedStageExecution(
    projectDir,
    directive,
    execution,
  );
  assert.equal(approved.status, "completed");
  assert.equal(approved.report?.kind, "done");
  assert.notEqual(resumeIntentState(projectDir).currentStage, current);
  const audit = readFileSync(born.auditPath, "utf8");
  assert.match(audit, /\*\*Event\*\*: STAGE_COMPLETED/);
  assert.match(audit, /\*\*Event\*\*: RULE_LEARNED/);
  assert.match(audit, new RegExp(`\\*\\*Stage\\*\\*: ${current}`));
});

test("failed Agent execution never reports or advances State", async () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const { directive, steering } = resolveRunnable(projectDir);
  const beforeState = readFileSync(born.state.statePath, "utf8");
  const beforeAudit = readFileSync(born.auditPath, "utf8");
  const adapter = new RecordingAdapter((request) =>
    resultFor(request, { status: "failed" })
  );

  const execution = await executeStageAndReport(
    projectDir,
    directive,
    steering,
    adapter,
  );

  assert.equal(execution.status, "failed");
  assert.equal(execution.report, undefined);
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);
  assert.equal(readFileSync(born.auditPath, "utf8"), beforeAudit);
});
