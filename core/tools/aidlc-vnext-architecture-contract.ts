import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";
import {
  parsePolicyAcknowledgement,
  type PolicyAcknowledgement,
} from "./aidlc-vnext-policy-gates.ts";

export const ARCHITECTURE_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_ARTIFACT_VERSION = 1 as const;
export const ARCHITECTURE_DISPOSITIONS = [
  "execute",
  "reuse",
  "not_applicable",
] as const;
export const ARCHITECTURE_CHANGE_ACTIONS = [
  "retain",
  "add",
  "modify",
  "remove",
] as const;
export const ARCHITECTURE_TARGET_KINDS = [
  "component",
  "api",
  "database",
  "external-service",
  "relation",
  "deployment",
  "boundary",
  "other",
] as const;
export const ARCHITECTURE_REVERSIBILITY = ["easy", "moderate", "hard"] as const;

export type ArchitectureDisposition = (typeof ARCHITECTURE_DISPOSITIONS)[number];
export type ArchitectureChangeAction = (typeof ARCHITECTURE_CHANGE_ACTIONS)[number];
export type ArchitectureTargetKind = (typeof ARCHITECTURE_TARGET_KINDS)[number];
export type ArchitectureReversibility = (typeof ARCHITECTURE_REVERSIBILITY)[number];

export interface ArchitectureRequirementAssessment {
  requirement_id: string;
  architecture_impact: boolean;
  reason: string;
  current_entity_refs: string[];
}

export interface ArchitecturePlannedChange {
  change_id: string;
  action: ArchitectureChangeAction;
  target_kind: ArchitectureTargetKind;
  target_id: string;
  description: string;
}

export interface ArchitectureDecisionDraft {
  decision_id: string;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  requirement_ids: string[];
  current_entity_refs: string[];
  planned_changes: ArchitecturePlannedChange[];
  alternatives: string[];
  consequences: string[];
  reversibility: ArchitectureReversibility;
}

export interface ArchitectureWorkRequest {
  schema_version: typeof ARCHITECTURE_SCHEMA_VERSION;
  artifact: "architecture-work-request";
  version: typeof ARCHITECTURE_ARTIFACT_VERSION;
  intent_id: string;
  stage_id: "ST-04";
  requirements_current_ref: ArtifactReference;
  requirements_ref: ArtifactReference;
  current_context_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  base_revision: number | null;
  base_architecture_ref: ArtifactReference | null;
  requirement_ids: string[];
  requested_outputs: ["architecture-assessment-proposal"];
  rules: string[];
  created_at: string;
}

export interface ArchitectureAssessmentProposal {
  schema_version: typeof ARCHITECTURE_SCHEMA_VERSION;
  artifact: "architecture-assessment-proposal";
  version: typeof ARCHITECTURE_ARTIFACT_VERSION;
  proposal_id: string;
  intent_id: string;
  work_request_sha256: string;
  disposition: ArchitectureDisposition;
  requirement_assessments: ArchitectureRequirementAssessment[];
  decisions: ArchitectureDecisionDraft[];
  reuse_ref: ArtifactReference | null;
  approval_ref: ArtifactReference | null;
  evidence: ArtifactReference[];
  reason: string;
  proposed_by: "ai";
}

export interface ArchitectureDecision {
  schema_version: typeof ARCHITECTURE_SCHEMA_VERSION;
  artifact: "architecture-decision";
  version: typeof ARCHITECTURE_ARTIFACT_VERSION;
  intent_id: string;
  revision: number;
  base_revision: number | null;
  proposal_id: string;
  requirements_ref: ArtifactReference;
  current_context_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  requirement_assessments: ArchitectureRequirementAssessment[];
  decisions: ArchitectureDecisionDraft[];
  reason: string;
  created_at: string;
}

export interface ArchitectureCurrent {
  schema_version: typeof ARCHITECTURE_SCHEMA_VERSION;
  artifact: "architecture-current";
  version: typeof ARCHITECTURE_ARTIFACT_VERSION;
  intent_id: string;
  disposition: ArchitectureDisposition;
  architecture_ref: ArtifactReference | null;
  requirements_ref: ArtifactReference;
  current_context_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  requirement_assessments: ArchitectureRequirementAssessment[];
  evidence: ArtifactReference[];
  reason: string;
  updated_at: string;
}

