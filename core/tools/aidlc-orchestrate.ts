// Deterministic orchestration engine. `next` never edits State or Audit and
// emits exactly one typed Directive. M10 may lazily create gitignored local
// steering-token state before it releases run-stage. `report` remains the only
// workflow mutation route and delegates transitions to aidlc-state.ts.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";
import {
  type CompiledStage,
  loadCompiledStageGraph,
  type ResolvedPlanStage,
} from "./aidlc-graph.ts";
import {
  type Directive,
  type DoneDirective,
  type ErrorDirective,
  type RunStageDirective,
  validateDirective,
} from "./aidlc-directive.ts";
import {
  type ArtifactResolutionOptions,
  resolveStageArtifacts,
  verifyStageArtifactEvidence,
} from "./aidlc-artifacts.ts";
import {
  activeIntentRecordDir,
  approveCurrentStage,
  completeAllCurrentStageUnits,
  completeCurrentUnitStage,
  completeCurrentStage,
  hasFreshPracticesAffirmation,
  hydrateConstructionUnitProgress,
  openApprovalGate,
  planFilePath,
  rejectApprovalGate,
  resumeIntentState,
  reviseApprovalGate,
  skipCurrentStage,
  stateFilePath,
  validateIntentState,
} from "./aidlc-state.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import { loadActiveUnitDag, type UnitDag } from "./aidlc-unit-graph.ts";
import { resolveSteeringDirective } from "./aidlc-steering.ts";
import { assertLearningGateCompleted } from "./aidlc-learnings.ts";
import { appendAuditEntries } from "./aidlc-audit.ts";
import {
  BOLT_STAGE_SLUGS,
  type BoltStageSlug,
  completeBolt,
  completeBoltStageUnit,
  currentBoltStage,
  loadBoltExecution,
  skipBoltStage,
} from "./aidlc-bolt.ts";
import { checkQualityGates } from "./aidlc-quality-gate.ts";
import {
  cliAcceptsResult,
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";

const ORCHESTRATE_CLI_CONTRACT = loadCliContract("aidlc-orchestrate.ts");

export type ReportResult =
  | "approved"
  | "awaiting-approval"
  | "completed"
  | "complete"
  | "done"
  | "rejected"
  | "revised"
  | "skipped";

export interface ReportOptions {
  stage: string;
  result: ReportResult;
  reason?: string;
  userInput?: string;
  unit?: string;
}

export interface ResolveNextOptions extends ArtifactResolutionOptions {
  continueToken?: string;
  stage?: string;
  single?: boolean;
}

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = runtimeCoreDir();
const FORWARD_RESULTS = new Set<ReportResult>([
  "approved",
  "completed",
  "complete",
  "done",
]);
const GATE_RESULTS = new Set<ReportResult>([
  "awaiting-approval",
  "rejected",
  "revised",
]);
const BOLT_STAGE_SET = new Set<string>(BOLT_STAGE_SLUGS);

function errorDirective(message: string): ErrorDirective {
  return { kind: "error", message };
}

function hasBoltState(content: string): boolean {
  return /<!-- AIDLC_BOLT_STATE_START -->[\s\S]*?```json\s*\n/.test(content);
}

function hasBoltPlan(projectDir: string): boolean {
  const path = join(
    activeIntentRecordDir(projectDir),
    "inception",
    "delivery-planning",
    "bolt-plan.md",
  );
  return existsSync(path) && /```ya?ml[\s\S]*?\bbolt_plan\s*:/i.test(
    readFileSync(path, "utf8"),
  );
}

function resolveBoltDirective(
  projectDir: string,
  graph: readonly CompiledStage[],
  plan: readonly ResolvedPlanStage[],
  stateContent: string,
  options: ResolveNextOptions,
): Directive | null {
  if (!hasBoltState(stateContent)) {
    return hasBoltPlan(projectDir)
      ? {
          kind: "print",
          message: "BOLT_ACTION initialize; after initialization run next again.",
        }
      : null;
  }
  const loaded = loadBoltExecution(projectDir);
  if (loaded.next.status === "ready") {
    return {
      kind: "print",
      message: `BOLT_ACTION start ${loaded.next.readyBoltIds.join(",")}; then run next again.`,
    };
  }
  if (loaded.next.status === "ready-to-complete") {
    const id = loaded.next.activeBoltIds[0] ?? "unknown";
    const run = loaded.state.bolts.find((bolt) => bolt.id === id);
    const definition = loaded.plan.bolts.find((bolt) => bolt.id === id);
    if (run?.worktreeStatus === "active" || run?.worktreeStatus === "preserved") {
      return {
        kind: "print",
        message:
          `BOLT_ACTION integrate ${id} ${definition?.slug ?? "unknown"}; ` +
          "verify the Worktree merge, record its commit ref, then run next again.",
      };
    }
    return {
      kind: "print",
      message: `BOLT_ACTION complete ${id}; then run next again.`,
    };
  }
  if (loaded.next.status === "awaiting-gate") {
    const id = loaded.next.activeBoltIds[0] ?? "unknown";
    return {
      kind: "present-gate",
      stage: `bolt:${id}`,
      phase: "construction",
      memory_path: workspacePath(
        projectDir,
        join(loaded.recordDir, "construction", "bolts", id, "memory.md"),
      ),
    };
  }
  if (loaded.next.status === "awaiting-autonomy") {
    return {
      kind: "ask",
      question:
        "Choose Construction autonomy after the B1 gate: " +
        "autonomous (continue later Bolts without a Bolt gate) or " +
        "gated (require a gate for every later Bolt).",
    };
  }
  if (loaded.next.status === "failed-awaiting-choice") {
    const id = loaded.next.activeBoltIds.find((candidate) =>
      loaded.state.bolts.find((bolt) => bolt.id === candidate)?.status === "failed"
    ) ?? "unknown";
    return {
      kind: "ask",
      question:
        `Bolt ${id} failed. Choose retry, skip, or abort; ` +
        "skip and abort require an explicit reason.",
    };
  }
  if (loaded.next.status === "aborted") {
    return {
      kind: "parked",
      reason: loaded.next.nextAction,
      stage: "construction",
    };
  }
  if (loaded.next.status === "blocked") {
    return errorDirective(loaded.next.nextAction);
  }
  if (loaded.next.status === "all-complete") {
    return {
      kind: "print",
      message: "All Bolts are complete; continue with aggregate Build and Test.",
    };
  }

  const cursor = currentBoltStage(projectDir);
  if (cursor === null) {
    const id = loaded.next.activeBoltIds[0] ?? "unknown";
    return {
      kind: "print",
      message: `BOLT_ACTION complete ${id}; all per-Bolt Stages are settled.`,
    };
  }
  if (options.unit !== undefined && options.unit !== cursor.unit) {
    return errorDirective(
      `Cannot run Unit "${options.unit}" out of Bolt order; next Unit is ` +
        `"${cursor.unit}" in ${cursor.boltId}/${cursor.stage}.`,
    );
  }
  const stage = graph.find((candidate) => candidate.slug === cursor.stage);
  if (stage === undefined) {
    return errorDirective(`Bolt Stage "${cursor.stage}" is not in the compiled graph.`);
  }
  const definition = loadActiveUnitDag(projectDir)?.units.find(
    (candidate) => candidate.name === cursor.unit,
  );
  const directive = buildRunStageDirective(
    projectDir,
    stage,
    graph,
    plan,
    stateContent,
    {
      ...options,
      unit: cursor.unit,
      ...(definition?.kind === undefined ? {} : { unitKind: definition.kind }),
    },
  );
  directive.gate = false;
  const run = loaded.state.bolts.find((bolt) => bolt.id === cursor.boltId)!;
  const currentIndex = run.stages.findIndex((progress) => progress.slug === cursor.stage);
  directive.next_stage = run.stages
    .slice(currentIndex)
    .find((progress) => progress.status === "pending" && progress.slug !== cursor.stage)
    ?.slug ?? null;
  return directive;
}

function emit(directive: Directive): void {
  const validation = validateDirective(directive);
  if (!validation.valid) {
    throw new Error(
      `Internal directive validation failed: ${validation.errors.join("; ")}`,
    );
  }
  console.log(JSON.stringify(validation.data, null, 2));
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function workspacePath(projectDir: string, absolutePath: string): string {
  return portablePath(relative(resolve(projectDir), absolutePath));
}

function readPlan(projectDir: string): ResolvedPlanStage[] {
  const path = planFilePath(projectDir);
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
      typeof row !== "object" || row === null ||
      typeof (row as Record<string, unknown>).slug !== "string" ||
      typeof (row as Record<string, unknown>).phase !== "string" ||
      !["EXECUTE", "SKIP"].includes(
        String((row as Record<string, unknown>).action),
      )
    ) throw new Error(`Invalid execution plan at ${path}: bad row ${index}`);
    return row as ResolvedPlanStage;
  });
}

