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
    ".codex/tools/aidlc-vnext-risk-contract.ts",
    ".codex/tools/aidlc-vnext-risk.ts",
    ".codex/tools/aidlc-vnext-policy-gates.ts",
    ".codex/tools/aidlc-vnext-bootstrap.ts",
    ".codex/tools/aidlc-vnext-define-intent-contract.ts",
    ".codex/tools/aidlc-vnext-define-intent.ts",
    ".codex/tools/aidlc-vnext-orient-contract.ts",
    ".codex/tools/aidlc-vnext-orient.ts",
    ".codex/tools/aidlc-vnext-requirements-contract.ts",
    ".codex/tools/aidlc-vnext-requirements.ts",
    ".codex/tools/aidlc-vnext-architecture-contract.ts",
    ".codex/tools/aidlc-vnext-architecture.ts",
    ".codex/tools/aidlc-vnext-build-contract-contract.ts",
    ".codex/tools/aidlc-vnext-build-contract.ts",
    ".codex/tools/aidlc-vnext-outcome-contract.ts",
    ".codex/tools/aidlc-vnext-outcome.ts",
    ".codex/tools/aidlc-vnext-state.ts",
    ".codex/aidlc-common/data/vnext-stage-catalog.json",
    ".codex/aidlc-common/data/vnext-stage-graph.json",
    ".codex/aidlc-common/stages/st-00-bootstrap.json",
    ".codex/aidlc-common/stages/st-01-orient.json",
    ".codex/aidlc-common/stages/st-02-define-intent.json",
    ".codex/aidlc-common/stages/st-03-requirements-constraints.json",
    ".codex/aidlc-common/stages/st-04-architecture-decision.json",
    ".codex/aidlc-common/stages/st-05-build-contract.json",
    ".codex/aidlc-common/stages/st-09-outcome-evaluation.json",
    ".codex/memory/org-policy.json",
    ".codex/memory/team-policy.json",
    ".codex/memory/project-policy.json",
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
  assert.doesNotMatch(files, /scope-grid|aidlc-scope-loader/);
  assert.match(
    readFileSync(join(outDir, ".agents/skills/aidlc/SKILL.md"), "utf8"),
    /never chooses the next Stage itself/,
  );
  assert.match(
    readFileSync(join(outDir, ".agents/skills/aidlc/SKILL.md"), "utf8"),
    /aidlc next \.\./,
  );
  assert.doesNotMatch(
    readFileSync(join(outDir, ".agents/skills/aidlc/SKILL.md"), "utf8"),
    /aidlc next \.`/,
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

test("generated Codex runtime completes ST-00 and prepares ST-01 work", () => {
  const outDir = freshBundleDir();
  writeCodexBundle({ outDir });
  run(outDir, ["run", "--cwd", ".codex", "aidlc", "workspace", "init", ".."]);
  run(outDir, [
    "run", "--cwd", ".codex", "aidlc", "intent", "birth", "..", "Bundle Smoke",
  ]);
  const risk = JSON.parse(run(outDir, [
    "run", "--cwd", ".codex", "aidlc", "intent", "risk", "show", "..",
  ])) as { register: { revision: number; risks: unknown[] } };
  assert.equal(risk.register.revision, 1);
  assert.deepEqual(risk.register.risks, []);
  const advanced = JSON.parse(run(outDir, [
    "run", "--cwd", ".codex", "aidlc", "next", "..",
  ])) as { kind: string; workflow: string; stage: string; decision_authority: string };
  assert.equal(advanced.kind, "advanced");
  assert.equal(advanced.stage, "ST-01");
  assert.equal(advanced.decision_authority, "core");
  const work = JSON.parse(run(outDir, [
    "run", "--cwd", ".codex", "aidlc", "next", "..",
  ])) as { kind: string; stage: string; request: { artifact: string } };
  assert.equal(work.kind, "work");
  assert.equal(work.stage, "ST-01");
  assert.equal(work.request.artifact, "orient-work-request");
  const doctor = JSON.parse(run(outDir, [
    "run", "--cwd", ".codex", "aidlc", "doctor", "check", "..",
  ])) as { healthy: boolean };
  assert.equal(doctor.healthy, true);
});
