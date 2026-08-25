#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendAuditEntries, appendAuditEntry, readOrderedAuditEntries } from "./aidlc-audit.ts";
import { reviseStageExecutionPlan } from "./aidlc-core-route.ts";
import { verifyProjectArtifactReference } from "./aidlc-effective-policy.ts";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";
import {
  parseArtifactReference,
  parseVNextStageContract,
  type ArtifactReference,
  type StageDispositionProposal,
  type StageExecutionPlan,
  type VNextStageContract,
} from "./aidlc-stage-contract.ts";
import { intentDefinitionPath } from "./aidlc-vnext-define-intent.ts";
import { parseIntentDefinition, type IntentDefinition } from "./aidlc-vnext-define-intent-contract.ts";
import { requirementsCurrentPath } from "./aidlc-vnext-requirements.ts";
import { parseRequirementsCurrent, parseRequirementsDefinition, type RequirementsDefinition } from "./aidlc-vnext-requirements-contract.ts";
import { parseReviewCurrent, parseReviewManifest, type ReviewManifest } from "./aidlc-vnext-review-contract.ts";
import { reviewCurrentPath } from "./aidlc-vnext-review.ts";
import { releaseCurrentPath } from "./aidlc-vnext-release.ts";
import { parseReleaseCurrent, type ReleaseCurrent } from "./aidlc-vnext-release-contract.ts";
import {
  humanGateRequirementReferenceAt,
  parseHumanGateRequirementSet,
  renderHumanGateRequirementSection,
  resolveHumanGateRequirementsAt,
  validatePolicyAcknowledgements,
  type PolicyAcknowledgement,
} from "./aidlc-vnext-policy-gates.ts";
import {
  calculateOutcomeResult,
  parseFollowUpBrief,
  parseOutcomeCurrent,
  parseOutcomeEvaluation,
  parseOutcomeEvaluationProposal,
  parseOutcomeEvidence,
  parseOutcomeHumanDecision,
  parseOutcomeWorkRequest,
  renderOutcomeEvaluationHtml,
  type FollowUpBrief,
  type OutcomeCurrent,
  type OutcomeDecision,
  type OutcomeEvaluation,
  type OutcomeEvaluationProposal,
  type OutcomeEvidence,
  type OutcomeHumanDecision,
  type OutcomeSignal,
  type OutcomeWorkRequest,
} from "./aidlc-vnext-outcome-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextPlanAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

const STAGE_PATH = resolve(runtimeCoreDir(), "aidlc-common/stages/st-09-outcome-evaluation.json");

export interface OutcomePrepareOptions {
  preparedAt?: string;
  notBefore?: string;
  deadline?: string | null;
}
export interface OutcomeEvaluateOptions { evaluatedAt?: string }
export interface OutcomeDecideOptions {
  evaluationSha256: string;
  decision: OutcomeDecision;
  reason: string;
  policyAcknowledgements?: PolicyAcknowledgement[];
  notBefore?: string | null;
  deadline?: string | null;
  decidedAt?: string;
}
export interface OutcomeReuseOptions {
  outcomeCurrentPath: string;
  reason: string;
  reusedAt?: string;
}
export interface OutcomePrepareResult {
  execution: "prepared" | "reused" | "waiting";
  request: OutcomeWorkRequest | null;
  reference: ArtifactReference | null;
  state: VNextIntentState;
}
export interface OutcomeEvaluateResult {
  outcome: "completed" | "awaiting_decision";
  evidence: OutcomeEvidence;
  evidenceReference: ArtifactReference;
  evaluation: OutcomeEvaluation;
  evaluationReference: ArtifactReference;
  htmlReference: ArtifactReference;
  current: OutcomeCurrent | null;
  currentReference: ArtifactReference | null;
  state: VNextIntentState;
}
export interface OutcomeDecideResult {
  outcome: "continued" | "completed";
  decision: OutcomeHumanDecision;
  decisionReference: ArtifactReference;
  followUp: FollowUpBrief | null;
  followUpReference: ArtifactReference | null;
  current: OutcomeCurrent | null;
  currentReference: ArtifactReference | null;
  state: VNextIntentState;
}
export interface OutcomeReuseResult {
  current: OutcomeCurrent;
  currentReference: ArtifactReference;
  reusedOutcomeCurrentReference: ArtifactReference;
  state: VNextIntentState;
}
export interface PendingOutcomeDecision {
  evaluation: OutcomeEvaluation;
  evaluationReference: ArtifactReference;
  htmlReference: ArtifactReference;
}

interface OutcomeInputs {
  state: VNextIntentState;
  plan: StageExecutionPlan;
  intent: IntentDefinition;
  intentReference: ArtifactReference;
  requirements: RequirementsDefinition;
  requirementsReference: ArtifactReference;
  reviewManifest: ReviewManifest | null;
  reviewManifestReference: ArtifactReference | null;
  release: ReleaseCurrent;
  releaseReference: ArtifactReference;
}

function fail(context: string, message: string): never { throw new Error(`${context}: ${message}`); }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function digest(value: string | Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function portable(value: string): string { return value.split(sep).join("/"); }
function refsEqual(left: ArtifactReference | null, right: ArtifactReference | null): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function clearObservationSchedule(state: VNextIntentState): VNextIntentState {
  const result = { ...state };
  delete result.not_before;
  delete result.deadline;
  return result;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* rename consumed it */ }
    throw error;
  }
}

function projectPath(projectDir: string, path: string): string {
  const value = relative(resolve(projectDir), resolve(path));
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) fail("ST-09 Outcome Evaluation", `path is outside the Project: ${path}`);
  return value === "" ? "." : portable(value);
}

