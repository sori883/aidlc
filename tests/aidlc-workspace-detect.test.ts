import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  detectWorkspace,
  parseGitmodules,
} from "../core/tools/aidlc-workspace-detect.ts";

test("detects an empty workspace as Greenfield", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-detect-"));
  assert.deepEqual(detectWorkspace(projectDir), {
    projectType: "Greenfield",
    languages: "Unknown",
    frameworks: "Unknown",
    buildSystem: "Unknown",
    submodules: [],
  });
});

test("detects TypeScript, React, Vite, and pnpm", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-detect-"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src", "main.tsx"), "export {};\n", "utf8");
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ dependencies: { react: "latest" } }),
    "utf8",
  );
  writeFileSync(join(projectDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(join(projectDir, "vite.config.ts"), "export default {};\n", "utf8");

  assert.deepEqual(detectWorkspace(projectDir), {
    projectType: "Brownfield",
    languages: "TypeScript",
    frameworks: "Vite, React",
    buildSystem: "pnpm (package.json)",
    submodules: [],
  });
});

test("detects a project nested under an arbitrary top-level directory", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-detect-"));
  mkdirSync(join(projectDir, "services", "api"), { recursive: true });
  writeFileSync(join(projectDir, "services", "api", "main.py"), "print('ok')\n", "utf8");

  assert.deepEqual(detectWorkspace(projectDir), {
    projectType: "Brownfield",
    languages: "Python",
    frameworks: "Unknown",
    buildSystem: "Unknown",
    nestedRoot: "services",
    submodules: [],
  });
});

test("parses safe submodules and uses them as a Brownfield signal", () => {
  const content = [
    '[submodule "app"]',
    "  path = packages/app",
    "  url = https://example.com/app.git",
    '[submodule "unsafe"]',
    "  path = ../outside",
    "  url = https://example.com/outside.git",
    "",
  ].join("\n");
  assert.deepEqual(parseGitmodules(content), [
    {
      name: "app",
      path: "packages/app",
      url: "https://example.com/app.git",
    },
  ]);

  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-detect-"));
  writeFileSync(join(projectDir, ".gitmodules"), content, "utf8");
  assert.deepEqual(detectWorkspace(projectDir), {
    projectType: "Brownfield",
    languages: "Unknown",
    frameworks: "Unknown",
    buildSystem: "Unknown",
    submodules: [
      {
        name: "app",
        path: "packages/app",
        url: "https://example.com/app.git",
        initialized: false,
      },
    ],
  });
});
