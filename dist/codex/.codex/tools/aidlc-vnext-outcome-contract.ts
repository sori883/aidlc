import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";
import {
  parsePolicyAcknowledgement,
  type PolicyAcknowledgement,
} from "./aidlc-vnext-policy-gates.ts";

export const OUTCOME_SCHEMA_VERSION = 1 as const;
export const OUTCOME_ARTIFACT_VERSION = 1 as const;
export const OUTCOME_RESULTS = [
  "achieved",
  "partially_achieved",
  "not_achieved",
  "inconclusive",
] as const;
export const OUTCOME_DECISIONS = [
  "continue-observation",
  "complete-with-outcome",
  "complete-and-draft-follow-up",
] as const;

export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];
export type OutcomeDecision = (typeof OUTCOME_DECISIONS)[number];
export type OutcomeReleaseResult = "released" | "rolled_back" | "not_applicable";

export interface OutcomeSignal {
  signal_id: string;
  source_artifact: "intent-definition" | "requirements-definition" | "review-manifest";
  source_pointer: string;
  statement: string;
  required: true;
  allowed_evidence_types: ["artifact", "registered-observation", "human-confirmation"];
}

export interface OutcomeWorkRequest {
  schema_version: typeof OUTCOME_SCHEMA_VERSION;
  artifact: "outcome-work-request";
  version: typeof OUTCOME_ARTIFACT_VERSION;
  revision: number;
  intent_id: string;
  stage_id: "ST-09";
  intent_definition_ref: ArtifactReference;
  requirements_ref: ArtifactReference;
  review_manifest_ref: ArtifactReference | null;
  release_current_ref: ArtifactReference;
  release_outcome: OutcomeReleaseResult;
  effective_policy_ref: ArtifactReference;
  signals: OutcomeSignal[];
  not_before: string;
  deadline: string | null;
  requested_output: "outcome-evaluation-proposal";
  rules: string[];
  created_at: string;
}

export interface OutcomeSignalObservation {
  signal_id: string;
  result: OutcomeResult;
  evidence_refs: ArtifactReference[];
  reason: string;
  observed_at: string;
}

export interface OutcomeEvaluationProposal {
  schema_version: typeof OUTCOME_SCHEMA_VERSION;
  artifact: "outcome-evaluation-proposal";
  version: typeof OUTCOME_ARTIFACT_VERSION;
  proposal_id: string;
  intent_id: string;
  work_request_sha256: string;
  observations: OutcomeSignalObservation[];
  reason: string;
  proposed_by: "ai";
}

export interface OutcomeEvidence {
  schema_version: typeof OUTCOME_SCHEMA_VERSION;
  artifact: "outcome-evidence";
  version: typeof OUTCOME_ARTIFACT_VERSION;
  revision: number;
  evidence_id: string;
  intent_id: string;
  work_request_ref: ArtifactReference;
  observations: OutcomeSignalObservation[];
  collected_at: string;
}

export interface OutcomeEvaluation {
  schema_version: typeof OUTCOME_SCHEMA_VERSION;
  artifact: "outcome-evaluation";
  version: typeof OUTCOME_ARTIFACT_VERSION;
  revision: number;
  evaluation_id: string;
  intent_id: string;
  stage_id: "ST-09";
  disposition: "execute" | "reuse";
  work_request_ref: ArtifactReference;
  outcome_evidence_ref: ArtifactReference;
  gate_requirement_set_ref: ArtifactReference;
  release_outcome: OutcomeReleaseResult;
  signal_results: OutcomeSignalObservation[];
  overall_result: OutcomeResult;
  reason: string;
  evaluated_at: string;
}

export interface OutcomeHumanDecision {
  schema_version: typeof OUTCOME_SCHEMA_VERSION;
  artifact: "outcome-human-decision";
  version: typeof OUTCOME_ARTIFACT_VERSION;
  decision_id: string;
  intent_id: string;
  outcome_evaluation_ref: ArtifactReference;
  gate_requirement_set_ref: ArtifactReference;
  policy_acknowledgements: PolicyAcknowledgement[];
  decision: OutcomeDecision;
  reason: string;
  decided_by: "human";
  decided_at: string;
  not_before: string | null;
  deadline: string | null;
}

