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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CompiledStage,
  type ResolvedPlanStage,
  loadCompiledStageGraph,
  resolvePlanForScope,
} from "./aidlc-graph.ts";
import { loadScopes, type ScopeDepth } from "./aidlc-scope-loader.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import {
  detectWorkspace,
  type WorkspaceScan,
} from "./aidlc-workspace-detect.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";
import { appendAuditEntries, appendAuditEntry } from "./aidlc-audit.ts";
import type { UnitDag } from "./aidlc-unit-graph.ts";
import {
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";

const STATE_CLI_CONTRACT = loadCliContract("aidlc-state.ts");

export const STATE_VERSION = 7;

export type StateCheckbox =
  | "pending"
  | "in-progress"
  | "awaiting-approval"
  | "revising"
  | "completed"
  | "skipped";

export interface InitializeIntentStateOptions {
  scope: string;
  projectDescription?: string;
  depth?: ScopeDepth;
  testStrategy?: ScopeDepth;
  startedAt?: string;
  workspaceScan?: WorkspaceScan;
  force?: boolean;
}

export interface InitializedIntentState {
  recordDir: string;
  statePath: string;
  planPath: string;
  scope: string;
  projectType: WorkspaceScan["projectType"];
  firstStage: string | null;
  totalStages: number;
  completedStages: number;
}

export interface ResumePoint {
  recordDir: string;
  scope: string;
  lifecyclePhase: string;
  currentStage: string;
  nextStage: string;
  status: string;
  activeAgent: string;
  completed: number;
  totalStages: number;
  nextAction: string;
  checkboxState: StateCheckbox | "unknown";
  currentUnit: string | null;
}

export interface StateTransition {
  recordDir: string;
  stage: string;
  stageState: "completed" | "skipped";
  nextStage: string | null;
  workflowCompleted: boolean;
  completedStages: number;
}

export interface ApprovalTransition {
  recordDir: string;
  stage: string;
  stageState: "awaiting-approval" | "revising";
  revisionCount: number;
}

export interface PracticesPromotionResult {
  emitted: "PRACTICES_AFFIRMED";
  affirmedAt: string;
  teamPath: string;
  projectPath: string;
  sectionsWritten: string[];
  mandatedAppended: number;
  forbiddenAppended: number;
}

export interface DerivedStateRepair {
  recordDir: string;
  changedFields: string[];
  currentStage: string | null;
  workflowCompleted: boolean;
}

export interface DerivedStateInspection {
  recordDir: string;
  driftedFields: string[];
  desiredFields: Record<string, string>;
  currentStage: string | null;
  workflowCompleted: boolean;
}

export interface RecomposePlanResult {
  recordDir: string;
  added: string[];
  stagesInScope: number;
  completedStages: number;
  currentStage: string;
  nextStage: string | null;
}

export interface UnitStageTransition {
  recordDir: string;
  stage: string;
  unit: string;
  replay: boolean;
  nextUnit: string | null;
  allUnitsCompleted: boolean;
}

export type ConstructionIteration = "unit-major" | "stage-major";

export interface ConstructionIterationUpdate {
  recordDir: string;
  constructionIteration: ConstructionIteration;
}

const MARKER_BY_STATE: Record<StateCheckbox, string> = {
  pending: " ",
  "in-progress": "-",
  "awaiting-approval": "?",
  revising: "R",
  completed: "x",
  skipped: "S",
};

const STATE_BY_MARKER: Record<string, StateCheckbox> = {
  " ": "pending",
  "-": "in-progress",
  "?": "awaiting-approval",
  R: "revising",
  x: "completed",
  S: "skipped",
};

const UNIT_PROGRESS_START = "<!-- AIDLC_UNIT_PROGRESS_START -->";
const UNIT_PROGRESS_END = "<!-- AIDLC_UNIT_PROGRESS_END -->";

interface UnitProgressRow {
  marker: string;
  unit: string;
  stage: string;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The atomic rename may already have consumed the temporary file.
    }
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isoTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

function phaseLabel(phase: string): string {
  return `${phase.slice(0, 1).toUpperCase()}${phase.slice(1)}`;
}

export function activeIntentRecordDir(projectDir: string): string {
  const projectRoot = resolve(projectDir);
  const space = activeSpace(projectRoot);
  const intentsRoot = join(workspaceRoot(projectRoot), "spaces", space, "intents");
  let intent = "";
  try {
    intent = readFileSync(join(intentsRoot, "active-intent"), "utf8").trim();
  } catch {
    throw new Error(
      `No active intent in space "${space}". Birth or switch an intent first.`,
    );
  }
  if (intent.length === 0) {
    throw new Error(`Active intent pointer is empty in space "${space}"`);
  }
  const recordDir = join(intentsRoot, intent);
  if (!existsSync(recordDir)) {
    throw new Error(`Active intent record does not exist: ${recordDir}`);
  }
  return recordDir;
}

export function stateFilePath(projectDir: string): string {
  return join(activeIntentRecordDir(projectDir), "aidlc-state.md");
}

export function planFilePath(projectDir: string): string {
  return join(activeIntentRecordDir(projectDir), ".aidlc-plan.json");
}

function adjustedPlan(
  scope: string,
  scan: WorkspaceScan,
): ResolvedPlanStage[] {
  return resolvePlanForScope(scope).map((stage) =>
    scan.projectType === "Greenfield" && stage.slug === "reverse-engineering"
      ? { ...stage, action: "SKIP" }
      : stage
  );
}

function nextExecutableStage(
  plan: readonly ResolvedPlanStage[],
  content: string,
  afterSlug?: string,
): ResolvedPlanStage | null {
  const start = afterSlug === undefined
    ? 0
    : plan.findIndex((stage) => stage.slug === afterSlug) + 1;
  for (let index = Math.max(0, start); index < plan.length; index += 1) {
    const stage = plan[index];
    if (stage === undefined) continue;
    const stateAction = stageProgressAction(content, stage.slug);
    const action = stateAction ?? stage.action;
    if (action !== "EXECUTE") continue;
    const state = checkboxState(content, stage.slug);
    if (state !== "completed" && state !== "skipped") return stage;
  }
  return null;
}

function stageProgressAction(
  content: string,
  slug: string,
): "EXECUTE" | "SKIP" | null {
  const pattern = new RegExp(
    `^- \\[[ xS?R-]\\] ${escapeRegExp(slug)} \\u2014 (EXECUTE|SKIP)(?::|$)`,
    "m",
  );
  const action = pattern.exec(content)?.[1];
  return action === "EXECUTE" || action === "SKIP" ? action : null;
}

function nextPostInitializationStage(
  plan: readonly ResolvedPlanStage[],
): ResolvedPlanStage | null {
  return plan.find(
    (stage) => stage.phase !== "initialization" && stage.action === "EXECUTE",
  ) ?? null;
}

function stageAfter(
  plan: readonly ResolvedPlanStage[],
  slug: string,
): ResolvedPlanStage | null {
  const emptyState = "";
  return nextExecutableStage(plan, emptyState, slug);
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
  if (!pattern.test(content)) {
    throw new Error(`State file is missing required field "${field}"`);
  }
  return content.replace(pattern, () => `- **${field}**: ${value}`);
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
  if (pattern.test(content)) {
    return content.replace(pattern, () => `- **${field}**: ${value}`);
  }
  const heading = `## ${section}`;
  const headingIndex = content.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`State file is missing required section "${section}"`);
  }
  const lineEnd = content.indexOf("\n", headingIndex + heading.length);
  if (lineEnd === -1) {
    return `${content}\n- **${field}**: ${value}\n`;
  }
  return `${content.slice(0, lineEnd + 1)}- **${field}**: ${value}\n${content.slice(lineEnd + 1)}`;
}

function checkboxState(content: string, slug: string): StateCheckbox | "unknown" {
  const pattern = new RegExp(
    `^- \\[([ xS?R-])\\] ${escapeRegExp(slug)}(?:\\s|$)`,
    "m",
  );
  const marker = pattern.exec(content)?.[1];
  return marker === undefined ? "unknown" : STATE_BY_MARKER[marker] ?? "unknown";
}

