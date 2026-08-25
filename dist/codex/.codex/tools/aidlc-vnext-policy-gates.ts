import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  HUMAN_GATE_STAGE_IDS,
  INTENT_RISK_SEVERITIES,
  parseEffectivePolicySnapshot,
  verifyProjectArtifactReference,
  type HumanGateStageId,
  type IntentRiskSeverity,
} from "./aidlc-effective-policy.ts";
import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";
import {
  readCurrentIntentRiskRegisterWithReferenceAt,
} from "./aidlc-vnext-risk.ts";

export interface HumanGateRequirement {
  requirement_id: string;
  rule_id: string;
  risk_id: string;
  severity: IntentRiskSeverity;
  risk_statement: string;
  statement: string;
}

export interface HumanGateRequirementSet {
  schema_version: 1;
  artifact: "human-gate-requirements";
  version: 1;
  intent_id: string;
  stage_id: HumanGateStageId;
  effective_policy_ref: ArtifactReference;
  risk_register_ref: ArtifactReference;
  requirements: HumanGateRequirement[];
  created_at: string;
}

export interface PolicyAcknowledgement {
  requirement_id: string;
  acknowledged: true;
  reason: string;
}

export interface ResolveHumanGateOptions {
  createdAt?: string;
}

export interface ValidatePolicyAcknowledgementOptions {
  projectDir: string;
  recordDir: string;
  requireCurrentRiskRegister?: boolean;
}

const REQUIREMENT_KEYS = [
  "requirement_id",
  "rule_id",
  "risk_id",
  "severity",
  "risk_statement",
  "statement",
] as const;
const SET_KEYS = [
  "schema_version",
  "artifact",
  "version",
  "intent_id",
  "stage_id",
  "effective_policy_ref",
  "risk_register_ref",
  "requirements",
  "created_at",
] as const;

function fail(message: string): never {
  throw new Error(`Human Gate Policy: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`);
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
  if (unknown.length > 0) fail(`${context} unknown field(s): ${unknown.join(", ")}`);
}

function text(value: unknown, context: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value !== value.trim() ||
    /[\r\n\0]/.test(value)
  ) fail(`${context} must be a non-empty single-line string`);
  return value;
}

function timestamp(value: unknown, context: string): string {
  const parsed = text(value, context);
  if (Number.isNaN(Date.parse(parsed)) || !parsed.endsWith("Z")) {
    fail(`${context} must be an ISO-8601 UTC timestamp`);
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
    fail(`${context} must be one of: ${values.join(", ")}`);
  }
  return parsed as T;
}

export function parseHumanGateRequirementSet(
  value: unknown,
  context = "Human Gate Requirement Set",
): HumanGateRequirementSet {
  const item = record(value, context);
  rejectUnknown(item, SET_KEYS, context);
  if (item.schema_version !== 1) fail(`${context}.schema_version must equal 1`);
  if (item.artifact !== "human-gate-requirements") {
    fail(`${context}.artifact must equal human-gate-requirements`);
  }
  if (item.version !== 1) fail(`${context}.version must equal 1`);
  if (!Array.isArray(item.requirements)) fail(`${context}.requirements must be an array`);
  const requirements = item.requirements.map((entry, index): HumanGateRequirement => {
    const requirementContext = `${context}.requirements[${index}]`;
    const requirement = record(entry, requirementContext);
    rejectUnknown(requirement, REQUIREMENT_KEYS, requirementContext);
    return {
      requirement_id: text(
        requirement.requirement_id,
        `${requirementContext}.requirement_id`,
      ),
      rule_id: text(requirement.rule_id, `${requirementContext}.rule_id`),
      risk_id: text(requirement.risk_id, `${requirementContext}.risk_id`),
      severity: allowed(
        requirement.severity,
        INTENT_RISK_SEVERITIES,
        `${requirementContext}.severity`,
      ),
      risk_statement: text(
        requirement.risk_statement,
        `${requirementContext}.risk_statement`,
      ),
      statement: text(requirement.statement, `${requirementContext}.statement`),
    };
  });
  const ids = requirements.map((entry) => entry.requirement_id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) fail(`${context}.requirements duplicate ID: ${duplicate}`);
  return {
    schema_version: 1,
    artifact: "human-gate-requirements",
    version: 1,
    intent_id: text(item.intent_id, `${context}.intent_id`),
    stage_id: allowed(item.stage_id, HUMAN_GATE_STAGE_IDS, `${context}.stage_id`),
    effective_policy_ref: parseArtifactReference(
      item.effective_policy_ref,
      `${context}.effective_policy_ref`,
    ),
    risk_register_ref: parseArtifactReference(
      item.risk_register_ref,
      `${context}.risk_register_ref`,
    ),
    requirements,
    created_at: timestamp(item.created_at, `${context}.created_at`),
  };
}

