import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
import { checkVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

test("M6 large fixture start, next, and Doctor finish within hang guards", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-large-fixture-"));
  const sourceDir = join(projectDir, "app", "src");
  const unrelatedDir = join(projectDir, "app", "generated-unrelated");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(unrelatedDir, { recursive: true });
  writeFileSync(join(sourceDir, "target.ts"), "export const target = true;\n");
  for (let index = 0; index < 1_500; index += 1) {
    writeFileSync(join(unrelatedDir, `file-${String(index).padStart(4, "0")}.txt`), "outside intent scope\n");
  }
  initializeWorkspace(projectDir);

  const birthStarted = performance.now();
  birthIntentWithState(projectDir, "target.tsの状態を確認する", "default", ["app"]);
  const birthMs = performance.now() - birthStarted;

  const bootstrapStarted = performance.now();
  const advanced = resolveVNextDirective(projectDir);
  const bootstrapMs = performance.now() - bootstrapStarted;
  assert.equal(advanced.kind, "advanced");

  const orientStarted = performance.now();
  const work = resolveVNextDirective(projectDir);
  const orientMs = performance.now() - orientStarted;
  assert.equal(work.kind, "work");

  const doctorStarted = performance.now();
  const doctor = checkVNextDoctor(projectDir);
  const doctorMs = performance.now() - doctorStarted;
  assert.equal(doctor.healthy, true);

  const metrics = { birth_ms: birthMs, bootstrap_next_ms: bootstrapMs, orient_next_ms: orientMs, doctor_ms: doctorMs, unrelated_files: 1_500 };
  process.stdout.write(`M6_PERFORMANCE ${JSON.stringify(metrics)}\n`);
  assert.equal(Object.values(metrics).every((value) => typeof value === "number" && Number.isFinite(value)), true);
  for (const [name, duration] of Object.entries(metrics).filter(([name]) => name.endsWith("_ms"))) {
    assert.equal((duration as number) < 10_000, true, `${name} exceeded the M6 hang guard: ${duration}`);
  }
}, { timeout: 30_000 });
