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
import { test } from "bun:test";
import {
  type LoadSteeringDirective,
  type RunStageDirective,
  validateDirective,
} from "../core/tools/aidlc-directive.ts";
import { loadCompiledStageGraph } from "../core/tools/aidlc-graph.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { persistLearnings } from "../core/tools/aidlc-learnings.ts";
import { ensureStageMemory } from "../core/tools/aidlc-memory.ts";
import {
  reportSingleStageResult,
  reportStageResult,
  resolveNextDirective,
} from "../core/tools/aidlc-orchestrate.ts";
import {
  completeCurrentUnitStage,
  completeCurrentStage,
  activeIntentRecordDir,
  resumeIntentState,
  setConstructionIteration,
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

function resolveRunnable(projectDir: string): {
  directive: RunStageDirective;
  loads: LoadSteeringDirective[];
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
  return { directive, loads };
}

function confirmLearningGate(
  projectDir: string,
  directive: RunStageDirective,
): void {
  ensureStageMemory(projectDir, directive.memory_path);
  const dir = join(activeIntentRecordDir(projectDir), ".aidlc-learnings");
  mkdirSync(dir, { recursive: true });
  const suffix = directive.unit === undefined ? "" : `-${directive.unit}`;
  const path = join(dir, `${directive.stage}${suffix}-selections.json`);
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    stage: directive.stage,
    anything_to_add_answered: true,
    selections: [],
  }, null, 2)}\n`, "utf8");
  persistLearnings(projectDir, directive.stage, path, directive.unit);
}

test("next loads Rules before one graph-backed run-stage without State mutation", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const beforeState = readFileSync(born.state.statePath, "utf8");
  const beforeAudit = readFileSync(born.auditPath, "utf8");

  const first = resolveNextDirective(projectDir);
  assert.equal(first.kind, "load-steering");
  if (first.kind !== "load-steering") return;
  assert.equal(first.stage, "intent-capture");
  assert.equal(first.part, 1);
  assert.ok(first.parts >= 1);
  assert.ok(first.rules_content.length >= 1);
  assert.equal(validateDirective(first).valid, true);

  const loads: LoadSteeringDirective[] = [first];
  let next = resolveNextDirective(projectDir, {
    continueToken: first.continue_token,
  });
  while (next.kind === "load-steering") {
    loads.push(next);
    next = resolveNextDirective(projectDir, {
      continueToken: next.continue_token,
    });
  }
  assert.equal(next.kind, "run-stage");
  if (next.kind !== "run-stage") return;
  const directive = next;

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
    directive.inline_context_paths.slice(0, 2).map((path) => basename(path)),
    ["aidlc-product-agent.md", "aidlc-architect-agent.md"],
  );
  assert.ok(
    directive.inline_context_paths.some((path) =>
      path.endsWith("/core/knowledge/aidlc-shared/state-template.md")
    ),
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
  assert.deepEqual(
    [...new Set(loads.flatMap((load) =>
      load.rules_content.map((rule) => basename(rule.path))
    ))],
    ["org.md", "ideation.md"],
  );
  assert.equal(validateDirective(directive).valid, true);
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);
  assert.equal(readFileSync(born.auditPath, "utf8"), beforeAudit);
});

test("single-stage next and report never move the main State pointer", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const beforeState = readFileSync(born.state.statePath, "utf8");
  let next = resolveNextDirective(projectDir, {
    stage: "intent-capture",
    single: true,
  });
  while (next.kind === "load-steering") {
    next = resolveNextDirective(projectDir, {
      stage: "intent-capture",
      single: true,
      continueToken: next.continue_token,
    });
  }
  assert.equal(next.kind, "run-stage");
  if (next.kind !== "run-stage") return;
  assert.equal(next.single, true);
  assert.equal(next.gate, false);
  assert.equal(next.next_stage, null);
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);

  const result = reportSingleStageResult(
    projectDir,
    "intent-capture",
    "completed",
  );
  assert.equal(result.kind, "done");
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);
  const audit = readFileSync(born.auditPath, "utf8");
  assert.match(audit, /\*\*Workflow\*\*: single-stage:intent-capture/);
  assert.match(audit, /\*\*Event\*\*: STAGE_STARTED/);
  assert.match(audit, /\*\*Event\*\*: STAGE_COMPLETED/);
});

test("single-stage mode rejects initialization and Stages skipped by Scope", () => {
  const projectDir = freshProject();
  birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const initialization = resolveNextDirective(projectDir, {
    stage: "state-init",
    single: true,
  });
  assert.equal(initialization.kind, "error");
  if (initialization.kind === "error") {
    assert.match(initialization.message, /initialization stage/);
  }
  const skipped = resolveNextDirective(projectDir, {
    stage: "market-research",
    single: true,
  });
  assert.equal(skipped.kind, "error");
  if (skipped.kind === "error") assert.match(skipped.message, /skipped for scope "mvp"/);
});

test("inline context includes active-Space shared and Agent Knowledge", () => {
  const projectDir = freshProject();
  const knowledgeRoot = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "knowledge",
  );
  const shared = join(knowledgeRoot, "aidlc-shared", "domain.md");
  const product = join(knowledgeRoot, "aidlc-product-agent", "product.md");
  mkdirSync(dirname(shared), { recursive: true });
  mkdirSync(dirname(product), { recursive: true });
  writeFileSync(shared, "# Shared\n", "utf8");
  writeFileSync(product, "# Product\n", "utf8");
  birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const { directive } = resolveRunnable(projectDir);
  assert.ok(directive.inline_context_paths.includes(shared));
  assert.ok(directive.inline_context_paths.includes(product));
});

test("report completion delegates to State and next sees the advanced stage", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const beforeAudit = readFileSync(born.auditPath, "utf8");
  const { directive } = resolveRunnable(projectDir);
  confirmLearningGate(projectDir, directive);

  const beforeState = readFileSync(born.state.statePath, "utf8");
  const rejected = reportStageResult(projectDir, {
    stage: "intent-capture",
    result: "approved",
    userInput: "Approve",
  });
  assert.equal(rejected.kind, "error");
  if (rejected.kind === "error") {
    assert.match(rejected.message, /missing required artifact evidence/);
  }
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);

  materialize(projectDir, directive.produces);
  const report = reportStageResult(projectDir, {
    stage: "intent-capture",
    result: "approved",
    userInput: "Approve",
  });

  assert.equal(report.kind, "done");
  const resume = resumeIntentState(projectDir);
  assert.notEqual(resume.currentStage, "intent-capture");
  const next = resolveRunnable(projectDir).directive;
  assert.equal(next.stage, resume.currentStage);
  const audit = readFileSync(born.auditPath, "utf8");
  assert.ok(audit.length > beforeAudit.length);
  assert.match(audit, /\*\*Event\*\*: STAGE_COMPLETED/);
  assert.match(audit, /\*\*Stage\*\*: intent-capture/);
});

test("gated report refuses completion before the Learnings Ritual", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const { directive } = resolveRunnable(projectDir);
  materialize(projectDir, directive.produces);
  const before = readFileSync(born.state.statePath, "utf8");

  const bypass = reportStageResult(projectDir, {
    stage: directive.stage,
    result: "completed",
  });
  assert.equal(bypass.kind, "error");
  if (bypass.kind === "error") assert.match(bypass.message, /human gate/);

  const unconfirmed = reportStageResult(projectDir, {
    stage: directive.stage,
    result: "approved",
    userInput: "Approve",
  });
  assert.equal(unconfirmed.kind, "error");
  if (unconfirmed.kind === "error") assert.match(unconfirmed.message, /Learning gate is incomplete/);
  assert.equal(readFileSync(born.state.statePath, "utf8"), before);
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

  const { directive } = resolveRunnable(projectDir);
  materialize(projectDir, directive.produces);
  confirmLearningGate(projectDir, directive);
  reportStageResult(projectDir, {
    stage: "intent-capture",
    result: "approved",
    userInput: "Approve",
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

test("a missing Unit DAG falls back to single-pass artifact evidence", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  while (resumeIntentState(projectDir).currentStage !== "functional-design") {
    const current = resumeIntentState(projectDir).currentStage;
    assert.notEqual(current, "none");
    completeCurrentStage(projectDir, current);
  }
  const beforeState = readFileSync(born.state.statePath, "utf8");
  const directive = resolveRunnable(projectDir).directive;
  confirmLearningGate(projectDir, directive);

  const result = reportStageResult(projectDir, {
    stage: "functional-design",
    result: "approved",
    userInput: "Approve",
  });

  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, /missing required artifact evidence/);
    assert.doesNotMatch(result.message, /\{unit-name\}/);
  }
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);
});

test("POC runs per-Unit Construction stages once when no Unit DAG exists", () => {
  const projectDir = freshProject();
  birthIntentWithState(projectDir, "Payment API spike", "default", "poc");
  while (resumeIntentState(projectDir).currentStage !== "code-generation") {
    const current = resumeIntentState(projectDir).currentStage;
    assert.notEqual(current, "none");
    completeCurrentStage(projectDir, current);
  }

  const { directive } = resolveRunnable(projectDir);
  assert.equal(directive.stage, "code-generation");
  assert.equal(directive.unit, undefined);
  assert.ok(directive.produces.every((path) =>
    path.includes("/construction/code-generation/") &&
    !path.includes("{unit-name}")
  ));

  materialize(projectDir, directive.produces);
  confirmLearningGate(projectDir, directive);
  const report = reportStageResult(projectDir, {
    stage: "code-generation",
    result: "approved",
    userInput: "Approve",
  });
  assert.equal(report.kind, "done");
  assert.equal(resumeIntentState(projectDir).currentStage, "build-and-test");
});

test("reverse-engineering completes only after every registered Repo has evidence", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-orchestrate-repos-"));
  writeFileSync(join(projectDir, "package.json"), '{"name":"fixture"}\n');
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src", "index.ts"), "export const ok = true;\n");
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(
    projectDir,
    "Modernize services",
    "default",
    "mvp",
    ["api", "worker"],
  );
  while (resumeIntentState(projectDir).currentStage !== "reverse-engineering") {
    const current = resumeIntentState(projectDir).currentStage;
    assert.notEqual(current, "none");
    completeCurrentStage(projectDir, current);
  }
  assert.equal(resumeIntentState(projectDir).currentStage, "reverse-engineering");

  const { directive } = resolveRunnable(projectDir);
  assert.equal(directive.stage, "reverse-engineering");
  const apiOutputs = directive.produces.filter((path) => path.includes("/api/"));
  const workerOutputs = directive.produces.filter((path) => path.includes("/worker/"));
  assert.ok(apiOutputs.length > 0);
  assert.equal(apiOutputs.length, workerOutputs.length);

  materialize(projectDir, apiOutputs);
  confirmLearningGate(projectDir, directive);
  const beforeState = readFileSync(born.state.statePath, "utf8");
  const incomplete = reportStageResult(projectDir, {
    stage: "reverse-engineering",
    result: "approved",
    userInput: "Approve",
  });
  assert.equal(incomplete.kind, "error");
  if (incomplete.kind === "error") assert.match(incomplete.message, /\/worker\//);
  assert.equal(readFileSync(born.state.statePath, "utf8"), beforeState);

  materialize(projectDir, workerOutputs);
  const completed = reportStageResult(projectDir, {
    stage: "reverse-engineering",
    result: "approved",
    userInput: "Approve",
  });
  assert.equal(completed.kind, "done");
  assert.notEqual(resumeIntentState(projectDir).currentStage, "reverse-engineering");
});

test("Unit DAG drives resumable per-Unit reports and advances after every Unit", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  while (resumeIntentState(projectDir).currentStage !== "units-generation") {
    const current = resumeIntentState(projectDir).currentStage;
    assert.notEqual(current, "none");
    completeCurrentStage(projectDir, current);
  }

  // Version 7 records created before Unit execution support used only this
  // placeholder; units-generation upgrades it without a separate migration.
  writeFileSync(
    born.state.statePath,
    readFileSync(born.state.statePath, "utf8").replace(
      /<!-- AIDLC_UNIT_PROGRESS_START -->[\s\S]*?<!-- AIDLC_UNIT_PROGRESS_END -->/,
      "Per unit: [TBD]",
    ),
    "utf8",
  );

  const unitsDirective = resolveRunnable(projectDir).directive;
  for (const path of unitsDirective.produces) {
    const absolute = resolve(projectDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(
      absolute,
      path.endsWith("unit-of-work-dependency.md")
        ? `# Unit dependencies