export interface ArchitectureReuseApproval {
  schema_version: typeof ARCHITECTURE_SCHEMA_VERSION;
  artifact: "human-decision";
  version: typeof ARCHITECTURE_ARTIFACT_VERSION;
  decision_id: string;
  decision_kind: "approval";
  intent_id: string;
  approved_architecture_ref: ArtifactReference;
  requirements_ref: ArtifactReference;
  decision: "approve-reuse";
  reason: string;
  decided_by: "human";
  decided_at: string;
}

export interface ArchitecturePolicyApproval {
  schema_version: typeof ARCHITECTURE_SCHEMA_VERSION;
  artifact: "architecture-policy-approval";
  version: typeof ARCHITECTURE_ARTIFACT_VERSION;
  decision_id: string;
  intent_id: string;
  proposal_ref: ArtifactReference;
  gate_requirement_set_ref: ArtifactReference;
  policy_acknowledgements: PolicyAcknowledgement[];
  decision: "approve-architecture-policy";
  reason: string;
  decided_by: "human";
  decided_at: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const REQUIREMENT_ID_PATTERN = /^(?:REQ-[A-Z]+|CON|INV)-\d{3}$/;
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
  if (!STABLE_ID_PATTERN.test(id)) fail(context, "must be a stable identifier");
  return id;
}

function asRequirementId(value: unknown, context: string): string {
  const id = asOneLine(value, context);
  if (!REQUIREMENT_ID_PATTERN.test(id)) {
    fail(context, "must match REQ-F-001, REQ-Q-001, CON-001, or INV-001");
  }
  return id;
}

function asPositiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(context, "must be a positive integer");
  }
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

function asSha256(value: unknown, context: string): string {
  const sha = asOneLine(value, context);
  if (!SHA256_PATTERN.test(sha)) {
    fail(context, "must use sha256:<64 lowercase hex characters>");
  }
  return sha;
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

function asUniqueStrings(
  value: unknown,
  context: string,
  minimum = 0,
  parser: (value: unknown, context: string) => string = asOneLine,
): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const items = value.map((entry, index) => parser(entry, `${context}[${index}]`));
  if (items.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  const duplicate = items.find((entry, index) => items.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate value: ${duplicate}`);
  return items;
}

function asReferences(value: unknown, context: string): ArtifactReference[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const references = value.map((entry, index) =>
    parseArtifactReference(entry, `${context}[${index}]`)
  );
  const keys = references.map((entry) => JSON.stringify(entry));
  const duplicate = keys.find((entry, index) => keys.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, "contains a duplicate Artifact Reference");
  return references;
}

function asNullableReference(value: unknown, context: string): ArtifactReference | null {
  return value === null ? null : parseArtifactReference(value, context);
}

function parseAssessment(
  value: unknown,
  context: string,
): ArchitectureRequirementAssessment {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["requirement_id", "architecture_impact", "reason", "current_entity_refs"],
    context,
  );
  if (typeof record.architecture_impact !== "boolean") {
    fail(`${context}.architecture_impact`, "must be a boolean");
  }
  return {
    requirement_id: asRequirementId(record.requirement_id, `${context}.requirement_id`),
    architecture_impact: record.architecture_impact,
    reason: asOneLine(record.reason, `${context}.reason`),
    current_entity_refs: asUniqueStrings(
      record.current_entity_refs,
      `${context}.current_entity_refs`,
      0,
      asStableId,
    ),
  };
}

function parseAssessments(
  value: unknown,
  context: string,
): ArchitectureRequirementAssessment[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const assessments = value.map((entry, index) =>
    parseAssessment(entry, `${context}[${index}]`)
  );
  if (assessments.length === 0) fail(context, "must contain at least one assessment");
  const ids = assessments.map((entry) => entry.requirement_id);
  const duplicate = ids.find((entry, index) => ids.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate requirement ID: ${duplicate}`);
  return assessments;
}

function parsePlannedChange(
  value: unknown,
  context: string,
): ArchitecturePlannedChange {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["change_id", "action", "target_kind", "target_id", "description"],
    context,
  );
  return {
    change_id: asStableId(record.change_id, `${context}.change_id`),
    action: asAllowed(record.action, ARCHITECTURE_CHANGE_ACTIONS, `${context}.action`),
    target_kind: asAllowed(
      record.target_kind,
      ARCHITECTURE_TARGET_KINDS,
      `${context}.target_kind`,
    ),
    target_id: asStableId(record.target_id, `${context}.target_id`),
    description: asOneLine(record.description, `${context}.description`),
  };
}

