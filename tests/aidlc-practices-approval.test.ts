import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import type { RunStageDirective } from "../core/tools/aidlc-directive.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { persistLearnings } from "../core/tools/aidlc-learnings.ts";
import { logAnswer, logDecision } from "../core/tools/aidlc-log.ts";
import { ensureStageMemory } from "../core/tools/aidlc-memory.ts";
import {
  reportStageResult,
  resolveNextDirective,
} from "../core/tools/aidlc-orchestrate.ts";
import {
  activeIntentRecordDir,
  completeCurrentStage,
  emitPracticesEvent,
  hasFreshPracticesAffirmation,
  promotePractices,
  resumeIntentState,
} from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function freshProject(): { projectDir: string; auditPath: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-approval-"));
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "Approval fixture", "default", "mvp");
  return { projectDir, auditPath: born.auditPath };
}

function advanceTo(projectDir: string, slug: string): void {
  while (resumeIntentState(projectDir).currentStage !== slug) {
    const current = resumeIntentState(projectDir).currentStage;
    assert.notEqual(current, "none");
    completeCurrentStage(projectDir, current);
  }
}

function runnable(projectDir: string): RunStageDirective {
  let directive = resolveNextDirective(projectDir);
  while (directive.kind === "load-steering") {
    directive = resolveNextDirective(projectDir, {
      continueToken: directive.continue_token,
    });
  }
  assert.equal(directive.kind, "run-stage");
  if (directive.kind !== "run-stage") throw new Error("Expected run-stage");
  return directive;
}

function materialize(projectDir: string, directive: RunStageDirective): void {
  for (const output of directive.produces) {
    const path = resolve(projectDir, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# ${basename(path)}\n`, "utf8");
  }
}

function confirmLearning(projectDir: string, directive: RunStageDirective): void {
  ensureStageMemory(projectDir, directive.memory_path);
  const selectionDir = join(activeIntentRecordDir(projectDir), ".aidlc-learnings");
  mkdirSync(selectionDir, { recursive: true });
  const path = join(selectionDir, `${directive.stage}-selections.json`);
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    stage: directive.stage,
    anything_to_add_answered: true,
    selections: [],
  }, null, 2)}\n`, "utf8");
  persistLearnings(projectDir, directive.stage, path);
}

function writePracticesDrafts(projectDir: string, directive: RunStageDirective): {
  team: string;
  rules: string;
} {
  const recordDir = activeIntentRecordDir(projectDir);
  const stageDir = join(recordDir, "inception", "practices-discovery");
  const team = join(stageDir, "team-practices.md");
  const rules = join(stageDir, "discovered-rules.md");
  writeFileSync(
    team,
    "# Team Practices\n\n## Way of Working\n\nUse short-lived branches.\n\n" +
      "## Walking Skeleton\n\nBuild one thin slice first.\n\n" +
      "## Testing Posture\n\nTest behavior at boundaries.\n\n" +
      "## Deployment\n\nPromote after checks pass.\n\n" +
      "## Code Style\n\nUse the repository formatter.\n",
    "utf8",
  );
  writeFileSync(
    rules,
    "# Rules\n\n## Mandated\n\nALWAYS run tests before merge\n\n" +
      "## Forbidden\n\nNEVER commit secrets\n",
    "utf8",
  );
  for (const agent of directive.support_agents) {
    const contribution = join(stageDir, "contributions", `${agent}.md`);
    mkdirSync(dirname(contribution), { recursive: true });
    writeFileSync(
      contribution,
      `**Collaborator:** ${agent}\n\n## Contribution\n\nVerified.\n`,
      "utf8",
    );
  }
  return { team, rules };
}

test("logs non-gate question options and answers as a paired audit trail", () => {
  const { projectDir, auditPath } = freshProject();
  logDecision(projectDir, {
    stage: "intent-capture",
    decision: "Choose the primary API consumer",
    options: "Web app,Partner service",
  });
  logAnswer(projectDir, "intent-capture", "Partner service");
  const audit = readFileSync(auditPath, "utf8");
  assert.match(audit, /\*\*Event\*\*: DECISION_RECORDED/);
  assert.match(audit, /\*\*Options\*\*: Web app,Partner service/);
  assert.match(audit, /\*\*Event\*\*: QUESTION_ANSWERED/);
  assert.match(audit, /\*\*Details\*\*: Partner service/);
});

test("practices-event records discovered and advisory events", () => {
  const { projectDir, auditPath } = freshProject();
  emitPracticesEvent(projectDir, "discovered", {
    "Sources Scanned": "package.json, git history",
    Drafts: "team-practices.md, discovered-rules.md",
  });
  emitPracticesEvent(projectDir, "empty", {
    Section: "Deployment",
    "Fallback source": "org.md",
  });
  const audit = readFileSync(auditPath, "utf8");
  assert.match(audit, /\*\*Event\*\*: PRACTICES_DISCOVERED/);
  assert.match(audit, /\*\*Sources Scanned\*\*: package.json, git history/);
  assert.match(audit, /\*\*Event\*\*: PRACTICES_SECTION_EMPTY/);
});

