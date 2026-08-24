import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";

export const ORIENT_SCHEMA_VERSION = 1 as const;
export const ORIENT_ARTIFACT_VERSION = 1 as const;
export const SYSTEM_MAP_PERSPECTIVE = "accepted-code-baseline" as const;

export const SOURCE_TYPES = ["git", "directory", "external"] as const;
export const EVIDENCE_TYPES = ["file", "external-record"] as const;
export const COVERAGE_STATUSES = ["observed", "unobserved", "stale", "unknown"] as const;
export const CURRENT_STATES = ["observed", "stale", "unknown"] as const;
export const ENTITY_TYPES = [
  "component",
  "runtime",
  "resource",
  "boundary",
  "external-system",
] as const;
export const CAPABILITIES = [
  "user-interface",
  "api",
  "worker",
  "web-hosting",
  "container-compute",
  "function-compute",
  "relational-database",
  "object-storage",
  "message-queue",
  "identity-provider",
  "cdn",
  "dns",
  "cache",
  "network",
  "other",
] as const;
export const RELATION_TYPES = [
  "deployed-on",
  "calls",
  "reads-writes",
  "invokes",
  "contained-in",
  "routes-to",
  "publishes-to",
  "subscribes-to",
  "depends-on",
  "uses",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
export type CurrentState = (typeof CURRENT_STATES)[number];
export type EntityType = (typeof ENTITY_TYPES)[number];
export type Capability = (typeof CAPABILITIES)[number];
export type RelationType = (typeof RELATION_TYPES)[number];

export interface SourceSnapshot {
  source_id: string;
  source_type: SourceType;
  locator: string;
  revision: string;
  dirty: boolean;
  observed_at: string;
  expires_at?: string;
}

export interface MapEvidence {
  evidence_id: string;
  source_id: string;
  evidence_type: EvidenceType;
  locator: string;
  sha256: string;
  observed_at: string;
}

export interface MapCoverage {
  coverage_id: string;
  scope: string;
  status: CoverageStatus;
  evidence_refs: string[];
  observed_at: string;
}

export interface MapProvider {
  name: string;
  service: string;
  resource_type?: string;
  extensions?: Record<string, string | number | boolean | null>;
}

export interface MapEntity {
  entity_id: string;
  name: string;
  entity_type: EntityType;
  capability: Capability;
  current_state: CurrentState;
  provider?: MapProvider;
  evidence_refs: string[];
}

export interface MapRelation {
  relation_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: RelationType;
  current_state: CurrentState;
  evidence_refs: string[];
}

export interface WorkspaceProfile {
  schema_version: typeof ORIENT_SCHEMA_VERSION;
  artifact: "workspace-profile";
  version: typeof ORIENT_ARTIFACT_VERSION;
  intent_id: string;
  space: string;
  repository_snapshots: SourceSnapshot[];
  observed_at: string;
}

export interface DesignBrief {
  schema_version: typeof ORIENT_SCHEMA_VERSION;
  artifact: "design-brief";
  version: typeof ORIENT_ARTIFACT_VERSION;
  intent_id: string;
  statement: string;
  created_at: string;
}

export interface OrientWorkRequest {
  schema_version: typeof ORIENT_SCHEMA_VERSION;
  artifact: "orient-work-request";
  version: typeof ORIENT_ARTIFACT_VERSION;
  intent_id: string;
  stage_id: "ST-01";
  design_brief_ref: ArtifactReference;
  bootstrap_receipt_ref: ArtifactReference;
  workspace_profile_ref: ArtifactReference;
  system_map_baseline_ref?: ArtifactReference;
  requested_outputs: ["system-map-patch", "current-context-proposal"];
  rules: string[];
  created_at: string;
}

export interface SystemMapPatch {
  schema_version: typeof ORIENT_SCHEMA_VERSION;
  artifact: "system-map-patch";
  version: typeof ORIENT_ARTIFACT_VERSION;
  proposal_id: string;
  map_id: string;
  base_revision: number | null;
  perspective: typeof SYSTEM_MAP_PERSPECTIVE;
  source_snapshots: SourceSnapshot[];
  evidence: MapEvidence[];
  coverage_upserts: MapCoverage[];
  entity_upserts: MapEntity[];
  relation_upserts: MapRelation[];
  remove_entity_ids: string[];
  remove_relation_ids: string[];
  reason: string;
  proposed_at: string;
  proposed_by: "ai";
}

export interface CurrentContextProposal {
  entity_ids: string[];
  relation_ids: string[];
  additional_findings: string[];
  out_of_scope: string[];
  intent_only_notes: string[];
  unknowns: string[];
}

export interface OrientProposal {
  schema_version: typeof ORIENT_SCHEMA_VERSION;
  artifact: "orient-proposal";
  version: typeof ORIENT_ARTIFACT_VERSION;
  intent_id: string;
  work_request_sha256: string;
  system_map_patch: SystemMapPatch;
  current_context: CurrentContextProposal;
  proposed_by: "ai";
}

export interface SystemMap {
  schema_version: typeof ORIENT_SCHEMA_VERSION;
  artifact: "system-map";
  version: typeof ORIENT_ARTIFACT_VERSION;
  map_id: string;
  revision: number;
  base_revision: number | null;
  baseline_kind: "imported" | "accepted";
  perspective: typeof SYSTEM_MAP_PERSPECTIVE;
  source_snapshots: SourceSnapshot[];
  evidence: MapEvidence[];
  coverage: MapCoverage[];
  entities: MapEntity[];
  relations: MapRelation[];
  created_at: string;
}

export interface SystemMapBaseline {
  schema_version: typeof ORIENT_SCHEMA_VERSION;
  artifact: "system-map-baseline";
  version: typeof ORIENT_ARTIFACT_VERSION;
  map_id: string;
  revision: number;
  source_of_truth: string;
  sha256: string;
}

export interface CurrentContext {
  schema_version: typeof ORIENT_SCHEMA_VERSION;
  artifact: "current-context";
  version: typeof ORIENT_ARTIFACT_VERSION;
  intent_id: string;
  design_brief_ref: ArtifactReference;
  workspace_profile_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  system_map_revision: number;
  entity_ids: string[];
  relation_ids: string[];
  additional_findings: string[];
  out_of_scope: string[];
  intent_only_notes: string[];
  unknowns: string[];
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

function asPositiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(context, "must be a positive integer");
  }
  return value as number;
}

