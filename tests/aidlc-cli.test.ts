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
  assert.deepEqual(resolveAction(["intent", "risk", "propose", ".", "risk-proposal.json"]), {
    type: "delegate",
    tool: "aidlc-intent.ts",
    args: ["risk", "propose", ".", "risk-proposal.json"],
  });
  assert.deepEqual(resolveAction(["orient", "complete", ".", "proposal.json"]), {
    type: "delegate",
    tool: "aidlc-vnext-orient.ts",
    args: ["complete", ".", "proposal.json"],
  });
  assert.deepEqual(resolveAction(["define-intent", "complete", ".", "proposal.json"]), {
    type: "delegate",
    tool: "aidlc-vnext-define-intent.ts",
    args: ["complete", ".", "proposal.json"],
  });
  assert.deepEqual(resolveAction(["requirements", "complete", ".", "proposal.json"]), {
    type: "delegate",
    tool: "aidlc-vnext-requirements.ts",
    args: ["complete", ".", "proposal.json"],
  });
  assert.deepEqual(resolveAction(["architecture", "complete", ".", "proposal.json"]), {
    type: "delegate",
    tool: "aidlc-vnext-architecture.ts",
    args: ["complete", ".", "proposal.json"],
  });
  assert.deepEqual(resolveAction(["build-contract", "review", ".", "proposal.json"]), {
    type: "delegate",
    tool: "aidlc-vnext-build-contract.ts",
    args: ["review", ".", "proposal.json"],
  });
  assert.deepEqual(resolveAction(["build-contract", "approve", ".", "sha256:value", "承認"]), {
    type: "delegate",
    tool: "aidlc-vnext-build-contract.ts",
    args: ["approve", ".", "sha256:value", "承認"],
  });
  assert.deepEqual(resolveAction(["build", "prepare", "."]), {
    type: "delegate",
    tool: "aidlc-vnext-build-converge.ts",
    args: ["prepare", "."],
  });
  assert.deepEqual(resolveAction(["build", "verify", ".", "BOLT-001"]), {
    type: "delegate",
    tool: "aidlc-vnext-build-converge.ts",
    args: ["verify", ".", "BOLT-001"],
  });
  assert.deepEqual(resolveAction(["build", "reuse", ".", "candidate.json", "同じ候補を使う"]), {
    type: "delegate",
    tool: "aidlc-vnext-build-converge.ts",
    args: ["reuse", ".", "candidate.json", "同じ候補を使う"],
  });
  assert.deepEqual(resolveAction(["review", "prepare", "."]), {
    type: "delegate",
    tool: "aidlc-vnext-review.ts",
    args: ["prepare", "."],
  });
  assert.deepEqual(resolveAction(["review", "approve", ".", "sha256:value", "承認"]), {
    type: "delegate",
    tool: "aidlc-vnext-review.ts",
    args: ["approve", ".", "sha256:value", "承認"],
  });
  assert.deepEqual(resolveAction(["review", "feedback", ".", "sha256:value", "feedback.json", "修正"]), {
    type: "delegate",
    tool: "aidlc-vnext-review.ts",
    args: ["feedback", ".", "sha256:value", "feedback.json", "修正"],
  });
  assert.deepEqual(resolveAction(["release", "review", ".", "proposal.json"]), {
    type: "delegate",
    tool: "aidlc-vnext-release.ts",
    args: ["review", ".", "proposal.json"],
  });
  assert.deepEqual(resolveAction(["release", "authorize", ".", "sha256:value", "承認"]), {
    type: "delegate",
    tool: "aidlc-vnext-release.ts",
    args: ["authorize", ".", "sha256:value", "承認"],
  });
  assert.deepEqual(resolveAction(["release", "execute", "."]), {
    type: "delegate",
    tool: "aidlc-vnext-release.ts",
    args: ["execute", "."],
  });
  assert.deepEqual(resolveAction(["release", "reuse", ".", "release-current.json", "一致"]), {
    type: "delegate",
    tool: "aidlc-vnext-release.ts",
    args: ["reuse", ".", "release-current.json", "一致"],
  });
  assert.deepEqual(resolveAction(["outcome", "prepare", "."]), {
    type: "delegate",
    tool: "aidlc-vnext-outcome.ts",
    args: ["prepare", "."],
  });
  assert.deepEqual(resolveAction(["outcome", "evaluate", ".", "proposal.json"]), {
    type: "delegate",
    tool: "aidlc-vnext-outcome.ts",
    args: ["evaluate", ".", "proposal.json"],
  });
  assert.deepEqual(resolveAction(["outcome", "decide", ".", "sha256:value", "complete-with-outcome", "完了"]), {
    type: "delegate",
    tool: "aidlc-vnext-outcome.ts",
    args: ["decide", ".", "sha256:value", "complete-with-outcome", "完了"],
  });
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
