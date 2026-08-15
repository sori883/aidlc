import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import {
  codexPatchPaths,
  runCodexSensorHook,
} from "../harness/codex/hooks/aidlc-sensor-fire.ts";

test("Codex adapter extracts every apply_patch path in patch order", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/first.ts",
    "@@",
    "-old",
    "+new",
    "*** Add File: src/second.ts",
    "+export {};",
    "*** Update File: src/old.ts",
    "*** Move to: src/new.ts",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(codexPatchPaths(patch), [
    "src/first.ts",
    "src/second.ts",
    "src/old.ts",
    "src/new.ts",
  ]);
});

test("Codex adapter fans out one advisory result per modified file", async () => {
  const projectDir = mkdtempSync(`${tmpdir()}/aidlc-codex-hook-`);
  const result = await runCodexSensorHook({
    cwd: projectDir,
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Add File: a.md\n+x\n*** Add File: b.md\n+y\n*** End Patch",
    },
  });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.files, ["a.md", "b.md"]);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.every((entry) => entry.skipped), true);
});

test("Codex adapter ignores unrelated tools", async () => {
  const result = await runCodexSensorHook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo ok" },
  });
  assert.deepEqual(result, {
    files: [],
    results: [],
    skipped: true,
    reason: "not apply_patch",
  });
});
