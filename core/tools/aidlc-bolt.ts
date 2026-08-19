// Harness-neutral Construction Bolt lifecycle. This tool owns the structured
// Bolt state embedded in aidlc-state.md and the canonical Bolt Audit events.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendAuditEntry,
  portableEvidencePath,
  type AuditEvent,
} from "./aidlc-audit.ts";
import { parseBoltPlan, type BoltDefinition, type BoltPlan } from "./aidlc-bolt-plan.ts";
import { loadCompiledStageGraph, type ResolvedPlanStage } from "./aidlc-graph.ts";
import {
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";
import { activeIntentRecordDir, STATE_VERSION } from "./aidlc-state.ts";
import { loadActiveUnitDag } from "./aidlc-unit-graph.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export const BOLT_EXECUTION_SCHEMA_VERSION = 2 as const;
export const BOLT_STATE_START = "<!-- AIDLC_BOLT_STATE_START -->";
export const BOLT_STATE_END = "<!-- AIDLC_BOLT_STATE_END -->";
export const BOLT_STAGE_SLUGS = [
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
] as const;
const BOLT_CLI_CONTRACT = loadCliContract("aidlc-bolt.ts");

export type BoltAutonomy = "unset" | "autonomous" | "gated";
export type BoltRunStatus =
  | "pending"
  | "running"
  | "awaiting-gate"
  | "awaiting-autonomy"
  | "ready-to-complete"
  | "completed"
  | "failed"
  | "skipped"
  | "aborted";

export type BoltStageSlug = typeof BOLT_STAGE_SLUGS[number];
export type BoltStageStatus = "pending" | "completed" | "skipped";
export type BoltWorktreeStatus =
  | "none"
  | "active"
  | "merged"
  | "preserved";

export interface BoltStageProgress {
  slug: BoltStageSlug;
  status: BoltStageStatus;
  completedUnits: string[];
}

export interface BoltRunState {
  id: string;
  slug: string;
  status: BoltRunStatus;
  attempt: number;
  gate: "pending" | "approved" | "not-required";
  failure: string | null;
  worktreePath: string | null;
  ref: string | null;
  worktreeStatus: BoltWorktreeStatus;
  stages: BoltStageProgress[];
}

export interface BoltExecutionState {
  schemaVersion: typeof BOLT_EXECUTION_SCHEMA_VERSION;
  planHash: string;
  autonomy: BoltAutonomy;
  bolts: BoltRunState[];
}

export type BoltNextStatus =
  | "ready"
  | "running"
  | "awaiting-gate"
  | "awaiting-autonomy"
  | "ready-to-complete"
  | "failed-awaiting-choice"
  | "aborted"
  | "blocked"
  | "all-complete";

export interface BoltNextAction {
  status: BoltNextStatus;
  readyBoltIds: string[];
  activeBoltIds: string[];
  nextAction: string;
}

export interface LoadedBoltExecution {
  recordDir: string;
  statePath: string;
  planPath: string;
  plan: BoltPlan;
  state: BoltExecutionState;
  next: BoltNextAction;
}

export interface BoltInitialization extends LoadedBoltExecution {
  replay: boolean;
}

export interface BoltTransition {
  boltId: string;
  status: BoltRunStatus;
  attempt: number;
  replay: boolean;
  next: BoltNextAction;
}

export interface BoltStageCursor {
  boltId: string;
  stage: BoltStageSlug;
  unit: string;
  units: string[];
  completedUnits: string[];
}

export interface BoltStageTransition {
  boltId: string;
  stage: BoltStageSlug;
  unit: string | null;
  replay: boolean;
  stageCompleted: boolean;
  allStagesCompleted: boolean;
  next: BoltNextAction;
}

export interface StartBoltOptions {
  worktreePath?: string;
  ref?: string;
}

const BOLT_PLAN_RELATIVE = join(
  "inception",
  "delivery-planning",
  "bolt-plan.md",
);
const ACTIVE_STATUSES = new Set<BoltRunStatus>([
  "running",
  "awaiting-gate",
  "awaiting-autonomy",
  "ready-to-complete",
  "failed",
  "aborted",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stateField(content: string, field: string): string | null {
  const pattern = new RegExp(
    `^- \\*\\*${escapeRegExp(field)}\\*\\*:[ \\t]*(.*)$`,
    "m",
  );
  return pattern.exec(content)?.[1]?.trim() ?? null;
}

function setStateField(content: string, field: string, value: string): string {
  const pattern = new RegExp(
    `^- \\*\\*${escapeRegExp(field)}\\*\\*:[^\\n]*$`,
    "m",
  );
  if (!pattern.test(content)) throw new Error(`State file is missing required field "${field}"`);
  return content.replace(pattern, `- **${field}**: ${value}`);
}

function setOrInsertStateField(
  content: string,
  section: string,
  field: string,
  value: string,
): string {
  const pattern = new RegExp(
    `^- \\*\\*${escapeRegExp(field)}\\*\\*:[^\\n]*$`,
    "m",
  );
  if (pattern.test(content)) return content.replace(pattern, `- **${field}**: ${value}`);
  const heading = `## ${section}`;
  const start = content.indexOf(heading);
  if (start === -1) throw new Error(`State file is missing required section "${section}"`);
  const end = content.indexOf("\n", start + heading.length);
  if (end === -1) return `${content}\n- **${field}**: ${value}\n`;
  return `${content.slice(0, end + 1)}- **${field}**: ${value}\n${content.slice(end + 1)}`;
}

function setStageMarker(
  content: string,
  slug: string,
  marker: " " | "-" | "x" | "S",
): string {
  const pattern = new RegExp(
    `^(- \\[)[ xS?R-](\\] ${escapeRegExp(slug)}(?:\\s|$)[^\\n]*)$`,
    "m",
  );
  if (!pattern.test(content)) {
    throw new Error(`State file has no stage checkbox for "${slug}"`);
  }
  return content.replace(
    pattern,
    (_line, prefix: string, suffix: string) => `${prefix}${marker}${suffix}`,
  );
}

function completedCheckboxCount(content: string): number {
  return [...content.matchAll(/^- \[x\] [a-z][a-z0-9-]*(?:\s|$)/gm)].length;
}

function currentStageProgress(run: BoltRunState): BoltStageProgress | null {
  return run.stages.find((stage) => stage.status === "pending") ?? null;
}

function allBoltStagesSettled(run: BoltRunState): boolean {
  return run.stages.every((stage) => stage.status === "completed" || stage.status === "skipped");
}

function syncConstructionProjection(
  content: string,
  state: BoltExecutionState,
  plan: BoltPlan,
): string {
  const allComplete = state.bolts.every(
    (bolt) => bolt.status === "completed" || bolt.status === "skipped",
  );
  let updated = content;
  if (allComplete) {
    for (const slug of BOLT_STAGE_SLUGS) {
      const everySkipped = state.bolts.every((bolt) =>
        bolt.status === "skipped" ||
        bolt.stages.find((stage) => stage.slug === slug)?.status === "skipped"
      );
      updated = setStageMarker(updated, slug, everySkipped ? "S" : "x");
    }
    updated = setStageMarker(updated, "build-and-test", "-");
    updated = setStateField(updated, "Active Agent", "aidlc-quality-agent");
    updated = setStateField(updated, "In Progress", "build-and-test");
    updated = setStateField(updated, "Lifecycle Phase", "CONSTRUCTION");
    updated = setStateField(updated, "Current Stage", "build-and-test");
    updated = setStateField(updated, "Next Stage", "ci-pipeline");
    updated = setStateField(updated, "Status", "Running");
    updated = setStateField(updated, "Next Action", "Execute build-and-test after all Bolts");
    updated = setStateField(updated, "Completed", String(completedCheckboxCount(updated)));
    return updated;
  }

  const run = plan.bolts
    .map((definition) => state.bolts.find((bolt) => bolt.id === definition.id)!)
    .find((bolt) => ACTIVE_STATUSES.has(bolt.status));
  if (run === undefined) return updated;

  for (const progress of run.stages) {
    const marker = progress.status === "completed"
      ? "x"
      : progress.status === "skipped" ? "S" : " ";
    updated = setStageMarker(updated, progress.slug, marker);
  }
  const current = currentStageProgress(run);
  if (current !== null) {
    updated = setStageMarker(updated, current.slug, "-");
    const graph = loadCompiledStageGraph();
    const node = graph.find((stage) => stage.slug === current.slug);
    const definition = plan.bolts.find((bolt) => bolt.id === run.id)!;
    const unit = definition.units.find((candidate) =>
      !current.completedUnits.includes(candidate)
    ) ?? "none";
    const next = run.stages.find((stage) =>
      stage.status === "pending" && stage.slug !== current.slug
    )?.slug ?? "none";
    updated = setStateField(updated, "Active Agent", node?.lead_agent ?? "");
    updated = setStateField(updated, "In Progress", current.slug);
    updated = setStateField(updated, "Lifecycle Phase", "CONSTRUCTION");
    updated = setStateField(updated, "Current Stage", current.slug);
    updated = setStateField(updated, "Next Stage", next);
    updated = setStateField(updated, "Status", "Running");
    updated = setStateField(
      updated,
      "Next Action",
      `Execute ${current.slug} for Bolt ${run.id}, Unit ${unit}`,
    );
  } else {
    updated = setStateField(updated, "Active Agent", "");
    updated = setStateField(updated, "In Progress", `Bolt ${run.id}`);
    updated = setStateField(updated, "Current Stage", "code-generation");
    updated = setStateField(updated, "Next Stage", "none");
  }
  updated = setStateField(updated, "Completed", String(completedCheckboxCount(updated)));
  return updated;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Atomic rename may already have consumed the temporary path.
    }
    throw error;
  }
}

function executionBlock(state: BoltExecutionState, plan: BoltPlan): string {
  const markers: Record<BoltRunStatus, string> = {
    pending: " ",
    running: "-",
    "awaiting-gate": "-",
    "awaiting-autonomy": "-",
    "ready-to-complete": "-",
    completed: "x",
    failed: "!",
    skipped: "S",
    aborted: "!",
  };
  const rows = plan.bolts.map((bolt) => {
    const run = state.bolts.find((candidate) => candidate.id === bolt.id)!;
    return `- [${markers[run.status]}] Bolt: ${bolt.id} — ${bolt.slug} — ` +
      `Batch ${bolt.batch} — Units: ${bolt.units.join(", ")}`;
  });
  return [
    BOLT_STATE_START,
    ...rows,
    "",
    "```json",
    JSON.stringify(state, null, 2),
    "```",
    BOLT_STATE_END,
  ].join("\n");
}

function replaceExecutionBlock(
  content: string,
  state: BoltExecutionState,
  plan: BoltPlan,
): string {
  const block = executionBlock(state, plan);
  const pattern = new RegExp(
    `${escapeRegExp(BOLT_STATE_START)}[\\s\\S]*?${escapeRegExp(BOLT_STATE_END)}`,
  );
  if (pattern.test(content)) return content.replace(pattern, block);
  const anchor = "## Current Status";
  const index = content.indexOf(anchor);
  if (index === -1) throw new Error("State file is missing Current Status section");
  return `${content.slice(0, index)}## Bolt Progress\n\n${block}\n\n${content.slice(index)}`;
}

function parseInternalState(content: string, plan: BoltPlan): BoltExecutionState | null {
  const blockPattern = new RegExp(
    `${escapeRegExp(BOLT_STATE_START)}[\\s\\S]*?` +
      "```json\\r?\\n([\\s\\S]*?)\\r?\\n```[\\s\\S]*?" +
      escapeRegExp(BOLT_STATE_END),
  );
  const source = blockPattern.exec(content)?.[1];
  if (source === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid Bolt execution JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Bolt execution state: expected an object");
  }
  const state = value as Partial<BoltExecutionState>;
  if (
    state.schemaVersion !== BOLT_EXECUTION_SCHEMA_VERSION ||
    typeof state.planHash !== "string" ||
    !["unset", "autonomous", "gated"].includes(String(state.autonomy)) ||
    !Array.isArray(state.bolts) || state.bolts.length !== plan.bolts.length
  ) throw new Error("Invalid Bolt execution state identity");
  const statuses = new Set<BoltRunStatus>([
    "pending", "running", "awaiting-gate", "awaiting-autonomy",
    "ready-to-complete", "completed", "failed", "skipped", "aborted",
  ]);
  for (const bolt of plan.bolts) {
    const run = state.bolts.find((candidate) => candidate?.id === bolt.id);
    if (
      run === undefined || run.slug !== bolt.slug ||
      !statuses.has(run.status) || !Number.isSafeInteger(run.attempt) || run.attempt < 0 ||
      !["pending", "approved", "not-required"].includes(run.gate) ||
      !(run.failure === null || typeof run.failure === "string") ||
      !(run.worktreePath === null || typeof run.worktreePath === "string") ||
      !(run.ref === null || typeof run.ref === "string") ||
      !["none", "active", "merged", "preserved"].includes(run.worktreeStatus) ||
      !Array.isArray(run.stages) || run.stages.length !== BOLT_STAGE_SLUGS.length
    ) throw new Error(`Invalid Bolt execution state for ${bolt.id}`);
    for (const slug of BOLT_STAGE_SLUGS) {
      const stage = run.stages.find((candidate) => candidate?.slug === slug);
      if (
        stage === undefined ||
        !["pending", "completed", "skipped"].includes(stage.status) ||
        !Array.isArray(stage.completedUnits) ||
        stage.completedUnits.some((unit) => typeof unit !== "string" || !bolt.units.includes(unit)) ||
        new Set(stage.completedUnits).size !== stage.completedUnits.length ||
        (stage.status === "completed" && stage.completedUnits.length !== bolt.units.length) ||
        (stage.status === "skipped" && stage.completedUnits.length !== 0)
      ) throw new Error(`Invalid Bolt stage execution state for ${bolt.id}/${slug}`);
    }
  }
  return state as BoltExecutionState;
}

export function parseBoltExecutionState(
  content: string,
  plan: BoltPlan,
): BoltExecutionState | null {
  return parseInternalState(content, plan);
}

function readyPendingIds(plan: BoltPlan, state: BoltExecutionState): string[] {
  const byId = new Map(state.bolts.map((bolt) => [bolt.id, bolt]));
  const ready = plan.bolts.filter((bolt) => {
    const run = byId.get(bolt.id)!;
    return run.status === "pending" && bolt.dependsOn.every((dependency) => {
      const status = byId.get(dependency)?.status;
      return status === "completed" || status === "skipped";
    });
  });
  const firstBatch = Math.min(...ready.map((bolt) => bolt.batch));
  return Number.isFinite(firstBatch)
    ? ready.filter((bolt) => bolt.batch === firstBatch).map((bolt) => bolt.id)
    : [];
}

function deriveNext(plan: BoltPlan, state: BoltExecutionState): BoltNextAction {
  const active = state.bolts.filter((bolt) => ACTIVE_STATUSES.has(bolt.status));
  const activeBoltIds = active.map((bolt) => bolt.id);
  const match = (status: BoltRunStatus) => active.find((bolt) => bolt.status === status);
  const failed = match("failed");
  if (failed !== undefined) {
    return {
      status: "failed-awaiting-choice",
      readyBoltIds: [],
      activeBoltIds,
      nextAction: `Choose retry, skip, or abort for ${failed.id}`,
    };
  }
  const aborted = match("aborted");
  if (aborted !== undefined) {
    return {
      status: "aborted",
      readyBoltIds: [],
      activeBoltIds,
      nextAction: `Construction aborted at ${aborted.id}; retry to resume`,
    };
  }
  const gate = match("awaiting-gate");
  if (gate !== undefined) {
    return {
      status: "awaiting-gate",
      readyBoltIds: [],
      activeBoltIds,
      nextAction: `Present approval gate for ${gate.id}`,
    };
  }
  const autonomy = match("awaiting-autonomy");
  if (autonomy !== undefined) {
    return {
      status: "awaiting-autonomy",
      readyBoltIds: [],
      activeBoltIds,
      nextAction: "Present the Construction autonomy ladder",
    };
  }
  const readyComplete = match("ready-to-complete");
  if (readyComplete !== undefined) {
    return {
      status: "ready-to-complete",
      readyBoltIds: [],
      activeBoltIds,
      nextAction: `Complete ${readyComplete.id}`,
    };
  }
  if (active.some((bolt) => bolt.status === "running")) {
    return {
      status: "running",
      readyBoltIds: [],
      activeBoltIds,
      nextAction: `Continue ${active.filter((bolt) => bolt.status === "running").map((bolt) => bolt.id).join(", ")}`,
    };
  }
  const skeleton = state.bolts.find((bolt) => bolt.id === "B1")!;
  if (skeleton.status === "skipped" && state.autonomy === "unset") {
    return {
      status: "awaiting-autonomy",
      readyBoltIds: [],
      activeBoltIds: [],
      nextAction: "Present the Construction autonomy ladder after skipped B1",
    };
  }
  const readyBoltIds = readyPendingIds(plan, state);
  if (readyBoltIds.length > 0) {
    return {
      status: "ready",
      readyBoltIds,
      activeBoltIds: [],
      nextAction: `Start Bolt batch: ${readyBoltIds.join(", ")}`,
    };
  }
  if (state.bolts.every((bolt) => bolt.status === "completed" || bolt.status === "skipped")) {
    return {
      status: "all-complete",
      readyBoltIds: [],
      activeBoltIds: [],
      nextAction: "Run Construction Stage 3.6 Build and Test",
    };
  }
  return {
    status: "blocked",
    readyBoltIds: [],
    activeBoltIds,
    nextAction: "Bolt dependencies are not satisfied",
  };
}

function syncHumanState(
  content: string,
  state: BoltExecutionState,
  plan: BoltPlan,
  timestamp: string,
): string {
  const next = deriveNext(plan, state);
  const active = state.bolts.filter((bolt) => ACTIVE_STATUSES.has(bolt.status));
  const attempts = state.bolts
    .filter((bolt) => bolt.attempt > 0)
    .map((bolt) => `${bolt.id}=${bolt.attempt}`)
    .join(", ") || "none";
  const failures = state.bolts
    .filter((bolt) => bolt.failure !== null)
    .map((bolt) => `${bolt.id}: ${bolt.failure}`)
    .join("; ") || "none";
  const worktrees = active
    .filter((bolt) => bolt.worktreePath !== null)
    .map((bolt) => `${bolt.id}=${bolt.worktreePath}`)
    .join(", ");
  const refs = state.bolts
    .filter((bolt) => bolt.ref !== null)
    .map((bolt) => `${bolt.slug}=${bolt.ref}`)
    .join(", ");
  let updated = content;
  for (const [field, value] of [
    ["Current Bolt", active.map((bolt) => bolt.id).join(", ") || "none"],
    ["Bolt Status", next.status],
    ["Bolt Attempt", attempts],
    ["Bolt Failure", failures],
    ["Bolt Next Action", next.nextAction],
  ] as const) {
    updated = setOrInsertStateField(updated, "Runtime State", field, value);
  }
  updated = setStateField(updated, "Worktree Path", worktrees);
  updated = setStateField(updated, "Bolt Refs", refs);
  updated = setStateField(updated, "Construction Autonomy Mode", state.autonomy);
  updated = setStateField(updated, "Last Updated", timestamp);
  return replaceExecutionBlock(updated, state, plan);
}

function activePaths(projectRoot: string): {
  recordDir: string;
  statePath: string;
  planPath: string;
} {
  const recordDir = activeIntentRecordDir(projectRoot);
  return {
    recordDir,
    statePath: join(recordDir, "aidlc-state.md"),
    planPath: join(recordDir, BOLT_PLAN_RELATIVE),
  };
}

function executionPlanActions(recordDir: string): Map<BoltStageSlug, "EXECUTE" | "SKIP"> {
  const path = join(recordDir, ".aidlc-plan.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read execution plan at ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid execution plan at ${path}: expected an array`);
  }
  const rows = value as ResolvedPlanStage[];
  const actions = new Map<BoltStageSlug, "EXECUTE" | "SKIP">();
  for (const slug of BOLT_STAGE_SLUGS) {
    const row = rows.find((candidate) => candidate?.slug === slug);
    if (row === undefined || (row.action !== "EXECUTE" && row.action !== "SKIP")) {
      throw new Error(`Invalid execution plan at ${path}: missing action for ${slug}`);
    }
    actions.set(slug, row.action);
  }
  return actions;
}

function loadPlan(projectRoot: string, planPath: string): BoltPlan {
  if (!existsSync(planPath)) throw new Error(`Bolt Plan does not exist: ${planPath}`);
  const unitDag = loadActiveUnitDag(projectRoot);
  if (unitDag === null) throw new Error("Bolt Plan requires a valid Unit DAG");
  return parseBoltPlan(readFileSync(planPath, "utf8"), unitDag, planPath);
}

function readUnlocked(projectRoot: string): LoadedBoltExecution {
  const paths = activePaths(projectRoot);
  const plan = loadPlan(projectRoot, paths.planPath);
  const content = readFileSync(paths.statePath, "utf8");
  const state = parseInternalState(content, plan);
  if (state === null) throw new Error("Bolt execution is not initialized; run aidlc bolt init");
  if (state.planHash !== plan.hash) {
    throw new Error("Bolt Plan changed after execution initialization; manual migration is required");
  }
  return { ...paths, plan, state, next: deriveNext(plan, state) };
}

function auditBlocks(recordDir: string): string[] {
  const directory = join(recordDir, "audit");
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .flatMap((name) => readFileSync(join(directory, name), "utf8").split(/\n---\n/));
  } catch {
    return [];
  }
}

