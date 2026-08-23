import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";
import {
  parseStageDispositionProposal,
  parseStageExecutionPlan,
  parseVNextStageContract,
  STAGE_CONTRACT_SCHEMA_VERSION,
  VNEXT_STAGE_IDS,
  type ArtifactReference,
  type CoreStageDecision,
  type StageDispositionProposal,
  type StageExecutionPlan,
  type VNextStageContract,
  type VNextStageId,
} from "./aidlc-stage-contract.ts";
import { verifyProjectArtifactReference } from "./aidlc-effective-policy.ts";

export const VNEXT_CATALOG_SCHEMA_VERSION = 1 as const;
export const VNEXT_GRAPH_SCHEMA_VERSION = 1 as const;

export const VNEXT_FEEDBACK_REASONS = [
  "requirements_changed",
  "architecture_impact",
  "build_contract_impact",
  "candidate_defect",
] as const;

export type VNextFeedbackReason = (typeof VNEXT_FEEDBACK_REASONS)[number];

export interface VNextStageCatalogEntry {
  stage_id: VNextStageId;
  name: string;
}

export interface VNextStageCatalog {
  schema_version: typeof VNEXT_CATALOG_SCHEMA_VERSION;
  catalog_version: string;
  stages: VNextStageCatalogEntry[];
}

export interface VNextForwardEdge {
  from: VNextStageId;
  to: VNextStageId;
}

export interface VNextFeedbackEdge extends VNextForwardEdge {
  reason: VNextFeedbackReason;
}

export interface VNextStageGraph {
  schema_version: typeof VNEXT_GRAPH_SCHEMA_VERSION;
  graph_version: string;
  catalog_version: string;
  entry_stage: "ST-00";
  terminal_stage: "ST-09";
  forward_edges: VNextForwardEdge[];
  feedback_edges: VNextFeedbackEdge[];
}

export interface VNextDefinitionOptions {
  catalogPath?: string;
  graphPath?: string;
}

export interface VNextDefinitions {
  catalog: VNextStageCatalog;
  graph: VNextStageGraph;
  catalogPath: string;
  graphPath: string;
}

export interface CoreRouteRequest {
  from: VNextStageId;
  to: VNextStageId;
  feedback_reason?: VNextFeedbackReason;
}

export interface ReviseStageExecutionPlanOptions {
  projectDir: string;
  stageContracts?: readonly VNextStageContract[];
}

const DEFAULT_CATALOG_PATH = resolve(
  runtimeCoreDir(),
  "aidlc-common/data/vnext-stage-catalog.json",
);
const DEFAULT_GRAPH_PATH = resolve(
  runtimeCoreDir(),
  "aidlc-common/data/vnext-stage-graph.json",
);

const CATALOG_KEYS = ["schema_version", "catalog_version", "stages"] as const;
const GRAPH_KEYS = [
  "schema_version",
  "graph_version",
  "catalog_version",
  "entry_stage",
  "terminal_stage",
  "forward_edges",
  "feedback_edges",
] as const;

const EXPECTED_FORWARD_EDGES: readonly VNextForwardEdge[] = VNEXT_STAGE_IDS
  .slice(0, -1)
  .map((from, index) => ({
    from,
    to: VNEXT_STAGE_IDS[index + 1]!,
  }));

const EXPECTED_FEEDBACK_EDGES: readonly VNextFeedbackEdge[] = [
  { from: "ST-07", to: "ST-03", reason: "requirements_changed" },
  { from: "ST-07", to: "ST-04", reason: "architecture_impact" },
  { from: "ST-07", to: "ST-05", reason: "build_contract_impact" },
  { from: "ST-07", to: "ST-06", reason: "candidate_defect" },
];

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

function asStageId(value: unknown, context: string): VNextStageId {
  const stageId = asOneLine(value, context);
  if (!(VNEXT_STAGE_IDS as readonly string[]).includes(stageId)) {
    fail(context, `must be one of: ${VNEXT_STAGE_IDS.join(", ")}`);
  }
  return stageId as VNextStageId;
}

function asFeedbackReason(value: unknown, context: string): VNextFeedbackReason {
  const reason = asOneLine(value, context);
  if (!(VNEXT_FEEDBACK_REASONS as readonly string[]).includes(reason)) {
    fail(context, `must be one of: ${VNEXT_FEEDBACK_REASONS.join(", ")}`);
  }
  return reason as VNextFeedbackReason;
}

function readJson(path: string, context: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(context, `cannot read ${path}: ${detail}`);
  }
}

