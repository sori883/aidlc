import { isAbsolute } from "node:path";
import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";
import {
  parsePolicyAcknowledgement,
  type PolicyAcknowledgement,
} from "./aidlc-vnext-policy-gates.ts";

export const RELEASE_SCHEMA_VERSION = 1 as const;
export const RELEASE_ARTIFACT_VERSION = 1 as const;
export const RELEASE_TARGET_KINDS = ["source", "artifact", "environment"] as const;
export const RELEASE_OPERATIONS = ["source-promote", "pipeline-trigger", "artifact-publish", "environment-deploy", "post-release-verify"] as const;
export const RELEASE_ROLLBACK_MODES = ["automatic", "human-authorized", "forward-fix"] as const;
export type ReleaseTargetKind = (typeof RELEASE_TARGET_KINDS)[number];
export type ReleaseOperation = (typeof RELEASE_OPERATIONS)[number];
export type ReleaseRollbackMode = (typeof RELEASE_ROLLBACK_MODES)[number];

export interface ReleaseCapability {
  capability_id: string;
  provider: string;
  operation: ReleaseOperation;
  target_kind: ReleaseTargetKind;
  adapter_id: string;
  credential_slots: string[];
  supports_rollback: boolean;
}

export interface ReleaseCapabilitySnapshot {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-capability-snapshot";
  version: typeof RELEASE_ARTIFACT_VERSION;
  intent_id: string;
  effective_policy_ref: ArtifactReference;
  capabilities: ReleaseCapability[];
  created_at: string;
}

export interface ReleaseSourceTarget {
  repository_id: string;
  source_ids: string[];
  source_locators: string[];
  repository_root: string;
  base_revision: string;
  candidate_revision: string;
  integration_branch: string;
  current_branch_ref: string;
  available_remotes: string[];
}

export interface ReleaseWorkRequest {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-work-request";
  version: typeof RELEASE_ARTIFACT_VERSION;
  intent_id: string;
  stage_id: "ST-08";
  review_current_ref: ArtifactReference;
  accepted_candidate_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  capability_snapshot_ref: ArtifactReference;
  deployment_map_baseline_ref: ArtifactReference | null;
  source_targets: ReleaseSourceTarget[];
  requested_output: "release-plan-proposal";
  rules: string[];
  created_at: string;
}

export interface ProposedReleaseTarget {
  target_id: string;
  target_kind: ReleaseTargetKind;
  provider: string;
  capability_id: string;
  repository_id: string | null;
  locator: string;
  environment: string | null;
}

export interface ReleaseTarget extends ProposedReleaseTarget {
  observed_before: string;
  observed_at: string;
}

export interface ReleaseStep {
  step_id: string;
  target_id: string;
  operation: ReleaseOperation;
  capability_id: string;
  depends_on: string[];
  desired_state: string;
  post_release_check: "target-matches-desired";
  rollback_mode: ReleaseRollbackMode;
}

export interface ReleasePlanProposal {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-plan-proposal";
  version: typeof RELEASE_ARTIFACT_VERSION;
  proposal_id: string;
  intent_id: string;
  work_request_sha256: string;
  disposition: "execute";
  targets: ProposedReleaseTarget[];
  steps: ReleaseStep[];
  release_notes: string[];
  reason: string;
  proposed_by: "ai";
}

export interface ReleasePlan {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-plan";
  version: typeof RELEASE_ARTIFACT_VERSION;
  revision: number;
  intent_id: string;
  stage_id: "ST-08";
  disposition: "execute";
  work_request_ref: ArtifactReference;
  review_current_ref: ArtifactReference;
  accepted_candidate_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  capability_snapshot_ref: ArtifactReference;
  targets: ReleaseTarget[];
  steps: ReleaseStep[];
  release_notes: string[];
  reason: string;
  created_at: string;
}

export interface ReleaseAuthority {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-authority";
  version: typeof RELEASE_ARTIFACT_VERSION;
  authority_id: string;
  intent_id: string;
  release_plan_ref: ArtifactReference;
  accepted_candidate_ref: ArtifactReference;
  gate_requirement_set_ref: ArtifactReference;
  policy_acknowledgements: PolicyAcknowledgement[];
  decision: "authorize-release";
  reason: string;
  decided_by: "human";
  decided_at: string;
}