export function parsePolicyAcknowledgement(
  value: unknown,
  context = "Policy acknowledgement",
): PolicyAcknowledgement {
  const item = record(value, context);
  rejectUnknown(item, ["requirement_id", "acknowledged", "reason"], context);
  if (item.acknowledged !== true) fail(`${context}.acknowledged must equal true`);
  return {
    requirement_id: text(item.requirement_id, `${context}.requirement_id`),
    acknowledged: true,
    reason: text(item.reason, `${context}.reason`),
  };
}

function severityRank(value: IntentRiskSeverity): number {
  return INTENT_RISK_SEVERITIES.indexOf(value);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function portablePath(projectDir: string, path: string): string {
  const root = resolve(projectDir);
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`path is outside the Project: ${absolute}`);
  }
  return rel.split(sep).join("/");
}

function setKey(set: HumanGateRequirementSet): string {
  return digest(
    `${set.stage_id}\0${set.effective_policy_ref.sha256}\0${set.risk_register_ref.sha256}`,
  );
}

function atomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

export function humanGateRequirementPath(
  recordDir: string,
  stageId: HumanGateStageId,
  key: string,
): string {
  return join(
    resolve(recordDir),
    "artifacts",
    "gates",
    stageId,
    key,
    "requirements.json",
  );
}

export function humanGateReviewPath(
  recordDir: string,
  stageId: HumanGateStageId,
  key: string,
): string {
  return join(
    resolve(recordDir),
    "artifacts",
    "gates",
    stageId,
    key,
    "review.html",
  );
}

export function resolveHumanGateRequirementsAt(
  projectDir: string,
  recordDir: string,
  stageId: HumanGateStageId,
  effectivePolicyReference: ArtifactReference,
  options: ResolveHumanGateOptions = {},
): HumanGateRequirementSet {
  const policyPath = verifyProjectArtifactReference(
    projectDir,
    effectivePolicyReference,
  );
  const policy = parseEffectivePolicySnapshot(
    JSON.parse(readFileSync(policyPath, "utf8")),
  );
  const risks = readCurrentIntentRiskRegisterWithReferenceAt(projectDir, recordDir);
  if (policy.intent_id !== risks.register.intent_id) {
    fail("Effective Policy and Risk Register belong to different Intents");
  }
  const requirements = policy.human_gate_rules
    .filter((rule) => rule.stage_ids.includes(stageId))
    .flatMap((rule) =>
      risks.register.risks
        .filter(
          (risk) =>
            risk.status === "active" &&
            severityRank(risk.severity) >= severityRank(rule.minimum_severity),
        )
        .map((risk): HumanGateRequirement => ({
          requirement_id: `${rule.rule_id}:${risk.risk_id}`,
          rule_id: rule.rule_id,
          risk_id: risk.risk_id,
          severity: risk.severity,
          risk_statement: risk.statement,
          statement: rule.acknowledgement,
        }))
    )
    .sort((a, b) => a.requirement_id.localeCompare(b.requirement_id));
  const set = parseHumanGateRequirementSet({
    schema_version: 1,
    artifact: "human-gate-requirements",
    version: 1,
    intent_id: policy.intent_id,
    stage_id: stageId,
    effective_policy_ref: effectivePolicyReference,
    risk_register_ref: risks.reference,
    requirements,
    created_at: options.createdAt ?? new Date().toISOString(),
  });
  const key = setKey(set);
  const path = humanGateRequirementPath(recordDir, stageId, key);
  if (existsSync(path)) {
    const stored = parseHumanGateRequirementSet(JSON.parse(readFileSync(path, "utf8")));
    const { created_at: _created, ...candidate } = set;
    const { created_at: _storedCreated, ...storedStable } = stored;
    if (JSON.stringify(candidate) !== JSON.stringify(storedStable)) {
      fail("immutable Gate Requirement Set differs");
    }
    return stored;
  }
  atomic(path, serialize(set));
  return set;
}

