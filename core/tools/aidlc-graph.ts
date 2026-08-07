import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadAgents,
  validateStageAgentReferences,
} from "./aidlc-agent-loader.ts";
import {
  type LoadedStage,
  type LoadStagesOptions,
  loadStages,
} from "./aidlc-stage-loader.ts";
import {
  loadSensors,
  resolveSensorsForStage,
  type SensorDefinition,
  type SensorResolution,
  validateStageSensorReferences,
} from "./aidlc-sensor-loader.ts";
import {
  loadRules,
  type RuleDefinition,
  type RuleResolution,
  resolveRulesForStage,
} from "./aidlc-rule-loader.ts";
import {
  loadScopes,
  validateScopeGridDefinitions,
  validateStageScopeReferences,
} from "./aidlc-scope-loader.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import {
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";

const GRAPH_CLI_CONTRACT = loadCliContract("aidlc-graph.ts");

export interface CompiledStage extends Omit<LoadedStage, "sourcePath"> {
  rules_in_context: RuleResolution[];
  sensors_applicable: SensorResolution[];
}

export interface ScopeGrid {
  [scope: string]: {
    stages: Record<string, "EXECUTE" | "SKIP">;
  };
}

export type StageAction = "EXECUTE" | "SKIP";

export interface ResolvedPlanStage {
  slug: string;
  phase: string;
  action: StageAction;
}

export interface ResolveOptions {
  graphPath?: string;
  scopeGridPath?: string;
}

export interface CompileResult {
  stages: CompiledStage[];
  scopeGrid: ScopeGrid;
  graphJson: string;
  scopeGridJson: string;
}

