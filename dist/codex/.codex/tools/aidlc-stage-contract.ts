/**
 * AI-DLC vNext common Stage contracts.
 *
 * M1 introduced these contracts. M2 connects them to the vNext State, Audit,
 * Doctor, and Orchestrator through the fixed ten-Stage Graph.
 */

export const STAGE_CONTRACT_SCHEMA_VERSION = 1 as const;

export const VNEXT_STAGE_IDS = [
  "ST-00",
  "ST-01",
  "ST-02",
  "ST-03",
  "ST-04",
  "ST-05",
  "ST-06",
  "ST-07",
  "ST-08",
  "ST-09",
] as const;

export type VNextStageId = (typeof VNEXT_STAGE_IDS)[number];

export const STAGE_DISPOSITIONS = [
  "execute",
  "reuse",
  "not_applicable",
] as const;

export type StageDisposition = (typeof STAGE_DISPOSITIONS)[number];

export const STAGE_PROPOSERS = ["ai", "human", "core"] as const;
export type StageProposer = (typeof STAGE_PROPOSERS)[number];

export const HUMAN_DECISION_KINDS = [
  "value_judgment",
  "exception",
  "approval",
  "release_authority",
] as const;

export type HumanDecisionKind = (typeof HUMAN_DECISION_KINDS)[number];

export interface StageArtifactRequirement {
  artifact: string;
  required: boolean;
}

export interface VNextStageContract {
  schema_version: typeof STAGE_CONTRACT_SCHEMA_VERSION;
  stage_id: VNextStageId;
  name: string;
  purpose: string;
  inputs: StageArtifactRequirement[];
  outputs: string[];
  completion_criteria: string[];
  stop_conditions: string[];
  human_decisions: HumanDecisionKind[];
  verifiers: string[];
}

export interface ArtifactReference {
  artifact: string;
  version: number;
  source_of_truth: string;
  sha256: string;
}

/**
 * Untrusted proposal shape. It deliberately has no authority or transition
 * field. Unknown fields are rejected, so an AI cannot smuggle a Core decision
 * or a next-Stage instruction into a proposal.
 */
export interface StageDispositionProposal {
  schema_version: typeof STAGE_CONTRACT_SCHEMA_VERSION;
  proposal_id: string;
  stage_id: VNextStageId;
  disposition: StageDisposition;
  reason: string;
  evidence: ArtifactReference[];
  proposed_by: StageProposer;
}

/** Persisted decision shape. Only Core-produced data may use this contract. */
export interface CoreStageDecision {
  schema_version: typeof STAGE_CONTRACT_SCHEMA_VERSION;
  decision_id: string;
  stage_id: VNextStageId;
  disposition: StageDisposition;
  reason: string;
  evidence: ArtifactReference[];
  decision_authority: "core";
  proposal_ref?: string;
}

/**
 * Core-owned plan describing the work depth for every fixed Stage.
 * Runtime progress and Graph transitions remain separate State concerns.
 */
export interface StageExecutionPlan {
  schema_version: typeof STAGE_CONTRACT_SCHEMA_VERSION;
  intent_id: string;
  revision: number;
  graph_version: string;
  policy_snapshot: ArtifactReference;
  stage_decisions: CoreStageDecision[];
}

const ARTIFACT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

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
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    fail(context, `unknown field(s): ${unknown.join(", ")}`);
  }
}

function asNonEmptyString(value: unknown, context: string): string {
  if (
    typeof value !== "string" || value.trim() === "" ||
    value !== value.trim() ||
    value.includes("\0") || /\r|\n/.test(value)
  ) {
    fail(context, "must be a non-empty single-line string");
  }
  return value;
}

function asPositiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(context, "must be a positive integer");
  }
  return value as number;
}

function asSchemaVersion(value: unknown, context: string): 1 {
  if (value !== STAGE_CONTRACT_SCHEMA_VERSION) {
    fail(context, `must equal ${STAGE_CONTRACT_SCHEMA_VERSION}`);
  }
  return STAGE_CONTRACT_SCHEMA_VERSION;
}

function asAllowedString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  const text = asNonEmptyString(value, context);
  if (!(allowed as readonly string[]).includes(text)) {
    fail(context, `must be one of: ${allowed.join(", ")}`);
  }
  return text as T;
}

function asUniqueStringArray(
  value: unknown,
  context: string,
  options: { minLength?: number; pattern?: RegExp } = {},
): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const strings = value.map((entry, index) => {
    const text = asNonEmptyString(entry, `${context}[${index}]`);
    if (options.pattern !== undefined && !options.pattern.test(text)) {
      fail(`${context}[${index}]`, "has an invalid format");
    }
    return text;
  });
  if (strings.length < (options.minLength ?? 0)) {
    fail(context, `must contain at least ${options.minLength} item(s)`);
  }
  const duplicate = strings.find((entry, index) =>
    strings.indexOf(entry) !== index
  );
  if (duplicate !== undefined) {
    fail(context, `contains duplicate value: ${duplicate}`);
  }
  return strings;
}

