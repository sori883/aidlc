import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  cliUnknownFlags,
  loadCliContracts,
} from "../core/tools/aidlc-cli-contract.ts";
import {
  authoredCliInvocations,
  inspectRuntimeContract,
  type RuntimeContractIssueCode,
} from "../core/tools/aidlc-runtime-contract.ts";
import {
  codexBundleFiles,
  writeCodexBundle,
} from "../core/tools/aidlc-codex-bundle.ts";
import type { HarnessDescriptor } from "../core/tools/aidlc-harness-contract.ts";
import { writeProjectLayout } from "../core/tools/aidlc-project-layout.ts";

function subjects(code: RuntimeContractIssueCode): string[] {
  return inspectRuntimeContract().issues
    .filter((issue) => issue.code === code)
    .map((issue) => issue.subject);
}

test("auto-discovers a new per-tool CLI definition", () => {
  const contractsDir = join(mkdtempSync(join(tmpdir(), "aidlc-cli-contract-")), "contracts");
  mkdirSync(contractsDir);
  writeFileSync(
    join(contractsDir, "aidlc-example.json"),
    `${JSON.stringify({
      tool: "aidlc-example.ts",
      commands: {
        run: { flags: ["--project-dir"], results: ["completed"] },
      },
    })}\n`,
  );
  const contracts = loadCliContracts(contractsDir);
  assert.deepEqual(contracts.get("aidlc-example.ts")?.commands.run, {
    flags: ["--project-dir"],
    results: ["completed"],
  });
  const contract = contracts.get("aidlc-example.ts");
  assert.ok(contract);
  assert.deepEqual(
    cliUnknownFlags(contract, "run", ["project", "--project-dir", ".", "--bad"]),
    ["--bad"],
  );
});

test("extracts every flag and result from a Harness CLI invocation", () => {
  const source = `---\nname: example\n---\n\n\`bun {{HARNESS_DIR}}/tools/aidlc-example.ts run --project-dir . --result completed --new-flag\`\n`;
  assert.deepEqual(authoredCliInvocations(source), [{
    tool: "aidlc-example.ts",
    command: "run",
    flags: ["--project-dir", "--result", "--new-flag"],
    results: ["completed"],
    line: 5,
  }]);
});

test("extracts native integrated CLI routes through the Harness executable", () => {
  const source = "`./.fake/tools/aidlc graph compile --check --new-flag`\n";
  assert.deepEqual(authoredCliInvocations(source, ".fake/tools/aidlc"), [{
    tool: "aidlc-graph.ts",
    command: "compile",
    flags: ["--check", "--new-flag"],
    results: [],
    line: 1,
    nativeNoun: "graph",
  }]);
});

test("ships the contract checker as a Codex runtime command", () => {
  const packageJson = codexBundleFiles().get(".codex/package.json");
  assert.ok(packageJson);
  const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  assert.equal(parsed.scripts?.contract, "bun tools/aidlc-runtime-contract.ts");
});

test("checks an installed Codex bundle without authored Harness sources", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-installed-contract-"));
  writeCodexBundle({ outDir: root });
  const report = inspectRuntimeContract({
    coreDir: join(root, ".codex"),
    harnessDir: join(root, "absent-authored-harness"),
  });
  assert.equal(report.documents, 46);
  assert.equal(report.valid, true);
  assert.deepEqual(report.issues, []);
});

test("checks a native project layout without TypeScript runtime sources", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-native-contract-"));
  writeProjectLayout({ outDir: root });
  const options = {
    coreDir: join(root, ".codex"),
    harnessDir: join(root, "absent-authored-harness"),
    implementation: "native" as const,
  };

  const report = inspectRuntimeContract(options);
  assert.equal(report.documents, 46);
  assert.equal(report.valid, true, JSON.stringify(report.issues, null, 2));
  assert.deepEqual(report.issues, []);

  const instruction = join(
    root,
    ".codex",
    "aidlc-common",
    "stages",
    "initialization",
    "state-init.md",
  );
  writeFileSync(
    instruction,
    `${readFileSync(instruction, "utf8")}\n` +
      "`./.codex/tools/aidlc graph definitely-not-a-command`\n" +
      "`./.codex/tools/aidlc graph compile --bogus-flag`\n" +
      "`./.codex/tools/aidlc orchestrate report --result not-a-result`\n",
    "utf8",
  );
  const invalidInvocation = inspectRuntimeContract(options);
  assert.equal(invalidInvocation.valid, false);
  assert.ok(invalidInvocation.issues.some((issue) =>
    issue.code === "missing-command" &&
    issue.subject === "aidlc-graph.ts definitely-not-a-command"
  ));
  assert.ok(invalidInvocation.issues.some((issue) =>
    issue.code === "missing-flag" &&
    issue.subject === "aidlc-graph.ts compile --bogus-flag"
  ));
  assert.ok(invalidInvocation.issues.some((issue) =>
    issue.code === "missing-result" &&
    issue.subject === "aidlc-orchestrate.ts report --result not-a-result"
  ));

  rmSync(join(root, ".codex", "tools", "contracts", "aidlc-log.json"));
  const missingContract = inspectRuntimeContract(options);
  assert.equal(missingContract.valid, false);
  assert.ok(missingContract.issues.some((issue) =>
    issue.code === "missing-tool" && issue.subject === "aidlc-log.ts"
  ));
});