export interface ReleaseStepReceipt {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-step-receipt";
  version: typeof RELEASE_ARTIFACT_VERSION;
  intent_id: string;
  attempt: number;
  step_id: string;
  target_id: string;
  capability_id: string;
  idempotency_key: string;
  outcome: "succeeded" | "recovered" | "failed" | "rolled_back" | "rollback_failed";
  before_state: string;
  after_state: string;
  external_operation_id: string | null;
  detail: string;
  executed_at: string;
}

export interface ReleaseAttempt {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-attempt";
  version: typeof RELEASE_ARTIFACT_VERSION;
  intent_id: string;
  attempt: number;
  status: "active" | "succeeded" | "rolled_back" | "blocked";
  release_plan_ref: ArtifactReference;
  authority_ref: ArtifactReference;
  step_receipt_refs: ArtifactReference[];
  failure: string | null;
  started_at: string;
  updated_at: string;
}

export interface ReleaseReceipt {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-receipt";
  version: typeof RELEASE_ARTIFACT_VERSION;
  intent_id: string;
  attempt: number;
  outcome: "released" | "rolled_back";
  release_plan_ref: ArtifactReference;
  authority_ref: ArtifactReference;
  accepted_candidate_ref: ArtifactReference;
  step_receipt_refs: ArtifactReference[];
  target_states: Array<{ target_id: string; observed_state: string }>;
  completed_at: string;
}

export interface DeploymentMapTarget {
  target_id: string;
  target_kind: ReleaseTargetKind;
  provider: string;
  locator: string;
  environment: string | null;
  observed_state: string;
  observed_at: string;
  release_receipt_ref: ArtifactReference;
}

export interface DeploymentMap {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "deployment-map";
  version: typeof RELEASE_ARTIFACT_VERSION;
  map_id: "default-deployment";
  revision: number;
  base_revision: number | null;
  targets: DeploymentMapTarget[];
  updated_at: string;
}

export interface DeploymentMapBaseline {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "deployment-map-baseline";
  version: typeof RELEASE_ARTIFACT_VERSION;
  map_id: "default-deployment";
  revision: number;
  source_of_truth: string;
  sha256: string;
  updated_at: string;
}

export interface ReleaseCurrent {
  schema_version: typeof RELEASE_SCHEMA_VERSION;
  artifact: "release-current";
  version: typeof RELEASE_ARTIFACT_VERSION;
  intent_id: string;
  disposition: "execute" | "reuse" | "not_applicable";
  outcome: "released" | "rolled_back" | "not_applicable";
  review_current_ref: ArtifactReference;
  accepted_candidate_ref: ArtifactReference | null;
  release_plan_ref: ArtifactReference | null;
  release_authority_ref: ArtifactReference | null;
  release_receipt_ref: ArtifactReference | null;
  deployment_map_ref: ArtifactReference | null;
  reason: string;
  updated_at: string;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const TARGET_ID = /^TARGET-\d{3}$/;
const STEP_ID = /^STEP-\d{3}$/;
const GIT_REVISION = /^[a-f0-9]{40,64}$/;
const SECRET = /(?:^|[_-])(secret|password|passwd|token|api[_-]?key|credential|private[_-]?key)(?:$|[_-])/i;

function fail(context: string, message: string): never { throw new Error(`${context}: ${message}`); }
function object(value: unknown, context: string): Record<string, unknown> {
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
    // `credential_slots` contains registered slot names only; credential values
    // remain prohibited everywhere in Release artifacts.
    if (key !== "credential_slots" && SECRET.test(key)) fail(context, `secret-bearing field is prohibited: ${key}`);
    noSecrets(child, `${context}.${key}`);
  }
}
function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\r\n\0]/.test(value)) fail(context, "must be a non-empty single-line string");
  return value;
}
function nullableText(value: unknown, context: string): string | null { return value === null ? null : text(value, context); }
function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(context, "must be a positive integer");
  return value as number;
}
function iso(value: unknown, context: string): string {
  const result = text(value, context);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) fail(context, "must be an ISO-8601 UTC timestamp");
  return result;
}
function allowed<T extends string>(value: unknown, choices: readonly T[], context: string): T {
  const result = text(value, context);
  if (!(choices as readonly string[]).includes(result)) fail(context, `must be one of: ${choices.join(", ")}`);
  return result as T;
}
function id(value: unknown, context: string, pattern = ID): string {
  const result = text(value, context);
  if (!pattern.test(result)) fail(context, "has an invalid identifier");
  return result;
}
function revision(value: unknown, context: string): string {
  const result = text(value, context);
  if (!GIT_REVISION.test(result)) fail(context, "must be a 40-64 character lowercase Git revision");
  return result;
}
function sha(value: unknown, context: string): string {
  const result = text(value, context);
  if (!SHA256.test(result)) fail(context, "must be sha256:<64 lowercase hex characters>");
  return result;
}
function textArray(value: unknown, context: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) fail(context, `must be ${allowEmpty ? "an" : "a non-empty"} array`);
  const result = value.map((entry, index) => text(entry, `${context}[${index}]`));
  if (new Set(result).size !== result.length) fail(context, "must not contain duplicates");
  return result;
}
function relativePath(value: unknown, context: string): string {
  const result = text(value, context);
  if (isAbsolute(result) || result === ".." || result.split(/[\\/]/).includes("..")) fail(context, "must be a safe project-relative path");
  return result;
}
function common(value: Record<string, unknown>, artifact: string, context: string): void {
  if (value.schema_version !== 1 || value.artifact !== artifact || value.version !== 1) fail(context, `must be ${artifact} schema/version 1`);
  noSecrets(value, context);
}

