import { isAbsolute } from "node:path";
import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";
import {
  parseBoltDefinition,
  parseBuildAcceptanceCriterion,
  parseBuildChangeContract,
  parseBuildVerifier,
  type BoltDefinition,
  type BuildAcceptanceCriterion,
  type BuildChangeContract,
  type BuildVerifier,
} from "./aidlc-vnext-build-contract-contract.ts";

export const BUILD_CONVERGE_SCHEMA_VERSION = 1 as const;
export const BUILD_CONVERGE_ARTIFACT_VERSION = 1 as const;
export const BUILD_SESSION_STATUSES = ["active", "blocked", "completed"] as const;
export const BUILD_ATTEMPT_OUTCOMES = ["passed", "failed", "blocked"] as const;
export const VERIFIER_RESULTS = ["passed", "failed", "deferred"] as const;

export type BuildSessionStatus = (typeof BUILD_SESSION_STATUSES)[number];
export type BuildAttemptOutcome = (typeof BUILD_ATTEMPT_OUTCOMES)[number];
export type VerifierResult = (typeof VERIFIER_RESULTS)[number];

export interface BuildSourceBinding {
  source_id: string;
  locator: string;
  relative_path: string;
}

export interface BuildRepositoryWorkspace {
  repository_id: string;
  repository_root: string;
  base_revision: string;
  working_revision: string;
  integration_branch: string;
  integration_worktree: string;
  sources: BuildSourceBinding[];
}

export interface BuildSession {
  schema_version: typeof BUILD_CONVERGE_SCHEMA_VERSION;
  artifact: "build-session";
  version: typeof BUILD_CONVERGE_ARTIFACT_VERSION;
  session_id: string;
  intent_id: string;
  stage_id: "ST-06";
  disposition: "execute";
  status: BuildSessionStatus;
  build_contract_current_ref: ArtifactReference;
  build_contract_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  completed_bolt_ids: string[];
  current_bolt_id: string | null;
  repositories: BuildRepositoryWorkspace[];
  last_failure_signature: string | null;
  same_failure_count: number;
  blocked_reason: string | null;
  started_at: string;
  updated_at: string;
}

export interface BoltSourceWorkspace {
  source_id: string;
  locator: string;
  repository_id: string;
  repository_root: string;
  worktree_path: string;
  base_revision: string;
}

export interface BoltWorkRequest {
  schema_version: typeof BUILD_CONVERGE_SCHEMA_VERSION;
  artifact: "bolt-work-request";
  version: typeof BUILD_CONVERGE_ARTIFACT_VERSION;
  session_id: string;
  intent_id: string;
  stage_id: "ST-06";
  build_contract_ref: ArtifactReference;
  bolt: BoltDefinition;
  change_contracts: BuildChangeContract[];
  acceptance_criteria: BuildAcceptanceCriterion[];
  verifiers: BuildVerifier[];
  attempt: number;
  source_workspaces: BoltSourceWorkspace[];
  requested_output: "repository-changes";
  rules: string[];
  created_at: string;
}

export interface BuildChangedFile {
  source_id: string;
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  sha256: string | null;
}

export interface VerifierEvidence {
  schema_version: typeof BUILD_CONVERGE_SCHEMA_VERSION;
  artifact: "verifier-evidence";
  version: typeof BUILD_CONVERGE_ARTIFACT_VERSION;
  intent_id: string;
  session_id: string;
  bolt_id: string | null;
  attempt: number | null;
  scope: "bolt" | "integration";
  verifier_id: string;
  verifier_kind: "command" | "runtime" | "artifact" | "human-at-st07";
  result: VerifierResult;
  exit_code: number | null;
  stdout_sha256: string | null;
  stderr_sha256: string | null;
  detail: string;
  executed_at: string;
}

export interface BuildAttemptCheckpoint {
  schema_version: typeof BUILD_CONVERGE_SCHEMA_VERSION;
  artifact: "build-attempt-checkpoint";
  version: typeof BUILD_CONVERGE_ARTIFACT_VERSION;
  intent_id: string;
  session_id: string;
  build_contract_ref: ArtifactReference;
  bolt_id: string;
  attempt: number;
  outcome: BuildAttemptOutcome;
  changed_files: BuildChangedFile[];
  verifier_evidence_refs: ArtifactReference[];
  failure_signature: string | null;
  reason: string;
  created_at: string;
}

export interface RunnableSourceResult {
  repository_id: string;
  source_ids: string[];
  source_locator: string;
  base_revision: string;
  candidate_revision: string;
  integration_branch: string;
  changed_files: string[];
}

