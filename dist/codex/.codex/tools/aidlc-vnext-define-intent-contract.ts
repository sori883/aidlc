import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";

export const DEFINE_INTENT_SCHEMA_VERSION = 1 as const;
export const DEFINE_INTENT_ARTIFACT_VERSION = 1 as const;

export interface DefineIntentWorkRequest {
  schema_version: typeof DEFINE_INTENT_SCHEMA_VERSION;
  artifact: "define-intent-work-request";
  version: typeof DEFINE_INTENT_ARTIFACT_VERSION;
  intent_id: string;
  stage_id: "ST-02";
  design_brief_ref: ArtifactReference;
  current_context_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  requested_outputs: ["intent-definition-proposal"];
  rules: string[];
  created_at: string;
}

export interface IntentDefinitionProposal {
  schema_version: typeof DEFINE_INTENT_SCHEMA_VERSION;
  artifact: "intent-definition-proposal";
  version: typeof DEFINE_INTENT_ARTIFACT_VERSION;
  proposal_id: string;
  intent_id: string;
  work_request_sha256: string;
  purpose: string;
  expected_outcomes: string[];
  in_scope: string[];
  out_of_scope: string[];
  success_signals: string[];
  unknowns: string[];
  reason: string;
  proposed_by: "ai";
}

export interface IntentDefinition {
  schema_version: typeof DEFINE_INTENT_SCHEMA_VERSION;
  artifact: "intent-definition";
  version: typeof DEFINE_INTENT_ARTIFACT_VERSION;
  intent_id: string;
  proposal_id: string;
  design_brief_ref: ArtifactReference;
  current_context_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  purpose: string;
  expected_outcomes: string[];
  in_scope: string[];
  out_of_scope: string[];
  success_signals: string[];
  unknowns: string[];
  reason: string;
  created_at: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
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

function asId(value: unknown, context: string): string {
  const id = asOneLine(value, context);
  if (!ID_PATTERN.test(id)) fail(context, "must be a stable lowercase identifier");
  return id;
}

function asSha256(value: unknown, context: string): string {
  const sha = asOneLine(value, context);
  if (!SHA256_PATTERN.test(sha)) {
    fail(context, "must use sha256:<64 lowercase hex characters>");
  }
  return sha;
}

function asIsoTimestamp(value: unknown, context: string): string {
  const timestamp = asOneLine(value, context);
  if (Number.isNaN(Date.parse(timestamp)) || !timestamp.endsWith("Z")) {
    fail(context, "must be an ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function asUniqueStrings(
  value: unknown,
  context: string,
  minimum = 0,
): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const items = value.map((entry, index) => asOneLine(entry, `${context}[${index}]`));
  if (items.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  const duplicate = items.find((entry, index) => items.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate value: ${duplicate}`);
  return items;
}

function assertScopeDoesNotOverlap(
  inScope: readonly string[],
  outOfScope: readonly string[],
  context: string,
): void {
  const excluded = new Set(outOfScope);
  const overlap = inScope.find((entry) => excluded.has(entry));
  if (overlap !== undefined) {
    fail(context, `item appears in both in_scope and out_of_scope: ${overlap}`);
  }
}

function proposalFields(
  record: Record<string, unknown>,
  context: string,
): Pick<
  IntentDefinitionProposal,
  | "purpose"
  | "expected_outcomes"
  | "in_scope"
  | "out_of_scope"
  | "success_signals"
  | "unknowns"
  | "reason"
> {
  const inScope = asUniqueStrings(record.in_scope, `${context}.in_scope`, 1);
  const outOfScope = asUniqueStrings(record.out_of_scope, `${context}.out_of_scope`);
  assertScopeDoesNotOverlap(inScope, outOfScope, context);
  return {
    purpose: asOneLine(record.purpose, `${context}.purpose`),
    expected_outcomes: asUniqueStrings(
      record.expected_outcomes,
      `${context}.expected_outcomes`,
      1,
    ),
    in_scope: inScope,
    out_of_scope: outOfScope,
    success_signals: asUniqueStrings(
      record.success_signals,
      `${context}.success_signals`,
      1,
    ),
    unknowns: asUniqueStrings(record.unknowns, `${context}.unknowns`),
    reason: asOneLine(record.reason, `${context}.reason`),
  };
}

export function parseDefineIntentWorkRequest(
  value: unknown,
  context = "Define Intent Work Request",
): DefineIntentWorkRequest {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "intent_id", "stage_id",
      "design_brief_ref", "current_context_ref", "effective_policy_ref",
      "requested_outputs", "rules", "created_at",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "define-intent-work-request") {
    fail(`${context}.artifact`, "must equal define-intent-work-request");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.stage_id !== "ST-02") fail(`${context}.stage_id`, "must equal ST-02");
  const requested = asUniqueStrings(record.requested_outputs, `${context}.requested_outputs`, 1);
  if (JSON.stringify(requested) !== JSON.stringify(["intent-definition-proposal"])) {
    fail(`${context}.requested_outputs`, "must contain only intent-definition-proposal");
  }
  return {
    schema_version: 1,
    artifact: "define-intent-work-request",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    stage_id: "ST-02",
    design_brief_ref: parseArtifactReference(record.design_brief_ref, `${context}.design_brief_ref`),
    current_context_ref: parseArtifactReference(record.current_context_ref, `${context}.current_context_ref`),
    effective_policy_ref: parseArtifactReference(record.effective_policy_ref, `${context}.effective_policy_ref`),
    requested_outputs: ["intent-definition-proposal"],
    rules: asUniqueStrings(record.rules, `${context}.rules`, 1),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseIntentDefinitionProposal(
  value: unknown,
  context = "Intent Definition Proposal",
): IntentDefinitionProposal {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "proposal_id", "intent_id",
      "work_request_sha256", "purpose", "expected_outcomes", "in_scope",
      "out_of_scope", "success_signals", "unknowns", "reason", "proposed_by",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "intent-definition-proposal") {
    fail(`${context}.artifact`, "must equal intent-definition-proposal");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.proposed_by !== "ai") fail(`${context}.proposed_by`, "must equal ai");
  return {
    schema_version: 1,
    artifact: "intent-definition-proposal",
    version: 1,
    proposal_id: asId(record.proposal_id, `${context}.proposal_id`),
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    work_request_sha256: asSha256(
      record.work_request_sha256,
      `${context}.work_request_sha256`,
    ),
    ...proposalFields(record, context),
    proposed_by: "ai",
  };
}

export function parseIntentDefinition(
  value: unknown,
  context = "Intent Definition",
): IntentDefinition {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "intent_id", "proposal_id",
      "design_brief_ref", "current_context_ref", "effective_policy_ref", "purpose",
      "expected_outcomes", "in_scope", "out_of_scope", "success_signals",
      "unknowns", "reason", "created_at",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "intent-definition") {
    fail(`${context}.artifact`, "must equal intent-definition");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  return {
    schema_version: 1,
    artifact: "intent-definition",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    proposal_id: asId(record.proposal_id, `${context}.proposal_id`),
    design_brief_ref: parseArtifactReference(record.design_brief_ref, `${context}.design_brief_ref`),
    current_context_ref: parseArtifactReference(record.current_context_ref, `${context}.current_context_ref`),
    effective_policy_ref: parseArtifactReference(record.effective_policy_ref, `${context}.effective_policy_ref`),
    ...proposalFields(record, context),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}