function auditHas(
  recordDir: string,
  event: AuditEvent,
  fields: Readonly<Record<string, string>>,
): boolean {
  return auditBlocks(recordDir).some((block) =>
    block.includes(`**Event**: ${event}`) &&
    Object.entries(fields).every(([key, value]) => block.includes(`**${key}**: ${value}`))
  );
}

function appendAuditOnce(
  projectRoot: string,
  recordDir: string,
  event: AuditEvent,
  fields: Readonly<Record<string, string>>,
  identity: Readonly<Record<string, string>> = fields,
): void {
  if (!auditHas(recordDir, event, identity)) {
    appendAuditEntry(projectRoot, recordDir, event, fields);
  }
}

function appendStageStart(
  projectRoot: string,
  loaded: LoadedBoltExecution,
  run: BoltRunState,
  stage: BoltStageSlug,
): void {
  const node = loadCompiledStageGraph().find((candidate) => candidate.slug === stage);
  appendAuditOnce(
    projectRoot,
    loaded.recordDir,
    "STAGE_STARTED",
    {
      Stage: stage,
      Agent: node?.lead_agent ?? "unknown",
      "Bolt ID": run.id,
      Attempt: String(run.attempt),
    },
    { Stage: stage, "Bolt ID": run.id, Attempt: String(run.attempt) },
  );
}

