import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WORKSPACE_LOCK_SENTINEL = "__workspace__";
const DEFAULT_STALE_MS = 10 * 60 * 1000;
const UNSTAMPED_GRACE_MS = 5_000;

interface LockOwner {
  pid: number;
  acquiredAtMs: number;
  token: string;
}

export interface WorkspaceLockOptions {
  maxRetries?: number;
  retryMs?: number;
  staleMs?: number;
}

export interface WorkspaceLockHandle {
  lockDir: string;
  token: string;
}

interface HeldLock extends WorkspaceLockHandle {
  depth: number;
  exitHandler: () => void;
}

const heldLocks = new Map<string, HeldLock>();

function lockIdentity(projectDir: string): string {
  return `${resolve(projectDir)}\0${WORKSPACE_LOCK_SENTINEL}`;
}

export function workspaceLockDir(projectDir: string): string {
  const hash = createHash("md5")
    .update(lockIdentity(projectDir))
    .digest("hex")
    .slice(0, 8);
  return join(tmpdir(), `.aidlc-audit-${hash}.lock`);
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(lockDir, "owner.json"), "utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      "acquiredAtMs" in value &&
      "token" in value &&
      typeof value.pid === "number" &&
      typeof value.acquiredAtMs === "number" &&
      typeof value.token === "string"
    ) {
      return {
        pid: value.pid,
        acquiredAtMs: value.acquiredAtMs,
        token: value.token,
      };
    }
  } catch {
    // An unstamped lock is handled using its directory age.
  }
  return null;
}

function ownerIsAlive(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function lockAgeMs(lockDir: string): number | null {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

function sameOwner(a: LockOwner | null, b: LockOwner | null): boolean {
  if (a === null || b === null) return a === b;
  return a.pid === b.pid && a.acquiredAtMs === b.acquiredAtMs && a.token === b.token;
}

function tryReapLock(lockDir: string, staleMs: number): boolean {
  const judgedOwner = readOwner(lockDir);
  if (judgedOwner === null) {
    const age = lockAgeMs(lockDir);
    if (age === null || age <= UNSTAMPED_GRACE_MS) return false;
  } else if (ownerIsAlive(judgedOwner)) {
    if (Date.now() - judgedOwner.acquiredAtMs <= staleMs) return false;
  }

  const moved = `${lockDir}.dead.${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockDir, moved);
  } catch {
    return false;
  }
  if (!sameOwner(readOwner(moved), judgedOwner)) {
    try {
      renameSync(moved, lockDir);
    } catch {
      rmSync(moved, { recursive: true, force: true });
    }
    return false;
  }
  rmSync(moved, { recursive: true, force: true });
  return true;
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function acquireWorkspaceLock(
  projectDir: string,
  options: WorkspaceLockOptions = {},
): WorkspaceLockHandle {
  const lockDir = workspaceLockDir(projectDir);
  const maxRetries = options.maxRetries ?? 50;
  const retryMs = options.retryMs ?? 100;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const token = randomUUID();
    try {
      mkdirSync(lockDir);
      const owner: LockOwner = {
        pid: process.pid,
        acquiredAtMs: Date.now(),
        token,
      };
      try {
        writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner), "utf8");
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      return { lockDir, token };
    } catch (error) {
      const alreadyExists =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST";
      if (!alreadyExists) throw error;
      if (tryReapLock(lockDir, staleMs)) continue;
      if (attempt < maxRetries) sleepSync(retryMs);
    }
  }
  throw new Error(`Failed to acquire workspace lock: ${lockDir}`);
}

export function releaseWorkspaceLock(handle: WorkspaceLockHandle): void {
  const owner = readOwner(handle.lockDir);
  if (owner?.token !== handle.token) return;
  rmSync(handle.lockDir, { recursive: true, force: true });
}

/** Run a synchronous Workspace mutation under a reentrant process lock. */
export function withWorkspaceLock<T>(
  projectDir: string,
  operation: () => T,
  options: WorkspaceLockOptions = {},
): T {
  const identity = lockIdentity(projectDir);
  const existing = heldLocks.get(identity);
  if (existing !== undefined) {
    existing.depth += 1;
    try {
      return operation();
    } finally {
      existing.depth -= 1;
    }
  }

  const handle = acquireWorkspaceLock(projectDir, options);
  const exitHandler = () => releaseWorkspaceLock(handle);
  heldLocks.set(identity, { ...handle, depth: 1, exitHandler });
  process.on("exit", exitHandler);
  try {
    return operation();
  } finally {
    const held = heldLocks.get(identity);
    heldLocks.delete(identity);
    process.off("exit", held?.exitHandler ?? exitHandler);
    releaseWorkspaceLock(handle);
  }
}

/** Run an asynchronous Workspace mutation under the same reentrant process lock. */
export async function withWorkspaceLockAsync<T>(
  projectDir: string,
  operation: () => Promise<T>,
  options: WorkspaceLockOptions = {},
): Promise<T> {
  const identity = lockIdentity(projectDir);
  const existing = heldLocks.get(identity);
  if (existing !== undefined) {
    existing.depth += 1;
    try {
      return await operation();
    } finally {
      existing.depth -= 1;
    }
  }

  const handle = acquireWorkspaceLock(projectDir, options);
  const exitHandler = () => releaseWorkspaceLock(handle);
  heldLocks.set(identity, { ...handle, depth: 1, exitHandler });
  process.on("exit", exitHandler);
  try {
    return await operation();
  } finally {
    const held = heldLocks.get(identity);
    heldLocks.delete(identity);
    process.off("exit", held?.exitHandler ?? exitHandler);
    releaseWorkspaceLock(handle);
  }
}

export function workspaceLockExists(projectDir: string): boolean {
  return existsSync(workspaceLockDir(projectDir));
}
