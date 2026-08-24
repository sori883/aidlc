import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeIntent,
  birthIntentWithState,
  readIntentRegistry,
  slugify,
  switchIntent,
} from "../core/tools/aidlc-intent.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function project(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-intent-"));
  initializeWorkspace(projectDir);
  return projectDir;
}

test("birth creates and selects a vNext Intent without Scope or work type", () => {
  const projectDir = project();
  const born = birthIntentWithState(projectDir, "Payment API", "default", ["app"]);
  assert.equal(born.slug, "payment-api");
  assert.match(born.dirName, /^\d{6}-payment-api$/);
  assert.equal(activeIntent(projectDir), born.dirName);
  assert.equal(born.state.workflow, "vnext");
  assert.equal(born.state.current_stage, "ST-00");
  assert.equal(born.plan.stage_decisions.length, 10);
  assert.deepEqual(JSON.parse(readFileSync(born.designBriefPath, "utf8")), {
    schema_version: 1,
    artifact: "design-brief",
    version: 1,
    intent_id: born.uuid,
    statement: "Payment API",
    created_at: born.state.created_at,
  });
  assert.deepEqual(readIntentRegistry(projectDir), [{
    uuid: born.uuid,
    slug: "payment-api",
    dirName: born.dirName,
    repos: ["app"],
    status: "in-flight",
  }]);
  assert.doesNotMatch(
    readFileSync(join(born.recordDir, "aidlc-state.json"), "utf8"),
    /scope|work_type|enterprise|lightweight/,
  );
});

test("duplicate labels remain distinct and require an exact switch", () => {
  const projectDir = project();
  const first = birthIntentWithState(projectDir, "Payment API");
  const second = birthIntentWithState(projectDir, "Payment API");
  assert.equal(second.dirName, `${first.dirName}-2`);
  assert.throws(() => switchIntent(projectDir, "payment-api"), /Ambiguous intent/);
  assert.equal(switchIntent(projectDir, first.dirName).dirName, first.dirName);
});

test("switches by a unique slug and rejects unknown or reserved names", () => {
  const projectDir = project();
  const payment = birthIntentWithState(projectDir, "Payment API");
  birthIntentWithState(projectDir, "Admin Screen");
  assert.equal(switchIntent(projectDir, "payment-api").dirName, payment.dirName);
  assert.throws(() => switchIntent(projectDir, "missing"), /Unknown intent/);
  assert.throws(() => birthIntentWithState(projectDir, "switch"), /reserved name/);
  assert.throws(
    () => birthIntentWithState(projectDir, "  padded brief  "),
    /single-line Design Brief/,
  );
});

test("slugify keeps stable safe names", () => {
  assert.equal(slugify("  123 Payment API  "), "intent-123-payment-api");
  assert.equal(slugify("---"), "intent");
  assert.equal(slugify("A".repeat(30), 24), "a".repeat(24));
});
