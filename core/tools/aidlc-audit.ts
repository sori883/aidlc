import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { workspaceRoot } from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export const CLONE_ID_FILE = ".aidlc-clone-id";

export type AuditEvent =
  | "WORKFLOW_STARTED"
  | "WORKFLOW_COMPLETED"
  | "PHASE_STARTED"
  | "PHASE_COMPLETED"
  | "PHASE_VERIFIED"
  | "PHASE_SKIPPED"
  | "STAGE_STARTED"
  | "STAGE_AWAITING_APPROVAL"
  | "GATE_APPROVED"
  | "GATE_REJECTED"
  | "STAGE_REVISING"
  | "STAGE_COMPLETED"
  | "STAGE_SKIPPED"
  | "DECISION_RECORDED"
  | "QUESTION_ANSWERED"
  | "PRACTICES_DISCOVERED"
  | "PRACTICES_AFFIRMED"
  | "PRACTICES_OVERRIDE"
  | "PRACTICES_SECTION_EMPTY"
  | "SENSOR_FIRED"
  | "SENSOR_PASSED"
  | "SENSOR_FAILED"
  | "SENSOR_BUDGET_OVERRIDE"
  | "BOLT_STARTED"
  | "BOLT_COMPLETED"
  | "BOLT_FAILED"
  | "AUTONOMY_MODE_SET"
  | "RULE_LEARNED"
  | "RECOMPOSED"
  | "WORKTREE_CREATED"
  | "WORKTREE_MERGED"
  | "WORKTREE_DISCARDED"
  | "DOCTOR_REPAIRED"
  | "WORKSPACE_SCAFFOLDED"
  | "WORKSPACE_SCANNED"
  | "WORKSPACE_INITIALISED";

export interface AuditAppendResult {
  appended: true;
  event: AuditEvent;
  timestamp: string;
  cloneId: string;
  sequence: number;
  path: string;
}

export interface AuditBatchEntry {
  event: AuditEvent;
  fields: Readonly<Record<string, string>>;
}

export interface AuditBatchAppendResult {
  appended: true;
  events: AuditEvent[];
  timestamp: string;
  cloneId: string;
  sequences: number[];
  path: string;
}

export interface OrderedAuditEntry {
  event: string;
  timestamp: string;
  cloneId: string;
  sequence: number;
  legacySequence: boolean;
  fields: Record<string, string>;
  path: string;
  block: string;
}

const EVENT_HEADINGS: Record<AuditEvent, string> = {
  WORKFLOW_STARTED: "Workflow Start",
  WORKFLOW_COMPLETED: "Workflow Completion",
  PHASE_STARTED: "Phase Start",
  PHASE_COMPLETED: "Phase Completion",
  PHASE_VERIFIED: "Phase Verification",
  PHASE_SKIPPED: "Phase Skip",
  STAGE_STARTED: "Stage Start",
  STAGE_AWAITING_APPROVAL: "Stage Awaiting Approval",
  GATE_APPROVED: "Gate Approved",
  GATE_REJECTED: "Gate Rejected",
  STAGE_REVISING: "Stage Revising",
  STAGE_COMPLETED: "Stage Completion",
  STAGE_SKIPPED: "Stage Skip",
  DECISION_RECORDED: "Decision Recorded",
  QUESTION_ANSWERED: "Question Answered",
  PRACTICES_DISCOVERED: "Practices Discovered",
  PRACTICES_AFFIRMED: "Practices Affirmed",
  PRACTICES_OVERRIDE: "Practices Override",
  PRACTICES_SECTION_EMPTY: "Practices Section Empty",
  SENSOR_FIRED: "Sensor Fired",
  SENSOR_PASSED: "Sensor Passed",
  SENSOR_FAILED: "Sensor Failed",
  SENSOR_BUDGET_OVERRIDE: "Sensor Budget Override",
  BOLT_STARTED: "Bolt Start",
  BOLT_COMPLETED: "Bolt Completion",
  BOLT_FAILED: "Bolt Failure",
  AUTONOMY_MODE_SET: "Construction Autonomy Mode Set",
  RULE_LEARNED: "Rule Learned",
  RECOMPOSED: "Execution Plan Recomposed",
  WORKTREE_CREATED: "Worktree Created",
  WORKTREE_MERGED: "Worktree Merged",
  WORKTREE_DISCARDED: "Worktree Discarded",
  DOCTOR_REPAIRED: "Doctor Repair",
  WORKSPACE_SCAFFOLDED: "Workspace Scaffolded",
  WORKSPACE_SCANNED: "Workspace Scanned",
  WORKSPACE_INITIALISED: "Workspace Initialised",
};

