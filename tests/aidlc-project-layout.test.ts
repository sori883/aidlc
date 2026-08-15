import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  installedBinaryCommand,
  projectLayoutFiles,
  PROJECT_LAYOUT_MANIFEST,
} from "../core/tools/aidlc-project-layout.ts";

test("splits Core Runtime and Codex Harness into the project-local layout", () => {
  const files = projectLayoutFiles({ platform: "darwin" });
  assert.equal(files.has(".aidlc/runtime/core/aidlc-common/data/stage-graph.json"), true);
  assert.equal(files.has(".aidlc/runtime/core/agents/aidlc-product-agent.md"), true);
  assert.equal(files.has(".codex/agents/aidlc-product-agent.toml"), true);
  assert.equal(files.has(".agents/skills/aidlc/SKILL.md"), true);
  assert.equal(files.has("AGENTS.md"), true);
  assert.equal(files.has(PROJECT_LAYOUT_MANIFEST), true);

  assert.equal(files.has(".codex/package.json"), false);
  assert.equal(files.has(".codex/bun.lock"), false);
  assert.equal(files.has(".codex/tools/aidlc.ts"), false);
  assert.equal(files.has(".aidlc/runtime/core/tools/aidlc.ts"), false);
  assert.equal(files.has(".aidlc/runtime/core/tools/contracts/aidlc-graph.json"), true);
  assert.equal(files.has(".codex/agents/aidlc-product-agent.md"), false);

  const allText = [...files.values()].join("\n");
  assert.doesNotMatch(allText, /bun run --cwd \.codex aidlc/);
  assert.doesNotMatch(allText, /git rev-parse/);
  assert.doesNotMatch(allText, /--project-dir \.\./);
  assert.match(allText, /\.\/\.aidlc\/bin\/aidlc/);
  const mainSkill = files.get(".agents/skills/aidlc/SKILL.md") ?? "";
  const installedGuidance = `${files.get("AGENTS.md") ?? ""}\n${mainSkill}`;
  assert.doesNotMatch(installedGuidance, /bun install|node_modules/);
  assert.match(mainSkill, /workspace init \.`/);
  assert.match(mainSkill, /Codex custom Agent type from\n`\.codex\/agents\/<role>\.toml`/);
  assert.match(mainSkill, /read\n`\.aidlc\/runtime\/core\/agents\/<role>\.md`/);
});

test("renders the project-local native command for Unix and Windows", () => {
  assert.equal(installedBinaryCommand("darwin"), "./.aidlc/bin/aidlc");
  assert.equal(installedBinaryCommand("linux"), "./.aidlc/bin/aidlc");
  assert.equal(installedBinaryCommand("win32"), "./.aidlc/bin/aidlc");

  const windows = projectLayoutFiles({ platform: "win32" });
  const skill = windows.get(".agents/skills/aidlc/SKILL.md") ?? "";
  assert.match(skill, /\.\/\.aidlc\/bin\/aidlc workspace init/);
  const hooks = windows.get(".codex/hooks.json") ?? "";
  assert.match(hooks, /\.aidlc\/bin\/aidlc\.exe/);
});
