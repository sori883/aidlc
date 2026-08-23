import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "bun:test";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import {
  appendStageMemoryEntry,
  ensureStageMemory,
  parseStageMemory,
  readStageMemory,
  STAGE_MEMORY_TEMPLATE,
} from "../core/tools/aidlc-memory.ts";
import { activeIntentRecordDir } from "../core/tools/aidlc-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function freshProject(): { projectDir: string; recordDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-memory-"));
  initializeWorkspace(projectDir);
  birthIntentWithState(projectDir, "Payment API", "default");
  return { projectDir, recordDir: activeIntentRecordDir(projectDir) };
}

test("creates standard and per-Unit Stage memory under the active Intent", () => {
  const { projectDir, recordDir } = freshProject();
  const standard = relative(
    projectDir,
    join(recordDir, "ideation", "intent-capture", "memory.md"),
  );
  const perUnit = relative(
    projectDir,
    join(recordDir, "construction", "payments", "code-generation", "memory.md"),
  );

  const first = ensureStageMemory(projectDir, standard);
  const unit = ensureStageMemory(projectDir, perUnit);

  assert.equal(first.created, true);
  assert.equal(unit.created, true);
  assert.equal(readFileSync(first.path, "utf8"), STAGE_MEMORY_TEMPLATE);
  assert.equal(readFileSync(unit.path, "utf8"), STAGE_MEMORY_TEMPLATE);
  assert.ok(first.path.startsWith(recordDir));
  assert.ok(unit.path.startsWith(recordDir));
});

test("appends and deterministically parses the four Memory sections", () => {
  const { projectDir, recordDir } = freshProject();
  const memoryPath = relative(
    projectDir,
    join(recordDir, "ideation", "intent-capture", "memory.md"),
  );
  const entries = [
    ["Interpretations", "Interpreted scope", "The request was ambiguous"],
    ["Deviations", "Skipped optional scan", "No repository was present"],
    ["Tradeoffs", "Kept the API small", "Reduced the first release risk"],
    ["Open Questions", "Confirm retention", "Ask before the next run"],
  ] as const;

  for (const [heading, summary, context] of entries) {
    appendStageMemoryEntry(projectDir, memoryPath, {
      heading,
      summary,
      context,
      timestamp: "2026-08-06T01:02:03.000Z",
    });
  }
  const parsed = readStageMemory(projectDir, memoryPath);

  assert.deepEqual(
    parsed.entries.map((entry) => [entry.heading, entry.summary, entry.context]),
    entries,
  );
});

test("initialization is idempotent and never overwrites existing Memory", () => {
  const { projectDir, recordDir } = freshProject();
  const memoryPath = relative(
    projectDir,
    join(recordDir, "ideation", "intent-capture", "memory.md"),
  );
  const initialized = ensureStageMemory(projectDir, memoryPath);
  appendStageMemoryEntry(projectDir, memoryPath, {
    heading: "Tradeoffs",
    summary: "Preserve this entry",
    context: "A resumed Stage needs its prior diary",
    timestamp: "2026-08-06T01:02:03Z",
  });
  const before = readFileSync(initialized.path, "utf8");

  const repeated = ensureStageMemory(projectDir, memoryPath);

  assert.equal(repeated.created, false);
  assert.equal(readFileSync(initialized.path, "utf8"), before);
});

test("rejects malformed entries and paths outside the active Intent", () => {
  const { projectDir, recordDir } = freshProject();
  assert.throws(
    () => ensureStageMemory(projectDir, "aidlc/spaces/default/memory.md"),
    /inside the active Intent/,
  );
  assert.throws(
    () => parseStageMemory(
      STAGE_MEMORY_TEMPLATE.replace(
        "## Interpretations\n",
        "## Interpretations\n\n- yesterday — unclear\n",
      ),
      "memory.md",
    ),
    /expected - <ISO timestamp>/,
  );
  const path = join(recordDir, "ideation", "intent-capture", "memory.md");
  ensureStageMemory(projectDir, relative(projectDir, path));
  writeFileSync(path, "# Stage Memory\n\n## Interpretations\n", "utf8");
  assert.throws(
    () => readStageMemory(projectDir, relative(projectDir, path)),
    /missing Stage memory heading/,
  );
  assert.equal(existsSync(path), true);
});