export function humanGateRequirementReferenceAt(
  projectDir: string,
  recordDir: string,
  setInput: HumanGateRequirementSet,
): ArtifactReference {
  const set = parseHumanGateRequirementSet(setInput);
  const path = humanGateRequirementPath(recordDir, set.stage_id, setKey(set));
  if (!existsSync(path)) fail(`Gate Requirement Set is not persisted: ${path}`);
  const content = readFileSync(path, "utf8");
  const stored = parseHumanGateRequirementSet(JSON.parse(content));
  if (JSON.stringify(stored) !== JSON.stringify(set)) {
    fail("persisted Gate Requirement Set differs from the supplied Set");
  }
  return {
    artifact: "human-gate-requirements",
    version: 1,
    source_of_truth: portablePath(projectDir, path),
    sha256: `sha256:${digest(content)}`,
  };
}

export function validatePolicyAcknowledgements(
  setInput: HumanGateRequirementSet,
  values: unknown,
  options?: ValidatePolicyAcknowledgementOptions,
): PolicyAcknowledgement[] {
  const set = parseHumanGateRequirementSet(setInput);
  if (options?.requireCurrentRiskRegister === true) {
    const current = readCurrentIntentRiskRegisterWithReferenceAt(
      options.projectDir,
      options.recordDir,
    );
    if (JSON.stringify(current.reference) !== JSON.stringify(set.risk_register_ref)) {
      fail("Risk Register changed after the Gate Requirement Set was created");
    }
  }
  if (!Array.isArray(values)) fail("policy_acknowledgements must be an array");
  const acknowledgements = values.map((entry, index) =>
    parsePolicyAcknowledgement(entry, `policy_acknowledgements[${index}]`)
  );
  const ids = acknowledgements.map((entry) => entry.requirement_id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) fail(`duplicate acknowledgement: ${duplicate}`);
  const expected = set.requirements.map((entry) => entry.requirement_id);
  const unknown = ids.find((id) => !expected.includes(id));
  if (unknown !== undefined) fail(`unknown acknowledgement: ${unknown}`);
  const missing = expected.find((id) => !ids.includes(id));
  if (missing !== undefined) fail(`missing acknowledgement: ${missing}`);
  return acknowledgements;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export function renderHumanGateReviewHtml(
  setInput: HumanGateRequirementSet,
  subject: string,
): string {
  const set = parseHumanGateRequirementSet(setInput);
  const rows = set.requirements.length === 0
    ? "<p>追加のPolicy確認はありません。固定Human Gateはそのまま実行します。</p>"
    : `<ol>${set.requirements.map((entry) =>
      `<li><strong>${escapeHtml(entry.requirement_id)}</strong>` +
      `<p>${escapeHtml(entry.statement)}</p>` +
      `<p>Risk: ${escapeHtml(entry.risk_statement)} (${entry.severity})</p></li>`
    ).join("")}</ol>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(set.stage_id)} Human Gate</title>` +
    `<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7;color:#172033;background:#f4f7fb;margin:0}main{width:min(860px,calc(100% - 24px));margin:24px auto;padding:28px;border-radius:18px;background:#fff}li{margin:12px 0;padding:14px;border-radius:12px;background:#eef4ff}p{margin:5px 0;color:#607086}@media(max-width:620px){main{margin:10px auto;padding:18px}}</style>` +
    `</head><body><main><h1>${escapeHtml(set.stage_id)} 人間確認</h1>` +
    `<p>対象: ${escapeHtml(subject)}</p>${rows}</main></body></html>`;
}

export function renderHumanGateRequirementSection(
  setInput: HumanGateRequirementSet,
): string {
  const set = parseHumanGateRequirementSet(setInput);
  if (set.requirements.length === 0) {
    return "<section><h2>Policyによる追加確認</h2><p>追加確認はありません。固定Human Gateは実行します。</p></section>";
  }
  return `<section><h2>Policyによる追加確認</h2><ol>${set.requirements.map((entry) =>
    `<li><strong>${escapeHtml(entry.requirement_id)}</strong>` +
    `<p>${escapeHtml(entry.statement)}</p>` +
    `<p>Risk: ${escapeHtml(entry.risk_statement)} (${entry.severity})</p></li>`
  ).join("")}</ol></section>`;
}