export interface FollowUpBrief {
  schema_version: typeof OUTCOME_SCHEMA_VERSION;
  artifact: "follow-up-brief";
  version: typeof OUTCOME_ARTIFACT_VERSION;
  brief_id: string;
  source_intent_id: string;
  outcome_evaluation_ref: ArtifactReference;
  human_decision_ref: ArtifactReference;
  title: string;
  problem_summary: string;
  unresolved_signal_ids: string[];
  created_at: string;
}

export interface OutcomeCurrent {
  schema_version: typeof OUTCOME_SCHEMA_VERSION;
  artifact: "outcome-current";
  version: typeof OUTCOME_ARTIFACT_VERSION;
  intent_id: string;
  disposition: "execute" | "reuse";
  overall_result: OutcomeResult;
  completion_mode: "auto-achieved" | "human-accepted" | "human-follow-up" | "reused";
  work_request_ref: ArtifactReference;
  outcome_evidence_ref: ArtifactReference;
  outcome_evaluation_ref: ArtifactReference;
  human_decision_ref: ArtifactReference | null;
  follow_up_brief_ref: ArtifactReference | null;
  reason: string;
  completed_at: string;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const SIGNAL_ID = /^(?:OUT|SIG|REQ-[A-Z]+|CON|INV|AC)-\d{3}$/;
const SECRET = /(?:^|[_-])(secret|password|passwd|token|api[_-]?key|credential|private[_-]?key)(?:$|[_-])/i;

function fail(context: string, message: string): never { throw new Error(`${context}: ${message}`); }
function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(context, "must be an object");
  return value as Record<string, unknown>;
}
function rejectUnknown(record: Record<string, unknown>, keys: readonly string[], context: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}
function noSecrets(value: unknown, context: string): void {
  if (Array.isArray(value)) return value.forEach((entry, index) => noSecrets(entry, `${context}[${index}]`));
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET.test(key)) fail(context, `secret-bearing field is prohibited: ${key}`);
    noSecrets(child, `${context}.${key}`);
  }
}
function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\r\n\0]/.test(value)) fail(context, "must be a non-empty single-line string");
  return value;
}
function id(value: unknown, context: string, pattern = ID): string {
  const result = text(value, context);
  if (!pattern.test(result)) fail(context, "must be a stable identifier");
  return result;
}
function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(context, "must be a positive integer");
  return value as number;
}
function iso(value: unknown, context: string): string {
  const result = text(value, context);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) fail(context, "must be an ISO-8601 UTC timestamp");
  return result;
}
function nullableIso(value: unknown, context: string): string | null { return value === null ? null : iso(value, context); }
function sha(value: unknown, context: string): string {
  const result = text(value, context);
  if (!SHA256.test(result)) fail(context, "must use sha256:<64 lowercase hex characters>");
  return result;
}
function choice<T extends string>(value: unknown, choices: readonly T[], context: string): T {
  const result = text(value, context);
  if (!(choices as readonly string[]).includes(result)) fail(context, `must be one of: ${choices.join(", ")}`);
  return result as T;
}
function strings(value: unknown, context: string, minimum = 0): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const result = value.map((entry, index) => text(entry, `${context}[${index}]`));
  if (result.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  if (new Set(result).size !== result.length) fail(context, "contains a duplicate value");
  return result;
}
function references(value: unknown, context: string, minimum = 0): ArtifactReference[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const result = value.map((entry, index) => parseArtifactReference(entry, `${context}[${index}]`));
  if (result.length < minimum) fail(context, `must contain at least ${minimum} Evidence reference(s)`);
  if (new Set(result.map((entry) => JSON.stringify(entry))).size !== result.length) fail(context, "contains duplicate Evidence");
  return result;
}
function releaseResult(value: unknown, context: string): OutcomeReleaseResult {
  return choice(value, ["released", "rolled_back", "not_applicable"] as const, context);
}
function result(value: unknown, context: string): OutcomeResult { return choice(value, OUTCOME_RESULTS, context); }