function parseCapability(value: unknown, context: string): ReleaseCapability {
  const item = object(value, context);
  rejectUnknown(item, ["capability_id", "provider", "operation", "target_kind", "adapter_id", "credential_slots", "supports_rollback"], context);
  if (typeof item.supports_rollback !== "boolean") fail(`${context}.supports_rollback`, "must be boolean");
  return { capability_id: id(item.capability_id, `${context}.capability_id`), provider: id(item.provider, `${context}.provider`), operation: allowed(item.operation, RELEASE_OPERATIONS, `${context}.operation`), target_kind: allowed(item.target_kind, RELEASE_TARGET_KINDS, `${context}.target_kind`), adapter_id: id(item.adapter_id, `${context}.adapter_id`), credential_slots: textArray(item.credential_slots, `${context}.credential_slots`, true), supports_rollback: item.supports_rollback };
}

export function parseReleaseCapabilitySnapshot(value: unknown, context = "Release Capability Snapshot"): ReleaseCapabilitySnapshot {
  const item = object(value, context); common(item, "release-capability-snapshot", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "effective_policy_ref", "capabilities", "created_at"], context);
  if (!Array.isArray(item.capabilities) || item.capabilities.length === 0) fail(`${context}.capabilities`, "must be a non-empty array");
  const capabilities = item.capabilities.map((entry, index) => parseCapability(entry, `${context}.capabilities[${index}]`));
  if (new Set(capabilities.map((entry) => entry.capability_id)).size !== capabilities.length) fail(`${context}.capabilities`, "capability IDs must be unique");
  return { schema_version: 1, artifact: "release-capability-snapshot", version: 1, intent_id: id(item.intent_id, `${context}.intent_id`), effective_policy_ref: parseArtifactReference(item.effective_policy_ref, `${context}.effective_policy_ref`), capabilities, created_at: iso(item.created_at, `${context}.created_at`) };
}

function parseSourceTarget(value: unknown, context: string): ReleaseSourceTarget {
  const item = object(value, context);
  rejectUnknown(item, ["repository_id", "source_ids", "source_locators", "repository_root", "base_revision", "candidate_revision", "integration_branch", "current_branch_ref", "available_remotes"], context);
  const currentBranch = text(item.current_branch_ref, `${context}.current_branch_ref`);
  if (!currentBranch.startsWith("refs/heads/")) fail(`${context}.current_branch_ref`, "must be a refs/heads/* reference");
  return { repository_id: id(item.repository_id, `${context}.repository_id`), source_ids: textArray(item.source_ids, `${context}.source_ids`), source_locators: textArray(item.source_locators, `${context}.source_locators`), repository_root: relativePath(item.repository_root, `${context}.repository_root`), base_revision: revision(item.base_revision, `${context}.base_revision`), candidate_revision: revision(item.candidate_revision, `${context}.candidate_revision`), integration_branch: text(item.integration_branch, `${context}.integration_branch`), current_branch_ref: currentBranch, available_remotes: textArray(item.available_remotes, `${context}.available_remotes`, true).map((entry, index) => id(entry, `${context}.available_remotes[${index}]`)) };
}

