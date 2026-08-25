import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";
import type { RunnableSourceResult } from "./aidlc-vnext-build-converge-contract.ts";
import {
  parsePolicyAcknowledgement,
  type PolicyAcknowledgement,
} from "./aidlc-vnext-policy-gates.ts";

export const REVIEW_SCHEMA_VERSION = 1 as const;
export const REVIEW_ARTIFACT_VERSION = 1 as const;
export const REVIEW_FEEDBACK_REASONS = [
  "requirements_changed",
  "architecture_impact",
  "build_contract_impact",
  "candidate_defect",
] as const;

export type ReviewFeedbackReason = (typeof REVIEW_FEEDBACK_REASONS)[number];

export interface ReviewRequirementSummary {
  requirement_id: string;
  statement: string;
}

export interface ReviewAcceptanceCriterion {
  criterion_id: string;
  requirement_ids: string[];
  given: string;
  when: string;
  then: string;
  verifier_ids: string[];
}

export interface ReviewHumanCheck {
  verifier_id: string;
  expected: string;
}

export interface ReviewManifest {
  schema_version: typeof REVIEW_SCHEMA_VERSION;
  artifact: "review-manifest";
  version: typeof REVIEW_ARTIFACT_VERSION;
  intent_id: string;
  stage_id: "ST-07";
  disposition: "execute" | "reuse";
  build_current_ref: ArtifactReference;
  runnable_candidate_ref: ArtifactReference;
  requirements_ref: ArtifactReference;
  architecture_current_ref: ArtifactReference;
  build_contract_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  source_results: RunnableSourceResult[];
  requirements: ReviewRequirementSummary[];
  acceptance_criteria: ReviewAcceptanceCriterion[];
  machine_evidence_refs: ArtifactReference[];
  human_checks: ReviewHumanCheck[];
  known_constraints: string[];
  created_at: string;
}

export interface HumanCheckResult {
  verifier_id: string;
  result: "passed" | "failed";
  note: string;
}

export interface ReviewFeedbackItem {
  feedback_id: string;
  summary: string;
  requirement_ids: string[];
  impacts: ReviewFeedbackReason[];
}

export interface CandidateReviewDecision {
  schema_version: typeof REVIEW_SCHEMA_VERSION;
  artifact: "human-decision";
  version: typeof REVIEW_ARTIFACT_VERSION;
  decision_id: string;
  decision_kind: "candidate-review";
  intent_id: string;
  review_manifest_ref: ArtifactReference;
  runnable_candidate_ref: ArtifactReference;
  gate_requirement_set_ref: ArtifactReference;
  policy_acknowledgements: PolicyAcknowledgement[];
  decision: "approve-runnable-candidate" | "request-changes";
  human_check_results: HumanCheckResult[];
  feedback_items: ReviewFeedbackItem[];
  reason: string;
  decided_by: "human";
  decided_at: string;
}

export interface AcceptedCandidate {
  schema_version: typeof REVIEW_SCHEMA_VERSION;
  artifact: "accepted-candidate";
  version: typeof REVIEW_ARTIFACT_VERSION;
  intent_id: string;
  runnable_candidate_ref: ArtifactReference;
  review_manifest_ref: ArtifactReference;
  approval_ref: ArtifactReference;
  requirements_ref: ArtifactReference;
  architecture_current_ref: ArtifactReference;
  build_contract_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  source_results: RunnableSourceResult[];
  accepted_at: string;
}

export interface FeedbackCurrent {
  schema_version: typeof REVIEW_SCHEMA_VERSION;
  artifact: "feedback-current";
  version: typeof REVIEW_ARTIFACT_VERSION;
  intent_id: string;
  review_manifest_ref: ArtifactReference;
  human_decision_ref: ArtifactReference;
  rejected_candidate_ref: ArtifactReference;
  feedback_items: ReviewFeedbackItem[];
  selected_reason: ReviewFeedbackReason;
  return_stage: "ST-03" | "ST-04" | "ST-05" | "ST-06";
  invalidated_stages: string[];
  reason: string;
  updated_at: string;
}

export interface ReviewCurrent {
  schema_version: typeof REVIEW_SCHEMA_VERSION;
  artifact: "review-current";
  version: typeof REVIEW_ARTIFACT_VERSION;
  intent_id: string;
  disposition: "execute" | "reuse" | "not_applicable";
  outcome: "approved" | "feedback" | "not_applicable";
  review_manifest_ref: ArtifactReference | null;
  human_decision_ref: ArtifactReference;
  accepted_candidate_ref: ArtifactReference | null;
  feedback_current_ref: ArtifactReference | null;
  reason: string;
  updated_at: string;
}