function appendInitialStageEvents(
  projectRoot: string,
  loaded: LoadedBoltExecution,
  run: BoltRunState,
): void {
  for (const stage of run.stages.filter((candidate) => candidate.status === "skipped")) {
    appendAuditOnce(
      projectRoot,
      loaded.recordDir,
      "STAGE_SKIPPED",
      {
        Stage: stage.slug,
        "Bolt ID": run.id,
        Attempt: String(run.attempt),
        Reason: "Skipped by the approved execution plan",
      },
      { Stage: stage.slug, "Bolt ID": run.id, Attempt: String(run.attempt) },
    );
  }
  const current = currentStageProgress(run);
  if (current !== null) appendStageStart(projectRoot, loaded, run, current.slug);
}

function appendAggregateStartIfReady(
  projectRoot: string,
  loaded: LoadedBoltExecution,
): void {
  if (deriveNext(loaded.plan, loaded.state).status !== "all-complete") return;
  appendAuditOnce(
    projectRoot,
    loaded.recordDir,
    "STAGE_STARTED",
    {
      Stage: "build-and-test",
      Agent: "aidlc-quality-agent",
      Details: "Aggregate Stage after all Construction Bolts",
    },
    { Stage: "build-and-test", Details: "Aggregate Stage after all Construction Bolts" },
  );
}

