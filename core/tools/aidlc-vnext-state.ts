import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import {
  parseArtifactReference,
  parseStageExecutionPlan,
  VNEXT_STAGE_IDS,
  type ArtifactReference,
  type StageExecutionPlan,
  type VNextStageId,
} from "./aidlc-stage-contract.ts";
import { verifyProjectArtifactReference } from "./aidlc-effective-policy.ts";

export const VNEXT_STATE_SCHEMA_VERSION = 1 as const;
export const VNEXT_STATE_STATUSES = ["parked", "ready", "completed"] as const;
export type VNextStateStatus = (typeof VNEXT_STATE_STATUSES)[number];

export interface VNextIntentState {
  schema_version: typeof VNEXT_STATE_SCHEMA_VERSION;
  workflow: "vnext";
  intent_id: string;
  catalog_version: string;
  graph_version: string;
  plan_revision: number;
  policy_snapshot: ArtifactReference;
  current_stage: VNextStageId;
  status: VNextStateStatus;
  parked_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface InitializedVNextIntentState {
  state: VNextIntentState;
  statePath: string;
  summaryPath: string;
  planPath: string;
}

const STATE_KEYS = [
  "schema_version",
  "workflow",
  "intent_id",
  "catalog_version",
  "graph_version",
  "plan_revision",
  "policy_snapshot",
  "current_stage",
  "status",
  "parked_reason",
  "created_at",
  "updated_at",
] as const;

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}

function asOneLine(value: unknown, context: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value !== value.trim() ||
    /[\r\n\0]/.test(value)
  ) fail(context, "must be a non-empty single-line string");
  return value;
}

function asPositiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(context, "must be a positive integer");
  }
  return value as number;
}

function asIsoTimestamp(value: unknown, context: string): string {
  const timestamp = asOneLine(value, context);
  if (Number.isNaN(Date.parse(timestamp)) || !timestamp.endsWith("Z")) {
    fail(context, "must be an ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function asStageId(value: unknown, context: string): VNextStageId {
  const stageId = asOneLine(value, context);
  if (!(VNEXT_STAGE_IDS as readonly string[]).includes(stageId)) {
    fail(context, `must be one of: ${VNEXT_STAGE_IDS.join(", ")}`);
  }
  return stageId as VNextStageId;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename has already consumed the temporary path.
    }
    throw error;
  }
}

export function vNextStatePath(recordDir: string): string {
  return join(resolve(recordDir), "aidlc-state.json");
}

export function vNextStateSummaryPath(recordDir: string): string {
  return join(resolve(recordDir), "aidlc-state.md");
}

export function vNextPlanPath(recordDir: string): string {
  return join(resolve(recordDir), "stage-execution-plan.json");
}

export function activeVNextIntentRecordDir(projectDir: string): string {
  const projectRoot = resolve(projectDir);
  const intentsRoot = join(
    workspaceRoot(projectRoot),
    "spaces",
    activeSpace(projectRoot),
    "intents",
  );
  let selected = "";
  try {
    selected = readFileSync(join(intentsRoot, "active-intent"), "utf8").trim();
  } catch {
    // A stable, actionable error is reported below.
  }
  if (selected === "" || selected.includes("/") || selected.includes("\\")) {
    fail("vNext State", "no valid active Intent; run aidlc intent birth first");
  }
  const recordDir = join(intentsRoot, selected);
  if (!existsSync(vNextStatePath(recordDir))) {
    fail("vNext State", `active Intent is not initialized for vNext: ${selected}`);
  }
  return recordDir;
}

export function activeVNextStatePath(projectDir: string): string {
  return vNextStatePath(activeVNextIntentRecordDir(projectDir));
}

export function activeVNextPlanPath(projectDir: string): string {
  return vNextPlanPath(activeVNextIntentRecordDir(projectDir));
}

