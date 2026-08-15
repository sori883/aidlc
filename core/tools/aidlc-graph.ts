import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runtimeCoreDir,
} from "./aidlc-runtime-paths.ts";
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

export interface ScopeCostSummary {
  total: number;
  execute: number;
  skip: number;
  gates: number;
  perUnitStages: number;
}

export interface ScopeValidation {
  valid: boolean;
  errors: string[];
  advisories: string[];
  summary: ScopeCostSummary;
}

const ARS_COMPONENTS = ["iae", "csu", "ve", "r", "ua"] as const;
export type ArsComponent = (typeof ARS_COMPONENTS)[number];
const ARS_SCORE_FLAGS: Record<ArsComponent, string> = {
  iae: "--iae",
  csu: "--csu",
  ve: "--ve",
  r: "--r",
  ua: "--ua",
};
type ArsBand = "LOW" | "MED" | "HIGH";
type ArsDecision = "EXECUTE" | "SKIP" | "COMPLETED";
const ARS_PROJECT_TYPES = ["brownfield", "greenfield"] as const;
export type ArsProjectType = (typeof ARS_PROJECT_TYPES)[number];

interface ArsPriors {
  schemaVersion: number;
  weights: Record<ArsComponent, number>;
  componentInfo: Record<ArsComponent, { name: string }>;
  componentBands: { lowMax: number; medMax: number };
  compositeBands: Array<{
    min: number;
    max: number;
    label: string;
    shape: string;
  }>;
  evThresholds: Record<string, number>;
  stages: Record<string, {
    targets: ArsComponent[];
    cost: number | null;
    role?: string;
    projectTypes?: ArsProjectType[];
  }>;
}

export interface ArsScreenRow {
  stage: string;
  number: string;
  decision: ArsDecision;
  screen:
    | "component"
    | "initialization"
    | "core"
    | "phase-gate"
    | "structural"
    | "project-type"
    | "no-cost-prior"
    | "no-prior"
    | "completed";
  targets: ArsComponent[];
  cost: number | null;
  maxTargetScore: number | null;
  threshold: number | null;
  reason: string;
}