function advanceBoltCompletion(
  projectRoot: string,
  loaded: LoadedBoltExecution,
  definition: BoltDefinition,
  run: BoltRunState,
): void {
  if (!allBoltStagesSettled(run)) {
    const cursor = stageCursorFor(loaded, run.id);
    throw new Error(
      `Bolt "${run.id}" has incomplete Construction work` +
        (cursor === null ? "" : ` at ${cursor.stage}/${cursor.unit}`),
    );
  }
  const gateRequired = definition.walkingSkeleton || loaded.state.autonomy === "gated";
  if (gateRequired && run.gate !== "approved") {
    run.status = "awaiting-gate";
    return;
  }
  if (definition.walkingSkeleton && loaded.state.autonomy === "unset") {
    run.status = "awaiting-autonomy";
    return;
  }
  if (run.worktreeStatus === "active" || run.worktreeStatus === "preserved") {
    run.status = "ready-to-complete";
    return;
  }
  run.status = "completed";
  run.failure = null;
  const fields = {
    "Bolt ID": run.id,
    "Bolt names": run.id,
    "Bolt slug": definition.slug,
    "Batch number": String(definition.batch),
    Attempt: String(run.attempt),
  };
  appendAuditOnce(projectRoot, loaded.recordDir, "BOLT_COMPLETED", fields, {
    "Bolt ID": run.id,
    Attempt: String(run.attempt),
  });
  appendAggregateStartIfReady(projectRoot, loaded);
}