function reference(projectDir: string, path: string, artifact: string, content?: string): ArtifactReference {
  const bytes = content ?? readFileSync(path, "utf8");
  return parseArtifactReference({ artifact, version: 1, source_of_truth: projectPath(projectDir, path), sha256: digest(bytes) });
}

function readCanonical<T>(path: string, parser: (value: unknown, context?: string) => T): { value: T; content: string } {
  const content = readFileSync(path, "utf8");
  let value: T;
  try { value = parser(JSON.parse(content), path); }
  catch (error) { fail("ST-09 Outcome Evaluation", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (content !== serialize(value)) fail("ST-09 Outcome Evaluation", `artifact is not canonical: ${path}`);
  return { value, content };
}

export function outcomeRootDir(recordDir: string): string { return join(resolve(recordDir), "artifacts", "outcome"); }
export function outcomeWorkRequestPath(recordDir: string): string { return join(outcomeRootDir(recordDir), "work-request.json"); }
export function outcomeEvidencePath(recordDir: string): string { return join(outcomeRootDir(recordDir), "outcome-evidence.json"); }
export function outcomeEvaluationPath(recordDir: string): string { return join(outcomeRootDir(recordDir), "outcome-evaluation.json"); }
export function outcomeHtmlPath(recordDir: string): string { return join(outcomeRootDir(recordDir), "outcome.html"); }
export function outcomeDecisionPath(recordDir: string): string { return join(outcomeRootDir(recordDir), "review", "human-decision.json"); }
export function outcomeCurrentPath(recordDir: string): string { return join(outcomeRootDir(recordDir), "current.json"); }
export function followUpBriefPath(recordDir: string): string { return join(outcomeRootDir(recordDir), "follow-up-brief.json"); }
export function outcomeWorkRequestRevisionPath(recordDir: string, revision: number): string { return join(outcomeRootDir(recordDir), "requests", revision.toString().padStart(6, "0"), "work-request.json"); }
export function outcomeEvidenceRevisionPath(recordDir: string, revision: number): string { return join(outcomeRootDir(recordDir), "revisions", revision.toString().padStart(6, "0"), "outcome-evidence.json"); }
export function outcomeEvaluationRevisionPath(recordDir: string, revision: number): string { return join(outcomeRootDir(recordDir), "revisions", revision.toString().padStart(6, "0"), "outcome-evaluation.json"); }
export function outcomeHtmlRevisionPath(recordDir: string, revision: number): string { return join(outcomeRootDir(recordDir), "revisions", revision.toString().padStart(6, "0"), "outcome.html"); }
export function outcomeDecisionRevisionPath(recordDir: string, decisionId: string): string { return join(outcomeRootDir(recordDir), "decisions", decisionId, "human-decision.json"); }

export function loadOutcomeStageContract(path = STAGE_PATH): VNextStageContract {
  const contract = parseVNextStageContract(JSON.parse(readFileSync(path, "utf8")), "ST-09 Outcome Evaluation Stage Contract");
  if (contract.stage_id !== "ST-09" || contract.name !== "Outcome Evaluation") fail("ST-09 Contract", "must define ST-09 Outcome Evaluation");
  return contract;
}

function localCanonical<T>(projectDir: string, path: string, artifact: string, parser: (value: unknown, context?: string) => T): { value: T; reference: ArtifactReference } {
  const stored = readCanonical(path, parser);
  const result = reference(projectDir, path, artifact, stored.content);
  verifyProjectArtifactReference(projectDir, result);
  return { value: stored.value, reference: result };
}

function loadInputs(projectDir: string, recordDir: string): OutcomeInputs {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-09" || state.status === "completed") fail("ST-09 Outcome Evaluation", `current State must be an active ST-09, found ${state.current_stage}/${state.status}`);
  const intentStored = localCanonical(projectDir, intentDefinitionPath(recordDir), "intent-definition", parseIntentDefinition);
  const requirementsCurrent = localCanonical(projectDir, requirementsCurrentPath(recordDir), "requirements-current", parseRequirementsCurrent);
  verifyProjectArtifactReference(projectDir, requirementsCurrent.value.requirements_ref);
  const requirementsStored = localCanonical(projectDir, resolve(projectDir, requirementsCurrent.value.requirements_ref.source_of_truth), "requirements-definition", parseRequirementsDefinition);
  if (!refsEqual(requirementsCurrent.value.requirements_ref, requirementsStored.reference)) fail("ST-09 Outcome Evaluation", "Requirements Current does not pin the canonical Requirements Definition");
  const releaseStored = localCanonical(projectDir, releaseCurrentPath(recordDir), "release-current", parseReleaseCurrent);
  const reviewCurrentStored = localCanonical(projectDir, reviewCurrentPath(recordDir), "review-current", parseReviewCurrent);
  if (!refsEqual(releaseStored.value.review_current_ref, reviewCurrentStored.reference)) fail("ST-09 Outcome Evaluation", "Release Current does not pin the active Review Current");
  let reviewManifest: ReviewManifest | null = null;
  let reviewManifestReference: ArtifactReference | null = null;
  if (reviewCurrentStored.value.review_manifest_ref !== null) {
    verifyProjectArtifactReference(projectDir, reviewCurrentStored.value.review_manifest_ref);
    const stored = localCanonical(projectDir, resolve(projectDir, reviewCurrentStored.value.review_manifest_ref.source_of_truth), "review-manifest", parseReviewManifest);
    if (!refsEqual(stored.reference, reviewCurrentStored.value.review_manifest_ref)) fail("ST-09 Outcome Evaluation", "Review Current does not pin the canonical Review Manifest");
    reviewManifest = stored.value;
    reviewManifestReference = stored.reference;
  }
  for (const item of [intentStored.reference, requirementsStored.reference, releaseStored.reference, state.policy_snapshot]) verifyProjectArtifactReference(projectDir, item);
  for (const value of [intentStored.value.intent_id, requirementsStored.value.intent_id, releaseStored.value.intent_id]) {
    if (value !== state.intent_id) fail("ST-09 Outcome Evaluation", "an input belongs to another Intent");
  }
  return { state, plan, intent: intentStored.value, intentReference: intentStored.reference, requirements: requirementsStored.value, requirementsReference: requirementsStored.reference, reviewManifest, reviewManifestReference, release: releaseStored.value, releaseReference: releaseStored.reference };
}

function signals(inputs: OutcomeInputs): OutcomeSignal[] {
  const values: OutcomeSignal[] = [];
  inputs.intent.expected_outcomes.forEach((statement, index) => values.push({ signal_id: `OUT-${String(index + 1).padStart(3, "0")}`, source_artifact: "intent-definition", source_pointer: `/expected_outcomes/${index}`, statement, required: true, allowed_evidence_types: ["artifact", "registered-observation", "human-confirmation"] }));
  inputs.intent.success_signals.forEach((statement, index) => values.push({ signal_id: `SIG-${String(index + 1).padStart(3, "0")}`, source_artifact: "intent-definition", source_pointer: `/success_signals/${index}`, statement, required: true, allowed_evidence_types: ["artifact", "registered-observation", "human-confirmation"] }));
  for (const [field, items] of [
    ["functional_requirements", inputs.requirements.functional_requirements],
    ["quality_requirements", inputs.requirements.quality_requirements],
    ["constraints", inputs.requirements.constraints],
    ["invariants", inputs.requirements.invariants],
  ] as const) items.forEach((entry, index) => values.push({ signal_id: entry.id, source_artifact: "requirements-definition", source_pointer: `/${field}/${index}`, statement: entry.statement, required: true, allowed_evidence_types: ["artifact", "registered-observation", "human-confirmation"] }));
  inputs.reviewManifest?.acceptance_criteria.forEach((entry, index) => values.push({ signal_id: entry.criterion_id, source_artifact: "review-manifest", source_pointer: `/acceptance_criteria/${index}`, statement: `${entry.given} / ${entry.when} / ${entry.then}`, required: true, allowed_evidence_types: ["artifact", "registered-observation", "human-confirmation"] }));
  if (new Set(values.map((entry) => entry.signal_id)).size !== values.length) fail("ST-09 Outcome Evaluation", "promised signal IDs are not unique");
  return values;
}

function latestRequestRevision(recordDir: string): number {
  return existsSync(outcomeWorkRequestPath(recordDir)) ? readCanonical(outcomeWorkRequestPath(recordDir), parseOutcomeWorkRequest).value.revision : 0;
}

function clearMutableObservationCycle(recordDir: string): void {
  // Immutable revisions and decisions remain available for Audit and diagnosis.
  for (const path of [
    outcomeEvidencePath(recordDir),
    outcomeEvaluationPath(recordDir),
    outcomeHtmlPath(recordDir),
    outcomeDecisionPath(recordDir),
  ]) if (existsSync(path)) unlinkSync(path);
}

function prepareLocked(projectDir: string, recordDir: string, options: OutcomePrepareOptions): OutcomePrepareResult {
  loadOutcomeStageContract();
  const inputs = loadInputs(projectDir, recordDir);
  const at = options.preparedAt ?? new Date().toISOString();
  const notBefore = options.notBefore ?? inputs.state.not_before ?? at;
  const deadline = options.deadline === undefined ? inputs.state.deadline ?? null : options.deadline;
  const schedule = parseOutcomeWorkRequest({ schema_version: 1, artifact: "outcome-work-request", version: 1, revision: 1, intent_id: inputs.state.intent_id, stage_id: "ST-09", intent_definition_ref: inputs.intentReference, requirements_ref: inputs.requirementsReference, review_manifest_ref: inputs.reviewManifestReference, release_current_ref: inputs.releaseReference, release_outcome: inputs.release.outcome, effective_policy_ref: inputs.state.policy_snapshot, signals: signals(inputs), not_before: notBefore, deadline, requested_output: "outcome-evaluation-proposal", rules: ["Assess every signal_id exactly once.", "Use only Project-bound Artifact Evidence or a registered observation/human confirmation recorded outside the AI proposal.", "Do not include shell commands, secrets, a next Stage, a backward route, or a new Intent instruction.", "A rolled_back Release cannot be proposed as an achieved overall Outcome."], created_at: at });
  const prior = existsSync(outcomeWorkRequestPath(recordDir)) ? readCanonical(outcomeWorkRequestPath(recordDir), parseOutcomeWorkRequest) : null;
  const comparable = (value: OutcomeWorkRequest) => ({ ...value, revision: 0, created_at: "" });
  if (prior !== null && JSON.stringify(comparable(prior.value)) === JSON.stringify(comparable(schedule))) {
    const requestReference = reference(projectDir, outcomeWorkRequestRevisionPath(recordDir, prior.value.revision), "outcome-work-request", prior.content);
    return { execution: "reused", request: prior.value, reference: requestReference, state: inputs.state };
  }
  if (Date.parse(at) < Date.parse(schedule.not_before)) {
    const state: VNextIntentState = { ...clearObservationSchedule(inputs.state), status: "parked", parked_reason: `ST-09 Outcome observation is scheduled for ${schedule.not_before}.`, not_before: schedule.not_before, ...(schedule.deadline === null ? {} : { deadline: schedule.deadline }), updated_at: at };
    writeVNextStateAt(recordDir, state, inputs.plan);
    return { execution: "waiting", request: null, reference: null, state: readVNextStateAt(recordDir) };
  }
  if (schedule.deadline !== null && Date.parse(at) > Date.parse(schedule.deadline)) {
    const state: VNextIntentState = { ...clearObservationSchedule(inputs.state), status: "parked", parked_reason: `ST-09 Outcome observation deadline ${schedule.deadline} passed; a human must reschedule or decide the Outcome.`, not_before: schedule.not_before, deadline: schedule.deadline, updated_at: at };
    writeVNextStateAt(recordDir, state, inputs.plan);
    return { execution: "waiting", request: null, reference: null, state: readVNextStateAt(recordDir) };
  }
  const request = parseOutcomeWorkRequest({ ...schedule, revision: latestRequestRevision(recordDir) + 1 });
  const content = serialize(request);
  const immutablePath = outcomeWorkRequestRevisionPath(recordDir, request.revision);
  if (existsSync(immutablePath) && readFileSync(immutablePath, "utf8") !== content) fail("ST-09 Outcome Evaluation", `immutable Work Request revision ${request.revision} differs`);
  writeFileAtomic(immutablePath, content);
  if (prior !== null) clearMutableObservationCycle(recordDir);
  writeFileAtomic(outcomeWorkRequestPath(recordDir), content);
  const requestReference = reference(projectDir, immutablePath, "outcome-work-request", content);
  const state: VNextIntentState = { ...clearObservationSchedule(inputs.state), status: "parked", parked_reason: "ST-09 Outcome Evidence and Evaluation proposal are required.", not_before: request.not_before, ...(request.deadline === null ? {} : { deadline: request.deadline }), updated_at: at };
  writeVNextStateAt(recordDir, state, inputs.plan);
  appendAuditEntry(projectDir, recordDir, "STAGE_STARTED", { Stage: "ST-09", "Work Request SHA-256": requestReference.sha256, "Signal Count": String(request.signals.length), "Decision Authority": "core" });
  return { execution: "prepared", request, reference: requestReference, state: readVNextStateAt(recordDir) };
}

export function prepareOutcomeEvaluation(projectDir: string, options: OutcomePrepareOptions = {}): OutcomePrepareResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => prepareLocked(root, activeVNextIntentRecordDir(root), options));
}