function asBaseRevision(value: unknown, context: string): number | null {
  if (value === null) return null;
  return asPositiveInteger(value, context);
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
  options: { ids?: boolean; min?: number } = {},
): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const values = value.map((entry, index) =>
    options.ids ? asId(entry, `${context}[${index}]`) : asOneLine(entry, `${context}[${index}]`)
  );
  if (values.length < (options.min ?? 0)) {
    fail(context, `must contain at least ${options.min} item(s)`);
  }
  const duplicate = values.find((entry, index) => values.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate value: ${duplicate}`);
  return values;
}

function assertUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  context: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) fail(context, `duplicate ${label}: ${id}`);
    seen.add(id);
  }
}

function parseSourceSnapshot(value: unknown, context: string): SourceSnapshot {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["source_id", "source_type", "locator", "revision", "dirty", "observed_at", "expires_at"],
    context,
  );
  const sourceType = asAllowed(record.source_type, SOURCE_TYPES, `${context}.source_type`);
  if (typeof record.dirty !== "boolean") fail(`${context}.dirty`, "must be a boolean");
  const expiresAt = record.expires_at === undefined
    ? undefined
    : asIsoTimestamp(record.expires_at, `${context}.expires_at`);
  if (sourceType === "external" && expiresAt === undefined) {
    fail(`${context}.expires_at`, "is required for external sources");
  }
  if (sourceType !== "external" && expiresAt !== undefined) {
    fail(`${context}.expires_at`, "is allowed only for external sources");
  }
  if (sourceType === "external" && record.dirty === true) {
    fail(`${context}.dirty`, "must be false for external sources");
  }
  return {
    source_id: asId(record.source_id, `${context}.source_id`),
    source_type: sourceType,
    locator: asOneLine(record.locator, `${context}.locator`),
    revision: asOneLine(record.revision, `${context}.revision`),
    dirty: record.dirty,
    observed_at: asIsoTimestamp(record.observed_at, `${context}.observed_at`),
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  };
}

function parseSourceSnapshots(value: unknown, context: string): SourceSnapshot[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(context, "must contain at least one source snapshot");
  }
  const snapshots = value.map((entry, index) =>
    parseSourceSnapshot(entry, `${context}[${index}]`)
  );
  assertUniqueBy(snapshots, (entry) => entry.source_id, "source_id", context);
  return snapshots;
}

function parseEvidence(value: unknown, context: string): MapEvidence[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const evidence = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(entry, itemContext);
    rejectUnknownKeys(
      record,
      ["evidence_id", "source_id", "evidence_type", "locator", "sha256", "observed_at"],
      itemContext,
    );
    return {
      evidence_id: asId(record.evidence_id, `${itemContext}.evidence_id`),
      source_id: asId(record.source_id, `${itemContext}.source_id`),
      evidence_type: asAllowed(record.evidence_type, EVIDENCE_TYPES, `${itemContext}.evidence_type`),
      locator: asOneLine(record.locator, `${itemContext}.locator`),
      sha256: asSha256(record.sha256, `${itemContext}.sha256`),
      observed_at: asIsoTimestamp(record.observed_at, `${itemContext}.observed_at`),
    };
  });
  assertUniqueBy(evidence, (entry) => entry.evidence_id, "evidence_id", context);
  return evidence;
}

function parseCoverage(value: unknown, context: string): MapCoverage[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const coverage = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(entry, itemContext);
    rejectUnknownKeys(
      record,
      ["coverage_id", "scope", "status", "evidence_refs", "observed_at"],
      itemContext,
    );
    return {
      coverage_id: asId(record.coverage_id, `${itemContext}.coverage_id`),
      scope: asOneLine(record.scope, `${itemContext}.scope`),
      status: asAllowed(record.status, COVERAGE_STATUSES, `${itemContext}.status`),
      evidence_refs: asUniqueStrings(record.evidence_refs, `${itemContext}.evidence_refs`, { ids: true }),
      observed_at: asIsoTimestamp(record.observed_at, `${itemContext}.observed_at`),
    };
  });
  assertUniqueBy(coverage, (entry) => entry.coverage_id, "coverage_id", context);
  return coverage;
}

function parseExtensions(
  value: unknown,
  context: string,
): Record<string, string | number | boolean | null> {
  const record = asRecord(value, context);
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!ID_PATTERN.test(key)) fail(`${context}.${key}`, "extension key has an invalid format");
    if (
      entry !== null && typeof entry !== "string" && typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) fail(`${context}.${key}`, "extension value must be a scalar");
    output[key] = entry as string | number | boolean | null;
  }
  return output;
}

function parseProvider(value: unknown, context: string): MapProvider {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["name", "service", "resource_type", "extensions"], context);
  return {
    name: asOneLine(record.name, `${context}.name`),
    service: asOneLine(record.service, `${context}.service`),
    ...(record.resource_type === undefined
      ? {}
      : { resource_type: asOneLine(record.resource_type, `${context}.resource_type`) }),
    ...(record.extensions === undefined
      ? {}
      : { extensions: parseExtensions(record.extensions, `${context}.extensions`) }),
  };
}

function parseEntities(value: unknown, context: string): MapEntity[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const entities = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(entry, itemContext);
    rejectUnknownKeys(
      record,
      ["entity_id", "name", "entity_type", "capability", "current_state", "provider", "evidence_refs"],
      itemContext,
    );
    return {
      entity_id: asId(record.entity_id, `${itemContext}.entity_id`),
      name: asOneLine(record.name, `${itemContext}.name`),
      entity_type: asAllowed(record.entity_type, ENTITY_TYPES, `${itemContext}.entity_type`),
      capability: asAllowed(record.capability, CAPABILITIES, `${itemContext}.capability`),
      current_state: asAllowed(record.current_state, CURRENT_STATES, `${itemContext}.current_state`),
      ...(record.provider === undefined
        ? {}
        : { provider: parseProvider(record.provider, `${itemContext}.provider`) }),
      evidence_refs: asUniqueStrings(record.evidence_refs, `${itemContext}.evidence_refs`, { ids: true }),
    };
  });
  assertUniqueBy(entities, (entry) => entry.entity_id, "entity_id", context);
  return entities;
}

function parseRelations(value: unknown, context: string): MapRelation[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const relations = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(entry, itemContext);
    rejectUnknownKeys(
      record,
      ["relation_id", "from_entity_id", "to_entity_id", "relation_type", "current_state", "evidence_refs"],
      itemContext,
    );
    return {
      relation_id: asId(record.relation_id, `${itemContext}.relation_id`),
      from_entity_id: asId(record.from_entity_id, `${itemContext}.from_entity_id`),
      to_entity_id: asId(record.to_entity_id, `${itemContext}.to_entity_id`),
      relation_type: asAllowed(record.relation_type, RELATION_TYPES, `${itemContext}.relation_type`),
      current_state: asAllowed(record.current_state, CURRENT_STATES, `${itemContext}.current_state`),
      evidence_refs: asUniqueStrings(record.evidence_refs, `${itemContext}.evidence_refs`, { ids: true }),
    };
  });
  assertUniqueBy(relations, (entry) => entry.relation_id, "relation_id", context);
  return relations;
}

function validateMapReferences(
  sources: readonly SourceSnapshot[],
  evidence: readonly MapEvidence[],
  coverage: readonly MapCoverage[],
  entities: readonly MapEntity[],
  relations: readonly MapRelation[],
  context: string,
): void {
  const sourceIds = new Set(sources.map((entry) => entry.source_id));
  for (const item of evidence) {
    if (!sourceIds.has(item.source_id)) {
      fail(context, `Evidence ${item.evidence_id} refers to unknown source_id: ${item.source_id}`);
    }
  }
  const evidenceIds = new Set(evidence.map((entry) => entry.evidence_id));
  for (const item of [...coverage, ...entities, ...relations]) {
    for (const evidenceRef of item.evidence_refs) {
      if (!evidenceIds.has(evidenceRef)) {
        fail(context, `unknown evidence_ref: ${evidenceRef}`);
      }
    }
  }
  const entityIds = new Set(entities.map((entry) => entry.entity_id));
  for (const relation of relations) {
    for (const endpoint of [relation.from_entity_id, relation.to_entity_id]) {
      if (!entityIds.has(endpoint)) fail(context, `unknown relation endpoint: ${endpoint}`);
    }
  }
}

function parseCurrentContextProposal(
  value: unknown,
  context: string,
): CurrentContextProposal {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["entity_ids", "relation_ids", "additional_findings", "out_of_scope", "intent_only_notes", "unknowns"],
    context,
  );
  return {
    entity_ids: asUniqueStrings(record.entity_ids, `${context}.entity_ids`, { ids: true }),
    relation_ids: asUniqueStrings(record.relation_ids, `${context}.relation_ids`, { ids: true }),
    additional_findings: asUniqueStrings(record.additional_findings, `${context}.additional_findings`),
    out_of_scope: asUniqueStrings(record.out_of_scope, `${context}.out_of_scope`),
    intent_only_notes: asUniqueStrings(record.intent_only_notes, `${context}.intent_only_notes`),
    unknowns: asUniqueStrings(record.unknowns, `${context}.unknowns`),
  };
}

export function parseWorkspaceProfile(
  value: unknown,
  context = "Workspace Profile",
): WorkspaceProfile {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["schema_version", "artifact", "version", "intent_id", "space", "repository_snapshots", "observed_at"],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "workspace-profile") fail(`${context}.artifact`, "must equal workspace-profile");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  const snapshots = parseSourceSnapshots(record.repository_snapshots, `${context}.repository_snapshots`);
  if (snapshots.some((entry) => entry.source_type === "external")) {
    fail(`${context}.repository_snapshots`, "cannot contain external sources");
  }
  return {
    schema_version: 1,
    artifact: "workspace-profile",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    space: asId(record.space, `${context}.space`),
    repository_snapshots: snapshots,
    observed_at: asIsoTimestamp(record.observed_at, `${context}.observed_at`),
  };
}

export function parseDesignBrief(value: unknown, context = "Design Brief"): DesignBrief {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["schema_version", "artifact", "version", "intent_id", "statement", "created_at"],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "design-brief") fail(`${context}.artifact`, "must equal design-brief");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  return {
    schema_version: 1,
    artifact: "design-brief",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    statement: asOneLine(record.statement, `${context}.statement`),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseOrientWorkRequest(
  value: unknown,
  context = "Orient Work Request",
): OrientWorkRequest {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "intent_id", "stage_id",
      "design_brief_ref", "bootstrap_receipt_ref", "workspace_profile_ref",
      "system_map_baseline_ref", "requested_outputs", "rules", "created_at",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "orient-work-request") fail(`${context}.artifact`, "must equal orient-work-request");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.stage_id !== "ST-01") fail(`${context}.stage_id`, "must equal ST-01");
  const requested = asUniqueStrings(record.requested_outputs, `${context}.requested_outputs`);
  if (JSON.stringify(requested) !== JSON.stringify(["system-map-patch", "current-context-proposal"])) {
    fail(`${context}.requested_outputs`, "must use the fixed ST-01 output order");
  }
  return {
    schema_version: 1,
    artifact: "orient-work-request",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    stage_id: "ST-01",
    design_brief_ref: parseArtifactReference(record.design_brief_ref, `${context}.design_brief_ref`),
    bootstrap_receipt_ref: parseArtifactReference(record.bootstrap_receipt_ref, `${context}.bootstrap_receipt_ref`),
    workspace_profile_ref: parseArtifactReference(record.workspace_profile_ref, `${context}.workspace_profile_ref`),
    ...(record.system_map_baseline_ref === undefined
      ? {}
      : { system_map_baseline_ref: parseArtifactReference(record.system_map_baseline_ref, `${context}.system_map_baseline_ref`) }),
    requested_outputs: ["system-map-patch", "current-context-proposal"],
    rules: asUniqueStrings(record.rules, `${context}.rules`, { min: 1 }),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseSystemMapPatch(
  value: unknown,
  context = "System Map Patch",
): SystemMapPatch {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "proposal_id", "map_id",
      "base_revision", "perspective", "source_snapshots", "evidence",
      "coverage_upserts", "entity_upserts", "relation_upserts",
      "remove_entity_ids", "remove_relation_ids", "reason", "proposed_at", "proposed_by",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "system-map-patch") fail(`${context}.artifact`, "must equal system-map-patch");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.perspective !== SYSTEM_MAP_PERSPECTIVE) {
    fail(`${context}.perspective`, `must equal ${SYSTEM_MAP_PERSPECTIVE}`);
  }
  if (record.proposed_by !== "ai") fail(`${context}.proposed_by`, "must equal ai");
  const snapshots = parseSourceSnapshots(record.source_snapshots, `${context}.source_snapshots`);
  if (snapshots.some((entry) => entry.dirty)) {
    fail(`${context}.source_snapshots`, "dirty working state cannot enter the accepted code baseline");
  }
  const evidence = parseEvidence(record.evidence, `${context}.evidence`);
  const coverage = parseCoverage(record.coverage_upserts, `${context}.coverage_upserts`);
  const entities = parseEntities(record.entity_upserts, `${context}.entity_upserts`);
  const relations = parseRelations(record.relation_upserts, `${context}.relation_upserts`);
  validateMapReferences(snapshots, evidence, coverage, entities, [], context);
  return {
    schema_version: 1,
    artifact: "system-map-patch",
    version: 1,
    proposal_id: asId(record.proposal_id, `${context}.proposal_id`),
    map_id: asId(record.map_id, `${context}.map_id`),
    base_revision: asBaseRevision(record.base_revision, `${context}.base_revision`),
    perspective: SYSTEM_MAP_PERSPECTIVE,
    source_snapshots: snapshots,
    evidence,
    coverage_upserts: coverage,
    entity_upserts: entities,
    relation_upserts: relations,
    remove_entity_ids: asUniqueStrings(record.remove_entity_ids, `${context}.remove_entity_ids`, { ids: true }),
    remove_relation_ids: asUniqueStrings(record.remove_relation_ids, `${context}.remove_relation_ids`, { ids: true }),
    reason: asOneLine(record.reason, `${context}.reason`),
    proposed_at: asIsoTimestamp(record.proposed_at, `${context}.proposed_at`),
    proposed_by: "ai",
  };
}

export function parseOrientProposal(
  value: unknown,
  context = "Orient Proposal",
): OrientProposal {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["schema_version", "artifact", "version", "intent_id", "work_request_sha256", "system_map_patch", "current_context", "proposed_by"],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "orient-proposal") fail(`${context}.artifact`, "must equal orient-proposal");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.proposed_by !== "ai") fail(`${context}.proposed_by`, "must equal ai");
  return {
    schema_version: 1,
    artifact: "orient-proposal",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    work_request_sha256: asSha256(record.work_request_sha256, `${context}.work_request_sha256`),
    system_map_patch: parseSystemMapPatch(record.system_map_patch, `${context}.system_map_patch`),
    current_context: parseCurrentContextProposal(record.current_context, `${context}.current_context`),
    proposed_by: "ai",
  };
}

export function parseSystemMap(value: unknown, context = "System Map"): SystemMap {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "map_id", "revision", "base_revision",
      "baseline_kind", "perspective", "source_snapshots", "evidence", "coverage",
      "entities", "relations", "created_at",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "system-map") fail(`${context}.artifact`, "must equal system-map");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  if (record.perspective !== SYSTEM_MAP_PERSPECTIVE) {
    fail(`${context}.perspective`, `must equal ${SYSTEM_MAP_PERSPECTIVE}`);
  }
  const baselineKind = asAllowed(record.baseline_kind, ["imported", "accepted"] as const, `${context}.baseline_kind`);
  const sources = parseSourceSnapshots(record.source_snapshots, `${context}.source_snapshots`);
  if (sources.some((entry) => entry.dirty)) {
    fail(`${context}.source_snapshots`, "dirty working state cannot enter the accepted code baseline");
  }
  const evidence = parseEvidence(record.evidence, `${context}.evidence`);
  const coverage = parseCoverage(record.coverage, `${context}.coverage`);
  const entities = parseEntities(record.entities, `${context}.entities`);
  const relations = parseRelations(record.relations, `${context}.relations`);
  validateMapReferences(sources, evidence, coverage, entities, relations, context);
  const revision = asPositiveInteger(record.revision, `${context}.revision`);
  const baseRevision = asBaseRevision(record.base_revision, `${context}.base_revision`);
  if (revision === 1 && baseRevision !== null) fail(`${context}.base_revision`, "must be null for revision 1");
  if (revision > 1 && baseRevision !== revision - 1) {
    fail(`${context}.base_revision`, `must equal previous revision ${revision - 1}`);
  }
  return {
    schema_version: 1,
    artifact: "system-map",
    version: 1,
    map_id: asId(record.map_id, `${context}.map_id`),
    revision,
    base_revision: baseRevision,
    baseline_kind: baselineKind,
    perspective: SYSTEM_MAP_PERSPECTIVE,
    source_snapshots: sources,
    evidence,
    coverage,
    entities,
    relations,
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseSystemMapBaseline(
  value: unknown,
  context = "System Map Baseline",
): SystemMapBaseline {
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    ["schema_version", "artifact", "version", "map_id", "revision", "source_of_truth", "sha256"],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "system-map-baseline") fail(`${context}.artifact`, "must equal system-map-baseline");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  return {
    schema_version: 1,
    artifact: "system-map-baseline",
    version: 1,
    map_id: asId(record.map_id, `${context}.map_id`),
    revision: asPositiveInteger(record.revision, `${context}.revision`),
    source_of_truth: asOneLine(record.source_of_truth, `${context}.source_of_truth`),
    sha256: asSha256(record.sha256, `${context}.sha256`),
  };
}

export function parseCurrentContext(
  value: unknown,
  context = "Current Context",
): CurrentContext {
  assertNoSecretFields(value, context);
  const record = asRecord(value, context);
  rejectUnknownKeys(
    record,
    [
      "schema_version", "artifact", "version", "intent_id", "design_brief_ref",
      "workspace_profile_ref", "system_map_ref", "system_map_revision", "entity_ids",
      "relation_ids", "additional_findings", "out_of_scope", "intent_only_notes",
      "unknowns", "created_at",
    ],
    context,
  );
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== "current-context") fail(`${context}.artifact`, "must equal current-context");
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
  const proposal = parseCurrentContextProposal({
    entity_ids: record.entity_ids,
    relation_ids: record.relation_ids,
    additional_findings: record.additional_findings,
    out_of_scope: record.out_of_scope,
    intent_only_notes: record.intent_only_notes,
    unknowns: record.unknowns,
  }, `${context}.selection`);
  return {
    schema_version: 1,
    artifact: "current-context",
    version: 1,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    design_brief_ref: parseArtifactReference(record.design_brief_ref, `${context}.design_brief_ref`),
    workspace_profile_ref: parseArtifactReference(record.workspace_profile_ref, `${context}.workspace_profile_ref`),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    system_map_revision: asPositiveInteger(record.system_map_revision, `${context}.system_map_revision`),
    ...proposal,
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}
