import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  BINARY_TARGETS,
  buildBinary,
  inspectBinaryFormat,
  type BinaryBuildReport,
} from "../scripts/build-binaries.ts";

const ROOT = resolve(import.meta.dir, "..");

test("declares the upstream-compatible nine-target release matrix", () => {
  assert.deepEqual(BINARY_TARGETS.map(({ name }) => name), [
    "native",
    "darwin-x64",
    "darwin-arm64",
    "linux-x64",
    "linux-arm64",
    "linux-x64-musl",
    "linux-arm64-musl",
    "linux-x64-baseline",
    "windows-x64",
  ]);
  assert.equal(new Set(BINARY_TARGETS.map(({ bunTarget }) => bunTarget)).size, 9);
});

test("cross-compiles every explicit release target and validates its artifact", () => {
  for (const target of BINARY_TARGETS.filter(({ name }) => name !== "native")) {
    const report = buildBinary(target.name);
    assert.equal(report.version, "0.6.1");
    assert.equal(report.target, target.name);
    assert.equal(report.bun_target, target.bunTarget);
    assert.equal(report.bytes > 10 * 1024 * 1024, true);
    assert.equal(inspectBinaryFormat(report.executable), target.format);
    assert.equal(existsSync(report.runtime), true);
    assert.equal(report.gates.every(({ ok }) => ok), true);

    const persisted = JSON.parse(
      readFileSync(resolve(ROOT, "build/binaries", target.name, "build-report.json"), "utf8"),
    ) as BinaryBuildReport;
    assert.equal(persisted.target, target.name);
  }
}, 600_000);