const cloneIds = new Map<string, string>();
const shardNames = new Map<string, string>();

export function cloneIdPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), CLONE_ID_FILE);
}

export function cloneId(projectDir: string): string {
  const projectRoot = resolve(projectDir);
  const cached = cloneIds.get(projectRoot);
  if (cached !== undefined) return cached;

  const path = cloneIdPath(projectRoot);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[a-z0-9]{1,32}$/.test(existing)) {
      cloneIds.set(projectRoot, existing);
      return existing;
    }
  } catch {
    // Mint the clone-local token below.
  }

  const minted = randomUUID().replace(/-/g, "").slice(0, 12);
  let settled = minted;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${minted}\n`, "utf8");
    const value = readFileSync(path, "utf8").trim();
    if (/^[a-z0-9]{1,32}$/.test(value)) settled = value;
  } catch {
    // An unwritable workspace keeps a stable in-process token.
  }
  cloneIds.set(projectRoot, settled);
  return settled;
}

export function auditShardName(projectDir: string): string {
  const projectRoot = resolve(projectDir);
  const cached = shardNames.get(projectRoot);
  if (cached !== undefined) return cached;
  const host = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "host";
  const name = `${host}-${cloneId(projectRoot)}.md`;
  shardNames.set(projectRoot, name);
  return name;
}

export function auditFilePath(
  projectDir: string,
  recordDir: string,
): string {
  return join(resolve(recordDir), "audit", auditShardName(projectDir));
}

/** Ensure the active clone's per-Intent audit shard has its canonical header. */
export function initializeAuditLog(
  projectDir: string,
  recordDir: string,
): string {
  return withWorkspaceLock(projectDir, () =>
    initializeAuditLogUnlocked(projectDir, recordDir)
  );
}

function initializeAuditLogUnlocked(
  projectDir: string,
  recordDir: string,
): string {
  const path = auditFilePath(projectDir, recordDir);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, "# AI-DLC Audit Log\n", { encoding: "utf8", flag: "wx" });
  }
  return path;
}

function renderAuditBlock(
  event: AuditEvent,
  fields: Readonly<Record<string, string>>,
  timestamp: string,
  currentCloneId: string,
  sequence: number,
): string {
  let block = `\n## ${EVENT_HEADINGS[event]}\n`;
  block += `**Timestamp**: ${timestamp}\n`;
  block += `**Clone ID**: ${currentCloneId}\n`;
  block += `**Sequence**: ${sequence}\n`;
  block += `**Event**: ${event}\n`;
  for (const [key, value] of Object.entries(fields)) {
    const safeValue = String(value).replace(/\r?\n/g, "\\n");
    block += `**${key}**: ${safeValue}\n`;
  }
  return `${block}\n---\n`;
}

