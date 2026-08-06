import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import {
  type LoadedStage,
  loadStages,
} from "./aidlc-stage-loader.ts";

export const SCOPE_DEPTHS = ["Minimal", "Standard", "Comprehensive"] as const;
export type ScopeDepth = (typeof SCOPE_DEPTHS)[number];

export interface ScopeDefinition {
  name: string;
  depth: ScopeDepth;
  keywords: string[];
  description: string;
  skeleton: boolean;
  runner?: boolean;
  testStrategy?: ScopeDepth;
  instructions: string;
  sourcePath: string;
}

export interface ScopeGridLike {
  [scope: string]: {
    stages: Record<string, "EXECUTE" | "SKIP">;
  };
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCOPES_DIR = resolve(MODULE_DIR, "../scopes");
const SCOPE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_KEYS = new Set([
  "name",
  "depth",
  "keywords",
  "description",
  "skeleton",
  "runner",
  "testStrategy",
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

function asDepth(value: unknown, context: string): ScopeDepth {
  const depth = asString(value, context);
  if (!(SCOPE_DEPTHS as readonly string[]).includes(depth)) {
    fail(context, `must be one of: ${SCOPE_DEPTHS.join(", ")}`);
  }
  return depth as ScopeDepth;
}

function asKeywords(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const keywords = value.map((item, index) =>
    asString(item, `${context}[${index}]`)
  );
  const normalized = new Set<string>();
  for (const keyword of keywords) {
    const key = keyword.trim().toLowerCase();
    if (normalized.has(key)) fail(context, `duplicate keyword "${keyword}"`);
    normalized.add(key);
  }
  return keywords;
}

function parseScopeMarkdown(source: string, sourcePath: string): ScopeDefinition {
  const match = source.match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match?.[1]) fail(sourcePath, "missing YAML frontmatter");

  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0) {
    fail(
      sourcePath,
      `invalid YAML frontmatter: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const record = asRecord(document.toJS(), `${sourcePath} frontmatter`);
  const unknownKeys = Object.keys(record).filter(
    (key) => !FRONTMATTER_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    fail(sourcePath, `unknown frontmatter field(s): ${unknownKeys.join(", ")}`);
  }

  const name = asString(record.name, `${sourcePath}.name`);
  if (!SCOPE_NAME_PATTERN.test(name)) {
    fail(`${sourcePath}.name`, "must use lowercase kebab-case");
  }
  if (basename(sourcePath) !== `aidlc-${name}.md`) {
    fail(sourcePath, `filename must be "aidlc-${name}.md"`);
  }
  if (record.skeleton !== "on" && record.skeleton !== "off") {
    fail(`${sourcePath}.skeleton`, "must be on or off");
  }
  if (record.runner !== undefined && typeof record.runner !== "boolean") {
    fail(`${sourcePath}.runner`, "must be a boolean");
  }

  const instructions = (match[2] ?? "").trim();
  if (instructions === "") fail(sourcePath, "scope instructions must not be empty");
  const scope: ScopeDefinition = {
    name,
    depth: asDepth(record.depth, `${sourcePath}.depth`),
    keywords: asKeywords(record.keywords, `${sourcePath}.keywords`),
    description: asString(record.description, `${sourcePath}.description`),
    skeleton: record.skeleton === "on",
    instructions,
    sourcePath,
  };
  if (record.runner !== undefined) scope.runner = record.runner;
  if (record.testStrategy !== undefined) {
    scope.testStrategy = asDepth(
      record.testStrategy,
      `${sourcePath}.testStrategy`,
    );
  }
  return scope;
}

export function loadScopes(scopesDir = DEFAULT_SCOPES_DIR): ScopeDefinition[] {
  const absoluteDir = resolve(scopesDir);
  if (!existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) {
    fail(absoluteDir, "scopes directory does not exist");
  }

  const scopes: ScopeDefinition[] = [];
  const names = new Map<string, string>();
  const keywords = new Map<string, string>();
  for (const filename of readdirSync(absoluteDir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()) {
    const sourcePath = join(absoluteDir, filename);
    const scope = parseScopeMarkdown(readFileSync(sourcePath, "utf8"), sourcePath);
    const previous = names.get(scope.name);
    if (previous !== undefined) {
      fail(sourcePath, `duplicate scope name "${scope.name}"; already defined in ${previous}`);
    }
    names.set(scope.name, sourcePath);
    for (const keyword of scope.keywords) {
      const normalized = keyword.trim().toLowerCase();
      const owner = keywords.get(normalized);
      if (owner !== undefined) {
        fail(
          sourcePath,
          `keyword "${keyword}" is already assigned to scope "${owner}"`,
        );
      }
      keywords.set(normalized, scope.name);
    }
    scopes.push(scope);
  }
  return scopes;
}

export function validateStageScopeReferences(
  stages: readonly LoadedStage[],
  scopes: readonly ScopeDefinition[],
): void {
  const known = new Set(scopes.map((scope) => scope.name));
  for (const stage of stages) {
    const seen = new Set<string>();
    stage.scopes.forEach((name, index) => {
      if (seen.has(name)) {
        throw new Error(`${stage.slug}: duplicate scopes entry "${name}"`);
      }
      seen.add(name);
      if (!known.has(name)) {
        throw new Error(`${stage.slug}: unknown scopes[${index}] "${name}"`);
      }
    });
  }
}

export function validateScopeGridDefinitions(
  scopeGrid: ScopeGridLike,
  scopes: readonly ScopeDefinition[],
): void {
  const gridNames = Object.keys(scopeGrid).sort();
  const definitionNames = scopes.map((scope) => scope.name).sort();
  const missingDefinitions = gridNames.filter(
    (name) => !definitionNames.includes(name),
  );
  const missingGridEntries = definitionNames.filter(
    (name) => !gridNames.includes(name),
  );
  if (missingDefinitions.length > 0 || missingGridEntries.length > 0) {
    const details = [
      missingDefinitions.length > 0
        ? `missing scope definitions: ${missingDefinitions.join(", ")}`
        : "",
      missingGridEntries.length > 0
        ? `missing scope-grid entries: ${missingGridEntries.join(", ")}`
        : "",
    ].filter(Boolean);
    throw new Error(`scope consistency: ${details.join("; ")}`);
  }
}

function runCli(): void {
  const command = process.argv[2];
  if (command !== "check") {
    console.error("Usage: aidlc-scope-loader check");
    process.exitCode = 1;
    return;
  }
  try {
    const scopes = loadScopes();
    const stages = loadStages();
    validateStageScopeReferences(stages, scopes);
    console.log(
      `Loaded ${scopes.length} scopes and validated ${stages.length} stage references.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
