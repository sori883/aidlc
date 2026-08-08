import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  | "RULE_LEARNED"
  | "DOCTOR_REPAIRED"
  | "WORKSPACE_SCAFFOLDED"
  | "WORKSPACE_SCANNED"
  | "WORKSPACE_INITIALISED";

export interface AuditAppendResult {
  appended: true;
  event: AuditEvent;
  timestamp: string;
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
  path: string;
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
  RULE_LEARNED: "Rule Learned",
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
): string {
  let block = `\n## ${EVENT_HEADINGS[event]}\n`;
  block += `**Timestamp**: ${timestamp}\n`;
  block += `**Event**: ${event}\n`;
  for (const [key, value] of Object.entries(fields)) {
    const safeValue = String(value).replace(/\r?\n/g, "\\n");
    block += `**${key}**: ${safeValue}\n`;
  }
  return `${block}\n---\n`;
}

/** Append one canonical initialization event to this clone's Intent shard. */
export function appendAuditEntry(
  projectDir: string,
  recordDir: string,
  event: AuditEvent,
  fields: Readonly<Record<string, string>>,
  timestamp = new Date().toISOString(),
): AuditAppendResult {
  return withWorkspaceLock(projectDir, () => {
    const path = initializeAuditLogUnlocked(projectDir, recordDir);
    appendFileSync(path, renderAuditBlock(event, fields, timestamp), "utf8");
    return { appended: true, event, timestamp, path };
  });
}

/** Append a related lifecycle sequence while holding one workspace lock. */
export function appendAuditEntries(
  projectDir: string,
  recordDir: string,
  entries: readonly AuditBatchEntry[],
  timestamp = new Date().toISOString(),
): AuditBatchAppendResult {
  if (entries.length === 0) {
    throw new Error("Audit batch must contain at least one event.");
  }
  return withWorkspaceLock(projectDir, () => {
    const path = initializeAuditLogUnlocked(projectDir, recordDir);
    appendFileSync(
      path,
      entries.map((entry) =>
        renderAuditBlock(entry.event, entry.fields, timestamp)
      ).join(""),
      "utf8",
    );
    return {
      appended: true,
      events: entries.map((entry) => entry.event),
      timestamp,
      path,
    };
  });
}