function transitionResult(
  bolt: BoltRunState,
  plan: BoltPlan,
  state: BoltExecutionState,
  replay = false,
): BoltTransition {
  return {
    boltId: bolt.id,
    status: bolt.status,
    attempt: bolt.attempt,
    replay,
    next: deriveNext(plan, state),
  };
}

function persist(
  loaded: LoadedBoltExecution,
  content: string,
  timestamp = new Date().toISOString(),
): void {
  const projected = syncConstructionProjection(
    syncHumanState(content, loaded.state, loaded.plan, timestamp),
    loaded.state,
    loaded.plan,
  );
  writeFileAtomic(
    loaded.statePath,
    projected,
  );
}

/** Register a validated Bolt Plan without inventing lifecycle Audit events. */
export function initializeBoltExecution(projectDir: string): BoltInitialization {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const paths = activePaths(projectRoot);
    const plan = loadPlan(projectRoot, paths.planPath);
    let content = readFileSync(paths.statePath, "utf8");
    const existing = parseInternalState(content, plan);
    if (existing !== null) {
      if (existing.planHash !== plan.hash) {
        throw new Error("Bolt Plan changed after execution initialization; manual migration is required");
      }
      return {
        ...paths,
        plan,
        state: existing,
        next: deriveNext(plan, existing),
        replay: true,
      };
    }
    const version = Number(stateField(content, "State Version"));
    if (version !== STATE_VERSION && version !== STATE_VERSION - 1) {
      throw new Error(`Unsupported State Version for Bolt initialization: ${String(version)}`);
    }
    const phase = stateField(content, "Lifecycle Phase");
    const currentStage = stateField(content, "Current Stage") ?? "none";
    const perBoltStages = new Set([
      "functional-design", "nfr-requirements", "nfr-design",
      "infrastructure-design", "code-generation",
    ]);
    if (phase !== "CONSTRUCTION" || !perBoltStages.has(currentStage)) {
      throw new Error(
        `Bolt execution can initialize only at the first Construction Bolt boundary; ` +
          `current position is ${phase ?? "unknown"}/${currentStage}`,
      );
    }
    const completedConstruction = [
      "functional-design", "nfr-requirements", "nfr-design",
      "infrastructure-design", "code-generation",
    ].some((slug) => new RegExp(`^- \\[x\\] ${slug} `, "m").test(content));
    if (completedConstruction) {
      throw new Error(
        "Construction already has completed per-Bolt stages without Bolt evidence; manual migration is required",
      );
    }
    const state: BoltExecutionState = {
      schemaVersion: BOLT_EXECUTION_SCHEMA_VERSION,
      planHash: plan.hash,
      autonomy: "unset",
      bolts: plan.bolts.map((bolt) => {
        const actions = executionPlanActions(paths.recordDir);
        return {
          id: bolt.id,
          slug: bolt.slug,
          status: "pending",
          attempt: 0,
          gate: "pending",
          failure: null,
          worktreePath: null,
          ref: null,
          worktreeStatus: "none" as const,
          stages: BOLT_STAGE_SLUGS.map((slug) => ({
            slug,
            status: actions.get(slug) === "SKIP" ? "skipped" as const : "pending" as const,
            completedUnits: [],
          })),
        };
      }),
    };
    content = setStateField(content, "State Version", String(STATE_VERSION));
    content = syncHumanState(content, state, plan, new Date().toISOString());
    writeFileAtomic(paths.statePath, content);
    return {
      ...paths,
      plan,
      state,
      next: deriveNext(plan, state),
      replay: false,
    };
  });
}

export function loadBoltExecution(projectDir: string): LoadedBoltExecution {
  return readUnlocked(resolve(projectDir));
}

export function nextBoltExecution(projectDir: string): BoltNextAction {
  return loadBoltExecution(projectDir).next;
}

function boltPair(loaded: LoadedBoltExecution, id: string): {
  definition: BoltDefinition;
  run: BoltRunState;
} {
  const definition = loaded.plan.bolts.find((bolt) => bolt.id === id);
  const run = loaded.state.bolts.find((bolt) => bolt.id === id);
  if (definition === undefined || run === undefined) throw new Error(`Unknown Bolt "${id}"`);
  return { definition, run };
}

function stageCursorFor(
  loaded: LoadedBoltExecution,
  id: string,
): BoltStageCursor | null {
  const { definition, run } = boltPair(loaded, id);
  if (run.status !== "running") return null;
  const stage = currentStageProgress(run);
  if (stage === null) return null;
  const unit = definition.units.find((candidate) =>
    !stage.completedUnits.includes(candidate)
  );
  if (unit === undefined) {
    throw new Error(
      `Bolt stage ${id}/${stage.slug} is pending but has no pending Unit`,
    );
  }
  return {
    boltId: id,
    stage: stage.slug,
    unit,
    units: [...definition.units],
    completedUnits: [...stage.completedUnits],
  };
}

/** Return the deterministic Stage/Unit cursor for the first active Bolt. */
export function currentBoltStage(
  projectDir: string,
  id?: string,
): BoltStageCursor | null {
  const loaded = loadBoltExecution(projectDir);
  if (id !== undefined) return stageCursorFor(loaded, id);
  for (const definition of loaded.plan.bolts) {
    const run = loaded.state.bolts.find((bolt) => bolt.id === definition.id)!;
    if (run.status !== "running") continue;
    const cursor = stageCursorFor(loaded, run.id);
    if (cursor !== null) return cursor;
  }
  return null;
}

