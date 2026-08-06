import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  assertLearningGateCompleted,
  persistLearnings,
  stageMemoryPath,
  surfaceLearnings,
} from "../core/tools/aidlc-learnings.ts";
import { appendStageMemoryEntry } from "../core/tools/aidlc-memory.ts";
import { activeIntentRecordDir } from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function fixture(): {
  projectDir: string;
  recordDir: string;
  auditPath: string;
} {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-learnings-"));
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "Payment API", "default", "mvp");
  const memoryPath = stageMemoryPath(projectDir, "intent-capture");
  const entries = [
    ["Interpretations", "Treat merchants as stakeholders", "The request named payments"],
    ["Deviations", "Deferred settlement detail", "It belongs in a later Stage"],
    ["Tradeoffs", "Kept the first API narrow", "Reduced delivery risk"],
    ["Open Questions", "Confirm retention period", "Compliance input is pending"],
  ] as const;
  for (const [heading, summary, context] of entries) {
    appendStageMemoryEntry(projectDir, memoryPath, {
      heading,
      summary,
      context,
      timestamp: "2026-08-06T03:04:05Z",
    });
  }
  return {
    projectDir,
    recordDir: activeIntentRecordDir(projectDir),
    auditPath: born.auditPath,
  };
}

function writeSelections(
  recordDir: string,
  value: unknown,
  filename = "intent-capture-selections.json",
): string {
  const dir = join(recordDir, ".aidlc-learnings");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

test("surface returns three learning candidates and parks Open Questions", () => {
  const { projectDir } = fixture();

  const first = surfaceLearnings(projectDir, "intent-capture");
  const repeated = surfaceLearnings(projectDir, "intent-capture");

  assert.deepEqual(first, repeated);
  assert.deepEqual(first.candidates.map((candidate) => candidate.source_heading), [
    "Interpretations",
    "Deviations",
    "Tradeoffs",
  ]);
  assert.ok(first.candidates.every((candidate) =>
    /^[a-f0-9]{16}$/.test(candidate.id) && candidate.default_scope === "project"
  ));
  assert.equal(first.parked_open_questions.length, 1);
  assert.equal(
    first.parked_open_questions[0]?.summary,
    "Confirm retention period",
  );
});

test("persist writes selected Rules to project/team once and audits each Rule", () => {
  const { projectDir, recordDir, auditPath } = fixture();
  const surfaced = surfaceLearnings(projectDir, "intent-capture");
  const projectCandidate = surfaced.candidates[0];
  const teamCandidate = surfaced.candidates[2];
  assert.ok(projectCandidate && teamCandidate);
  const selectionsPath = writeSelections(recordDir, {
    version: 1,
    stage: "intent-capture",
    anything_to_add_answered: true,
    selections: [
      {
        id: projectCandidate.id,
        scope: "project",
        heading: "Corrections",
        admission: "clear",
      },
      {
        id: teamCandidate.id,
        scope: "team",
        heading: "Corrections",
        admission: "escalated",
      },
    ],
  });

  const first = persistLearnings(
    projectDir,
    "intent-capture",
    selectionsPath,
  );

  assert.deepEqual(first.persisted.map((entry) => entry.already_present), [
    false,
    false,
  ]);
  assert.match(first.receipt_path, /\.aidlc-learnings\/intent-capture-receipt\.json$/);
  const memoryRoot = join(projectDir, "aidlc", "spaces", "default", "memory");
  const project = readFileSync(join(memoryRoot, "project.md"), "utf8");
  const team = readFileSync(join(memoryRoot, "team.md"), "utf8");
  const org = readFileSync(join(memoryRoot, "org.md"), "utf8");
  assert.match(project, new RegExp(`cid:intent-capture:${projectCandidate.id}`));
  assert.match(team, new RegExp(`cid:intent-capture:${teamCandidate.id}`));
  assert.doesNotMatch(org, /cid:intent-capture:/);
  let audit = readFileSync(auditPath, "utf8");
  assert.equal([...audit.matchAll(/\*\*Event\*\*: RULE_LEARNED/g)].length, 2);

  const repeated = persistLearnings(
    projectDir,
    "intent-capture",
    selectionsPath,
  );
  assert.deepEqual(repeated.persisted.map((entry) => entry.already_present), [
    true,
    true,
  ]);
  audit = readFileSync(auditPath, "utf8");
  assert.equal([...audit.matchAll(/\*\*Event\*\*: RULE_LEARNED/g)].length, 2);
  assert.equal(
    [...readFileSync(join(memoryRoot, "project.md"), "utf8").matchAll(
      new RegExp(`cid:intent-capture:${projectCandidate.id}`, "g"),
    )].length,
    1,
  );
});

test("persist rejects un-surfaced candidates and selections outside runtime dir", () => {
  const { projectDir, recordDir } = fixture();
  const outside = join(projectDir, "selections.json");
  writeFileSync(outside, "{}\n", "utf8");
  assert.throws(
    () => persistLearnings(projectDir, "intent-capture", outside),
    /under .*\.aidlc-learnings/,
  );

  const selectionsPath = writeSelections(recordDir, {
    version: 1,
    stage: "intent-capture",
    anything_to_add_answered: true,
    selections: [{
      id: "0000000000000000",
      scope: "project",
      heading: "Corrections",
      admission: "clear",
    }],
  });
  assert.throws(
    () => persistLearnings(projectDir, "intent-capture", selectionsPath),
    /not a surfaced candidate/,
  );
});

test("learning receipt requires the mandatory answer and becomes stale after Memory changes", () => {
  const { projectDir, recordDir } = fixture();
  const invalid = writeSelections(recordDir, {
    version: 1,
    stage: "intent-capture",
    selections: [],
  }, "invalid-selections.json");
  assert.throws(
    () => persistLearnings(projectDir, "intent-capture", invalid),
    /anything_to_add_answered must be true/,
  );

  const valid = writeSelections(recordDir, {
    version: 1,
    stage: "intent-capture",
    anything_to_add_answered: true,
    selections: [],
  }, "valid-selections.json");
  persistLearnings(projectDir, "intent-capture", valid);
  assert.doesNotThrow(() =>
    assertLearningGateCompleted(projectDir, "intent-capture")
  );

  appendStageMemoryEntry(
    projectDir,
    stageMemoryPath(projectDir, "intent-capture"),
    {
      heading: "Tradeoffs",
      summary: "Changed after confirmation",
      context: "The gate must be answered again",
      timestamp: "2026-08-06T06:07:08Z",
    },
  );
  assert.throws(
    () => assertLearningGateCompleted(projectDir, "intent-capture"),
    /stale or invalid/,
  );
});

test("per-Unit learning lookup supports single-pass and safe Unit paths", () => {
  const { projectDir } = fixture();
  assert.match(
    stageMemoryPath(projectDir, "code-generation"),
    /\/construction\/code-generation\/memory\.md$/,
  );
  assert.throws(
    () => stageMemoryPath(projectDir, "code-generation", "../api"),
    /safe path segment/,
  );
  assert.match(
    stageMemoryPath(projectDir, "code-generation", "payments"),
    /\/construction\/payments\/code-generation\/memory\.md$/,
  );
});