function parseSignal(value: unknown, context: string): OutcomeSignal {
  const record = object(value, context);
  rejectUnknown(record, ["signal_id", "source_artifact", "source_pointer", "statement", "required", "allowed_evidence_types"], context);
  const allowed = strings(record.allowed_evidence_types, `${context}.allowed_evidence_types`, 3);
  if (JSON.stringify(allowed) !== JSON.stringify(["artifact", "registered-observation", "human-confirmation"])) fail(`${context}.allowed_evidence_types`, "must contain the fixed evidence types in order");
  if (record.required !== true) fail(`${context}.required`, "must equal true");
  return {
    signal_id: id(record.signal_id, `${context}.signal_id`, SIGNAL_ID),
    source_artifact: choice(record.source_artifact, ["intent-definition", "requirements-definition", "review-manifest"] as const, `${context}.source_artifact`),
    source_pointer: text(record.source_pointer, `${context}.source_pointer`),
    statement: text(record.statement, `${context}.statement`),
    required: true,
    allowed_evidence_types: ["artifact", "registered-observation", "human-confirmation"],
  };
}

function parseObservation(value: unknown, context: string): OutcomeSignalObservation {
  const record = object(value, context);
  rejectUnknown(record, ["signal_id", "result", "evidence_refs", "reason", "observed_at"], context);
  return {
    signal_id: id(record.signal_id, `${context}.signal_id`, SIGNAL_ID),
    result: result(record.result, `${context}.result`),
    evidence_refs: references(record.evidence_refs, `${context}.evidence_refs`, 1),
    reason: text(record.reason, `${context}.reason`),
    observed_at: iso(record.observed_at, `${context}.observed_at`),
  };
}

function observations(value: unknown, context: string): OutcomeSignalObservation[] {
  if (!Array.isArray(value) || value.length === 0) fail(context, "must contain at least one signal observation");
  const result = value.map((entry, index) => parseObservation(entry, `${context}[${index}]`));
  if (new Set(result.map((entry) => entry.signal_id)).size !== result.length) fail(context, "contains a duplicate signal_id");
  return result;
}

export function calculateOutcomeResult(values: readonly OutcomeSignalObservation[]): OutcomeResult {
  if (values.length === 0) fail("Outcome Evaluation", "cannot evaluate zero signals");
  if (values.some((entry) => entry.result === "inconclusive")) return "inconclusive";
  if (values.every((entry) => entry.result === "achieved")) return "achieved";
  if (values.every((entry) => entry.result === "not_achieved")) return "not_achieved";
  return "partially_achieved";
}

export function parseOutcomeWorkRequest(value: unknown, context = "Outcome Work Request"): OutcomeWorkRequest {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, ["schema_version", "artifact", "version", "revision", "intent_id", "stage_id", "intent_definition_ref", "requirements_ref", "review_manifest_ref", "release_current_ref", "release_outcome", "effective_policy_ref", "signals", "not_before", "deadline", "requested_output", "rules", "created_at"], context);
  if (record.schema_version !== 1 || record.version !== 1) fail(context, "schema_version and version must equal 1");
  if (record.artifact !== "outcome-work-request" || record.stage_id !== "ST-09") fail(context, "must define the ST-09 outcome-work-request");
  if (record.requested_output !== "outcome-evaluation-proposal") fail(`${context}.requested_output`, "must equal outcome-evaluation-proposal");
  if (!Array.isArray(record.signals) || record.signals.length === 0) fail(`${context}.signals`, "must contain at least one required signal");
  const parsedSignals = record.signals.map((entry, index) => parseSignal(entry, `${context}.signals[${index}]`));
  if (new Set(parsedSignals.map((entry) => entry.signal_id)).size !== parsedSignals.length) fail(`${context}.signals`, "contains a duplicate signal_id");
  const notBefore = iso(record.not_before, `${context}.not_before`);
  const deadline = nullableIso(record.deadline, `${context}.deadline`);
  if (deadline !== null && Date.parse(deadline) <= Date.parse(notBefore)) fail(`${context}.deadline`, "must be after not_before");
  return {
    schema_version: 1, artifact: "outcome-work-request", version: 1,
    revision: integer(record.revision, `${context}.revision`),
    intent_id: text(record.intent_id, `${context}.intent_id`), stage_id: "ST-09",
    intent_definition_ref: parseArtifactReference(record.intent_definition_ref, `${context}.intent_definition_ref`),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    review_manifest_ref: record.review_manifest_ref === null ? null : parseArtifactReference(record.review_manifest_ref, `${context}.review_manifest_ref`),
    release_current_ref: parseArtifactReference(record.release_current_ref, `${context}.release_current_ref`),
    release_outcome: releaseResult(record.release_outcome, `${context}.release_outcome`),
    effective_policy_ref: parseArtifactReference(record.effective_policy_ref, `${context}.effective_policy_ref`),
    signals: parsedSignals, not_before: notBefore, deadline,
    requested_output: "outcome-evaluation-proposal",
    rules: strings(record.rules, `${context}.rules`, 1), created_at: iso(record.created_at, `${context}.created_at`),
  };
}

