import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";

export const EFFECTIVE_POLICY_SCHEMA_VERSION = 1 as const;
export const POLICY_SOURCE_LAYERS = ["org", "team", "project"] as const;
export const POLICY_SOURCE_PRIORITY = [
  "org",
  "team",
  "project",
  "intent_risk",
] as const;
export const INTENT_RISK_SEVERITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type PolicySourceLayer = (typeof POLICY_SOURCE_LAYERS)[number];
export type PolicyPriorityLayer = (typeof POLICY_SOURCE_PRIORITY)[number];
export type IntentRiskSeverity = (typeof INTENT_RISK_SEVERITIES)[number];

export interface EffectivePolicySource {
  layer: PolicySourceLayer;
  source_of_truth: string;
  sha256: string;
  content: string;
}

export interface IntentRiskFact {
  risk_id: string;
  severity: IntentRiskSeverity;
  statement: string;
  evidence: ArtifactReference[];
}

export interface EffectivePolicySnapshot {
  schema_version: typeof EFFECTIVE_POLICY_SCHEMA_VERSION;
  snapshot_id: string;
  intent_id: string;
  revision: number;
  created_at: string;
  source_priority: PolicyPriorityLayer[];
  sources: EffectivePolicySource[];
  intent_risks: IntentRiskFact[];
}

export interface BuildEffectivePolicyOptions {
  revision?: number;
  createdAt?: string;
  intentRisks?: readonly IntentRiskFact[];
}

export interface WrittenEffectivePolicy {
  path: string;
  snapshot: EffectivePolicySnapshot;
  reference: ArtifactReference;
}

const POLICY_SOURCE_KEYS = [
  "layer",
  "source_of_truth",
  "sha256",
  "content",
] as const;
const RISK_KEYS = ["risk_id", "severity", "statement", "evidence"] as const;
const SNAPSHOT_KEYS = [
  "schema_version",
  "snapshot_id",
  "intent_id",
  "revision",
  "created_at",
  "source_priority",
  "sources",
  "intent_risks",
] as const;
const RISK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

function asPositiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(context, "must be a positive integer");
  }
  return value as number;
}

function asIsoTimestamp(value: unknown, context: string): string {
  const timestamp = asOneLine(value, context);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    fail(context, "must be an ISO-8601 UTC timestamp");
  }
  return timestamp;
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

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function portableProjectPath(projectDir: string, path: string): string {
  const projectRoot = resolve(projectDir);
  const absolute = resolve(path);
  const rel = relative(projectRoot, absolute);
  if (
    rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  ) {
    fail("Effective Policy", `path is outside the project: ${absolute}`);
  }
  return rel.split(sep).join("/");
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename has already consumed the temporary path.
    }
    throw error;
  }
}

function parsePolicySource(
  value: unknown,
  context: string,
): EffectivePolicySource {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, POLICY_SOURCE_KEYS, context);
  const sha256 = asOneLine(record.sha256, `${context}.sha256`);
  if (!SHA256_PATTERN.test(sha256)) {
    fail(`${context}.sha256`, "must use sha256:<64 lowercase hex characters>");
  }
  if (typeof record.content !== "string") {
    fail(`${context}.content`, "must be a string");
  }
  if (digest(record.content) !== sha256) {
    fail(`${context}.sha256`, "does not match the snapshotted content");
  }
  return {
    layer: asAllowed(record.layer, POLICY_SOURCE_LAYERS, `${context}.layer`),
    source_of_truth: asOneLine(
      record.source_of_truth,
      `${context}.source_of_truth`,
    ),
    sha256,
    content: record.content,
  };
}

function parseIntentRisk(value: unknown, context: string): IntentRiskFact {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, RISK_KEYS, context);
  const riskId = asOneLine(record.risk_id, `${context}.risk_id`);
  if (!RISK_ID_PATTERN.test(riskId)) {
    fail(`${context}.risk_id`, "must use lowercase kebab-case");
  }
  if (!Array.isArray(record.evidence)) fail(`${context}.evidence`, "must be an array");
  return {
    risk_id: riskId,
    severity: asAllowed(
      record.severity,
      INTENT_RISK_SEVERITIES,
      `${context}.severity`,
    ),
    statement: asOneLine(record.statement, `${context}.statement`),
    evidence: record.evidence.map((entry, index) =>
      parseArtifactReference(entry, `${context}.evidence[${index}]`)
    ),
  };
}

