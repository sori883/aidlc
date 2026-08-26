import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const skill = readFileSync(
  join(root, "harness", "codex", "skills", "aidlc", "SKILL.md"),
  "utf8",
);
const instructions = readFileSync(
  join(root, "harness", "codex", "AGENTS.md"),
  "utf8",
);

test("requires delegated execution for every Core work Directive", () => {
  assert.match(skill, /vnext-stage-delegation\.json/);
  assert.match(skill, /For every `work`\s+Directive.*must delegate/is);
  assert.match(skill, /must not create or\s+edit the Stage proposal inline/i);
  assert.match(skill, /matching Codex custom Agent/i);
  assert.match(skill, /\.codex\/agents\/<agent-name>\.toml/);
  assert.match(skill, /aidlc-stage-work/);
  assert.match(skill, /Do not fall back to inline Stage work/i);
});

test("defines topology, review, and parent-only submission boundaries", () => {
  assert.match(skill, /`subagent`:/);
  assert.match(skill, /`pipeline`:/);
  assert.match(skill, /`mob`:/);
  assert.match(skill, /reviewer_max_iterations/);
  assert.match(skill, /Only the Conductor runs the Core submission command/i);
  assert.match(skill, /review_assignment/);
  assert.match(skill, /advisory.*human decision/is);
  assert.match(skill, /subagents must never run.*aidlc next/is);
});

test("project instructions preserve Core authority and mandatory delegation", () => {
  assert.match(instructions, /Stage Delegation/i);
  assert.match(instructions, /must delegate/i);
  assert.match(instructions, /Core owns/i);
  assert.match(instructions, /must not replace a missing Agent with inline\s+work/i);
});