function stateField(content: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^- \\*\\*${escaped}\\*\\*:[ \\t]*(.*)$`, "m")
    .exec(content)?.[1]?.trim() ?? null;
}

function stateStageAction(
  content: string,
  slug: string,
): "EXECUTE" | "SKIP" | null {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const action = new RegExp(
    `^- \\[[ xS?R-]\\] ${escaped} — (EXECUTE|SKIP)(?::|$)`,
    "m",
  ).exec(content)?.[1];
  return action === "EXECUTE" || action === "SKIP" ? action : null;
}

function stateStageSettled(content: string, slug: string): boolean {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^- \\[xS\\] ${escaped}(?:\\s|$)`, "m").test(content);
}

function usesUnitMajorIteration(content: string): boolean {
  return stateField(content, "Construction Iteration") === "unit-major";
}

function constructionDesignBlock(
  graph: readonly CompiledStage[],
  plan: readonly ResolvedPlanStage[],
  stateContent: string,
): CompiledStage[] {
  const planBySlug = new Map(plan.map((stage) => [stage.slug, stage.action]));
  return graph.filter((stage) =>
    stage.phase === "construction" &&
    stage.for_each === "unit-of-work" &&
    stage.mode === "inline" &&
    !stateStageSettled(stateContent, stage.slug) &&
    (stateStageAction(stateContent, stage.slug) ?? planBySlug.get(stage.slug)) ===
      "EXECUTE"
  );
}

