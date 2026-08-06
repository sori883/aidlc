import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { validateDirective } from "../core/tools/aidlc-directive.ts";
import { loadCompiledStageGraph } from "../core/tools/aidlc-graph.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  reportStageResult,
  resolveNextDirective,
} from "../core/tools/aidlc-orchestrate.ts";
import {
  completeCurrentStage,
  resumeIntentState,
} from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function freshProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-orchestrate-"));
  initializeWorkspace(projectDir);
  return projectDir;
}

function materialize(projectDir: string, paths: readonly string[]): void {
  for (const path of paths) {
    const absolute = resolve(projectDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "# Test artifact\n", "utf8");
  }
}

test("next emits one graph-backed run-stage directive without mutation", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const beforeState = readFileSync(born.state.statePath, "utf8");
  const beforeAudit = readFileSync(born.auditPath, "utf8");

  const directive = resolveNextDirective(projectDir);

  assert.equal(directive.kind, "run-stage");
  if (directive.kind !== "run-stage") return;
  assert.equal(directive.stage, "intent-capture");
  assert.equal(directive.phase, "ideation");
  assert.equal(directive.lead_agent, "aidlc-product-agent");
  assert.deepEqual(directive.support_agents, ["aidlc-architect-agent"]);
  assert.equal(directive.mode, "inline");
  assert.equal(directive.gate, true);
  assert.equal(directive.reviewer, "aidlc-product-lead-agent");
  assert.equal(directive.reviewer_max_iterations, 2);
  assert.ok(directive.stage_file.endsWith(
    "/core/aidlc-common/stages/ideation/intent-capture.md",
  ));
  assert.ok(existsSync(directive.stage_file));
  assert.deepEqual(
    directive.inline_context_paths.map((path) => basename(path)),
    ["aidlc-product-agent.md", "aidlc-architect-agent.md"],
  );
  assert.ok(directive.inline_context_paths.every(existsSync));
  assert.deepEqual(directive.produces.map((path) => basename(path)), [
    "intent-statement.md",
    "stakeholder-map.md",
    "intent-capture-questions.md",
  ]);
  assert.deepEqual(directive.sensors_applicable, [
    "claim-sources",
    "required-sections",
    "upstream-coverage",
  ]);
  assert.match(directive.memory_path, /\/ideation\/intent-capture\/memory\.md$/);
  assert.equal(validateDirective(directive).valid, true);
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);
  assert.equal(readFileSync(born.auditPath, "utf8"), beforeAudit);
});

test("report completion delegates to State and next sees the advanced stage", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const beforeAudit = readFileSync(born.auditPath, "utf8");

  const beforeState = readFileSync(born.state.statePath, "utf8");
  const rejected = reportStageResult(projectDir, {
    stage: "intent-capture",
    result: "completed",
  });
  assert.equal(rejected.kind, "error");
  if (rejected.kind === "error") {
    assert.match(rejected.message, /missing required artifact evidence/);
  }
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);

  const directive = resolveNextDirective(projectDir);
  assert.equal(directive.kind, "run-stage");
  if (directive.kind !== "run-stage") return;
  materialize(projectDir, directive.produces);
  const report = reportStageResult(projectDir, {
    stage: "intent-capture",
    result: "completed",
  });

  assert.equal(report.kind, "done");
  const resume = resumeIntentState(projectDir);
  assert.notEqual(resume.currentStage, "intent-capture");
  const next = resolveNextDirective(projectDir);
  assert.equal(next.kind, "run-stage");
  if (next.kind === "run-stage") assert.equal(next.stage, resume.currentStage);
  const audit = readFileSync(born.auditPath, "utf8");
  assert.ok(audit.length > beforeAudit.length);
  assert.match(audit, /\*\*Event\*\*: STAGE_COMPLETED/);
  assert.match(audit, /\*\*Stage\*\*: intent-capture/);
});

test("report skip requires a conditional stage and a reason", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const beforeState = readFileSync(born.state.statePath, "utf8");

  const alwaysSkip = reportStageResult(projectDir, {
    stage: "intent-capture",
    result: "skipped",
    reason: "not needed",
  });
  assert.equal(alwaysSkip.kind, "error");
  assert.match(alwaysSkip.message, /only a CONDITIONAL stage/);
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);

  const directive = resolveNextDirective(projectDir);
  assert.equal(directive.kind, "run-stage");
  if (directive.kind !== "run-stage") return;
  materialize(projectDir, directive.produces);
  reportStageResult(projectDir, {
    stage: "intent-capture",
    result: "completed",
  });
  const conditional = resumeIntentState(projectDir).currentStage;
  const node = loadCompiledStageGraph().find((stage) => stage.slug === conditional);
  assert.equal(node?.execution, "CONDITIONAL");

  const noReason = reportStageResult(projectDir, {
    stage: conditional,
    result: "skipped",
  });
  assert.equal(noReason.kind, "error");
  assert.match(noReason.message, /requires a nonblank --reason/);

  const skipped = reportStageResult(projectDir, {
    stage: conditional,
    result: "skipped",
    reason: "outside MVP needs",
  });
  assert.equal(skipped.kind, "done");
  assert.notEqual(resumeIntentState(projectDir).currentStage, conditional);
  const audit = readFileSync(born.auditPath, "utf8");
  assert.match(audit, /\*\*Event\*\*: STAGE_SKIPPED/);
  assert.match(audit, /\*\*Reason\*\*: outside MVP needs/);
});

test("report does not advance a per-unit stage without unit execution state", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  while (resumeIntentState(projectDir).currentStage !== "functional-design") {
    const current = resumeIntentState(projectDir).currentStage;
    assert.notEqual(current, "none");
    completeCurrentStage(projectDir, current);
  }
  const beforeState = readFileSync(born.state.statePath, "utf8");

  const result = reportStageResult(projectDir, {
    stage: "functional-design",
    result: "completed",
  });

  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.match(result.message, /unit execution state/);
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);
});

test("next emits done after the active workflow completes", () => {
  const projectDir = freshProject();
  birthIntentWithState(projectDir, "Payment API", "default", "poc");

  while (resumeIntentState(projectDir).currentStage !== "none") {
    const current = resumeIntentState(projectDir).currentStage;
    completeCurrentStage(projectDir, current);
  }

  const directive = resolveNextDirective(projectDir);
  assert.equal(directive.kind, "done");
  if (directive.kind === "done") assert.match(directive.reason, /poc/);
});

test("next returns an error directive when no Intent is active", () => {
  const projectDir = freshProject();
  const directive = resolveNextDirective(projectDir);
  assert.equal(directive.kind, "error");
  if (directive.kind === "error") assert.match(directive.message, /No active intent/);
});

test("directive validation rejects malformed and drifted wire shapes", () => {
  assert.deepEqual(validateDirective(null), {
    valid: false,
    errors: ["expected object, got null"],
  });
  const result = validateDirective({ kind: "done", reason: "ok", extra: true });
  assert.equal(result.valid, false);
  if (!result.valid) assert.deepEqual(result.errors, ["done: unknown key: extra"]);

  const badOptional = validateDirective({
    kind: "invoke-swarm",
    units: ["payments"],
    reviewer_max_iterations: 0,
  });
  assert.equal(badOptional.valid, false);
  if (!badOptional.valid) {
    assert.deepEqual(badOptional.errors, [
      "invoke-swarm: reviewer_max_iterations must be a positive integer",
    ]);
  }
});
