import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import {
  renderHelp,
  resolveAction,
  ROUTES,
} from "../core/tools/aidlc.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

const ROOT = resolve(import.meta.dir, "..");

function run(path: string, args: string[]) {
  return spawnSync(process.execPath, [path, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("integrated CLI exposes explicit upstream-style routes", () => {
  assert.deepEqual(resolveAction(["graph", "compile", "--check"]), {
    type: "delegate",
    tool: "aidlc-graph.ts",
    args: ["compile", "--check"],
  });
  assert.deepEqual(resolveAction(["next", "--project-dir", "."]), {
    type: "delegate",
    tool: "aidlc-orchestrate.ts",
    args: ["next", "--project-dir", "."],
  });
  assert.deepEqual(resolveAction(["__sensor-script", "linter", "--stage", "x"]), {
    type: "delegate",
    tool: "aidlc-sensor-linter.ts",
    args: ["--stage", "x"],
  });
  assert.equal(ROUTES.some((route) => route.noun === "state"), true);
  assert.match(renderHelp(true), /All command groups:/);
});

test("integrated CLI preserves direct CLI output and exit status", () => {
  for (const [integratedArgs, directTool, directArgs] of [
    [["utility", "scope-table"], "aidlc-utility.ts", ["scope-table"]],
    [["graph", "compile", "--check"], "aidlc-graph.ts", ["compile", "--check"]],
    [["contract", "check"], "aidlc-runtime-contract.ts", ["check"]],
  ] as const) {
    const integrated = run("core/tools/aidlc.ts", [...integratedArgs]);
    const direct = run(`core/tools/${directTool}`, [...directArgs]);
    assert.equal(integrated.status, direct.status);
    assert.equal(integrated.stdout, direct.stdout);
    assert.equal(integrated.stderr, direct.stderr);
  }
});

test("integrated CLI rejects unknown routes before delegation", () => {
  const result = run("core/tools/aidlc.ts", ["unknown", "command"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command or noun 'unknown'/);
});

test("integrated CLI exposes version 0.6.0", () => {
  assert.deepEqual(resolveAction(["--version"]), { type: "version" });
  assert.deepEqual(resolveAction(["-V"]), { type: "version" });
  const result = run("core/tools/aidlc.ts", ["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `aidlc ${AIDLC_VERSION}\n`);
  assert.equal(result.stderr, "");
});

test("every packaged TypeScript tool exports main(argv)", async () => {
  const runtime = JSON.parse(
    readFileSync(resolve(ROOT, "harness/codex/runtime/package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const tools = [...new Set(
    Object.values(runtime.scripts)
      .map((command) => command.match(/^bun tools\/(aidlc-[a-z0-9-]+\.ts)$/)?.[1])
      .filter((tool): tool is string => tool !== undefined),
  )];
  for (const tool of tools) {
    const module = await import(
      pathToFileURL(resolve(ROOT, "core/tools", tool)).href
    ) as { main?: unknown };
    assert.equal(typeof module.main, "function", tool);
  }
});