const SHA1 = /^[a-f0-9]{40,64}$/;
const ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const REQUIREMENT_ID = /^(?:REQ-[A-Z]+|CON|INV)-\d{3}$/;
const CRITERION_ID = /^AC-\d{3}$/;
const VERIFIER_ID = /^VER-[A-Za-z0-9._-]+$/;
const FEEDBACK_ID = /^FB-\d{3}$/;
const SECRET = /(?:^|[_-])(secret|password|passwd|token|api[_-]?key|credential|private[_-]?key)(?:$|[_-])/i;

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}

function noSecrets(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => noSecrets(entry, `${context}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET.test(key)) fail(context, `secret-bearing field is prohibited: ${key}`);
    noSecrets(child, `${context}.${key}`);
  }
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\r\n\0]/.test(value)) {
    fail(context, "must be a non-empty single-line string");
  }
  return value;
}

function id(value: unknown, context: string, pattern: RegExp = ID): string {
  const result = text(value, context);
  if (!pattern.test(result)) fail(context, "has an invalid identifier format");
  return result;
}

function timestamp(value: unknown, context: string): string {
  const result = text(value, context);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) fail(context, "must be an ISO-8601 UTC timestamp");
  return result;
}

function uniqueStrings(value: unknown, context: string, minimum = 0, pattern?: RegExp): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const result = value.map((entry, index) => pattern === undefined ? text(entry, `${context}[${index}]`) : id(entry, `${context}[${index}]`, pattern));
  if (result.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  if (new Set(result).size !== result.length) fail(context, "must not contain duplicates");
  return result;
}

function references(value: unknown, context: string, minimum = 0): ArtifactReference[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  if (value.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  return value.map((entry, index) => parseArtifactReference(entry, `${context}[${index}]`));
}

function nullableReference(value: unknown, context: string): ArtifactReference | null {
  return value === null ? null : parseArtifactReference(value, context);
}

function common(record: Record<string, unknown>, artifact: string, context: string): void {
  if (record.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (record.artifact !== artifact) fail(`${context}.artifact`, `must equal ${artifact}`);
  if (record.version !== 1) fail(`${context}.version`, "must equal 1");
}

function parseSourceResult(value: unknown, context: string): RunnableSourceResult {
  const record = object(value, context);
  rejectUnknown(record, ["repository_id", "source_ids", "source_locator", "base_revision", "candidate_revision", "integration_branch", "changed_files"], context);
  const baseRevision = text(record.base_revision, `${context}.base_revision`);
  const candidateRevision = text(record.candidate_revision, `${context}.candidate_revision`);
  if (!SHA1.test(baseRevision) && !/^\d+$/.test(baseRevision)) fail(`${context}.base_revision`, "must be a Git revision");
  if (!SHA1.test(candidateRevision) && !/^\d+$/.test(candidateRevision)) fail(`${context}.candidate_revision`, "must be a Git revision");
  return {
    repository_id: id(record.repository_id, `${context}.repository_id`),
    source_ids: uniqueStrings(record.source_ids, `${context}.source_ids`, 1),
    source_locator: text(record.source_locator, `${context}.source_locator`),
    base_revision: baseRevision,
    candidate_revision: candidateRevision,
    integration_branch: record.integration_branch === undefined ? "review-snapshot" : text(record.integration_branch, `${context}.integration_branch`),
    changed_files: uniqueStrings(record.changed_files, `${context}.changed_files`, 1),
  };
}

function parseRequirement(value: unknown, context: string): ReviewRequirementSummary {
  const record = object(value, context);
  rejectUnknown(record, ["requirement_id", "statement"], context);
  return {
    requirement_id: id(record.requirement_id, `${context}.requirement_id`, REQUIREMENT_ID),
    statement: text(record.statement, `${context}.statement`),
  };
}

function parseAcceptance(value: unknown, context: string): ReviewAcceptanceCriterion {
  const record = object(value, context);
  rejectUnknown(record, ["criterion_id", "requirement_ids", "given", "when", "then", "verifier_ids"], context);
  return {
    criterion_id: id(record.criterion_id, `${context}.criterion_id`, CRITERION_ID),
    requirement_ids: uniqueStrings(record.requirement_ids, `${context}.requirement_ids`, 1, REQUIREMENT_ID),
    given: text(record.given, `${context}.given`),
    when: text(record.when, `${context}.when`),
    then: text(record.then, `${context}.then`),
    verifier_ids: uniqueStrings(record.verifier_ids, `${context}.verifier_ids`, 1, VERIFIER_ID),
  };
}

function parseHumanCheck(value: unknown, context: string): ReviewHumanCheck {
  const record = object(value, context);
  rejectUnknown(record, ["verifier_id", "expected"], context);
  return {
    verifier_id: id(record.verifier_id, `${context}.verifier_id`, VERIFIER_ID),
    expected: text(record.expected, `${context}.expected`),
  };
}

export function parseReviewManifest(value: unknown, context = "Review Manifest"): ReviewManifest {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, [
    "schema_version", "artifact", "version", "intent_id", "stage_id", "disposition",
    "build_current_ref", "runnable_candidate_ref", "requirements_ref", "architecture_current_ref",
    "build_contract_ref", "effective_policy_ref", "system_map_ref", "source_results", "requirements",
    "acceptance_criteria", "machine_evidence_refs", "human_checks", "known_constraints", "created_at",
  ], context);
  common(record, "review-manifest", context);
  if (record.stage_id !== "ST-07") fail(`${context}.stage_id`, "must equal ST-07");
  if (record.disposition !== "execute" && record.disposition !== "reuse") fail(`${context}.disposition`, "must be execute or reuse");
  if (!Array.isArray(record.source_results) || record.source_results.length === 0) fail(`${context}.source_results`, "must contain at least one source result");
  if (!Array.isArray(record.requirements) || record.requirements.length === 0) fail(`${context}.requirements`, "must contain at least one requirement");
  if (!Array.isArray(record.acceptance_criteria) || record.acceptance_criteria.length === 0) fail(`${context}.acceptance_criteria`, "must contain at least one criterion");
  if (!Array.isArray(record.human_checks)) fail(`${context}.human_checks`, "must be an array");
  const requirements = record.requirements.map((entry, index) => parseRequirement(entry, `${context}.requirements[${index}]`));
  const requirementIds = new Set(requirements.map((entry) => entry.requirement_id));
  if (requirementIds.size !== requirements.length) fail(`${context}.requirements`, "contains duplicate requirement_id");
  const acceptance = record.acceptance_criteria.map((entry, index) => parseAcceptance(entry, `${context}.acceptance_criteria[${index}]`));
  for (const criterion of acceptance) {
    if (criterion.requirement_ids.some((entry) => !requirementIds.has(entry))) fail(`${context}.acceptance_criteria`, `references unknown requirement ${criterion.requirement_ids.find((entry) => !requirementIds.has(entry))}`);
  }
  const humanChecks = record.human_checks.map((entry, index) => parseHumanCheck(entry, `${context}.human_checks[${index}]`));
  if (new Set(humanChecks.map((entry) => entry.verifier_id)).size !== humanChecks.length) fail(`${context}.human_checks`, "contains duplicate verifier_id");
  return {
    schema_version: 1,
    artifact: "review-manifest",
    version: 1,
    intent_id: id(record.intent_id, `${context}.intent_id`),
    stage_id: "ST-07",
    disposition: record.disposition,
    build_current_ref: parseArtifactReference(record.build_current_ref, `${context}.build_current_ref`),
    runnable_candidate_ref: parseArtifactReference(record.runnable_candidate_ref, `${context}.runnable_candidate_ref`),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    architecture_current_ref: parseArtifactReference(record.architecture_current_ref, `${context}.architecture_current_ref`),
    build_contract_ref: parseArtifactReference(record.build_contract_ref, `${context}.build_contract_ref`),
    effective_policy_ref: parseArtifactReference(record.effective_policy_ref, `${context}.effective_policy_ref`),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    source_results: record.source_results.map((entry, index) => parseSourceResult(entry, `${context}.source_results[${index}]`)),
    requirements,
    acceptance_criteria: acceptance,
    machine_evidence_refs: references(record.machine_evidence_refs, `${context}.machine_evidence_refs`),
    human_checks: humanChecks,
    known_constraints: uniqueStrings(record.known_constraints, `${context}.known_constraints`),
    created_at: timestamp(record.created_at, `${context}.created_at`),
  };
}

function parseHumanCheckResult(value: unknown, context: string): HumanCheckResult {
  const record = object(value, context);
  rejectUnknown(record, ["verifier_id", "result", "note"], context);
  if (record.result !== "passed" && record.result !== "failed") fail(`${context}.result`, "must be passed or failed");
  return {
    verifier_id: id(record.verifier_id, `${context}.verifier_id`, VERIFIER_ID),
    result: record.result,
    note: text(record.note, `${context}.note`),
  };
}

export function parseReviewFeedbackItem(value: unknown, context = "Review Feedback Item"): ReviewFeedbackItem {
  const record = object(value, context);
  rejectUnknown(record, ["feedback_id", "summary", "requirement_ids", "impacts"], context);
  const impacts = uniqueStrings(record.impacts, `${context}.impacts`, 1).map((entry) => {
    if (!(REVIEW_FEEDBACK_REASONS as readonly string[]).includes(entry)) fail(`${context}.impacts`, `unknown impact ${entry}`);
    return entry as ReviewFeedbackReason;
  });
  return {
    feedback_id: id(record.feedback_id, `${context}.feedback_id`, FEEDBACK_ID),
    summary: text(record.summary, `${context}.summary`),
    requirement_ids: uniqueStrings(record.requirement_ids, `${context}.requirement_ids`, 1, REQUIREMENT_ID),
    impacts,
  };
}

export function parseCandidateReviewDecision(value: unknown, context = "Candidate Review Decision"): CandidateReviewDecision {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, [
    "schema_version", "artifact", "version", "decision_id", "decision_kind", "intent_id",
    "review_manifest_ref", "runnable_candidate_ref", "gate_requirement_set_ref", "policy_acknowledgements", "decision", "human_check_results",
    "feedback_items", "reason", "decided_by", "decided_at",
  ], context);
  common(record, "human-decision", context);
  if (record.decision_kind !== "candidate-review") fail(`${context}.decision_kind`, "must equal candidate-review");
  if (record.decided_by !== "human") fail(`${context}.decided_by`, "must equal human");
  if (record.decision !== "approve-runnable-candidate" && record.decision !== "request-changes") fail(`${context}.decision`, "must be approve-runnable-candidate or request-changes");
  if (!Array.isArray(record.policy_acknowledgements) || !Array.isArray(record.human_check_results) || !Array.isArray(record.feedback_items)) fail(context, "policy_acknowledgements, human_check_results, and feedback_items must be arrays");
  const acknowledgements = record.policy_acknowledgements.map((entry, index) => parsePolicyAcknowledgement(entry, `${context}.policy_acknowledgements[${index}]`));
  const checks = record.human_check_results.map((entry, index) => parseHumanCheckResult(entry, `${context}.human_check_results[${index}]`));
  if (new Set(checks.map((entry) => entry.verifier_id)).size !== checks.length) fail(`${context}.human_check_results`, "contains duplicate verifier_id");
  const feedback = record.feedback_items.map((entry, index) => parseReviewFeedbackItem(entry, `${context}.feedback_items[${index}]`));
  if (new Set(feedback.map((entry) => entry.feedback_id)).size !== feedback.length) fail(`${context}.feedback_items`, "contains duplicate feedback_id");
  if (record.decision === "approve-runnable-candidate" && feedback.length !== 0) fail(`${context}.feedback_items`, "approval requires feedback_items to be empty");
  if (record.decision === "request-changes" && feedback.length === 0) fail(`${context}.feedback_items`, "request-changes requires at least one feedback item");
  return {
    schema_version: 1,
    artifact: "human-decision",
    version: 1,
    decision_id: id(record.decision_id, `${context}.decision_id`),
    decision_kind: "candidate-review",
    intent_id: id(record.intent_id, `${context}.intent_id`),
    review_manifest_ref: parseArtifactReference(record.review_manifest_ref, `${context}.review_manifest_ref`),
    runnable_candidate_ref: parseArtifactReference(record.runnable_candidate_ref, `${context}.runnable_candidate_ref`),
    gate_requirement_set_ref: parseArtifactReference(record.gate_requirement_set_ref, `${context}.gate_requirement_set_ref`),
    policy_acknowledgements: acknowledgements,
    decision: record.decision,
    human_check_results: checks,
    feedback_items: feedback,
    reason: text(record.reason, `${context}.reason`),
    decided_by: "human",
    decided_at: timestamp(record.decided_at, `${context}.decided_at`),
  };
}

export function parseAcceptedCandidate(value: unknown, context = "Accepted Candidate"): AcceptedCandidate {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, [
    "schema_version", "artifact", "version", "intent_id", "runnable_candidate_ref", "review_manifest_ref",
    "approval_ref", "requirements_ref", "architecture_current_ref", "build_contract_ref", "system_map_ref",
    "source_results", "accepted_at",
  ], context);
  common(record, "accepted-candidate", context);
  if (!Array.isArray(record.source_results) || record.source_results.length === 0) fail(`${context}.source_results`, "must contain at least one source result");
  return {
    schema_version: 1, artifact: "accepted-candidate", version: 1,
    intent_id: id(record.intent_id, `${context}.intent_id`),
    runnable_candidate_ref: parseArtifactReference(record.runnable_candidate_ref, `${context}.runnable_candidate_ref`),
    review_manifest_ref: parseArtifactReference(record.review_manifest_ref, `${context}.review_manifest_ref`),
    approval_ref: parseArtifactReference(record.approval_ref, `${context}.approval_ref`),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    architecture_current_ref: parseArtifactReference(record.architecture_current_ref, `${context}.architecture_current_ref`),
    build_contract_ref: parseArtifactReference(record.build_contract_ref, `${context}.build_contract_ref`),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    source_results: record.source_results.map((entry, index) => parseSourceResult(entry, `${context}.source_results[${index}]`)),
    accepted_at: timestamp(record.accepted_at, `${context}.accepted_at`),
  };
}

export function parseFeedbackCurrent(value: unknown, context = "Feedback Current"): FeedbackCurrent {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, [
    "schema_version", "artifact", "version", "intent_id", "review_manifest_ref", "human_decision_ref",
    "rejected_candidate_ref", "feedback_items", "selected_reason", "return_stage", "invalidated_stages",
    "reason", "updated_at",
  ], context);
  common(record, "feedback-current", context);
  if (!Array.isArray(record.feedback_items) || record.feedback_items.length === 0) fail(`${context}.feedback_items`, "must contain at least one item");
  const selected = text(record.selected_reason, `${context}.selected_reason`);
  if (!(REVIEW_FEEDBACK_REASONS as readonly string[]).includes(selected)) fail(`${context}.selected_reason`, "is not a fixed feedback reason");
  const stage = text(record.return_stage, `${context}.return_stage`);
  if (!["ST-03", "ST-04", "ST-05", "ST-06"].includes(stage)) fail(`${context}.return_stage`, "must be ST-03, ST-04, ST-05, or ST-06");
  return {
    schema_version: 1, artifact: "feedback-current", version: 1,
    intent_id: id(record.intent_id, `${context}.intent_id`),
    review_manifest_ref: parseArtifactReference(record.review_manifest_ref, `${context}.review_manifest_ref`),
    human_decision_ref: parseArtifactReference(record.human_decision_ref, `${context}.human_decision_ref`),
    rejected_candidate_ref: parseArtifactReference(record.rejected_candidate_ref, `${context}.rejected_candidate_ref`),
    feedback_items: record.feedback_items.map((entry, index) => parseReviewFeedbackItem(entry, `${context}.feedback_items[${index}]`)),
    selected_reason: selected as ReviewFeedbackReason,
    return_stage: stage as FeedbackCurrent["return_stage"],
    invalidated_stages: uniqueStrings(record.invalidated_stages, `${context}.invalidated_stages`, 2),
    reason: text(record.reason, `${context}.reason`),
    updated_at: timestamp(record.updated_at, `${context}.updated_at`),
  };
}

export function parseReviewCurrent(value: unknown, context = "Review Current"): ReviewCurrent {
  noSecrets(value, context);
  const record = object(value, context);
  rejectUnknown(record, [
    "schema_version", "artifact", "version", "intent_id", "disposition", "outcome", "review_manifest_ref",
    "human_decision_ref", "accepted_candidate_ref", "feedback_current_ref", "reason", "updated_at",
  ], context);
  common(record, "review-current", context);
  const disposition = text(record.disposition, `${context}.disposition`);
  if (!["execute", "reuse", "not_applicable"].includes(disposition)) fail(`${context}.disposition`, "is invalid");
  const outcome = text(record.outcome, `${context}.outcome`);
  if (!["approved", "feedback", "not_applicable"].includes(outcome)) fail(`${context}.outcome`, "is invalid");
  const manifest = nullableReference(record.review_manifest_ref, `${context}.review_manifest_ref`);
  const accepted = nullableReference(record.accepted_candidate_ref, `${context}.accepted_candidate_ref`);
  const feedback = nullableReference(record.feedback_current_ref, `${context}.feedback_current_ref`);
  if (outcome === "approved" && (manifest === null || accepted === null || feedback !== null)) fail(context, "approved outcome requires Manifest and Accepted Candidate only");
  if (outcome === "feedback" && (manifest === null || accepted !== null || feedback === null)) fail(context, "feedback outcome requires Manifest and Feedback Current only");
  if (outcome === "not_applicable" && (manifest !== null || accepted !== null || feedback !== null || disposition !== "not_applicable")) fail(context, "not_applicable outcome cannot reference review artifacts");
  return {
    schema_version: 1, artifact: "review-current", version: 1,
    intent_id: id(record.intent_id, `${context}.intent_id`),
    disposition: disposition as ReviewCurrent["disposition"],
    outcome: outcome as ReviewCurrent["outcome"],
    review_manifest_ref: manifest,
    human_decision_ref: parseArtifactReference(record.human_decision_ref, `${context}.human_decision_ref`),
    accepted_candidate_ref: accepted,
    feedback_current_ref: feedback,
    reason: text(record.reason, `${context}.reason`),
    updated_at: timestamp(record.updated_at, `${context}.updated_at`),
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderCandidateReviewHtml(manifest: ReviewManifest, gateSection = ""): string {
  const requirements = manifest.requirements.map((entry) => `<li><b>${escapeHtml(entry.requirement_id)}</b> ${escapeHtml(entry.statement)}</li>`).join("");
  const criteria = manifest.acceptance_criteria.map((entry) => `<article><b>${escapeHtml(entry.criterion_id)}</b><p>${escapeHtml(entry.given)} → ${escapeHtml(entry.when)} → ${escapeHtml(entry.then)}</p></article>`).join("");
  const sources = manifest.source_results.map((entry) => `<article><b>${escapeHtml(entry.repository_id)}</b><p>base revision: ${escapeHtml(entry.base_revision)}</p><p>candidate revision: ${escapeHtml(entry.candidate_revision)}</p><ul>${entry.changed_files.map((path) => `<li>${escapeHtml(path)}</li>`).join("")}</ul></article>`).join("");
  const checks = manifest.human_checks.length === 0 ? "<p>追加の人間確認項目はありません。</p>" : `<ul>${manifest.human_checks.map((entry) => `<li><b>${escapeHtml(entry.verifier_id)}</b> ${escapeHtml(entry.expected)}</li>`).join("")}</ul>`;
  const constraints = manifest.known_constraints.length === 0 ? "<p>記録された制約はありません。</p>" : `<ul>${manifest.known_constraints.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>`;
  const evidence = manifest.machine_evidence_refs.length === 0 ? "<p>追加の機械Evidenceはありません。</p>" : `<ul>${manifest.machine_evidence_refs.map((entry) => `<li><b>${escapeHtml(entry.artifact)}</b> ${escapeHtml(entry.source_of_truth)}<br><code>${escapeHtml(entry.sha256)}</code></li>`).join("")}</ul>`;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ST-07 Candidate Review</title><style>
:root{--ink:#172033;--muted:#617087;--line:#dce4ef;--blue:#2563eb;--green:#147a55;--soft:#f5f8fc}*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.7}main{width:min(980px,calc(100% - 24px));margin:28px auto}header,section{margin-bottom:18px;padding:28px;border:1px solid var(--line);border-radius:20px;background:#fff}h1,h2,p{margin-top:0}.tag{color:var(--blue);font-weight:900}.lead{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.grid article{padding:16px;border-radius:14px;background:var(--soft)}code{word-break:break-all}.approval{border-left:6px solid var(--green)}@media(max-width:650px){.grid{grid-template-columns:1fr}}
</style></head><body><main><header><p class="tag">AI-DLC vNext / ST-07</p><h1>完成候補の確認</h1><p class="lead">この画面の対象はReview ManifestとRunnable CandidateのSHA-256で固定されています。</p><code>${escapeHtml(manifest.runnable_candidate_ref.sha256)}</code></header>
<section><h2>満たすべき要求</h2><ul>${requirements}</ul></section>
<section><h2>合格条件</h2><div class="grid">${criteria}</div></section>
<section><h2>変更されたCandidate revision</h2><div class="grid">${sources}</div></section>
<section><h2>合格済みの機械Evidence</h2>${evidence}</section>
<section><h2>人間が確認すること</h2>${checks}</section>
<section><h2>変えてはいけないこと・既知制約</h2>${constraints}</section>
${gateSection}
<section class="approval"><h2>人間の判断</h2><p>問題がなければ、このCandidateを明示的に承認します。問題があれば、要求・構成・Build Contract・実装のどこを見直すか指定します。</p></section></main></body></html>
`;
}
