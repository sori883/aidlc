import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import {
  type LoadedStage,
  loadStages,
} from "./aidlc-stage-loader.ts";

export type RuleScope = "org" | "team" | "project" | "phase";

export interface RuleFrontmatter {
  pairing?: string;
}

export interface RuleDefinition {
  path: string;
  scope: RuleScope;
  phase?: string;
  frontmatter: RuleFrontmatter;
  headings: Map<string, string>;
  sourcePath: string;
}

export interface RuleResolution {
  path: string;
  scope: RuleScope;
}

const DEFAULT_MEMORY_DIR = resolve("core/memory");
const DEFAULT_DISPLAY_ROOT = "aidlc/spaces/default/memory";
const BASE_RULE_PATTERN = /^(org|team|project)\.md$/;
const PHASE_RULE_PATTERN = /^([a-z][a-z0-9-]*)\.md$/;
const SCOPE_PRIORITY: Record<RuleScope, number> = {
  org: 0,
  team: 1,
  project: 2,
  phase: 3,
};

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "frontmatter must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseRuleFrontmatter(
  source: string,
  sourcePath: string,
): RuleFrontmatter {
  const normalized = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};

  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0) {
    fail(
      sourcePath,
      `invalid YAML frontmatter: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const record = asRecord(document.toJS(), sourcePath);
  if (record.pairing === undefined) return {};
  if (typeof record.pairing !== "string" || record.pairing.length === 0) {
    fail(sourcePath, "pairing must be a non-empty string");
  }
  if (
    record.pairing !== "feedforward-only" &&
    !record.pairing.startsWith("aidlc-")
  ) {
    fail(
      sourcePath,
      `pairing must be "feedforward-only" or start with "aidlc-"; got "${record.pairing}"`,
    );
  }
  return { pairing: record.pairing };
}

export function parseRuleHeadings(source: string): Map<string, string> {
  const headings = new Map<string, string>();
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  let current: string | undefined;
  let inFence = false;
  let inComment = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--") && !trimmed.includes("-->")) {
      inComment = true;
      continue;
    }
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!headings.has(current)) headings.set(current, "");
      continue;
    }
    if (current === undefined || trimmed === "") continue;
    if (trimmed.startsWith(">")) continue;
    if (/^<!--.*-->\s*$/.test(trimmed)) continue;
    const previous = headings.get(current) ?? "";
    headings.set(current, previous === "" ? trimmed : `${previous}\n${trimmed}`);
  }
  return headings;
}

export function loadRules(
  memoryDir = DEFAULT_MEMORY_DIR,
  displayRoot = DEFAULT_DISPLAY_ROOT,
): RuleDefinition[] {
  const absoluteDir = resolve(memoryDir);
  if (!existsSync(absoluteDir)) return [];

  const candidates: Array<{
    relativePath: string;
    sourcePath: string;
    scope: RuleScope;
    phase?: string;
  }> = [];

  for (const filename of readdirSync(absoluteDir)) {
    const match = filename.match(BASE_RULE_PATTERN);
    if (!match?.[1]) continue;
    const scope = match[1] as Exclude<RuleScope, "phase">;
    candidates.push({
      relativePath: filename,
      sourcePath: join(absoluteDir, filename),
      scope,
    });
  }

  const phasesDir = join(absoluteDir, "phases");
  if (existsSync(phasesDir)) {
    for (const filename of readdirSync(phasesDir)) {
      const match = filename.match(PHASE_RULE_PATTERN);
      if (!match?.[1]) continue;
      candidates.push({
        relativePath: posix.join("phases", filename),
        sourcePath: join(phasesDir, filename),
        scope: "phase",
        phase: match[1],
      });
    }
  }

  const rules = candidates.map((candidate): RuleDefinition => {
    const source = readFileSync(candidate.sourcePath, "utf8");
    const rule: RuleDefinition = {
      path: posix.join(displayRoot, candidate.relativePath),
      scope: candidate.scope,
      frontmatter: parseRuleFrontmatter(source, candidate.sourcePath),
      headings: parseRuleHeadings(source),
      sourcePath: candidate.sourcePath,
    };
    if (candidate.phase !== undefined) rule.phase = candidate.phase;
    return rule;
  });

  return rules.sort((a, b) => {
    const priority = SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope];
    return priority || a.path.localeCompare(b.path);
  });
}

export function resolveRulesForStage(
  stage: Pick<LoadedStage, "phase">,
  rules: readonly RuleDefinition[],
): RuleResolution[] {
  const resolved: RuleResolution[] = [];
  for (const rule of rules) {
    if (
      rule.scope === "org" ||
      rule.scope === "team" ||
      rule.scope === "project" ||
      (rule.scope === "phase" && rule.phase === stage.phase)
    ) {
      resolved.push({ path: rule.path, scope: rule.scope });
    }
  }
  return resolved;
}

function runCli(): void {
  const command = process.argv[2];
  if (command !== "check") {
    console.error("Usage: aidlc-rule-loader check");
    process.exitCode = 1;
    return;
  }
  try {
    const rules = loadRules();
    const stages = loadStages();
    const links = stages.reduce(
      (total, stage) => total + resolveRulesForStage(stage, rules).length,
      0,
    );
    console.log(
      `Loaded ${rules.length} rules and resolved ${links} stage links.`,
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
