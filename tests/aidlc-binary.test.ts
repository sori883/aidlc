import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import type { BinaryBuildReport } from "../scripts/build-binaries.ts";

const ROOT = resolve(import.meta.dir, "..");
const NATIVE_DIR = resolve(ROOT, "build/binaries/native");
const EXECUTABLE = resolve(
  NATIVE_DIR,
  process.platform === "win32" ? "aidlc.exe" : "aidlc",
);

test("builds and smoke-gates a Harness-neutral project-local native binary", () => {
  const build = spawnSync(process.execPath, ["scripts/build-binaries.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  assert.equal(existsSync(EXECUTABLE), true);
  assert.equal(statSync(EXECUTABLE).size > 10 * 1024 * 1024, true);

  const report = JSON.parse(
    readFileSync(resolve(NATIVE_DIR, "build-report.json"), "utf8"),
  ) as BinaryBuildReport;
  assert.equal(report.target, "native");
  assert.equal(report.version, "0.6.0");
  assert.equal(report.runtime_smoke, true);
  assert.equal(report.gates.length, 15);
  assert.equal(report.gates.every((gate) => gate.ok), true);

  const project = resolve(NATIVE_DIR, "project-layout");
  const runtime = resolve(project, ".aidlc/runtime/core");
  assert.equal(existsSync(resolve(runtime, "aidlc-common/data/stage-graph.json")), true);
  assert.equal(existsSync(resolve(project, ".agents/skills/aidlc/SKILL.md")), true);
  const skill = readFileSync(resolve(project, ".agents/skills/aidlc/SKILL.md"), "utf8");
  assert.match(skill, /`\.\/\.aidlc\/bin\/aidlc workspace init \.`/);
  assert.doesNotMatch(skill, /bun run --cwd \.codex aidlc/);
  const hooks = readFileSync(resolve(project, ".codex/hooks.json"), "utf8");
  assert.match(hooks, /\.aidlc\/bin\/aidlc hook sensor-fire/);
  assert.doesNotMatch(hooks, /sensor-hook/);
  assert.doesNotMatch(hooks, /git rev-parse/);

  const installedExecutable = resolve(
    project,
    ".aidlc/bin",
    process.platform === "win32" ? "aidlc.exe" : "aidlc",
  );
  mkdirSync(resolve(project, ".aidlc/bin"), { recursive: true });
  cpSync(EXECUTABLE, installedExecutable);

  const pathless = spawnSync(installedExecutable, ["graph", "compile", "--check"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(pathless.status, 0, `${pathless.stdout}\n${pathless.stderr}`);
  assert.match(pathless.stdout, /32 stages/);
});