export function startBolt(
  projectDir: string,
  id: string,
  options: StartBoltOptions = {},
): BoltTransition {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { definition, run } = boltPair(loaded, id);
    if (run.status !== "pending") throw new Error(`Bolt "${id}" is ${run.status}, not pending`);
    if (loaded.state.bolts.some((bolt) => bolt.status === "failed" || bolt.status === "aborted")) {
      throw new Error("A failed or aborted Bolt must be resolved before another Bolt starts");
    }
    if (id !== "B1" && loaded.state.autonomy === "unset") {
      throw new Error("Construction autonomy is unset; resolve the walking-skeleton ladder first");
    }
    const active = loaded.state.bolts.filter((bolt) => ACTIVE_STATUSES.has(bolt.status));
    if (active.some((bolt) => bolt.status !== "running")) {
      throw new Error("An active Bolt gate or completion boundary must be resolved first");
    }
    const activeBatches = new Set(active.map((bolt) =>
      loaded.plan.bolts.find((definition) => definition.id === bolt.id)!.batch
    ));
    if (activeBatches.size > 0 && !activeBatches.has(definition.batch)) {
      throw new Error(`Bolt "${id}" is not in the active parallel batch`);
    }
    if (!readyPendingIds(loaded.plan, loaded.state).includes(id)) {
      throw new Error(`Bolt "${id}" dependencies are not ready`);
    }
    if (
      loaded.plan.worktree.enabled &&
      (options.worktreePath === undefined || options.ref === undefined)
    ) {
      throw new Error(
        `Bolt "${id}" requires a verified Worktree path and branch ref from its approved plan`,
      );
    }
    if (options.worktreePath !== undefined && !isAbsolute(options.worktreePath)) {
      throw new Error("Bolt worktreePath must be absolute");
    }
    if (options.ref !== undefined && (options.ref.trim() === "" || /[\r\n]/.test(options.ref))) {
      throw new Error("Bolt ref must be a non-empty single-line value");
    }
    run.status = "running";
    run.attempt += 1;
    run.failure = null;
    run.worktreePath = options.worktreePath === undefined
      ? run.worktreePath
      : portableEvidencePath(projectRoot, options.worktreePath);
    run.ref = options.ref ?? run.ref;
    if (options.worktreePath !== undefined) run.worktreeStatus = "active";
    if (!definition.walkingSkeleton && loaded.state.autonomy === "autonomous") {
      run.gate = "not-required";
    }
    const fields = {
      "Bolt ID": id,
      "Bolt names": id,
      "Bolt slug": definition.slug,
      "Batch number": String(definition.batch),
      "Walking skeleton": String(definition.walkingSkeleton),
      Attempt: String(run.attempt),
    };
    appendAuditOnce(projectRoot, loaded.recordDir, "BOLT_STARTED", fields, {
      "Bolt ID": id,
      Attempt: String(run.attempt),
    });
    appendInitialStageEvents(projectRoot, loaded, run);
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

/** Commit one Stage/Unit cell inside a running Bolt without opening a Stage gate. */
export function completeBoltStageUnit(
  projectDir: string,
  id: string,
  stageSlug: BoltStageSlug,
  unit: string,
): BoltStageTransition {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { definition, run } = boltPair(loaded, id);
    const stage = run.stages.find((candidate) => candidate.slug === stageSlug);
    if (stage === undefined) throw new Error(`Unknown Bolt stage "${stageSlug}"`);
    if (stage.completedUnits.includes(unit)) {
      return {
        boltId: id,
        stage: stageSlug,
        unit,
        replay: true,
        stageCompleted: stage.status === "completed",
        allStagesCompleted: allBoltStagesSettled(run),
        next: deriveNext(loaded.plan, loaded.state),
      };
    }
    if (run.status !== "running") {
      throw new Error(`Bolt "${id}" is ${run.status}, not running`);
    }
    const cursor = stageCursorFor(loaded, id);
    if (cursor === null) throw new Error(`Bolt "${id}" has no pending Stage/Unit`);
    if (cursor.stage !== stageSlug || cursor.unit !== unit) {
      throw new Error(
        `Cannot complete ${stageSlug}/${unit} out of order; next is ` +
          `${cursor.stage}/${cursor.unit}`,
      );
    }
    stage.completedUnits.push(unit);
    let stageCompleted = false;
    if (stage.completedUnits.length === definition.units.length) {
      stage.status = "completed";
      stageCompleted = true;
      appendAuditOnce(
        projectRoot,
        loaded.recordDir,
        "STAGE_COMPLETED",
        {
          Stage: stageSlug,
          "Bolt ID": id,
          Attempt: String(run.attempt),
          Details: `Completed for Units: ${definition.units.join(", ")}`,
        },
        { Stage: stageSlug, "Bolt ID": id, Attempt: String(run.attempt) },
      );
      const nextStage = currentStageProgress(run);
      if (nextStage !== null) {
        appendStageStart(projectRoot, loaded, run, nextStage.slug);
      }
    }
    persist(loaded, content);
    return {
      boltId: id,
      stage: stageSlug,
      unit,
      replay: false,
      stageCompleted,
      allStagesCompleted: allBoltStagesSettled(run),
      next: deriveNext(loaded.plan, loaded.state),
    };
  });
}