function stageProposal(disposition: "execute" | "reuse", proposalId: string, reason: string, evidence: ArtifactReference[]): StageDispositionProposal {
  return { schema_version: 1, proposal_id: proposalId, stage_id: "ST-09", disposition, reason, evidence, proposed_by: "ai" };
}

function reviseOutcomePlan(projectDir: string, plan: StageExecutionPlan, proposal: StageDispositionProposal): StageExecutionPlan {
  const current = plan.stage_decisions.find((entry) => entry.stage_id === "ST-09");
  if (current?.proposal_ref === proposal.proposal_id && current.disposition === proposal.disposition && JSON.stringify(current.evidence) === JSON.stringify(proposal.evidence)) return plan;
  return reviseStageExecutionPlan(plan, [proposal], { projectDir, stageContracts: [loadOutcomeStageContract()] });
}

function latestEvaluationRevision(recordDir: string): number {
  return existsSync(outcomeEvaluationPath(recordDir)) ? readCanonical(outcomeEvaluationPath(recordDir), parseOutcomeEvaluation).value.revision : 0;
}

function finalize(projectDir: string, recordDir: string, state: VNextIntentState, oldPlan: StageExecutionPlan, evaluation: OutcomeEvaluation, workRequestReference: ArtifactReference, evidenceReference: ArtifactReference, evaluationReference: ArtifactReference, humanDecisionReference: ArtifactReference | null, followUpReference: ArtifactReference | null, mode: OutcomeCurrent["completion_mode"], reason: string, at: string, disposition: "execute" | "reuse" = "execute"): { current: OutcomeCurrent; reference: ArtifactReference; state: VNextIntentState } {
  const current = parseOutcomeCurrent({ schema_version: 1, artifact: "outcome-current", version: 1, intent_id: state.intent_id, disposition, overall_result: evaluation.overall_result, completion_mode: mode, work_request_ref: workRequestReference, outcome_evidence_ref: evidenceReference, outcome_evaluation_ref: evaluationReference, human_decision_ref: humanDecisionReference, follow_up_brief_ref: followUpReference, reason, completed_at: at });
  const content = serialize(current);
  writeFileAtomic(outcomeCurrentPath(recordDir), content);
  const currentReference = reference(projectDir, outcomeCurrentPath(recordDir), "outcome-current", content);
  const proposal = stageProposal(disposition, `st09-${disposition}-${evaluationReference.sha256.slice(7, 19)}`, reason, [workRequestReference, evidenceReference, evaluationReference, ...(humanDecisionReference === null ? [] : [humanDecisionReference]), ...(followUpReference === null ? [] : [followUpReference]), currentReference]);
  const plan = reviseOutcomePlan(projectDir, oldPlan, proposal);
  if (plan.revision !== oldPlan.revision) writeVNextPlanAt(recordDir, plan);
  if (!readOrderedAuditEntries(recordDir).some((entry) => entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-09" && entry.fields["Outcome Current SHA-256"] === currentReference.sha256)) appendAuditEntries(projectDir, recordDir, [
    ...(plan.revision === oldPlan.revision ? [] : [{ event: "PLAN_REVISED" as const, fields: { "Plan Revision": String(plan.revision), Stage: "ST-09", Disposition: disposition, "Decision Authority": "core" } }]),
    { event: "STAGE_COMPLETED", fields: { Stage: "ST-09", Outcome: evaluation.overall_result, Artifact: currentReference.source_of_truth, "Outcome Current SHA-256": currentReference.sha256, "Decision Authority": "core", Terminal: "true" } },
  ]);
  const completed: VNextIntentState = { schema_version: state.schema_version, workflow: "vnext", intent_id: state.intent_id, catalog_version: state.catalog_version, graph_version: state.graph_version, plan_revision: plan.revision, policy_snapshot: state.policy_snapshot, current_stage: "ST-09", status: "completed", created_at: state.created_at, updated_at: at };
  writeVNextStateAt(recordDir, completed, plan);
  return { current, reference: currentReference, state: readVNextStateAt(recordDir) };
}