function unitProgressRows(content: string): UnitProgressRow[] {
  return [...content.matchAll(
    /^- \[([ xS?R-])\] Unit: ([a-z0-9]+(?:-[a-z0-9]+)*) — ([a-z0-9]+(?:-[a-z0-9]+)*)$/gm,
  )].map((match) => ({
    marker: match[1] ?? " ",
    unit: match[2] ?? "",
    stage: match[3] ?? "",
  }));
}

function currentUnitForStage(content: string, slug: string): string | null {
  return unitProgressRows(content).find(
    (row) => row.stage === slug && row.marker !== "x" && row.marker !== "S",
  )?.unit ?? null;
}

function setUnitProgressMarker(
  content: string,
  slug: string,
  unit: string,
  marker: "x" | "S",
): string {
  const pattern = new RegExp(
    `^(- \\[)[ xS?R-](\\] Unit: ${escapeRegExp(unit)} — ${escapeRegExp(slug)})$`,
    "m",
  );
  if (!pattern.test(content)) {
    throw new Error(`State file has no Unit row for "${unit}" / "${slug}"`);
  }
  return content.replace(pattern, `$1${marker}$2`);
}

function skipUnitProgressForStage(content: string, slug: string): string {
  const pattern = new RegExp(
    `^(- \\[)[ x?R-](\\] Unit: [a-z0-9]+(?:-[a-z0-9]+)* — ${escapeRegExp(slug)})$`,
    "gm",
  );
  return content.replace(pattern, "$1S$2");
}

function setCheckboxState(
  content: string,
  slug: string,
  state: StateCheckbox,
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
    (_line, prefix: string, suffix: string) =>
      `${prefix}${MARKER_BY_STATE[state]}${suffix}`,
  );
}

function setStageProgressSuffix(
  content: string,
  slug: string,
  suffix: string,
): string {
  const pattern = new RegExp(
    `^(- \\[[ xS?R-]\\] ${escapeRegExp(slug)} \\u2014 )[^\\n]*$`,
    "m",
  );
  if (!pattern.test(content)) {
    throw new Error(`State file has no stage progress row for "${slug}"`);
  }
  return content.replace(pattern, (_line, prefix: string) => `${prefix}${suffix}`);
}

function setPhaseState(content: string, phase: string, value: string): string {
  return setStateField(content, phaseLabel(phase), value);
}

function completedCheckboxCount(content: string): number {
  return [...content.matchAll(/^- \[x\] [a-z][a-z0-9-]*(?:\s|$)/gm)].length;
}

function readPlan(recordDir: string): ResolvedPlanStage[] {
  const path = join(recordDir, ".aidlc-plan.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read execution plan at ${path}: ${detail}`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid execution plan at ${path}: expected an array`);
  }
  return value.map((row, index) => {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof (row as Record<string, unknown>).slug !== "string" ||
      typeof (row as Record<string, unknown>).phase !== "string" ||
      !["EXECUTE", "SKIP"].includes(
        String((row as Record<string, unknown>).action),
      )
    ) {
      throw new Error(`Invalid execution plan at ${path}: bad row ${index}`);
    }
    return row as ResolvedPlanStage;
  });
}

function graphBySlug(): Map<string, CompiledStage> {
  return new Map(loadCompiledStageGraph().map((stage) => [stage.slug, stage]));
}

function renderState(
  projectDir: string,
  options: InitializeIntentStateOptions,
  scan: WorkspaceScan,
  plan: readonly ResolvedPlanStage[],
  graph: readonly CompiledStage[],
): { content: string; firstStage: ResolvedPlanStage | null; completed: number } {
  const scopeDefinition = loadScopes().find((scope) => scope.name === options.scope);
  if (scopeDefinition === undefined) {
    throw new Error(`Unknown scope: "${options.scope}"`);
  }
  const depth = options.depth ?? scopeDefinition.depth;
  const testStrategy =
    options.testStrategy ?? scopeDefinition.testStrategy ?? depth;
  const startedAt = options.startedAt ?? isoTimestamp();
  const firstStage = nextPostInitializationStage(plan);
  const firstEntry = firstStage === null
    ? undefined
    : graph.find((stage) => stage.slug === firstStage.slug);
  const phases = [...new Set(graph.map((stage) => stage.phase))];
  const initializationSlugs = new Set(
    plan
      .filter(
        (stage) => stage.phase === "initialization" && stage.action === "EXECUTE",
      )
      .map((stage) => stage.slug),
  );
  const completed = initializationSlugs.size;
  const executeNumbers = graph
    .filter(
      (stage) => plan.find((row) => row.slug === stage.slug)?.action === "EXECUTE",
    )
    .map((stage) => stage.number);
  const skippedStages = graph
    .filter(
      (stage) => plan.find((row) => row.slug === stage.slug)?.action === "SKIP",
    )
    .map((stage) =>
      scan.projectType === "Greenfield" && stage.slug === "reverse-engineering"
        ? `${stage.number} (reverse-engineering — greenfield)`
        : `${stage.number} (${stage.slug})`
    );

  const phaseProgress = phases.map((phase) => {
    let status = "Pending";
    if (phase === "initialization") status = "Verified";
    else if (firstStage?.phase === phase) status = "Active";
    else if (!plan.some((stage) => stage.phase === phase && stage.action === "EXECUTE")) {
      status = "Skipped";
    }
    return `- **${phaseLabel(phase)}**: ${status}`;
  }).join("\n");

  const progressSections = phases.map((phase) => {
    const rows = graph
      .filter((stage) => stage.phase === phase)
      .map((stage) => {
        const action = plan.find((row) => row.slug === stage.slug)?.action ?? "SKIP";
        let marker = " ";
        if (initializationSlugs.has(stage.slug)) marker = "x";
        if (stage.slug === firstStage?.slug) marker = "-";
        return `- [${marker}] ${stage.slug} — ${action}`;
      });
    const unitHint = phase === "construction"
      ? [UNIT_PROGRESS_START, "Per unit: [TBD]", UNIT_PROGRESS_END]
      : [];
    return `### ${phase.toUpperCase()} PHASE\n${[...unitHint, ...rows].join("\n")}`;
  }).join("\n\n");

  const nextStage = firstStage === null ? null : stageAfter(plan, firstStage.slug);
  const lifecyclePhase = firstStage?.phase.toUpperCase() ?? "READY";
  const currentStage = firstStage?.slug ?? "none";
  const activeAgent = firstEntry?.lead_agent ?? "";
  const status = firstStage === null ? "Completed" : "Running";
  const projectDescription = options.projectDescription?.trim() || "[Project description]";

  return {
    firstStage,
    completed,
    content: `# AI-DLC State Tracking

## Project Information
- **Project**: ${projectDescription}
- **Project Type**: ${scan.projectType}
- **Scope**: ${options.scope}
- **Start Date**: ${startedAt}
- **State Version**: ${STATE_VERSION}
- **Active Agent**: ${activeAgent}
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: ${executeNumbers.join(", ")}
- **Stages to Skip**: ${skippedStages.length > 0 ? skippedStages.join(", ") : "none"}
- **Depth**: ${depth}
- **Test Strategy**: ${testStrategy}

## Workspace State
- **Project Root**: ${resolve(projectDir)}
- **Languages**: ${scan.languages}
- **Frameworks**: ${scan.frameworks}
- **Build System**: ${scan.buildSystem}

## Execution Plan Summary
- **Total Stages**: ${executeNumbers.length}
- **Completed**: ${completed}
- **In Progress**: ${currentStage}

## Runtime State
- **Revision Count**: 0

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

${phaseProgress}

## Stage Progress
<!-- Checkbox states: [ ] pending, [-] in-progress, [?] awaiting approval, [R] revising, [x] completed, [S] skipped -->

${progressSections}

## Current Status
- **Lifecycle Phase**: ${lifecyclePhase}
- **Current Stage**: ${currentStage}
- **Next Stage**: ${nextStage?.slug ?? "none"}
- **Status**: ${status}
- **Construction Autonomy Mode**: unset
- **Last Updated**: ${startedAt}

## Session Resume Point
- **Last Completed Stage**: state-init
- **Next Action**: ${firstStage === null ? "Workflow complete" : `Execute ${firstStage.slug}`}
- **Pending Artifacts**: none
`,
  };
}