function asHumanDecisionArray(
  value: unknown,
  context: string,
): HumanDecisionKind[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const decisions = value.map((entry, index) =>
    asAllowedString(
      entry,
      HUMAN_DECISION_KINDS,
      `${context}[${index}]`,
    )
  );
  const duplicate = decisions.find((entry, index) =>
    decisions.indexOf(entry) !== index
  );
  if (duplicate !== undefined) {
    fail(context, `contains duplicate value: ${duplicate}`);
  }
  return decisions;
}

function parseArtifactRequirements(
  value: unknown,
  context: string,
): StageArtifactRequirement[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const requirements = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(entry, itemContext);
    rejectUnknownKeys(record, ["artifact", "required"], itemContext);
    const artifact = asNonEmptyString(
      record.artifact,
      `${itemContext}.artifact`,
    );
    if (!ARTIFACT_PATTERN.test(artifact)) {
      fail(`${itemContext}.artifact`, "must use lowercase kebab-case");
    }
    if (typeof record.required !== "boolean") {
      fail(`${itemContext}.required`, "must be a boolean");
    }
    return { artifact, required: record.required };
  });
  const names = requirements.map((entry) => entry.artifact);
  const duplicate = names.find((entry, index) => names.indexOf(entry) !== index);
  if (duplicate !== undefined) {
    fail(context, `contains duplicate artifact: ${duplicate}`);
  }
  return requirements;
}

export function parseArtifactReference(
  value: unknown,
  context = "Artifact reference",
): ArtifactReference {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["artifact", "version", "source_of_truth", "sha256"],
    context,
  );
  const artifact = asNonEmptyString(record.artifact, `${context}.artifact`);
  if (!ARTIFACT_PATTERN.test(artifact)) {
    fail(`${context}.artifact`, "must use lowercase kebab-case");
  }
  const sha256 = asNonEmptyString(record.sha256, `${context}.sha256`);
  if (!SHA256_PATTERN.test(sha256)) {
    fail(`${context}.sha256`, "must use sha256:<64 lowercase hex characters>");
  }
  return {
    artifact,
    version: asPositiveInteger(record.version, `${context}.version`),
    source_of_truth: asNonEmptyString(
      record.source_of_truth,
      `${context}.source_of_truth`,
    ),
    sha256,
  };
}

function parseEvidence(value: unknown, context: string): ArtifactReference[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const evidence = value.map((entry, index) =>
    parseArtifactReference(entry, `${context}[${index}]`)
  );
  const identities = evidence.map((entry) =>
    `${entry.artifact}@${entry.version}:${entry.source_of_truth}`
  );
  const duplicate = identities.find((entry, index) =>
    identities.indexOf(entry) !== index
  );
  if (duplicate !== undefined) {
    fail(context, `contains duplicate reference: ${duplicate}`);
  }
  return evidence;
}

function requireDispositionEvidence(
  disposition: StageDisposition,
  evidence: readonly ArtifactReference[],
  context: string,
): void {
  if (disposition !== "execute" && evidence.length === 0) {
    fail(
      `${context}.evidence`,
      `${disposition} requires at least one evidence reference`,
    );
  }
}

export function parseVNextStageContract(
  value: unknown,
  context = "Stage Contract",
): VNextStageContract {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version",
      "stage_id",
      "name",
      "purpose",
      "inputs",
      "outputs",
      "completion_criteria",
      "stop_conditions",
      "human_decisions",
      "verifiers",
    ],
    context,
  );
  return {
    schema_version: asSchemaVersion(
      record.schema_version,
      `${context}.schema_version`,
    ),
    stage_id: asAllowedString(
      record.stage_id,
      VNEXT_STAGE_IDS,
      `${context}.stage_id`,
    ),
    name: asNonEmptyString(record.name, `${context}.name`),
    purpose: asNonEmptyString(record.purpose, `${context}.purpose`),
    inputs: parseArtifactRequirements(record.inputs, `${context}.inputs`),
    outputs: asUniqueStringArray(record.outputs, `${context}.outputs`, {
      pattern: ARTIFACT_PATTERN,
    }),
    completion_criteria: asUniqueStringArray(
      record.completion_criteria,
      `${context}.completion_criteria`,
      { minLength: 1 },
    ),
    stop_conditions: asUniqueStringArray(
      record.stop_conditions,
      `${context}.stop_conditions`,
      { minLength: 1 },
    ),
    human_decisions: asHumanDecisionArray(
      record.human_decisions,
      `${context}.human_decisions`,
    ),
    verifiers: asUniqueStringArray(
      record.verifiers,
      `${context}.verifiers`,
      { minLength: 1 },
    ),
  };
}

