import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";
import {
  boltWorktreePath,
  createWorktree,
  discardWorktree,
  listWorktrees,
  mergeWorktree,
  verifyWorktreeEvent,
  worktreeInfo,
  type MergeStrategy,
} from "../core/tools/aidlc-worktree.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function pathKey(path: string): string {
  const canonical = realpathSync(path).replaceAll("\\", "/");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function fixture(): {
  projectDir: string;
  auditPath: string;
  planPath: string;
  statePath: string;
} {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-worktree-"));
  git(projectDir, "init", "-b", "main");
  git(projectDir, "config", "user.email", "aidlc@example.test");
  git(projectDir, "config", "user.name", "AI-DLC Test");
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "Worktree test", "default", "mvp");
  writeFileSync(join(projectDir, "app.txt"), "base\n", "utf8");
  git(projectDir, "add", ".");
  git(projectDir, "commit", "-m", "initial");
  const remote = mkdtempSync(join(tmpdir(), "aidlc-worktree-remote-"));
  git(remote, "init", "--bare");
  git(projectDir, "remote", "add", "origin", remote);
  git(projectDir, "push", "-u", "origin", "main");
  return {
    projectDir,
    auditPath: born.auditPath,
    planPath: born.state.planPath,
    statePath: born.state.statePath,
  };
}

test("worktree CLI creates, validates, lists, describes, and idempotently discards", () => {
  const { projectDir, auditPath, planPath, statePath } = fixture();
  const beforePlan = readFileSync(planPath, "utf8");
  const beforeState = readFileSync(statePath, "utf8");
  const created = spawnSync(
    process.execPath,
    [
      "core/tools/aidlc-worktree.ts",
      "create",
      "--project-dir",
      projectDir,
      "--slug",
      "payment-api",
      "--base",
      "main",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  const payload = JSON.parse(created.stdout) as Record<string, unknown>;
  const path = boltWorktreePath(projectDir, "payment-api");
  assert.equal(payload.worktree_path, path);
  assert.equal(existsSync(path), true);

  const validated = spawnSync(
    process.execPath,
    [
      "core/tools/aidlc-worktree.ts",
      "validate",
      "--project-dir",
      projectDir,
      "--slug",
      "payment-api",
      "--event",
      "WORKTREE_CREATED",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).verified, true);
  const listed = listWorktrees({ projectDir }).worktrees as Array<{
    slug: string;
    worktree_path: string;
    branch: string;
  }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.slug, "payment-api");
  assert.equal(listed[0]?.branch, "bolt-payment-api");
  assert.equal(pathKey(listed[0]!.worktree_path), pathKey(path));
  const info = worktreeInfo({ projectDir, slug: "payment-api" });
  assert.equal(pathKey(String(info.path)), pathKey(path));

  assert.equal(discardWorktree({ projectDir, slug: "payment-api" }).emitted,
    "WORKTREE_DISCARDED");
  assert.equal(existsSync(path), false);
  assert.equal(
    verifyWorktreeEvent({
      projectDir,
      slug: "payment-api",
      event: "WORKTREE_DISCARDED",
    }).verified,
    true,
  );
  assert.equal(discardWorktree({ projectDir, slug: "payment-api" }).reason,
    "already-discarded");
  assert.deepEqual(listWorktrees({ projectDir }).worktrees, []);
  const audit = readFileSync(auditPath, "utf8");
  assert.match(audit, /\*\*Event\*\*: WORKTREE_CREATED/);
  assert.match(audit, /\*\*Event\*\*: WORKTREE_DISCARDED/);
  assert.equal(readFileSync(planPath, "utf8"), beforePlan);
  assert.equal(readFileSync(statePath, "utf8"), beforeState);
});

for (const strategy of ["squash", "merge", "rebase"] as const) {
  test(`worktree ${strategy} lands the Bolt commit and removes its branch`, () => {
    const { projectDir, auditPath, planPath, statePath } = fixture();
    const beforePlan = readFileSync(planPath, "utf8");
    const beforeState = readFileSync(statePath, "utf8");
    const slug = `${strategy}-change`;
    createWorktree({ projectDir, slug, base: "main" });
    const path = boltWorktreePath(projectDir, slug);
    writeFileSync(join(path, `${strategy}.txt`), `${strategy}\n`, "utf8");
    git(path, "add", ".");
    git(path, "commit", "-m", `${strategy} change`);

    const merged = mergeWorktree({
      projectDir,
      slug,
      target: "main",
      strategy: strategy as MergeStrategy,
    });
    assert.equal(merged.emitted, "WORKTREE_MERGED");
    assert.equal(readFileSync(join(projectDir, `${strategy}.txt`), "utf8"), `${strategy}\n`);
    assert.equal(existsSync(path), false);
    assert.notEqual(
      spawnSync("git", ["rev-parse", "--verify", `refs/heads/bolt-${slug}`], {
        cwd: projectDir,
      }).status,
      0,
    );
    assert.equal(
      verifyWorktreeEvent({
        projectDir,
        slug,
        event: "WORKTREE_MERGED",
      }).verified,
      true,
    );
    assert.match(readFileSync(auditPath, "utf8"), /\*\*Event\*\*: WORKTREE_MERGED/);
    assert.equal(readFileSync(planPath, "utf8"), beforePlan);
    assert.equal(readFileSync(statePath, "utf8"), beforeState);
  });
}

test("merge conflict preserves the Worktree and reports conflicting files", () => {
  const { projectDir } = fixture();
  createWorktree({ projectDir, slug: "conflicting", base: "main" });
  const path = boltWorktreePath(projectDir, "conflicting");

  writeFileSync(join(projectDir, "app.txt"), "main change\n", "utf8");
  git(projectDir, "add", "app.txt");
  git(projectDir, "commit", "-m", "main change");
  writeFileSync(join(path, "app.txt"), "bolt change\n", "utf8");
  git(path, "add", "app.txt");
  git(path, "commit", "-m", "bolt change");

  const conflict = mergeWorktree({
    projectDir,
    slug: "conflicting",
    target: "main",
    strategy: "merge",
  });
  assert.equal(conflict.status, "conflict");
  assert.deepEqual(conflict.conflict_files, ["app.txt"]);
  assert.equal(existsSync(path), true);
  git(projectDir, "merge", "--abort");
  discardWorktree({ projectDir, slug: "conflicting" });
});

test("worktree rejects unsafe slugs and a sibling checkout as the project root", () => {
  const { projectDir } = fixture();
  assert.throws(
    () => createWorktree({ projectDir, slug: "../escape", base: "main" }),
    /Invalid --slug/,
  );
  createWorktree({ projectDir, slug: "sibling", base: "main" });
  const path = boltWorktreePath(projectDir, "sibling");
  assert.throws(
    () => createWorktree({ projectDir: path, slug: "nested", base: "main" }),
    /main checkout/,
  );
  discardWorktree({ projectDir, slug: "sibling" });
});
