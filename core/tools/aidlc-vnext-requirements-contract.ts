import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";

export const REQUIREMENTS_SCHEMA_VERSION = 1 as const;
export const REQUIREMENTS_ARTIFACT_VERSION = 1 as const;
export const REQUIREMENTS_SOURCE_ARTIFACTS = [
  "intent-definition",
  "current-context",
  "effective-policy",
] as const;

export type RequirementsSourceArtifact = (typeof REQUIREMENTS_SOURCE_ARTIFACTS)[number];

export interface RequirementsSourceRef {
  artifact: RequirementsSourceArtifact;
  pointer: string;
}

export interface RequirementItem {
  id: string;
  statement: string;
  source_refs: RequirementsSourceRef[];
}

export interface RequirementsOpenQuestion {
  id: string;
  question: string;
  blocking: boolean;
  reason: string;
  source_refs: RequirementsSourceRef[];
}

export interface RequirementsWorkRequest {
  schema_version: typeof REQUIREMENTS_SCHEMA_VERSION;
  artifact: "requirements-work-request";
  version: typeof REQUIREMENTS_ARTIFACT_VERSION;
  intent_id: string;
  stage_id: "ST-03";
  intent_definition_ref: ArtifactReference;
  current_context_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  base_revision: number | null;
  base_requirements_ref: ArtifactReference | null;
  coverage_required: RequirementsSourceRef[];
  requested_outputs: ["requirements-definition-proposal"];
  rules: string[];
  created_at: string;
}

export interface RequirementsDefinitionProposal {
  schema_version: typeof REQUIREMENTS_SCHEMA_VERSION;
  artifact: "requirements-definition-proposal";
  version: typeof REQUIREMENTS_ARTIFACT_VERSION;
  proposal_id: string;
  intent_id: string;
  work_request_sha256: string;
  functional_requirements: RequirementItem[];
  quality_requirements: RequirementItem[];
  constraints: RequirementItem[];
  invariants: RequirementItem[];
  open_questions: RequirementsOpenQuestion[];
  reason: string;
  proposed_by: "ai";
}

export interface RequirementsDefinition {
  schema_version: typeof REQUIREMENTS_SCHEMA_VERSION;
  artifact: "requirements-definition";
  version: typeof REQUIREMENTS_ARTIFACT_VERSION;
  intent_id: string;
  revision: number;
  base_revision: number | null;
  proposal_id: string;
  intent_definition_ref: ArtifactReference;
  current_context_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  functional_requirements: RequirementItem[];
  quality_requirements: RequirementItem[];
  constraints: RequirementItem[];
  invariants: RequirementItem[];
  open_questions: RequirementsOpenQuestion[];
  reason: string;
  created_at: string;
}

export interface RequirementsCurrent {
  schema_version: typeof REQUIREMENTS_SCHEMA_VERSION;
  artifact: "requirements-current";
  version: typeof REQUIREMENTS_ARTIFACT_VERSION;
  intent_id: string;
  current_revision: number;
  requirements_ref: ArtifactReference;
  updated_at: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STABLE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SECRET_FIELD_PATTERN = /(?:^|[_-])(secret|password|passwd|token|api[_-]?key|credential|private[_-]?key)(?:$|[_-])/i;

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
  const known = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}

function assertNoSecretFields(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${context}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      fail(context, `secret-bearing field is prohibited: ${key}`);
    }
    assertNoSecretFields(child, `${context}.${key}`);
  }
}

function asOneLine(value: unknown, context: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value !== value.trim() ||
    /[\r\n\0]/.test(value)
  ) fail(context, "must be a non-empty single-line string");
  return value;
}

function asStableId(value: unknown, context: string): string {
  const id = asOneLine(value, context);
  if (!STABLE_ID_PATTERN.test(id)) fail(context, "must be a stable lowercase identifier");
  return id;
}

function asSha256(value: unknown, context: string): string {
  const sha = asOneLine(value, context);
  if (!SHA256_PATTERN.test(sha)) {
    fail(context, "must use sha256:<64 lowercase hex characters>");
  }
  return sha;
}

function asPositiveInteger(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) fail(context, "must be a positive integer");
  return value as number;
}

function asNullableRevision(value: unknown, context: string): number | null {
  return value === null ? null : asPositiveInteger(value, context);
}

