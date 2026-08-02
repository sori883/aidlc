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
import { appendAuditEntry } from "./aidlc-audit.ts";

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
}

export interface StateTransition {
  recordDir: string;
  stage: string;
  stageState: "completed" | "skipped";
  nextStage: string | null;
  workflowCompleted: boolean;
  completedStages: number;
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
    `^- \\*\\*${escapeRegExp(field)}\\*\\*:\\s*(.*)$`,
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

function checkboxState(content: string, slug: string): StateCheckbox | "unknown" {
  const pattern = new RegExp(
    `^- \\[([ xS?R-])\\] ${escapeRegExp(slug)}(?:\\s|$)`,
    "m",
  );
  const marker = pattern.exec(content)?.[1];
  return marker === undefined ? "unknown" : STATE_BY_MARKER[marker] ?? "unknown";
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
    const unitHint = phase === "construction" ? ["Per unit: [TBD]"] : [];
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

function transitionCurrentStage(
  projectDir: string,
  slug: string,
  result: "completed" | "skipped",
  reason?: string,
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

    const plan = readPlan(recordDir);
    const graph = graphBySlug();
    const currentEntry = graph.get(slug);
    if (currentEntry === undefined) throw new Error(`Unknown stage: "${slug}"`);
    const scope = stateField(content, "Scope");
    if (scope === null || scope.length === 0) {
      throw new Error("State file has no Scope field");
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
    }
    const completedStages = completedCheckboxCount(content);
    content = setStateField(content, "Completed", String(completedStages));
    content = setStateField(content, "Last Updated", timestamp);

    // Audit-first transition: the Workspace lock already held by this function
    // serializes the audit append and State write as one mutation path. If an
    // audit append throws, the State write below is not attempted.
    if (result === "completed") {
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
  };
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
  if (plan.length !== loadCompiledStageGraph().length) {
    throw new Error("Execution plan does not cover the compiled stage graph");
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

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function runCli(): void {
  const [command, projectDir, slug, ...args] = process.argv.slice(2);
  const usage =
    "Usage: aidlc-state init <project-dir> --scope <scope> [--description <text>] [--force]\n" +
    "       aidlc-state show <project-dir>\n" +
    "       aidlc-state advance <project-dir> <current-stage>\n" +
    "       aidlc-state skip <project-dir> <current-stage> --reason <text>\n" +
    "       aidlc-state resume <project-dir>\n" +
    "       aidlc-state check <project-dir>";
  if (command === undefined || projectDir === undefined) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  try {
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
