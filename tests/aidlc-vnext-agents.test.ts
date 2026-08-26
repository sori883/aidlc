import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadVNextDelegationCatalog } from "../core/tools/aidlc-vnext-delegation-contract.ts";

const root = resolve(import.meta.dir, "..");

function assignedAgents(): string[] {
  const catalog = loadVNextDelegationCatalog();
  const agents = new Set<string>();
  for (const stage of catalog.stages) {
    for (const assignment of [stage.work_assignment, stage.review_assignment]) {
      if (assignment === null) continue;
      agents.add(assignment.lead_agent);
      assignment.support_agents.forEach((agent) => agents.add(agent));
      if (assignment.reviewer_agent !== null) agents.add(assignment.reviewer_agent);
    }
  }
  return [...agents].sort();
}

test("defines every delegated vNext role as a Codex custom Agent", () => {
  const expected = assignedAgents();
  assert.equal(expected.length, 9);
  for (const name of expected) {
    const personaPath = join(root, "core", "agents", `${name}.md`);
    const configPath = join(root, "harness", "codex", "agents", `${name}.toml`);
    assert.equal(existsSync(personaPath), true, personaPath);
    assert.equal(existsSync(configPath), true, configPath);

    const persona = readFileSync(personaPath, "utf8");
    const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(config.name, name);
    assert.equal("model" in config, false, `${name} must inherit the parent model`);
    assert.match(String(config.developer_instructions), /\$aidlc-stage-work/);
    assert.match(String(config.developer_instructions), /must not spawn|Do not spawn/i);
    assert.match(String(config.developer_instructions), new RegExp(`\\.codex/agents/${name}\\.md`));
    assert.match(persona, /Core owns|Core-owned/);
    assert.doesNotMatch(persona, /TODO|PLACEHOLDER/);
  }
});

test("defines a narrowly routed shared Stage Worker Skill", () => {
  const path = join(root, "harness", "codex", "skills", "aidlc-stage-work", "SKILL.md");
  assert.equal(existsSync(path), true, path);
  const skill = readFileSync(path, "utf8");
  assert.match(skill, /^---\nname: aidlc-stage-work\n/m);
  assert.match(skill, /delegated AI-DLC vNext Stage/i);
  assert.match(skill, /proposal-only/);
  assert.match(skill, /assigned-worktree/);
  assert.match(skill, /read-only/);
  assert.match(skill, /task-matched/i);
  assert.match(skill, /Never run.*next|Do not run.*next/is);
  assert.match(skill, /must not spawn|never spawn/i);
  assert.doesNotMatch(skill, /TODO|PLACEHOLDER/);
});