export function parseStageDispositionProposal(
  value: unknown,
  context = "Stage disposition proposal",
): StageDispositionProposal {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version",
      "proposal_id",
      "stage_id",
      "disposition",
      "reason",
      "evidence",
      "proposed_by",
    ],
    context,
  );
  const disposition = asAllowedString(
    record.disposition,
    STAGE_DISPOSITIONS,
    `${context}.disposition`,
  );
  const evidence = parseEvidence(record.evidence, `${context}.evidence`);
  requireDispositionEvidence(disposition, evidence, context);
  return {
    schema_version: asSchemaVersion(
      record.schema_version,
      `${context}.schema_version`,
    ),
    proposal_id: asNonEmptyString(
      record.proposal_id,
      `${context}.proposal_id`,
    ),
    stage_id: asAllowedString(
      record.stage_id,
      VNEXT_STAGE_IDS,
      `${context}.stage_id`,
    ),
    disposition,
    reason: asNonEmptyString(record.reason, `${context}.reason`),
    evidence,
    proposed_by: asAllowedString(
      record.proposed_by,
      STAGE_PROPOSERS,
      `${context}.proposed_by`,
    ),
  };
}

export function parseCoreStageDecision(
  value: unknown,
  context = "Core Stage decision",
): CoreStageDecision {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version",
      "decision_id",
      "stage_id",
      "disposition",
      "reason",
      "evidence",
      "decision_authority",
      "proposal_ref",
    ],
    context,
  );
  if (record.decision_authority !== "core") {
    fail(`${context}.decision_authority`, "must equal core");
  }
  const disposition = asAllowedString(
    record.disposition,
    STAGE_DISPOSITIONS,
    `${context}.disposition`,
  );
  const evidence = parseEvidence(record.evidence, `${context}.evidence`);
  requireDispositionEvidence(disposition, evidence, context);
  const decision: CoreStageDecision = {
    schema_version: asSchemaVersion(
      record.schema_version,
      `${context}.schema_version`,
    ),
    decision_id: asNonEmptyString(
      record.decision_id,
      `${context}.decision_id`,
    ),
    stage_id: asAllowedString(
      record.stage_id,
      VNEXT_STAGE_IDS,
      `${context}.stage_id`,
    ),
    disposition,
    reason: asNonEmptyString(record.reason, `${context}.reason`),
    evidence,
    decision_authority: "core",
  };
  if (record.proposal_ref !== undefined) {
    decision.proposal_ref = asNonEmptyString(
      record.proposal_ref,
      `${context}.proposal_ref`,
    );
  }
  return decision;
}

export function parseStageExecutionPlan(
  value: unknown,
  context = "Stage Execution Plan",
): StageExecutionPlan {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version",
      "intent_id",
      "revision",
      "graph_version",
      "policy_snapshot",
      "stage_decisions",
    ],
    context,
  );
  if (!Array.isArray(record.stage_decisions)) {
    fail(`${context}.stage_decisions`, "must be an array");
  }
  const stageDecisions = record.stage_decisions.map((entry, index) =>
    parseCoreStageDecision(entry, `${context}.stage_decisions[${index}]`)
  );
  if (stageDecisions.length !== VNEXT_STAGE_IDS.length) {
    fail(
      `${context}.stage_decisions`,
      `must contain exactly ${VNEXT_STAGE_IDS.length} decisions`,
    );
  }
  for (const [index, stageId] of VNEXT_STAGE_IDS.entries()) {
    const actual = stageDecisions[index]?.stage_id;
    if (actual !== stageId) {
      fail(
        `${context}.stage_decisions[${index}].stage_id`,
        `must equal ${stageId}; fixed Stage order cannot be changed`,
      );
    }
  }
  const decisionIds = stageDecisions.map((entry) => entry.decision_id);
  const duplicateDecisionId = decisionIds.find((entry, index) =>
    decisionIds.indexOf(entry) !== index
  );
  if (duplicateDecisionId !== undefined) {
    fail(
      `${context}.stage_decisions`,
      `contains duplicate decision_id: ${duplicateDecisionId}`,
    );
  }
  return {
    schema_version: asSchemaVersion(
      record.schema_version,
      `${context}.schema_version`,
    ),
    intent_id: asNonEmptyString(record.intent_id, `${context}.intent_id`),
    revision: asPositiveInteger(record.revision, `${context}.revision`),
    graph_version: asNonEmptyString(
      record.graph_version,
      `${context}.graph_version`,
    ),
    policy_snapshot: parseArtifactReference(
      record.policy_snapshot,
      `${context}.policy_snapshot`,
    ),
    stage_decisions: stageDecisions,
  };
}