export function parseReleaseWorkRequest(value: unknown, context = "Release Work Request"): ReleaseWorkRequest {
  const item = object(value, context); common(item, "release-work-request", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "stage_id", "review_current_ref", "accepted_candidate_ref", "effective_policy_ref", "system_map_ref", "capability_snapshot_ref", "deployment_map_baseline_ref", "source_targets", "requested_output", "rules", "created_at"], context);
  if (item.stage_id !== "ST-08" || item.requested_output !== "release-plan-proposal") fail(context, "must request ST-08 release-plan-proposal");
  if (!Array.isArray(item.source_targets) || item.source_targets.length === 0) fail(`${context}.source_targets`, "must be a non-empty array");
  const sourceTargets = item.source_targets.map((entry, index) => parseSourceTarget(entry, `${context}.source_targets[${index}]`));
  if (new Set(sourceTargets.map((entry) => entry.repository_id)).size !== sourceTargets.length) fail(`${context}.source_targets`, "repository IDs must be unique");
  return { schema_version: 1, artifact: "release-work-request", version: 1, intent_id: id(item.intent_id, `${context}.intent_id`), stage_id: "ST-08", review_current_ref: parseArtifactReference(item.review_current_ref, `${context}.review_current_ref`), accepted_candidate_ref: parseArtifactReference(item.accepted_candidate_ref, `${context}.accepted_candidate_ref`), effective_policy_ref: parseArtifactReference(item.effective_policy_ref, `${context}.effective_policy_ref`), system_map_ref: parseArtifactReference(item.system_map_ref, `${context}.system_map_ref`), capability_snapshot_ref: parseArtifactReference(item.capability_snapshot_ref, `${context}.capability_snapshot_ref`), deployment_map_baseline_ref: item.deployment_map_baseline_ref === null ? null : parseArtifactReference(item.deployment_map_baseline_ref, `${context}.deployment_map_baseline_ref`), source_targets: sourceTargets, requested_output: "release-plan-proposal", rules: textArray(item.rules, `${context}.rules`), created_at: iso(item.created_at, `${context}.created_at`) };
}

function parseProposedTarget(value: unknown, context: string): ProposedReleaseTarget {
  const item = object(value, context);
  rejectUnknown(item, ["target_id", "target_kind", "provider", "capability_id", "repository_id", "locator", "environment"], context);
  return { target_id: id(item.target_id, `${context}.target_id`, TARGET_ID), target_kind: allowed(item.target_kind, RELEASE_TARGET_KINDS, `${context}.target_kind`), provider: id(item.provider, `${context}.provider`), capability_id: id(item.capability_id, `${context}.capability_id`), repository_id: nullableText(item.repository_id, `${context}.repository_id`), locator: text(item.locator, `${context}.locator`), environment: nullableText(item.environment, `${context}.environment`) };
}
function parseTarget(value: unknown, context: string): ReleaseTarget {
  const item = object(value, context);
  rejectUnknown(item, ["target_id", "target_kind", "provider", "capability_id", "repository_id", "locator", "environment", "observed_before", "observed_at"], context);
  const base = parseProposedTarget(Object.fromEntries(Object.entries(item).filter(([key]) => key !== "observed_before" && key !== "observed_at")), context);
  return { ...base, observed_before: revision(item.observed_before, `${context}.observed_before`), observed_at: iso(item.observed_at, `${context}.observed_at`) };
}
function parseStep(value: unknown, context: string): ReleaseStep {
  const item = object(value, context);
  rejectUnknown(item, ["step_id", "target_id", "operation", "capability_id", "depends_on", "desired_state", "post_release_check", "rollback_mode"], context);
  if (item.post_release_check !== "target-matches-desired") fail(`${context}.post_release_check`, "must equal target-matches-desired");
  return { step_id: id(item.step_id, `${context}.step_id`, STEP_ID), target_id: id(item.target_id, `${context}.target_id`, TARGET_ID), operation: allowed(item.operation, RELEASE_OPERATIONS, `${context}.operation`), capability_id: id(item.capability_id, `${context}.capability_id`), depends_on: textArray(item.depends_on, `${context}.depends_on`, true).map((entry, index) => id(entry, `${context}.depends_on[${index}]`, STEP_ID)), desired_state: revision(item.desired_state, `${context}.desired_state`), post_release_check: "target-matches-desired", rollback_mode: allowed(item.rollback_mode, RELEASE_ROLLBACK_MODES, `${context}.rollback_mode`) };
}
function validatePlanGraph(targets: readonly ProposedReleaseTarget[], steps: readonly ReleaseStep[], context: string): void {
  if (new Set(targets.map((entry) => entry.target_id)).size !== targets.length) fail(`${context}.targets`, "target IDs must be unique");
  if (new Set(steps.map((entry) => entry.step_id)).size !== steps.length) fail(`${context}.steps`, "step IDs must be unique");
  const targetIds = new Set(targets.map((entry) => entry.target_id));
  const stepIds = new Set(steps.map((entry) => entry.step_id));
  for (const step of steps) {
    if (!targetIds.has(step.target_id)) fail(`${context}.steps`, `${step.step_id} references an unknown target`);
    if (step.depends_on.includes(step.step_id) || step.depends_on.some((entry) => !stepIds.has(entry))) fail(`${context}.steps`, `${step.step_id} has an invalid dependency`);
  }
  const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(steps.map((entry) => [entry.step_id, entry]));
  const visit = (stepId: string): void => { if (visiting.has(stepId)) fail(`${context}.steps`, "dependency cycle detected"); if (visited.has(stepId)) return; visiting.add(stepId); for (const dependency of byId.get(stepId)!.depends_on) visit(dependency); visiting.delete(stepId); visited.add(stepId); };
  for (const step of steps) visit(step.step_id);
}