/** Skip one conditional Stage for the current Bolt with an explicit reason. */
export function skipBoltStage(
  projectDir: string,
  id: string,
  stageSlug: BoltStageSlug,
  reason: string,
): BoltStageTransition {
  const exact = reason.trim();
  if (!exact) throw new Error("A non-empty Bolt Stage skip reason is required");
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { definition, run } = boltPair(loaded, id);
    if (run.status !== "running") {
      throw new Error(`Bolt "${id}" is ${run.status}, not running`);
    }
    const cursor = stageCursorFor(loaded, id);
    if (cursor === null || cursor.stage !== stageSlug) {
      throw new Error(
        `Cannot skip ${stageSlug} out of order; next is ` +
          (cursor === null ? "none" : `${cursor.stage}/${cursor.unit}`),
      );
    }
    const node = loadCompiledStageGraph().find((candidate) => candidate.slug === stageSlug);
    if (node?.execution !== "CONDITIONAL") {
      throw new Error(`Bolt Stage "${stageSlug}" is not conditional`);
    }
    const stage = run.stages.find((candidate) => candidate.slug === stageSlug)!;
    stage.status = "skipped";
    stage.completedUnits = [];
    appendAuditOnce(
      projectRoot,
      loaded.recordDir,
      "STAGE_SKIPPED",
      {
        Stage: stageSlug,
        "Bolt ID": id,
        Attempt: String(run.attempt),
        Reason: exact,
      },
      { Stage: stageSlug, "Bolt ID": id, Attempt: String(run.attempt) },
    );
    const nextStage = currentStageProgress(run);
    if (nextStage !== null) {
      appendStageStart(projectRoot, loaded, run, nextStage.slug);
    }
    persist(loaded, content);
    return {
      boltId: id,
      stage: stageSlug,
      unit: null,
      replay: false,
      stageCompleted: true,
      allStagesCompleted: allBoltStagesSettled(run),
      next: deriveNext(loaded.plan, loaded.state),
    };
  });
}