\`\`\`yaml
units:
  - name: api
    kind: service
    depends_on: [database]
  - name: monitoring
    depends_on: [database]
  - name: database
    kind: library
    depends_on: []
  - name: frontend
    kind: ui
    depends_on: [api]
\`\`\`
`
        : "# Test artifact\n",
      "utf8",
    );
  }
  confirmLearningGate(projectDir, unitsDirective);
  assert.equal(reportStageResult(projectDir, {
    stage: "units-generation",
    result: "approved",
    userInput: "Approve",
  }).kind, "done");

  assert.equal(resumeIntentState(projectDir).currentStage, "delivery-planning");
  setConstructionIteration(projectDir, "stage-major");
  completeCurrentStage(projectDir, "delivery-planning");
  assert.equal(resumeIntentState(projectDir).currentStage, "functional-design");
  assert.equal(resumeIntentState(projectDir).currentUnit, "database");

  const outOfOrder = reportStageResult(projectDir, {
    stage: "functional-design",
    unit: "monitoring",
    result: "approved",
    userInput: "Approve",
  });
  assert.equal(outOfOrder.kind, "error");
  if (outOfOrder.kind === "error") assert.match(outOfOrder.message, /out of order/);

  for (const expectedUnit of ["database", "api", "monitoring", "frontend"]) {
    const directive = resolveRunnable(projectDir).directive;
    assert.equal(directive.stage, "functional-design");
    assert.equal(directive.unit, expectedUnit);
    assert.ok(directive.produces.every((path) =>
      path.includes(`/construction/${expectedUnit}/functional-design/`)
    ));
    if (expectedUnit === "frontend") {
      assert.deepEqual(directive.produces.map((path) => basename(path)), [
        "business-logic-model.md",
      ]);
    }
    materialize(projectDir, directive.produces);
    if (expectedUnit === "frontend") {
      const interrupted = completeCurrentUnitStage(
        projectDir,
        directive.stage,
        expectedUnit,
      );
      assert.equal(interrupted.allUnitsCompleted, true);
      assert.equal(resumeIntentState(projectDir).currentUnit, null);
    }
    confirmLearningGate(projectDir, directive);
    const result = reportStageResult(projectDir, {
      stage: directive.stage,
      unit: expectedUnit,
      result: "approved",
      userInput: "Approve",
    });
    assert.equal(result.kind, "done");
  }

  const resume = resumeIntentState(projectDir);
  assert.equal(resume.currentStage, "nfr-requirements");
  assert.equal(resume.currentUnit, "database");
  const state = readFileSync(born.state.statePath, "utf8");
  for (const unit of ["database", "api", "monitoring", "frontend"]) {
    assert.match(state, new RegExp(`^- \\[x\\] Unit: ${unit} — functional-design$`, "m"));
  }
  const audit = readFileSync(born.auditPath, "utf8");
  assert.equal(
    [...audit.matchAll(/\*\*Event\*\*: STAGE_COMPLETED\n\*\*Stage\*\*: functional-design/g)].length,
    1,
  );
});

