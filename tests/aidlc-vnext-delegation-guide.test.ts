import assert from "node:assert/strict";
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VNEXT_STAGE_IDS } from "../core/tools/aidlc-stage-contract.ts";
import { loadVNextDelegationCatalog } from "../core/tools/aidlc-vnext-delegation-contract.ts";

const root = resolve(import.meta.dir, "..");
const html = readFileSync(
  join(root, "docs", "aidlc-vnext-agent-delegation-guide.html"),
  "utf8",
);

test("explains the complete vNext Agent delegation model for beginners", () => {
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /vnext-stage-delegation\.json/);
  assert.match(html, /Conductor/);
  assert.match(html, /Core/);
  assert.match(html, /人間/);
  assert.match(html, /aidlc-stage-work/);
  assert.match(html, /@media\s*\(max-width:/);
  for (const stageId of VNEXT_STAGE_IDS) assert.match(html, new RegExp(stageId));
  for (const stage of loadVNextDelegationCatalog().stages) {
    for (const assignment of [stage.work_assignment, stage.review_assignment]) {
      if (assignment === null) continue;
      assert.match(html, new RegExp(assignment.lead_agent));
    }
  }
  assert.doesNotMatch(html, /TODO|PLACEHOLDER/);
});
