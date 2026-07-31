import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

export const PHASES = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

export type Phase = (typeof PHASES)[number];
export type Execution = "ALWAYS" | "CONDITIONAL";
export type StageMode = "inline" | "subagent" | "pipeline" | "mob";

export interface StageCatalogEntry {
  slug: string;
  number: string;
  name: string;
}

export interface StageConsume {
  artifact: string;
  required: boolean;
  conditional_on?: "brownfield" | "greenfield";
}

export interface StageFrontmatter {
  slug: string;
  phase: Phase;
  execution: Execution;
  condition: string;
  lead_agent: string;
  support_agents: string[];
  mode: StageMode;
  produces: string[];
  consumes: StageConsume[];
  requires_stage: string[];
  sensors: string[];
  scopes: string[];
  inputs: string;
  outputs: string;
  plugin?: string;
  reviewer?: string;
  reviewer_max_iterations?: number;
  for_each?: string;
  workspace_requires?: boolean;
  optional_produces?: string[];
  produces_kinds?: Record<string, string[]>;
}

export interface LoadedStage extends StageFrontmatter {
  number: string;
  name: string;
  sourcePath: string;
}

export interface LoadStagesOptions {
  catalogPath?: string;
  stagesDir?: string;
}

const DEFAULT_CATALOG_PATH = resolve(
  "core/aidlc-common/data/stage-catalog.json",
);
const DEFAULT_STAGES_DIR = resolve("core/aidlc-common/stages");
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUMBER_PATTERN = /^\d+\.\d+$/;

const TOP_LEVEL_KEYS = new Set([
  "slug",
  "phase",
  "execution",
  "condition",
  "lead_agent",
  "support_agents",
  "mode",
  "produces",
  "consumes",
  "requires_stage",
  "sensors",
  "scopes",
  "inputs",
  "outputs",
  "plugin",
  "reviewer",
  "reviewer_max_iterations",
  "for_each",
  "workspace_requires",
  "optional_produces",
  "produces_kinds",
]);

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(context, "must be a non-empty string");
  }
  return value;
}

function asStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  return value.map((item, index) => asString(item, `${context}[${index}]`));
}

function asOptionalString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  if (record[key] === undefined) return undefined;
  return asString(record[key], `${context}.${key}`);
}