export interface RunnableCandidate {
  schema_version: typeof BUILD_CONVERGE_SCHEMA_VERSION;
  artifact: "runnable-candidate";
  version: typeof BUILD_CONVERGE_ARTIFACT_VERSION;
  intent_id: string;
  session_id: string;
  disposition: "execute";
  build_contract_ref: ArtifactReference;
  source_results: RunnableSourceResult[];
  bolt_checkpoint_refs: ArtifactReference[];
  integration_verifier_evidence_refs: ArtifactReference[];
  created_at: string;
}

export interface BuildCurrent {
  schema_version: typeof BUILD_CONVERGE_SCHEMA_VERSION;
  artifact: "build-current";
  version: typeof BUILD_CONVERGE_ARTIFACT_VERSION;
  intent_id: string;
  disposition: "execute" | "reuse" | "not_applicable";
  build_contract_current_ref: ArtifactReference;
  runnable_candidate_ref: ArtifactReference | null;
  reason: string;
  updated_at: string;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const BOLT_ID = /^BOLT-\d{3}$/;
const SECRET_FIELD = /(?:^|[_-])(secret|password|passwd|token|api[_-]?key|credential|private[_-]?key)(?:$|[_-])/i;

function fail(context: string, message: string): never { throw new Error(`${context}: ${message}`) }
function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(context, "must be an object");
  return value as Record<string, unknown>;
}
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}
function noSecrets(value: unknown, context: string): void {
  if (Array.isArray(value)) return value.forEach((entry, index) => noSecrets(entry, `${context}[${index}]`));
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) fail(context, `secret-bearing field is prohibited: ${key}`);
    noSecrets(child, `${context}.${key}`);
  }
}
function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\r\n\0]/.test(value)) fail(context, "must be a non-empty single-line string");
  return value;
}
function id(value: unknown, context: string, pattern = ID): string {
  const parsed = text(value, context);
  if (!pattern.test(parsed)) fail(context, "must be a stable identifier");
  return parsed;
}
function integer(value: unknown, context: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(context, `must be an integer >= ${minimum}`);
  return value as number;
}
function timestamp(value: unknown, context: string): string {
  const parsed = text(value, context);
  if (!parsed.endsWith("Z") || Number.isNaN(Date.parse(parsed))) fail(context, "must be an ISO-8601 UTC timestamp");
  return parsed;
}
function enumeration<T extends string>(value: unknown, choices: readonly T[], context: string): T {
  const parsed = text(value, context);
  if (!(choices as readonly string[]).includes(parsed)) fail(context, `must be one of: ${choices.join(", ")}`);
  return parsed as T;
}
function strings(value: unknown, context: string, minimum = 0, parser = text): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const parsed = value.map((entry, index) => parser(entry, `${context}[${index}]`));
  if (parsed.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  if (new Set(parsed).size !== parsed.length) fail(context, "contains duplicate values");
  return parsed;
}
function references(value: unknown, context: string): ArtifactReference[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const parsed = value.map((entry, index) => parseArtifactReference(entry, `${context}[${index}]`));
  if (new Set(parsed.map((entry) => JSON.stringify(entry))).size !== parsed.length) fail(context, "contains duplicate references");
  return parsed;
}
function nullableReference(value: unknown, context: string): ArtifactReference | null {
  return value === null ? null : parseArtifactReference(value, context);
}
function nullableText(value: unknown, context: string): string | null { return value === null ? null : text(value, context) }
function absolute(value: unknown, context: string): string {
  const parsed = text(value, context);
  if (!isAbsolute(parsed)) fail(context, "must be an absolute path");
  return parsed;
}
function common(value: Record<string, unknown>, artifact: string, context: string): void {
  if (value.schema_version !== 1) fail(`${context}.schema_version`, "must equal 1");
  if (value.artifact !== artifact) fail(`${context}.artifact`, `must equal ${artifact}`);
  if (value.version !== 1) fail(`${context}.version`, "must equal 1");
  noSecrets(value, context);
}

function parseSourceBinding(value: unknown, context: string): BuildSourceBinding {
  const item = record(value, context);
  rejectUnknown(item, ["source_id", "locator", "relative_path"], context);
  return { source_id: id(item.source_id, `${context}.source_id`), locator: text(item.locator, `${context}.locator`), relative_path: text(item.relative_path, `${context}.relative_path`) };
}

