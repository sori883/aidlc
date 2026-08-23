import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  appendAuditEntries,
  appendAuditEntry,
  readOrderedAuditEntries,
} from "../core/tools/aidlc-audit.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

test("Audit appends a unique monotonic sequence under the Workspace lock", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-audit-sequence-"));
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "Audit sequence", "default");
  const before = readOrderedAuditEntries(born.recordDir);
  const first = appendAuditEntry(projectDir, born.recordDir, "DECISION_RECORDED", {
    Decision: "one",
  });
  const batch = appendAuditEntries(projectDir, born.recordDir, [
    { event: "QUESTION_ANSWERED", fields: { Question: "two" } },
    { event: "RULE_LEARNED", fields: { Rule: "three" } },
  ]);
  assert.equal(first.sequence, before.length + 1);
  assert.deepEqual(batch.sequences, [before.length + 2, before.length + 3]);
  const entries = readOrderedAuditEntries(born.recordDir);
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    entries.map((_entry, index) => index + 1),
  );
  const source = readFileSync(first.path, "utf8");
  assert.match(source, /^\*\*Clone ID\*\*: [a-z0-9]+$/m);
  assert.match(source, /^\*\*Sequence\*\*: \d+$/m);
});

test("distributed Audit shards have deterministic clone and sequence order", () => {
  const recordDir = mkdtempSync(join(tmpdir(), "aidlc-audit-shards-"));
  const auditDir = join(recordDir, "audit");
  mkdirSync(auditDir);
  const block = (cloneId: string, sequence: number, timestamp: string, event: string) =>
    `# AI-DLC Audit Log\n\n## Event\n**Timestamp**: ${timestamp}\n` +
    `**Clone ID**: ${cloneId}\n**Sequence**: ${sequence}\n**Event**: ${event}\n\n---\n`;
  writeFileSync(
    join(auditDir, "host-bbbb.md"),
    block("bbbb", 1, "2026-08-18T00:00:00.000Z", "WORKFLOW_STARTED"),
  );
  writeFileSync(
    join(auditDir, "host-aaaa.md"),
    block("aaaa", 2, "2026-08-18T00:00:02.000Z", "STAGE_COMPLETED") +
      block("aaaa", 1, "2026-08-18T00:00:01.000Z", "STAGE_STARTED"),
  );
  assert.deepEqual(
    readOrderedAuditEntries(recordDir).map((entry) =>
      `${entry.cloneId}:${entry.sequence}:${entry.event}`
    ),
    [
      "aaaa:1:STAGE_STARTED",
      "aaaa:2:STAGE_COMPLETED",
      "bbbb:1:WORKFLOW_STARTED",
    ],
  );
});

test("concurrent processes cannot duplicate or reverse a shard sequence", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-audit-concurrent-"));
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "Audit concurrency", "default");
  const before = readOrderedAuditEntries(born.recordDir).length;
  const children = Array.from({ length: 6 }, (_value, index) => new Promise<void>(
    (accept, reject) => {
      const script = `import { appendAuditEntry } from "./core/tools/aidlc-audit.ts"; ` +
        `appendAuditEntry(${JSON.stringify(projectDir)}, ${JSON.stringify(born.recordDir)}, ` +
        `"DECISION_RECORDED", { Decision: ${JSON.stringify(String(index))} });`;
      const child = spawn(process.execPath, ["-e", script], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? accept() : reject(new Error(stderr || `child exited ${code}`))
      );
    }
  ));
  await Promise.all(children);
  const appended = readOrderedAuditEntries(born.recordDir)
    .filter((entry) => entry.event === "DECISION_RECORDED");
  assert.deepEqual(
    appended.map((entry) => entry.sequence),
    Array.from({ length: 6 }, (_value, index) => before + index + 1),
  );
});