export function parseReleasePlanProposal(value: unknown, context = "Release Plan Proposal"): ReleasePlanProposal {
  const item = object(value, context); common(item, "release-plan-proposal", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "proposal_id", "intent_id", "work_request_sha256", "disposition", "targets", "steps", "release_notes", "reason", "proposed_by"], context);
  if (item.disposition !== "execute" || item.proposed_by !== "ai") fail(context, "must be an AI execute proposal");
  if (!Array.isArray(item.targets) || item.targets.length === 0 || !Array.isArray(item.steps) || item.steps.length === 0) fail(context, "targets and steps must be non-empty arrays");
  const targets = item.targets.map((entry, index) => parseProposedTarget(entry, `${context}.targets[${index}]`));
  const steps = item.steps.map((entry, index) => parseStep(entry, `${context}.steps[${index}]`));
  validatePlanGraph(targets, steps, context);
  return { schema_version: 1, artifact: "release-plan-proposal", version: 1, proposal_id: id(item.proposal_id, `${context}.proposal_id`), intent_id: id(item.intent_id, `${context}.intent_id`), work_request_sha256: sha(item.work_request_sha256, `${context}.work_request_sha256`), disposition: "execute", targets, steps, release_notes: textArray(item.release_notes, `${context}.release_notes`), reason: text(item.reason, `${context}.reason`), proposed_by: "ai" };
}

export function parseReleasePlan(value: unknown, context = "Release Plan"): ReleasePlan {
  const item = object(value, context); common(item, "release-plan", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "revision", "intent_id", "stage_id", "disposition", "work_request_ref", "review_current_ref", "accepted_candidate_ref", "effective_policy_ref", "capability_snapshot_ref", "targets", "steps", "release_notes", "reason", "created_at"], context);
  if (item.stage_id !== "ST-08" || item.disposition !== "execute") fail(context, "must be an ST-08 execute Plan");
  if (!Array.isArray(item.targets) || item.targets.length === 0 || !Array.isArray(item.steps) || item.steps.length === 0) fail(context, "targets and steps must be non-empty arrays");
  const targets = item.targets.map((entry, index) => parseTarget(entry, `${context}.targets[${index}]`));
  const steps = item.steps.map((entry, index) => parseStep(entry, `${context}.steps[${index}]`));
  validatePlanGraph(targets, steps, context);
  return { schema_version: 1, artifact: "release-plan", version: 1, revision: integer(item.revision, `${context}.revision`), intent_id: id(item.intent_id, `${context}.intent_id`), stage_id: "ST-08", disposition: "execute", work_request_ref: parseArtifactReference(item.work_request_ref, `${context}.work_request_ref`), review_current_ref: parseArtifactReference(item.review_current_ref, `${context}.review_current_ref`), accepted_candidate_ref: parseArtifactReference(item.accepted_candidate_ref, `${context}.accepted_candidate_ref`), effective_policy_ref: parseArtifactReference(item.effective_policy_ref, `${context}.effective_policy_ref`), capability_snapshot_ref: parseArtifactReference(item.capability_snapshot_ref, `${context}.capability_snapshot_ref`), targets, steps, release_notes: textArray(item.release_notes, `${context}.release_notes`), reason: text(item.reason, `${context}.reason`), created_at: iso(item.created_at, `${context}.created_at`) };
}