export function parseEffectivePolicySnapshot(
  value: unknown,
  context = "Effective Policy snapshot",
): EffectivePolicySnapshot {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, SNAPSHOT_KEYS, context);
  if (record.schema_version !== EFFECTIVE_POLICY_SCHEMA_VERSION) {
    fail(`${context}.schema_version`, `must equal ${EFFECTIVE_POLICY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(record.source_priority)) {
    fail(`${context}.source_priority`, "must be an array");
  }
  const sourcePriority = record.source_priority.map((entry, index) =>
    asAllowed(entry, POLICY_SOURCE_PRIORITY, `${context}.source_priority[${index}]`)
  );
  if (JSON.stringify(sourcePriority) !== JSON.stringify(POLICY_SOURCE_PRIORITY)) {
    fail(`${context}.source_priority`, "must use org, team, project, intent_risk order");
  }
  if (!Array.isArray(record.sources)) fail(`${context}.sources`, "must be an array");
  const sources = record.sources.map((entry, index) =>
    parsePolicySource(entry, `${context}.sources[${index}]`)
  );
  if (sources.length !== POLICY_SOURCE_LAYERS.length) {
    fail(`${context}.sources`, `must contain exactly ${POLICY_SOURCE_LAYERS.length} sources`);
  }
  for (const [index, expected] of POLICY_SOURCE_LAYERS.entries()) {
    if (sources[index]?.layer !== expected) {
      fail(`${context}.sources[${index}].layer`, `must equal ${expected}`);
    }
  }
  if (!Array.isArray(record.intent_risks)) {
    fail(`${context}.intent_risks`, "must be an array");
  }
  const intentRisks = record.intent_risks.map((entry, index) =>
    parseIntentRisk(entry, `${context}.intent_risks[${index}]`)
  );
  const riskIds = intentRisks.map((risk) => risk.risk_id);
  const duplicateRisk = riskIds.find((risk, index) => riskIds.indexOf(risk) !== index);
  if (duplicateRisk !== undefined) {
    fail(`${context}.intent_risks`, `contains duplicate risk_id: ${duplicateRisk}`);
  }
  return {
    schema_version: EFFECTIVE_POLICY_SCHEMA_VERSION,
    snapshot_id: asOneLine(record.snapshot_id, `${context}.snapshot_id`),
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    revision: asPositiveInteger(record.revision, `${context}.revision`),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
    source_priority: [...POLICY_SOURCE_PRIORITY],
    sources,
    intent_risks: intentRisks,
  };
}

export function buildEffectivePolicySnapshot(
  projectDir: string,
  intentId: string,
  options: BuildEffectivePolicyOptions = {},
): EffectivePolicySnapshot {
  const projectRoot = resolve(projectDir);
  const revision = options.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("Effective Policy revision", "must be a positive integer");
  }
  const space = activeSpace(projectRoot);
  const memoryDir = join(workspaceRoot(projectRoot), "spaces", space, "memory");
  const sources = POLICY_SOURCE_LAYERS.map((layer): EffectivePolicySource => {
    const path = join(memoryDir, `${layer}.md`);
    if (!existsSync(path) || !statSync(path).isFile()) {
      fail("Effective Policy", `missing ${layer} Memory: ${path}`);
    }
    const content = readFileSync(path, "utf8");
    return {
      layer,
      source_of_truth: portableProjectPath(projectRoot, path),
      sha256: digest(content),
      content,
    };
  });
  return parseEffectivePolicySnapshot({
    schema_version: EFFECTIVE_POLICY_SCHEMA_VERSION,
    snapshot_id: `effective-policy-${intentId}-r${revision}`,
    intent_id: intentId,
    revision,
    created_at: options.createdAt ?? new Date().toISOString(),
    source_priority: [...POLICY_SOURCE_PRIORITY],
    sources,
    intent_risks: [...(options.intentRisks ?? [])],
  });
}

export function writeEffectivePolicySnapshot(
  projectDir: string,
  recordDir: string,
  intentId: string,
  options: BuildEffectivePolicyOptions = {},
): WrittenEffectivePolicy {
  const revision = options.revision ?? 1;
  const snapshot = buildEffectivePolicySnapshot(projectDir, intentId, options);
  const path = join(resolve(recordDir), `effective-policy-r${revision}.json`);
  const sourceOfTruth = portableProjectPath(projectDir, path);
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  writeFileAtomic(path, content);
  const reference = parseArtifactReference({
    artifact: "effective-policy",
    version: revision,
    source_of_truth: sourceOfTruth,
    sha256: digest(content),
  });
  return { path, snapshot, reference };
}

export function verifyProjectArtifactReference(
  projectDir: string,
  reference: ArtifactReference,
): string {
  const parsed = parseArtifactReference(reference);
  if (isAbsolute(parsed.source_of_truth)) {
    fail("Artifact reference", "source_of_truth must be project-relative");
  }
  const projectRoot = resolve(projectDir);
  const path = resolve(projectRoot, parsed.source_of_truth);
  const rel = relative(projectRoot, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("Artifact reference", "source_of_truth escapes the project");
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail("Artifact reference", `source_of_truth does not exist: ${parsed.source_of_truth}`);
  }
  const actual = digest(readFileSync(path));
  if (actual !== parsed.sha256) {
    fail("Artifact reference", `sha256 mismatch for ${parsed.source_of_truth}`);
  }
  return path;
}
