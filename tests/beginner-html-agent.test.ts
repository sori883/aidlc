import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const agentPath = join(
  projectRoot,
  ".codex",
  "agents",
  "beginner-html-writer.toml",
);
const skillPath = join(
  projectRoot,
  ".agents",
  "skills",
  "beginner-html",
  "SKILL.md",
);
const harnessAgentPath = join(
  projectRoot,
  "harness",
  "codex",
  "agents",
  "beginner-html-writer.toml",
);
const harnessSkillPath = join(
  projectRoot,
  "harness",
  "codex",
  "skills",
  "beginner-html",
  "SKILL.md",
);
const harnessInstructionsPath = join(
  projectRoot,
  "harness",
  "codex",
  "AGENTS.md",
);

test("defines a project-scoped beginner HTML custom agent", () => {
  assert.equal(existsSync(agentPath), true, agentPath);

  const config = Bun.TOML.parse(readFileSync(agentPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(config.name, "beginner_html_writer");
  assert.equal(typeof config.description, "string");
  assert.equal(config.sandbox_mode, "workspace-write");
  assert.equal("model" in config, false, "agent must inherit the parent model");

  const instructions = String(config.developer_instructions);
  assert.match(instructions, /\$beginner-html/);
  assert.match(instructions, /source of truth/i);
  assert.match(instructions, /mobile.*desktop|desktop.*mobile/i);
  assert.match(instructions, /runtime.*contract.*JSON/is);
});

test("defines a reusable and narrowly routed beginner HTML skill", () => {
  assert.equal(existsSync(skillPath), true, skillPath);

  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /^---\nname: beginner-html\n/m);
  assert.match(skill, /beginner-facing HTML documentation/i);
  assert.match(skill, /source of truth/i);
  assert.match(skill, /single-file HTML/i);
  assert.match(skill, /390px/);
  assert.match(skill, /scrollWidth\s*<=\s*clientWidth/);
  assert.match(skill, /escape/i);
  assert.match(skill, /Runtime, Contract, or canonical JSON/i);
  assert.doesNotMatch(skill, /TODO|PLACEHOLDER/i);
});

test("keeps the beginner HTML helper out of the distributable Codex Harness", () => {
  assert.equal(existsSync(harnessAgentPath), false, harnessAgentPath);
  assert.equal(existsSync(harnessSkillPath), false, harnessSkillPath);
});

test("does not route installed projects to the development-only HTML helper", () => {
  const instructions = readFileSync(harnessInstructionsPath, "utf8");
  assert.doesNotMatch(instructions, /beginner_html_writer/);
  assert.doesNotMatch(instructions, /Beginner-facing HTML delegation/);
});