export function parseVNextIntentState(
  value: unknown,
  context = "vNext Intent State",
): VNextIntentState {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, STATE_KEYS, context);
  if (record.schema_version !== VNEXT_STATE_SCHEMA_VERSION) {
    fail(`${context}.schema_version`, `must equal ${VNEXT_STATE_SCHEMA_VERSION}`);
  }
  if (record.workflow !== "vnext") fail(`${context}.workflow`, "must equal vnext");
  const status = asOneLine(record.status, `${context}.status`);
  if (!(VNEXT_STATE_STATUSES as readonly string[]).includes(status)) {
    fail(`${context}.status`, `must be one of: ${VNEXT_STATE_STATUSES.join(", ")}`);
  }
  const parkedReason = record.parked_reason === undefined
    ? undefined
    : asOneLine(record.parked_reason, `${context}.parked_reason`);
  if (status === "parked" && parkedReason === undefined) {
    fail(`${context}.parked_reason`, "is required while status is parked");
  }
  if (status !== "parked" && parkedReason !== undefined) {
    fail(`${context}.parked_reason`, "is allowed only while status is parked");
  }
  return {
    schema_version: VNEXT_STATE_SCHEMA_VERSION,
    workflow: "vnext",
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    catalog_version: asOneLine(record.catalog_version, `${context}.catalog_version`),
    graph_version: asOneLine(record.graph_version, `${context}.graph_version`),
    plan_revision: asPositiveInteger(record.plan_revision, `${context}.plan_revision`),
    policy_snapshot: parseArtifactReference(
      record.policy_snapshot,
      `${context}.policy_snapshot`,
    ),
    current_stage: asStageId(record.current_stage, `${context}.current_stage`),
    status: status as VNextStateStatus,
    ...(parkedReason === undefined ? {} : { parked_reason: parkedReason }),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
    updated_at: asIsoTimestamp(record.updated_at, `${context}.updated_at`),
  };
}

export function readVNextStateAt(recordDir: string): VNextIntentState {
  const path = vNextStatePath(recordDir);
  try {
    return parseVNextIntentState(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${path}:`)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail("vNext State", `cannot read ${path}: ${detail}`);
  }
}

export function readVNextPlanAt(recordDir: string): StageExecutionPlan {
  const path = vNextPlanPath(recordDir);
  try {
    return parseStageExecutionPlan(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${path}:`)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail("Stage Execution Plan", `cannot read ${path}: ${detail}`);
  }
}

function renderSummary(state: VNextIntentState, plan: StageExecutionPlan): string {
  const decisions = plan.stage_decisions.map((decision) => {
    const marker = decision.stage_id === state.current_stage ? ">" : "-";
    return `${marker} ${decision.stage_id}: ${decision.disposition}`;
  });
  return [
    "# AI-DLC vNext State",
    "",
    `- Intent: ${state.intent_id}`,
    `- Current Stage: ${state.current_stage}`,
    `- Status: ${state.status}`,
    `- Plan Revision: ${state.plan_revision}`,
    `- Graph: ${state.graph_version}`,
    ...(state.parked_reason === undefined ? [] : [`- Parked Reason: ${state.parked_reason}`]),
    "",
    "## Stage Execution Plan",
    "",
    ...decisions,
    "",
    "> This file is a human-readable mirror. Core-owned JSON files are authoritative.",
    "",
  ].join("\n");
}

