import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectProject } from "../core/tools/aidlc-utility.ts";

function brownfieldFixture(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-utility-"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src", "main.ts"), "export {};\n", "utf8");
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ dependencies: { react: "latest" } }),
    "utf8",
  );
  writeFileSync(join(projectDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  return projectDir;
}

test("detectProject returns the upstream scan and resolved Scope registries", () => {
  const projectDir = brownfieldFixture();
  const before = readdirSync(projectDir).sort();
  const result = detectProject(projectDir);

  assert.equal(result.projectType, "Brownfield");
  assert.equal(result.languages, "TypeScript");
  assert.equal(result.frameworks, "React");
  assert.equal(result.buildSystem, "pnpm (package.json)");
  assert.match(result.scopesDir, /\/core\/scopes$/);
  assert.match(result.scopeGridPath, /\/core\/aidlc-common\/data\/scope-grid\.json$/);
  assert.deepEqual(result.scopes, [
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
  assert.deepEqual(readdirSync(projectDir).sort(), before);
});

test("utility detect --json works without an initialized AI-DLC Workspace", () => {
  const projectDir = brownfieldFixture();
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "core/tools/aidlc-utility.ts",
      "detect",
      "--project-dir",
      projectDir,
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.projectType, "Brownfield");
  assert.equal(payload.languages, "TypeScript");
  assert.equal(payload.buildSystem, "pnpm (package.json)");
});