export function completeBolt(projectDir: string, id: string): BoltTransition {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { definition, run } = boltPair(loaded, id);
    if (run.status === "completed") return transitionResult(run, loaded.plan, loaded.state, true);
    if (run.status === "awaiting-gate") {
      throw new Error(`Bolt "${id}" is awaiting gate approval`);
    }
    if (run.status === "awaiting-autonomy") {
      throw new Error(`Bolt "${id}" is awaiting the autonomy ladder`);
    }
    if (run.status !== "running" && run.status !== "ready-to-complete") {
      throw new Error(`Bolt "${id}" is ${run.status}, not completable`);
    }
    advanceBoltCompletion(projectRoot, loaded, definition, run);
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

/** Record a verified Worktree integration before a Bolt may complete. */
export function recordBoltIntegration(
  projectDir: string,
  id: string,
  ref: string,
): BoltTransition {
  const exact = ref.trim();
  if (!exact || /[\r\n]/.test(exact)) {
    throw new Error("Integrated Bolt ref must be a non-empty single-line value");
  }
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { run } = boltPair(loaded, id);
    if (run.status !== "ready-to-complete") {
      throw new Error(`Bolt "${id}" is ${run.status}, not ready for integration`);
    }
    if (run.worktreeStatus !== "active" && run.worktreeStatus !== "preserved") {
      if (run.worktreeStatus === "merged" && run.ref === exact) {
        return transitionResult(run, loaded.plan, loaded.state, true);
      }
      throw new Error(`Bolt "${id}" has no active or preserved Worktree`);
    }
    run.worktreeStatus = "merged";
    run.ref = exact;
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

export function approveBoltGate(
  projectDir: string,
  id: string,
  userInput: string,
): BoltTransition {
  const exact = userInput.trim();
  if (!exact) throw new Error("A non-empty human gate choice is required");
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { definition, run } = boltPair(loaded, id);
    if (run.gate === "approved") return transitionResult(run, loaded.plan, loaded.state, true);
    if (run.status !== "awaiting-gate") {
      throw new Error(`Bolt "${id}" is ${run.status}, not awaiting gate approval`);
    }
    run.gate = "approved";
    run.status = definition.walkingSkeleton && loaded.state.autonomy === "unset"
      ? "awaiting-autonomy"
      : "ready-to-complete";
    const fields = { Stage: "construction", "Bolt ID": id, "User Input": exact };
    appendAuditOnce(projectRoot, loaded.recordDir, "GATE_APPROVED", fields, {
      "Bolt ID": id,
      "User Input": exact,
    });
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

export function rejectBoltGate(
  projectDir: string,
  id: string,
  userInput: string,
): BoltTransition {
  const exact = userInput.trim();
  if (!exact) throw new Error("A non-empty human gate choice is required");
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { run } = boltPair(loaded, id);
    if (run.status !== "awaiting-gate") {
      throw new Error(`Bolt "${id}" is ${run.status}, not awaiting gate approval`);
    }
    const fields = { Stage: "construction", "Bolt ID": id, "User Input": exact };
    appendAuditOnce(projectRoot, loaded.recordDir, "GATE_REJECTED", fields, {
      "Bolt ID": id,
      "User Input": exact,
    });
    const revision = run.stages.find((stage) => stage.slug === "code-generation")!;
    revision.status = "pending";
    revision.completedUnits = [];
    run.status = "running";
    run.gate = "pending";
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

export function setBoltAutonomy(
  projectDir: string,
  mode: Exclude<BoltAutonomy, "unset">,
): { mode: Exclude<BoltAutonomy, "unset">; replay: boolean; next: BoltNextAction } {
  if (mode !== "autonomous" && mode !== "gated") {
    throw new Error("Construction autonomy mode must be autonomous or gated");
  }
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    if (loaded.state.autonomy !== "unset") {
      if (loaded.state.autonomy !== mode) {
        throw new Error(`Construction autonomy is already ${loaded.state.autonomy}`);
      }
      return { mode, replay: true, next: deriveNext(loaded.plan, loaded.state) };
    }
    const skeleton = loaded.state.bolts.find((bolt) => bolt.id === "B1")!;
    if (skeleton.gate !== "approved" && skeleton.status !== "skipped") {
      throw new Error("Construction autonomy can be set only after the B1 gate or explicit B1 skip");
    }
    loaded.state.autonomy = mode;
    if (skeleton.status === "awaiting-autonomy") skeleton.status = "ready-to-complete";
    const fields = { Mode: mode, "Bolt ID": "B1" };
    appendAuditOnce(projectRoot, loaded.recordDir, "AUTONOMY_MODE_SET", fields, fields);
    persist(loaded, content);
    return { mode, replay: false, next: deriveNext(loaded.plan, loaded.state) };
  });
}

export function failBolt(projectDir: string, id: string, reason: string): BoltTransition {
  const exact = reason.trim();
  if (!exact) throw new Error("A non-empty Bolt failure reason is required");
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { definition, run } = boltPair(loaded, id);
    if (!["running", "awaiting-gate", "awaiting-autonomy", "ready-to-complete"].includes(run.status)) {
      throw new Error(`Bolt "${id}" is ${run.status}, not active`);
    }
    run.status = "failed";
    run.failure = exact;
    const fields = {
      "Bolt ID": id,
      "Failed Bolt": id,
      "Bolt slug": definition.slug,
      Attempt: String(run.attempt),
      "Error summary": exact,
    };
    appendAuditOnce(projectRoot, loaded.recordDir, "BOLT_FAILED", fields, {
      "Bolt ID": id,
      Attempt: String(run.attempt),
      "Error summary": exact,
    });
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

export function retryBolt(projectDir: string, id: string): BoltTransition {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { definition, run } = boltPair(loaded, id);
    if (run.status !== "failed" && run.status !== "aborted") {
      throw new Error(`Bolt "${id}" is ${run.status}, not retryable`);
    }
    run.status = "running";
    run.attempt += 1;
    run.failure = null;
    if (run.worktreePath !== null && run.worktreeStatus !== "merged") {
      run.worktreeStatus = "active";
    }
    const fields = {
      "Bolt ID": id,
      "Bolt names": id,
      "Bolt slug": definition.slug,
      "Batch number": String(definition.batch),
      "Walking skeleton": String(definition.walkingSkeleton),
      Attempt: String(run.attempt),
      Retry: "true",
    };
    appendAuditOnce(projectRoot, loaded.recordDir, "BOLT_STARTED", fields, {
      "Bolt ID": id,
      Attempt: String(run.attempt),
    });
    appendInitialStageEvents(projectRoot, loaded, run);
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

export function skipBolt(
  projectDir: string,
  id: string,
  reason: string,
  userInput: string,
): BoltTransition {
  const exactReason = reason.trim();
  const exactInput = userInput.trim();
  if (!exactReason || !exactInput) throw new Error("Bolt skip requires a reason and exact user input");
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { run } = boltPair(loaded, id);
    if (run.status !== "failed") throw new Error(`Bolt "${id}" is ${run.status}, not failed`);
    run.status = "skipped";
    run.failure = exactReason;
    if (run.worktreeStatus === "active") run.worktreeStatus = "preserved";
    const fields = {
      Stage: "construction",
      "Bolt ID": id,
      Details: exactInput,
      Reason: exactReason,
    };
    appendAuditOnce(projectRoot, loaded.recordDir, "QUESTION_ANSWERED", fields, {
      "Bolt ID": id,
      Details: exactInput,
    });
    appendAggregateStartIfReady(projectRoot, loaded);
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

export function abortBolt(
  projectDir: string,
  id: string,
  reason: string,
  userInput: string,
): BoltTransition {
  const exactReason = reason.trim();
  const exactInput = userInput.trim();
  if (!exactReason || !exactInput) throw new Error("Bolt abort requires a reason and exact user input");
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const loaded = readUnlocked(projectRoot);
    const content = readFileSync(loaded.statePath, "utf8");
    const { definition, run } = boltPair(loaded, id);
    if (run.status !== "failed") throw new Error(`Bolt "${id}" is ${run.status}, not failed`);
    run.status = "aborted";
    run.failure = exactReason;
    if (run.worktreeStatus === "active") run.worktreeStatus = "preserved";
    const fields = {
      "Bolt ID": id,
      "Failed Bolt": id,
      "Bolt slug": definition.slug,
      Attempt: String(run.attempt),
      Reason: "aborted",
      Details: exactReason,
      "User Input": exactInput,
    };
    appendAuditOnce(projectRoot, loaded.recordDir, "BOLT_FAILED", fields, {
      "Bolt ID": id,
      Attempt: String(run.attempt),
      Reason: "aborted",
    });
    persist(loaded, content);
    return transitionResult(run, loaded.plan, loaded.state);
  });
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  const id = flagValue(args, "--bolt");
  try {
    if (!cliHasCommand(BOLT_CLI_CONTRACT, command)) {
      throw new Error(
        "Usage: aidlc-bolt <init|show|next|start|complete|record-integration|fail|retry|skip|abort|approve-gate|reject-gate|set-autonomy>",
      );
    }
    const unknownFlags = cliUnknownFlags(BOLT_CLI_CONTRACT, command, args);
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown flag(s) for ${command}: ${unknownFlags.join(", ")}`);
    }
    let result: unknown;
    if (command === "init") result = initializeBoltExecution(projectDir);
    else if (command === "show" || command === "next") result = loadBoltExecution(projectDir);
    else if (command === "set-autonomy") {
      const mode = flagValue(args, "--mode");
      if (mode !== "autonomous" && mode !== "gated") {
        throw new Error("set-autonomy requires --mode autonomous|gated");
      }
      result = setBoltAutonomy(projectDir, mode);
    } else {
      if (id === undefined) throw new Error(`${command ?? "command"} requires --bolt <id>`);
      if (command === "start") {
        result = startBolt(projectDir, id, {
          ...(flagValue(args, "--worktree") === undefined
            ? {}
            : { worktreePath: flagValue(args, "--worktree")! }),
          ...(flagValue(args, "--ref") === undefined ? {} : { ref: flagValue(args, "--ref")! }),
        });
      } else if (command === "complete") result = completeBolt(projectDir, id);
      else if (command === "record-integration") {
        result = recordBoltIntegration(
          projectDir,
          id,
          flagValue(args, "--ref") ?? "",
        );
      }
      else if (command === "fail") {
        result = failBolt(projectDir, id, flagValue(args, "--reason") ?? "");
      } else if (command === "retry") result = retryBolt(projectDir, id);
      else if (command === "skip") {
        result = skipBolt(
          projectDir,
          id,
          flagValue(args, "--reason") ?? "",
          flagValue(args, "--user-input") ?? "",
        );
      } else if (command === "abort") {
        result = abortBolt(
          projectDir,
          id,
          flagValue(args, "--reason") ?? "",
          flagValue(args, "--user-input") ?? "",
        );
      } else if (command === "approve-gate") {
        result = approveBoltGate(projectDir, id, flagValue(args, "--user-input") ?? "");
      } else if (command === "reject-gate") {
        result = rejectBoltGate(projectDir, id, flagValue(args, "--user-input") ?? "");
      } else {
        throw new Error(
          "Usage: aidlc-bolt <init|show|next|start|complete|record-integration|fail|retry|skip|abort|approve-gate|reject-gate|set-autonomy>",
        );
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