function parseDecisionDraft(
  value: unknown,
  context: string,
): ArchitectureDecisionDraft {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "decision_id",
      "title",
      "context",
      "decision",
      "rationale",
      "requirement_ids",
      "current_entity_refs",
      "planned_changes",
      "alternatives",
      "consequences",
      "reversibility",
    ],
    context,
  );
  const decisionId = asOneLine(record.decision_id, `${context}.decision_id`);
  if (!/^ADR-\d{3}$/.test(decisionId)) {
    fail(`${context}.decision_id`, "must match ADR-001");
  }
  if (!Array.isArray(record.planned_changes)) {
    fail(`${context}.planned_changes`, "must be an array");
  }
  const plannedChanges = record.planned_changes.map((entry, index) =>
    parsePlannedChange(entry, `${context}.planned_changes[${index}]`)
  );
  if (plannedChanges.length === 0) {
    fail(`${context}.planned_changes`, "must contain at least one planned change");
  }
  const changeIds = plannedChanges.map((entry) => entry.change_id);
  const duplicateChange = changeIds.find((entry, index) => changeIds.indexOf(entry) !== index);
  if (duplicateChange !== undefined) {
    fail(`${context}.planned_changes`, `contains duplicate change ID: ${duplicateChange}`);
  }
  return {
    decision_id: decisionId,
    title: asOneLine(record.title, `${context}.title`),
    context: asOneLine(record.context, `${context}.context`),
    decision: asOneLine(record.decision, `${context}.decision`),
    rationale: asOneLine(record.rationale, `${context}.rationale`),
    requirement_ids: asUniqueStrings(
      record.requirement_ids,
      `${context}.requirement_ids`,
      1,
      asRequirementId,
    ),
    current_entity_refs: asUniqueStrings(
      record.current_entity_refs,
      `${context}.current_entity_refs`,
      0,
      asStableId,
    ),
    planned_changes: plannedChanges,
    alternatives: asUniqueStrings(record.alternatives, `${context}.alternatives`, 1),
    consequences: asUniqueStrings(record.consequences, `${context}.consequences`, 1),
    reversibility: asAllowed(
      record.reversibility,
      ARCHITECTURE_REVERSIBILITY,
      `${context}.reversibility`,
    ),
  };
}

