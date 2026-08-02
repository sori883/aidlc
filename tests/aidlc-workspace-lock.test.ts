import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  withWorkspaceLock,
  workspaceLockExists,
} from "../core/tools/aidlc-workspace-lock.ts";

test("workspace lock is held, reentrant, and released", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-lock-project-"));
  assert.equal(workspaceLockExists(projectDir), false);

  const result = withWorkspaceLock(projectDir, () => {
    assert.equal(workspaceLockExists(projectDir), true);
    return withWorkspaceLock(projectDir, () => {
      assert.equal(workspaceLockExists(projectDir), true);
      return "done";
    });
  });

  assert.equal(result, "done");
  assert.equal(workspaceLockExists(projectDir), false);
});

test("workspace lock rejects a competing live owner", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-lock-project-"));
  const handle = acquireWorkspaceLock(projectDir);
  try {
    assert.throws(
      () => acquireWorkspaceLock(projectDir, { maxRetries: 0 }),
      /Failed to acquire workspace lock/,
    );
  } finally {
    releaseWorkspaceLock(handle);
  }
  assert.equal(workspaceLockExists(projectDir), false);
});

test("workspace lock is released when a mutation throws", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-lock-project-"));
  assert.throws(
    () => withWorkspaceLock(projectDir, () => {
      throw new Error("mutation failed");
    }),
    /mutation failed/,
  );
  assert.equal(workspaceLockExists(projectDir), false);
});
