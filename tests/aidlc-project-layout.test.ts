import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  installedBinaryCommand,
  projectLayoutFiles,
  PROJECT_LAYOUT_MANIFEST,
} from "../core/tools/aidlc-project-layout.ts";

test("renders a vNext-only native Codex project layout", () => {
  const files = projectLayoutFiles({ platform: "darwin" });
  assert.equal(files.has(".codex/aidlc-common/data/vnext-stage-catalog.json"), true);
  assert.equal(files.has(".codex/aidlc-common/data/vnext-stage-graph.json"), true);
  assert.equal(files.has(".agents/skills/aidlc/SKILL.md"), true);
  assert.equal(files.has("AGENTS.md"), true);
  assert.equal(files.has(PROJECT_LAYOUT_MANIFEST), true);

  for (const obsolete of [
    ".codex/aidlc-common/data/scope-grid.json",
    ".codex/aidlc-common/data/stage-catalog.json",
    ".codex/aidlc-common/data/stage-graph.json",
    ".codex/scopes/aidlc-poc.md",
    ".codex/aidlc-common/stages/initialization/state-init.md",
  ]) assert.equal(files.has(obsolete), false, obsolete);

  const allText = [...files.values()].join("\n");
  assert.doesNotMatch(allText, /bun run --cwd \.codex aidlc/);
  assert.doesNotMatch(allText, /--scope|scope-grid/);
  assert.match(allText, /\.\/\.codex\/tools\/aidlc/);
  assert.match(files.get(".agents/skills/aidlc/SKILL.md") ?? "", /next Stage itself/);
});

test("renders the same project-local native command on all platforms", () => {
  assert.equal(installedBinaryCommand("darwin"), "./.codex/tools/aidlc");
  assert.equal(installedBinaryCommand("linux"), "./.codex/tools/aidlc");
  assert.equal(installedBinaryCommand("win32"), "./.codex/tools/aidlc");
  assert.equal(
    projectLayoutFiles({ platform: "win32" }).get(".codex/hooks.json"),
    "{\n  \"hooks\": {}\n}\n",
  );
});