export interface ArsResult {
  schemaVersion: 1;
  components: Record<ArsComponent, {
    name: string;
    score: number;
    band: ArsBand;
  }>;
  composite: { raw: number; total: number; label: string; shape: string };
  evScreen: ArsScreenRow[];
  screenGrid: Record<string, StageAction>;
  nearestScopes: Array<{ scope: string; diff: number; differs: string[] }>;
  completed: string[];
  projectType: ArsProjectType | null;
  tables: { arsScores: string; stageDecisions: string };
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
const RUNTIME_CORE_DIR = runtimeCoreDir();
const DEFAULT_GRAPH_PATH = resolve(RUNTIME_CORE_DIR, "aidlc-common/data/stage-graph.json");
const DEFAULT_SCOPE_GRID_PATH = resolve(
  RUNTIME_CORE_DIR,
  "aidlc-common/data/scope-grid.json",
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
  const graphPath = resolve(
    options.graphPath ?? process.env.AIDLC_STAGE_GRAPH ?? DEFAULT_GRAPH_PATH,
  );
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
  const scopeGridPath = resolve(
    options.scopeGridPath ?? process.env.AIDLC_SCOPE_GRID ?? DEFAULT_SCOPE_GRID_PATH,
  );
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

/** Count the deterministic execution ceremony carried by an arbitrary grid. */
export function gridCostSummary(
  grid: Record<string, StageAction>,
  options: ResolveOptions = {},
): ScopeCostSummary {
  const graph = new Map(
    loadCompiledStageGraph(options).map((stage) => [stage.slug, stage]),
  );
  const total = Object.keys(grid).length;
  let execute = 0;
  let gates = 0;
  let perUnitStages = 0;
  for (const [slug, action] of Object.entries(grid)) {
    if (action !== "EXECUTE") continue;
    execute += 1;
    const stage = graph.get(slug);
    if (stage === undefined) continue;
    if (stage.phase !== "initialization") gates += 1;
    if (stage.for_each === "unit-of-work") perUnitStages += 1;
  }
  return { total, execute, skip: total - execute, gates, perUnitStages };
}

/** Validate a Composer-proposed EXECUTE/SKIP grid against graph contracts. */
export function validateGrid(
  grid: Record<string, string>,
  options: ResolveOptions & {
    projectType?: ArsProjectType;
    strict?: boolean;
    label?: string;
  } = {},
): ScopeValidation {
  const graph = loadCompiledStageGraph(options);
  const knownSlugs = new Set(graph.map((stage) => stage.slug));
  const errors: string[] = [];
  const advisories: string[] = [];
  const label = options.label ?? "proposed grid";

  for (const [slug, action] of Object.entries(grid)) {
    if (!knownSlugs.has(slug)) {
      errors.push(
        `Grid names unknown stage "${slug}" - not in the compiled stage graph.`,
      );
    }
    if (action !== "EXECUTE" && action !== "SKIP") {
      errors.push(
        `Grid entry "${slug}" has invalid action "${action}" ` +
          `(expected EXECUTE or SKIP).`,
      );
    }
  }

  const onPath = new Set(
    Object.entries(grid)
      .filter(([slug, action]) =>
        action === "EXECUTE" && knownSlugs.has(slug)
      )
      .map(([slug]) => slug),
  );
  const producers = new Map<string, CompiledStage[]>();
  for (const stage of graph) {
    for (const artifact of [
      ...stage.produces,
      ...(stage.optional_produces ?? []),
    ]) {
      const rows = producers.get(artifact) ?? [];
      rows.push(stage);
      producers.set(artifact, rows);
    }
  }

  for (const stage of graph
    .filter((row) => onPath.has(row.slug))
    .sort((left, right) => numericStageOrder(left.number, right.number))) {
    for (const consume of stage.consumes ?? []) {
      if (!consume.required) continue;
      if (
        consume.conditional_on !== undefined &&
        options.projectType !== undefined &&
        consume.conditional_on !== options.projectType
      ) continue;
      const artifactProducers = producers.get(consume.artifact) ?? [];
      if (artifactProducers.length === 0) {
        errors.push(
          `Stage "${stage.slug}" requires artifact "${consume.artifact}" ` +
            `but no stage in the graph produces it.`,
        );
        continue;
      }
      if (!artifactProducers.some((producer) => onPath.has(producer.slug))) {
        const message =
          `Stage "${stage.slug}" requires artifact "${consume.artifact}" ` +
          `whose producer(s) [${artifactProducers
            .map((producer) => producer.slug).join(", ")}] ` +
          `are not on the "${label}" path.`;
        if (options.strict) {
          errors.push(
            `${message} Strict (recompose) mode rejects a starved required input.`,
          );
        } else {
          advisories.push(`${message} Ensure existing artifact is current.`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    advisories,
    summary: gridCostSummary(grid as Record<string, StageAction>, options),
  };
}

/** Reject Scope keywords that would shadow an existing Scope. */
export function keywordCollisions(granted: readonly string[]): string[] {
  const scopes = loadScopes();
  const errors: string[] = [];
  for (const keyword of granted) {
    const holders = scopes
      .filter((scope) => scope.keywords.some((candidate) =>
        candidate.toLowerCase() === keyword.toLowerCase()
      ))
      .map((scope) => scope.name)
      .sort();
    if (holders.length === 0) continue;
    errors.push(
      `Keyword "${keyword}" is already claimed by scope` +
        `${holders.length > 1 ? "s" : ""} [${holders.join(", ")}] - ` +
        `granting it would shadow that scope in keyword inference. ` +
        `Pick a keyword no existing scope claims.`,
    );
  }
  return errors;
}

const ARS_RAW_PRECISION = 9;

function arsPriorsPath(): string {
  return process.env.AIDLC_ARS_PRIORS ?? join(RUNTIME_CORE_DIR, "tools", "data", "ars-priors.json");
}

/** Load and fully validate the deterministic ARS priors. */
export function loadArsPriors(): ArsPriors {
  const path = arsPriorsPath();
  const parsed = readJson(path, "ARS priors");
  if (!isRecord(parsed)) throw new Error(`ARS priors at ${path}: not a JSON object.`);
  const priors = parsed as unknown as ArsPriors;
  if (priors.schemaVersion !== 1) {
    throw new Error(
      `ARS priors at ${path}: unsupported schemaVersion ` +
        `${String(priors.schemaVersion)} (expected 1).`,
    );
  }
  let weightSum = 0;
  for (const component of ARS_COMPONENTS) {
    const weight = priors.weights?.[component];
    if (typeof weight !== "number" || weight < 0 || weight > 1) {
      throw new Error(`ARS priors: weights.${component} must be a number in [0,1].`);
    }
    weightSum += weight;
    if (typeof priors.componentInfo?.[component]?.name !== "string") {
      throw new Error(`ARS priors: componentInfo.${component}.name is missing.`);
    }
  }
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new Error(`ARS priors: weights must sum to 1.0 (got ${weightSum}).`);
  }
  const lowMax = priors.componentBands?.lowMax;
  const medMax = priors.componentBands?.medMax;
  if (
    typeof lowMax !== "number" || typeof medMax !== "number" ||
    !(0 < lowMax && lowMax < medMax && medMax <= 1)
  ) {
    throw new Error(
      "ARS priors: componentBands must satisfy 0 < lowMax < medMax <= 1.",
    );
  }
  if (!Array.isArray(priors.compositeBands) || priors.compositeBands.length === 0) {
    throw new Error("ARS priors: compositeBands must be a non-empty array.");
  }
  let expectedMinimum = 0;
  for (const band of priors.compositeBands) {
    if (
      band.min !== expectedMinimum || typeof band.max !== "number" ||
      band.max < band.min || typeof band.label !== "string" ||
      typeof band.shape !== "string"
    ) {
      throw new Error(
        "ARS priors: compositeBands must tile 0..100 contiguously with label + shape.",
      );
    }
    expectedMinimum = band.max + 1;
  }
  if (expectedMinimum !== 101) {
    throw new Error("ARS priors: compositeBands must end at 100.");
  }
  for (const [key, threshold] of Object.entries(priors.evThresholds ?? {})) {
    if (typeof threshold !== "number" || threshold < 0 || threshold > 1) {
      throw new Error(
        `ARS priors: evThresholds["${key}"] must be a number in [0,1].`,
      );
    }
  }
  for (const [slug, stage] of Object.entries(priors.stages ?? {})) {
    if (
      !Array.isArray(stage.targets) ||
      stage.targets.some((target) => !ARS_COMPONENTS.includes(target))
    ) {
      throw new Error(
        `ARS priors: stages.${slug}.targets must be a subset of ` +
          `{${ARS_COMPONENTS.join(", ")}}.`,
      );
    }
    if (stage.cost !== null && typeof stage.cost !== "number") {
      throw new Error(
        `ARS priors: stages.${slug}.cost must be a number or null ` +
          `(got ${typeof stage.cost}).`,
      );
    }
    if (
      stage.cost !== null &&
      !(String(stage.cost) in (priors.evThresholds ?? {}))
    ) {
      throw new Error(
        `ARS priors: stages.${slug}.cost ${String(stage.cost)} ` +
          `has no evThresholds entry.`,
      );
    }
    if (
      stage.projectTypes !== undefined &&
      (!Array.isArray(stage.projectTypes) || stage.projectTypes.length === 0 ||
        stage.projectTypes.some((type) => !ARS_PROJECT_TYPES.includes(type)))
    ) {
      throw new Error(
        `ARS priors: stages.${slug}.projectTypes must be a non-empty subset ` +
          `of {${ARS_PROJECT_TYPES.join(", ")}}.`,
      );
    }
  }
  return priors;
}

function arsThreshold(priors: ArsPriors, cost: number): number {
  const threshold = priors.evThresholds[String(cost)];
  if (threshold === undefined) {
    throw new Error(`ARS priors: cost ${cost} has no EV threshold.`);
  }
  return threshold;
}

/** Deterministically compute the ARS screen and its pre-rendered gate tables. */
export function computeArs(
  scores: Record<ArsComponent, number>,
  options: ResolveOptions & {
    completed?: string[];
    projectType?: ArsProjectType;
  } = {},
): ArsResult {
  const priors = loadArsPriors();
  for (const component of ARS_COMPONENTS) {
    const value = scores[component];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(
        `--${component} must be a number in [0.00, 1.00] (got ${String(value)}).`,
      );
    }
    if (Number(value.toFixed(2)) !== value) {
      throw new Error(
        `--${component} must have at most two decimals (got ${String(value)}).`,
      );
    }
  }

  const graph = loadCompiledStageGraph(options);
  const knownSlugs = new Set(graph.map((stage) => stage.slug));
  const completed = options.completed ?? [];
  for (const slug of completed) {
    if (!knownSlugs.has(slug)) {
      throw new Error(
        `--completed names unknown stage "${slug}" - not in the compiled stage graph.`,
      );
    }
  }
  for (const slug of Object.keys(priors.stages)) {
    if (!knownSlugs.has(slug)) {
      throw new Error(
        `ARS priors: stages.${slug} is not in the compiled stage graph.`,
      );
    }
  }

  const band = (value: number): ArsBand =>
    value < priors.componentBands.lowMax
      ? "LOW"
      : value < priors.componentBands.medMax ? "MED" : "HIGH";
  const format = (value: number): string => value.toFixed(2);
  const symbol = (component: ArsComponent): string => component.toUpperCase();
  const components = {} as ArsResult["components"];
  for (const component of ARS_COMPONENTS) {
    components[component] = {
      name: priors.componentInfo[component].name,
      score: scores[component],
      band: band(scores[component]),
    };
  }
  const raw = Number(
    (100 * ARS_COMPONENTS.reduce(
      (sum, component) => sum + priors.weights[component] * scores[component],
      0,
    )).toFixed(ARS_RAW_PRECISION),
  );
  const total = Math.round(raw);
  const compositeBand = priors.compositeBands.find((candidate) =>
    total >= candidate.min && total <= candidate.max
  );
  if (compositeBand === undefined) {
    throw new Error(`Composite ${total} falls outside the compositeBands coverage.`);
  }

  const completedSet = new Set(completed);
  const offProjectType = (stage?: ArsPriors["stages"][string]): boolean =>
    options.projectType !== undefined && stage?.projectTypes !== undefined &&
    !stage.projectTypes.includes(options.projectType);
  const decisions = new Map<string, ArsDecision>();
  const deferred = new Set<string>();
  for (const stage of graph) {
    const prior = priors.stages[stage.slug];
    if (completedSet.has(stage.slug)) decisions.set(stage.slug, "COMPLETED");
    else if (offProjectType(prior)) decisions.set(stage.slug, "SKIP");
    else if (prior?.role === "phase-gate") deferred.add(stage.slug);
    else if (prior?.role === "initialization" || prior?.role === "core") {
      decisions.set(stage.slug, "EXECUTE");
    } else if (prior === undefined || prior.role === "structural" || prior.cost === null) {
      decisions.set(stage.slug, "SKIP");
    } else {
      const maximum = prior.targets.length === 0
        ? 0
        : Math.max(...prior.targets.map((target) => scores[target]));
      decisions.set(
        stage.slug,
        maximum > arsThreshold(priors, prior.cost) ? "EXECUTE" : "SKIP",
      );
    }
  }
  for (const stage of graph) {
    if (!deferred.has(stage.slug)) continue;
    const phaseActive = graph.some((candidate) =>
      candidate.phase === stage.phase && candidate.slug !== stage.slug &&
      decisions.get(candidate.slug) !== "SKIP"
    );
    decisions.set(stage.slug, phaseActive ? "EXECUTE" : "SKIP");
  }

  const evScreen: ArsScreenRow[] = [];
  for (const stage of graph) {
    const prior = priors.stages[stage.slug];
    const decision = decisions.get(stage.slug) as ArsDecision;
    const base = {
      stage: stage.slug,
      number: stage.number,
      decision,
      targets: prior?.targets ?? [],
      cost: prior?.cost ?? null,
      maxTargetScore: null,
      threshold: null,
    };
    if (decision === "COMPLETED") {
      evScreen.push({
        ...base,
        screen: "completed",
        reason: "completed - in-flight evidence; kept as EXECUTE in the derived grid",
      });
    } else if (prior === undefined) {
      evScreen.push({
        ...base,
        screen: "no-prior",
        reason: "no entry in ars-priors.json - not screenable",
      });
    } else if (offProjectType(prior)) {
      evScreen.push({
        ...base,
        screen: "project-type",
        reason:
          `project is ${String(options.projectType)} - the stage's compiled ` +
          `condition restricts it to ${(prior.projectTypes ?? []).join("/")} projects`,
      });
    } else if (prior.role === "initialization") {
      evScreen.push({
        ...base,
        screen: "initialization",
        reason: "initialization - always runs",
      });
    } else if (prior.role === "core") {
      evScreen.push({
        ...base,
        screen: "core",
        reason: "spine - always (core implementation / verification)",
      });
    } else if (prior.role === "phase-gate") {
      evScreen.push({
        ...base,
        screen: "phase-gate",
        reason: decision === "EXECUTE"
          ? `phase gate - other ${stage.phase} stages execute, so the boundary exists`
          : `phase gate - every other ${stage.phase} stage folds away, so the boundary does not exist`,
      });
    } else if (prior.role === "structural") {
      evScreen.push({
        ...base,
        screen: "structural",
        reason:
          "structural (decomposition) - not numerically screenable; " +
          "mechanical default SKIP, human judgment at the gate",
      });
    } else if (prior.cost === null) {
      evScreen.push({
        ...base,
        screen: "no-cost-prior",
        reason:
          "no cost prior in the shipped table - not numerically screenable; " +
          "human judgment at the gate",
      });
    } else {
      const maximumTarget = prior.targets.reduce((left, right) =>
        scores[left] >= scores[right] ? left : right
      );
      const maximum = scores[maximumTarget];
      const threshold = arsThreshold(priors, prior.cost);
      evScreen.push({
        ...base,
        maxTargetScore: maximum,
        threshold,
        screen: "component",
        reason: decision === "EXECUTE"
          ? `reduces ${symbol(maximumTarget)}=${format(maximum)} > ` +
            `threshold ${threshold} (cost ${prior.cost})`
          : `max target ${symbol(maximumTarget)}=${format(maximum)} <= ` +
            `threshold ${threshold} (cost ${prior.cost})`,
      });
    }
  }

  const screenGrid: Record<string, StageAction> = {};
  for (const stage of graph) {
    screenGrid[stage.slug] = decisions.get(stage.slug) === "SKIP" ? "SKIP" : "EXECUTE";
  }
  const nearestScopes = Object.entries(loadCompiledScopeGrid(options))
    .map(([scope, definition]) => {
      const differs = Object.entries(definition.stages)
        .filter(([slug, action]) => screenGrid[slug] !== undefined && screenGrid[slug] !== action)
        .map(([slug]) => slug);
      return { scope, diff: differs.length, differs };
    })
    .sort((left, right) => left.diff - right.diff || left.scope.localeCompare(right.scope));
  const arsScores = [
    "| Component | Symbol | Score | Band |",
    "|-----------|--------|-------|------|",
    ...ARS_COMPONENTS.map((component) =>
      `| ${components[component].name} | ${symbol(component)} | ` +
      `${format(scores[component])} | ${components[component].band} |`
    ),
    `| **Composite ARS (advisory)** | - | **${total} / 100** | ` +
      `**${compositeBand.label}** |`,
  ].join("\n");
  const stageDecisions = [
    "| # | Stage | Decision | Reasoning |",
    "|---|-------|----------|-----------|",
    ...evScreen.map((row) =>
      `| ${row.number} | ${row.stage} | ${row.decision} | ${row.reason} |`
    ),
  ].join("\n");
  return {
    schemaVersion: 1,
    components,
    composite: {
      raw,
      total,
      label: compositeBand.label,
      shape: compositeBand.shape,
    },
    evScreen,
    screenGrid,
    nearestScopes,
    completed,
    projectType: options.projectType ?? null,
    tables: { arsScores, stageDecisions },
  };
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
    compileStage(
      stage,
      sensors,
      rules,
      options.harnessDir ?? ".codex",
    )
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

function cliFlagValue(
  args: readonly string[],
  flag: string,
  required = false,
): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    if (required) throw new Error(`${flag} requires a value.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function cliProjectType(
  args: readonly string[],
): ArsProjectType | undefined {
  const raw = cliFlagValue(args, "--project-type");
  if (raw === undefined) return undefined;
  const lowered = raw.toLowerCase();
  if (lowered !== "brownfield" && lowered !== "greenfield") {
    throw new Error(
      `--project-type must be brownfield or greenfield (got "${raw}").`,
    );
  }
  return lowered;
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

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  try {
    if (!cliHasCommand(GRAPH_CLI_CONTRACT, command)) {
      throw new Error(`Unknown command: ${command ?? ""}`);
    }
    const unknownFlags = cliUnknownFlags(GRAPH_CLI_CONTRACT, command, args);
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown flag(s) for ${command}: ${unknownFlags.join(", ")}`);
    }
    if (command === "ars") {
      const scores = {} as Record<ArsComponent, number>;
      for (const component of ARS_COMPONENTS) {
        const flag = ARS_SCORE_FLAGS[component];
        const raw = cliFlagValue(args, flag, true) as string;
        const value = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(
            `${flag} must be a number in [0.00, 1.00] (got "${raw}").`,
          );
        }
        if (Number(value.toFixed(2)) !== value) {
          throw new Error(
            `${flag} must have at most two decimals (got "${raw}").`,
          );
        }
        scores[component] = value;
      }
      const completedRaw = cliFlagValue(args, "--completed");
      const completed = completedRaw === undefined
        ? undefined
        : completedRaw.split(",").map((slug) => slug.trim()).filter(Boolean);
      if (completedRaw !== undefined && completed?.length === 0) {
        throw new Error("--completed requires a comma-separated value.");
      }
      const projectType = cliProjectType(args);
      const result = computeArs(scores, {
        ...(completed === undefined ? {} : { completed }),
        ...(projectType === undefined ? {} : { projectType }),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === "validate-grid") {
      const proposalPath = cliFlagValue(args, "--proposal", true) as string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(proposalPath, "utf8"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`validate-grid: cannot read ${proposalPath}: ${detail}`);
      }
      if (!isRecord(parsed)) {
        throw new Error(
          "validate-grid: proposal must be a JSON object of " +
            `{"<stage-slug>": "EXECUTE"|"SKIP"} ` +
            "(or {stages: {...}}).",
        );
      }
      const candidate = isRecord(parsed.stages) ? parsed.stages : parsed;
      const grid: Record<string, string> = {};
      for (const [slug, action] of Object.entries(candidate)) {
        grid[slug] = String(action);
      }
      const projectType = cliProjectType(args);
      const result = validateGrid(grid, {
        strict: args.includes("--strict"),
        ...(projectType === undefined ? {} : { projectType }),
      });
      const keywords = cliFlagValue(args, "--keywords");
      if (keywords !== undefined) {
        const granted = keywords.split(",").map((value) => value.trim()).filter(Boolean);
        if (granted.length === 0) {
          throw new Error("--keywords requires a comma-separated value.");
        }
        result.errors.push(...keywordCollisions(granted));
        result.valid = result.errors.length === 0;
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.valid) process.exitCode = 1;
      return;
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
        "       aidlc-graph resolve <scope> [--project <project-dir>] [--stdout]\n" +
        "       aidlc-graph ars --iae <s> --csu <s> --ve <s> --r <s> --ua <s>\n" +
        "       aidlc-graph validate-grid --proposal <path> [--strict]",
    );
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
