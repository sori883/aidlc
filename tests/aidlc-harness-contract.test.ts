import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  resolveDirectiveExecution,
  resolveHarnessDescriptor,
  validateHarnessDescriptor,
  type HarnessDescriptor,
} from "../core/tools/aidlc-harness-contract.ts";
import { CODEX_HARNESS } from "../harness/codex/aidlc-harness.ts";
import {
  distributionArea,
  isRuntimeDistributionPath,
  nativeCliPath,
  validateInstallationManifest,
  type InstallationManifest,
} from "../core/tools/aidlc-distribution-contract.ts";
import { projectLayoutFiles } from "../core/tools/aidlc-project-layout.ts";

const ROOT = resolve(import.meta.dir, "..");
const SHA = "a".repeat(64);

function fakeHarness(
  capabilities: Partial<HarnessDescriptor["capabilities"]> = {},
): HarnessDescriptor {
  return {
    id: "fake",
    displayName: "Fake Harness",
    capabilities: {
      structuredQuestions: false,
      agentDelegation: false,
      parallelAgentDelegation: false,
      postWriteHook: false,
      reviewerScopeEnforcement: false,
      stopWaitNotification: false,
      ...capabilities,
    },
    layout: {
      runtimeRoot: ".fake",
      executablePath: ".fake/tools/aidlc",
      projectInstructions: ["FAKE.md"],
      skillRoot: ".fake/skills",
      agentRoot: ".fake/agents",
      hookConfigPath: ".fake/hooks.json",
      installationManifestPath: ".fake/aidlc-installation.json",
      projectLayoutManifestPath: ".fake/distribution-manifest.json",
    },
  };
}

test("Codex is a validated Adapter descriptor, not a Core-only Harness union", () => {
  assert.deepEqual(validateHarnessDescriptor(CODEX_HARNESS), CODEX_HARNESS);
  assert.equal(CODEX_HARNESS.id, "codex");
  assert.equal(CODEX_HARNESS.layout.runtimeRoot, ".codex");
  assert.equal(nativeCliPath("win32", CODEX_HARNESS), ".codex/tools/aidlc.exe");
  assert.equal(nativeCliPath("linux", fakeHarness()), ".fake/tools/aidlc");
  assert.equal(distributionArea(".fake/tools/contracts/state.json", fakeHarness()), "core");
  assert.equal(isRuntimeDistributionPath(".fake/agents/worker.toml", fakeHarness()), true);
});

test("Harness descriptors reject unsafe layouts and inconsistent capabilities", () => {
  assert.throws(
    () => validateHarnessDescriptor({
      ...fakeHarness(),
      layout: { ...fakeHarness().layout, runtimeRoot: "../escape" },
    }),
    /runtimeRoot/,
  );
  assert.throws(
    () => validateHarnessDescriptor(fakeHarness({
      parallelAgentDelegation: true,
      agentDelegation: false,
    })),
    /parallelAgentDelegation/,
  );
  assert.throws(
    () => validateHarnessDescriptor({
      ...fakeHarness(),
      layout: { ...fakeHarness().layout, runtimeRoot: "C:/escape" },
    }),
    /runtimeRoot/,
  );
});

test("unsupported Harness selection fails explicitly", () => {
  assert.equal(resolveHarnessDescriptor("codex", [CODEX_HARNESS]), CODEX_HARNESS);
  assert.throws(
    () => resolveHarnessDescriptor("claude-code", [CODEX_HARNESS]),
    /Unsupported Harness: claude-code/,
  );
});

test("capability fallback changes execution means without changing Directive intent", () => {
  const swarm = { kind: "invoke-swarm" as const, units: ["U1", "U2"] };
  assert.deepEqual(
    resolveDirectiveExecution(swarm, CODEX_HARNESS.capabilities),
    { directive: swarm, strategy: "parallel-agents" },
  );
  assert.deepEqual(
    resolveDirectiveExecution(swarm, fakeHarness().capabilities),
    { directive: swarm, strategy: "inline-sequential" },
  );

  const ask = { kind: "ask", question: "Continue?" } as const;
  assert.deepEqual(
    resolveDirectiveExecution(ask, fakeHarness().capabilities),
    { directive: ask, strategy: "text-question" },
  );
  const directives = [swarm, ask, { kind: "done" as const, reason: "complete" }];
  const codexTrace = directives.map((directive) =>
    resolveDirectiveExecution(directive, CODEX_HARNESS.capabilities).directive.kind
  );
  const fakeTrace = directives.map((directive) =>
    resolveDirectiveExecution(directive, fakeHarness().capabilities).directive.kind
  );
  assert.deepEqual(fakeTrace, codexTrace);
});

test("Installation manifest schema can preserve a future Harness id", () => {
  const manifest: InstallationManifest = {
    format: "aidlc-project-installation",
    schema_version: 2,
    version: "0.6.2",
    harness: "claude-code",
    installed_at: "2026-08-18T00:00:00.000Z",
    files: [{
      path: "CLAUDE.md",
      sha256: SHA,
      bytes: 10,
      executable: false,
    }],
  };
  assert.deepEqual(validateInstallationManifest(manifest), manifest);
});

test("project distribution paths are derived from the selected descriptor", () => {
  const descriptor = fakeHarness();
  const files = projectLayoutFiles({
    descriptor,
    platform: "linux",
    bundleFiles: new Map([
      [".fake/tools/contracts/state.json", "{}\n"],
      ["FAKE.md", "Run `bun run --cwd .fake aidlc state show`.\n"],
    ]),
  });
  assert.equal(files.has(".fake/tools/contracts/state.json"), true);
  assert.equal(files.has(".fake/distribution-manifest.json"), true);
  assert.match(files.get("FAKE.md") ?? "", /\.\/\.fake\/tools\/aidlc state show/);
  assert.equal([...files.keys()].some((path) => path.startsWith(".codex/")), false);
});

test("Core protocol contains no Codex lifecycle operation names", () => {
  const protocol = readFileSync(
    resolve(ROOT, "core/aidlc-common/protocols/stage-protocol.md"),
    "utf8",
  );
  assert.doesNotMatch(protocol, /\bTaskUpdate\b/);
  assert.doesNotMatch(protocol, /\bPostToolUse\b/);
});

test("Domain Core has no concrete Harness imports or payload environment names", () => {
  const coreTools = resolve(ROOT, "core/tools");
  const compositionFiles = new Set([
    "aidlc-codex-bundle.ts",
    "aidlc-distribution-contract.ts",
    "aidlc-doctor.ts",
    "aidlc-hook.ts",
    "aidlc-project-layout.ts",
    "aidlc-runner-gen.ts",
    "aidlc-runtime-contract.ts",
    "aidlc-runtime-paths.ts",
  ]);
  for (const name of readdirSync(coreTools).filter((entry) => entry.endsWith(".ts"))) {
    if (compositionFiles.has(name)) continue;
    const source = readFileSync(resolve(coreTools, name), "utf8");
    assert.doesNotMatch(source, /harness\/codex|aidlc-codex-bundle/, name);
  }
  const hook = readFileSync(resolve(ROOT, "core/hooks/aidlc-sensor-fire.ts"), "utf8");
  assert.doesNotMatch(hook, /CODEX_PROJECT_DIR|CLAUDE_PROJECT_DIR|PostToolUse/);
  for (const name of ["aidlc-state.ts", "aidlc-audit.ts", "aidlc-orchestrate.ts"]) {
    const source = readFileSync(resolve(coreTools, name), "utf8");
    assert.doesNotMatch(source, /aidlc-codex-bundle|harness\/codex/, name);
  }
});