function evaluateLocked(projectDir: string, recordDir: string, proposalValue: unknown, options: OutcomeEvaluateOptions): OutcomeEvaluateResult {
  const inputs = loadInputs(projectDir, recordDir);
  if (!existsSync(outcomeWorkRequestPath(recordDir))) fail("ST-09 Outcome Evaluation", "Outcome Work Request is required; run prepare first");
  const requestStored = readCanonical(outcomeWorkRequestPath(recordDir), parseOutcomeWorkRequest);
  const requestPath = outcomeWorkRequestRevisionPath(recordDir, requestStored.value.revision);
  if (!existsSync(requestPath) || readFileSync(requestPath, "utf8") !== requestStored.content) fail("ST-09 Outcome Evaluation", "immutable Work Request revision is missing or differs");
  const workRequestReference = reference(projectDir, requestPath, "outcome-work-request", requestStored.content);
  const at = options.evaluatedAt ?? new Date().toISOString();
  if (Date.parse(at) < Date.parse(requestStored.value.not_before)) fail("ST-09 Outcome Evaluation", `observation window opens at ${requestStored.value.not_before}`);
  if (requestStored.value.deadline !== null && Date.parse(at) > Date.parse(requestStored.value.deadline)) fail("ST-09 Outcome Evaluation", `observation deadline passed at ${requestStored.value.deadline}`);
  const proposal = parseOutcomeEvaluationProposal(proposalValue);
  if (proposal.intent_id !== inputs.state.intent_id || proposal.work_request_sha256 !== workRequestReference.sha256) fail("ST-09 Outcome Evaluation", "proposal is not bound to the active Work Request");
  const expected = requestStored.value.signals.map((entry) => entry.signal_id);
  const actual = proposal.observations.map((entry) => entry.signal_id);
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) fail("ST-09 Outcome Evaluation", "proposal must assess every fixed signal exactly once");
  for (const observation of proposal.observations) {
    if (Date.parse(observation.observed_at) < Date.parse(requestStored.value.not_before) || (requestStored.value.deadline !== null && Date.parse(observation.observed_at) > Date.parse(requestStored.value.deadline))) fail("ST-09 Outcome Evaluation", `observation ${observation.signal_id} is outside the approved time window`);
    for (const item of observation.evidence_refs) verifyProjectArtifactReference(projectDir, item);
  }
  const overall = calculateOutcomeResult(proposal.observations);
  if (requestStored.value.release_outcome === "rolled_back" && overall === "achieved") fail("ST-09 Outcome Evaluation", "a rolled_back Release cannot be evaluated as achieved");
  const revision = latestEvaluationRevision(recordDir) + 1;
  const evidence = parseOutcomeEvidence({ schema_version: 1, artifact: "outcome-evidence", version: 1, revision, evidence_id: `outcome-evidence-${String(revision).padStart(3, "0")}`, intent_id: inputs.state.intent_id, work_request_ref: workRequestReference, observations: proposal.observations, collected_at: at });
  const evidenceContent = serialize(evidence);
  const immutableEvidencePath = outcomeEvidenceRevisionPath(recordDir, revision);
  writeFileAtomic(immutableEvidencePath, evidenceContent);
  writeFileAtomic(outcomeEvidencePath(recordDir), evidenceContent);
  const evidenceReference = reference(projectDir, immutableEvidencePath, "outcome-evidence", evidenceContent);
  const gate = resolveHumanGateRequirementsAt(projectDir, recordDir, "ST-09", requestStored.value.effective_policy_ref, { createdAt: at });
  const gateReference = humanGateRequirementReferenceAt(projectDir, recordDir, gate);
  const evaluation = parseOutcomeEvaluation({ schema_version: 1, artifact: "outcome-evaluation", version: 1, revision, evaluation_id: `outcome-evaluation-${String(revision).padStart(3, "0")}`, intent_id: inputs.state.intent_id, stage_id: "ST-09", disposition: "execute", work_request_ref: workRequestReference, outcome_evidence_ref: evidenceReference, gate_requirement_set_ref: gateReference, release_outcome: requestStored.value.release_outcome, signal_results: proposal.observations, overall_result: overall, reason: proposal.reason, evaluated_at: at });
  const evaluationContent = serialize(evaluation);
  const immutableEvaluationPath = outcomeEvaluationRevisionPath(recordDir, revision);
  writeFileAtomic(immutableEvaluationPath, evaluationContent);
  writeFileAtomic(outcomeEvaluationPath(recordDir), evaluationContent);
  const evaluationReference = reference(projectDir, immutableEvaluationPath, "outcome-evaluation", evaluationContent);
  const html = renderOutcomeEvaluationHtml(evaluation, renderHumanGateRequirementSection(gate));
  writeFileAtomic(outcomeHtmlRevisionPath(recordDir, revision), html);
  writeFileAtomic(outcomeHtmlPath(recordDir), html);
  const htmlReference = reference(projectDir, outcomeHtmlRevisionPath(recordDir, revision), "outcome-html", html);
  if (overall === "achieved" && gate.requirements.length === 0) {
    const finalized = finalize(projectDir, recordDir, inputs.state, inputs.plan, evaluation, workRequestReference, evidenceReference, evaluationReference, null, null, "auto-achieved", "Every fixed Outcome signal is achieved with verified Project Evidence.", at);
    return { outcome: "completed", evidence, evidenceReference, evaluation, evaluationReference, htmlReference, current: finalized.current, currentReference: finalized.reference, state: finalized.state };
  }
  const state: VNextIntentState = { ...inputs.state, status: "parked", parked_reason: `ST-09 Outcome is ${overall}; a human must confirm Policy requirements and decide whether to continue observation or accept closure.`, updated_at: at };
  writeVNextStateAt(recordDir, state, inputs.plan);
  appendAuditEntry(projectDir, recordDir, "ROUTE_BLOCKED", { Stage: "ST-09", Outcome: overall, "Outcome Evaluation SHA-256": evaluationReference.sha256, Reason: "Human outcome value judgment is required.", "Decision Authority": "core" });
  return { outcome: "awaiting_decision", evidence, evidenceReference, evaluation, evaluationReference, htmlReference, current: null, currentReference: null, state: readVNextStateAt(recordDir) };
}

