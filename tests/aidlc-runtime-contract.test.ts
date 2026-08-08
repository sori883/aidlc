import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("ships the contract checker as a Codex runtime command", () => {
  const packageJson = codexBundleFiles().get(".codex/package.json");
  assert.ok(packageJson);
  const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  assert.equal(parsed.scripts?.contract, "tsx tools/aidlc-runtime-contract.ts");
});

test("checks an installed Codex bundle without authored Harness sources", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-installed-contract-"));
  writeCodexBundle({ outDir: root });
  const report = inspectRuntimeContract({
    coreDir: join(root, ".codex"),
    harnessDir: join(root, "absent-authored-harness"),
  });
  assert.equal(report.documents, 46);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) =>
    issue.code === "missing-command" &&
    issue.subject === "aidlc-state.ts practices-event"
  ));
});

test("finds runtime tools referenced by authored instructions but not implemented", () => {
  const missing = new Set(subjects("missing-tool"));
  assert.ok(missing.has("aidlc-log.ts"));
  assert.ok(missing.has("aidlc-utility.ts"));
  assert.ok(missing.has("aidlc-worktree.ts"));
});

test("finds implemented tools that lack referenced commands", () => {
  const missing = new Set(subjects("missing-command"));
  assert.ok(missing.has("aidlc-state.ts practices-event"));
  assert.ok(missing.has("aidlc-state.ts practices-promote"));
  assert.ok(missing.has("aidlc-state.ts set-construction-iteration"));
  assert.ok(missing.has("aidlc-graph.ts ars"));
  assert.ok(missing.has("aidlc-graph.ts validate-grid"));
});

test("finds report lifecycle values and flags absent from the runtime", () => {
  const results = new Set(subjects("missing-result"));
  assert.ok(results.has("aidlc-orchestrate.ts report --result awaiting-approval"));
  assert.ok(results.has("aidlc-orchestrate.ts report --result rejected"));
  assert.ok(results.has("aidlc-orchestrate.ts report --result revised"));
  assert.ok(subjects("missing-flag").includes(
    "aidlc-orchestrate.ts report --user-input",
  ));
});

test("finds missing shared resources and unresolved Codex placeholders", () => {
  const resources = new Set(subjects("missing-resource"));
  assert.ok(resources.has("stage-protocol.md"));
  assert.ok(resources.has("knowledge/aidlc-shared/rules-reading.md"));
  assert.ok(resources.has("knowledge/aidlc-design-agent/component-spec-template.md"));
  assert.ok(resources.has("knowledge/aidlc-developer-agent/re-artifacts.md"));
  assert.ok(resources.has("branching-strategies.md"));
  assert.ok(resources.has("tools/data/scope-grid.json"));
  assert.ok(subjects("unresolved-harness-placeholder").length > 0);
});

test("reports stable source locations and no capability catalog drift", () => {
  const report = inspectRuntimeContract();
  assert.equal(report.documents, 46);
  assert.equal(report.valid, false);
  assert.ok(report.issues.every((issue) => issue.line >= 1));
  assert.deepEqual(subjects("capability-drift"), []);
});
