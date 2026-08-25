import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const RUNTIME_SCENARIOS = [
  { name: "A 小さな文字変更", pattern: "ST-09 fixes every promise, auto-completes only an all-achieved Outcome" },
  { name: "B 依存関係のある機能", pattern: "Core integrates dependent Bolts across two Git Repositories before creating one Candidate" },
  { name: "C 実装を伴わないIntent", pattern: "ST-08 deterministically skips Release only when ST-07 has no Accepted Candidate" },
  { name: "D Release失敗と復旧", pattern: "ST-08 rolls back earlier Source promotions when a later external step fails" },
] as const;

for (const scenario of RUNTIME_SCENARIOS) {
  test(`M6 E2E ${scenario.name}`, () => {
    const result = spawnSync(process.execPath, [
      "test",
      "tests/aidlc-vnext-build-converge.test.ts",
      "--test-name-pattern",
      scenario.pattern,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /1 pass/);
    assert.match(output, /0 fail/);
  }, { timeout: 120_000 });
}
