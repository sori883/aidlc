import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadAgents } from "../core/tools/aidlc-agent-loader.ts";
import {
  checkCodexBundle,
  CODEX_BUNDLE_MANIFEST,
  writeCodexBundle,
} from "../core/tools/aidlc-codex-bundle.ts";

function freshBundleDir(): string {
  return join(mkdtempSync(join(tmpdir(), "aidlc-codex-bundle-")), "bundle");
}

function run(
  cwd: string,
  command: string,
  args: string[],
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

test("writes a complete Codex bundle with local tsx and yaml runtime", () => {
  const outDir = freshBundleDir();
  const result = writeCodexBundle({ outDir });
  assert.equal(result.files.length > 100, true);
  assert.equal(checkCodexBundle({ outDir }).valid, true);
  for (const path of [
    "AGENTS.md",
    CODEX_BUNDLE_MANIFEST,
    ".codex/hooks.json",
    ".codex/package.json",
    ".codex/pnpm-lock.yaml",
    ".codex/pnpm-workspace.yaml",
    ".codex/tools/aidlc-orchestrate.ts",
    ".codex/hooks/aidlc-sensor-core.ts",
    ".codex/hooks/aidlc-sensor-fire.ts",
    ".codex/aidlc-common/data/stage-graph.json",
    ".agents/skills/aidlc/SKILL.md",
  ]) {
    assert.equal(existsSync(join(outDir, path)), true, path);
  }
  const runtime = JSON.parse(
    readFileSync(join(outDir, ".codex", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  assert.deepEqual(runtime.dependencies, { tsx: "4.23.1", yaml: "2.9.0" });
  const hook = readFileSync(
    join(outDir, ".codex", "hooks", "aidlc-sensor-fire.ts"),
    "utf8",
  );
  assert.match(hook, /from "\.\/aidlc-sensor-core\.ts"/);
  assert.doesNotMatch(hook, /\.\.\/\.\.\/\.\.\/core/);

  const agents = loadAgents();
  for (const agent of agents) {
    const source = readFileSync(
      join(outDir, ".codex", "agents", `${agent.name}.toml`),
      "utf8",
    );
    assert.match(source, new RegExp(`^name = "${agent.name}"$`, "m"));
    assert.match(source, /^description = ".+"$/m);
    assert.match(source, /^developer_instructions = ".+"$/m);
    assert.match(source, /Do not spawn or delegate to another agent/);
  }
  const conductor = readFileSync(
    join(outDir, ".agents", "skills", "aidlc", "SKILL.md"),
    "utf8",
  );
  assert.match(conductor, /pnpm --dir \.codex install --frozen-lockfile/);
  assert.match(conductor, /pnpm --dir \.codex run orchestrate/);
});

test("bundle check detects drift and write refuses an unmanaged directory", () => {
  const outDir = freshBundleDir();
  writeCodexBundle({ outDir });
  writeFileSync(join(outDir, "AGENTS.md"), "stale\n", "utf8");
  const drift = checkCodexBundle({ outDir });
  assert.equal(drift.valid, false);
  assert.deepEqual(drift.stale, ["AGENTS.md"]);
  writeCodexBundle({ outDir });
  assert.equal(checkCodexBundle({ outDir }).valid, true);

  const unmanaged = freshBundleDir();
  mkdirSync(unmanaged, { recursive: true });
  writeFileSync(join(unmanaged, "keep.txt"), "user data\n", "utf8");
  assert.throws(
    () => writeCodexBundle({ outDir: unmanaged }),
    /Refusing to overwrite non-bundle directory/,
  );
  assert.equal(readFileSync(join(unmanaged, "keep.txt"), "utf8"), "user data\n");
});

test("generated runtime installs and starts a real Intent", { timeout: 30_000 }, () => {
  const outDir = freshBundleDir();
  writeCodexBundle({ outDir });
  run(outDir, "pnpm", [
    "--dir",
    ".codex",
    "install",
    "--frozen-lockfile",
    "--offline",
  ]);
  run(outDir, "pnpm", ["--dir", ".codex", "run", "workspace", "init", ".."]) ;
  run(outDir, "pnpm", [
    "--dir",
    ".codex",
    "run",
    "intent",
    "birth",
    "..",
    "Bundle Smoke",
    "--scope",
    "mvp",
  ]);
  const next = run(outDir, "pnpm", [
    "--dir",
    ".codex",
    "run",
    "orchestrate",
    "next",
    "--project-dir",
    "..",
  ]);
  const jsonStart = next.stdout.indexOf("{");
  assert.notEqual(jsonStart, -1, next.stdout);
  const directive = JSON.parse(next.stdout.slice(jsonStart)) as {
    kind?: string;
  };
  assert.equal(["load-steering", "run-stage"].includes(directive.kind ?? ""), true);
  assert.equal(existsSync(join(outDir, "aidlc", "active-space")), true);
});
