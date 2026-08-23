import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCodexBundle,
  CODEX_BUNDLE_MANIFEST,
  codexRuntimeToolScripts,
  transformCodexMarkdown,
  writeCodexBundle,
} from "../core/tools/aidlc-codex-bundle.ts";

function freshBundleDir(): string {
  return join(mkdtempSync(join(tmpdir(), "aidlc-vnext-bundle-")), "bundle");
}

function run(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${process.execPath} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

test("translates Harness-neutral paths without introducing a Scope table", () => {
  const scripts = codexRuntimeToolScripts(JSON.stringify({
    scripts: { graph: "bun tools/aidlc-core-route.ts" },
  }));
  const rendered = transformCodexMarkdown(
    "bun {{HARNESS_DIR}}/tools/aidlc-core-route.ts validate\n{{HARNESS_DIR}}/memory/org.md",
    scripts,
  );
  assert.equal(
    rendered,
    "bun run --cwd .codex aidlc graph validate\n.codex/memory/org.md",
  );
  assert.doesNotMatch(rendered, /scope-grid|\{\{HARNESS_DIR\}\}/);
});

test("writes a vNext-only Codex bundle", () => {
  const outDir = freshBundleDir();
  const result = writeCodexBundle({ outDir });
  assert.equal(checkCodexBundle({ outDir }).valid, true);
  for (const path of [
    "AGENTS.md",
    CODEX_BUNDLE_MANIFEST,
    ".codex/hooks.json",
    ".codex/package.json",
    ".codex/tools/aidlc.ts",
    ".codex/tools/aidlc-core-route.ts",
    ".codex/tools/aidlc-vnext-state.ts",
    ".codex/aidlc-common/data/vnext-stage-catalog.json",
    ".codex/aidlc-common/data/vnext-stage-graph.json",
    ".agents/skills/aidlc/SKILL.md",
  ]) assert.equal(existsSync(join(outDir, path)), true, path);

  for (const obsolete of [
    ".codex/aidlc-common/data/scope-grid.json",
    ".codex/aidlc-common/data/stage-catalog.json",
    ".codex/aidlc-common/data/stage-graph.json",
    ".codex/tools/aidlc-graph.ts",
    ".codex/tools/aidlc-scope-loader.ts",
    ".codex/tools/aidlc-orchestrate.ts",
    ".codex/tools/aidlc-state.ts",
  ]) assert.equal(existsSync(join(outDir, obsolete)), false, obsolete);

  const files = result.files.join("\n");
  assert.doesNotMatch(files, /scope-grid|aidlc-common\/stages|aidlc-scope-loader/);
  assert.match(
    readFileSync(join(outDir, ".agents/skills/aidlc/SKILL.md"), "utf8"),
    /never chooses the next Stage itself/,
  );
});

test("bundle check detects drift and refuses an unmanaged directory", () => {
  const outDir = freshBundleDir();
  writeCodexBundle({ outDir });
  writeFileSync(join(outDir, "AGENTS.md"), "stale\n", "utf8");
  assert.deepEqual(checkCodexBundle({ outDir }).stale, ["AGENTS.md"]);
  writeCodexBundle({ outDir });
  assert.equal(checkCodexBundle({ outDir }).valid, true);

  const unmanaged = freshBundleDir();
  mkdirSync(unmanaged, { recursive: true });
  writeFileSync(join(unmanaged, "keep.txt"), "user data\n", "utf8");
  assert.throws(
    () => writeCodexBundle({ outDir: unmanaged }),
    /Refusing to overwrite non-bundle directory/,
  );
});

test("generated Codex runtime creates an Intent and parks at ST-00", () => {
  const outDir = freshBundleDir();
  writeCodexBundle({ outDir });
  run(outDir, ["run", "--cwd", ".codex", "aidlc", "workspace", "init", ".."]);
  run(outDir, [
    "run", "--cwd", ".codex", "aidlc", "intent", "birth", "..", "Bundle Smoke",
  ]);
  const next = JSON.parse(run(outDir, [
    "run", "--cwd", ".codex", "aidlc", "next", "..",
  ])) as { kind: string; workflow: string; stage: string; decision_authority: string };
  assert.deepEqual(next, {
    schema_version: 1,
    kind: "parked",
    workflow: "vnext",
    stage: "ST-00",
    reason: "ST-00 Stage Contract is not implemented until M3.",
    graph_version: "vnext-10-stage-graph-v1",
    plan_revision: 1,
    decision_authority: "core",
  });
  const doctor = JSON.parse(run(outDir, [
    "run", "--cwd", ".codex", "aidlc", "doctor", "check", "..",
  ])) as { healthy: boolean };
  assert.equal(doctor.healthy, true);
});