export function writeVNextPlanAt(
  recordDir: string,
  planValue: StageExecutionPlan,
): string {
  const plan = parseStageExecutionPlan(planValue);
  const path = vNextPlanPath(recordDir);
  writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

export function writeVNextStateAt(
  recordDir: string,
  stateValue: VNextIntentState,
  planValue: StageExecutionPlan,
): string {
  const state = parseVNextIntentState(stateValue);
  const plan = parseStageExecutionPlan(planValue);
  if (state.intent_id !== plan.intent_id) fail("vNext State", "Intent does not match Plan");
  if (state.graph_version !== plan.graph_version) fail("vNext State", "Graph does not match Plan");
  if (state.plan_revision !== plan.revision) fail("vNext State", "revision does not match Plan");
  if (JSON.stringify(state.policy_snapshot) !== JSON.stringify(plan.policy_snapshot)) {
    fail("vNext State", "Effective Policy reference does not match Plan");
  }
  const path = vNextStatePath(recordDir);
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  writeFileAtomic(vNextStateSummaryPath(recordDir), renderSummary(state, plan));
  return path;
}

export function initializeVNextIntentStateAt(
  projectDir: string,
  recordDir: string,
  options: {
    intentId: string;
    catalogVersion: string;
    graphVersion: string;
    policySnapshot: ArtifactReference;
    plan: StageExecutionPlan;
    createdAt?: string;
  },
): InitializedVNextIntentState {
  const statePath = vNextStatePath(recordDir);
  const planPath = vNextPlanPath(recordDir);
  if (existsSync(statePath) || existsSync(planPath)) {
    fail("vNext State", "Core-owned State or Plan already exists");
  }
  verifyProjectArtifactReference(projectDir, options.policySnapshot);
  const now = options.createdAt ?? new Date().toISOString();
  const plan = parseStageExecutionPlan(options.plan);
  const state = parseVNextIntentState({
    schema_version: VNEXT_STATE_SCHEMA_VERSION,
    workflow: "vnext",
    intent_id: options.intentId,
    catalog_version: options.catalogVersion,
    graph_version: options.graphVersion,
    plan_revision: plan.revision,
    policy_snapshot: options.policySnapshot,
    current_stage: "ST-00",
    status: "parked",
    parked_reason: "ST-00 Stage Contract is not implemented until M3.",
    created_at: now,
    updated_at: now,
  });
  writeVNextPlanAt(recordDir, plan);
  writeVNextStateAt(recordDir, state, plan);
  return {
    state,
    statePath,
    summaryPath: vNextStateSummaryPath(recordDir),
    planPath,
  };
}

export function validateVNextIntentAt(projectDir: string, recordDir: string): void {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.intent_id !== plan.intent_id) fail("vNext State", "Intent does not match Plan");
  if (state.graph_version !== plan.graph_version) fail("vNext State", "Graph does not match Plan");
  if (state.plan_revision !== plan.revision) fail("vNext State", "revision does not match Plan");
  if (JSON.stringify(state.policy_snapshot) !== JSON.stringify(plan.policy_snapshot)) {
    fail("vNext State", "Effective Policy reference does not match Plan");
  }
  verifyProjectArtifactReference(projectDir, state.policy_snapshot);
}

export function resumeVNextIntent(projectDir: string): {
  recordDir: string;
  state: VNextIntentState;
  plan: StageExecutionPlan;
} {
  const recordDir = activeVNextIntentRecordDir(projectDir);
  validateVNextIntentAt(projectDir, recordDir);
  return {
    recordDir,
    state: readVNextStateAt(recordDir),
    plan: readVNextPlanAt(recordDir),
  };
}

export function main(argv: string[]): void {
  const [command, projectDir, ...rest] = argv;
  if (
    (command !== "show" && command !== "resume" && command !== "check") ||
    projectDir === undefined || rest.length !== 0
  ) {
    console.error("Usage: aidlc state <show|resume|check> <project-dir>");
    process.exitCode = 1;
    return;
  }
  try {
    if (command === "check") {
      const recordDir = activeVNextIntentRecordDir(projectDir);
      validateVNextIntentAt(projectDir, recordDir);
      process.stdout.write(`${JSON.stringify({ valid: true, workflow: "vnext" })}\n`);
      return;
    }
    const resumed = resumeVNextIntent(projectDir);
    process.stdout.write(
      `${JSON.stringify({ state: resumed.state, plan: resumed.plan }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
