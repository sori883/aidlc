import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
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
  assert.equal(report.version, AIDLC_VERSION);
  assert.equal(report.runtime_smoke, true);
  assert.equal(report.gates.length, 14);
  assert.equal(report.gates.every((gate) => gate.ok), true);

  const project = resolve(NATIVE_DIR, "project-layout");
  const runtime = resolve(project, ".codex");
  assert.equal(existsSync(resolve(runtime, "aidlc-common/data/vnext-stage-graph.json")), true);
  assert.equal(existsSync(resolve(runtime, "memory/project-policy.json")), true);
  assert.equal(existsSync(resolve(project, ".agents/skills/aidlc/SKILL.md")), true);
  assert.equal(existsSync(resolve(project, ".agents/skills/aidlc-stage-work/SKILL.md")), true);
  assert.equal(existsSync(resolve(runtime, "agents/aidlc-developer-agent.md")), true);
  assert.equal(existsSync(resolve(runtime, "agents/aidlc-developer-agent.toml")), true);
  const skill = readFileSync(resolve(project, ".agents/skills/aidlc/SKILL.md"), "utf8");
  assert.match(skill, /`\.\/\.codex\/tools\/aidlc workspace init \.`/);
  assert.doesNotMatch(skill, /bun run --cwd \.codex aidlc/);
  const hooks = readFileSync(resolve(project, ".codex/hooks.json"), "utf8");
  assert.deepEqual(JSON.parse(hooks), { hooks: {} });

  const installedExecutable = resolve(
    project,
    ".codex/tools",
    process.platform === "win32" ? "aidlc.exe" : "aidlc",
  );
  mkdirSync(resolve(project, ".codex/tools"), { recursive: true });
  cpSync(EXECUTABLE, installedExecutable);

  const pathless = spawnSync(installedExecutable, ["graph", "validate"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(pathless.status, 0, `${pathless.stdout}\n${pathless.stderr}`);
  assert.deepEqual(JSON.parse(pathless.stdout), {
    valid: true,
    workflow: "vnext",
    catalog_version: "vnext-stage-catalog-v1",
    graph_version: "vnext-10-stage-graph-v1",
  });
  const delegation = spawnSync(installedExecutable, ["delegation", "show", "ST-06", "work"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(delegation.status, 0, `${delegation.stdout}\n${delegation.stderr}`);
  assert.equal(JSON.parse(delegation.stdout).lead_agent, "aidlc-developer-agent");
  const workspace = spawnSync(installedExecutable, ["workspace", "init", "."], { cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(workspace.status, 0, workspace.stderr);
  const risksPath = resolve(project, "known-risks.json");
  writeFileSync(risksPath, `${JSON.stringify([{ risk_id: "native-smoke", severity: "medium", statement: "Native配布のRisk導線を確認する。", evidence_refs: [] }], null, 2)}\n`);
  const birth = spawnSync(installedExecutable, ["intent", "birth", ".", "Native Smoke", "--risk-file", risksPath], { cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(birth.status, 0, `${birth.stdout}\n${birth.stderr}`);
  const risk = spawnSync(installedExecutable, ["intent", "risk", "show", "."], { cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(risk.status, 0, `${risk.stdout}\n${risk.stderr}`);
  assert.equal((JSON.parse(risk.stdout) as { register: { risks: unknown[] } }).register.risks.length, 1);
  const doctor = spawnSync(installedExecutable, ["doctor", "check", "."], { cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
});