function assertAllowedValue<T extends string>(
  value: string,
  allowed: readonly T[],
  context: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    fail(context, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function extractFrontmatter(source: string, filePath: string): string {
  const match = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) fail(filePath, "missing YAML frontmatter");
  return match[1];
}

function parseYamlFrontmatter(source: string, filePath: string): Record<string, unknown> {
  const document = parseDocument(extractFrontmatter(source, filePath), {
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(
      filePath,
      `invalid YAML frontmatter: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return asRecord(document.toJS(), `${filePath} frontmatter`);
}

function parseConsumes(value: unknown, context: string): StageConsume[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  return value.map((item, index) => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(item, itemContext);
    const unknownKeys = Object.keys(record).filter(
      (key) => !["artifact", "required", "conditional_on"].includes(key),
    );
    if (unknownKeys.length > 0) {
      fail(itemContext, `unknown field(s): ${unknownKeys.join(", ")}`);
    }
    if (typeof record.required !== "boolean") {
      fail(`${itemContext}.required`, "must be a boolean");
    }
    const consume: StageConsume = {
      artifact: asString(record.artifact, `${itemContext}.artifact`),
      required: record.required,
    };
    if (record.conditional_on !== undefined) {
      const conditional = asString(
        record.conditional_on,
        `${itemContext}.conditional_on`,
      );
      consume.conditional_on = assertAllowedValue(
        conditional,
        ["brownfield", "greenfield"] as const,
        `${itemContext}.conditional_on`,
      );
    }
    return consume;
  });
}

function parseProducesKinds(
  value: unknown,
  context: string,
): Record<string, string[]> {
  const record = asRecord(value, context);
  return Object.fromEntries(
    Object.entries(record).map(([artifact, kinds]) => [
      artifact,
      asStringArray(kinds, `${context}.${artifact}`),
    ]),
  );
}

export function parseStageFrontmatter(
  source: string,
  filePath: string,
  directoryPhase: Phase,
): StageFrontmatter {
  const record = parseYamlFrontmatter(source, filePath);
  const unknownKeys = Object.keys(record).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    fail(filePath, `unknown frontmatter field(s): ${unknownKeys.join(", ")}`);
  }

  const slug = asString(record.slug, `${filePath}.slug`);
  if (!SLUG_PATTERN.test(slug)) {
    fail(`${filePath}.slug`, "must use lowercase kebab-case");
  }
  if (basename(filePath, ".md") !== slug) {
    fail(filePath, `filename must match slug "${slug}"`);
  }

  const phase = assertAllowedValue(
    asString(record.phase, `${filePath}.phase`),
    PHASES,
    `${filePath}.phase`,
  );
  if (phase !== directoryPhase) {
    fail(`${filePath}.phase`, `must match directory phase "${directoryPhase}"`);
  }

  const execution = assertAllowedValue(
    asString(record.execution, `${filePath}.execution`),
    ["ALWAYS", "CONDITIONAL"] as const,
    `${filePath}.execution`,
  );
  const mode = assertAllowedValue(
    asString(record.mode, `${filePath}.mode`),
    ["inline", "subagent", "pipeline", "mob"] as const,
    `${filePath}.mode`,
  );

  const stage: StageFrontmatter = {
    slug,
    phase,
    execution,
    condition: asString(record.condition, `${filePath}.condition`),
    lead_agent: asString(record.lead_agent, `${filePath}.lead_agent`),
    support_agents: asStringArray(record.support_agents, `${filePath}.support_agents`),
    mode,
    produces: asStringArray(record.produces, `${filePath}.produces`),
    consumes: parseConsumes(record.consumes, `${filePath}.consumes`),
    requires_stage: asStringArray(record.requires_stage, `${filePath}.requires_stage`),
    sensors: asStringArray(record.sensors, `${filePath}.sensors`),
    scopes: asStringArray(record.scopes, `${filePath}.scopes`),
    inputs: asString(record.inputs, `${filePath}.inputs`),
    outputs: asString(record.outputs, `${filePath}.outputs`),
  };

  const optionalStrings = ["plugin", "reviewer", "for_each"] as const;
  for (const key of optionalStrings) {
    const value = asOptionalString(record, key, filePath);
    if (value !== undefined) stage[key] = value;
  }

  if (record.reviewer_max_iterations !== undefined) {
    if (
      typeof record.reviewer_max_iterations !== "number" ||
      !Number.isInteger(record.reviewer_max_iterations) ||
      record.reviewer_max_iterations < 1
    ) {
      fail(`${filePath}.reviewer_max_iterations`, "must be a positive integer");
    }
    stage.reviewer_max_iterations = record.reviewer_max_iterations;
  }
  if (record.workspace_requires !== undefined) {
    if (typeof record.workspace_requires !== "boolean") {
      fail(`${filePath}.workspace_requires`, "must be a boolean");
    }
    stage.workspace_requires = record.workspace_requires;
  }
  if (record.optional_produces !== undefined) {
    stage.optional_produces = asStringArray(
      record.optional_produces,
      `${filePath}.optional_produces`,
    );
  }
  if (record.produces_kinds !== undefined) {
    stage.produces_kinds = parseProducesKinds(
      record.produces_kinds,
      `${filePath}.produces_kinds`,
    );
  }

  return stage;
}

export function loadStageCatalog(catalogPath = DEFAULT_CATALOG_PATH): StageCatalogEntry[] {
  const absolutePath = resolve(catalogPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(absolutePath, `cannot read catalog: ${message}`);
  }
  if (!Array.isArray(parsed)) fail(absolutePath, "catalog root must be an array");

  const slugs = new Set<string>();
  const numbers = new Set<string>();
  return parsed.map((item, index) => {
    const context = `${absolutePath}[${index}]`;
    const record = asRecord(item, context);
    const unknownKeys = Object.keys(record).filter(
      (key) => !["slug", "number", "name"].includes(key),
    );
    if (unknownKeys.length > 0) {
      fail(context, `unknown field(s): ${unknownKeys.join(", ")}`);
    }
    const entry: StageCatalogEntry = {
      slug: asString(record.slug, `${context}.slug`),
      number: asString(record.number, `${context}.number`),
      name: asString(record.name, `${context}.name`),
    };
    if (!SLUG_PATTERN.test(entry.slug)) {
      fail(`${context}.slug`, "must use lowercase kebab-case");
    }
    if (!NUMBER_PATTERN.test(entry.number)) {
      fail(`${context}.number`, "must use <phase>.<index> format");
    }
    if (slugs.has(entry.slug)) fail(context, `duplicate slug "${entry.slug}"`);
    if (numbers.has(entry.number)) fail(context, `duplicate number "${entry.number}"`);
    slugs.add(entry.slug);
    numbers.add(entry.number);
    return entry;
  });
}

function phaseDirectories(stagesDir: string): Array<{ name: Phase; path: string }> {
  if (!existsSync(stagesDir) || !statSync(stagesDir).isDirectory()) {
    fail(stagesDir, "stages directory does not exist");
  }
  const directories = readdirSync(stagesDir)
    .filter((entry) => statSync(join(stagesDir, entry)).isDirectory())
    .sort();
  const unknown = directories.filter(
    (entry) => !(PHASES as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    fail(stagesDir, `unknown phase director${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}`);
  }
  return directories.map((name) => ({
    name: name as Phase,
    path: join(stagesDir, name),
  }));
}

export function loadStageDefinitions(stagesDir = DEFAULT_STAGES_DIR): Array<{
  definition: StageFrontmatter;
  sourcePath: string;
}> {
  const absoluteDir = resolve(stagesDir);
  const loaded: Array<{ definition: StageFrontmatter; sourcePath: string }> = [];
  const seen = new Map<string, string>();

  for (const phase of phaseDirectories(absoluteDir)) {
    const files = readdirSync(phase.path)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    for (const file of files) {
      const sourcePath = join(phase.path, file);
      const definition = parseStageFrontmatter(
        readFileSync(sourcePath, "utf8"),
        sourcePath,
        phase.name,
      );
      const previous = seen.get(definition.slug);
      if (previous !== undefined) {
        fail(sourcePath, `duplicate slug "${definition.slug}"; already defined in ${previous}`);
      }
      seen.set(definition.slug, sourcePath);
      loaded.push({ definition, sourcePath });
    }
  }
  return loaded;
}

function numericStageOrder(a: string, b: string): number {
  const [aPhase = 0, aIndex = 0] = a.split(".").map(Number);
  const [bPhase = 0, bIndex = 0] = b.split(".").map(Number);
  return aPhase - bPhase || aIndex - bIndex;
}

export function loadStages(options: LoadStagesOptions = {}): LoadedStage[] {
  const catalog = loadStageCatalog(options.catalogPath ?? DEFAULT_CATALOG_PATH);
  const definitions = loadStageDefinitions(options.stagesDir ?? DEFAULT_STAGES_DIR);
  const catalogBySlug = new Map(catalog.map((entry) => [entry.slug, entry]));
  const definitionsBySlug = new Map(
    definitions.map((entry) => [entry.definition.slug, entry]),
  );
  const missingFromCatalog = [...definitionsBySlug.keys()]
    .filter((slug) => !catalogBySlug.has(slug))
    .sort();
  const missingStageFiles = [...catalogBySlug.keys()]
    .filter((slug) => !definitionsBySlug.has(slug))
    .sort();
  if (missingFromCatalog.length > 0 || missingStageFiles.length > 0) {
    const details = [
      missingFromCatalog.length > 0
        ? `missing from catalog: ${missingFromCatalog.join(", ")}`
        : "",
      missingStageFiles.length > 0
        ? `missing stage files: ${missingStageFiles.join(", ")}`
        : "",
    ].filter(Boolean);
    fail("stage/catalog consistency", details.join("; "));
  }

  return catalog
    .map((catalogEntry) => {
      const loaded = definitionsBySlug.get(catalogEntry.slug);
      if (loaded === undefined) {
        fail("stage/catalog consistency", `missing stage file: ${catalogEntry.slug}`);
      }
      const expectedPhasePrefix = String(PHASES.indexOf(loaded.definition.phase));
      const actualPhasePrefix = catalogEntry.number.split(".")[0];
      if (actualPhasePrefix !== expectedPhasePrefix) {
        fail(
          catalogEntry.slug,
          `catalog number ${catalogEntry.number} does not match phase ${loaded.definition.phase}`,
        );
      }
      return {
        ...loaded.definition,
        number: catalogEntry.number,
        name: catalogEntry.name,
        sourcePath: loaded.sourcePath,
      };
    })
    .sort((a, b) => numericStageOrder(a.number, b.number));
}

function runCli(): void {
  const command = process.argv[2];
  if (command !== "check") {
    console.error("Usage: aidlc-stage-loader check");
    process.exitCode = 1;
    return;
  }
  try {
    const stages = loadStages();
    console.log(`Loaded and validated ${stages.length} stages.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
