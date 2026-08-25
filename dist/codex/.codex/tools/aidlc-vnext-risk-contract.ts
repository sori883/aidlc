import {
  INTENT_RISK_SEVERITIES,
  type IntentRiskSeverity,
} from "./aidlc-effective-policy.ts";
import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";

export const INTENT_RISK_SCHEMA_VERSION = 1 as const;
export const INTENT_RISK_ARTIFACT_VERSION = 1 as const;
export const INTENT_RISK_STATUSES = ["active", "resolved", "dismissed"] as const;
export const INTENT_RISK_DECISIONS = [
  "dismiss",
  "resolve",
  "set-severity",
] as const;

export type IntentRiskStatus = (typeof INTENT_RISK_STATUSES)[number];
export type IntentRiskDecisionAction = (typeof INTENT_RISK_DECISIONS)[number];

export interface IntentRiskSeed {
  risk_id: string;
  severity: IntentRiskSeverity;
  statement: string;
  evidence_refs: ArtifactReference[];
}

export interface IntentRiskEntry extends IntentRiskSeed {
  status: IntentRiskStatus;
  last_decision_ref: ArtifactReference | null;
}

export interface IntentRiskRegister {
  schema_version: typeof INTENT_RISK_SCHEMA_VERSION;
  artifact: "intent-risk-register";
  version: typeof INTENT_RISK_ARTIFACT_VERSION;
  intent_id: string;
  revision: number;
  base_revision: number | null;
  risks: IntentRiskEntry[];
  created_at: string;
}

export interface IntentRiskCurrent {
  schema_version: typeof INTENT_RISK_SCHEMA_VERSION;
  artifact: "intent-risk-current";
  version: typeof INTENT_RISK_ARTIFACT_VERSION;
  intent_id: string;
  current_revision: number;
  register_ref: ArtifactReference;
  updated_at: string;
}

export interface IntentRiskProposal {
  schema_version: typeof INTENT_RISK_SCHEMA_VERSION;
  artifact: "intent-risk-proposal";
  version: typeof INTENT_RISK_ARTIFACT_VERSION;
  proposal_id: string;
  intent_id: string;
  base_revision: number;
  risks: IntentRiskSeed[];
  reason: string;
  proposed_by: "ai" | "human";
  proposed_at: string;
}

export interface IntentRiskDecision {
  schema_version: typeof INTENT_RISK_SCHEMA_VERSION;
  artifact: "intent-risk-decision";
  version: typeof INTENT_RISK_ARTIFACT_VERSION;
  decision_id: string;
  intent_id: string;
  risk_id: string;
  action: IntentRiskDecisionAction;
  severity: IntentRiskSeverity | null;
  evidence_refs: ArtifactReference[];
  reason: string;
  decided_by: "human";
  decided_at: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}

function text(value: unknown, context: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value !== value.trim() ||
    /[\r\n\0]/.test(value)
  ) fail(context, "must be a non-empty single-line string");
  return value;
}

function id(value: unknown, context: string): string {
  const parsed = text(value, context);
  if (!ID_PATTERN.test(parsed)) fail(context, "must be a stable lowercase identifier");
  return parsed;
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(context, "must be a positive integer");
  }
  return value as number;
}

function timestamp(value: unknown, context: string): string {
  const parsed = text(value, context);
  if (Number.isNaN(Date.parse(parsed)) || !parsed.endsWith("Z")) {
    fail(context, "must be an ISO-8601 UTC timestamp");
  }
  return parsed;
}

function allowed<T extends string>(
  value: unknown,
  values: readonly T[],
  context: string,
): T {
  const parsed = text(value, context);
  if (!(values as readonly string[]).includes(parsed)) {
    fail(context, `must be one of: ${values.join(", ")}`);
  }
  return parsed as T;
}

function references(value: unknown, context: string): ArtifactReference[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  return value.map((entry, index) =>
    parseArtifactReference(entry, `${context}[${index}]`)
  );
}

export function parseIntentRiskSeed(
  value: unknown,
  context = "Intent Risk",
): IntentRiskSeed {
  const item = record(value, context);
  rejectUnknown(
    item,
    ["risk_id", "severity", "statement", "evidence_refs"],
    context,
  );
  return {
    risk_id: id(item.risk_id, `${context}.risk_id`),
    severity: allowed(
      item.severity,
      INTENT_RISK_SEVERITIES,
      `${context}.severity`,
    ),
    statement: text(item.statement, `${context}.statement`),
    evidence_refs: references(item.evidence_refs, `${context}.evidence_refs`),
  };
}

export function parseIntentRiskEntry(
  value: unknown,
  context = "Intent Risk entry",
): IntentRiskEntry {
  const item = record(value, context);
  rejectUnknown(
    item,
    [
      "risk_id",
      "severity",
      "statement",
      "status",
      "evidence_refs",
      "last_decision_ref",
    ],
    context,
  );
  const seed = parseIntentRiskSeed({
    risk_id: item.risk_id,
    severity: item.severity,
    statement: item.statement,
    evidence_refs: item.evidence_refs,
  }, context);
  return {
    ...seed,
    status: allowed(item.status, INTENT_RISK_STATUSES, `${context}.status`),
    last_decision_ref: item.last_decision_ref === null
      ? null
      : parseArtifactReference(item.last_decision_ref, `${context}.last_decision_ref`),
  };
}