export function evaluateOutcome(projectDir: string, proposal: OutcomeEvaluationProposal | unknown, options: OutcomeEvaluateOptions = {}): OutcomeEvaluateResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => evaluateLocked(root, activeVNextIntentRecordDir(root), proposal, options));
}

function currentEvaluation(projectDir: string, recordDir: string): { evaluation: OutcomeEvaluation; reference: ArtifactReference; htmlReference: ArtifactReference } {
  if (!existsSync(outcomeEvaluationPath(recordDir)) || !existsSync(outcomeHtmlPath(recordDir))) fail("ST-09 Outcome Evaluation", "an Outcome Evaluation is required");
  const stored = readCanonical(outcomeEvaluationPath(recordDir), parseOutcomeEvaluation);
  const immutable = outcomeEvaluationRevisionPath(recordDir, stored.value.revision);
  const immutableHtml = outcomeHtmlRevisionPath(recordDir, stored.value.revision);
  if (!existsSync(immutable) || readFileSync(immutable, "utf8") !== stored.content || !existsSync(immutableHtml)) fail("ST-09 Outcome Evaluation", "immutable Evaluation revision is incomplete");
  const request = readCanonical(resolve(projectDir, stored.value.work_request_ref.source_of_truth), parseOutcomeWorkRequest).value;
  verifyProjectArtifactReference(projectDir, stored.value.gate_requirement_set_ref);
  const gate = readCanonical(resolve(projectDir, stored.value.gate_requirement_set_ref.source_of_truth), parseHumanGateRequirementSet).value;
  if (gate.stage_id !== "ST-09" || gate.intent_id !== stored.value.intent_id || !refsEqual(gate.effective_policy_ref, request.effective_policy_ref)) fail("ST-09 Outcome Evaluation", "Evaluation Gate Requirement Set does not bind ST-09, the Intent, and Effective Policy");
  const html = renderOutcomeEvaluationHtml(stored.value, renderHumanGateRequirementSection(gate));
  if (readFileSync(outcomeHtmlPath(recordDir), "utf8") !== html || readFileSync(immutableHtml, "utf8") !== html) fail("ST-09 Outcome Evaluation", "Outcome HTML differs from the canonical Evaluation");
  return { evaluation: stored.value, reference: reference(projectDir, immutable, "outcome-evaluation", stored.content), htmlReference: reference(projectDir, immutableHtml, "outcome-html", html) };
}