/** Write the full v2 state contract and its resolved plan into one Intent. */
export function initializeIntentStateAt(
  projectDir: string,
  recordDir: string,
  options: InitializeIntentStateOptions,
): InitializedIntentState {
  const absoluteRecordDir = resolve(recordDir);
  const statePath = join(absoluteRecordDir, "aidlc-state.md");
  const planPath = join(absoluteRecordDir, ".aidlc-plan.json");
  if (existsSync(statePath) && !options.force) {
    const existing = readFileSync(statePath, "utf8").trim();
    if (existing !== "# AI-DLC State Tracking") {
      throw new Error(
        `State is already initialized at ${statePath}. Use force only for an intentional rebuild.`,
      );
    }
  }

  const scan = options.workspaceScan ?? detectWorkspace(projectDir);
  const graph = loadCompiledStageGraph();
  const scopePlan = resolvePlanForScope(options.scope);
  const routedPlan = adjustedPlan(options.scope, scan);
  const rendered = renderState(projectDir, options, scan, routedPlan, graph);
  mkdirSync(absoluteRecordDir, { recursive: true });
  writeFileAtomic(planPath, `${JSON.stringify(scopePlan, null, 2)}\n`);
  writeFileAtomic(statePath, rendered.content);
  return {
    recordDir: absoluteRecordDir,
    statePath,
    planPath,
    scope: options.scope,
    projectType: scan.projectType,
    firstStage: rendered.firstStage?.slug ?? null,
    totalStages: routedPlan.filter((stage) => stage.action === "EXECUTE").length,
    completedStages: rendered.completed,
  };
}

export function initializeActiveIntentState(
  projectDir: string,
  options: InitializeIntentStateOptions,
): InitializedIntentState {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () =>
    initializeIntentStateAt(
      projectRoot,
      activeIntentRecordDir(projectRoot),
      options,
    )
  );
}

function updateActiveIntentStatus(projectDir: string, status: string): void {
  const projectRoot = resolve(projectDir);
  const space = activeSpace(projectRoot);
  const intentsRoot = join(workspaceRoot(projectRoot), "spaces", space, "intents");
  const active = readFileSync(join(intentsRoot, "active-intent"), "utf8").trim();
  const registryPath = join(intentsRoot, "intents.json");
  let registry: Array<Record<string, unknown>>;
  try {
    const value: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!Array.isArray(value)) return;
    registry = value as Array<Record<string, unknown>>;
  } catch {
    return;
  }
  const entry = registry.find((row) => row.dirName === active);
  if (entry === undefined || entry.status === status) return;
  entry.status = status;
  writeFileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Materialize the active workflow's deterministic per-Unit State rows. */
export function hydrateConstructionUnitProgress(
  projectDir: string,
  dag: UnitDag,
): string[] {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeIntentRecordDir(projectRoot);
    const path = join(recordDir, "aidlc-state.md");
    let content = readFileSync(path, "utf8");
    const existing = new Map(
      unitProgressRows(content).map((row) => [
        `${row.stage}\u0000${row.unit}`,
        row.marker,
      ]),
    );
    const plan = readPlan(recordDir);
    const routed = new Map(plan.map((row) => [row.slug, row.action]));
    const stages = loadCompiledStageGraph().filter(
      (stage) =>
        stage.for_each === "unit-of-work" && routed.get(stage.slug) === "EXECUTE",
    );
    const units = dag.batches.flat();
    const rows = stages.flatMap((stage) =>
      units.map((unit) => {
        const marker = existing.get(`${stage.slug}\u0000${unit}`) ?? " ";
        return `- [${marker}] Unit: ${unit} — ${stage.slug}`;
      })
    );
    const replacement = [
      UNIT_PROGRESS_START,
      rows.length === 0 ? "Per unit: none" : "Per unit:",
      ...rows,
      UNIT_PROGRESS_END,
    ].join("\n");
    const block = new RegExp(
      `${escapeRegExp(UNIT_PROGRESS_START)}[\\s\\S]*?${escapeRegExp(UNIT_PROGRESS_END)}`,
    );
    if (block.test(content)) {
      content = content.replace(block, replacement);
    } else if (/^Per unit: \[TBD\]$/m.test(content)) {
      // State Version 7 records created before Unit execution support used a
      // single placeholder line. Upgrade that line in place on first hydrate.
      content = content.replace(/^Per unit: \[TBD\]$/m, replacement);
    } else {
      throw new Error(
        "State file is missing the Construction Unit progress placeholder",
      );
    }
    content = setStateField(content, "Last Updated", isoTimestamp());
    writeFileAtomic(path, content);
    return units;
  });
}

/** Persist the opt-in Construction Unit walk order under Runtime State. */
export function setConstructionIteration(
  projectDir: string,
  value: ConstructionIteration,
): ConstructionIterationUpdate {
  if (value !== "unit-major" && value !== "stage-major") {
    throw new Error(
      `Invalid construction iteration "${String(value)}". ` +
        "Valid values: unit-major, stage-major",
    );
  }
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeIntentRecordDir(projectRoot);
    const path = join(recordDir, "aidlc-state.md");
    const content = readFileSync(path, "utf8");
    const updated = setOrInsertStateField(
      content,
      "Runtime State",
      "Construction Iteration",
      value,
    );
    writeFileAtomic(path, updated);
    return { recordDir, constructionIteration: value };
  });
}

/** Mark every Unit row for the current per-Unit Stage complete in one update. */
export function completeAllCurrentStageUnits(
  projectDir: string,
  slug: string,
): string[] {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeIntentRecordDir(projectRoot);
    const path = join(recordDir, "aidlc-state.md");
    let content = readFileSync(path, "utf8");
    const current = stateField(content, "Current Stage");
    if (current !== slug) {
      throw new Error(
        `Cannot complete Units for "${slug}": Current Stage is "${current ?? "unknown"}"`,
      );
    }
    const node = graphBySlug().get(slug);
    if (node?.for_each !== "unit-of-work") {
      throw new Error(`Stage "${slug}" is not a per-Unit stage`);
    }
    const rows = unitProgressRows(content).filter((row) => row.stage === slug);
    if (rows.length === 0) {
      throw new Error(`Stage "${slug}" has no Unit progress rows`);
    }
    for (const row of rows) {
      if (row.marker !== "x" && row.marker !== "S") {
        content = setUnitProgressMarker(content, slug, row.unit, "x");
      }
    }
    content = setStateField(content, "Next Action", `Complete ${slug} after all Units`);
    content = setStateField(content, "Last Updated", isoTimestamp());
    writeFileAtomic(path, content);
    return rows.map((row) => row.unit);
  });
}