function parseRiskList<T>(
  value: unknown,
  parser: (entry: unknown, context: string) => T,
  context: string,
  minimum = 0,
): T[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  if (value.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  const parsed = value.map((entry, index) => parser(entry, `${context}[${index}]`));
  const ids = parsed.map((entry) => (entry as { risk_id: string }).risk_id);
  const duplicate = ids.find((riskId, index) => ids.indexOf(riskId) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate risk_id: ${duplicate}`);
  return parsed;
}

export function parseIntentRiskRegister(
  value: unknown,
  context = "Intent Risk Register",
): IntentRiskRegister {
  const item = record(value, context);
  rejectUnknown(
    item,
    [
      "schema_version",
      "artifact",
      "version",
      "intent_id",
      "revision",
      "base_revision",
      "risks",
      "created_at",
    ],
    context,
  );
  if (item.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (item.artifact !== "intent-risk-register") {
    fail(`${context}.artifact`, "must equal intent-risk-register");
  }
  if (item.version !== 1) fail(`${context}.version`, "must equal 1");
  const revision = positiveInteger(item.revision, `${context}.revision`);
  const baseRevision = item.base_revision === null
    ? null
    : positiveInteger(item.base_revision, `${context}.base_revision`);
  if (
    (revision === 1 && baseRevision !== null) ||
    (revision > 1 && baseRevision !== revision - 1)
  ) fail(context, "base_revision must be null for revision 1 or the previous revision");
  return {
    schema_version: 1,
    artifact: "intent-risk-register",
    version: 1,
    intent_id: text(item.intent_id, `${context}.intent_id`),
    revision,
    base_revision: baseRevision,
    risks: parseRiskList(item.risks, parseIntentRiskEntry, `${context}.risks`),
    created_at: timestamp(item.created_at, `${context}.created_at`),
  };
}

export function parseIntentRiskCurrent(
  value: unknown,
  context = "Intent Risk Current",
): IntentRiskCurrent {
  const item = record(value, context);
  rejectUnknown(
    item,
    [
      "schema_version",
      "artifact",
      "version",
      "intent_id",
      "current_revision",
      "register_ref",
      "updated_at",
    ],
    context,
  );
  if (item.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (item.artifact !== "intent-risk-current") {
    fail(`${context}.artifact`, "must equal intent-risk-current");
  }
  if (item.version !== 1) fail(`${context}.version`, "must equal 1");
  return {
    schema_version: 1,
    artifact: "intent-risk-current",
    version: 1,
    intent_id: text(item.intent_id, `${context}.intent_id`),
    current_revision: positiveInteger(
      item.current_revision,
      `${context}.current_revision`,
    ),
    register_ref: parseArtifactReference(
      item.register_ref,
      `${context}.register_ref`,
    ),
    updated_at: timestamp(item.updated_at, `${context}.updated_at`),
  };
}

export function parseIntentRiskProposal(
  value: unknown,
  context = "Intent Risk Proposal",
): IntentRiskProposal {
  const item = record(value, context);
  rejectUnknown(
    item,
    [
      "schema_version",
      "artifact",
      "version",
      "proposal_id",
      "intent_id",
      "base_revision",
      "risks",
      "reason",
      "proposed_by",
      "proposed_at",
    ],
    context,
  );
  if (item.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (item.artifact !== "intent-risk-proposal") {
    fail(`${context}.artifact`, "must equal intent-risk-proposal");
  }
  if (item.version !== 1) fail(`${context}.version`, "must equal 1");
  return {
    schema_version: 1,
    artifact: "intent-risk-proposal",
    version: 1,
    proposal_id: id(item.proposal_id, `${context}.proposal_id`),
    intent_id: text(item.intent_id, `${context}.intent_id`),
    base_revision: positiveInteger(item.base_revision, `${context}.base_revision`),
    risks: parseRiskList(
      item.risks,
      parseIntentRiskSeed,
      `${context}.risks`,
      1,
    ),
    reason: text(item.reason, `${context}.reason`),
    proposed_by: allowed(
      item.proposed_by,
      ["ai", "human"] as const,
      `${context}.proposed_by`,
    ),
    proposed_at: timestamp(item.proposed_at, `${context}.proposed_at`),
  };
}

export function parseIntentRiskDecision(
  value: unknown,
  context = "Intent Risk Decision",
): IntentRiskDecision {
  const item = record(value, context);
  rejectUnknown(
    item,
    [
      "schema_version",
      "artifact",
      "version",
      "decision_id",
      "intent_id",
      "risk_id",
      "action",
      "severity",
      "evidence_refs",
      "reason",
      "decided_by",
      "decided_at",
    ],
    context,
  );
  if (item.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (item.artifact !== "intent-risk-decision") {
    fail(`${context}.artifact`, "must equal intent-risk-decision");
  }
  if (item.version !== 1) fail(`${context}.version`, "must equal 1");
  if (item.decided_by !== "human") {
    fail(`${context}.decided_by`, "must equal human");
  }
  const action = allowed(
    item.action,
    INTENT_RISK_DECISIONS,
    `${context}.action`,
  );
  const severity = item.severity === null
    ? null
    : allowed(item.severity, INTENT_RISK_SEVERITIES, `${context}.severity`);
  if ((action === "set-severity") !== (severity !== null)) {
    fail(context, "set-severity requires severity and other actions require null severity");
  }
  const evidenceRefs = references(item.evidence_refs, `${context}.evidence_refs`);
  if (action === "resolve" && evidenceRefs.length === 0) {
    fail(`${context}.evidence_refs`, "resolve requires Evidence");
  }
  return {
    schema_version: 1,
    artifact: "intent-risk-decision",
    version: 1,
    decision_id: id(item.decision_id, `${context}.decision_id`),
    intent_id: text(item.intent_id, `${context}.intent_id`),
    risk_id: id(item.risk_id, `${context}.risk_id`),
    action,
    severity,
    evidence_refs: evidenceRefs,
    reason: text(item.reason, `${context}.reason`),
    decided_by: "human",
    decided_at: timestamp(item.decided_at, `${context}.decided_at`),
  };
}
