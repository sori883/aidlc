import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";
import {
  VNEXT_STAGE_IDS,
  type VNextStageId,
} from "./aidlc-stage-contract.ts";

export const VNEXT_DELEGATION_SCHEMA_VERSION = 1 as const;
export const DELEGATION_TOPOLOGIES = ["subagent", "pipeline", "mob"] as const;
export const DELEGATION_MUTATION_SCOPES = [
  "proposal-only",
  "assigned-worktree",
  "read-only",
] as const;

export type DelegationTopology = (typeof DELEGATION_TOPOLOGIES)[number];
export type DelegationMutationScope =
  (typeof DELEGATION_MUTATION_SCOPES)[number];

export interface StageAgentAssignment {
  topology: DelegationTopology;
  lead_agent: string;
  support_agents: string[];
  reviewer_agent: string | null;
  reviewer_max_iterations: number;
  required_skills: string[];
  optional_skill_policy: "task-matched";
  mutation_scope: DelegationMutationScope;
  nested_delegation: false;
}

export interface VNextStageDelegation {
  stage_id: VNextStageId;
  work_assignment: StageAgentAssignment | null;
  review_assignment: StageAgentAssignment | null;
}

export interface VNextDelegationCatalog {
  schema_version: typeof VNEXT_DELEGATION_SCHEMA_VERSION;
  catalog_version: string;
  stages: VNextStageDelegation[];
}

export interface VNextDelegationCatalogOptions {
  catalogPath?: string;
}

const DEFAULT_CATALOG_PATH = resolve(
  runtimeCoreDir(),
  "aidlc-common/data/vnext-stage-delegation.json",
);
const AGENT_PATTERN = /^aidlc-[a-z0-9]+(?:-[a-z0-9]+)*-agent$/;
const SKILL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_WORK_STAGES = new Set<VNextStageId>([
  "ST-01",
  "ST-02",
  "ST-03",
  "ST-04",
  "ST-05",
  "ST-06",
  "ST-08",
  "ST-09",
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

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}

function asOneLine(value: unknown, context: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value !== value.trim() ||
    /[\r\n\0]/.test(value)
  ) {
    fail(context, "must be a non-empty single-line string");
  }
  return value;
}

function asAllowed<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  const text = asOneLine(value, context);
  if (!(allowed as readonly string[]).includes(text)) {
    fail(context, `must be one of: ${allowed.join(", ")}`);
  }
  return text as T;
}