/** Record one verified Unit output set without advancing the parent Stage. */
export function completeCurrentUnitStage(
  projectDir: string,
  slug: string,
  unit: string,
  approvalInput?: string,
): UnitStageTransition {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeIntentRecordDir(projectRoot);
    const path = join(recordDir, "aidlc-state.md");
    let content = readFileSync(path, "utf8");
    const current = stateField(content, "Current Stage");
    if (current !== slug) {
      throw new Error(
        `Cannot complete Unit "${unit}" for "${slug}": Current Stage is "${current ?? "unknown"}"`,
      );
    }
    const node = graphBySlug().get(slug);
    if (node?.for_each !== "unit-of-work") {
      throw new Error(`Stage "${slug}" is not a per-Unit stage`);
    }
    const before = unitProgressRows(content).find(
      (row) => row.stage === slug && row.unit === unit,
    );
    if (before === undefined) {
      throw new Error(`Unknown Unit "${unit}" for stage "${slug}"`);
    }
    if (
      approvalInput !== undefined &&
      checkboxState(content, slug) !== "awaiting-approval"
    ) {
      throw new Error(
        `Cannot approve Unit "${unit}" for "${slug}": Stage is not awaiting-approval`,
      );
    }
    const replay = before.marker === "x";
    if (!replay) content = setUnitProgressMarker(content, slug, unit, "x");
    const remaining = unitProgressRows(content).filter(
      (row) => row.stage === slug && row.marker !== "x" && row.marker !== "S",
    );
    const nextUnit = remaining[0]?.unit ?? null;
    if (approvalInput !== undefined && nextUnit !== null) {
      const exactInput = approvalInput.trim();
      if (!exactInput) throw new Error("A non-empty human approval choice is required");
      appendAuditEntry(projectRoot, recordDir, "GATE_APPROVED", {
        Stage: slug,
        Unit: unit,
        "User Input": exactInput,
      });
      content = setCheckboxState(content, slug, "in-progress");
      content = setStateField(content, "Revision Count", "0");
    }
    content = setStateField(
      content,
      "Next Action",
      nextUnit === null
        ? `Complete ${slug} after all Units`
        : `Execute ${slug} for Unit ${nextUnit}`,
    );
    content = setStateField(content, "Last Updated", isoTimestamp());
    writeFileAtomic(path, content);
    return {
      recordDir,
      stage: slug,
      unit,
      replay,
      nextUnit,
      allUnitsCompleted: nextUnit === null,
    };
  });
}

function transitionCurrentStage(
  projectDir: string,
  slug: string,
  result: "completed" | "skipped",
  reason?: string,
  approvalInput?: string,
): StateTransition {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeIntentRecordDir(projectRoot);
    const path = join(recordDir, "aidlc-state.md");
    let content = readFileSync(path, "utf8");
    const current = stateField(content, "Current Stage");
    if (current !== slug) {
      throw new Error(
        `Cannot ${result === "completed" ? "complete" : "skip"} "${slug}": Current Stage is "${current ?? "unknown"}"`,
      );
    }
    const currentState = checkboxState(content, slug);
    if (!["in-progress", "awaiting-approval", "revising"].includes(currentState)) {
      throw new Error(`Stage "${slug}" is ${currentState}, not active`);
    }
    if (approvalInput !== undefined && currentState !== "awaiting-approval") {
      throw new Error(
        `Cannot approve "${slug}": Stage is ${currentState}, not awaiting-approval`,
      );
    }

    const plan = readPlan(recordDir);
    const graph = graphBySlug();
    const currentEntry = graph.get(slug);
    if (currentEntry === undefined) throw new Error(`Unknown stage: "${slug}"`);
    const scope = stateField(content, "Scope");
    if (scope === null || scope.length === 0) {
      throw new Error("State file has no Scope field");
    }
    const unitRows = unitProgressRows(content).filter(
      (row) => row.stage === slug,
    );
    if (
      result === "completed" && unitRows.length > 0 &&
      unitRows.some((row) => row.marker !== "x" && row.marker !== "S")
    ) {
      throw new Error(
        `Cannot complete per-Unit stage "${slug}": not all Units are complete`,
      );
    }
    if (result === "skipped" && unitRows.length > 0) {
      content = skipUnitProgressForStage(content, slug);
    }
    content = setCheckboxState(
      content,
      slug,
      result === "completed" ? "completed" : "skipped",
    );
    if (result === "skipped") {
      content = setStageProgressSuffix(content, slug, `SKIP: ${reason}`);
    }
    const next = nextExecutableStage(plan, content, slug);
    const nextEntry = next === null ? null : graph.get(next.slug);
    if (next !== null && nextEntry === undefined) {
      throw new Error(`Unknown stage: "${next.slug}"`);
    }
    const crossesPhaseBoundary =
      next !== null && currentEntry.phase !== next.phase;
    const timestamp = isoTimestamp();
    if (next === null) {
      content = setStateField(content, "Active Agent", "");
      content = setStateField(content, "In Progress", "none");
      content = setStateField(content, "Lifecycle Phase", "READY");
      content = setStateField(content, "Current Stage", "none");
      content = setStateField(content, "Next Stage", "none");
      content = setStateField(content, "Status", "Completed");
      content = setStateField(content, "Next Action", "Workflow complete");
      content = setPhaseState(content, currentEntry.phase, "Verified");
    } else {
      if (nextEntry === null || nextEntry === undefined) {
        throw new Error(`Unknown stage: "${next.slug}"`);
      }
      content = setCheckboxState(content, next.slug, "in-progress");
      const afterNext = nextExecutableStage(plan, content, next.slug);
      content = setStateField(content, "Active Agent", nextEntry.lead_agent);
      content = setStateField(content, "In Progress", next.slug);
      content = setStateField(content, "Lifecycle Phase", next.phase.toUpperCase());
      content = setStateField(content, "Current Stage", next.slug);
      content = setStateField(content, "Next Stage", afterNext?.slug ?? "none");
      content = setStateField(content, "Status", "Running");
      content = setStateField(content, "Next Action", `Execute ${next.slug}`);
      if (crossesPhaseBoundary) {
        content = setPhaseState(content, currentEntry.phase, "Verified");
        content = setPhaseState(content, next.phase, "Active");
      }
    }
    if (result === "completed") {
      content = setStateField(content, "Last Completed Stage", slug);
      content = setStateField(content, "Revision Count", "0");
    }
    const completedStages = completedCheckboxCount(content);
    content = setStateField(content, "Completed", String(completedStages));
    content = setStateField(content, "Last Updated", timestamp);

    // Audit-first transition: the Workspace lock already held by this function
    // serializes the audit append and State write as one mutation path. If an
    // audit append throws, the State write below is not attempted.
    if (result === "completed") {
      if (approvalInput !== undefined) {
        appendAuditEntry(projectRoot, recordDir, "GATE_APPROVED", {
          Stage: slug,
          "User Input": approvalInput,
        });
      }
      appendAuditEntry(projectRoot, recordDir, "STAGE_COMPLETED", {
        Stage: slug,
        Details: next === null
          ? `Final stage ${currentEntry.name} completed`
          : `Stage ${currentEntry.name} completed`,
      });
    } else {
      appendAuditEntry(projectRoot, recordDir, "STAGE_SKIPPED", {
        Stage: slug,
        Reason: reason ?? "unspecified",
      });
    }
    if (next !== null) {
      if (nextEntry === null || nextEntry === undefined) {
        throw new Error(`Unknown stage: "${next.slug}"`);
      }
      if (crossesPhaseBoundary) {
        appendAuditEntry(projectRoot, recordDir, "PHASE_COMPLETED", {
          "From phase": currentEntry.phase,
          "To phase": next.phase,
          "Stages completed": String(completedStages),
        });
        appendAuditEntry(projectRoot, recordDir, "PHASE_VERIFIED", {
          "Phase boundary": `${currentEntry.phase} → ${next.phase}`,
        });
        appendAuditEntry(projectRoot, recordDir, "PHASE_STARTED", {
          Phase: next.phase,
          Scope: scope,
        });
      }
      appendAuditEntry(projectRoot, recordDir, "STAGE_STARTED", {
        Stage: next.slug,
        Agent: nextEntry.lead_agent,
      });
    } else {
      appendAuditEntry(projectRoot, recordDir, "PHASE_COMPLETED", {
        "From phase": currentEntry.phase,
        "To phase": "(end)",
        "Stages completed": String(completedStages),
      });
      appendAuditEntry(projectRoot, recordDir, "PHASE_VERIFIED", {
        "Phase boundary": `${currentEntry.phase} → end`,
      });
      appendAuditEntry(projectRoot, recordDir, "WORKFLOW_COMPLETED", {
        Scope: scope,
        Details: result === "completed"
          ? `Scope: ${scope}, ${completedStages} stages completed`
          : `Scope: ${scope}, final stage ${slug} skipped`,
        ...(result === "skipped" ? { Reason: reason ?? "unspecified" } : {}),
      });
    }
    writeFileAtomic(path, content);
    if (next === null) updateActiveIntentStatus(projectRoot, "complete");
    return {
      recordDir,
      stage: slug,
      stageState: result,
      nextStage: next?.slug ?? null,
      workflowCompleted: next === null,
      completedStages,
    };
  });
}

