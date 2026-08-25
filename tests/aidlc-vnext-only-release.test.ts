import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import { CODEX_HARNESS } from "../harness/codex/aidlc-harness.ts";

const root = resolve(import.meta.dir, "..");

function treeHasFiles(path: string): boolean {
  if (!existsSync(path)) return false;
  if (statSync(path).isFile()) return true;
  return readdirSync(path, { withFileTypes: true }).some((entry) =>
    entry.isFile() || (entry.isDirectory() && treeHasFiles(join(path, entry.name)))
  );
}

test("M7 source tree contains no retired v2 Workflow island", () => {
  const retired = [
    "core/tools/aidlc-graph.ts",
    "core/tools/aidlc-scope-loader.ts",
    "core/tools/aidlc-state.ts",
    "core/tools/aidlc-doctor.ts",
    "core/tools/aidlc-orchestrate.ts",
    "core/tools/aidlc-executor.ts",
    "core/tools/aidlc-stage-loader.ts",
    "core/tools/aidlc-sensor.ts",
    "core/tools/aidlc-worktree.ts",
    "core/tools/aidlc-unit-graph.ts",
    "core/tools/contracts",
    "core/tools/data",
    "core/agents",
    "core/knowledge",
    "core/sensors",
    "core/hooks",
    "harness/codex/hooks/aidlc-sensor-fire.ts",
  ];
  for (const path of retired) {
    const absolute = join(root, path);
    assert.equal(treeHasFiles(absolute), false, `retired path remains: ${path}`);
  }
  const retiredDocs = readdirSync(join(root, "docs"))
    .filter((name) => name.startsWith("aidlc-v2-"));
  assert.deepEqual(retiredDocs, []);
});

test("M7 release identity and user documentation are vNext-only", () => {
  assert.equal(AIDLC_VERSION, "1.0.0");
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(packageJson.dependencies?.yaml, undefined);
  assert.equal(CODEX_HARNESS.capabilities.postWriteHook, false);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /^# AI-DLC vNext for Codex/m);
  assert.doesNotMatch(readme, /32 stages|32 Stage|Scopeの選び方|AI-DLC v2/);
  assert.equal(existsSync(join(root, "docs", "aidlc-vnext-1.0.0-release-notes.md")), true);
});