function parseRepository(value: unknown, context: string): BuildRepositoryWorkspace {
  const item = record(value, context);
  rejectUnknown(item, ["repository_id", "repository_root", "base_revision", "working_revision", "integration_branch", "integration_worktree", "sources"], context);
  if (!Array.isArray(item.sources)) fail(`${context}.sources`, "must be an array");
  return {
    repository_id: id(item.repository_id, `${context}.repository_id`),
    repository_root: absolute(item.repository_root, `${context}.repository_root`),
    base_revision: text(item.base_revision, `${context}.base_revision`),
    working_revision: text(item.working_revision, `${context}.working_revision`),
    integration_branch: text(item.integration_branch, `${context}.integration_branch`),
    integration_worktree: absolute(item.integration_worktree, `${context}.integration_worktree`),
    sources: item.sources.map((entry, index) => parseSourceBinding(entry, `${context}.sources[${index}]`)),
  };
}

export function parseBuildSession(value: unknown, context = "Build Session"): BuildSession {
  const item = record(value, context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "session_id", "intent_id", "stage_id", "disposition", "status", "build_contract_current_ref", "build_contract_ref", "effective_policy_ref", "completed_bolt_ids", "current_bolt_id", "repositories", "last_failure_signature", "same_failure_count", "blocked_reason", "started_at", "updated_at"], context);
  common(item, "build-session", context);
  if (item.stage_id !== "ST-06" || item.disposition !== "execute") fail(context, "must describe ST-06 execute");
  if (!Array.isArray(item.repositories) || item.repositories.length === 0) fail(`${context}.repositories`, "must be a non-empty array");
  const currentBolt = nullableText(item.current_bolt_id, `${context}.current_bolt_id`);
  if (currentBolt !== null && !BOLT_ID.test(currentBolt)) fail(`${context}.current_bolt_id`, "must match BOLT-001");
  const failure = nullableText(item.last_failure_signature, `${context}.last_failure_signature`);
  if (failure !== null && !SHA256.test(failure)) fail(`${context}.last_failure_signature`, "must be a SHA-256 digest");
  const blocked = nullableText(item.blocked_reason, `${context}.blocked_reason`);
  const status = enumeration(item.status, BUILD_SESSION_STATUSES, `${context}.status`);
  if (status === "blocked" && blocked === null) fail(`${context}.blocked_reason`, "is required while blocked");
  if (status !== "blocked" && blocked !== null) fail(`${context}.blocked_reason`, "is allowed only while blocked");
  return {
    schema_version: 1, artifact: "build-session", version: 1,
    session_id: id(item.session_id, `${context}.session_id`), intent_id: id(item.intent_id, `${context}.intent_id`),
    stage_id: "ST-06", disposition: "execute", status,
    build_contract_current_ref: parseArtifactReference(item.build_contract_current_ref, `${context}.build_contract_current_ref`),
    build_contract_ref: parseArtifactReference(item.build_contract_ref, `${context}.build_contract_ref`),
    effective_policy_ref: parseArtifactReference(item.effective_policy_ref, `${context}.effective_policy_ref`),
    completed_bolt_ids: strings(item.completed_bolt_ids, `${context}.completed_bolt_ids`, 0, (entry, itemContext) => id(entry, itemContext, BOLT_ID)),
    current_bolt_id: currentBolt, repositories: item.repositories.map((entry, index) => parseRepository(entry, `${context}.repositories[${index}]`)),
    last_failure_signature: failure, same_failure_count: integer(item.same_failure_count, `${context}.same_failure_count`, 0), blocked_reason: blocked,
    started_at: timestamp(item.started_at, `${context}.started_at`), updated_at: timestamp(item.updated_at, `${context}.updated_at`),
  };
}

function parseSourceWorkspace(value: unknown, context: string): BoltSourceWorkspace {
  const item = record(value, context);
  rejectUnknown(item, ["source_id", "locator", "repository_id", "repository_root", "worktree_path", "base_revision"], context);
  return {
    source_id: id(item.source_id, `${context}.source_id`), locator: text(item.locator, `${context}.locator`),
    repository_id: id(item.repository_id, `${context}.repository_id`), repository_root: absolute(item.repository_root, `${context}.repository_root`),
    worktree_path: absolute(item.worktree_path, `${context}.worktree_path`), base_revision: text(item.base_revision, `${context}.base_revision`),
  };
}