export function completeCurrentStage(
  projectDir: string,
  slug: string,
): StateTransition {
  return transitionCurrentStage(projectDir, slug, "completed");
}

/** Approve an open human gate and route to the next Stage atomically. */
export function approveCurrentStage(
  projectDir: string,
  slug: string,
  userInput: string,
): StateTransition {
  const exactInput = userInput.trim();
  if (!exactInput) {
    throw new Error("A non-empty human approval choice is required");
  }
  return transitionCurrentStage(
    projectDir,
    slug,
    "completed",
    undefined,
    exactInput,
  );
}

function transitionApprovalState(
  projectDir: string,
  slug: string,
  action: "open" | "reject" | "revise",
  feedback?: string,
): ApprovalTransition {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeIntentRecordDir(projectRoot);
    const path = join(recordDir, "aidlc-state.md");
    let content = readFileSync(path, "utf8");
    const current = stateField(content, "Current Stage");
    if (current !== slug) {
      throw new Error(
        `Cannot update approval for "${slug}": Current Stage is "${current ?? "unknown"}"`,
      );
    }
    const before = checkboxState(content, slug);
    const revisionCount = Number(stateField(content, "Revision Count") ?? "0");
    const safeRevisionCount = Number.isInteger(revisionCount) && revisionCount >= 0
      ? revisionCount
      : 0;
    const timestamp = isoTimestamp();

    if (action === "open") {
      if (before !== "in-progress") {
        throw new Error(
          `Cannot open approval for "${slug}": Stage is ${before}, not in-progress`,
        );
      }
      content = setCheckboxState(content, slug, "awaiting-approval");
      content = setStateField(content, "Next Action", `Await approval for ${slug}`);
      content = setStateField(content, "Last Updated", timestamp);
      appendAuditEntry(projectRoot, recordDir, "STAGE_AWAITING_APPROVAL", {
        Stage: slug,
      });
      writeFileAtomic(path, content);
      return {
        recordDir,
        stage: slug,
        stageState: "awaiting-approval",
        revisionCount: safeRevisionCount,
      };
    }

    if (action === "reject") {
      const exactFeedback = feedback?.trim() ?? "";
      if (!exactFeedback) throw new Error("A non-empty rejection reason is required");
      if (before !== "in-progress" && before !== "awaiting-approval") {
        throw new Error(
          `Cannot reject "${slug}": Stage is ${before}, not active or awaiting-approval`,
        );
      }
      const nextRevisionCount = safeRevisionCount + 1;
      content = setCheckboxState(content, slug, "revising");
      content = setStateField(content, "Revision Count", String(nextRevisionCount));
      content = setStateField(content, "Next Action", `Revise ${slug}`);
      content = setStateField(content, "Last Updated", timestamp);
      appendAuditEntries(projectRoot, recordDir, [
        ...(before === "in-progress"
          ? [{
              event: "STAGE_AWAITING_APPROVAL" as const,
              fields: { Stage: slug, Recovered: "true" },
            }]
          : []),
        {
          event: "GATE_REJECTED",
          fields: { Stage: slug, Feedback: exactFeedback },
        },
        {
          event: "STAGE_REVISING",
          fields: {
            Stage: slug,
            "Revision count": String(nextRevisionCount),
            Feedback: exactFeedback,
          },
        },
      ]);
      writeFileAtomic(path, content);
      return {
        recordDir,
        stage: slug,
        stageState: "revising",
        revisionCount: nextRevisionCount,
      };
    }

    if (before !== "revising") {
      throw new Error(
        `Cannot re-open approval for "${slug}": Stage is ${before}, not revising`,
      );
    }
    content = setCheckboxState(content, slug, "awaiting-approval");
    content = setStateField(content, "Next Action", `Await approval for ${slug}`);
    content = setStateField(content, "Last Updated", timestamp);
    appendAuditEntry(projectRoot, recordDir, "STAGE_AWAITING_APPROVAL", {
      Stage: slug,
      Details: "Re-entering gate after revision",
    });
    writeFileAtomic(path, content);
    return {
      recordDir,
      stage: slug,
      stageState: "awaiting-approval",
      revisionCount: safeRevisionCount,
    };
  });
}

export function openApprovalGate(
  projectDir: string,
  slug: string,
): ApprovalTransition {
  return transitionApprovalState(projectDir, slug, "open");
}

export function rejectApprovalGate(
  projectDir: string,
  slug: string,
  feedback: string,
): ApprovalTransition {
  return transitionApprovalState(projectDir, slug, "reject", feedback);
}

export function reviseApprovalGate(
  projectDir: string,
  slug: string,
): ApprovalTransition {
  return transitionApprovalState(projectDir, slug, "revise");
}

export function skipCurrentStage(
  projectDir: string,
  slug: string,
  reason: string,
): StateTransition {
  if (reason.trim().length === 0) {
    throw new Error("A non-empty skip reason is required");
  }
  return transitionCurrentStage(projectDir, slug, "skipped", reason.trim());
}

interface ParsedAuditEvent {
  event: string;
  stage: string | null;
  timestamp: string;
  position: number;
}

function auditField(block: string, field: string): string | null {
  const prefix = `**${field}**:`;
  return block.split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length).trim() ?? null;
}

function activeAuditEvents(recordDir: string): ParsedAuditEvent[] {
  const auditDir = join(recordDir, "audit");
  let position = 0;
  const events: ParsedAuditEvent[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(auditDir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  for (const name of names) {
    const source = readFileSync(join(auditDir, name), "utf8").replace(/\r\n/g, "\n");
    for (const block of source.split(/\n---\n/)) {
      const event = auditField(block, "Event");
      const timestamp = auditField(block, "Timestamp");
      if (event !== null && timestamp !== null) {
        events.push({
          event,
          stage: auditField(block, "Stage"),
          timestamp,
          position,
        });
      }
      position += 1;
    }
  }
  return events.sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp) || left.position - right.position
  );
}

/** Require a successful promotion after the current practices Stage attempt/revision. */
export function hasFreshPracticesAffirmation(projectDir: string): boolean {
  const projectRoot = resolve(projectDir);
  const recordDir = activeIntentRecordDir(projectRoot);
  const state = readFileSync(join(recordDir, "aidlc-state.md"), "utf8");
  const recordedTimestamp = stateField(state, "Practices Affirmed Timestamp");
  if (!recordedTimestamp) return false;
  const relevant = activeAuditEvents(recordDir).filter((event) =>
    (event.event === "PRACTICES_AFFIRMED" &&
      (event.stage === null || event.stage === "practices-discovery")) ||
    ((event.event === "STAGE_STARTED" || event.event === "GATE_REJECTED") &&
      event.stage === "practices-discovery")
  );
  const boundary = relevant.findLast((event) =>
    event.event === "STAGE_STARTED" || event.event === "GATE_REJECTED"
  );
  const affirmed = relevant.findLast((event) =>
    event.event === "PRACTICES_AFFIRMED" &&
    (boundary === undefined ||
      event.timestamp > boundary.timestamp ||
      (event.timestamp === boundary.timestamp && event.position > boundary.position))
  );
  return affirmed?.timestamp === recordedTimestamp;
}

const PRACTICES_TEAM_SECTIONS = [
  "Way of Working",
  "Walking Skeleton",
  "Testing Posture",
  "Deployment",
  "Code Style",
] as const;

