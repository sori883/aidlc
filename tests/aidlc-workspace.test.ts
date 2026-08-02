import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

test("initializes the upstream-compatible default workspace shell", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-workspace-"));
  const result = initializeWorkspace(projectDir);

  assert.equal(result.workspaceDir, join(projectDir, "aidlc"));
  assert.equal(result.activeSpace, "default");
  assert.equal(
    readFileSync(join(projectDir, "aidlc", "active-space"), "utf8"),
    "default\n",
  );
  assert.equal(
    readFileSync(
      join(projectDir, "aidlc", "spaces", "default", "memory", "org.md"),
      "utf8",
    ),
    readFileSync("core/memory/org.md", "utf8"),
  );
  assert.ok(
    existsSync(
      join(
        projectDir,
        "aidlc",
        "spaces",
        "default",
        "memory",
        "phases",
        "construction.md",
      ),
    ),
  );
  assert.equal(
    existsSync(join(projectDir, "aidlc", "spaces", "default", "intents")),
    false,
  );
});

test("workspace initialization is idempotent and preserves user files", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-workspace-"));
  initializeWorkspace(projectDir);
  const activeSpacePath = join(projectDir, "aidlc", "active-space");
  const orgPath = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "memory",
    "org.md",
  );
  writeFileSync(activeSpacePath, "team-a\n", "utf8");
  writeFileSync(orgPath, "# Customized organization rules\n", "utf8");

  const result = initializeWorkspace(projectDir);

  assert.equal(result.activeSpace, "team-a");
  assert.equal(readFileSync(activeSpacePath, "utf8"), "team-a\n");
  assert.equal(
    readFileSync(orgPath, "utf8"),
    "# Customized organization rules\n",
  );
  assert.equal(result.createdFiles.length, 0);
  assert.ok(result.preservedFiles.includes(activeSpacePath));
  assert.ok(result.preservedFiles.includes(orgPath));
});

test("workspace initialization rejects a missing project directory", () => {
  const parent = mkdtempSync(join(tmpdir(), "aidlc-workspace-"));
  const missingProject = join(parent, "missing");
  assert.throws(
    () => initializeWorkspace(missingProject),
    /Project directory is not a directory/,
  );
});