export function pendingOutcomeDecision(projectDir: string): PendingOutcomeDecision | null {
  const root = resolve(projectDir);
  const recordDir = activeVNextIntentRecordDir(root);
  const state = readVNextStateAt(recordDir);
  if (state.current_stage !== "ST-09" || state.status === "completed" || !existsSync(outcomeEvaluationPath(recordDir))) return null;
  const current = currentEvaluation(root, recordDir);
  if (existsSync(outcomeDecisionPath(recordDir))) {
    const decision = readCanonical(outcomeDecisionPath(recordDir), parseOutcomeHumanDecision).value;
    if (refsEqual(decision.outcome_evaluation_ref, current.reference) && decision.decision === "continue-observation") return null;
  }
  return { evaluation: current.evaluation, evaluationReference: current.reference, htmlReference: current.htmlReference };
}

function decideLocked(projectDir: string, recordDir: string, options: OutcomeDecideOptions): OutcomeDecideResult {
  const inputs = loadInputs(projectDir, recordDir);
  const current = currentEvaluation(projectDir, recordDir);
  if (current.reference.sha256 !== options.evaluationSha256) fail("ST-09 Outcome Evaluation", "human decision does not bind the current Evaluation SHA-256");
  const at = options.decidedAt ?? new Date().toISOString();
  const workRequest = readCanonical(resolve(projectDir, current.evaluation.work_request_ref.source_of_truth), parseOutcomeWorkRequest).value;
  verifyProjectArtifactReference(projectDir, current.evaluation.gate_requirement_set_ref);
  const gate = readCanonical(resolve(projectDir, current.evaluation.gate_requirement_set_ref.source_of_truth), parseHumanGateRequirementSet).value;
  if (!refsEqual(gate.effective_policy_ref, workRequest.effective_policy_ref)) fail("ST-09 Outcome Evaluation", "Evaluation Gate Requirement Set does not bind the Work Request Policy");
  if (current.evaluation.overall_result === "achieved" && gate.requirements.length === 0) fail("ST-09 Outcome Evaluation", "achieved Evaluation without Policy requirements is completed automatically and needs no human decision");
  const acknowledgements = options.decision === "continue-observation" ? [] : validatePolicyAcknowledgements(gate, options.policyAcknowledgements ?? [], { projectDir, recordDir, requireCurrentRiskRegister: true });
  const gateReference = current.evaluation.gate_requirement_set_ref;
  const decision = parseOutcomeHumanDecision({ schema_version: 1, artifact: "outcome-human-decision", version: 1, decision_id: `outcome-decision-${randomUUID()}`, intent_id: inputs.state.intent_id, outcome_evaluation_ref: current.reference, gate_requirement_set_ref: gateReference, policy_acknowledgements: acknowledgements, decision: options.decision, reason: options.reason, decided_by: "human", decided_at: at, not_before: options.decision === "continue-observation" ? options.notBefore ?? null : null, deadline: options.decision === "continue-observation" ? options.deadline ?? null : null });
  const decisionContent = serialize(decision);
  const immutableDecisionPath = outcomeDecisionRevisionPath(recordDir, decision.decision_id);
  writeFileAtomic(immutableDecisionPath, decisionContent);
  writeFileAtomic(outcomeDecisionPath(recordDir), decisionContent);
  const decisionReference = reference(projectDir, immutableDecisionPath, "outcome-human-decision", decisionContent);
  if (decision.decision === "continue-observation") {
    const state: VNextIntentState = { ...clearObservationSchedule(inputs.state), status: "parked", parked_reason: `ST-09 Outcome observation continues at ${decision.not_before}.`, not_before: decision.not_before!, ...(decision.deadline === null ? {} : { deadline: decision.deadline }), updated_at: at };
    writeVNextStateAt(recordDir, state, inputs.plan);
    appendAuditEntry(projectDir, recordDir, "ROUTE_BLOCKED", { Stage: "ST-09", Decision: decision.decision, "Not Before": decision.not_before!, ...(decision.deadline === null ? {} : { Deadline: decision.deadline }), "Decision Authority": "human" });
    return { outcome: "continued", decision, decisionReference, followUp: null, followUpReference: null, current: null, currentReference: null, state: readVNextStateAt(recordDir) };
  }
  const work = readCanonical(resolve(projectDir, current.evaluation.work_request_ref.source_of_truth), parseOutcomeWorkRequest);
  const evidenceStored = readCanonical(resolve(projectDir, current.evaluation.outcome_evidence_ref.source_of_truth), parseOutcomeEvidence);
  let followUp: FollowUpBrief | null = null;
  let followUpReference: ArtifactReference | null = null;
  if (decision.decision === "complete-and-draft-follow-up") {
    const unresolved = current.evaluation.signal_results.filter((entry) => entry.result !== "achieved").map((entry) => entry.signal_id);
    followUp = parseFollowUpBrief({ schema_version: 1, artifact: "follow-up-brief", version: 1, brief_id: `follow-up-${randomUUID()}`, source_intent_id: inputs.state.intent_id, outcome_evaluation_ref: current.reference, human_decision_ref: decisionReference, title: `Follow-up for ${inputs.intent.purpose}`, problem_summary: `${current.evaluation.overall_result}: ${decision.reason}`, unresolved_signal_ids: unresolved, created_at: at });
    const content = serialize(followUp);
    writeFileAtomic(followUpBriefPath(recordDir), content);
    followUpReference = reference(projectDir, followUpBriefPath(recordDir), "follow-up-brief", content);
  }
  const finalized = finalize(projectDir, recordDir, inputs.state, inputs.plan, current.evaluation, reference(projectDir, resolve(projectDir, current.evaluation.work_request_ref.source_of_truth), "outcome-work-request", work.content), reference(projectDir, resolve(projectDir, current.evaluation.outcome_evidence_ref.source_of_truth), "outcome-evidence", evidenceStored.content), current.reference, decisionReference, followUpReference, decision.decision === "complete-and-draft-follow-up" ? "human-follow-up" : "human-accepted", decision.reason, at);
  return { outcome: "completed", decision, decisionReference, followUp, followUpReference, current: finalized.current, currentReference: finalized.reference, state: finalized.state };
}