function parseDecisionDrafts(value: unknown, context: string): ArchitectureDecisionDraft[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const decisions = value.map((entry, index) =>
    parseDecisionDraft(entry, `${context}[${index}]`)
  );
  const ids = decisions.map((entry) => entry.decision_id);
  const duplicate = ids.find((entry, index) => ids.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate decision ID: ${duplicate}`);
  return decisions;
}

export function parseArchitectureWorkRequest(
  value: unknown,
  context = "Architecture Work Request",
): ArchitectureWorkRequest {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(record, [
    "schema_version",
    "artifact",
    "version",
    "intent_id",
    "stage_id",
    "requirements_current_ref",
    "requirements_ref",
    "current_context_ref",
    "system_map_ref",
    "effective_policy_ref",
    "base_revision",
    "base_architecture_ref",
    "requirement_ids",
    "requested_outputs",
    "rules",
    "created_at",
  ], context);
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "architecture-work-request") {
    fail(`${context}.artifact`, "must equal architecture-work-request");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.stage_id !== "ST-04") fail(`${context}.stage_id`, "must equal ST-04");
  if (
    !Array.isArray(record.requested_outputs) || record.requested_outputs.length !== 1 ||
    record.requested_outputs[0] !== "architecture-assessment-proposal"
  ) {
    fail(`${context}.requested_outputs`, "must contain architecture-assessment-proposal only");
  }
  return {
    schema_version: 1,
    artifact: "architecture-work-request",
    version: 1,
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    stage_id: "ST-04",
    requirements_current_ref: parseArtifactReference(
      record.requirements_current_ref,
      `${context}.requirements_current_ref`,
    ),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    current_context_ref: parseArtifactReference(
      record.current_context_ref,
      `${context}.current_context_ref`,
    ),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    effective_policy_ref: parseArtifactReference(
      record.effective_policy_ref,
      `${context}.effective_policy_ref`,
    ),
    base_revision: asNullableRevision(record.base_revision, `${context}.base_revision`),
    base_architecture_ref: asNullableReference(
      record.base_architecture_ref,
      `${context}.base_architecture_ref`,
    ),
    requirement_ids: asUniqueStrings(
      record.requirement_ids,
      `${context}.requirement_ids`,
      1,
      asRequirementId,
    ),
    requested_outputs: ["architecture-assessment-proposal"],
    rules: asUniqueStrings(record.rules, `${context}.rules`, 1),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseArchitectureAssessmentProposal(
  value: unknown,
  context = "Architecture Assessment Proposal",
): ArchitectureAssessmentProposal {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(record, [
    "schema_version",
    "artifact",
    "version",
    "proposal_id",
    "intent_id",
    "work_request_sha256",
    "disposition",
    "requirement_assessments",
    "decisions",
    "reuse_ref",
    "approval_ref",
    "evidence",
    "reason",
    "proposed_by",
  ], context);
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "architecture-assessment-proposal") {
    fail(`${context}.artifact`, "must equal architecture-assessment-proposal");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.proposed_by !== "ai") fail(`${context}.proposed_by`, "must equal ai");
  const disposition = asAllowed(
    record.disposition,
    ARCHITECTURE_DISPOSITIONS,
    `${context}.disposition`,
  );
  const decisions = parseDecisionDrafts(record.decisions, `${context}.decisions`);
  const reuseRef = asNullableReference(record.reuse_ref, `${context}.reuse_ref`);
  const approvalRef = asNullableReference(record.approval_ref, `${context}.approval_ref`);
  if (disposition === "execute") {
    if (decisions.length === 0) fail(context, "execute requires at least one decision");
    if (reuseRef !== null) fail(context, "execute cannot contain reuse_ref");
    if (approvalRef !== null && approvalRef.artifact !== "human-decision") {
      fail(context, "execute approval_ref must reference a human-decision");
    }
  } else if (disposition === "reuse") {
    if (decisions.length !== 0) fail(context, "reuse cannot contain decisions");
    if (reuseRef === null || approvalRef === null) {
      fail(context, "reuse requires reuse_ref and approval_ref");
    }
  } else {
    if (decisions.length !== 0) fail(context, "not_applicable cannot contain decisions");
    if (reuseRef !== null || approvalRef !== null) {
      fail(context, "not_applicable cannot contain reuse_ref or approval_ref");
    }
  }
  return {
    schema_version: 1,
    artifact: "architecture-assessment-proposal",
    version: 1,
    proposal_id: asStableId(record.proposal_id, `${context}.proposal_id`),
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    work_request_sha256: asSha256(record.work_request_sha256, `${context}.work_request_sha256`),
    disposition,
    requirement_assessments: parseAssessments(
      record.requirement_assessments,
      `${context}.requirement_assessments`,
    ),
    decisions,
    reuse_ref: reuseRef,
    approval_ref: approvalRef,
    evidence: asReferences(record.evidence, `${context}.evidence`),
    reason: asOneLine(record.reason, `${context}.reason`),
    proposed_by: "ai",
  };
}

export function parseArchitectureDecision(
  value: unknown,
  context = "Architecture Decision",
): ArchitectureDecision {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(record, [
    "schema_version",
    "artifact",
    "version",
    "intent_id",
    "revision",
    "base_revision",
    "proposal_id",
    "requirements_ref",
    "current_context_ref",
    "system_map_ref",
    "effective_policy_ref",
    "requirement_assessments",
    "decisions",
    "reason",
    "created_at",
  ], context);
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "architecture-decision") {
    fail(`${context}.artifact`, "must equal architecture-decision");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  const decisions = parseDecisionDrafts(record.decisions, `${context}.decisions`);
  if (decisions.length === 0) fail(`${context}.decisions`, "must contain at least one decision");
  return {
    schema_version: 1,
    artifact: "architecture-decision",
    version: 1,
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    revision: asPositiveInteger(record.revision, `${context}.revision`),
    base_revision: asNullableRevision(record.base_revision, `${context}.base_revision`),
    proposal_id: asStableId(record.proposal_id, `${context}.proposal_id`),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    current_context_ref: parseArtifactReference(
      record.current_context_ref,
      `${context}.current_context_ref`,
    ),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    effective_policy_ref: parseArtifactReference(
      record.effective_policy_ref,
      `${context}.effective_policy_ref`,
    ),
    requirement_assessments: parseAssessments(
      record.requirement_assessments,
      `${context}.requirement_assessments`,
    ),
    decisions,
    reason: asOneLine(record.reason, `${context}.reason`),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseArchitectureCurrent(
  value: unknown,
  context = "Architecture Current",
): ArchitectureCurrent {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(record, [
    "schema_version",
    "artifact",
    "version",
    "intent_id",
    "disposition",
    "architecture_ref",
    "requirements_ref",
    "current_context_ref",
    "system_map_ref",
    "effective_policy_ref",
    "requirement_assessments",
    "evidence",
    "reason",
    "updated_at",
  ], context);
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "architecture-current") {
    fail(`${context}.artifact`, "must equal architecture-current");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  const disposition = asAllowed(
    record.disposition,
    ARCHITECTURE_DISPOSITIONS,
    `${context}.disposition`,
  );
  const architectureRef = asNullableReference(
    record.architecture_ref,
    `${context}.architecture_ref`,
  );
  if (disposition === "not_applicable" && architectureRef !== null) {
    fail(context, "not_applicable cannot point to an Architecture Decision");
  }
  if (disposition !== "not_applicable" && architectureRef === null) {
    fail(context, `${disposition} must point to an Architecture Decision`);
  }
  return {
    schema_version: 1,
    artifact: "architecture-current",
    version: 1,
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    disposition,
    architecture_ref: architectureRef,
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    current_context_ref: parseArtifactReference(
      record.current_context_ref,
      `${context}.current_context_ref`,
    ),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    effective_policy_ref: parseArtifactReference(
      record.effective_policy_ref,
      `${context}.effective_policy_ref`,
    ),
    requirement_assessments: parseAssessments(
      record.requirement_assessments,
      `${context}.requirement_assessments`,
    ),
    evidence: asReferences(record.evidence, `${context}.evidence`),
    reason: asOneLine(record.reason, `${context}.reason`),
    updated_at: asIsoTimestamp(record.updated_at, `${context}.updated_at`),
  };
}

export function parseArchitectureReuseApproval(
  value: unknown,
  context = "Architecture Reuse Approval",
): ArchitectureReuseApproval {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(record, [
    "schema_version",
    "artifact",
    "version",
    "decision_id",
    "decision_kind",
    "intent_id",
    "approved_architecture_ref",
    "requirements_ref",
    "decision",
    "reason",
    "decided_by",
    "decided_at",
  ], context);
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "human-decision") fail(`${context}.artifact`, "must equal human-decision");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.decision_kind !== "approval") fail(`${context}.decision_kind`, "must equal approval");
  if (record.decision !== "approve-reuse") fail(`${context}.decision`, "must equal approve-reuse");
  if (record.decided_by !== "human") fail(`${context}.decided_by`, "must equal human");
  return {
    schema_version: 1,
    artifact: "human-decision",
    version: 1,
    decision_id: asStableId(record.decision_id, `${context}.decision_id`),
    decision_kind: "approval",
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    approved_architecture_ref: parseArtifactReference(
      record.approved_architecture_ref,
      `${context}.approved_architecture_ref`,
    ),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    decision: "approve-reuse",
    reason: asOneLine(record.reason, `${context}.reason`),
    decided_by: "human",
    decided_at: asIsoTimestamp(record.decided_at, `${context}.decided_at`),
  };
}

export function parseArchitecturePolicyApproval(
  value: unknown,
  context = "Architecture Policy Approval",
): ArchitecturePolicyApproval {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(record, [
    "schema_version",
    "artifact",
    "version",
    "decision_id",
    "intent_id",
    "proposal_ref",
    "gate_requirement_set_ref",
    "policy_acknowledgements",
    "decision",
    "reason",
    "decided_by",
    "decided_at",
  ], context);
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "architecture-policy-approval") {
    fail(`${context}.artifact`, "must equal architecture-policy-approval");
  }
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.decision !== "approve-architecture-policy") {
    fail(`${context}.decision`, "must equal approve-architecture-policy");
  }
  if (record.decided_by !== "human") fail(`${context}.decided_by`, "must equal human");
  if (!Array.isArray(record.policy_acknowledgements)) {
    fail(`${context}.policy_acknowledgements`, "must be an array");
  }
  return {
    schema_version: 1,
    artifact: "architecture-policy-approval",
    version: 1,
    decision_id: asStableId(record.decision_id, `${context}.decision_id`),
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    proposal_ref: parseArtifactReference(record.proposal_ref, `${context}.proposal_ref`),
    gate_requirement_set_ref: parseArtifactReference(
      record.gate_requirement_set_ref,
      `${context}.gate_requirement_set_ref`,
    ),
    policy_acknowledgements: record.policy_acknowledgements.map((entry, index) =>
      parsePolicyAcknowledgement(entry, `${context}.policy_acknowledgements[${index}]`)
    ),
    decision: "approve-architecture-policy",
    reason: asOneLine(record.reason, `${context}.reason`),
    decided_by: "human",
    decided_at: asIsoTimestamp(record.decided_at, `${context}.decided_at`),
  };
}
