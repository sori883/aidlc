import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  createSpace,
  listSpaces,
  switchSpace,
} from "../core/tools/aidlc-space.ts";
import {
  activeSpace,
  initializeWorkspace,
} from "../core/tools/aidlc-workspace.ts";

test("creates the full upstream additional-space shape", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-space-"));
  initializeWorkspace(projectDir);
  const result = createSpace(projectDir, "Team A");

  assert.equal(result.name, "team-a");
  assert.equal(activeSpace(projectDir), "default");
  assert.equal(
    readFileSync(join(result.spaceDir, "memory", "org.md"), "utf8"),
    readFileSync(
      join(projectDir, "aidlc", "spaces", "default", "memory", "org.md"),
      "utf8",
    ),
  );
  assert.equal(
    readFileSync(join(result.spaceDir, "memory", "team.md"), "utf8"),
    readFileSync(
      join(projectDir, "aidlc", "spaces", "default", "memory", "team.md"),
      "utf8",
    ),
  );
  assert.equal(
    readFileSync(join(result.spaceDir, "memory", "project.md"), "utf8"),
    readFileSync(
      join(projectDir, "aidlc", "spaces", "default", "memory", "project.md"),
      "utf8",
    ),
  );
  for (const relativePath of [
    "memory/phases/ideation.md",
    "memory/phases/inception.md",
    "memory/phases/construction.md",
    "memory/phases/operation.md",
    "memory/templates/.gitkeep",
    "intents",
    "codekb/.gitkeep",
    "knowledge/.gitkeep",
  ]) {
    assert.ok(existsSync(join(result.spaceDir, relativePath)), relativePath);
  }
});

test("switches to an existing normalized space", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-space-"));
  initializeWorkspace(projectDir);
  createSpace(projectDir, "Team A");

  assert.deepEqual(switchSpace(projectDir, "Team A"), {
    name: "team-a",
    active: true,
  });
  assert.equal(activeSpace(projectDir), "team-a");
  assert.deepEqual(listSpaces(projectDir), [
    { name: "default", active: false },
    { name: "team-a", active: true },
  ]);
});

test("space creation and switching reject invalid targets", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-space-"));
  initializeWorkspace(projectDir);
  assert.throws(() => createSpace(projectDir, "switch"), /reserved name/);
  assert.throws(() => createSpace(projectDir, "default"), /already exists/);
  assert.throws(() => switchSpace(projectDir, "missing"), /Unknown space/);
});
