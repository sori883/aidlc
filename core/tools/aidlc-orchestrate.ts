// Deterministic orchestration engine. `next` never edits State or Audit and
// emits exactly one typed Directive. M10 may lazily create gitignored local
// steering-token state before it releases run-stage. `report` remains the only
// workflow mutation route and delegates transitions to aidlc-state.ts.

import { readFileSync, readdirSync } from "node:fs";
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
  approveCurrentStage,
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
import { loadActiveUnitDag } from "./aidlc-unit-graph.ts";
import { resolveSteeringDirective } from "./aidlc-steering.ts";
import { assertLearningGateCompleted } from "./aidlc-learnings.ts";
import { appendAuditEntries } from "./aidlc-audit.ts";
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
const CORE_DIR = resolve(TOOL_DIR, "..");
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
  return new RegExp(`^- \\*\\*${escaped}\\*\\*:[ \\t]*(.*)$`, "m")
    .exec(content)?.[1]?.trim() ?? null;
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
      readPlan(projectRoot),
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
        assertLearningGateCompleted(projectRoot, stage, options.unit);
        const evidence = verifyStageArtifactEvidence(projectRoot, node, {
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
      const revisedEvidence = verifyStageArtifactEvidence(projectRoot, node, {
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

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
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

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