export function parseReleaseAuthority(value: unknown, context = "Release Authority"): ReleaseAuthority {
  const item = object(value, context); common(item, "release-authority", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "authority_id", "intent_id", "release_plan_ref", "accepted_candidate_ref", "gate_requirement_set_ref", "policy_acknowledgements", "decision", "reason", "decided_by", "decided_at"], context);
  if (item.decision !== "authorize-release" || item.decided_by !== "human") fail(context, "Release authority must be an actual human authorize-release decision");
  if (!Array.isArray(item.policy_acknowledgements)) fail(`${context}.policy_acknowledgements`, "must be an array");
  return { schema_version: 1, artifact: "release-authority", version: 1, authority_id: id(item.authority_id, `${context}.authority_id`), intent_id: id(item.intent_id, `${context}.intent_id`), release_plan_ref: parseArtifactReference(item.release_plan_ref, `${context}.release_plan_ref`), accepted_candidate_ref: parseArtifactReference(item.accepted_candidate_ref, `${context}.accepted_candidate_ref`), gate_requirement_set_ref: parseArtifactReference(item.gate_requirement_set_ref, `${context}.gate_requirement_set_ref`), policy_acknowledgements: item.policy_acknowledgements.map((entry, index) => parsePolicyAcknowledgement(entry, `${context}.policy_acknowledgements[${index}]`)), decision: "authorize-release", reason: text(item.reason, `${context}.reason`), decided_by: "human", decided_at: iso(item.decided_at, `${context}.decided_at`) };
}

export function parseReleaseStepReceipt(value: unknown, context = "Release Step Receipt"): ReleaseStepReceipt {
  const item = object(value, context); common(item, "release-step-receipt", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "attempt", "step_id", "target_id", "capability_id", "idempotency_key", "outcome", "before_state", "after_state", "external_operation_id", "detail", "executed_at"], context);
  return { schema_version: 1, artifact: "release-step-receipt", version: 1, intent_id: id(item.intent_id, `${context}.intent_id`), attempt: integer(item.attempt, `${context}.attempt`), step_id: id(item.step_id, `${context}.step_id`, STEP_ID), target_id: id(item.target_id, `${context}.target_id`, TARGET_ID), capability_id: id(item.capability_id, `${context}.capability_id`), idempotency_key: sha(item.idempotency_key, `${context}.idempotency_key`), outcome: allowed(item.outcome, ["succeeded", "recovered", "failed", "rolled_back", "rollback_failed"] as const, `${context}.outcome`), before_state: revision(item.before_state, `${context}.before_state`), after_state: revision(item.after_state, `${context}.after_state`), external_operation_id: nullableText(item.external_operation_id, `${context}.external_operation_id`), detail: text(item.detail, `${context}.detail`), executed_at: iso(item.executed_at, `${context}.executed_at`) };
}

export function parseReleaseAttempt(value: unknown, context = "Release Attempt"): ReleaseAttempt {
  const item = object(value, context); common(item, "release-attempt", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "attempt", "status", "release_plan_ref", "authority_ref", "step_receipt_refs", "failure", "started_at", "updated_at"], context);
  if (!Array.isArray(item.step_receipt_refs)) fail(`${context}.step_receipt_refs`, "must be an array");
  return { schema_version: 1, artifact: "release-attempt", version: 1, intent_id: id(item.intent_id, `${context}.intent_id`), attempt: integer(item.attempt, `${context}.attempt`), status: allowed(item.status, ["active", "succeeded", "rolled_back", "blocked"] as const, `${context}.status`), release_plan_ref: parseArtifactReference(item.release_plan_ref, `${context}.release_plan_ref`), authority_ref: parseArtifactReference(item.authority_ref, `${context}.authority_ref`), step_receipt_refs: item.step_receipt_refs.map((entry, index) => parseArtifactReference(entry, `${context}.step_receipt_refs[${index}]`)), failure: nullableText(item.failure, `${context}.failure`), started_at: iso(item.started_at, `${context}.started_at`), updated_at: iso(item.updated_at, `${context}.updated_at`) };
}