export function decideOutcome(projectDir: string, options: OutcomeDecideOptions): OutcomeDecideResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => decideLocked(root, activeVNextIntentRecordDir(root), options));
}

function reuseLocked(projectDir: string, recordDir: string, options: OutcomeReuseOptions): OutcomeReuseResult {
  const inputs = loadInputs(projectDir, recordDir);
  const sourcePath = resolve(options.outcomeCurrentPath);
  projectPath(projectDir, sourcePath);
  const sourceStored = readCanonical(sourcePath, parseOutcomeCurrent);
  const reusedOutcomeCurrentReference = reference(projectDir, sourcePath, "outcome-current", sourceStored.content);
  const prior = sourceStored.value;
  if (prior.overall_result !== "achieved") fail("ST-09 Outcome Evaluation", "only an achieved Outcome can be reused without a new human value judgment");
  for (const item of [prior.work_request_ref, prior.outcome_evidence_ref, prior.outcome_evaluation_ref]) verifyProjectArtifactReference(projectDir, item);
  const priorRequest = readCanonical(resolve(projectDir, prior.work_request_ref.source_of_truth), parseOutcomeWorkRequest).value;
  const priorEvidenceStored = readCanonical(resolve(projectDir, prior.outcome_evidence_ref.source_of_truth), parseOutcomeEvidence);
  const priorEvaluationStored = readCanonical(resolve(projectDir, prior.outcome_evaluation_ref.source_of_truth), parseOutcomeEvaluation);
  const prepared = prepareLocked(
    projectDir,
    recordDir,
    options.reusedAt === undefined ? {} : { preparedAt: options.reusedAt },
  );
  if (prepared.request === null || prepared.reference === null) fail("ST-09 Outcome Evaluation", "active Outcome Work Request is not ready for reuse");
  const comparable = (value: OutcomeWorkRequest) => ({ intent_definition_ref: value.intent_definition_ref, requirements_ref: value.requirements_ref, review_manifest_ref: value.review_manifest_ref, release_current_ref: value.release_current_ref, release_outcome: value.release_outcome, effective_policy_ref: value.effective_policy_ref, signals: value.signals });
  if (JSON.stringify(comparable(priorRequest)) !== JSON.stringify(comparable(prepared.request))) fail("ST-09 Outcome Evaluation", "reused Outcome does not match the active promises, Release Current, Policy, and signals");
  for (const observation of priorEvidenceStored.value.observations) for (const item of observation.evidence_refs) verifyProjectArtifactReference(projectDir, item);
  const at = options.reusedAt ?? new Date().toISOString();
  const gate = resolveHumanGateRequirementsAt(projectDir, recordDir, "ST-09", prepared.request.effective_policy_ref, { createdAt: at });
  if (gate.requirements.length > 0) fail("ST-09 Outcome Evaluation", "Outcome reuse requires human confirmation because current Policy requirements apply");
  const html = renderOutcomeEvaluationHtml(priorEvaluationStored.value, renderHumanGateRequirementSection(gate));
  writeFileAtomic(outcomeHtmlPath(recordDir), html);
  const finalized = finalize(projectDir, recordDir, inputs.state, readVNextPlanAt(recordDir), { ...priorEvaluationStored.value, disposition: "reuse" }, prepared.reference, reference(projectDir, resolve(projectDir, prior.outcome_evidence_ref.source_of_truth), "outcome-evidence", priorEvidenceStored.content), reference(projectDir, resolve(projectDir, prior.outcome_evaluation_ref.source_of_truth), "outcome-evaluation", priorEvaluationStored.content), null, null, "reused", options.reason, at, "reuse");
  return { current: finalized.current, currentReference: finalized.reference, reusedOutcomeCurrentReference, state: finalized.state };
}

