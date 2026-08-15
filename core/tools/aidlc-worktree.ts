// Deterministic Construction Worktree lifecycle. Mutating commands emit their
// audit intent before invoking Git, matching upstream AI-DLC v2 semantics.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { appendAuditEntry, type AuditEvent } from "./aidlc-audit.ts";
import { activeIntent, readIntentRegistry } from "./aidlc-intent.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import {
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";

const WORKTREE_CLI_CONTRACT = loadCliContract("aidlc-worktree.ts");
const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERIFY_EVENTS = [
  "WORKTREE_CREATED",
  "WORKTREE_MERGED",
  "WORKTREE_DISCARDED",
] as const;

export type WorktreeEvent = (typeof VERIFY_EVENTS)[number];
export type MergeStrategy = "squash" | "merge" | "rebase";

export interface WorktreeOptions {
  projectDir: string;
  slug: string;
  repo?: string;
  intent?: string;
  space?: string;
}

export interface CreateWorktreeOptions extends WorktreeOptions {
  base: string;
}

export interface MergeWorktreeOptions extends WorktreeOptions {
  target: string;
  strategy: MergeStrategy;
  message?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface AuditMatch {
  timestamp: string;
  block: string;
}

function runGit(args: readonly string[], cwd: string): GitResult {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, EDITOR: process.env.EDITOR ?? "false" },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

function gitDetail(result: GitResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pathKey(path: string): string {
  const normalized = canonical(path).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validateSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid --slug: "${slug}". Must be kebab-case beginning with a letter.`,
    );
  }
  return slug;
}

function selectedIntentRecordDir(options: WorktreeOptions): string {
  const projectRoot = resolve(options.projectDir);
  const space = options.space ?? activeSpace(projectRoot);
  const intent = options.intent ?? activeIntent(projectRoot, space);
  if (intent === null || intent.trim() === "") {
    throw new Error(`No active intent in space "${space}".`);
  }
  const recordDir = join(
    workspaceRoot(projectRoot),
    "spaces",
    space,
    "intents",
    intent,
  );
  if (!existsSync(join(recordDir, "aidlc-state.md"))) {
    throw new Error(`Intent record does not exist: ${recordDir}`);
  }
  return recordDir;
}

function recordedRepos(options: WorktreeOptions): string[] {
  const projectRoot = resolve(options.projectDir);
  const space = options.space ?? activeSpace(projectRoot);
  const intent = options.intent ?? activeIntent(projectRoot, space);
  if (intent === null) return [];
  return readIntentRegistry(projectRoot, space)
    .find((entry) => entry.dirName === intent)?.repos
    ?.map((repo) => repo.trim())
    .filter(Boolean) ?? [];
}

function repoDirectory(options: WorktreeOptions): string {
  const projectRoot = resolve(options.projectDir);
  const repos = recordedRepos(options);
  if (options.repo !== undefined) {
    validateSlug(options.repo);
    if (repos.length > 0 && !repos.includes(options.repo)) {
      throw new Error(
        `Repository "${options.repo}" is not recorded by the selected Intent.`,
      );
    }
    if (repos.length === 0 && basename(projectRoot) === options.repo) {
      return projectRoot;
    }
    return join(projectRoot, options.repo);
  }
  if (repos.length > 1) {
    throw new Error(
      `Intent records multiple repositories (${repos.join(", ")}); use --repo <name>.`,
    );
  }
  return repos.length === 1 ? join(projectRoot, repos[0]!) : projectRoot;
}

function assertMainCheckout(repoDir: string): void {
  const top = runGit(["rev-parse", "--show-toplevel"], repoDir);
  if (!top.ok) throw new Error(`Not a Git repository: ${repoDir}`);
  const topLevel = canonical(top.stdout.trim());
  const common = runGit(["rev-parse", "--git-common-dir"], repoDir);
  if (!common.ok) throw new Error(`Cannot resolve Git common directory: ${repoDir}`);
  const commonPath = common.stdout.trim();
  const commonAbsolute = canonical(
    isAbsolute(commonPath) ? commonPath : resolve(topLevel, commonPath),
  );
  const mainCheckout = canonical(dirname(commonAbsolute));
  if (pathKey(topLevel) !== pathKey(mainCheckout)) {
    throw new Error(
      `aidlc-worktree must run against the main checkout, not sibling worktree ${topLevel}.`,
    );
  }
}

export function boltWorktreePath(projectDir: string, slug: string): string {
  return join(resolve(projectDir), ".aidlc", "worktrees", `bolt-${validateSlug(slug)}`);
}

function emitWorktreeAudit(
  options: WorktreeOptions,
  event: WorktreeEvent,
  fields: Record<string, string>,
): string {
  const result = appendAuditEntry(
    resolve(options.projectDir),
    selectedIntentRecordDir(options),
    event as AuditEvent,
    fields,
  );
  return result.timestamp;
}

export function createWorktree(options: CreateWorktreeOptions): Record<string, unknown> {
  const slug = validateSlug(options.slug);
  if (options.base.trim() === "") throw new Error("Missing --base <branch>.");
  const repoDir = repoDirectory(options);
  assertMainCheckout(repoDir);
  const base = runGit(["rev-parse", "--verify", options.base], repoDir);
  if (!base.ok) throw new Error(`Base branch does not exist locally: ${options.base}`);
  const path = boltWorktreePath(options.projectDir, slug);
  const branch = `bolt-${slug}`;
  if (existsSync(path)) throw new Error(`Worktree directory already exists: ${path}`);
  if (runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoDir).ok) {
    throw new Error(`Branch already exists: ${branch}`);
  }
  const timestamp = emitWorktreeAudit(options, "WORKTREE_CREATED", {
    "Bolt slug": slug,
    "Worktree path": path,
    "Branch name": branch,
    "Base branch": options.base,
  });
  const added = runGit(["worktree", "add", path, "-b", branch, options.base], repoDir);
  if (!added.ok) throw new Error(`git worktree add failed: ${gitDetail(added)}`);
  return {
    emitted: "WORKTREE_CREATED",
    slug,
    worktree_path: path,
    branch,
    base: options.base,
    audit_timestamp: timestamp,
  };
}

function conflictFiles(cwd: string): string[] {
  const result = runGit(["diff", "--name-only", "--diff-filter=U"], cwd);
  return result.ok
    ? result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
}

function isConflict(result: GitResult): boolean {
  return /^CONFLICT \(/m.test(`${result.stdout}\n${result.stderr}`);
}

export function mergeWorktree(options: MergeWorktreeOptions): Record<string, unknown> {
  const slug = validateSlug(options.slug);
  if (options.target.trim() === "") throw new Error("Missing --target <branch>.");
  if (!["squash", "merge", "rebase"].includes(options.strategy)) {
    throw new Error(`Invalid --strategy: "${options.strategy}".`);
  }
  const repoDir = repoDirectory(options);
  assertMainCheckout(repoDir);
  const head = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
  if (!head.ok || head.stdout.trim() !== options.target) {
    throw new Error(
      `Expected target branch "${options.target}" checked out; found ` +
        `"${head.stdout.trim() || "unknown"}".`,
    );
  }
  const path = boltWorktreePath(options.projectDir, slug);
  const branch = `bolt-${slug}`;
  if (!existsSync(path)) throw new Error(`Worktree directory does not exist: ${path}`);
  if (!runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoDir).ok) {
    throw new Error(`Branch does not exist: ${branch}`);
  }

  let remote = "";
  if (options.strategy === "rebase") {
    const configured = runGit(["config", `branch.${options.target}.remote`], repoDir);
    remote = configured.stdout.trim();
    if (!configured.ok || remote === "") {
      throw new Error(`rebase strategy requires a remote for ${options.target}.`);
    }
  }
  const timestamp = emitWorktreeAudit(options, "WORKTREE_MERGED", {
    "Bolt slug": slug,
    "Worktree path": path,
    "Target branch": options.target,
    Strategy: options.strategy,
  });
  if (options.strategy === "rebase") {
    const fetched = runGit(["fetch", remote], path);
    if (!fetched.ok) throw new Error(`git fetch failed: ${gitDetail(fetched)}`);
  }

  let operation: GitResult;
  let conflictCwd = repoDir;
  if (options.strategy === "squash") {
    operation = runGit(["merge", "--squash", branch], repoDir);
  } else if (options.strategy === "merge") {
    operation = runGit(
      ["merge", "--no-ff", "--no-edit", "-m", `Merge bolt ${slug}`, branch],
      repoDir,
    );
  } else {
    conflictCwd = path;
    operation = runGit(["rebase", options.target], path);
  }
  if (!operation.ok) {
    if (isConflict(operation)) {
      return {
        status: "conflict",
        slug,
        worktree_path: path,
        conflict_files: conflictFiles(conflictCwd),
        detail: `Merge produced conflicts; worktree preserved at ${path}.`,
      };
    }
    throw new Error(`git ${options.strategy} failed: ${gitDetail(operation)}`);
  }

  if (options.strategy === "squash") {
    const committed = runGit(
      ["commit", "--no-edit", "-m", options.message ?? `Bolt ${slug}`],
      repoDir,
    );
    if (!committed.ok) throw new Error(`git commit failed: ${gitDetail(committed)}`);
  } else if (options.strategy === "rebase") {
    const fastForward = runGit(["merge", "--ff-only", branch], repoDir);
    if (!fastForward.ok) {
      throw new Error(`git merge --ff-only failed: ${gitDetail(fastForward)}`);
    }
  }
  const sha = runGit(["rev-parse", "HEAD"], repoDir).stdout.trim();
  const removed = runGit(["worktree", "remove", path], repoDir);
  if (!removed.ok) {
    throw new Error(`[merge-succeeded:${sha}] worktree remove failed: ${gitDetail(removed)}`);
  }
  const deleted = runGit(["branch", "-D", branch], repoDir);
  if (!deleted.ok) {
    throw new Error(`[merge-succeeded:${sha}] branch deletion failed: ${gitDetail(deleted)}`);
  }
  return {
    emitted: "WORKTREE_MERGED",
    slug,
    worktree_path: path,
    target: options.target,
    strategy: options.strategy,
    commit_sha: sha,
    audit_timestamp: timestamp,
  };
}

export function discardWorktree(options: WorktreeOptions): Record<string, unknown> {
  const slug = validateSlug(options.slug);
  const repoDir = repoDirectory(options);
  assertMainCheckout(repoDir);
  const path = boltWorktreePath(options.projectDir, slug);
  const branch = `bolt-${slug}`;
  const directoryExists = existsSync(path);
  const branchExists = runGit(
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    repoDir,
  ).ok;
  if (!directoryExists && !branchExists) {
    return { emitted: null, slug, worktree_path: path, reason: "already-discarded" };
  }
  const timestamp = emitWorktreeAudit(options, "WORKTREE_DISCARDED", {
    "Bolt slug": slug,
    "Worktree path": path,
    Reason: "agent-discard",
  });
  if (directoryExists) {
    const removed = runGit(["worktree", "remove", "--force", path], repoDir);
    if (!removed.ok) throw new Error(`git worktree remove failed: ${gitDetail(removed)}`);
  }
  if (branchExists) {
    const deleted = runGit(["branch", "-D", branch], repoDir);
    if (!deleted.ok) throw new Error(`branch deletion failed: ${gitDetail(deleted)}`);
  }
  return {
    emitted: "WORKTREE_DISCARDED",
    slug,
    worktree_path: path,
    reason: "agent-discard",
    audit_timestamp: timestamp,
  };
}

function auditText(options: WorktreeOptions): string {
  const directory = join(selectedIntentRecordDir(options), "audit");
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => readFileSync(join(directory, name), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

function auditField(block: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\*\\*${escaped}\\*\\*:\\s*(.*?)\\s*$`, "m")
    .exec(block)?.[1] ?? null;
}

function latestEvent(
  options: WorktreeOptions,
  event: WorktreeEvent,
): AuditMatch | null {
  const matches = auditText(options)
    .split(/^---\s*$/m)
    .filter((block) =>
      auditField(block, "Event") === event &&
      auditField(block, "Bolt slug") === options.slug
    )
    .map((block) => ({ timestamp: auditField(block, "Timestamp") ?? "", block }))
    .filter((match) => !Number.isNaN(Date.parse(match.timestamp)))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return matches.at(-1) ?? null;
}

export function verifyWorktreeEvent(
  options: WorktreeOptions & { event: WorktreeEvent; maxAgeSeconds?: number },
): Record<string, unknown> {
  validateSlug(options.slug);
  if (!VERIFY_EVENTS.includes(options.event)) {
    throw new Error(`Invalid worktree event: ${String(options.event)}`);
  }
  const maxAge = options.maxAgeSeconds ?? 60;
  if (!Number.isFinite(maxAge) || maxAge < 0) {
    throw new Error(`Invalid --max-age-seconds: ${String(maxAge)}`);
  }
  const match = latestEvent(options, options.event);
  if (match === null) {
    return { verified: false, event: options.event, slug: options.slug, reason: "absent" };
  }
  if (Date.now() - Date.parse(match.timestamp) > maxAge * 1000) {
    return {
      verified: false,
      event: options.event,
      slug: options.slug,
      reason: `stale (last seen ${match.timestamp})`,
    };
  }
  return {
    verified: true,
    event: options.event,
    slug: options.slug,
    audit_timestamp: match.timestamp,
  };
}

export function worktreeInfo(options: WorktreeOptions): Record<string, unknown> {
  validateSlug(options.slug);
  const match = latestEvent(options, "WORKTREE_CREATED");
  if (match === null) {
    throw new Error(`No WORKTREE_CREATED audit entry for slug ${options.slug}.`);
  }
  const path = auditField(match.block, "Worktree path");
  const branch = auditField(match.block, "Branch name");
  if (path === null || branch === null) {
    throw new Error(`Malformed WORKTREE_CREATED audit entry for ${options.slug}.`);
  }
  return {
    slug: options.slug,
    path,
    branch_name: branch,
    audit_timestamp: match.timestamp,
    merge_held: false,
  };
}

export function listWorktrees(options: Omit<WorktreeOptions, "slug">): Record<string, unknown> {
  const repoDir = repoDirectory({ ...options, slug: "list" });
  const result = runGit(["worktree", "list", "--porcelain"], repoDir);
  if (!result.ok) throw new Error(`git worktree list failed: ${gitDetail(result)}`);
  const owned = pathKey(join(resolve(options.projectDir), ".aidlc", "worktrees"));
  const worktrees: Array<{ slug: string; worktree_path: string; branch: string }> = [];
  let path = "";
  let branch = "";
  const flush = (): void => {
    if (path === "") return;
    if (pathKey(dirname(path)) === owned && basename(path).startsWith("bolt-")) {
      worktrees.push({
        slug: basename(path).slice("bolt-".length),
        worktree_path: path,
        branch,
      });
    }
    path = "";
    branch = "";
  };
  for (const line of `${result.stdout}\n`.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "") flush();
  }
  return { worktrees };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function commonOptions(args: readonly string[]): WorktreeOptions {
  const repo = flagValue(args, "--repo");
  const intent = flagValue(args, "--intent");
  const space = flagValue(args, "--space");
  return {
    projectDir: flagValue(args, "--project-dir") ?? process.cwd(),
    slug: flagValue(args, "--slug") ?? "",
    ...(repo === undefined ? {} : { repo }),
    ...(intent === undefined ? {} : { intent }),
    ...(space === undefined ? {} : { space }),
  };
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  const usage =
    "Usage: aidlc-worktree <create|merge|discard|verify|validate|list|info> " +
    "[--project-dir <dir>] ...";
  if (!cliHasCommand(WORKTREE_CLI_CONTRACT, command)) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  try {
    const unknown = cliUnknownFlags(WORKTREE_CLI_CONTRACT, command, args);
    if (unknown.length > 0) {
      throw new Error(`Unknown flag(s) for ${command}: ${unknown.join(", ")}`);
    }
    const options = commonOptions(args);
    let result: Record<string, unknown>;
    if (command === "create") {
      result = createWorktree({
        ...options,
        base: flagValue(args, "--base") ?? "",
      });
    } else if (command === "merge") {
      const message = flagValue(args, "--message");
      result = mergeWorktree({
        ...options,
        target: flagValue(args, "--target") ?? "",
        strategy: (flagValue(args, "--strategy") ?? "") as MergeStrategy,
        ...(message === undefined ? {} : { message }),
      });
    } else if (command === "discard") {
      result = discardWorktree(options);
    } else if (command === "verify" || command === "validate") {
      const event = flagValue(args, "--event") as WorktreeEvent | undefined;
      if (event === undefined || !VERIFY_EVENTS.includes(event)) {
        throw new Error(`--event must be one of: ${VERIFY_EVENTS.join(", ")}`);
      }
      const maxAge = flagValue(args, "--max-age-seconds");
      result = verifyWorktreeEvent({
        ...options,
        event,
        ...(maxAge === undefined ? {} : { maxAgeSeconds: Number(maxAge) }),
      });
      if (result.verified !== true) process.exitCode = 1;
    } else if (command === "info") {
      result = worktreeInfo(options);
    } else {
      result = listWorktrees(options);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "conflict") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
