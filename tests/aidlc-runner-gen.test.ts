import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import {
  checkRunnerSkills,
  runnableStages,
  runnerScopes,
  writeRunnerSkills,
} from "../core/tools/aidlc-runner-gen.ts";

function freshSkillsDir(): string {
  return join(mkdtempSync(join(tmpdir(), "aidlc-runners-")), ".agents", "skills");
}

test("runner generator derives Stage, Scope, init, and main Codex Skills", () => {
  const skillsDir = freshSkillsDir();
  const result = writeRunnerSkills({ skillsDir });
  assert.equal(result.stageRunners.length, 29);
  assert.deepEqual(result.scopeRunners, [
    "aidlc-bugfix",
    "aidlc-feature",
    "aidlc-mvp",
    "aidlc-security-patch",
  ]);
  assert.equal(runnableStages().length, 29);
  assert.deepEqual(runnerScopes().map((scope) => scope.name), [
    "bugfix",
    "feature",
    "mvp",
    "security-patch",
  ]);
  assert.equal(existsSync(join(skillsDir, "aidlc", "SKILL.md")), true);
  assert.equal(existsSync(join(skillsDir, "aidlc", "question-rendering.md")), true);
  assert.equal(existsSync(join(skillsDir, "aidlc", "agents", "openai.yaml")), true);
  assert.equal(existsSync(join(skillsDir, "aidlc-init", "SKILL.md")), true);
  assert.equal(existsSync(join(skillsDir, "aidlc-state-init")), false);
  assert.equal(existsSync(join(skillsDir, "aidlc-workspace-detection")), false);
  assert.equal(existsSync(join(skillsDir, "aidlc-workspace-scaffold")), false);

  const stage = readFileSync(
    join(skillsDir, "aidlc-intent-capture", "SKILL.md"),
    "utf8",
  );
  assert.match(stage, /^name: aidlc-intent-capture$/m);
  assert.match(stage, /--stage intent-capture --single/);
  assert.match(stage, /report .*--single/);
  const scopeRunner = readFileSync(
    join(skillsDir, "aidlc-mvp", "SKILL.md"),
    "utf8",
  );
  assert.match(scopeRunner, /pnpm --dir \.codex run workspace init \.\./);
  assert.match(scopeRunner, /pnpm --dir \.codex run state resume \.\./);
  assert.equal(
    readFileSync(
      join(skillsDir, "aidlc-intent-capture", "agents", "openai.yaml"),
      "utf8",
    ),
    "policy:\n  allow_implicit_invocation: false\n",
  );

  for (const directory of [
    "aidlc",
    ...result.stageRunners,
    ...result.scopeRunners,
    "aidlc-init",
  ]) {
    const body = readFileSync(join(skillsDir, directory, "SKILL.md"), "utf8");
    assert.match(body, new RegExp(`^name: ${directory}$`, "m"));
    assert.match(body, /^description: \S.+$/m);
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    assert.deepEqual(
      frontmatter.split("\n").map((line) => line.split(":", 1)[0]),
      ["name", "description"],
    );
    assert.equal(basename(dirname(join(skillsDir, directory, "SKILL.md"))), directory);
  }
  const metadata = parseDocument(readFileSync(
    join(skillsDir, "aidlc", "agents", "openai.yaml"),
    "utf8",
  )).toJS() as Record<string, unknown>;
  assert.deepEqual(metadata, {
    interface: {
      display_name: "AI-DLC",
      short_description: "Run deterministic AI-DLC workflows in Codex",
      default_prompt: "Use $aidlc to start or resume this project workflow.",
    },
  });
  assert.equal(checkRunnerSkills({ skillsDir }).valid, true);
});

test("runner write is idempotent and check reports stale and orphaned runners", () => {
  const skillsDir = freshSkillsDir();
  writeRunnerSkills({ skillsDir });
  const stagePath = join(skillsDir, "aidlc-feasibility", "SKILL.md");
  writeFileSync(stagePath, "stale\n", "utf8");
  const orphan = join(skillsDir, "aidlc-orphan", "SKILL.md");
  mkdirSync(dirname(orphan), { recursive: true });
  writeFileSync(
    orphan,
    "---\nname: aidlc-orphan\ndescription: orphan\n---\n\n<!-- generated-by: aidlc-runner-gen -->\n",
    "utf8",
  );
  const unmanaged = join(skillsDir, "custom", "SKILL.md");
  mkdirSync(dirname(unmanaged), { recursive: true });
  writeFileSync(unmanaged, "---\nname: custom\ndescription: keep\n---\n", "utf8");

  const drift = checkRunnerSkills({ skillsDir });
  assert.equal(drift.valid, false);
  assert.deepEqual(drift.stale, ["aidlc-feasibility/SKILL.md"]);
  assert.deepEqual(drift.orphaned, ["aidlc-orphan"]);

  const rewritten = writeRunnerSkills({ skillsDir });
  assert.deepEqual(rewritten.prunedDirectories, [join(skillsDir, "aidlc-orphan")]);
  assert.equal(existsSync(unmanaged), true);
  assert.equal(checkRunnerSkills({ skillsDir }).valid, true);
  const first = readFileSync(stagePath, "utf8");
  writeRunnerSkills({ skillsDir });
  assert.equal(readFileSync(stagePath, "utf8"), first);
});