export function parseBoltWorkRequest(value: unknown, context = "Bolt Work Request"): BoltWorkRequest {
  const item = record(value, context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "session_id", "intent_id", "stage_id", "build_contract_ref", "bolt", "change_contracts", "acceptance_criteria", "verifiers", "attempt", "source_workspaces", "requested_output", "rules", "created_at"], context);
  common(item, "bolt-work-request", context);
  if (item.stage_id !== "ST-06" || item.requested_output !== "repository-changes") fail(context, "must request ST-06 repository-changes");
  if (!Array.isArray(item.change_contracts) || !Array.isArray(item.acceptance_criteria) || !Array.isArray(item.verifiers) || !Array.isArray(item.source_workspaces)) fail(context, "embedded contract arrays are required");
  return {
    schema_version: 1, artifact: "bolt-work-request", version: 1,
    session_id: id(item.session_id, `${context}.session_id`), intent_id: id(item.intent_id, `${context}.intent_id`), stage_id: "ST-06",
    build_contract_ref: parseArtifactReference(item.build_contract_ref, `${context}.build_contract_ref`),
    bolt: parseBoltDefinition(item.bolt, `${context}.bolt`),
    change_contracts: item.change_contracts.map((entry, index) => parseBuildChangeContract(entry, `${context}.change_contracts[${index}]`)),
    acceptance_criteria: item.acceptance_criteria.map((entry, index) => parseBuildAcceptanceCriterion(entry, `${context}.acceptance_criteria[${index}]`)),
    verifiers: item.verifiers.map((entry, index) => parseBuildVerifier(entry, `${context}.verifiers[${index}]`)),
    attempt: integer(item.attempt, `${context}.attempt`),
    source_workspaces: item.source_workspaces.map((entry, index) => parseSourceWorkspace(entry, `${context}.source_workspaces[${index}]`)),
    requested_output: "repository-changes", rules: strings(item.rules, `${context}.rules`, 1), created_at: timestamp(item.created_at, `${context}.created_at`),
  };
}

function parseChangedFile(value: unknown, context: string): BuildChangedFile {
  const item = record(value, context);
  rejectUnknown(item, ["source_id", "path", "status", "sha256"], context);
  const digest = nullableText(item.sha256, `${context}.sha256`);
  if (digest !== null && !SHA256.test(digest)) fail(`${context}.sha256`, "must be a SHA-256 digest");
  return { source_id: id(item.source_id, `${context}.source_id`), path: text(item.path, `${context}.path`), status: enumeration(item.status, ["added", "modified", "deleted", "renamed"] as const, `${context}.status`), sha256: digest };
}

export function parseVerifierEvidence(value: unknown, context = "Verifier Evidence"): VerifierEvidence {
  const item = record(value, context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "session_id", "bolt_id", "attempt", "scope", "verifier_id", "verifier_kind", "result", "exit_code", "stdout_sha256", "stderr_sha256", "detail", "executed_at"], context);
  common(item, "verifier-evidence", context);
  const boltId = nullableText(item.bolt_id, `${context}.bolt_id`);
  if (boltId !== null && !BOLT_ID.test(boltId)) fail(`${context}.bolt_id`, "must match BOLT-001");
  const sha = (candidate: unknown, field: string) => { const parsed = nullableText(candidate, `${context}.${field}`); if (parsed !== null && !SHA256.test(parsed)) fail(`${context}.${field}`, "must be a SHA-256 digest"); return parsed; };
  const exitCode = item.exit_code === null ? null : integer(item.exit_code, `${context}.exit_code`, 0);
  return {
    schema_version: 1, artifact: "verifier-evidence", version: 1,
    intent_id: id(item.intent_id, `${context}.intent_id`), session_id: id(item.session_id, `${context}.session_id`),
    bolt_id: boltId, attempt: item.attempt === null ? null : integer(item.attempt, `${context}.attempt`),
    scope: enumeration(item.scope, ["bolt", "integration"] as const, `${context}.scope`), verifier_id: id(item.verifier_id, `${context}.verifier_id`),
    verifier_kind: enumeration(item.verifier_kind, ["command", "runtime", "artifact", "human-at-st07"] as const, `${context}.verifier_kind`),
    result: enumeration(item.result, VERIFIER_RESULTS, `${context}.result`), exit_code: exitCode,
    stdout_sha256: sha(item.stdout_sha256, "stdout_sha256"), stderr_sha256: sha(item.stderr_sha256, "stderr_sha256"),
    detail: text(item.detail, `${context}.detail`), executed_at: timestamp(item.executed_at, `${context}.executed_at`),
  };
}

