import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  loadAgents,
  RESERVED_AGENT_NAMES,
  validateStageAgentReferences,
} from "../core/tools/aidlc-agent-loader.ts";
import { loadStages } from "../core/tools/aidlc-stage-loader.ts";

const AGENT_MARKDOWN = `---
name: sample-agent
display_name: Sample Agent
description: A sample agent used by tests.
disallowedTools: Task
tier: balanced
---

# Role

Perform the assigned work.
`;

test("loads all real agent definitions", () => {
  const agents = loadAgents();
  assert.equal(agents.length, 14);
  const composer = agents.find((agent) => agent.name === "aidlc-composer-agent");
  assert.ok(composer);
  assert.equal(composer.tier, "judgment");
  assert.ok(composer.instructions.length > 0);
});

test("validates every stage agent reference", () => {
  const stages = loadStages();
  const agents = loadAgents();
  assert.doesNotThrow(() => validateStageAgentReferences(stages, agents));
  assert.ok(RESERVED_AGENT_NAMES.has("orchestrator"));
});

test("rejects an unknown lead agent", () => {
  const stages = loadStages();
  const agents = loadAgents().filter(
    (agent) => agent.name !== "aidlc-product-agent",
  );
  assert.throws(
    () => validateStageAgentReferences(stages, agents),
    /unknown lead_agent "aidlc-product-agent"/,
  );
});

test("rejects a filename that differs from the agent name", () => {
  const agentsDir = mkdtempSync(join(tmpdir(), "aidlc-agents-"));
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "wrong-name.md"), AGENT_MARKDOWN);
  assert.throws(
    () => loadAgents(agentsDir),
    /filename must match agent name "sample-agent"/,
  );
});