function asIsoTimestamp(value: unknown, context: string): string {
  const timestamp = asOneLine(value, context);
  if (Number.isNaN(Date.parse(timestamp)) || !timestamp.endsWith("Z")) {
    fail(context, "must be an ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function asUniqueStrings(value: unknown, context: string, minimum = 0): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const items = value.map((entry, index) => asOneLine(entry, `${context}[${index}]`));
  if (items.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  const duplicate = items.find((entry, index) => items.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate value: ${duplicate}`);
  return items;
}

function asSourceArtifact(value: unknown, context: string): RequirementsSourceArtifact {
  const artifact = asOneLine(value, context);
  if (!(REQUIREMENTS_SOURCE_ARTIFACTS as readonly string[]).includes(artifact)) {
    fail(context, `must be one of ${REQUIREMENTS_SOURCE_ARTIFACTS.join(", ")}`);
  }
  return artifact as RequirementsSourceArtifact;
}

function asJsonPointer(value: unknown, context: string): string {
  const pointer = asOneLine(value, context);
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) {
    fail(context, "must be a non-root RFC 6901 JSON Pointer");
  }
  return pointer;
}

export function parseRequirementsSourceRef(
  value: unknown,
  context = "Requirements Source Reference",
): RequirementsSourceRef {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["artifact", "pointer"], context);
  return {
    artifact: asSourceArtifact(record.artifact, `${context}.artifact`),
    pointer: asJsonPointer(record.pointer, `${context}.pointer`),
  };
}

function parseSourceRefs(value: unknown, context: string, minimum = 1): RequirementsSourceRef[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const references = value.map((entry, index) =>
    parseRequirementsSourceRef(entry, `${context}[${index}]`)
  );
  if (references.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  const keys = references.map((reference) => `${reference.artifact}:${reference.pointer}`);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate reference: ${duplicate}`);
  return references;
}

function parseRequirementItems(
  value: unknown,
  context: string,
  idPattern: RegExp,
  idExample: string,
): RequirementItem[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  return value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(entry, itemContext);
    rejectUnknownKeys(record, ["id", "statement", "source_refs"], itemContext);
    const id = asOneLine(record.id, `${itemContext}.id`);
    if (!idPattern.test(id)) fail(`${itemContext}.id`, `must match ${idExample}`);
    return {
      id,
      statement: asOneLine(record.statement, `${itemContext}.statement`),
      source_refs: parseSourceRefs(record.source_refs, `${itemContext}.source_refs`),
    };
  });
}

function parseOpenQuestions(value: unknown, context: string): RequirementsOpenQuestion[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  return value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(entry, itemContext);
    rejectUnknownKeys(
      record,
      ["id", "question", "blocking", "reason", "source_refs"],
      itemContext,
    );
    const id = asOneLine(record.id, `${itemContext}.id`);
    if (!/^Q-\d{3}$/.test(id)) fail(`${itemContext}.id`, "must match Q-001");
    if (typeof record.blocking !== "boolean") fail(`${itemContext}.blocking`, "must be boolean");
    return {
      id,
      question: asOneLine(record.question, `${itemContext}.question`),
      blocking: record.blocking,
      reason: asOneLine(record.reason, `${itemContext}.reason`),
      source_refs: parseSourceRefs(record.source_refs, `${itemContext}.source_refs`),
    };
  });
}

type RequirementsBody = Pick<
  RequirementsDefinitionProposal,
  | "functional_requirements"
  | "quality_requirements"
  | "constraints"
  | "invariants"
  | "open_questions"
  | "reason"
>;

function parseRequirementsBody(
  record: Record<string, unknown>,
  context: string,
): RequirementsBody {
  const functional = parseRequirementItems(
    record.functional_requirements,
    `${context}.functional_requirements`,
    /^REQ-F-\d{3}$/,
    "REQ-F-001",
  );
  const quality = parseRequirementItems(
    record.quality_requirements,
    `${context}.quality_requirements`,
    /^REQ-Q-\d{3}$/,
    "REQ-Q-001",
  );
  const constraints = parseRequirementItems(
    record.constraints,
    `${context}.constraints`,
    /^CON-\d{3}$/,
    "CON-001",
  );
  const invariants = parseRequirementItems(
    record.invariants,
    `${context}.invariants`,
    /^INV-\d{3}$/,
    "INV-001",
  );
  const questions = parseOpenQuestions(record.open_questions, `${context}.open_questions`);
  if (functional.length + quality.length + constraints.length + invariants.length === 0) {
    fail(context, "must define at least one requirement, constraint, or invariant");
  }
  const allIds = [
    ...functional,
    ...quality,
    ...constraints,
    ...invariants,
    ...questions,
  ].map((item) => item.id);
  const duplicate = allIds.find((id, index) => allIds.indexOf(id) !== index);
  if (duplicate !== undefined) fail(context, `duplicate requirement ID: ${duplicate}`);
  return {
    functional_requirements: functional,
    quality_requirements: quality,
    constraints,
    invariants,
    open_questions: questions,
    reason: asOneLine(record.reason, `${context}.reason`),
  };
}

