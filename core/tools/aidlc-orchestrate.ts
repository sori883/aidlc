// Deterministic M6 orchestration engine. `next` is read-only and emits exactly
// one typed Directive. `report` is the only mutation route and delegates the
// transition to aidlc-state.ts; this module never edits State or Audit itself.

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  completeCurrentUnitStage,
  completeCurrentStage,
  hydrateConstructionUnitProgress,
  planFilePath,
  resumeIntentState,
  skipCurrentStage,
  stateFilePath,
  validateIntentState,
} from "./aidlc-state.ts";
import { activeSpace } from "./aidlc-workspace.ts";
import { loadActiveUnitDag } from "./aidlc-unit-graph.ts";

export type ReportResult =
  | "approved"
  | "completed"
  | "complete"
  | "done"
  | "skipped";

export interface ReportOptions {
  stage: string;
  result: ReportResult;
  reason?: string;
  unit?: string;
}

export type ResolveNextOptions = ArtifactResolutionOptions;

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(TOOL_DIR, "..");
const FORWARD_RESULTS = new Set<ReportResult>([
  "approved",
  "completed",
  "complete",
  "done",
]);

function errorDirective(message: string): ErrorDirective {
  return { kind: "error", message };
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
  return new RegExp(`^- \\*\\*${escaped}\\*\\*:\\s*(.*)$`, "m")
    .exec(content)?.[1]?.trim() ?? null;
}

function inlineContextPaths(stage: CompiledStage): string[] {
  const names = stage.mode === "inline"
    ? [stage.lead_agent, ...(stage.support_agents ?? [])]
    : stage.mode === "mob" ? [stage.lead_agent] : [];
  return [...new Set(names)]
    .filter((name) => name !== "orchestrator")
    .map((name) => join(CORE_DIR, "agents", `${name}.md`));
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
  if (resume.nextStage !== "none") {
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
    inline_context_paths: inlineContextPaths(stage),
    gate: stage.phase !== "initialization",
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

/** Resolve one upstream-compatible next action without changing State or Audit. */
export function resolveNextDirective(
  projectDir: string,
  options: ResolveNextOptions = {},
): Directive {
  const projectRoot = resolve(projectDir);
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
    if (![
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
    const stateContent = readFileSync(stateFilePath(projectRoot), "utf8");
    const dag = loadActiveUnitDag(projectRoot);
    const artifactOptions: ResolveNextOptions = { ...options };
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
    return buildRunStageDirective(
      projectRoot,
      stage,
      graph,
      readPlan(projectRoot),
      stateContent,
      artifactOptions,
    );
  } catch (error) {
    return errorDirective(error instanceof Error ? error.message : String(error));
  }
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
    if (!FORWARD_RESULTS.has(options.result)) {
      return errorDirective(`Unknown report result: "${options.result}".`);
    }
    const dag = loadActiveUnitDag(projectRoot);
    if (node.for_each === "unit-of-work" && dag !== null) {
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
      const unitTransition = completeCurrentUnitStage(projectRoot, stage, unit);
      if (!unitTransition.allUnitsCompleted) {
        return {
          kind: "done",
          reason:
            `Committed Unit "${unit}" for "${stage}". ` +
            `Next Unit: "${unitTransition.nextUnit}"; run next to continue.`,
        };
      }
      completeCurrentStage(projectRoot, stage);
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
    completeCurrentStage(projectRoot, stage);
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

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  const usage =
    "Usage: aidlc-orchestrate next --project-dir <project-dir> [--unit <name>] [--repo <name>]\n" +
    "       aidlc-orchestrate report --project-dir <project-dir> --stage <slug> " +
    "--result <completed|approved|skipped> [--reason <text>] [--unit <name>]";
  if (!["next", "report"].includes(command ?? "")) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  if (command === "next") {
    const unit = flagValue(args, "--unit");
    const repo = flagValue(args, "--repo");
    emit(resolveNextDirective(projectDir, {
      ...(unit === undefined ? {} : { unit }),
      ...(repo === undefined ? {} : { repo }),
    }));
    return;
  }
  const stage = flagValue(args, "--stage");
  const result = flagValue(args, "--result");
  if (stage === undefined || result === undefined) {
    emit(errorDirective(
      "report requires --stage <slug> and --result <completed|approved|skipped>.",
    ));
    return;
  }
  if (![
    "approved",
    "completed",
    "complete",
    "done",
    "skipped",
  ].includes(result)) {
    emit(errorDirective(`Unknown --result "${result}".`));
    return;
  }
  const reason = flagValue(args, "--reason");
  const unit = flagValue(args, "--unit");
  emit(reportStageResult(projectDir, {
    stage,
    result: result as ReportResult,
    ...(reason === undefined ? {} : { reason }),
    ...(unit === undefined ? {} : { unit }),
  }));
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
