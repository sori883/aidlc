import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderHelp, resolveAction, ROUTES } from "../core/tools/aidlc.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

const ROOT = resolve(import.meta.dir, "..");

function run(args: string[]) {
  return spawnSync(process.execPath, ["core/tools/aidlc.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("integrated CLI exposes only vNext workflow routes", () => {
  assert.deepEqual(resolveAction(["graph", "validate"]), {
    type: "delegate",
    tool: "aidlc-core-route.ts",
    args: ["validate"],
  });
  assert.deepEqual(resolveAction(["next", "."]), {
    type: "delegate",
    tool: "aidlc-vnext-orchestrate.ts",
    args: ["next", "."],
  });
  assert.equal(ROUTES.some((route) => route.noun === "plan"), true);
  assert.equal(ROUTES.some((route) => route.noun === "state"), true);
  assert.equal(ROUTES.some((route) => route.noun === "scope"), false);
  assert.equal(ROUTES.some((route) => route.noun === "bolt"), false);
  assert.match(renderHelp(true), /fixed vNext Catalog/);
});

test("integrated CLI rejects v2 workflow and unknown routes", () => {
  for (const args of [
    ["graph", "compile"],
    ["state", "skip", ".", "ST-00"],
    ["report", "."],
    ["scope", "check"],
    ["unknown", "command"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(" "));
  }
});

test("integrated CLI exposes the release version", () => {
  assert.deepEqual(resolveAction(["--version"]), { type: "version" });
  const result = run(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `aidlc ${AIDLC_VERSION}\n`);
});

test("every packaged vNext TypeScript tool exports main(argv)", async () => {
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