function edgeIdentity(edge: VNextForwardEdge): string {
  return `${edge.from}->${edge.to}`;
}

function feedbackIdentity(edge: VNextFeedbackEdge): string {
  return `${edgeIdentity(edge)}:${edge.reason}`;
}

function requireExactEdges<T>(
  actual: readonly T[],
  expected: readonly T[],
  identity: (value: T) => string,
  context: string,
): void {
  if (actual.length !== expected.length) {
    fail(context, `must contain exactly ${expected.length} edge(s)`);
  }
  for (const [index, expectedEdge] of expected.entries()) {
    const actualEdge = actual[index];
    if (actualEdge === undefined || identity(actualEdge) !== identity(expectedEdge)) {
      fail(
        `${context}[${index}]`,
        `must equal ${identity(expectedEdge)}; fixed Route cannot be changed`,
      );
    }
  }
}

export function parseVNextStageCatalog(
  value: unknown,
  context = "vNext Stage Catalog",
): VNextStageCatalog {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, CATALOG_KEYS, context);
  if (record.schema_version !== VNEXT_CATALOG_SCHEMA_VERSION) {
    fail(`${context}.schema_version`, `must equal ${VNEXT_CATALOG_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(record.stages)) fail(`${context}.stages`, "must be an array");
  const stages = record.stages.map((entry, index): VNextStageCatalogEntry => {
    const itemContext = `${context}.stages[${index}]`;
    const item = asRecord(entry, itemContext);
    rejectUnknownKeys(item, ["stage_id", "name"], itemContext);
    return {
      stage_id: asStageId(item.stage_id, `${itemContext}.stage_id`),
      name: asOneLine(item.name, `${itemContext}.name`),
    };
  });
  if (stages.length !== VNEXT_STAGE_IDS.length) {
    fail(`${context}.stages`, `must contain exactly ${VNEXT_STAGE_IDS.length} stages`);
  }
  for (const [index, expected] of VNEXT_STAGE_IDS.entries()) {
    if (stages[index]?.stage_id !== expected) {
      fail(
        `${context}.stages[${index}].stage_id`,
        `must equal ${expected}; fixed Stage order cannot be changed`,
      );
    }
  }
  const names = stages.map((stage) => stage.name);
  const duplicateName = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicateName !== undefined) {
    fail(`${context}.stages`, `contains duplicate name: ${duplicateName}`);
  }
  return {
    schema_version: VNEXT_CATALOG_SCHEMA_VERSION,
    catalog_version: asOneLine(
      record.catalog_version,
      `${context}.catalog_version`,
    ),
    stages,
  };
}

export function parseVNextStageGraph(
  value: unknown,
  context = "vNext Stage Graph",
): VNextStageGraph {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, GRAPH_KEYS, context);
  if (record.schema_version !== VNEXT_GRAPH_SCHEMA_VERSION) {
    fail(`${context}.schema_version`, `must equal ${VNEXT_GRAPH_SCHEMA_VERSION}`);
  }
  if (record.entry_stage !== "ST-00") {
    fail(`${context}.entry_stage`, "must equal ST-00");
  }
  if (record.terminal_stage !== "ST-09") {
    fail(`${context}.terminal_stage`, "must equal ST-09");
  }
  if (!Array.isArray(record.forward_edges)) {
    fail(`${context}.forward_edges`, "must be an array");
  }
  if (!Array.isArray(record.feedback_edges)) {
    fail(`${context}.feedback_edges`, "must be an array");
  }
  const forwardEdges = record.forward_edges.map((entry, index): VNextForwardEdge => {
    const edgeContext = `${context}.forward_edges[${index}]`;
    const edge = asRecord(entry, edgeContext);
    rejectUnknownKeys(edge, ["from", "to"], edgeContext);
    return {
      from: asStageId(edge.from, `${edgeContext}.from`),
      to: asStageId(edge.to, `${edgeContext}.to`),
    };
  });
  const feedbackEdges = record.feedback_edges.map(
    (entry, index): VNextFeedbackEdge => {
      const edgeContext = `${context}.feedback_edges[${index}]`;
      const edge = asRecord(entry, edgeContext);
      rejectUnknownKeys(edge, ["from", "to", "reason"], edgeContext);
      return {
        from: asStageId(edge.from, `${edgeContext}.from`),
        to: asStageId(edge.to, `${edgeContext}.to`),
        reason: asFeedbackReason(edge.reason, `${edgeContext}.reason`),
      };
    },
  );
  requireExactEdges(
    forwardEdges,
    EXPECTED_FORWARD_EDGES,
    edgeIdentity,
    `${context}.forward_edges`,
  );
  requireExactEdges(
    feedbackEdges,
    EXPECTED_FEEDBACK_EDGES,
    feedbackIdentity,
    `${context}.feedback_edges`,
  );
  return {
    schema_version: VNEXT_GRAPH_SCHEMA_VERSION,
    graph_version: asOneLine(record.graph_version, `${context}.graph_version`),
    catalog_version: asOneLine(
      record.catalog_version,
      `${context}.catalog_version`,
    ),
    entry_stage: "ST-00",
    terminal_stage: "ST-09",
    forward_edges: forwardEdges,
    feedback_edges: feedbackEdges,
  };
}

export function loadVNextDefinitions(
  options: VNextDefinitionOptions = {},
): VNextDefinitions {
  const catalogPath = resolve(options.catalogPath ?? DEFAULT_CATALOG_PATH);
  const graphPath = resolve(options.graphPath ?? DEFAULT_GRAPH_PATH);
  const catalog = parseVNextStageCatalog(
    readJson(catalogPath, "vNext Stage Catalog"),
    `vNext Stage Catalog (${catalogPath})`,
  );
  const graph = parseVNextStageGraph(
    readJson(graphPath, "vNext Stage Graph"),
    `vNext Stage Graph (${graphPath})`,
  );
  if (graph.catalog_version !== catalog.catalog_version) {
    fail(
      "vNext definitions",
      `Graph catalog_version ${graph.catalog_version} does not match ` +
        `Catalog ${catalog.catalog_version}`,
    );
  }
  return { catalog, graph, catalogPath, graphPath };
}

export function nextForwardStage(
  graph: VNextStageGraph,
  current: VNextStageId,
): VNextStageId | null {
  return graph.forward_edges.find((edge) => edge.from === current)?.to ?? null;
}

export function validateCoreRoute(
  graph: VNextStageGraph,
  request: CoreRouteRequest,
): void {
  const forward = graph.forward_edges.find(
    (edge) => edge.from === request.from && edge.to === request.to,
  );
  if (forward !== undefined) {
    if (request.feedback_reason !== undefined) {
      fail("Core Route", "forward transition must not include feedback_reason");
    }
    return;
  }
  const feedback = graph.feedback_edges.find(
    (edge) =>
      edge.from === request.from && edge.to === request.to &&
      edge.reason === request.feedback_reason,
  );
  if (feedback !== undefined) return;
  fail(
    "Core Route",
    `transition ${request.from}->${request.to} is not allowed by ` +
      `${graph.graph_version}`,
  );
}

export function allowedFeedbackTargets(
  graph: VNextStageGraph,
): Array<{ stage_id: VNextStageId; reason: VNextFeedbackReason }> {
  return graph.feedback_edges.map((edge) => ({
    stage_id: edge.to,
    reason: edge.reason,
  }));
}

function decisionId(stageId: VNextStageId, revision: number): string {
  return `core-${stageId.toLowerCase()}-r${revision}`;
}

export function createInitialStageExecutionPlan(
  intentId: string,
  graphVersion: string,
  policySnapshot: ArtifactReference,
): StageExecutionPlan {
  const stageDecisions = VNEXT_STAGE_IDS.map(
    (stageId): CoreStageDecision => ({
      schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
      decision_id: decisionId(stageId, 1),
      stage_id: stageId,
      disposition: "execute",
      reason: "Core safe default: no verified basis exists to shorten this Stage.",
      evidence: [],
      decision_authority: "core",
    }),
  );
  return parseStageExecutionPlan({
    schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
    intent_id: intentId,
    revision: 1,
    graph_version: graphVersion,
    policy_snapshot: policySnapshot,
    stage_decisions: stageDecisions,
  });
}

function contractMap(
  contracts: readonly VNextStageContract[],
): Map<VNextStageId, VNextStageContract> {
  const parsed = contracts.map((contract, index) =>
    parseVNextStageContract(contract, `Stage Contract[${index}]`)
  );
  const map = new Map<VNextStageId, VNextStageContract>();
  for (const contract of parsed) {
    if (map.has(contract.stage_id)) {
      fail("Stage Contracts", `duplicate stage_id: ${contract.stage_id}`);
    }
    map.set(contract.stage_id, contract);
  }
  return map;
}

function verifyProposalEvidence(
  projectDir: string,
  proposal: StageDispositionProposal,
): void {
  for (const evidence of proposal.evidence) {
    verifyProjectArtifactReference(projectDir, evidence);
  }
}

function validateProposalDecisionRule(
  proposal: StageDispositionProposal,
  contract: VNextStageContract | undefined,
): void {
  if (proposal.disposition === "execute") return;
  if (proposal.stage_id === "ST-00" && proposal.disposition === "not_applicable") {
    fail("Core decision ST-00", "ST-00 cannot be not_applicable");
  }
  if (contract === undefined) {
    fail(
      `Core decision ${proposal.stage_id}`,
      `${proposal.disposition} requires an implemented Stage Contract`,
    );
  }
  if (proposal.disposition === "reuse") {
    const declaredArtifacts = new Set([
      ...contract.inputs.map((input) => input.artifact),
      ...contract.outputs,
    ]);
    const unknownEvidence = proposal.evidence.find(
      (evidence) => !declaredArtifacts.has(evidence.artifact),
    );
    if (unknownEvidence !== undefined) {
      fail(
        `Core decision ${proposal.stage_id}`,
        `reuse Evidence ${unknownEvidence.artifact} is not declared by the Stage Contract`,
      );
    }
    return;
  }
  const humanDecision = proposal.evidence.some(
    (evidence) => evidence.artifact === "human-decision",
  );
  const contractAllowsException = contract.human_decisions.some(
    (kind) => kind === "exception" || kind === "value_judgment",
  );
  if (!humanDecision || !contractAllowsException) {
    fail(
      `Core decision ${proposal.stage_id}`,
      "not_applicable requires a verified human-decision Evidence or a future deterministic applicability rule",
    );
  }
}

export function reviseStageExecutionPlan(
  currentPlan: StageExecutionPlan,
  proposals: readonly StageDispositionProposal[],
  options: ReviseStageExecutionPlanOptions,
): StageExecutionPlan {
  const current = parseStageExecutionPlan(currentPlan);
  if (proposals.length === 0) {
    fail("Stage Execution Plan revision", "requires at least one proposal");
  }
  verifyProjectArtifactReference(options.projectDir, current.policy_snapshot);
  const parsedProposals = proposals.map((proposal, index) =>
    parseStageDispositionProposal(proposal, `Proposal[${index}]`)
  );
  const stageIds = parsedProposals.map((proposal) => proposal.stage_id);
  const duplicate = stageIds.find((stageId, index) => stageIds.indexOf(stageId) !== index);
  if (duplicate !== undefined) {
    fail("Stage Execution Plan revision", `duplicate proposal for ${duplicate}`);
  }
  const contracts = contractMap(options.stageContracts ?? []);
  const proposalByStage = new Map(
    parsedProposals.map((proposal) => [proposal.stage_id, proposal]),
  );
  const revision = current.revision + 1;
  const decisions = current.stage_decisions.map((existing): CoreStageDecision => {
    const proposal = proposalByStage.get(existing.stage_id);
    if (proposal === undefined) return existing;
    verifyProposalEvidence(options.projectDir, proposal);
    validateProposalDecisionRule(proposal, contracts.get(proposal.stage_id));
    return {
      schema_version: STAGE_CONTRACT_SCHEMA_VERSION,
      decision_id: decisionId(existing.stage_id, revision),
      stage_id: existing.stage_id,
      disposition: proposal.disposition,
      reason: proposal.reason,
      evidence: proposal.evidence,
      decision_authority: "core",
      proposal_ref: proposal.proposal_id,
    };
  });
  return parseStageExecutionPlan({
    ...current,
    revision,
    stage_decisions: decisions,
  });
}

export function main(argv: string[]): void {
  const [command, ...rest] = argv;
  try {
    const definitions = loadVNextDefinitions();
    if (command === "show" && rest.length === 0) {
      process.stdout.write(`${JSON.stringify(definitions, null, 2)}\n`);
      return;
    }
    if (command === "catalog" && rest.length === 0) {
      process.stdout.write(`${JSON.stringify(definitions.catalog, null, 2)}\n`);
      return;
    }
    if (command === "validate" && rest.length === 0) {
      process.stdout.write(
        `${JSON.stringify({ valid: true, workflow: "vnext", catalog_version: definitions.catalog.catalog_version, graph_version: definitions.graph.graph_version })}\n`,
      );
      return;
    }
    console.error("Usage: aidlc graph <show|catalog|validate>");
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