export function reuseOutcomeEvaluation(projectDir: string, options: OutcomeReuseOptions): OutcomeReuseResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => reuseLocked(root, activeVNextIntentRecordDir(root), options));
}

export function main(argv: string[]): void {
  const [command, projectDir, ...rest] = argv;
  try {
    if (command === "prepare" && projectDir !== undefined && rest.length <= 1) { process.stdout.write(`${JSON.stringify(prepareOutcomeEvaluation(projectDir, rest[0] === undefined ? {} : { preparedAt: rest[0] }), null, 2)}\n`); return; }
    if (command === "evaluate" && projectDir !== undefined && rest.length >= 1 && rest.length <= 2) { process.stdout.write(`${JSON.stringify(evaluateOutcome(projectDir, JSON.parse(readFileSync(resolve(rest[0]!), "utf8")), rest[1] === undefined ? {} : { evaluatedAt: rest[1] }), null, 2)}\n`); return; }
    if (command === "decide" && projectDir !== undefined && rest.length >= 3 && rest.length <= 7) {
      const [evaluationSha256, decision, reason, fourth, fifth, sixth, seventh] = rest;
      const acknowledgementPath = fourth !== undefined && existsSync(resolve(fourth)) ? resolve(fourth) : null;
      const acknowledgements = acknowledgementPath === null ? [] : JSON.parse(readFileSync(acknowledgementPath, "utf8"));
      const [notBefore, deadline, decidedAt] = acknowledgementPath === null ? [fourth, fifth, sixth] : [fifth, sixth, seventh];
      process.stdout.write(`${JSON.stringify(decideOutcome(projectDir, { evaluationSha256: evaluationSha256!, decision: decision as OutcomeDecision, reason: reason!, policyAcknowledgements: acknowledgements, ...(notBefore === undefined ? {} : { notBefore }), ...(deadline === undefined ? {} : { deadline }), ...(decidedAt === undefined ? {} : { decidedAt }) }), null, 2)}\n`); return;
    }
    if (command === "reuse" && projectDir !== undefined && rest.length >= 2 && rest.length <= 3) { process.stdout.write(`${JSON.stringify(reuseOutcomeEvaluation(projectDir, { outcomeCurrentPath: rest[0]!, reason: rest[1]!, ...(rest[2] === undefined ? {} : { reusedAt: rest[2] }) }), null, 2)}\n`); return; }
    console.error("Usage: aidlc-vnext-outcome.ts prepare <project-dir> [prepared-at] | evaluate <project-dir> <proposal.json> [evaluated-at] | decide <project-dir> <evaluation-sha256> <continue-observation|complete-with-outcome|complete-and-draft-follow-up> <reason> [policy-acknowledgements.json] [not-before] [deadline] [decided-at] | reuse <project-dir> <outcome-current.json> <reason> [reused-at]");
    process.exitCode = 1;
  } catch (error) {
    if (projectDir !== undefined) {
      try { appendAuditEntry(resolve(projectDir), activeVNextIntentRecordDir(resolve(projectDir)), "ROUTE_BLOCKED", { Stage: "ST-09", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" }); } catch { /* preserve original error */ }
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