test("detects unresolved placeholders and missing files in an installed bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-broken-contract-"));
  writeCodexBundle({ outDir: root });
  const instruction = join(
    root,
    ".codex",
    "aidlc-common",
    "stages",
    "initialization",
    "state-init.md",
  );
  writeFileSync(
    instruction,
    `${readFileSync(instruction, "utf8")}\nSee {{HARNESS_DIR}}/knowledge/aidlc-shared/state-template.md and .codex/knowledge/aidlc-shared/not-present.md.\n`,
  );
  const report = inspectRuntimeContract({
    coreDir: join(root, ".codex"),
    harnessDir: join(root, "absent-authored-harness"),
  });
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) =>
    issue.code === "unresolved-harness-placeholder"
  ));
  assert.ok(report.issues.some((issue) =>
    issue.code === "missing-resource" &&
    issue.subject === ".codex/knowledge/aidlc-shared/not-present.md"
  ));
});

test("checks generated instructions through a non-Codex Harness descriptor", () => {
  const descriptor: HarnessDescriptor = {
    id: "fake",
    displayName: "Fake",
    capabilities: {
      structuredQuestions: false,
      agentDelegation: false,
      parallelAgentDelegation: false,
      postWriteHook: false,
      reviewerScopeEnforcement: false,
      stopWaitNotification: false,
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
  const generatedFiles = new Map([
    ["FAKE.md", "See .fake/knowledge/missing.md.\n"],
  ]);
  const report = inspectRuntimeContract({ descriptor, generatedFiles });
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) =>
    issue.code === "missing-resource" &&
    issue.subject === ".fake/knowledge/missing.md"
  ));
  assert.ok(report.issues.every((issue) => !issue.detail.includes("Codex bundle")));
});

test("finds runtime tools referenced by authored instructions but not implemented", () => {
  const missing = new Set(subjects("missing-tool"));
  assert.equal(missing.has("aidlc-log.ts"), false);
  assert.equal(missing.has("aidlc-utility.ts"), false);
  assert.equal(missing.has("aidlc-worktree.ts"), false);
});

test("finds implemented tools that lack referenced commands", () => {
  const missing = new Set(subjects("missing-command"));
  assert.equal(missing.has("aidlc-state.ts practices-event"), false);
  assert.equal(missing.has("aidlc-state.ts practices-promote"), false);
  assert.equal(missing.has("aidlc-state.ts set-construction-iteration"), false);
  assert.equal(missing.has("aidlc-graph.ts ars"), false);
  assert.equal(missing.has("aidlc-graph.ts validate-grid"), false);
  assert.equal(missing.has("aidlc-utility.ts detect"), false);
  assert.equal(missing.has("aidlc-utility.ts codekb-path"), false);
  assert.equal(missing.has("aidlc-utility.ts scope-table"), false);
  assert.equal(missing.has("aidlc-utility.ts stage-table"), false);
  assert.equal(missing.has("aidlc-utility.ts recompose"), false);
});

test("implements report approval lifecycle values and user input", () => {
  const results = new Set(subjects("missing-result"));
  assert.equal(results.has("aidlc-orchestrate.ts report --result awaiting-approval"), false);
  assert.equal(results.has("aidlc-orchestrate.ts report --result rejected"), false);
  assert.equal(results.has("aidlc-orchestrate.ts report --result revised"), false);
  assert.equal(subjects("missing-flag").includes(
    "aidlc-orchestrate.ts report --user-input",
  ), false);
});

test("resolves shared resources and Codex placeholders", () => {
  const resources = new Set(subjects("missing-resource"));
  assert.equal(resources.has("stage-protocol.md"), false);
  assert.equal(resources.has("knowledge/aidlc-shared/rules-reading.md"), false);
  assert.equal(
    resources.has("knowledge/aidlc-design-agent/component-spec-template.md"),
    false,
  );
  assert.equal(
    resources.has("knowledge/aidlc-developer-agent/re-artifacts.md"),
    false,
  );
  assert.equal(resources.has("branching-strategies.md"), false);
  assert.equal(resources.has("tools/data/scope-grid.json"), false);
  assert.deepEqual(subjects("unresolved-harness-placeholder"), []);
});

test("reports stable source locations and no capability catalog drift", () => {
  const report = inspectRuntimeContract();
  assert.equal(report.documents, 46);
  assert.equal(report.valid, true);
  assert.ok(report.issues.every((issue) => issue.line >= 1));
  assert.deepEqual(report.issues, []);
  assert.deepEqual(subjects("capability-drift"), []);
});