export function parseReleaseReceipt(value: unknown, context = "Release Receipt"): ReleaseReceipt {
  const item = object(value, context); common(item, "release-receipt", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "attempt", "outcome", "release_plan_ref", "authority_ref", "accepted_candidate_ref", "step_receipt_refs", "target_states", "completed_at"], context);
  if (!Array.isArray(item.step_receipt_refs) || item.step_receipt_refs.length === 0 || !Array.isArray(item.target_states) || item.target_states.length === 0) fail(context, "step receipts and target states must be non-empty arrays");
  const targetStates = item.target_states.map((entry, index) => { const state = object(entry, `${context}.target_states[${index}]`); rejectUnknown(state, ["target_id", "observed_state"], `${context}.target_states[${index}]`); return { target_id: id(state.target_id, `${context}.target_states[${index}].target_id`, TARGET_ID), observed_state: revision(state.observed_state, `${context}.target_states[${index}].observed_state`) }; });
  if (new Set(targetStates.map((entry) => entry.target_id)).size !== targetStates.length) fail(`${context}.target_states`, "target IDs must be unique");
  return { schema_version: 1, artifact: "release-receipt", version: 1, intent_id: id(item.intent_id, `${context}.intent_id`), attempt: integer(item.attempt, `${context}.attempt`), outcome: allowed(item.outcome, ["released", "rolled_back"] as const, `${context}.outcome`), release_plan_ref: parseArtifactReference(item.release_plan_ref, `${context}.release_plan_ref`), authority_ref: parseArtifactReference(item.authority_ref, `${context}.authority_ref`), accepted_candidate_ref: parseArtifactReference(item.accepted_candidate_ref, `${context}.accepted_candidate_ref`), step_receipt_refs: item.step_receipt_refs.map((entry, index) => parseArtifactReference(entry, `${context}.step_receipt_refs[${index}]`)), target_states: targetStates, completed_at: iso(item.completed_at, `${context}.completed_at`) };
}

function parseDeploymentTarget(value: unknown, context: string): DeploymentMapTarget {
  const item = object(value, context);
  rejectUnknown(item, ["target_id", "target_kind", "provider", "locator", "environment", "observed_state", "observed_at", "release_receipt_ref"], context);
  return { target_id: id(item.target_id, `${context}.target_id`), target_kind: allowed(item.target_kind, RELEASE_TARGET_KINDS, `${context}.target_kind`), provider: id(item.provider, `${context}.provider`), locator: text(item.locator, `${context}.locator`), environment: nullableText(item.environment, `${context}.environment`), observed_state: revision(item.observed_state, `${context}.observed_state`), observed_at: iso(item.observed_at, `${context}.observed_at`), release_receipt_ref: parseArtifactReference(item.release_receipt_ref, `${context}.release_receipt_ref`) };
}
export function parseDeploymentMap(value: unknown, context = "Deployment Map"): DeploymentMap {
  const item = object(value, context); common(item, "deployment-map", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "map_id", "revision", "base_revision", "targets", "updated_at"], context);
  if (item.map_id !== "default-deployment" || (item.base_revision !== null && (!Number.isSafeInteger(item.base_revision) || (item.base_revision as number) < 1))) fail(context, "invalid map_id or base_revision");
  if (!Array.isArray(item.targets)) fail(`${context}.targets`, "must be an array");
  const targets = item.targets.map((entry, index) => parseDeploymentTarget(entry, `${context}.targets[${index}]`));
  if (new Set(targets.map((entry) => entry.target_id)).size !== targets.length) fail(`${context}.targets`, "target IDs must be unique");
  return { schema_version: 1, artifact: "deployment-map", version: 1, map_id: "default-deployment", revision: integer(item.revision, `${context}.revision`), base_revision: item.base_revision as number | null, targets, updated_at: iso(item.updated_at, `${context}.updated_at`) };
}
export function parseDeploymentMapBaseline(value: unknown, context = "Deployment Map Baseline"): DeploymentMapBaseline {
  const item = object(value, context); common(item, "deployment-map-baseline", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "map_id", "revision", "source_of_truth", "sha256", "updated_at"], context);
  if (item.map_id !== "default-deployment") fail(`${context}.map_id`, "must equal default-deployment");
  return { schema_version: 1, artifact: "deployment-map-baseline", version: 1, map_id: "default-deployment", revision: integer(item.revision, `${context}.revision`), source_of_truth: relativePath(item.source_of_truth, `${context}.source_of_truth`), sha256: sha(item.sha256, `${context}.sha256`), updated_at: iso(item.updated_at, `${context}.updated_at`) };
}