test("unit-major walks design Stages within each Unit and cascades Stage gates", () => {
  const projectDir = freshProject();
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  while (resumeIntentState(projectDir).currentStage !== "units-generation") {
    completeCurrentStage(projectDir, resumeIntentState(projectDir).currentStage);
  }

  const unitsDirective = resolveRunnable(projectDir).directive;
  for (const path of unitsDirective.produces) {
    const absolute = resolve(projectDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(
      absolute,
      path.endsWith("unit-of-work-dependency.md")
        ? `# Unit dependencies

\`\`\`yaml
units:
  - name: alpha
    depends_on: []
  - name: beta
    depends_on: [alpha]
\`\`\`
`
        : "# Test artifact\n",
      "utf8",
    );
  }
  confirmLearningGate(projectDir, unitsDirective);
  assert.equal(reportStageResult(projectDir, {
    stage: "units-generation",
    result: "approved",
    userInput: "Approve",
  }).kind, "done");

  assert.equal(resumeIntentState(projectDir).currentStage, "delivery-planning");
  setConstructionIteration(projectDir, "unit-major");
  completeCurrentStage(projectDir, "delivery-planning");
  assert.equal(resumeIntentState(projectDir).currentStage, "functional-design");

  const designStages = [
    "functional-design",
    "nfr-requirements",
    "nfr-design",
    "infrastructure-design",
  ];
  const expectedPairs = [
    ...designStages.map((stage) => [stage, "alpha"] as const),
    ...designStages.map((stage) => [stage, "beta"] as const),
  ];
  for (const [expectedStage, expectedUnit] of expectedPairs) {
    const directive = resolveRunnable(projectDir).directive;
    assert.equal(directive.stage, expectedStage);
    assert.equal(directive.unit, expectedUnit);
    assert.equal(directive.gate, false);
    materialize(projectDir, directive.produces);
    confirmLearningGate(projectDir, directive);
  }

  for (const expectedStage of designStages) {
    const gate = resolveRunnable(projectDir).directive;
    assert.equal(gate.stage, expectedStage);
    assert.equal(gate.unit, "beta");
    assert.equal(gate.gate, true);
    assert.equal(reportStageResult(projectDir, {
      stage: expectedStage,
      result: "approved",
      userInput: "Approve",
    }).kind, "done");
  }

  const resume = resumeIntentState(projectDir);
  assert.equal(resume.currentStage, "code-generation");
  assert.equal(resume.currentUnit, "alpha");
  const codeGeneration = resolveRunnable(projectDir).directive;
  assert.equal(codeGeneration.stage, "code-generation");
  assert.equal(codeGeneration.unit, "alpha");
  assert.equal(codeGeneration.gate, true);
  const state = readFileSync(born.state.statePath, "utf8");
  for (const stage of designStages) {
    for (const unit of ["alpha", "beta"]) {
      assert.match(
        state,
        new RegExp(`^- \\[x\\] Unit: ${unit} — ${stage}$`, "m"),
      );
    }
  }
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