export function parseOutcomeEvaluationProposal(value: unknown, context = "Outcome Evaluation Proposal"): OutcomeEvaluationProposal {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, ["schema_version", "artifact", "version", "proposal_id", "intent_id", "work_request_sha256", "observations", "reason", "proposed_by"], context);
  if (record.schema_version !== 1 || record.version !== 1) fail(context, "schema_version and version must equal 1");
  if (record.artifact !== "outcome-evaluation-proposal") fail(`${context}.artifact`, "must equal outcome-evaluation-proposal");
  if (record.proposed_by !== "ai") fail(`${context}.proposed_by`, "must equal ai");
  return {
    schema_version: 1, artifact: "outcome-evaluation-proposal", version: 1,
    proposal_id: id(record.proposal_id, `${context}.proposal_id`), intent_id: text(record.intent_id, `${context}.intent_id`),
    work_request_sha256: sha(record.work_request_sha256, `${context}.work_request_sha256`),
    observations: observations(record.observations, `${context}.observations`),
    reason: text(record.reason, `${context}.reason`), proposed_by: "ai",
  };
}

export function parseOutcomeEvidence(value: unknown, context = "Outcome Evidence"): OutcomeEvidence {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, ["schema_version", "artifact", "version", "revision", "evidence_id", "intent_id", "work_request_ref", "observations", "collected_at"], context);
  if (record.schema_version !== 1 || record.version !== 1 || record.artifact !== "outcome-evidence") fail(context, "must define outcome-evidence version 1");
  return { schema_version: 1, artifact: "outcome-evidence", version: 1, revision: integer(record.revision, `${context}.revision`), evidence_id: id(record.evidence_id, `${context}.evidence_id`), intent_id: text(record.intent_id, `${context}.intent_id`), work_request_ref: parseArtifactReference(record.work_request_ref, `${context}.work_request_ref`), observations: observations(record.observations, `${context}.observations`), collected_at: iso(record.collected_at, `${context}.collected_at`) };
}

export function parseOutcomeEvaluation(value: unknown, context = "Outcome Evaluation"): OutcomeEvaluation {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, ["schema_version", "artifact", "version", "revision", "evaluation_id", "intent_id", "stage_id", "disposition", "work_request_ref", "outcome_evidence_ref", "gate_requirement_set_ref", "release_outcome", "signal_results", "overall_result", "reason", "evaluated_at"], context);
  if (record.schema_version !== 1 || record.version !== 1 || record.artifact !== "outcome-evaluation" || record.stage_id !== "ST-09") fail(context, "must define ST-09 outcome-evaluation version 1");
  const signalResults = observations(record.signal_results, `${context}.signal_results`);
  const overall = result(record.overall_result, `${context}.overall_result`);
  if (calculateOutcomeResult(signalResults) !== overall) fail(`${context}.overall_result`, "does not match the signal results");
  const released = releaseResult(record.release_outcome, `${context}.release_outcome`);
  if (released === "rolled_back" && overall === "achieved") fail(`${context}.overall_result`, "a rolled_back Release cannot be automatically achieved");
  return { schema_version: 1, artifact: "outcome-evaluation", version: 1, revision: integer(record.revision, `${context}.revision`), evaluation_id: id(record.evaluation_id, `${context}.evaluation_id`), intent_id: text(record.intent_id, `${context}.intent_id`), stage_id: "ST-09", disposition: choice(record.disposition, ["execute", "reuse"] as const, `${context}.disposition`), work_request_ref: parseArtifactReference(record.work_request_ref, `${context}.work_request_ref`), outcome_evidence_ref: parseArtifactReference(record.outcome_evidence_ref, `${context}.outcome_evidence_ref`), gate_requirement_set_ref: parseArtifactReference(record.gate_requirement_set_ref, `${context}.gate_requirement_set_ref`), release_outcome: released, signal_results: signalResults, overall_result: overall, reason: text(record.reason, `${context}.reason`), evaluated_at: iso(record.evaluated_at, `${context}.evaluated_at`) };
}