export function parseRequirementsWorkRequest(
  value: unknown,
  context = "Requirements Work Request",
): RequirementsWorkRequest {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "intent_id", "stage_id",
      "intent_definition_ref", "current_context_ref", "effective_policy_ref",
      "base_revision", "base_requirements_ref", "coverage_required",
      "requested_outputs", "rules", "created_at",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "requirements-work-request") {
    fail(`${context}.artifact`, "must equal requirements-work-request");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.stage_id !== "ST-03") fail(`${context}.stage_id`, "must equal ST-03");
  const requested = asUniqueStrings(record.requested_outputs, `${context}.requested_outputs`, 1);
  if (JSON.stringify(requested) !== JSON.stringify(["requirements-definition-proposal"])) {
    fail(`${context}.requested_outputs`, "must contain only requirements-definition-proposal");
  }
  const baseRevision = asNullableRevision(record.base_revision, `${context}.base_revision`);
  const baseReference = record.base_requirements_ref === null
    ? null
    : parseArtifactReference(record.base_requirements_ref, `${context}.base_requirements_ref`);
  if ((baseRevision === null) !== (baseReference === null)) {
    fail(context, "base_revision and base_requirements_ref must both be null or both be present");
  }
  return {
    schema_version: 1,
    artifact: "requirements-work-request",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    stage_id: "ST-03",
    intent_definition_ref: parseArtifactReference(
      record.intent_definition_ref,
      `${context}.intent_definition_ref`,
    ),
    current_context_ref: parseArtifactReference(
      record.current_context_ref,
      `${context}.current_context_ref`,
    ),
    effective_policy_ref: parseArtifactReference(
      record.effective_policy_ref,
      `${context}.effective_policy_ref`,
    ),
    base_revision: baseRevision,
    base_requirements_ref: baseReference,
    coverage_required: parseSourceRefs(
      record.coverage_required,
      `${context}.coverage_required`,
      1,
    ),
    requested_outputs: ["requirements-definition-proposal"],
    rules: asUniqueStrings(record.rules, `${context}.rules`, 1),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseRequirementsDefinitionProposal(
  value: unknown,
  context = "Requirements Definition Proposal",
): RequirementsDefinitionProposal {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "proposal_id", "intent_id",
      "work_request_sha256", "functional_requirements", "quality_requirements",
      "constraints", "invariants", "open_questions", "reason", "proposed_by",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "requirements-definition-proposal") {
    fail(`${context}.artifact`, "must equal requirements-definition-proposal");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.proposed_by !== "ai") fail(`${context}.proposed_by`, "must equal ai");
  return {
    schema_version: 1,
    artifact: "requirements-definition-proposal",
    version: 1,
    proposal_id: asStableId(record.proposal_id, `${context}.proposal_id`),
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    work_request_sha256: asSha256(
      record.work_request_sha256,
      `${context}.work_request_sha256`,
    ),
    ...parseRequirementsBody(record, context),
    proposed_by: "ai",
  };
}

export function parseRequirementsDefinition(
  value: unknown,
  context = "Requirements Definition",
): RequirementsDefinition {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "intent_id", "revision",
      "base_revision", "proposal_id", "intent_definition_ref", "current_context_ref",
      "effective_policy_ref", "functional_requirements", "quality_requirements",
      "constraints", "invariants", "open_questions", "reason", "created_at",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "requirements-definition") {
    fail(`${context}.artifact`, "must equal requirements-definition");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  return {
    schema_version: 1,
    artifact: "requirements-definition",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    revision: asPositiveInteger(record.revision, `${context}.revision`),
    base_revision: asNullableRevision(record.base_revision, `${context}.base_revision`),
    proposal_id: asStableId(record.proposal_id, `${context}.proposal_id`),
    intent_definition_ref: parseArtifactReference(
      record.intent_definition_ref,
      `${context}.intent_definition_ref`,
    ),
    current_context_ref: parseArtifactReference(
      record.current_context_ref,
      `${context}.current_context_ref`,
    ),
    effective_policy_ref: parseArtifactReference(
      record.effective_policy_ref,
      `${context}.effective_policy_ref`,
    ),
    ...parseRequirementsBody(record, context),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseRequirementsCurrent(
  value: unknown,
  context = "Requirements Current",
): RequirementsCurrent {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "intent_id", "current_revision",
      "requirements_ref", "updated_at",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "requirements-current") {
    fail(`${context}.artifact`, "must equal requirements-current");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  return {
    schema_version: 1,
    artifact: "requirements-current",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    current_revision: asPositiveInteger(record.current_revision, `${context}.current_revision`),
    requirements_ref: parseArtifactReference(
      record.requirements_ref,
      `${context}.requirements_ref`,
    ),
    updated_at: asIsoTimestamp(record.updated_at, `${context}.updated_at`),
  };
}