export function parseReleaseCurrent(value: unknown, context = "Release Current"): ReleaseCurrent {
  const item = object(value, context); common(item, "release-current", context);
  rejectUnknown(item, ["schema_version", "artifact", "version", "intent_id", "disposition", "outcome", "review_current_ref", "accepted_candidate_ref", "release_plan_ref", "release_authority_ref", "release_receipt_ref", "deployment_map_ref", "reason", "updated_at"], context);
  const disposition = allowed(item.disposition, ["execute", "reuse", "not_applicable"] as const, `${context}.disposition`);
  const outcome = allowed(item.outcome, ["released", "rolled_back", "not_applicable"] as const, `${context}.outcome`);
  const accepted = item.accepted_candidate_ref === null ? null : parseArtifactReference(item.accepted_candidate_ref, `${context}.accepted_candidate_ref`);
  const plan = item.release_plan_ref === null ? null : parseArtifactReference(item.release_plan_ref, `${context}.release_plan_ref`);
  const authority = item.release_authority_ref === null ? null : parseArtifactReference(item.release_authority_ref, `${context}.release_authority_ref`);
  const receipt = item.release_receipt_ref === null ? null : parseArtifactReference(item.release_receipt_ref, `${context}.release_receipt_ref`);
  const deployment = item.deployment_map_ref === null ? null : parseArtifactReference(item.deployment_map_ref, `${context}.deployment_map_ref`);
  if (outcome === "not_applicable" ? disposition !== "not_applicable" || accepted !== null || plan !== null || authority !== null || receipt !== null || deployment !== null : disposition === "not_applicable" || accepted === null || plan === null || authority === null || receipt === null || deployment === null) fail(context, "disposition, outcome, and references are inconsistent");
  return { schema_version: 1, artifact: "release-current", version: 1, intent_id: id(item.intent_id, `${context}.intent_id`), disposition, outcome, review_current_ref: parseArtifactReference(item.review_current_ref, `${context}.review_current_ref`), accepted_candidate_ref: accepted, release_plan_ref: plan, release_authority_ref: authority, release_receipt_ref: receipt, deployment_map_ref: deployment, reason: text(item.reason, `${context}.reason`), updated_at: iso(item.updated_at, `${context}.updated_at`) };
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
export function renderReleaseReviewHtml(plan: ReleasePlan, gateSection = ""): string {
  const value = parseReleasePlan(plan);
  const targets = value.targets.map((target) => `<article><b>${escapeHtml(target.target_id)}</b><h3>${escapeHtml(target.target_kind)} / ${escapeHtml(target.provider)}</h3><p>${escapeHtml(target.locator)}</p><small>現在: ${escapeHtml(target.observed_before)}</small></article>`).join("");
  const steps = value.steps.map((step) => `<tr><td>${escapeHtml(step.step_id)}</td><td>${escapeHtml(step.operation)}</td><td>${escapeHtml(step.target_id)}</td><td>${escapeHtml(step.desired_state)}</td><td>${escapeHtml(step.rollback_mode)}</td></tr>`).join("");
  const notes = value.release_notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  return `<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ST-08 Release確認</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.65}main{width:min(980px,calc(100% - 28px));margin:auto;padding:32px 0}header,section{margin-bottom:18px;padding:26px;border:1px solid #dce4ef;border-radius:20px;background:#fff}h1,h2,h3,p{margin-top:0}.lead,small{color:#607086}.targets{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.targets article{padding:16px;border-radius:14px;background:#eaf1ff}.targets b{color:#2563eb}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #dce4ef;text-align:left;vertical-align:top}th{background:#f4f7fb}.warning{border-left:5px solid #a25c00;background:#fff4d8}code{overflow-wrap:anywhere}@media(max-width:650px){header,section{padding:19px}table{font-size:12px}}</style></head><body><main><header><small>AI-DLC vNext / ST-08 / RELEASE AUTHORITY</small><h1>Release前の最終確認</h1><p class="lead">承認すると、次のTargetへ外部操作を行います。CandidateやTargetが変わった場合、この承認は使えません。</p><code>Release Plan revision ${value.revision}</code></header><section><h2>Release先</h2><div class="targets">${targets}</div></section><section><h2>実行順</h2><table><thead><tr><th>Step</th><th>操作</th><th>Target</th><th>到達状態</th><th>失敗時</th></tr></thead><tbody>${steps}</tbody></table></section><section><h2>Release notes</h2><ul>${notes}</ul></section>${gateSection}<section class="warning"><h2>人間が確認すること</h2><p>Target、現在revision、到達revision、rollback方式が正しい場合だけ、このRelease PlanのSHA-256を承認してください。</p></section></main></body></html>\n`;
}