function nextAuditSequence(path: string): number {
  if (!existsSync(path)) return 1;
  const source = readFileSync(path, "utf8");
  const recorded = [...source.matchAll(/^\*\*Sequence\*\*:[ \t]*(\d+)[ \t]*$/gm)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const legacyFloor = (source.match(/^\*\*Event\*\*:/gm) ?? []).length;
  return Math.max(legacyFloor, 0, ...recorded) + 1;
}

function auditField(block: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\*\\*${escaped}\\*\\*:[ \\t]*(.*)$`, "m")
    .exec(block)?.[1]?.trim() ?? null;
}

function cloneIdFromShard(path: string): string {
  return /-([a-z0-9]{1,32})\.md$/.exec(basename(path))?.[1] ?? basename(path, ".md");
}

/**
 * Read every clone-local shard in deterministic causal order. Per-clone
 * sequence is authoritative; timestamp is the final stable tie-breaker.
 * Legacy blocks without Sequence retain their physical order.
 */
export function readOrderedAuditEntries(recordDir: string): OrderedAuditEntry[] {
  const directory = join(resolve(recordDir), "audit");
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(directory, entry.name))
    .sort()
    .flatMap((path) => {
      let legacyIndex = 0;
      return readFileSync(path, "utf8").split(/^---\s*$/m).flatMap((block) => {
        const event = auditField(block, "Event");
        if (event === null) return [];
        legacyIndex += 1;
        const fields: Record<string, string> = {};
        for (const match of block.matchAll(/^\*\*([^*]+)\*\*:[ \t]*(.*)$/gm)) {
          const key = match[1]?.trim();
          if (key !== undefined) fields[key] = match[2]?.trim() ?? "";
        }
        const recordedSequence = Number(auditField(block, "Sequence"));
        const legacySequence = !Number.isSafeInteger(recordedSequence) || recordedSequence < 1;
        return [{
          event,
          timestamp: auditField(block, "Timestamp") ?? "",
          cloneId: auditField(block, "Clone ID") ?? cloneIdFromShard(path),
          sequence: legacySequence ? legacyIndex : recordedSequence,
          legacySequence,
          fields,
          path,
          block,
        }];
      });
    });
  return entries.sort((left, right) =>
    left.cloneId.localeCompare(right.cloneId) ||
    left.sequence - right.sequence ||
    left.timestamp.localeCompare(right.timestamp) ||
    left.path.localeCompare(right.path)
  );
}

/** Store project-owned evidence as a portable path; retain external paths. */
export function portableEvidencePath(projectDir: string, input: string): string {
  const projectRoot = resolve(projectDir);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(projectRoot, input);
  const rel = relative(projectRoot, absolute);
  if (rel === "") return ".";
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    return rel.split(sep).join("/");
  }
  return absolute;
}

/** Append one canonical initialization event to this clone's Intent shard. */
export function appendAuditEntry(
  projectDir: string,
  recordDir: string,
  event: AuditEvent,
  fields: Readonly<Record<string, string>>,
): AuditAppendResult {
  return withWorkspaceLock(projectDir, () => {
    const path = initializeAuditLogUnlocked(projectDir, recordDir);
    const timestamp = new Date().toISOString();
    const currentCloneId = cloneId(projectDir);
    const sequence = nextAuditSequence(path);
    appendFileSync(
      path,
      renderAuditBlock(event, fields, timestamp, currentCloneId, sequence),
      "utf8",
    );
    return { appended: true, event, timestamp, cloneId: currentCloneId, sequence, path };
  });
}

/** Append a related lifecycle sequence while holding one workspace lock. */
export function appendAuditEntries(
  projectDir: string,
  recordDir: string,
  entries: readonly AuditBatchEntry[],
): AuditBatchAppendResult {
  if (entries.length === 0) {
    throw new Error("Audit batch must contain at least one event.");
  }
  return withWorkspaceLock(projectDir, () => {
    const path = initializeAuditLogUnlocked(projectDir, recordDir);
    const timestamp = new Date().toISOString();
    const currentCloneId = cloneId(projectDir);
    const firstSequence = nextAuditSequence(path);
    const sequences = entries.map((_entry, index) => firstSequence + index);
    appendFileSync(
      path,
      entries.map((entry, index) =>
        renderAuditBlock(
          entry.event,
          entry.fields,
          timestamp,
          currentCloneId,
          sequences[index]!,
        )
      ).join(""),
      "utf8",
    );
    return {
      appended: true,
      events: entries.map((entry) => entry.event),
      timestamp,
      cloneId: currentCloneId,
      sequences,
      path,
    };
  });
}
