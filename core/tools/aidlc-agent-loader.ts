import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import {
  type LoadedStage,
  loadStages,
} from "./aidlc-stage-loader.ts";

export const AGENT_TIERS = ["judgment", "balanced", "templated"] as const;
export type AgentTier = (typeof AGENT_TIERS)[number];

export interface AgentDefinition {
  name: string;
  display_name: string;
  description: string;
  disallowedTools: string;
  tier: AgentTier;
  examples?: string[];
  instructions: string;
  sourcePath: string;
}

const DEFAULT_AGENTS_DIR = resolve("core/agents");
const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_KEYS = new Set([
  "name",
  "display_name",
  "examples",
  "description",
  "disallowedTools",
  "tier",
]);

export const RESERVED_AGENT_NAMES = new Set(["orchestrator"]);

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

function parseAgentMarkdown(source: string, sourcePath: string): AgentDefinition {
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
  if (!AGENT_NAME_PATTERN.test(name)) {
    fail(`${sourcePath}.name`, "must use lowercase kebab-case");
  }
  if (basename(sourcePath, ".md") !== name) {
    fail(sourcePath, `filename must match agent name "${name}"`);
  }

  const tier = asString(record.tier, `${sourcePath}.tier`);
  if (!(AGENT_TIERS as readonly string[]).includes(tier)) {
    fail(`${sourcePath}.tier`, `must be one of: ${AGENT_TIERS.join(", ")}`);
  }

  const instructions = (match[2] ?? "").trim();
  if (instructions === "") fail(sourcePath, "agent instructions must not be empty");

  const agent: AgentDefinition = {
    name,
    display_name: asString(record.display_name, `${sourcePath}.display_name`),
    description: asString(record.description, `${sourcePath}.description`),
    disallowedTools: asString(
      record.disallowedTools,
      `${sourcePath}.disallowedTools`,
    ),
    tier: tier as AgentTier,
    instructions,
    sourcePath,
  };
  if (record.examples !== undefined) {
    agent.examples = asStringArray(record.examples, `${sourcePath}.examples`);
  }
  return agent;
}

export function loadAgents(agentsDir = DEFAULT_AGENTS_DIR): AgentDefinition[] {
  const absoluteDir = resolve(agentsDir);
  if (!existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) {
    fail(absoluteDir, "agents directory does not exist");
  }

  const agents: AgentDefinition[] = [];
  const seen = new Map<string, string>();
  for (const filename of readdirSync(absoluteDir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()) {
    const sourcePath = join(absoluteDir, filename);
    const agent = parseAgentMarkdown(readFileSync(sourcePath, "utf8"), sourcePath);
    const previous = seen.get(agent.name);
    if (previous !== undefined) {
      fail(sourcePath, `duplicate agent name "${agent.name}"; already defined in ${previous}`);
    }
    seen.set(agent.name, sourcePath);
    agents.push(agent);
  }
  return agents;
}

export function validateStageAgentReferences(
  stages: readonly LoadedStage[],
  agents: readonly AgentDefinition[],
): void {
  const known = new Set(agents.map((agent) => agent.name));
  const validate = (stage: LoadedStage, field: string, name: string): void => {
    if (RESERVED_AGENT_NAMES.has(name) || known.has(name)) return;
    throw new Error(`${stage.slug}: unknown ${field} "${name}"`);
  };

  for (const stage of stages) {
    validate(stage, "lead_agent", stage.lead_agent);
    stage.support_agents.forEach((name, index) => {
      validate(stage, `support_agents[${index}]`, name);
    });
    if (stage.reviewer !== undefined) {
      validate(stage, "reviewer", stage.reviewer);
    }
  }
}

function runCli(): void {
  const command = process.argv[2];
  if (command !== "check") {
    console.error("Usage: aidlc-agent-loader check");
    process.exitCode = 1;
    return;
  }
  try {
    const agents = loadAgents();
    const stages = loadStages();
    validateStageAgentReferences(stages, agents);
    console.log(
      `Loaded ${agents.length} agents and validated ${stages.length} stage references.`,
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
