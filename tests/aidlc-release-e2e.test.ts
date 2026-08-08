import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { RunStageDirective } from "../core/tools/aidlc-directive.ts";
import { checkDoctor } from "../core/tools/aidlc-doctor.ts";
import {
  birthIntentWithState,
  readIntentRegistry,
} from "../core/tools/aidlc-intent.ts";
import { persistLearnings } from "../core/tools/aidlc-learnings.ts";
import { ensureStageMemory } from "../core/tools/aidlc-memory.ts";
import {
  reportStageResult,
  resolveNextDirective,
} from "../core/tools/aidlc-orchestrate.ts";
import { writeRunnerSkills } from "../core/tools/aidlc-runner-gen.ts";
import {
  promotePractices,
  resumeIntentState,
} from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

const SCOPES = [
  "bugfix",
  "enterprise",
  "feature",
  "infra",
  "mvp",
  "poc",
  "refactor",
  "security-patch",
  "workshop",
] as const;

const UNIT_DAG = `# Unit dependencies

\`\`\`yaml
units:
  - name: api
    kind: service
    depends_on: [data]
  - name: data
    kind: library
    depends_on: []
\`\`\`
`;

function freshBrownfieldProject(scope: string): {
  projectDir: string;
  recordDir: string;
  auditPath: string;
  dirName: string;
} {
  const projectDir = mkdtempSync(join(tmpdir(), `aidlc-release-${scope}-`));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(
    join(projectDir, "package.json"),
    `${JSON.stringify({ name: `release-${scope}`, private: true })}\n`,
    "utf8",
  );
  writeFileSync(
    join(projectDir, "src", "index.ts"),
    "export const fixture = true;\n",
    "utf8",
  );
  initializeWorkspace(projectDir);
  writeRunnerSkills({ skillsDir: join(projectDir, ".agents", "skills") });
  const born = birthIntentWithState(
    projectDir,
    `Release ${scope}`,
    "default",
    scope,
    ["app"],
  );
  return {
    projectDir,
    recordDir: born.recordDir,
    auditPath: born.auditPath,
    dirName: born.dirName,
  };
}

function runnableDirective(projectDir: string): RunStageDirective | null {
  let directive = resolveNextDirective(projectDir);
  while (directive.kind === "load-steering") {
    directive = resolveNextDirective(projectDir, {
      continueToken: directive.continue_token,
    });
  }
  if (directive.kind === "done") return null;
  assert.equal(
    directive.kind,
    "run-stage",
    directive.kind === "error" ? directive.message : JSON.stringify(directive),
  );
  if (directive.kind !== "run-stage") {
    throw new Error("Expected run-stage Directive");
  }
  return directive;
}

function materializeOutputs(
  projectDir: string,
  directive: RunStageDirective,
): void {
  for (const output of directive.produces) {
    const path = resolve(projectDir, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      path.endsWith("unit-of-work-dependency.md")
        ? UNIT_DAG
        : `# ${directive.stage}${directive.unit === undefined ? "" : ` / ${directive.unit}`}\n`,
      "utf8",
    );
  }
}

function confirmLearningGate(
  projectDir: string,
  recordDir: string,
  directive: RunStageDirective,
): void {
  ensureStageMemory(projectDir, directive.memory_path);
  const selectionDir = join(recordDir, ".aidlc-learnings");
  mkdirSync(selectionDir, { recursive: true });
  const suffix = directive.unit === undefined ? "" : `-${directive.unit}`;
  const selectionPath = join(
    selectionDir,
    `${directive.stage}${suffix}-selections.json`,
  );
  writeFileSync(selectionPath, `${JSON.stringify({
    version: 1,
    stage: directive.stage,
    anything_to_add_answered: true,
    selections: [],
  }, null, 2)}\n`, "utf8");
  persistLearnings(
    projectDir,
    directive.stage,
    selectionPath,
    directive.unit,
  );
}

