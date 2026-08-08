import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadAgents } from "../core/tools/aidlc-agent-loader.ts";
import type {
  Directive,
  RunStageDirective,
} from "../core/tools/aidlc-directive.ts";
import {
  checkCodexBundle,
  CODEX_BUNDLE_MANIFEST,
  codexProjectCommands,
  codexRuntimeToolScripts,
  transformCodexMarkdown,
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

function jsonOutput<T>(stdout: string): T {
  const start = stdout.indexOf("{");
  assert.notEqual(start, -1, stdout);
  return JSON.parse(stdout.slice(start)) as T;
}

function runtimeNext(outDir: string, continueToken?: string): Directive {
  const args = [
    "--dir",
    ".codex",
    "run",
    "orchestrate",
    "next",
    "--project-dir",
    "..",
    ...(continueToken === undefined
      ? []
      : ["--continue-token", continueToken]),
  ];
  return jsonOutput<Directive>(run(outDir, "pnpm", args).stdout);
}

function runtimeRunnable(outDir: string): RunStageDirective {
  let directive = runtimeNext(outDir);
  while (directive.kind === "load-steering") {
    directive = runtimeNext(outDir, directive.continue_token);
  }
  assert.equal(
    directive.kind,
    "run-stage",
    directive.kind === "error" ? directive.message : JSON.stringify(directive),
  );
  if (directive.kind !== "run-stage") {
    throw new Error("Expected run-stage Directive");
  }
  return directive;
}

test("translates Harness-neutral Markdown to Codex pnpm commands and paths", () => {
  const scripts = codexRuntimeToolScripts(JSON.stringify({
    scripts: {
      graph: "tsx tools/aidlc-graph.ts",
      utility: "tsx tools/aidlc-utility.ts",
      ignored: "node tools/not-an-aidlc-tool.ts",
    },
  }));
  assert.deepEqual([...scripts], [
    ["aidlc-graph.ts", "graph"],
    ["aidlc-utility.ts", "utility"],
  ]);

  const rendered = transformCodexMarkdown([
    "bun {{HARNESS_DIR}}/tools/aidlc-graph.ts ars",
    "bun\n{{HARNESS_DIR}}/tools/aidlc-utility.ts scope-table",
    "bun {{HARNESS_DIR}}/tools/aidlc-utility.ts detect --json",
    "{{HARNESS_DIR}}/knowledge/aidlc-shared/rules-reading.md",
    "{{HARNESS_DIR}}/tools/data/scope-grid.json",
  ].join("\n"), scripts, new Map([
    ["aidlc-utility.ts", new Set(["detect"])],
  ]));
  assert.equal(rendered, [
    "pnpm --dir .codex run graph ars",
    "pnpm --dir .codex run utility scope-table",
    "pnpm --dir .codex run utility detect --project-dir .. --json",
    ".codex/knowledge/aidlc-shared/rules-reading.md",
    ".codex/aidlc-common/data/scope-grid.json",
  ].join("\n"));
  assert.doesNotMatch(rendered, /\{\{HARNESS_DIR\}\}/);
});

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
    ".codex/aidlc-common/protocols/stage-protocol.md",
    ".codex/knowledge/aidlc-shared/rules-reading.md",
    ".codex/knowledge/aidlc-design-agent/component-spec-template.md",
    ".codex/knowledge/aidlc-developer-agent/re-artifacts.md",
    ".codex/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md",
    ".agents/skills/aidlc/SKILL.md",
  ]) {
    assert.equal(existsSync(join(outDir, path)), true, path);
  }
  const runtime = JSON.parse(
    readFileSync(join(outDir, ".codex", "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.deepEqual(runtime.dependencies, { tsx: "4.23.1", yaml: "2.9.0" });
  assert.equal(runtime.scripts.graph, "tsx tools/aidlc-graph.ts");
  assert.equal(
    runtime.scripts["sensor-linter"],
    "tsx tools/aidlc-sensor-linter.ts",
  );
  const hook = readFileSync(
    join(outDir, ".codex", "hooks", "aidlc-sensor-fire.ts"),
    "utf8",
  );
  assert.match(hook, /from "\.\/aidlc-sensor-core\.ts"/);
  assert.doesNotMatch(hook, /\.\.\/\.\.\/\.\.\/core/);
  const skill = readFileSync(
    join(outDir, ".agents", "skills", "aidlc", "SKILL.md"),
    "utf8",
  );
  assert.match(
    skill,
    /\.codex\/aidlc-common\/protocols\/stage-protocol\.md/,
  );
  const composer = readFileSync(
    join(outDir, ".codex", "agents", "aidlc-composer-agent.md"),
    "utf8",
  );
  assert.match(composer, /pnpm --dir \.codex run graph ars/);
  const composerToml = readFileSync(
    join(outDir, ".codex", "agents", "aidlc-composer-agent.toml"),
    "utf8",
  );
  assert.match(composerToml, /pnpm --dir \.codex run graph ars/);
  const protocol = readFileSync(
    join(outDir, ".codex", "aidlc-common", "protocols", "stage-protocol.md"),
    "utf8",
  );
  assert.match(
    protocol,
    /pnpm --dir \.codex run log decision --project-dir \.\./,
  );
  assert.match(protocol, /pnpm --dir \.codex run utility scope-table/);
  const practices = readFileSync(
    join(
      outDir,
      ".codex",
      "aidlc-common",
      "stages",
      "inception",
      "practices-discovery.md",
    ),
    "utf8",
  );
  assert.match(
    practices,
    /pnpm --dir \.codex run state practices-promote --project-dir \.\./,
  );
  assert.match(
    practices,
    /pnpm --dir \.codex run orchestrate report --project-dir \.\./,
  );
  const sensor = readFileSync(
    join(outDir, ".codex", "sensors", "aidlc-linter.md"),
    "utf8",
  );
  assert.match(sensor, /^command: pnpm --dir \.codex run sensor-linter$/m);
  const stateInit = readFileSync(
    join(
      outDir,
      ".codex",
      "aidlc-common",
      "stages",
      "initialization",
      "state-init.md",
    ),
    "utf8",
  );
  assert.match(stateInit, /\.codex\/aidlc-common\/data\/scope-grid\.json/);

  for (const path of result.files.filter((path) =>
    path.endsWith(".md") || path.endsWith(".toml")
  )) {
    assert.doesNotMatch(
      readFileSync(join(outDir, path), "utf8"),
      /\{\{HARNESS_DIR\}\}/,
      path,
    );
  }

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

test("derives project-aware Codex commands from CLI contracts", () => {
  const commands = codexProjectCommands();
  assert.equal(commands.get("aidlc-orchestrate.ts")?.has("report"), true);
  assert.equal(commands.get("aidlc-state.ts")?.has("practices-promote"), true);
  assert.equal(commands.get("aidlc-utility.ts")?.has("detect"), true);
  assert.equal(commands.get("aidlc-utility.ts")?.has("scope-table"), false);
  assert.equal(commands.get("aidlc-graph.ts"), undefined);
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
  const directive = runtimeRunnable(outDir);
  assert.equal(directive.stage, "intent-capture");
  assert.equal(existsSync(join(outDir, "aidlc", "active-space")), true);
  const doctor = run(outDir, "pnpm", [
    "--dir",
    ".codex",
    "run",
    "doctor",
    "check",
    "--project-dir",
    "..",
    "--json",
  ]);
  const doctorReport = jsonOutput<{
    healthy?: boolean;
  }>(doctor.stdout);
  assert.equal(doctorReport.healthy, true);

  for (const output of directive.produces) {
    const path = resolve(outDir, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# Bundle process-resume artifact\n", "utf8");
  }
  run(outDir, "pnpm", [
    "--dir",
    ".codex",
    "run",
    "memory",
    "init",
    "--memory-path",
    directive.memory_path,
    "--project-dir",
    "..",
  ]);
  const memoryPath = resolve(realpathSync(outDir), directive.memory_path);
  const recordDir = dirname(dirname(dirname(memoryPath)));
  const selectionDir = join(recordDir, ".aidlc-learnings");
  mkdirSync(selectionDir, { recursive: true });
  const selections = join(selectionDir, `${directive.stage}-selections.json`);
  writeFileSync(selections, `${JSON.stringify({
    version: 1,
    stage: directive.stage,
    anything_to_add_answered: true,
    selections: [],
  }, null, 2)}\n`, "utf8");
  run(outDir, "pnpm", [
    "--dir",
    ".codex",
    "run",
    "learnings",
    "persist",
    "--slug",
    directive.stage,
    "--selections-json",
    selections,
    "--project-dir",
    "..",
  ]);
  const report = jsonOutput<Directive>(run(outDir, "pnpm", [
    "--dir",
    ".codex",
    "run",
    "orchestrate",
    "report",
    "--project-dir",
    "..",
    "--stage",
    directive.stage,
    "--result",
    "approved",
    "--user-input",
    "Approve",
  ]).stdout);
  assert.equal(report.kind, "done");

  const resumed = jsonOutput<{ currentStage: string }>(run(outDir, "pnpm", [
    "--dir",
    ".codex",
    "run",
    "state",
    "resume",
    "..",
  ]).stdout);
  assert.notEqual(resumed.currentStage, directive.stage);
  const afterProcessRestart = runtimeRunnable(outDir);
  assert.equal(afterProcessRestart.stage, resumed.currentStage);
});