test("user-stories follows awaiting, rejected, revised, approved lifecycle", () => {
  const { projectDir, auditPath } = freshProject();
  advanceTo(projectDir, "user-stories");
  const directive = runnable(projectDir);
  materialize(projectDir, directive);
  confirmLearning(projectDir, directive);

  assert.equal(reportStageResult(projectDir, {
    stage: "user-stories",
    result: "awaiting-approval",
  }).kind, "done");
  assert.equal(resumeIntentState(projectDir).checkboxState, "awaiting-approval");

  assert.equal(reportStageResult(projectDir, {
    stage: "user-stories",
    result: "rejected",
    userInput: "Add the refund failure path",
  }).kind, "done");
  assert.equal(resumeIntentState(projectDir).checkboxState, "revising");
  let state = readFileSync(join(activeIntentRecordDir(projectDir), "aidlc-state.md"), "utf8");
  assert.match(state, /- \*\*Revision Count\*\*: 1/);

  assert.equal(reportStageResult(projectDir, {
    stage: "user-stories",
    result: "revised",
  }).kind, "done");
  assert.equal(reportStageResult(projectDir, {
    stage: "user-stories",
    result: "approved",
    userInput: "Approve revised stories",
  }).kind, "done");
  assert.notEqual(resumeIntentState(projectDir).currentStage, "user-stories");
  state = readFileSync(join(activeIntentRecordDir(projectDir), "aidlc-state.md"), "utf8");
  assert.match(state, /- \*\*Revision Count\*\*: 0/);
  const audit = readFileSync(auditPath, "utf8");
  const events = [...audit.matchAll(/^\*\*Event\*\*: ([A-Z_]+)$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(events.slice(-7), [
    "STAGE_AWAITING_APPROVAL",
    "GATE_REJECTED",
    "STAGE_REVISING",
    "STAGE_AWAITING_APPROVAL",
    "GATE_APPROVED",
    "STAGE_COMPLETED",
    "STAGE_STARTED",
  ]);
  assert.match(audit, /\*\*User Input\*\*: Approve revised stories/);
});

test("practices-discovery cannot approve until fresh promotion succeeds", () => {
  const { projectDir, auditPath } = freshProject();
  advanceTo(projectDir, "practices-discovery");
  const directive = runnable(projectDir);
  materialize(projectDir, directive);
  confirmLearning(projectDir, directive);
  const drafts = writePracticesDrafts(projectDir, directive);

  assert.equal(reportStageResult(projectDir, {
    stage: "practices-discovery",
    result: "awaiting-approval",
  }).kind, "done");
  const refused = reportStageResult(projectDir, {
    stage: "practices-discovery",
    result: "approved",
    userInput: "Approve",
  });
  assert.equal(refused.kind, "error");
  assert.match(refused.message, /before practices-promote succeeds/);

  const promoted = promotePractices(projectDir, drafts.team, drafts.rules, "Human tester");
  assert.equal(promoted.emitted, "PRACTICES_AFFIRMED");
  assert.equal(hasFreshPracticesAffirmation(projectDir), true);
  assert.match(readFileSync(promoted.teamPath, "utf8"), /Use short-lived branches/);
  assert.match(
    readFileSync(promoted.projectPath, "utf8"),
    /ALWAYS run tests before merge \(affirmed \d{4}-\d{2}-\d{2}\)/,
  );
  assert.equal(reportStageResult(projectDir, {
    stage: "practices-discovery",
    result: "approved",
    userInput: "Approve",
  }).kind, "done");
  const audit = readFileSync(auditPath, "utf8");
  assert.ok(
    audit.indexOf("**Event**: PRACTICES_AFFIRMED") <
      audit.indexOf("**Event**: GATE_APPROVED"),
  );
});

test("a practices rejection invalidates an earlier promotion receipt", () => {
  const { projectDir } = freshProject();
  advanceTo(projectDir, "practices-discovery");
  const directive = runnable(projectDir);
  materialize(projectDir, directive);
  confirmLearning(projectDir, directive);
  const drafts = writePracticesDrafts(projectDir, directive);
  reportStageResult(projectDir, {
    stage: "practices-discovery",
    result: "awaiting-approval",
  });
  promotePractices(projectDir, drafts.team, drafts.rules, "Human tester");
  reportStageResult(projectDir, {
    stage: "practices-discovery",
    result: "rejected",
    userInput: "Change branch lifetime",
  });
  reportStageResult(projectDir, {
    stage: "practices-discovery",
    result: "revised",
  });
  assert.equal(hasFreshPracticesAffirmation(projectDir), false);
  const refused = reportStageResult(projectDir, {
    stage: "practices-discovery",
    result: "approved",
    userInput: "Approve revised practices",
  });
  assert.equal(refused.kind, "error");
  assert.match(refused.message, /before practices-promote succeeds/);
});