function asSlugArray(
  value: unknown,
  pattern: RegExp,
  context: string,
): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const entries = value.map((item, index) => {
    const text = asOneLine(item, `${context}[${index}]`);
    if (!pattern.test(text)) fail(`${context}[${index}]`, "has an invalid format");
    return text;
  });
  const duplicate = entries.find((entry, index) => entries.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate value: ${duplicate}`);
  return entries;
}

function parseAssignment(
  value: unknown,
  context: string,
): StageAgentAssignment | null {
  if (value === null) return null;
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "topology",
      "lead_agent",
      "support_agents",
      "reviewer_agent",
      "reviewer_max_iterations",
      "required_skills",
      "optional_skill_policy",
      "mutation_scope",
      "nested_delegation",
    ],
    context,
  );
  const topology = asAllowed(record.topology, DELEGATION_TOPOLOGIES, `${context}.topology`);
  const leadAgent = asOneLine(record.lead_agent, `${context}.lead_agent`);
  if (!AGENT_PATTERN.test(leadAgent)) fail(`${context}.lead_agent`, "has an invalid format");
  const supportAgents = asSlugArray(
    record.support_agents,
    AGENT_PATTERN,
    `${context}.support_agents`,
  );
  let reviewerAgent: string | null = null;
  if (record.reviewer_agent !== null) {
    reviewerAgent = asOneLine(record.reviewer_agent, `${context}.reviewer_agent`);
    if (!AGENT_PATTERN.test(reviewerAgent)) {
      fail(`${context}.reviewer_agent`, "has an invalid format");
    }
  }
  if (
    !Number.isInteger(record.reviewer_max_iterations) ||
    (record.reviewer_max_iterations as number) < 0 ||
    (record.reviewer_max_iterations as number) > 3
  ) {
    fail(`${context}.reviewer_max_iterations`, "must be an integer from 0 through 3");
  }
  const reviewerMaxIterations = record.reviewer_max_iterations as number;
  if (
    (reviewerAgent === null && reviewerMaxIterations !== 0) ||
    (reviewerAgent !== null && reviewerMaxIterations < 1)
  ) {
    fail(
      `${context}.reviewer_max_iterations`,
      "must be zero without a reviewer and positive with a reviewer",
    );
  }
  const participants = [leadAgent, ...supportAgents, ...(reviewerAgent === null ? [] : [reviewerAgent])];
  const duplicateParticipant = participants.find((entry, index) =>
    participants.indexOf(entry) !== index
  );
  if (duplicateParticipant !== undefined) {
    fail(context, `contains duplicate participant: ${duplicateParticipant}`);
  }
  if ((topology === "pipeline" || topology === "mob") && supportAgents.length === 0) {
    fail(`${context}.support_agents`, `${topology} requires at least one support agent`);
  }
  const requiredSkills = asSlugArray(
    record.required_skills,
    SKILL_PATTERN,
    `${context}.required_skills`,
  );
  if (!requiredSkills.includes("aidlc-stage-work")) {
    fail(`${context}.required_skills`, "must include aidlc-stage-work");
  }
  if (record.optional_skill_policy !== "task-matched") {
    fail(`${context}.optional_skill_policy`, "must equal task-matched");
  }
  if (record.nested_delegation !== false) {
    fail(`${context}.nested_delegation`, "must be false");
  }
  return {
    topology,
    lead_agent: leadAgent,
    support_agents: supportAgents,
    reviewer_agent: reviewerAgent,
    reviewer_max_iterations: reviewerMaxIterations,
    required_skills: requiredSkills,
    optional_skill_policy: "task-matched",
    mutation_scope: asAllowed(
      record.mutation_scope,
      DELEGATION_MUTATION_SCOPES,
      `${context}.mutation_scope`,
    ),
    nested_delegation: false,
  };
}

function validateStageCoverage(stages: VNextStageDelegation[], context: string): void {
  if (stages.length !== VNEXT_STAGE_IDS.length) {
    fail(`${context}.stages`, `must contain exactly ${VNEXT_STAGE_IDS.length} entries`);
  }
  for (const [index, expected] of VNEXT_STAGE_IDS.entries()) {
    const stage = stages[index];
    if (stage?.stage_id !== expected) {
      fail(`${context}.stages[${index}].stage_id`, `must equal ${expected}`);
    }
    if (expected === "ST-00") {
      if (stage.work_assignment !== null || stage.review_assignment !== null) {
        fail(`${context}.stages[${index}]`, "ST-00 is Core-owned and cannot delegate");
      }
      continue;
    }
    if (REQUIRED_WORK_STAGES.has(expected) && stage.work_assignment === null) {
      fail(`${context}.stages[${index}].work_assignment`, "must delegate AI work");
    }
    if (expected === "ST-07" && stage.work_assignment !== null) {
      fail(`${context}.stages[${index}].work_assignment`, "ST-07 has review work only");
    }
    if (expected === "ST-07" && stage.review_assignment === null) {
      fail(`${context}.stages[${index}].review_assignment`, "must delegate independent review");
    }
    if (stage.review_assignment?.mutation_scope !== undefined && stage.review_assignment.mutation_scope !== "read-only") {
      fail(`${context}.stages[${index}].review_assignment.mutation_scope`, "must be read-only");
    }
    if (stage.work_assignment !== null) {
      const expectedScope = expected === "ST-06" ? "assigned-worktree" : "proposal-only";
      if (stage.work_assignment.mutation_scope !== expectedScope) {
        fail(
          `${context}.stages[${index}].work_assignment.mutation_scope`,
          `must equal ${expectedScope}`,
        );
      }
    }
  }
}

export function parseVNextDelegationCatalog(
  value: unknown,
  context = "vNext Delegation Catalog",
): VNextDelegationCatalog {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["schema_version", "catalog_version", "stages"], context);
  if (record.schema_version !== VNEXT_DELEGATION_SCHEMA_VERSION) {
    fail(`${context}.schema_version`, `must equal ${VNEXT_DELEGATION_SCHEMA_VERSION}`);
  }
  const catalogVersion = asOneLine(record.catalog_version, `${context}.catalog_version`);
  if (!Array.isArray(record.stages)) fail(`${context}.stages`, "must be an array");
  const stages = record.stages.map((item, index) => {
    const itemContext = `${context}.stages[${index}]`;
    const stage = asRecord(item, itemContext);
    rejectUnknownKeys(stage, ["stage_id", "work_assignment", "review_assignment"], itemContext);
    return {
      stage_id: asAllowed(stage.stage_id, VNEXT_STAGE_IDS, `${itemContext}.stage_id`),
      work_assignment: parseAssignment(stage.work_assignment, `${itemContext}.work_assignment`),
      review_assignment: parseAssignment(stage.review_assignment, `${itemContext}.review_assignment`),
    };
  });
  validateStageCoverage(stages, context);
  return {
    schema_version: VNEXT_DELEGATION_SCHEMA_VERSION,
    catalog_version: catalogVersion,
    stages,
  };
}

export function loadVNextDelegationCatalog(
  options: VNextDelegationCatalogOptions = {},
): VNextDelegationCatalog {
  const path = resolve(options.catalogPath ?? DEFAULT_CATALOG_PATH);
  try {
    return parseVNextDelegationCatalog(
      JSON.parse(readFileSync(path, "utf8")),
      `vNext Delegation Catalog ${path}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("vNext Delegation Catalog")) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    fail("vNext Delegation Catalog", `cannot read ${path}: ${detail}`);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function main(argv: string[]): void {
  const [command, stageArg, assignmentArg, ...rest] = argv;
  const catalog = loadVNextDelegationCatalog();
  if (command === "validate") {
    if (stageArg !== undefined) fail("Delegation CLI", "validate does not accept arguments");
    writeJson({
      valid: true,
      schema_version: catalog.schema_version,
      catalog_version: catalog.catalog_version,
      stage_count: catalog.stages.length,
    });
    return;
  }
  if (command === "show") {
    if (stageArg === undefined || rest.length > 0) {
      fail("Delegation CLI", "usage: delegation show <ST-00..ST-09> [work|review]");
    }
    const stageId = asAllowed(stageArg, VNEXT_STAGE_IDS, "Delegation CLI stage");
    const stage = catalog.stages.find((candidate) => candidate.stage_id === stageId)!;
    if (assignmentArg === undefined) {
      writeJson(stage);
      return;
    }
    if (assignmentArg === "work") {
      writeJson(stage.work_assignment);
      return;
    }
    if (assignmentArg === "review") {
      writeJson(stage.review_assignment);
      return;
    }
    fail("Delegation CLI assignment", "must be work or review");
  }
  fail("Delegation CLI", "usage: delegation <validate|show>");
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
