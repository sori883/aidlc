import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activeIntent,
  birthIntent,
  switchIntent,
  slugify,
} from "../core/tools/aidlc-intent.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

test("births and selects an upstream-compatible intent record", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-intent-"));
  initializeWorkspace(projectDir);

  const born = birthIntent(
    projectDir,
    "Payment API",
    "default",
    "mvp",
    ["app"],
  );
  const intentsRoot = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "intents",
  );

  assert.equal(born.slug, "payment-api");
  assert.match(born.dirName, /^\d{6}-payment-api$/);
  assert.match(
    born.uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    readFileSync(join(intentsRoot, "active-intent"), "utf8"),
    `${born.dirName}\n`,
  );
  assert.equal(activeIntent(projectDir), born.dirName);
  assert.equal(
    readFileSync(join(born.recordDir, "aidlc-state.md"), "utf8"),
    "# AI-DLC State Tracking\n",
  );
  assert.equal(existsSync(join(born.recordDir, ".aidlc-plan.json")), false);

  const registry = JSON.parse(
    readFileSync(join(intentsRoot, "intents.json"), "utf8"),
  ) as unknown;
  assert.deepEqual(registry, [
    {
      uuid: born.uuid,
      slug: "payment-api",
      dirName: born.dirName,
      scope: "mvp",
      repos: ["app"],
      status: "in-flight",
    },
  ]);
});

test("same-day duplicate labels receive a numeric directory suffix", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-intent-"));
  initializeWorkspace(projectDir);

  const first = birthIntent(projectDir, "Payment API");
  const second = birthIntent(projectDir, "Payment API");

  assert.equal(second.dirName, `${first.dirName}-2`);
  assert.notEqual(second.uuid, first.uuid);
  assert.equal(activeIntent(projectDir), second.dirName);
  const registry = JSON.parse(
    readFileSync(
      join(
        projectDir,
        "aidlc",
        "spaces",
        "default",
        "intents",
        "intents.json",
      ),
      "utf8",
    ),
  ) as unknown[];
  assert.equal(registry.length, 2);
  assert.throws(
    () => switchIntent(projectDir, "payment-api"),
    /Ambiguous intent/,
  );
  assert.equal(switchIntent(projectDir, first.dirName).dirName, first.dirName);
  assert.equal(activeIntent(projectDir), first.dirName);
});

test("switches an intent by its unique slug", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-intent-"));
  initializeWorkspace(projectDir);
  const payment = birthIntent(projectDir, "Payment API");
  birthIntent(projectDir, "Admin Screen");

  const selected = switchIntent(projectDir, "payment-api");

  assert.equal(selected.dirName, payment.dirName);
  assert.equal(selected.active, true);
  assert.equal(activeIntent(projectDir), payment.dirName);
  assert.throws(
    () => switchIntent(projectDir, "missing"),
    /Unknown intent/,
  );
});

test("intent birth rejects reserved names and an absent workspace", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-intent-"));
  initializeWorkspace(projectDir);
  assert.throws(
    () => birthIntent(projectDir, "switch"),
    /reserved name/,
  );

  const missingWorkspace = mkdtempSync(join(tmpdir(), "aidlc-intent-"));
  assert.throws(
    () => birthIntent(missingWorkspace, "Payment API"),
    /Initialize the workspace first/,
  );
});

test("slugify follows the upstream leading-letter and length rules", () => {
  assert.equal(slugify("  123 Payment API  "), "intent-123-payment-api");
  assert.equal(slugify("---"), "intent");
  assert.equal(slugify("A".repeat(30), 24), "a".repeat(24));
});
