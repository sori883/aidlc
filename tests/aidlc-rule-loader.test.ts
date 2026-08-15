import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  loadRules,
  resolveRulesForStage,
} from "../core/tools/aidlc-rule-loader.ts";
import { loadStages } from "../core/tools/aidlc-stage-loader.ts";

test("loads rules in strict-additive precedence order", () => {
  const rules = loadRules();
  assert.equal(rules.length, 7);
  assert.deepEqual(
    rules.map((rule) => [rule.scope, rule.phase, rule.path]),
    [
      ["org", undefined, "aidlc/spaces/default/memory/org.md"],
      ["team", undefined, "aidlc/spaces/default/memory/team.md"],
      ["project", undefined, "aidlc/spaces/default/memory/project.md"],
      ["phase", "construction", "aidlc/spaces/default/memory/phases/construction.md"],
      ["phase", "ideation", "aidlc/spaces/default/memory/phases/ideation.md"],
      ["phase", "inception", "aidlc/spaces/default/memory/phases/inception.md"],
      ["phase", "operation", "aidlc/spaces/default/memory/phases/operation.md"],
    ],
  );
});

test("resolves three base rules for initialization", () => {
  const stage = loadStages().find((entry) => entry.slug === "state-init");
  assert.ok(stage);
  assert.deepEqual(resolveRulesForStage(stage, loadRules()), [
    { path: "aidlc/spaces/default/memory/org.md", scope: "org" },
    { path: "aidlc/spaces/default/memory/team.md", scope: "team" },
    { path: "aidlc/spaces/default/memory/project.md", scope: "project" },
  ]);
});

test("adds the matching phase rule after base rules", () => {
  const stage = loadStages().find((entry) => entry.slug === "code-generation");
  assert.ok(stage);
  assert.deepEqual(resolveRulesForStage(stage, loadRules()).at(-1), {
    path: "aidlc/spaces/default/memory/phases/construction.md",
    scope: "phase",
  });
});

test("parses rule headings while excluding comments", () => {
  const org = loadRules().find((rule) => rule.scope === "org");
  assert.ok(org);
  assert.ok(org.headings.get("Way of Working")?.includes("trunk-based"));
  assert.equal(org.headings.get("Forbidden"), "");
});

test("rejects invalid optional pairing frontmatter", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "aidlc-memory-"));
  writeFileSync(
    join(memoryDir, "org.md"),
    "---\npairing: invalid\n---\n\n# Rules\n",
  );
  assert.throws(
    () => loadRules(memoryDir),
    /pairing must be "feedforward-only" or start with "aidlc-"/,
  );
});