function markdownSection(source: string, heading: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  const marker = `## ${heading}`;
  const start = normalized.split("\n").findIndex((line) => line.trim() === marker);
  if (start === -1) return "";
  const lines = normalized.split("\n");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function replaceMarkdownSection(
  source: string,
  heading: string,
  body: string,
): string {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const marker = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start === -1) throw new Error(`Target is missing ${marker}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ")) {
      end = index;
      break;
    }
  }
  return [
    ...lines.slice(0, start + 1),
    "",
    body.trim(),
    "",
    ...lines.slice(end).filter((line, index) => index > 0 || line !== ""),
  ].join("\n").replace(/\n+$/, "\n");
}

function appendMarkdownLines(
  source: string,
  heading: string,
  additions: readonly string[],
): { content: string; appended: number } {
  let content = source;
  let appended = 0;
  const existing = new Set(source.split(/\r?\n/).map((line) => line.trim()));
  for (const addition of additions) {
    if (existing.has(addition)) continue;
    const current = markdownSection(content, heading);
    const body = current === "" ? addition : `${current}\n${addition}`;
    content = replaceMarkdownSection(content, heading, body);
    existing.add(addition);
    appended += 1;
  }
  return { content, appended };
}

function practicesDraftPath(
  projectRoot: string,
  recordDir: string,
  input: string,
  expectedName: string,
): string {
  const path = resolve(isAbsolute(input) ? input : join(projectRoot, input));
  const stageDir = resolve(recordDir, "inception", "practices-discovery");
  const rel = relative(stageDir, path);
  if (
    rel !== expectedName || rel.startsWith("..") || isAbsolute(rel)
  ) {
    throw new Error(
      `${expectedName} must be the declared practices-discovery artifact inside the active Intent`,
    );
  }
  return path;
}

/** Promote affirmed practices into active-Space memory and mint its receipt. */
export function promotePractices(
  projectDir: string,
  teamPracticesInput: string,
  discoveredRulesInput: string,
  affirmingUser = "unknown",
): PracticesPromotionResult {
  const projectRoot = resolve(projectDir);
  const recordDir = activeIntentRecordDir(projectRoot);
  const fail = (reason: string): never => {
    try {
      appendAuditEntry(projectRoot, recordDir, "PRACTICES_OVERRIDE", {
        Stage: "practices-discovery",
        Reason: reason,
      });
    } catch {
      // Preserve the promotion failure as the primary error.
    }
    throw new Error(`practices-promote failed: ${reason}`);
  };

  return withWorkspaceLock(projectRoot, () => {
    try {
      const teamDraftPath = practicesDraftPath(
        projectRoot,
        recordDir,
        teamPracticesInput,
        "team-practices.md",
      );
      const rulesDraftPath = practicesDraftPath(
        projectRoot,
        recordDir,
        discoveredRulesInput,
        "discovered-rules.md",
      );
      const stage = graphBySlug().get("practices-discovery");
      if (stage === undefined) throw new Error("practices-discovery is not in the graph");
      for (const agent of stage.support_agents ?? []) {
        const contribution = join(dirname(teamDraftPath), "contributions", `${agent}.md`);
        const firstLine = readFileSync(contribution, "utf8").split(/\r?\n/, 1)[0]?.trim();
        if (firstLine !== `**Collaborator:** ${agent}`) {
          throw new Error(
            `ensemble evidence is incomplete for ${agent}: missing identity marker`,
          );
        }
      }

      const teamDraft = readFileSync(teamDraftPath, "utf8");
      const rulesDraft = readFileSync(rulesDraftPath, "utf8");
      const memoryDir = join(
        workspaceRoot(projectRoot),
        "spaces",
        activeSpace(projectRoot),
        "memory",
      );
      const teamPath = join(memoryDir, "team.md");
      const projectPath = join(memoryDir, "project.md");
      let teamContent = readFileSync(teamPath, "utf8");
      let projectContent = readFileSync(projectPath, "utf8");
      const sectionsWritten: string[] = [];
      for (const heading of PRACTICES_TEAM_SECTIONS) {
        const body = markdownSection(teamDraft, heading);
        if (!body) continue;
        teamContent = replaceMarkdownSection(teamContent, heading, body);
        sectionsWritten.push(heading);
      }

      const today = isoTimestamp().slice(0, 10);
      const rules = (heading: "Mandated" | "Forbidden") =>
        markdownSection(rulesDraft, heading)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("<!--"))
          .map((line) => `${line} (affirmed ${today})`);
      const mandated = appendMarkdownLines(projectContent, "Mandated", rules("Mandated"));
      projectContent = mandated.content;
      const forbidden = appendMarkdownLines(projectContent, "Forbidden", rules("Forbidden"));
      projectContent = forbidden.content;

      // Upstream order is intentional: constrained project rules first, then
      // broader team practices. Exact stamped rows make retries idempotent.
      writeFileAtomic(projectPath, projectContent);
      writeFileAtomic(teamPath, teamContent);

      const affirmedAt = isoTimestamp();
      appendAuditEntry(
        projectRoot,
        recordDir,
        "PRACTICES_AFFIRMED",
        {
          Stage: "practices-discovery",
          "Affirming User": affirmingUser.trim() || "unknown",
          "Sections Written": sectionsWritten.join(", "),
          "Mandated Rules Appended": String(mandated.appended),
          "Forbidden Rules Appended": String(forbidden.appended),
        },
        affirmedAt,
      );
      const statePath = join(recordDir, "aidlc-state.md");
      let state = readFileSync(statePath, "utf8");
      state = setStateField(state, "Practices Affirmed Timestamp", affirmedAt);
      state = setStateField(state, "Last Updated", affirmedAt);
      writeFileAtomic(statePath, state);
      return {
        emitted: "PRACTICES_AFFIRMED",
        affirmedAt,
        teamPath,
        projectPath,
        sectionsWritten,
        mandatedAppended: mandated.appended,
        forbiddenAppended: forbidden.appended,
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
}

export function emitPracticesEvent(
  projectDir: string,
  type: "discovered" | "override" | "empty",
  fields: Readonly<Record<string, string>>,
): void {
  const projectRoot = resolve(projectDir);
  const recordDir = activeIntentRecordDir(projectRoot);
  const event = type === "discovered"
    ? "PRACTICES_DISCOVERED"
    : type === "override"
    ? "PRACTICES_OVERRIDE"
    : "PRACTICES_SECTION_EMPTY";
  appendAuditEntry(projectRoot, recordDir, event, fields);
}

export function resumeIntentState(projectDir: string): ResumePoint {
  const recordDir = activeIntentRecordDir(projectDir);
  const content = readFileSync(join(recordDir, "aidlc-state.md"), "utf8");
  const currentStage = stateField(content, "Current Stage") ?? "unknown";
  return {
    recordDir,
    scope: stateField(content, "Scope") ?? "unknown",
    lifecyclePhase: stateField(content, "Lifecycle Phase") ?? "unknown",
    currentStage,
    nextStage: stateField(content, "Next Stage") ?? "none",
    status: stateField(content, "Status") ?? "unknown",
    activeAgent: stateField(content, "Active Agent") ?? "unknown",
    completed: Number(stateField(content, "Completed") ?? "0"),
    totalStages: Number(stateField(content, "Total Stages") ?? "0"),
    nextAction: stateField(content, "Next Action") ?? "unknown",
    checkboxState:
      currentStage === "none" ? "unknown" : checkboxState(content, currentStage),
    currentUnit:
      currentStage === "none" ? null : currentUnitForStage(content, currentStage),
  };
}

function skipTokenSlug(token: string): string {
  const wrapped = /^\S+ \((.+)\)$/.exec(token)?.[1] ?? token;
  return wrapped.split(" — ")[0] ?? wrapped;
}

/** Promote pending forward Stages into the active Intent's live execution plan. */
export function addStagesToExecutionPlan(
  projectDir: string,
  additions: readonly string[],
): RecomposePlanResult {
  const projectRoot = resolve(projectDir);
  const normalized = additions.map((slug) => slug.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("recompose requires at least one Stage in --add");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("recompose --add contains a duplicate Stage");
  }

  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeIntentRecordDir(projectRoot);
    const statePath = join(recordDir, "aidlc-state.md");
    const planPath = join(recordDir, ".aidlc-plan.json");
    const originalState = readFileSync(statePath, "utf8");
    if (stateField(originalState, "Status") !== "Running") {
      throw new Error("Cannot recompose: workflow Status is not Running");
    }
    if (stateField(originalState, "Construction Autonomy Mode") === "autonomous") {
      throw new Error(
        "Cannot recompose: Construction Autonomy Mode is autonomous; switch to gated execution first",
      );
    }

    const graph = loadCompiledStageGraph();
    const graphBySlug = new Map(graph.map((stage) => [stage.slug, stage]));
    const plan = readPlan(recordDir);
    const planBySlug = new Map(plan.map((stage) => [stage.slug, stage]));
    const currentStage = stateField(originalState, "Current Stage") ?? "";
    const currentIndex = graph.findIndex((stage) => stage.slug === currentStage);
    if (currentIndex === -1) {
      throw new Error(`Cannot recompose: unknown Current Stage "${currentStage || "none"}"`);
    }

    const effectiveAction = (slug: string): "EXECUTE" | "SKIP" => {
      const row = planBySlug.get(slug);
      if (row === undefined) throw new Error(`Execution plan has no Stage "${slug}"`);
      return stageProgressAction(originalState, slug) ?? row.action;
    };
    for (const slug of normalized) {
      const stage = graphBySlug.get(slug);
      if (stage === undefined) throw new Error(`Cannot recompose "${slug}": unknown Stage`);
      if (checkboxState(originalState, slug) !== "pending") {
        throw new Error(
          `Cannot recompose "${slug}": only a pending Stage can be added`,
        );
      }
      const targetIndex = graph.findIndex((entry) => entry.slug === slug);
      if (targetIndex <= currentIndex) {
        throw new Error(
          `Cannot recompose "${slug}": Stage is at or behind Current Stage "${currentStage}"`,
        );
      }
      if (effectiveAction(slug) !== "SKIP") {
        throw new Error(`Cannot recompose "${slug}": Stage already executes`);
      }
    }

    const beforeAnchor = graph.find(
      (stage) => stage.phase === "construction" &&
        effectiveAction(stage.slug) === "EXECUTE",
    )?.slug;
    const additionSet = new Set(normalized);
    const afterAction = (slug: string): "EXECUTE" | "SKIP" =>
      additionSet.has(slug) ? "EXECUTE" : effectiveAction(slug);
    const afterAnchor = graph.find(
      (stage) => stage.phase === "construction" && afterAction(stage.slug) === "EXECUTE",
    )?.slug;
    if (beforeAnchor !== afterAnchor) {
      throw new Error(
        `Cannot recompose: addition moves the Construction walking-skeleton anchor ` +
          `from "${beforeAnchor ?? "none"}" to "${afterAnchor ?? "none"}"`,
      );
    }

    const completed = (slug: string): boolean =>
      checkboxState(originalState, slug) === "completed";
    for (const slug of normalized) {
      const stage = graphBySlug.get(slug)!;
      for (const dependency of stage.requires_stage) {
        if (afterAction(dependency) !== "EXECUTE" && !completed(dependency)) {
          throw new Error(
            `Cannot recompose "${slug}": required Stage "${dependency}" is skipped`,
          );
        }
      }
      const projectType = (stateField(originalState, "Project Type") ?? "").toLowerCase();
      for (const consume of stage.consumes.filter(
        (entry) => entry.required &&
          (entry.conditional_on === undefined || entry.conditional_on === projectType),
      )) {
        const producer = graph.find((entry) =>
          entry.produces.includes(consume.artifact) ||
          entry.optional_produces?.includes(consume.artifact) === true
        );
        if (
          producer !== undefined && afterAction(producer.slug) !== "EXECUTE" &&
          !completed(producer.slug)
        ) {
          throw new Error(
            `Cannot recompose "${slug}": required artifact "${consume.artifact}" ` +
              `is produced by skipped Stage "${producer.slug}"`,
          );
        }
      }
    }

    const proposedPlan = plan.map((stage) =>
      additionSet.has(stage.slug) ? { ...stage, action: "EXECUTE" as const } : stage
    );
    let state = originalState;
    for (const slug of normalized) {
      state = setStageProgressSuffix(state, slug, "EXECUTE");
    }
    const effectivePlan = proposedPlan.map((stage) => ({
      ...stage,
      action: stageProgressAction(state, stage.slug) ?? stage.action,
    }));
    const executable = effectivePlan.filter((stage) => stage.action === "EXECUTE");
    const previousSkipTokens = (stateField(state, "Stages to Skip") ?? "")
      .split(", ")
      .filter((token) => token !== "" && token !== "none");
    const previousSkipBySlug = new Map(
      previousSkipTokens.map((token) => [skipTokenSlug(token), token]),
    );
    const skipped = graph
      .filter((stage) =>
        effectivePlan.find((row) => row.slug === stage.slug)?.action === "SKIP"
      )
      .map((stage) => previousSkipBySlug.get(stage.slug) ?? `${stage.number} (${stage.slug})`);
    const executeNumbers = graph
      .filter((stage) =>
        effectivePlan.find((row) => row.slug === stage.slug)?.action === "EXECUTE"
      )
      .map((stage) => stage.number);
    const next = nextExecutableStage(effectivePlan, state, currentStage);
    state = setStateField(state, "Stages to Execute", executeNumbers.join(", "));
    state = setStateField(state, "Stages to Skip", skipped.length === 0 ? "none" : skipped.join(", "));
    state = setStateField(state, "Total Stages", String(executable.length));
    state = setStateField(state, "Next Stage", next?.slug ?? "none");
    for (const slug of normalized) {
      const stage = graphBySlug.get(slug)!;
      if (stateField(state, phaseLabel(stage.phase)) === "Skipped") {
        state = setPhaseState(state, stage.phase, "Pending");
      }
    }
    state = setStateField(state, "Last Updated", isoTimestamp());

    const completedStages = completedCheckboxCount(state);
    const scope = stateField(state, "Scope") ?? "unknown";
    appendAuditEntry(projectRoot, recordDir, "RECOMPOSED", {
      Scope: scope,
      "Stages added": normalized.join(", "),
      "Stages in Scope": String(executable.length),
    });
    writeFileAtomic(planPath, `${JSON.stringify(proposedPlan, null, 2)}\n`);
    writeFileAtomic(statePath, state);
    return {
      recordDir,
      added: normalized,
      stagesInScope: executable.length,
      completedStages,
      currentStage,
      nextStage: next?.slug ?? null,
    };
  });
}

export function validateIntentState(projectDir: string): void {
  const recordDir = activeIntentRecordDir(projectDir);
  const content = readFileSync(join(recordDir, "aidlc-state.md"), "utf8");
  const version = Number(stateField(content, "State Version"));
  if (version !== STATE_VERSION) {
    throw new Error(`Unsupported State Version: ${String(stateField(content, "State Version"))}`);
  }
  const scope = stateField(content, "Scope");
  if (scope === null) throw new Error("State file has no Scope field");
  const plan = readPlan(recordDir);
  const graph = loadCompiledStageGraph();
  if (plan.length !== graph.length) {
    throw new Error("Execution plan does not cover the compiled stage graph");
  }
  for (const stage of graph) {
    const pattern = new RegExp(
      `^- \\[[ xS?R-]\\] ${escapeRegExp(stage.slug)}(?:\\s|$)`,
      "gm",
    );
    const rows = [...content.matchAll(pattern)].length;
    if (rows !== 1) {
      throw new Error(
        `State file requires exactly one checkbox for "${stage.slug}"; found ${rows}`,
      );
    }
  }
  const current = stateField(content, "Current Stage");
  const status = stateField(content, "Status");
  if (status === "Running" && (current === null || current === "none")) {
    throw new Error("Running state has no Current Stage");
  }
  if (current !== null && current !== "none" && checkboxState(content, current) === "unknown") {
    throw new Error(`Current Stage "${current}" has no checkbox`);
  }
}

function inspectDerivedIntentStateUnlocked(
  projectRoot: string,
): DerivedStateInspection & { path: string; content: string } {
  const recordDir = activeIntentRecordDir(projectRoot);
  const path = join(recordDir, "aidlc-state.md");
  const content = readFileSync(path, "utf8");
  const plan = readPlan(recordDir);
  const graph = graphBySlug();
  const effectivePlan = plan.map((stage) => ({
    ...stage,
    action: stageProgressAction(content, stage.slug) ?? stage.action,
  }));
  const executable = effectivePlan.filter((stage) => stage.action === "EXECUTE");
  const active = executable.filter((stage) =>
    ["in-progress", "awaiting-approval", "revising"].includes(
      checkboxState(content, stage.slug),
    )
  );
  const unfinished = executable.filter((stage) =>
    !["completed", "skipped"].includes(checkboxState(content, stage.slug))
  );
  if (active.length > 1) {
    throw new Error(
      `State has multiple active Stage markers: ${active.map((stage) => stage.slug).join(", ")}`,
    );
  }
  if (active.length === 0 && unfinished.length > 0) {
    throw new Error("State has unfinished Stages but no authoritative active marker");
  }

  const current = active[0] ?? null;
  const currentEntry = current === null ? null : graph.get(current.slug);
  if (current !== null && currentEntry === undefined) {
    throw new Error(`Unknown active Stage: ${current.slug}`);
  }
  const next = current === null
    ? null
    : nextExecutableStage(effectivePlan, content, current.slug);
  const desiredFields: Record<string, string> = {
    "Total Stages": String(executable.length),
    Completed: String(completedCheckboxCount(content)),
    "In Progress": current?.slug ?? "none",
    "Active Agent": currentEntry?.lead_agent ?? "",
    "Lifecycle Phase": currentEntry?.phase.toUpperCase() ?? "READY",
    "Current Stage": current?.slug ?? "none",
    "Next Stage": next?.slug ?? "none",
    Status: current === null ? "Completed" : "Running",
    "Next Action": current === null ? "Workflow complete" : `Execute ${current.slug}`,
  };
  return {
    recordDir,
    path,
    content,
    desiredFields,
    driftedFields: Object.entries(desiredFields)
      .filter(([field, value]) => stateField(content, field) !== value)
      .map(([field]) => field),
    currentStage: current?.slug ?? null,
    workflowCompleted: current === null,
  };
}

/** Inspect State fields that are fully derived from plan and checkbox data. */
export function inspectDerivedIntentState(
  projectDir: string,
): DerivedStateInspection {
  const { path: _path, content: _content, ...inspection } =
    inspectDerivedIntentStateUnlocked(resolve(projectDir));
  return inspection;
}

/** Recompute only derived State fields; progress markers remain authoritative. */
export function repairDerivedIntentState(
  projectDir: string,
): DerivedStateRepair {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const inspection = inspectDerivedIntentStateUnlocked(projectRoot);
    let content = inspection.content;
    for (const field of inspection.driftedFields) {
      content = setStateField(content, field, inspection.desiredFields[field] ?? "");
    }
    if (inspection.driftedFields.length > 0) {
      content = setStateField(content, "Last Updated", isoTimestamp());
      writeFileAtomic(inspection.path, content);
    }
    return {
      recordDir: inspection.recordDir,
      changedFields: inspection.driftedFields,
      currentStage: inspection.currentStage,
      workflowCompleted: inspection.workflowCompleted,
    };
  });
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function runCli(): void {
  const [command, projectDirArgument, slug, ...args] = process.argv.slice(2);
  const practicesCommand =
    command === "practices-event" || command === "practices-promote";
  const constructionIterationCommand = command === "set-construction-iteration";
  const rawCommandArgs = process.argv.slice(3);
  const projectDir = practicesCommand || constructionIterationCommand
    ? flagValue(rawCommandArgs, "--project-dir") ?? process.cwd()
    : projectDirArgument;
  const usage =
    "Usage: aidlc-state init <project-dir> --scope <scope> [--description <text>] [--force]\n" +
    "       aidlc-state show <project-dir>\n" +
    "       aidlc-state advance <project-dir> <current-stage>\n" +
    "       aidlc-state skip <project-dir> <current-stage> --reason <text>\n" +
    "       aidlc-state resume <project-dir>\n" +
    "       aidlc-state check <project-dir>\n" +
    "       aidlc-state practices-event --type <discovered|override|empty> " +
    "[--field \"Key: Value\"] [--project-dir <dir>]\n" +
    "       aidlc-state practices-promote --team-practices <path> " +
    "--discovered-rules <path> [--affirming-user <name>] [--project-dir <dir>]\n" +
    "       aidlc-state set-construction-iteration <unit-major|stage-major> " +
    "[--project-dir <dir>]";
  if (!cliHasCommand(STATE_CLI_CONTRACT, command) || projectDir === undefined) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  try {
    const commandArgs = practicesCommand || constructionIterationCommand
      ? rawCommandArgs
      : [slug, ...args].filter((item): item is string => item !== undefined);
    const unknownFlags = cliUnknownFlags(
      STATE_CLI_CONTRACT,
      command,
      commandArgs,
    );
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown flag(s) for ${command}: ${unknownFlags.join(", ")}`);
    }
    if (command === "practices-event") {
      const type = flagValue(commandArgs, "--type");
      if (type !== "discovered" && type !== "override" && type !== "empty") {
        throw new Error("--type must be discovered, override, or empty");
      }
      const fields: Record<string, string> = {};
      for (let index = 0; index < commandArgs.length; index += 1) {
        if (commandArgs[index] !== "--field") continue;
        const value = commandArgs[index + 1] ?? "";
        const separator = value.indexOf(":");
        if (separator <= 0) {
          throw new Error(`--field must use \"Key: Value\": ${value}`);
        }
        fields[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
        index += 1;
      }
      emitPracticesEvent(projectDir, type, fields);
      console.log(JSON.stringify({
        emitted: type === "discovered"
          ? "PRACTICES_DISCOVERED"
          : type === "override"
          ? "PRACTICES_OVERRIDE"
          : "PRACTICES_SECTION_EMPTY",
        fields_count: Object.keys(fields).length,
      }));
      return;
    }
    if (command === "practices-promote") {
      const teamPractices = flagValue(commandArgs, "--team-practices");
      const discoveredRules = flagValue(commandArgs, "--discovered-rules");
      if (teamPractices === undefined || discoveredRules === undefined) {
        throw new Error("--team-practices and --discovered-rules are required");
      }
      console.log(JSON.stringify(promotePractices(
        projectDir,
        teamPractices,
        discoveredRules,
        flagValue(commandArgs, "--affirming-user") ?? "unknown",
      )));
      return;
    }
    if (command === "set-construction-iteration") {
      const value = commandArgs[0];
      if (value !== "unit-major" && value !== "stage-major") {
        throw new Error(
          `Invalid construction iteration "${value ?? ""}". ` +
            "Valid values: unit-major, stage-major",
        );
      }
      const update = setConstructionIteration(projectDir, value);
      process.stdout.write(
        `${JSON.stringify({
          updated: true,
          construction_iteration: update.constructionIteration,
        })}\n`,
      );
      return;
    }
    if (command === "init") {
      const scope = flagValue([slug, ...args].filter((item): item is string => item !== undefined), "--scope");
      if (scope === undefined) throw new Error("--scope is required");
      const initArgs = [slug, ...args].filter((item): item is string => item !== undefined);
      const description = flagValue(initArgs, "--description");
      const result = initializeActiveIntentState(projectDir, {
        scope,
        ...(description === undefined ? {} : { projectDescription: description }),
        force: initArgs.includes("--force"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (command === "show") {
      process.stdout.write(readFileSync(stateFilePath(projectDir), "utf8"));
      return;
    }
    if (command === "resume") {
      process.stdout.write(`${JSON.stringify(resumeIntentState(projectDir), null, 2)}\n`);
      return;
    }
    if (command === "check") {
      validateIntentState(projectDir);
      console.log(`State is valid: ${stateFilePath(projectDir)}`);
      return;
    }
    if (slug === undefined) throw new Error("current stage slug is required");
    if (command === "advance") {
      process.stdout.write(`${JSON.stringify(completeCurrentStage(projectDir, slug), null, 2)}\n`);
      return;
    }
    if (command === "skip") {
      const reason = flagValue(args, "--reason");
      if (reason === undefined) throw new Error("--reason is required");
      process.stdout.write(`${JSON.stringify(skipCurrentStage(projectDir, slug, reason), null, 2)}\n`);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
