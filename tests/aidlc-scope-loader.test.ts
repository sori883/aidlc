import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadScopes,
  validateScopeGridDefinitions,
  validateStageScopeReferences,
} from "../core/tools/aidlc-scope-loader.ts";
import { loadStages } from "../core/tools/aidlc-stage-loader.ts";
import { compileStageGraph } from "../core/tools/aidlc-graph.ts";

function scopeMarkdown(name: string, keyword: string): string {
  return `---
name: ${name}
depth: Minimal
keywords:
  - ${keyword}
description: ${name} scope
skeleton: off
---

# ${name} scope

Scope instructions.
`;
}

test("loads all real scope definitions", () => {
  const scopes = loadScopes();
  assert.equal(scopes.length, 9);
  const workshop = scopes.find((scope) => scope.name === "workshop");
  assert.ok(workshop);
  assert.equal(workshop.depth, "Standard");
  assert.equal(workshop.testStrategy, "Minimal");
  assert.equal(workshop.skeleton, true);
});

test("validates every stage scope reference", () => {
  assert.doesNotThrow(() =>
    validateStageScopeReferences(loadStages(), loadScopes())
  );
});

test("validates scope definitions against the generated grid", () => {
  const result = compileStageGraph();
  assert.doesNotThrow(() =>
    validateScopeGridDefinitions(result.scopeGrid, loadScopes())
  );
  assert.deepEqual(Object.keys(result.scopeGrid).sort(), [
    "bugfix",
    "enterprise",
    "feature",
    "infra",
    "mvp",
    "poc",
    "refactor",
    "security-patch",
    "workshop",
  ]);
});

test("rejects an unknown stage scope", () => {
  const stages = loadStages();
  const first = stages[0];
  assert.ok(first);
  const changed = [{ ...first, scopes: [...first.scopes, "unknown"] }];
  assert.throws(
    () => validateStageScopeReferences(changed, loadScopes()),
    /unknown scopes\[9\] "unknown"/,
  );
});

test("rejects a keyword assigned to multiple scopes", () => {
  const scopesDir = mkdtempSync(join(tmpdir(), "aidlc-scopes-"));
  writeFileSync(join(scopesDir, "aidlc-first.md"), scopeMarkdown("first", "same"));
  writeFileSync(join(scopesDir, "aidlc-second.md"), scopeMarkdown("second", "same"));
  assert.throws(
    () => loadScopes(scopesDir),
    /keyword "same" is already assigned to scope "first"/,
  );
});