function unitArtifactEvidence(
  projectDir: string,
  stage: CompiledStage,
  dag: UnitDag,
): { valid: boolean; missing: string[] } {
  const missing = dag.batches.flatMap((batch) =>
    batch.flatMap((unit) => {
      const definition = dag.units.find((candidate) => candidate.name === unit);
      return verifyStageArtifactEvidence(projectDir, stage, {
        unit,
        ...(definition?.kind === undefined ? {} : { unitKind: definition.kind }),
      }).missing;
    })
  );
  return { valid: missing.length === 0, missing };
}

function unitMajorGridEvidence(
  projectDir: string,
  block: readonly CompiledStage[],
  dag: UnitDag,
): { valid: boolean; missing: string[] } {
  const missing = block.flatMap((stage) =>
    unitArtifactEvidence(projectDir, stage, dag).missing
  );
  return { valid: missing.length === 0, missing };
}

function assertEveryUnitLearningGate(
  projectDir: string,
  stage: string,
  dag: UnitDag,
): void {
  for (const unit of dag.batches.flat()) {
    assertLearningGateCompleted(projectDir, stage, unit);
  }
}

function markdownFilesUnder(directory: string): string[] {
  try {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...markdownFilesUnder(path));
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

function inlineContextPaths(
  projectDir: string,
  stage: CompiledStage,
): string[] {
  const names = stage.mode === "inline"
    ? [stage.lead_agent, ...(stage.support_agents ?? [])]
    : stage.mode === "mob" ? [stage.lead_agent] : [];
  const agents = [...new Set(names)].filter((name) => name !== "orchestrator");
  if (agents.length === 0) return [];
  const spaceKnowledge = join(
    workspaceRoot(projectDir),
    "spaces",
    activeSpace(projectDir),
    "knowledge",
  );
  const paths = agents.map((name) =>
    join(CORE_DIR, "agents", `${name}.md`)
  );
  paths.push(...markdownFilesUnder(join(CORE_DIR, "knowledge", "aidlc-shared")));
  for (const agent of agents) {
    paths.push(...markdownFilesUnder(join(CORE_DIR, "knowledge", agent)));
  }
  paths.push(...markdownFilesUnder(join(spaceKnowledge, "aidlc-shared")));
  for (const agent of agents) {
    paths.push(...markdownFilesUnder(join(spaceKnowledge, agent)));
  }
  return [...new Set(paths)];
}

function buildRunStageDirective(
  projectDir: string,
  stage: CompiledStage,
  graph: readonly CompiledStage[],
  plan: readonly ResolvedPlanStage[],
  stateContent: string,
  options: ResolveNextOptions,
): RunStageDirective {
  const recordDir = activeIntentRecordDir(projectDir);
  const recordPrefix = workspacePath(projectDir, recordDir);
  const projectType = stateField(stateContent, "Project Type") ?? "Unknown";
  const artifacts = resolveStageArtifacts(
    projectDir,
    stage,
    graph,
    plan,
    stateContent,
    projectType,
    options,
  );

  const resume = resumeIntentState(projectDir);
  let next: string | null = null;
  if (options.single !== true && resume.nextStage !== "none") {
    const nextNode = graph.find((candidate) => candidate.slug === resume.nextStage);
    if (nextNode === undefined) {
      throw new Error(
        `Next Stage "${resume.nextStage}" is not in the compiled graph.`,
      );
    }
    next = nextNode.name;
  }
  const space = activeSpace(projectDir);
  const directive: RunStageDirective = {
    kind: "run-stage",
    stage: stage.slug,
    phase: stage.phase,
    lead_agent: stage.lead_agent,
    support_agents: stage.support_agents ?? [],
    mode: stage.mode,
    inline_context_paths: inlineContextPaths(projectDir, stage),
    gate: options.single === true ? false : stage.phase !== "initialization",
    memory_path: portablePath(
      stage.for_each === "unit-of-work" && !options.singlePass
        ? join(
            recordPrefix,
            stage.phase,
            options.unit ?? "{unit-name}",
            stage.slug,
            "memory.md",
          )
        : join(recordPrefix, stage.phase, stage.slug, "memory.md"),
    ),
    consumes: artifacts.consumes,
    produces: artifacts.produces,
    rules_in_context: (stage.rules_in_context ?? []).map((rule) =>
      rule.path.replace(
        /^aidlc\/spaces\/default\//,
        `aidlc/spaces/${space}/`,
      )
    ),
    sensors_applicable: (stage.sensors_applicable ?? []).map((sensor) => sensor.id),
    stage_file: join(
      CORE_DIR,
      "aidlc-common",
      "stages",
      stage.phase,
      `${stage.slug}.md`,
    ),
    next_stage: next,
    ...(options.single === true ? { single: true } : {}),
    ...(options.unit === undefined ? {} : { unit: options.unit }),
  };
  if (artifacts.consumesAbsent.length > 0) {
    directive.consumes_absent = artifacts.consumesAbsent;
  }
  if (stage.reviewer !== undefined) {
    directive.reviewer = stage.reviewer;
    directive.reviewer_max_iterations = stage.reviewer_max_iterations ?? 2;
  }
  return directive;
}

function resolveUnitMajorDirective(
  projectDir: string,
  currentStage: CompiledStage,
  graph: readonly CompiledStage[],
  plan: readonly ResolvedPlanStage[],
  stateContent: string,
  dag: UnitDag,
  options: ResolveNextOptions,
): RunStageDirective | ErrorDirective | null {
  if (
    !usesUnitMajorIteration(stateContent) ||
    currentStage.phase !== "construction" ||
    currentStage.for_each !== "unit-of-work" ||
    currentStage.mode !== "inline"
  ) return null;

  const block = constructionDesignBlock(graph, plan, stateContent);
  if (!block.some((stage) => stage.slug === currentStage.slug)) return null;
  const units = dag.batches.flat();
  if (units.length === 0) return null;

  for (const unit of units) {
    const definition = dag.units.find((candidate) => candidate.name === unit);
    if (definition === undefined) {
      return errorDirective(`Unit "${unit}" is not in the active Unit DAG.`);
    }
    for (const stage of block) {
      const evidence = verifyStageArtifactEvidence(projectDir, stage, {
        unit,
        ...(definition.kind === undefined ? {} : { unitKind: definition.kind }),
      });
      if (evidence.valid) continue;
      if (options.unit !== undefined && options.unit !== unit) {
        return errorDirective(
          `Cannot run Unit "${options.unit}" out of order; next Unit is "${unit}".`,
        );
      }
      const directive = buildRunStageDirective(
        projectDir,
        stage,
        graph,
        plan,
        stateContent,
        {
          ...options,
          unit,
          ...(definition.kind === undefined ? {} : { unitKind: definition.kind }),
        },
      );
      directive.gate = false;
      return directive;
    }
  }

  const lastUnit = units.at(-1)!;
  if (options.unit !== undefined && options.unit !== lastUnit) {
    return errorDirective(
      `The unit-major design grid is complete; the approval gate is on Unit "${lastUnit}".`,
    );
  }
  const definition = dag.units.find((candidate) => candidate.name === lastUnit);
  if (definition === undefined) {
    return errorDirective(`Unit "${lastUnit}" is not in the active Unit DAG.`);
  }
  return buildRunStageDirective(
    projectDir,
    currentStage,
    graph,
    plan,
    stateContent,
    {
      ...options,
      unit: lastUnit,
      ...(definition.kind === undefined ? {} : { unitKind: definition.kind }),
    },
  );
}

const SINGLE_INIT_ERROR =
  "Cannot run an initialization stage with --single. Initialization is bootstrap; use the aidlc-init Skill.";

/** Resolve one runnable Stage without routing from or moving the main State pointer. */
export function resolveSingleStageDirective(
  projectDir: string,
  stageSlug: string,
  options: Omit<ResolveNextOptions, "stage" | "single"> = {},
): Directive {
  const projectRoot = resolve(projectDir);
  try {
    validateIntentState(projectRoot);
    const resume = resumeIntentState(projectRoot);
    const graph = loadCompiledStageGraph();
    const stage = graph.find((candidate) => candidate.slug === stageSlug);
    if (stage === undefined) {
      return errorDirective(`Unknown stage "${stageSlug}".`);
    }
    if (stage.phase === "initialization") return errorDirective(SINGLE_INIT_ERROR);
    const plan = readPlan(projectRoot);
    if (plan.find((row) => row.slug === stage.slug)?.action !== "EXECUTE") {
      return errorDirective(
        `Stage "${stage.slug}" is skipped for scope "${resume.scope}". ` +
          "Choose a different stage or change scope.",
      );
    }
    const stateContent = readFileSync(stateFilePath(projectRoot), "utf8");
    const directive = buildRunStageDirective(
      projectRoot,
      stage,
      graph,
      plan,
      stateContent,
      {
        ...options,
        singlePass: true,
        single: true,
        stage: stageSlug,
      },
    );
    return resolveSteeringDirective(projectRoot, directive, {
      ...(options.continueToken === undefined
        ? {}
        : { continueToken: options.continueToken }),
    });
  } catch (error) {
    return errorDirective(error instanceof Error ? error.message : String(error));
  }
}

/** Resolve one upstream-compatible next action without changing State or Audit. */
export function resolveNextDirective(
  projectDir: string,
  options: ResolveNextOptions = {},
): Directive {
  const projectRoot = resolve(projectDir);
  if (options.single === true) {
    if (options.stage === undefined || options.stage.trim() === "") {
      return errorDirective(
        "--single requires --stage <slug>. A Stage runner executes exactly one named Stage.",
      );
    }
    return resolveSingleStageDirective(projectRoot, options.stage, options);
  }
  if (options.stage !== undefined) {
    return errorDirective("--stage requires --single in the current M11 runner contract.");
  }
  try {
    validateIntentState(projectRoot);
    const resume = resumeIntentState(projectRoot);
    if (resume.status === "Completed" || resume.currentStage === "none") {
      return {
        kind: "done",
        reason: `Workflow completed (scope: ${resume.scope}).`,
      };
    }
    if (resume.status !== "Running") {
      return errorDirective(
        `Workflow status is "${resume.status}"; expected Running or Completed.`,
      );
    }
    const earlyStateContent = readFileSync(stateFilePath(projectRoot), "utf8");
    const atBoltBoundary = BOLT_STAGE_SET.has(resume.currentStage) &&
      hasBoltState(earlyStateContent);
    if (!atBoltBoundary && ![
      "pending",
      "in-progress",
      "awaiting-approval",
      "revising",
    ].includes(resume.checkboxState)) {
      return errorDirective(
        `Current Stage "${resume.currentStage}" is ${resume.checkboxState}; it is not runnable.`,
      );
    }

    const graph = loadCompiledStageGraph();
    const stage = graph.find((candidate) => candidate.slug === resume.currentStage);
    if (stage === undefined) {
      return errorDirective(
        `Current Stage "${resume.currentStage}" is not in the compiled graph.`,
      );
    }
    const stateContent = earlyStateContent;
    const dag = loadActiveUnitDag(projectRoot);
    const plan = readPlan(projectRoot);
    if (BOLT_STAGE_SET.has(stage.slug)) {
      const boltDirective = resolveBoltDirective(
        projectRoot,
        graph,
        plan,
        stateContent,
        options,
      );
      if (boltDirective !== null) {
        if (boltDirective.kind === "run-stage") {
          return resolveSteeringDirective(projectRoot, boltDirective, {
            ...(options.continueToken === undefined
              ? {}
              : { continueToken: options.continueToken }),
          });
        }
        return boltDirective;
      }
    }
    if (dag !== null) {
      const unitMajor = resolveUnitMajorDirective(
        projectRoot,
        stage,
        graph,
        plan,
        stateContent,
        dag,
        options,
      );
      if (unitMajor !== null) {
        if (unitMajor.kind === "error") return unitMajor;
        return resolveSteeringDirective(projectRoot, unitMajor, {
          ...(options.continueToken === undefined
            ? {}
            : { continueToken: options.continueToken }),
        });
      }
    }
    const artifactOptions: ArtifactResolutionOptions = {
      ...(options.unit === undefined ? {} : { unit: options.unit }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.unitKind === undefined ? {} : { unitKind: options.unitKind }),
      ...(options.singlePass === undefined
        ? {}
        : { singlePass: options.singlePass }),
    };
    if (dag === null) {
      artifactOptions.singlePass = true;
    } else if (stage.for_each === "unit-of-work") {
      const unit = options.unit ?? resume.currentUnit;
      if (unit === null || unit === undefined) {
        return errorDirective(
          `Per-Unit stage "${stage.slug}" has no pending Unit in State.`,
        );
      }
      if (options.unit !== undefined && options.unit !== resume.currentUnit) {
        return errorDirective(
          `Cannot run Unit "${options.unit}" out of order; next Unit is ` +
            `"${resume.currentUnit ?? "none"}".`,
        );
      }
      const definition = dag.units.find((candidate) => candidate.name === unit);
      if (definition === undefined) {
        return errorDirective(`Unit "${unit}" is not in the active Unit DAG.`);
      }
      artifactOptions.unit = unit;
      if (definition.kind !== undefined) artifactOptions.unitKind = definition.kind;
    }
    const directive = buildRunStageDirective(
      projectRoot,
      stage,
      graph,
      plan,
      stateContent,
      artifactOptions,
    );
    return resolveSteeringDirective(projectRoot, directive, {
      ...(options.continueToken === undefined
        ? {}
        : { continueToken: options.continueToken }),
    });
  } catch (error) {
    return errorDirective(error instanceof Error ? error.message : String(error));
  }
}

/** Record an isolated Stage lifecycle without writing the main State file. */
export function reportSingleStageResult(
  projectDir: string,
  stageSlug: string,
  result: ReportResult,
): DoneDirective | ErrorDirective {
  const projectRoot = resolve(projectDir);
  try {
    if (!FORWARD_RESULTS.has(result)) {
      return errorDirective(
        `Unknown single-stage report result: "${result}".`,
      );
    }
    const stage = loadCompiledStageGraph().find((candidate) =>
      candidate.slug === stageSlug
    );
    if (stage === undefined) return errorDirective(`Unknown stage "${stageSlug}".`);
    if (stage.phase === "initialization") return errorDirective(SINGLE_INIT_ERROR);
    const recordDir = activeIntentRecordDir(projectRoot);
    const workflow = `single-stage:${stage.slug}`;
    appendAuditEntries(projectRoot, recordDir, [
      {
        event: "STAGE_STARTED",
        fields: {
          Stage: stage.slug,
          Agent: stage.lead_agent,
          Workflow: workflow,
        },
      },
      {
        event: "STAGE_COMPLETED",
        fields: {
          Stage: stage.slug,
          Details: `Single-stage run of ${stage.slug} completed`,
          Workflow: workflow,
        },
      },
    ]);
    return {
      kind: "done",
      reason:
        `Single-stage run of "${stage.slug}" was recorded under "${workflow}". ` +
        "The main workflow Current Stage is unchanged.",
    };
  } catch (error) {
    return errorDirective(error instanceof Error ? error.message : String(error));
  }
}

function reportBoltStageResult(
  projectRoot: string,
  node: CompiledStage,
  options: ReportOptions,
): DoneDirective | ErrorDirective {
  const loaded = loadBoltExecution(projectRoot);
  const cursor = currentBoltStage(projectRoot);
  const id = cursor?.boltId ?? loaded.next.activeBoltIds[0];
  if (id === undefined) {
    return errorDirective("No active Bolt can accept a Stage report.");
  }
  if (options.result === "skipped") {
    const reason = options.reason?.trim();
    if (!reason) {
      return errorDirective("Bolt Stage skip requires a nonblank --reason <text>.");
    }
    const transition = skipBoltStage(
      projectRoot,
      id,
      node.slug as BoltStageSlug,
      reason,
    );
    if (transition.allStagesCompleted) completeBolt(projectRoot, id);
    return {
      kind: "done",
      reason: `Skipped ${id}/${node.slug}; run next to continue the Bolt.`,
    };
  }
  if (!["completed", "complete", "done"].includes(options.result)) {
    return errorDirective(
      `Per-Bolt Stage "${node.slug}" has no Stage-level approval gate. ` +
        "Report completed after its outputs are ready; approval occurs at the Bolt gate.",
    );
  }
  const unit = options.unit?.trim();
  if (!unit) {
    return errorDirective(
      `report for per-Bolt Stage "${node.slug}" requires --unit <name>.`,
    );
  }
  if (cursor === null || cursor.stage !== node.slug || cursor.unit !== unit) {
    return errorDirective(
      `Cannot report ${node.slug}/${unit} out of Bolt order; next is ` +
        (cursor === null ? "none" : `${cursor.boltId}/${cursor.stage}/${cursor.unit}`),
    );
  }
  const dag = loadActiveUnitDag(projectRoot);
  const definition = dag?.units.find((candidate) => candidate.name === unit);
  if (definition === undefined) {
    return errorDirective(`Unit "${unit}" is not in the active Unit DAG.`);
  }
  const evidence = verifyStageArtifactEvidence(projectRoot, node, {
    unit,
    ...(definition.kind === undefined ? {} : { unitKind: definition.kind }),
  });
  if (!evidence.valid) {
    return errorDirective(
      `Cannot complete ${id}/${node.slug}/${unit}: missing required artifact evidence:\n` +
        evidence.missing.map((path) => `- ${path}`).join("\n"),
    );
  }
  const transition = completeBoltStageUnit(
    projectRoot,
    id,
    node.slug as BoltStageSlug,
    unit,
  );
  const bolt = transition.allStagesCompleted
    ? completeBolt(projectRoot, id)
    : null;
  return {
    kind: "done",
    reason: bolt === null
      ? `Committed ${id}/${node.slug}/${unit}; run next to continue the Bolt.`
      : `Committed the final Stage cell for ${id}; Bolt status is ${bolt.status}. Run next.`,
  };
}

/** Commit an acted stage result through aidlc-state.ts and stop this report beat. */
export function reportStageResult(
  projectDir: string,
  options: ReportOptions,
): DoneDirective | ErrorDirective {
  const projectRoot = resolve(projectDir);
  const stage = options.stage.trim();
  if (stage === "") return errorDirective("report requires --stage <slug>.");
  try {
    validateIntentState(projectRoot);
    const resume = resumeIntentState(projectRoot);
    if (resume.currentStage !== stage) {
      return errorDirective(
        `Cannot report "${stage}": Current Stage is "${resume.currentStage}".`,
      );
    }
    const node = loadCompiledStageGraph().find((candidate) => candidate.slug === stage);
    if (node === undefined) {
      return errorDirective(`Reported stage "${stage}" is not in the compiled graph.`);
    }
    const stateContent = readFileSync(stateFilePath(projectRoot), "utf8");
    if (BOLT_STAGE_SET.has(stage) && hasBoltState(stateContent)) {
      return reportBoltStageResult(projectRoot, node, options);
    }
    if (
      stage === "ci-pipeline" &&
      options.result !== "skipped" && options.result !== "rejected"
    ) {
      const quality = checkQualityGates(projectRoot);
      if (!quality.valid) {
        return errorDirective(
          "Cannot open or complete the CI Pipeline gate: Quality Gate Manifest validation failed:\n" +
            quality.findings
              .filter((finding) => finding.severity === "error")
              .map((finding) => `- ${finding.code}: ${finding.message}`)
              .join("\n"),
        );
      }
    }
    const dag = loadActiveUnitDag(projectRoot);
    const unitMajorBlock = dag === null
      ? []
      : constructionDesignBlock(
          loadCompiledStageGraph(),
          readPlan(projectRoot),
          stateContent,
        );
    const unitMajor = dag !== null && usesUnitMajorIteration(stateContent) &&
      node.phase === "construction" && node.for_each === "unit-of-work" &&
      node.mode === "inline" &&
      unitMajorBlock.some((candidate) => candidate.slug === node.slug);
    if (options.result === "skipped") {
      if (node.execution !== "CONDITIONAL") {
        return errorDirective(
          `Stage "${stage}" is execution: ${node.execution}; only a CONDITIONAL stage can report skipped.`,
        );
      }
      const reason = options.reason?.trim();
      if (!reason) {
        return errorDirective(
          "report --result skipped requires a nonblank --reason <text>.",
        );
      }
      skipCurrentStage(projectRoot, stage, reason);
      return {
        kind: "done",
        reason:
          `Committed skip for "${stage}" (scope: ${resume.scope}). ` +
          "State routed forward; run next to continue.",
      };
    }
    if (GATE_RESULTS.has(options.result)) {
      if (node.phase === "initialization") {
        return errorDirective(
          `Stage "${stage}" is an ungated initialization stage; it cannot report ${options.result}.`,
        );
      }
      if (options.result === "awaiting-approval") {
        if (resume.checkboxState === "awaiting-approval") {
          return { kind: "done", reason: `Stage "${stage}" is already awaiting approval.` };
        }
        if (resume.checkboxState !== "in-progress") {
          return errorDirective(
            `Stage "${stage}" is ${resume.checkboxState}; only an in-progress Stage can open a gate.`,
          );
        }
        const evidence = unitMajor && dag !== null
          ? unitMajorGridEvidence(projectRoot, unitMajorBlock, dag)
          : verifyStageArtifactEvidence(projectRoot, node, {
              ...(options.unit === undefined ? {} : { unit: options.unit }),
              ...(node.for_each === "unit-of-work" && options.unit === undefined
                ? { singlePass: true }
                : {}),
            });
        if (!evidence.valid) {
          return errorDirective(
            `Cannot open approval for "${stage}": missing required artifact evidence:\n` +
              evidence.missing.map((path) => `- ${path}`).join("\n"),
          );
        }
        if (unitMajor && dag !== null) {
          assertEveryUnitLearningGate(projectRoot, stage, dag);
        } else {
          assertLearningGateCompleted(projectRoot, stage, options.unit);
        }
        openApprovalGate(projectRoot, stage);
        return { kind: "done", reason: `Recorded awaiting-approval for "${stage}".` };
      }
      if (options.result === "rejected") {
        const feedback = (options.userInput ?? options.reason)?.trim();
        if (!feedback) {
          return errorDirective(
            `report --result rejected for "${stage}" requires nonblank --user-input or --reason feedback.`,
          );
        }
        rejectApprovalGate(projectRoot, stage, feedback);
        return { kind: "done", reason: `Recorded rejected for "${stage}".` };
      }
      if (resume.checkboxState !== "revising") {
        return errorDirective(
          `Stage "${stage}" is ${resume.checkboxState}; only a revising Stage can re-enter its gate.`,
        );
      }
      const revisedEvidence = unitMajor && dag !== null
        ? unitMajorGridEvidence(projectRoot, unitMajorBlock, dag)
        : verifyStageArtifactEvidence(projectRoot, node, {
            ...(options.unit === undefined ? {} : { unit: options.unit }),
            ...(node.for_each === "unit-of-work" && options.unit === undefined
              ? { singlePass: true }
              : {}),
          });
      if (!revisedEvidence.valid) {
        return errorDirective(
          `Cannot re-open approval for "${stage}": missing required artifact evidence:\n` +
            revisedEvidence.missing.map((path) => `- ${path}`).join("\n"),
        );
      }
      reviseApprovalGate(projectRoot, stage);
      return { kind: "done", reason: `Recorded revised for "${stage}".` };
    }
    if (!FORWARD_RESULTS.has(options.result)) {
      return errorDirective(`Unknown report result: "${options.result}".`);
    }
    if (node.phase !== "initialization" && options.result !== "approved") {
      return errorDirective(
        `Stage "${stage}" has a human gate; report it with --result approved ` +
          "after completing the Learnings Ritual.",
      );
    }
    const userInput = options.userInput?.trim();
    if (node.phase !== "initialization" && !userInput) {
      return errorDirective(
        `report --result approved for "${stage}" requires --user-input with the human's exact approval choice.`,
      );
    }
    if (resume.checkboxState === "revising") {
      return errorDirective(
        `Stage "${stage}" is revising; report --result revised before approval.`,
      );
    }
    if (node.for_each === "unit-of-work" && dag !== null) {
      if (unitMajor) {
        const gridEvidence = unitMajorGridEvidence(
          projectRoot,
          unitMajorBlock,
          dag,
        );
        if (!gridEvidence.valid) {
          return errorDirective(
            `Cannot approve "${stage}": the unit-major design grid has ` +
              `missing per-unit artifact evidence:\n` +
              gridEvidence.missing.map((path) => `- ${path}`).join("\n"),
          );
        }
        assertEveryUnitLearningGate(projectRoot, stage, dag);
        if (resume.checkboxState === "in-progress") {
          openApprovalGate(projectRoot, stage);
        }
        completeAllCurrentStageUnits(projectRoot, stage);
        approveCurrentStage(projectRoot, stage, userInput ?? "");
        return {
          kind: "done",
          reason:
            `Completed unit-major design Stage "${stage}" after all Units. ` +
            "State advanced; run next to continue.",
        };
      }
      const unit = options.unit?.trim();
      if (!unit) {
        return errorDirective(
          `report for per-Unit stage "${stage}" requires --unit <name>.`,
        );
      }
      if (resume.currentUnit !== null && resume.currentUnit !== unit) {
        return errorDirective(
          `Cannot report Unit "${unit}" out of order; current Unit is ` +
            `"${resume.currentUnit ?? "none"}".`,
        );
      }
      const definition = dag.units.find((candidate) => candidate.name === unit);
      if (definition === undefined) {
        return errorDirective(`Unit "${unit}" is not in the active Unit DAG.`);
      }
      assertLearningGateCompleted(projectRoot, stage, unit);
      const evidence = verifyStageArtifactEvidence(projectRoot, node, {
        unit,
        ...(definition.kind === undefined ? {} : { unitKind: definition.kind }),
      });
      if (!evidence.valid) {
        return errorDirective(
          `Cannot complete "${stage}" for Unit "${unit}": ` +
            `missing required artifact evidence:\n` +
            evidence.missing.map((path) => `- ${path}`).join("\n"),
        );
      }
      if (resume.checkboxState === "in-progress") {
        openApprovalGate(projectRoot, stage);
      }
      const unitTransition = completeCurrentUnitStage(
        projectRoot,
        stage,
        unit,
        userInput,
      );
      if (!unitTransition.allUnitsCompleted) {
        return {
          kind: "done",
          reason:
            `Committed Unit "${unit}" for "${stage}". ` +
            `Next Unit: "${unitTransition.nextUnit}"; run next to continue.`,
        };
      }
      approveCurrentStage(projectRoot, stage, userInput ?? "");
      return {
        kind: "done",
        reason:
          `Committed final Unit "${unit}" and completed "${stage}" ` +
          `(scope: ${resume.scope}). State advanced; run next to continue.`,
      };
    }
    // Reverse engineering may produce one set per repository. Deliberately do
    // not narrow this check to a CLI --repo value: all registered repos are
    // required before the stage-level transition can be committed.
    if (node.phase !== "initialization") {
      assertLearningGateCompleted(projectRoot, stage);
    }
    const evidence = verifyStageArtifactEvidence(
      projectRoot,
      node,
      node.for_each === "unit-of-work" ? { singlePass: true } : {},
    );
    if (!evidence.valid) {
      return errorDirective(
        `Cannot complete "${stage}": missing required artifact evidence:\n` +
          evidence.missing.map((path) => `- ${path}`).join("\n"),
      );
    }
    if (stage === "units-generation") {
      const unitDag = loadActiveUnitDag(projectRoot);
      if (unitDag === null) {
        return errorDirective(
          "Cannot complete units-generation: unit-of-work-dependency.md " +
            "has no fenced YAML units block.",
        );
      }
      hydrateConstructionUnitProgress(projectRoot, unitDag);
    }
    if (stage === "practices-discovery" && !hasFreshPracticesAffirmation(projectRoot)) {
      return errorDirective(
        'Cannot approve "practices-discovery" before practices-promote succeeds. ' +
          "Run practices-promote after the human approves, then report approved again.",
      );
    }
    if (node.phase === "initialization") {
      completeCurrentStage(projectRoot, stage);
    } else {
      if (resume.checkboxState === "in-progress") {
        openApprovalGate(projectRoot, stage);
      }
      approveCurrentStage(projectRoot, stage, userInput ?? "");
    }
    return {
      kind: "done",
      reason:
        `Committed completion for "${stage}" (scope: ${resume.scope}). ` +
        "State advanced; run next to continue.",
    };
  } catch (error) {
    return errorDirective(error instanceof Error ? error.message : String(error));
  }
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  const usage =
    "Usage: aidlc-orchestrate next --project-dir <project-dir> [--unit <name>] " +
    "[--repo <name>] [--continue-token <token>] [--stage <slug> --single]\n" +
    "       aidlc-orchestrate report --project-dir <project-dir> --stage <slug> " +
    "--result <awaiting-approval|approved|rejected|revised|completed|skipped> " +
    "[--user-input <text>] [--reason <text>] [--unit <name>] [--single]";
  if (!cliHasCommand(ORCHESTRATE_CLI_CONTRACT, command)) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  const unknownFlags = cliUnknownFlags(ORCHESTRATE_CLI_CONTRACT, command, args);
  if (unknownFlags.length > 0) {
    emit(errorDirective(
      `Unknown flag(s) for ${command}: ${unknownFlags.join(", ")}`,
    ));
    return;
  }
  if (command === "next") {
    const unit = flagValue(args, "--unit");
    const repo = flagValue(args, "--repo");
    const continueToken = flagValue(args, "--continue-token");
    const stage = flagValue(args, "--stage");
    const single = args.includes("--single");
    emit(resolveNextDirective(projectDir, {
      ...(unit === undefined ? {} : { unit }),
      ...(repo === undefined ? {} : { repo }),
      ...(continueToken === undefined ? {} : { continueToken }),
      ...(stage === undefined ? {} : { stage }),
      ...(single ? { single: true } : {}),
    }));
    return;
  }
  const stage = flagValue(args, "--stage");
  const result = flagValue(args, "--result");
  if (stage === undefined || result === undefined) {
    emit(errorDirective(
      "report requires --stage <slug> and --result " +
        "<awaiting-approval|approved|rejected|revised|completed|skipped>.",
    ));
    return;
  }
  if (!cliAcceptsResult(ORCHESTRATE_CLI_CONTRACT, "report", result)) {
    emit(errorDirective(`Unknown --result "${result}".`));
    return;
  }
  const reason = flagValue(args, "--reason");
  const userInput = flagValue(args, "--user-input");
  const unit = flagValue(args, "--unit");
  if (args.includes("--single")) {
    emit(reportSingleStageResult(projectDir, stage, result as ReportResult));
    return;
  }
  emit(reportStageResult(projectDir, {
    stage,
    result: result as ReportResult,
    ...(reason === undefined ? {} : { reason }),
    ...(userInput === undefined ? {} : { userInput }),
    ...(unit === undefined ? {} : { unit }),
  }));
}

if (import.meta.main) main(process.argv.slice(2));