export function parseBuildAttemptCheckpoint(value: unknown, context = "Build Attempt Checkpoint"): BuildAttemptCheckpoint {
  const item = record(value, context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "session_id", "build_contract_ref", "bolt_id", "attempt", "outcome", "changed_files", "verifier_evidence_refs", "failure_signature", "reason", "created_at"], context);
  common(item, "build-attempt-checkpoint", context);
  if (!Array.isArray(item.changed_files)) fail(`${context}.changed_files`, "must be an array");
  const signature = nullableText(item.failure_signature, `${context}.failure_signature`);
  if (signature !== null && !SHA256.test(signature)) fail(`${context}.failure_signature`, "must be a SHA-256 digest");
  const outcome = enumeration(item.outcome, BUILD_ATTEMPT_OUTCOMES, `${context}.outcome`);
  if (outcome === "passed" && signature !== null) fail(`${context}.failure_signature`, "must be null when passed");
  if (outcome !== "passed" && signature === null) fail(`${context}.failure_signature`, "is required when not passed");
  return {
    schema_version: 1, artifact: "build-attempt-checkpoint", version: 1,
    intent_id: id(item.intent_id, `${context}.intent_id`), session_id: id(item.session_id, `${context}.session_id`),
    build_contract_ref: parseArtifactReference(item.build_contract_ref, `${context}.build_contract_ref`), bolt_id: id(item.bolt_id, `${context}.bolt_id`, BOLT_ID),
    attempt: integer(item.attempt, `${context}.attempt`), outcome,
    changed_files: item.changed_files.map((entry, index) => parseChangedFile(entry, `${context}.changed_files[${index}]`)),
    verifier_evidence_refs: references(item.verifier_evidence_refs, `${context}.verifier_evidence_refs`), failure_signature: signature,
    reason: text(item.reason, `${context}.reason`), created_at: timestamp(item.created_at, `${context}.created_at`),
  };
}

function parseSourceResult(value: unknown, context: string): RunnableSourceResult {
  const item = record(value, context);
  rejectUnknown(item, ["repository_id", "source_ids", "source_locator", "base_revision", "candidate_revision", "integration_branch", "changed_files"], context);
  return {
    repository_id: id(item.repository_id, `${context}.repository_id`), source_ids: strings(item.source_ids, `${context}.source_ids`, 1, id),
    source_locator: text(item.source_locator, `${context}.source_locator`), base_revision: text(item.base_revision, `${context}.base_revision`),
    candidate_revision: text(item.candidate_revision, `${context}.candidate_revision`), integration_branch: text(item.integration_branch, `${context}.integration_branch`),
    changed_files: strings(item.changed_files, `${context}.changed_files`, 1),
  };
}

export function parseRunnableCandidate(value: unknown, context = "Runnable Candidate"): RunnableCandidate {
  const item = record(value, context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "session_id", "disposition", "build_contract_ref", "source_results", "bolt_checkpoint_refs", "integration_verifier_evidence_refs", "created_at"], context);
  common(item, "runnable-candidate", context);
  if (item.disposition !== "execute" || !Array.isArray(item.source_results) || item.source_results.length === 0) fail(context, "execute source_results are required");
  return {
    schema_version: 1, artifact: "runnable-candidate", version: 1,
    intent_id: id(item.intent_id, `${context}.intent_id`), session_id: id(item.session_id, `${context}.session_id`), disposition: "execute",
    build_contract_ref: parseArtifactReference(item.build_contract_ref, `${context}.build_contract_ref`),
    source_results: item.source_results.map((entry, index) => parseSourceResult(entry, `${context}.source_results[${index}]`)),
    bolt_checkpoint_refs: references(item.bolt_checkpoint_refs, `${context}.bolt_checkpoint_refs`),
    integration_verifier_evidence_refs: references(item.integration_verifier_evidence_refs, `${context}.integration_verifier_evidence_refs`),
    created_at: timestamp(item.created_at, `${context}.created_at`),
  };
}

export function parseBuildCurrent(value: unknown, context = "Build Current"): BuildCurrent {
  const item = record(value, context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "disposition", "build_contract_current_ref", "runnable_candidate_ref", "reason", "updated_at"], context);
  common(item, "build-current", context);
  const disposition = enumeration(item.disposition, ["execute", "reuse", "not_applicable"] as const, `${context}.disposition`);
  const candidate = nullableReference(item.runnable_candidate_ref, `${context}.runnable_candidate_ref`);
  if (disposition === "not_applicable" && candidate !== null) fail(`${context}.runnable_candidate_ref`, "must be null for not_applicable");
  if (disposition !== "not_applicable" && candidate === null) fail(`${context}.runnable_candidate_ref`, `is required for ${disposition}`);
  return {
    schema_version: 1, artifact: "build-current", version: 1,
    intent_id: id(item.intent_id, `${context}.intent_id`), disposition,
    build_contract_current_ref: parseArtifactReference(item.build_contract_current_ref, `${context}.build_contract_current_ref`),
    runnable_candidate_ref: candidate, reason: text(item.reason, `${context}.reason`), updated_at: timestamp(item.updated_at, `${context}.updated_at`),
  };
}