export function parseOutcomeHumanDecision(value: unknown, context = "Outcome Human Decision"): OutcomeHumanDecision {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, ["schema_version", "artifact", "version", "decision_id", "intent_id", "outcome_evaluation_ref", "gate_requirement_set_ref", "policy_acknowledgements", "decision", "reason", "decided_by", "decided_at", "not_before", "deadline"], context);
  if (record.schema_version !== 1 || record.version !== 1 || record.artifact !== "outcome-human-decision") fail(context, "must define outcome-human-decision version 1");
  if (record.decided_by !== "human") fail(`${context}.decided_by`, "must equal human");
  if (!Array.isArray(record.policy_acknowledgements)) fail(`${context}.policy_acknowledgements`, "must be an array");
  const decision = choice(record.decision, OUTCOME_DECISIONS, `${context}.decision`);
  const notBefore = nullableIso(record.not_before, `${context}.not_before`);
  const deadline = nullableIso(record.deadline, `${context}.deadline`);
  if (decision === "continue-observation" && notBefore === null) fail(`${context}.not_before`, "is required when observation continues");
  if (decision !== "continue-observation" && (notBefore !== null || deadline !== null)) fail(context, "completion decisions cannot schedule another observation");
  if (notBefore !== null && deadline !== null && Date.parse(deadline) <= Date.parse(notBefore)) fail(`${context}.deadline`, "must be after not_before");
  return { schema_version: 1, artifact: "outcome-human-decision", version: 1, decision_id: id(record.decision_id, `${context}.decision_id`), intent_id: text(record.intent_id, `${context}.intent_id`), outcome_evaluation_ref: parseArtifactReference(record.outcome_evaluation_ref, `${context}.outcome_evaluation_ref`), gate_requirement_set_ref: parseArtifactReference(record.gate_requirement_set_ref, `${context}.gate_requirement_set_ref`), policy_acknowledgements: record.policy_acknowledgements.map((entry, index) => parsePolicyAcknowledgement(entry, `${context}.policy_acknowledgements[${index}]`)), decision, reason: text(record.reason, `${context}.reason`), decided_by: "human", decided_at: iso(record.decided_at, `${context}.decided_at`), not_before: notBefore, deadline };
}

export function parseFollowUpBrief(value: unknown, context = "Follow-up Brief"): FollowUpBrief {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, ["schema_version", "artifact", "version", "brief_id", "source_intent_id", "outcome_evaluation_ref", "human_decision_ref", "title", "problem_summary", "unresolved_signal_ids", "created_at"], context);
  if (record.schema_version !== 1 || record.version !== 1 || record.artifact !== "follow-up-brief") fail(context, "must define follow-up-brief version 1");
  const unresolved = strings(record.unresolved_signal_ids, `${context}.unresolved_signal_ids`, 1).map((entry, index) => id(entry, `${context}.unresolved_signal_ids[${index}]`, SIGNAL_ID));
  return { schema_version: 1, artifact: "follow-up-brief", version: 1, brief_id: id(record.brief_id, `${context}.brief_id`), source_intent_id: text(record.source_intent_id, `${context}.source_intent_id`), outcome_evaluation_ref: parseArtifactReference(record.outcome_evaluation_ref, `${context}.outcome_evaluation_ref`), human_decision_ref: parseArtifactReference(record.human_decision_ref, `${context}.human_decision_ref`), title: text(record.title, `${context}.title`), problem_summary: text(record.problem_summary, `${context}.problem_summary`), unresolved_signal_ids: unresolved, created_at: iso(record.created_at, `${context}.created_at`) };
}