export interface CompileOptions extends LoadStagesOptions {
  agentsDir?: string;
  sensorsDir?: string;
  harnessDir?: string;
  memoryDir?: string;
  memoryDisplayRoot?: string;
  graphPath?: string;
  scopeGridPath?: string;
  scopesDir?: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GRAPH_PATH = resolve(MODULE_DIR, "../aidlc-common/data/stage-graph.json");
const DEFAULT_SCOPE_GRID_PATH = resolve(
  MODULE_DIR,
  "../aidlc-common/data/scope-grid.json",
);

const FIELD_ORDER = [
  "slug",
  "number",
  "name",
  "phase",
  "execution",
  "condition",
  "lead_agent",
  "support_agents",
  "mode",
  "plugin",
  "for_each",
  "workspace_requires",
  "produces",
  "optional_produces",
  "produces_kinds",
  "consumes",
  "requires_stage",
  "sensors",
  "scopes",
  "reviewer",
  "reviewer_max_iterations",
  "inputs",
  "outputs",
  "rules_in_context",
  "sensors_applicable",
] as const satisfies readonly (keyof CompiledStage)[];

export function numericStageOrder(a: string, b: string): number {
  const [aPhase = 0, aIndex = 0] = a.split(".").map(Number);
  const [bPhase = 0, bIndex = 0] = b.split(".").map(Number);
  return aPhase - bPhase || aIndex - bIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${label} at ${path}: ${detail}`);
  }
}

/** Load the compiled graph used by the runtime resolver. */
export function loadCompiledStageGraph(
  options: ResolveOptions = {},
): CompiledStage[] {
  const graphPath = resolve(options.graphPath ?? DEFAULT_GRAPH_PATH);
  const value = readJson(graphPath, "stage graph");
  if (!Array.isArray(value)) {
    throw new Error(`Invalid stage graph at ${graphPath}: expected an array`);
  }

  const seen = new Set<string>();
  return value.map((row, index) => {
    if (
      !isRecord(row) ||
      typeof row.slug !== "string" ||
      typeof row.number !== "string" ||
      typeof row.phase !== "string"
    ) {
      throw new Error(
        `Invalid stage graph at ${graphPath}: row ${index} requires string slug, number, and phase`,
      );
    }
    if (seen.has(row.slug)) {
      throw new Error(
        `Invalid stage graph at ${graphPath}: duplicate slug "${row.slug}"`,
      );
    }
    seen.add(row.slug);
    return row as unknown as CompiledStage;
  });
}

/** Load the compiled scope-to-stage action grid used by the runtime resolver. */
export function loadCompiledScopeGrid(
  options: ResolveOptions = {},
): ScopeGrid {
  const scopeGridPath = resolve(options.scopeGridPath ?? DEFAULT_SCOPE_GRID_PATH);
  const value = readJson(scopeGridPath, "scope grid");
  if (!isRecord(value)) {
    throw new Error(
      `Invalid scope grid at ${scopeGridPath}: expected an object`,
    );
  }

  for (const [scope, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isRecord(entry.stages)) {
      throw new Error(
        `Invalid scope grid at ${scopeGridPath}: scope "${scope}" requires a stages object`,
      );
    }
    for (const [slug, action] of Object.entries(entry.stages)) {
      if (action !== "EXECUTE" && action !== "SKIP") {
        throw new Error(
          `Invalid scope grid at ${scopeGridPath}: ${scope}.${slug} must be EXECUTE or SKIP`,
        );
      }
    }
  }
  return value as ScopeGrid;
}

function requireScope(scope: string, scopeGrid: ScopeGrid): ScopeGrid[string] {
  const entry = scopeGrid[scope];
  if (entry !== undefined) return entry;
  throw new Error(
    `Unknown scope: "${scope}". Valid scopes: ${Object.keys(scopeGrid).sort().join(", ")}`,
  );
}

/** Resolve EXECUTE/SKIP for every stage, preserving numeric stage order. */
export function resolvePlanForScope(
  scope: string,
  options: ResolveOptions = {},
): ResolvedPlanStage[] {
  const scopeGrid = loadCompiledScopeGrid(options);
  const entry = requireScope(scope, scopeGrid);
  return loadCompiledStageGraph(options)
    .slice()
    .sort((a, b) => numericStageOrder(a.number, b.number))
    .map((stage) => ({
      slug: stage.slug,
      phase: stage.phase,
      action: entry.stages[stage.slug] === "EXECUTE" ? "EXECUTE" : "SKIP",
    }));
}

/** Resolve the active Intent's upstream v2 plan location. */
export function resolvedPlanPath(projectDir: string): string {
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
  return join(intentsRoot, intent, ".aidlc-plan.json");
}

/** Persist a scope plan under the active Intent, matching upstream v2. */
export function writeResolvedPlanForScope(
  scope: string,
  projectDir: string,
  options: ResolveOptions = {},
): string {
  const path = resolvedPlanPath(projectDir);
  writeFileAtomic(
    path,
    `${JSON.stringify(resolvePlanForScope(scope, options), null, 2)}\n`,
  );
  return path;
}

/** Return only the stages that execute for a scope, in numeric stage order. */
export function subgraphForScope(
  scope: string,
  options: ResolveOptions = {},
): CompiledStage[] {
  const scopeGrid = loadCompiledScopeGrid(options);
  const entry = requireScope(scope, scopeGrid);
  return loadCompiledStageGraph(options)
    .filter((stage) => entry.stages[stage.slug] === "EXECUTE")
    .sort((a, b) => numericStageOrder(a.number, b.number));
}

export function validateStageDependencies(stages: readonly LoadedStage[]): void {
  const bySlug = new Map(stages.map((stage) => [stage.slug, stage]));
  for (const stage of stages) {
    const seen = new Set<string>();
    for (const dependencySlug of stage.requires_stage) {
      if (seen.has(dependencySlug)) {
        throw new Error(
          `${stage.slug}: duplicate requires_stage entry "${dependencySlug}"`,
        );
      }
      seen.add(dependencySlug);
      const dependency = bySlug.get(dependencySlug);
      if (dependency === undefined) {
        throw new Error(
          `${stage.slug}: unknown requires_stage "${dependencySlug}"`,
        );
      }
      if (numericStageOrder(dependency.number, stage.number) >= 0) {
        throw new Error(
          `${stage.slug} (${stage.number}): dependency ${dependency.slug} ` +
            `(${dependency.number}) must have a lower stage number`,
        );
      }
    }
  }
}

/** Validate the producer/consumer contract compiled into the stage graph. */
export function validateArtifactContracts(
  stages: readonly Pick<
    LoadedStage,
    "slug" | "number" | "produces" | "optional_produces" | "consumes"
  >[],
): void {
  const producers = new Map<string, { slug: string; number: string }>();
  const artifactPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  for (const stage of stages) {
    const stageArtifacts = [
      ...stage.produces,
      ...(stage.optional_produces ?? []),
    ];
    const seen = new Set<string>();
    for (const artifact of stageArtifacts) {
      if (!artifactPattern.test(artifact)) {
        throw new Error(
          `${stage.slug}: artifact "${artifact}" must use lowercase kebab-case`,
        );
      }
      if (seen.has(artifact)) {
        throw new Error(
          `${stage.slug}: duplicate produced artifact "${artifact}"`,
        );
      }
      seen.add(artifact);
      const previous = producers.get(artifact);
      if (previous !== undefined) {
        throw new Error(
          `Artifact "${artifact}" has multiple producers: ` +
            `${previous.slug}, ${stage.slug}`,
        );
      }
      producers.set(artifact, { slug: stage.slug, number: stage.number });
    }
  }

  for (const stage of stages) {
    const seen = new Set<string>();
    for (const consume of stage.consumes) {
      if (!artifactPattern.test(consume.artifact)) {
        throw new Error(
          `${stage.slug}: artifact "${consume.artifact}" must use lowercase kebab-case`,
        );
      }
      if (seen.has(consume.artifact)) {
        throw new Error(
          `${stage.slug}: duplicate consumed artifact "${consume.artifact}"`,
        );
      }
      seen.add(consume.artifact);
      const producer = producers.get(consume.artifact);
      if (producer === undefined) {
        throw new Error(
          `${stage.slug}: consumed artifact "${consume.artifact}" has no producer`,
        );
      }
      if (numericStageOrder(producer.number, stage.number) >= 0) {
        throw new Error(
          `${stage.slug} (${stage.number}): artifact "${consume.artifact}" ` +
            `must be produced by an earlier stage; producer ` +
            `${producer.slug} is ${producer.number}`,
        );
      }
    }
  }
}

function compileStage(
  stage: LoadedStage,
  sensors: readonly SensorDefinition[],
  rules: readonly RuleDefinition[],
  harnessDir: string,
): CompiledStage {
  const { sourcePath: _sourcePath, ...definition } = stage;
  return {
    ...definition,
    rules_in_context: resolveRulesForStage(stage, rules),
    sensors_applicable: resolveSensorsForStage(stage, sensors, harnessDir),
  };
}

export function transposeScopeGrid(stages: readonly CompiledStage[]): ScopeGrid {
  const scopeNames = new Set<string>();
  for (const stage of stages) {
    for (const scope of stage.scopes) scopeNames.add(scope);
  }

  const grid: ScopeGrid = {};
  for (const scope of [...scopeNames].sort()) {
    const actions: Record<string, "EXECUTE" | "SKIP"> = {};
    for (const stage of stages) {
      actions[stage.slug] =
        stage.phase === "initialization" || stage.scopes.includes(scope)
          ? "EXECUTE"
          : "SKIP";
    }
    grid[scope] = { stages: actions };
  }
  return grid;
}

export function canonicalStageGraphJson(stages: readonly CompiledStage[]): string {
  const ordered = stages.map((stage) => {
    const row: Partial<Record<keyof CompiledStage, unknown>> = {};
    for (const key of FIELD_ORDER) {
      const value = stage[key];
      if (value !== undefined) row[key] = value;
    }
    return row;
  });
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function canonicalScopeGridJson(scopeGrid: ScopeGrid): string {
  return `${JSON.stringify(scopeGrid, null, 2)}\n`;
}

export function compileStageGraph(options: CompileOptions = {}): CompileResult {
  const loaded = loadStages(options);
  const agents = loadAgents(options.agentsDir);
  validateStageAgentReferences(loaded, agents);
  const sensors = loadSensors(options.sensorsDir);
  validateStageSensorReferences(loaded, sensors);
  const rules = loadRules(options.memoryDir, options.memoryDisplayRoot);
  const scopes = loadScopes(options.scopesDir);
  validateStageScopeReferences(loaded, scopes);
  validateStageDependencies(loaded);
  validateArtifactContracts(loaded);
  const stages = loaded.map((stage) =>
    compileStage(stage, sensors, rules, options.harnessDir ?? ".codex")
  );
  const scopeGrid = transposeScopeGrid(stages);
  validateScopeGridDefinitions(scopeGrid, scopes);
  return {
    stages,
    scopeGrid,
    graphJson: canonicalStageGraphJson(stages),
    scopeGridJson: canonicalScopeGridJson(scopeGrid),
  };
}

function writeFileAtomic(path: string, content: string): void {
  const temporaryPath = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
}

export function writeCompiledStageGraph(options: CompileOptions = {}): CompileResult {
  const result = compileStageGraph(options);
  const graphPath = resolve(options.graphPath ?? DEFAULT_GRAPH_PATH);
  const scopeGridPath = resolve(options.scopeGridPath ?? DEFAULT_SCOPE_GRID_PATH);
  writeFileAtomic(graphPath, result.graphJson);
  writeFileAtomic(scopeGridPath, result.scopeGridJson);
  return result;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function checkCompiledStageGraph(options: CompileOptions = {}): {
  result: CompileResult;
  staleFiles: string[];
} {
  const result = compileStageGraph(options);
  const graphPath = resolve(options.graphPath ?? DEFAULT_GRAPH_PATH);
  const scopeGridPath = resolve(options.scopeGridPath ?? DEFAULT_SCOPE_GRID_PATH);
  const staleFiles: string[] = [];
  if (readOrEmpty(graphPath) !== result.graphJson) staleFiles.push(graphPath);
  if (readOrEmpty(scopeGridPath) !== result.scopeGridJson) {
    staleFiles.push(scopeGridPath);
  }
  return { result, staleFiles };
}

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (!cliHasCommand(GRAPH_CLI_CONTRACT, command)) {
      throw new Error(`Unknown command: ${command ?? ""}`);
    }
    const unknownFlags = cliUnknownFlags(GRAPH_CLI_CONTRACT, command, args);
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown flag(s) for ${command}: ${unknownFlags.join(", ")}`);
    }
    if (command === "compile" && args.every((arg) => arg === "--check")) {
      if (args.includes("--check")) {
        const { result, staleFiles } = checkCompiledStageGraph();
        if (staleFiles.length > 0) {
          console.error(`Compiled data is out of date: ${staleFiles.join(", ")}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Compiled graph is up to date (${result.stages.length} stages).`);
        return;
      }

      const result = writeCompiledStageGraph();
      console.log(`Compiled ${result.stages.length} stages.`);
      return;
    }

    if (command === "resolve" && args.length >= 1) {
      const scope = args[0];
      if (scope === undefined) throw new Error("scope is required");
      const remaining = args.slice(1);
      let projectDir = ".";
      let stdout = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const arg = remaining[index];
        if (arg === "--stdout") {
          stdout = true;
          continue;
        }
        if (arg === "--project") {
          const value = remaining[index + 1];
          if (value === undefined || value.startsWith("--")) {
            throw new Error("--project requires a project directory");
          }
          projectDir = value;
          index += 1;
          continue;
        }
        throw new Error(
          "Usage: aidlc-graph resolve <scope> [--project <project-dir>] [--stdout]",
        );
      }
      if (stdout) {
        process.stdout.write(
          `${JSON.stringify(resolvePlanForScope(scope), null, 2)}\n`,
        );
        return;
      }
      console.log(writeResolvedPlanForScope(scope, projectDir));
      return;
    }

    console.error(
      "Usage: aidlc-graph compile [--check]\n" +
        "       aidlc-graph resolve <scope> [--project <project-dir>] [--stdout]",
    );
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
