// Deterministic M6 orchestration engine. `next` is read-only and emits exactly
// one typed Directive. `report` is the only mutation route and delegates the
// transition to aidlc-state.ts; this module never edits State or Audit itself.

import { existsSync, readFileSync } from "node:fs";
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
  activeIntentRecordDir,
  completeCurrentStage,
  planFilePath,
  resumeIntentState,
  skipCurrentStage,
  stateFilePath,
  validateIntentState,
} from "./aidlc-state.ts";
import { activeSpace } from "./aidlc-workspace.ts";

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
}

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

function statePlanAction(
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

function outputPath(
  recordPrefix: string,
  stage: CompiledStage,
  artifact: string,
): string {
  return portablePath(
    join(recordPrefix, stage.phase, stage.slug, `${artifact}.md`),
  );
}

function producerMap(graph: readonly CompiledStage[]): Map<string, CompiledStage> {
  const producers = new Map<string, CompiledStage>();
  for (const stage of graph) {
    for (const artifact of [
      ...(stage.produces ?? []),
      ...(stage.optional_produces ?? []),
    ]) {
      const previous = producers.get(artifact);
      if (previous !== undefined && previous.slug !== stage.slug) {
        throw new Error(
          `Artifact "${artifact}" has multiple producers: ${previous.slug}, ${stage.slug}`,
        );
      }
      producers.set(artifact, stage);
    }
  }
  return producers;
}

function inlineContextPaths(stage: CompiledStage): string[] {
  const names = stage.mode === "inline"
    ? [stage.lead_agent, ...(stage.support_agents ?? [])]
    : stage.mode === "mob" ? [stage.lead_agent] : [];
  return [...new Set(names)]
    .filter((name) => name !== "orchestrator")
    .map((name) => join(CORE_DIR, "agents", `${name}.md`));
}

function applicableConsumes(
  projectType: string,
  stage: CompiledStage,
): CompiledStage["consumes"] {
  const normalized = projectType.toLowerCase();
  return (stage.consumes ?? []).filter(
    (consume) => consume.conditional_on === undefined ||
      consume.conditional_on === normalized,
  );
}

function buildRunStageDirective(
  projectDir: string,
  stage: CompiledStage,
  graph: readonly CompiledStage[],
  plan: readonly ResolvedPlanStage[],
  stateContent: string,
): RunStageDirective {
  const recordDir = activeIntentRecordDir(projectDir);
  const recordPrefix = workspacePath(projectDir, recordDir);
  const projectType = stateField(stateContent, "Project Type") ?? "Unknown";
  const producers = producerMap(graph);
  const consumes: string[] = [];
  const consumesAbsent: Array<{ path: string; expected: boolean }> = [];

  for (const consume of applicableConsumes(projectType, stage)) {
    const producer = producers.get(consume.artifact);
    if (producer === undefined) {
      throw new Error(
        `Stage "${stage.slug}" consumes unknown artifact "${consume.artifact}"`,
      );
    }
    const path = outputPath(recordPrefix, producer, consume.artifact);
    if (existsSync(resolve(projectDir, path))) {
      consumes.push(path);
    } else if (consume.required) {
      const planned = plan.find((row) => row.slug === producer.slug)?.action;
      const routed = statePlanAction(stateContent, producer.slug) ?? planned;
      consumesAbsent.push({ path, expected: routed !== "EXECUTE" });
    }
  }

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
      join(recordPrefix, stage.phase, stage.slug, "memory.md"),
    ),
    consumes,
    produces: (stage.produces ?? []).map((artifact) =>
      outputPath(recordPrefix, stage, artifact)
    ),
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
  };
  if (consumesAbsent.length > 0) directive.consumes_absent = consumesAbsent;
  if (stage.reviewer !== undefined) {
    directive.reviewer = stage.reviewer;
    directive.reviewer_max_iterations = stage.reviewer_max_iterations ?? 2;
  }
  return directive;
}

/** Resolve one upstream-compatible next action without changing State or Audit. */
export function resolveNextDirective(projectDir: string): Directive {
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
    return buildRunStageDirective(
      projectRoot,
      stage,
      graph,
      readPlan(projectRoot),
      stateContent,
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
    "Usage: aidlc-orchestrate next --project-dir <project-dir>\n" +
    "       aidlc-orchestrate report --project-dir <project-dir> --stage <slug> " +
    "--result <completed|approved|skipped> [--reason <text>]";
  if (!["next", "report"].includes(command ?? "")) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  if (command === "next") {
    emit(resolveNextDirective(projectDir));
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
  emit(reportStageResult(projectDir, {
    stage,
    result: result as ReportResult,
    ...(reason === undefined ? {} : { reason }),
  }));
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