function completeDirective(
  projectDir: string,
  recordDir: string,
  directive: RunStageDirective,
): void {
  materializeOutputs(projectDir, directive);
  confirmLearningGate(projectDir, recordDir, directive);
  if (directive.stage === "practices-discovery") {
    const stageDir = join(recordDir, "inception", "practices-discovery");
    writeFileSync(
      join(stageDir, "team-practices.md"),
      "# Team Practices\n\n## Way of Working\n\nUse short-lived branches.\n\n" +
        "## Walking Skeleton\n\nBuild one thin slice first.\n\n" +
        "## Testing Posture\n\nTest behavior at boundaries.\n\n" +
        "## Deployment\n\nPromote after checks pass.\n\n" +
        "## Code Style\n\nFollow the repository formatter.\n",
      "utf8",
    );
    writeFileSync(
      join(stageDir, "discovered-rules.md"),
      "# Discovered Rules\n\n## Mandated\n\nALWAYS run tests before merge\n\n" +
        "## Forbidden\n\nNEVER commit secrets\n",
      "utf8",
    );
    for (const agent of directive.support_agents) {
      const path = join(stageDir, "contributions", `${agent}.md`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `**Collaborator:** ${agent}\n\n## Contribution\n\nChecked.\n`, "utf8");
    }
    promotePractices(
      projectDir,
      join(stageDir, "team-practices.md"),
      join(stageDir, "discovered-rules.md"),
      "Release test",
    );
  }
  const result = reportStageResult(projectDir, {
    stage: directive.stage,
    result: "approved",
    userInput: "Approve",
    ...(directive.unit === undefined ? {} : { unit: directive.unit }),
  });
  assert.equal(
    result.kind,
    "done",
    result.kind === "error" ? result.message : JSON.stringify(result),
  );
}

function finishWorkflow(
  projectDir: string,
  recordDir: string,
  maxExecutions = 128,
): number {
  let executions = 0;
  while (executions < maxExecutions) {
    const directive = runnableDirective(projectDir);
    if (directive === null) return executions;
    completeDirective(projectDir, recordDir, directive);
    executions += 1;
  }
  throw new Error(`Workflow did not finish after ${maxExecutions} executions`);
}

test("every Scope completes through the graph-backed workflow", { timeout: 60_000 }, async (t) => {
  for (const scope of SCOPES) {
    await t.test(scope, () => {
      const fixture = freshBrownfieldProject(scope);
      const executions = finishWorkflow(fixture.projectDir, fixture.recordDir);
      assert.ok(executions > 0);

      const resume = resumeIntentState(fixture.projectDir);
      assert.equal(resume.scope, scope);
      assert.equal(resume.status, "Completed");
      assert.equal(resume.currentStage, "none");
      assert.equal(resume.lifecyclePhase, "READY");
      assert.equal(resume.activeAgent, "");
      assert.equal(resume.completed, resume.totalStages);
      assert.equal(resolveNextDirective(fixture.projectDir).kind, "done");

      const registry = readIntentRegistry(fixture.projectDir);
      assert.equal(
        registry.find((entry) => entry.dirName === fixture.dirName)?.status,
        "complete",
      );
      assert.match(
        readFileSync(fixture.auditPath, "utf8"),
        /\*\*Event\*\*: WORKFLOW_COMPLETED/,
      );
      const doctor = checkDoctor(fixture.projectDir);
      assert.equal(doctor.healthy, true, JSON.stringify(doctor, null, 2));
    });
  }
});

test("a per-Unit workflow resumes from the next persisted Unit", { timeout: 30_000 }, () => {
  const fixture = freshBrownfieldProject("mvp");
  let directive = runnableDirective(fixture.projectDir);
  while (directive !== null && directive.stage !== "functional-design") {
    completeDirective(fixture.projectDir, fixture.recordDir, directive);
    directive = runnableDirective(fixture.projectDir);
  }
  assert.ok(directive);
  assert.equal(directive.stage, "functional-design");
  assert.equal(directive.unit, "data");
  completeDirective(fixture.projectDir, fixture.recordDir, directive);

  // No continuation token or in-memory cursor is retained here. Re-entering
  // from State must select the next Unit in topological order.
  const resumed = resumeIntentState(fixture.projectDir);
  assert.equal(resumed.currentStage, "functional-design");
  assert.equal(resumed.currentUnit, "api");
  const afterRestart = runnableDirective(fixture.projectDir);
  assert.ok(afterRestart);
  assert.equal(afterRestart.stage, "functional-design");
  assert.equal(afterRestart.unit, "api");

  const remaining = finishWorkflow(fixture.projectDir, fixture.recordDir);
  assert.ok(remaining > 0);
  assert.equal(resumeIntentState(fixture.projectDir).status, "Completed");
});