export function parseOutcomeCurrent(value: unknown, context = "Outcome Current"): OutcomeCurrent {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, ["schema_version", "artifact", "version", "intent_id", "disposition", "overall_result", "completion_mode", "work_request_ref", "outcome_evidence_ref", "outcome_evaluation_ref", "human_decision_ref", "follow_up_brief_ref", "reason", "completed_at"], context);
  if (record.schema_version !== 1 || record.version !== 1 || record.artifact !== "outcome-current") fail(context, "must define outcome-current version 1");
  const mode = choice(record.completion_mode, ["auto-achieved", "human-accepted", "human-follow-up", "reused"] as const, `${context}.completion_mode`);
  const human = record.human_decision_ref === null ? null : parseArtifactReference(record.human_decision_ref, `${context}.human_decision_ref`);
  const followUp = record.follow_up_brief_ref === null ? null : parseArtifactReference(record.follow_up_brief_ref, `${context}.follow_up_brief_ref`);
  if (mode === "auto-achieved" && (record.overall_result !== "achieved" || human !== null || followUp !== null)) fail(context, "auto-achieved requires achieved without a human decision or Follow-up Brief");
  if ((mode === "human-accepted" || mode === "human-follow-up") && human === null) fail(context, `${mode} requires a human decision`);
  if ((mode === "human-follow-up") !== (followUp !== null)) fail(context, "Follow-up Brief must exist only for human-follow-up");
  if (mode === "reused" && record.disposition !== "reuse") fail(context, "reused completion requires reuse disposition");
  return { schema_version: 1, artifact: "outcome-current", version: 1, intent_id: text(record.intent_id, `${context}.intent_id`), disposition: choice(record.disposition, ["execute", "reuse"] as const, `${context}.disposition`), overall_result: result(record.overall_result, `${context}.overall_result`), completion_mode: mode, work_request_ref: parseArtifactReference(record.work_request_ref, `${context}.work_request_ref`), outcome_evidence_ref: parseArtifactReference(record.outcome_evidence_ref, `${context}.outcome_evidence_ref`), outcome_evaluation_ref: parseArtifactReference(record.outcome_evaluation_ref, `${context}.outcome_evaluation_ref`), human_decision_ref: human, follow_up_brief_ref: followUp, reason: text(record.reason, `${context}.reason`), completed_at: iso(record.completed_at, `${context}.completed_at`) };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderOutcomeEvaluationHtml(evaluation: OutcomeEvaluation, gateSection = ""): string {
  const label: Record<OutcomeResult, string> = { achieved: "達成", partially_achieved: "一部達成", not_achieved: "未達成", inconclusive: "判断不能" };
  const rows = evaluation.signal_results.map((entry) => `<tr><td>${escapeHtml(entry.signal_id)}</td><td>${label[entry.result]}</td><td>${escapeHtml(entry.reason)}</td><td>${escapeHtml(entry.observed_at)}</td></tr>`).join("");
  return `<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ST-09 Outcome Evaluation</title><style>body{margin:0;background:#f5f7fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.7}main{max-width:960px;margin:auto;padding:32px 18px}header,section{background:#fff;border:1px solid #dbe3f0;border-radius:18px;padding:24px;margin-bottom:16px}h1,h2{margin-top:0}.result{display:inline-block;padding:8px 14px;border-radius:999px;background:#e8f5ee;color:#17633b;font-weight:800}table{width:100%;border-collapse:collapse}th,td{border:1px solid #dbe3f0;padding:10px;text-align:left;vertical-align:top}th{background:#f3f6fb}@media(max-width:680px){table{font-size:13px}}</style></head><body><main><header><p>AI-DLC vNext / ST-09</p><h1>Outcome Evaluation</h1><p>最初に決めた成功条件と、実際に観測した事実を比較した結果です。</p><span class="result">${label[evaluation.overall_result]}</span></header><section><h2>全体結果</h2><p>${escapeHtml(evaluation.reason)}</p><p>Release結果: ${escapeHtml(evaluation.release_outcome)}</p></section><section><h2>条件ごとの確認</h2><table><thead><tr><th>条件ID</th><th>結果</th><th>理由</th><th>確認時刻</th></tr></thead><tbody>${rows}</tbody></table></section>${gateSection}</main></body></html>\n`;
}
