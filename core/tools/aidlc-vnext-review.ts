#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { appendAuditEntries, appendAuditEntry, readOrderedAuditEntries } from "./aidlc-audit.ts";
import {
  loadVNextDefinitions,
  nextForwardStage,
  reviseStageExecutionPlan,
  validateCoreRoute,
  type VNextFeedbackReason,
} from "./aidlc-core-route.ts";
import { verifyProjectArtifactReference } from "./aidlc-effective-policy.ts";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";
import {
  parseArtifactReference,
  parseVNextStageContract,
  VNEXT_STAGE_IDS,
  type ArtifactReference,
  type StageDispositionProposal,
  type StageExecutionPlan,
  type VNextStageContract,
} from "./aidlc-stage-contract.ts";
import { parseArchitectureCurrent } from "./aidlc-vnext-architecture-contract.ts";
import { parseBuildContract, parseBuildContractCurrent } from "./aidlc-vnext-build-contract-contract.ts";
import {
  parseBuildCurrent,
  parseRunnableCandidate,
  type BuildCurrent,
  type RunnableCandidate,
} from "./aidlc-vnext-build-converge-contract.ts";
import { buildCurrentPath } from "./aidlc-vnext-build-converge.ts";
import { promoteAcceptedSystemMapSources } from "./aidlc-vnext-orient.ts";
import { parseRequirementsDefinition } from "./aidlc-vnext-requirements-contract.ts";
import {
  parseAcceptedCandidate,
  parseCandidateReviewDecision,
  parseFeedbackCurrent,
  parseReviewCurrent,
  parseReviewFeedbackItem,
  parseReviewManifest,
  renderCandidateReviewHtml,
  type AcceptedCandidate,
  type CandidateReviewDecision,
  type FeedbackCurrent,
  type HumanCheckResult,
  type ReviewCurrent,
  type ReviewFeedbackItem,
  type ReviewManifest,
} from "./aidlc-vnext-review-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextPlanAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { activeSpace } from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export interface CandidateReviewPrepareOptions { preparedAt?: string }
export interface PendingCandidateReview {
  manifest: ReviewManifest;
  manifestReference: ArtifactReference;
  reviewReference: ArtifactReference;
}
export interface CandidateReviewPrepareResult {
  execution: "prepared" | "reused" | "advanced";
  pending: PendingCandidateReview | null;
  current: ReviewCurrent | null;
  currentReference: ArtifactReference | null;
  state: VNextIntentState;
}
export interface CandidateReviewApproveOptions {
  manifestSha256: string;
  reason: string;
  humanCheckResults?: HumanCheckResult[];
  decidedAt?: string;
}
export interface CandidateReviewApprovalResult {
  decision: CandidateReviewDecision;
  decisionReference: ArtifactReference;
  acceptedCandidate: AcceptedCandidate;
  acceptedCandidateReference: ArtifactReference;
  current: ReviewCurrent;
  currentReference: ArtifactReference;
  state: VNextIntentState;
}
export interface CandidateReviewFeedbackOptions {
  manifestSha256: string;
  feedbackItems: ReviewFeedbackItem[];
  reason: string;
  humanCheckResults?: HumanCheckResult[];
  decidedAt?: string;
}
export interface CandidateReviewFeedbackResult {
  decision: CandidateReviewDecision;
  decisionReference: ArtifactReference;
  feedback: FeedbackCurrent;
  feedbackReference: ArtifactReference;
  current: ReviewCurrent;
  currentReference: ArtifactReference;
  state: VNextIntentState;
}

interface ReviewInputs {
  state: VNextIntentState;
  plan: StageExecutionPlan;
  buildCurrent: BuildCurrent;
  buildCurrentReference: ArtifactReference;
  buildContractCurrent: ReturnType<typeof parseBuildContractCurrent>;
}

const STAGE_PATH = resolve(runtimeCoreDir(), "aidlc-common/stages/st-07-human-feedback-approval.json");
const ROUTES = [
  { reason: "requirements_changed", stage: "ST-03" },
  { reason: "architecture_impact", stage: "ST-04" },
  { reason: "build_contract_impact", stage: "ST-05" },
  { reason: "candidate_defect", stage: "ST-06" },
] as const;

function fail(context: string, message: string): never { throw new Error(`${context}: ${message}`) }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function digest(content: string | Uint8Array): string { return `sha256:${createHash("sha256").update(content).digest("hex")}` }
function portable(path: string): string { return path.split(sep).join("/") }
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, content, "utf8"); renameSync(temporary, path); }
  catch (error) { try { unlinkSync(temporary); } catch { /* renamed */ } throw error; }
}
function readCanonical<T>(path: string, parser: (value: unknown, context?: string) => T): { value: T; content: string } {
  const content = readFileSync(path, "utf8");
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { fail("ST-07 Human Review", `cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  const parsed = parser(value, path);
  if (content !== serialize(parsed)) fail("ST-07 Human Review", `Artifact is not canonical: ${path}`);
  return { value: parsed, content };
}
function reference(projectDir: string, path: string, artifact: string, content?: string): ArtifactReference {
  const absolute = resolve(path);
  const relativePath = relative(resolve(projectDir), absolute);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) fail("ST-07 Human Review", `Artifact is outside the Project: ${path}`);
  return parseArtifactReference({ artifact, version: 1, source_of_truth: portable(relativePath), sha256: digest(content ?? readFileSync(absolute)) });
}
function refsEqual(left: ArtifactReference, right: ArtifactReference): boolean { return JSON.stringify(left) === JSON.stringify(right) }

export function reviewRootDir(recordDir: string): string { return join(resolve(recordDir), "artifacts", "review") }
export function reviewManifestPath(recordDir: string): string { return join(reviewRootDir(recordDir), "review-manifest.json") }
export function reviewHtmlPath(recordDir: string): string { return join(reviewRootDir(recordDir), "review.html") }
export function reviewDecisionPath(recordDir: string): string { return join(reviewRootDir(recordDir), "human-decision.json") }
export function acceptedCandidatePath(recordDir: string): string { return join(reviewRootDir(recordDir), "accepted-candidate.json") }
export function feedbackCurrentPath(recordDir: string): string { return join(reviewRootDir(recordDir), "feedback-current.json") }
export function reviewCurrentPath(recordDir: string): string { return join(reviewRootDir(recordDir), "current.json") }
function candidateSnapshotPath(recordDir: string, sha256: string): string { return join(reviewRootDir(recordDir), "candidates", sha256.slice(7), "runnable-candidate.json") }
function reviewCycleRoot(recordDir: string, candidateSha256: string): string { return join(reviewRootDir(recordDir), "cycles", candidateSha256.slice(7)) }
function immutableReviewManifestPath(recordDir: string, candidateSha256: string): string { return join(reviewCycleRoot(recordDir, candidateSha256), "review-manifest.json") }
function immutableReviewHtmlPath(recordDir: string, candidateSha256: string): string { return join(reviewCycleRoot(recordDir, candidateSha256), "review.html") }
function immutableReviewDecisionPath(recordDir: string, decisionId: string): string { return join(reviewRootDir(recordDir), "decisions", `${decisionId}.json`) }
function immutableFeedbackPath(recordDir: string, candidateSha256: string): string { return join(reviewCycleRoot(recordDir, candidateSha256), "feedback-current.json") }

export function loadCandidateReviewStageContract(path: string = STAGE_PATH): VNextStageContract {
  const contract = parseVNextStageContract(JSON.parse(readFileSync(path, "utf8")), "ST-07 Human Feedback & Approval Stage Contract");
  if (contract.stage_id !== "ST-07" || contract.name !== "Human Feedback & Approval") fail("ST-07 Contract", "must define ST-07 Human Feedback & Approval");
  return contract;
}
export function selectFeedbackRoute(values: readonly ReviewFeedbackItem[]): { stage: "ST-03" | "ST-04" | "ST-05" | "ST-06"; reason: VNextFeedbackReason } {
  if (values.length === 0) fail("ST-07 Feedback", "at least one feedback item is required");
  const feedback = values.map((value, index) => parseReviewFeedbackItem(value, `ST-07 Feedback[${index}]`));
  const impacts = new Set(feedback.flatMap((entry) => entry.impacts));
  const selected = ROUTES.find((entry) => impacts.has(entry.reason));
  if (selected === undefined) fail("ST-07 Feedback", "no fixed feedback route is justified");
  return selected;
}

function loadInputs(projectDir: string, recordDir: string): ReviewInputs {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-07") fail("ST-07 Human Review", `current Stage must be ST-07, found ${state.current_stage}`);
  const buildPath = buildCurrentPath(recordDir);
  const buildStored = readCanonical(buildPath, parseBuildCurrent);
  const buildCurrentReference = reference(projectDir, buildPath, "build-current", buildStored.content);
  const contractCurrentPath = resolve(projectDir, buildStored.value.build_contract_current_ref.source_of_truth);
  verifyProjectArtifactReference(projectDir, buildStored.value.build_contract_current_ref);
  const contractCurrent = readCanonical(contractCurrentPath, parseBuildContractCurrent).value;
  if (buildStored.value.intent_id !== state.intent_id || contractCurrent.intent_id !== state.intent_id) fail("ST-07 Human Review", "Build inputs do not match the active Intent");
  if (!refsEqual(buildStored.value.build_contract_current_ref, reference(projectDir, contractCurrentPath, "build-contract-current"))) fail("ST-07 Human Review", "Build Current does not pin the current Build Contract result");
  return { state, plan, buildCurrent: buildStored.value, buildCurrentReference, buildContractCurrent: contractCurrent };
}
function snapshotCandidate(projectDir: string, recordDir: string, candidateRef: ArtifactReference): { candidate: RunnableCandidate; reference: ArtifactReference } {
  verifyProjectArtifactReference(projectDir, candidateRef);
  const stored = readCanonical(resolve(projectDir, candidateRef.source_of_truth), parseRunnableCandidate);
  const path = candidateSnapshotPath(recordDir, candidateRef.sha256);
  if (existsSync(path) && readFileSync(path, "utf8") !== stored.content) fail("ST-07 Human Review", "immutable Candidate snapshot differs");
  if (!existsSync(path)) writeFileAtomic(path, stored.content);
  const snapshot = reference(projectDir, path, "runnable-candidate", stored.content);
  if (snapshot.sha256 !== candidateRef.sha256) fail("ST-07 Human Review", "Candidate snapshot SHA-256 differs from Build Current");
  return { candidate: stored.value, reference: snapshot };
}
function snapshotReferencedArtifact(projectDir: string, recordDir: string, candidateSha256: string, sourceRef: ArtifactReference, fileName: string): ArtifactReference {
  verifyProjectArtifactReference(projectDir, sourceRef);
  const content = readFileSync(resolve(projectDir, sourceRef.source_of_truth), "utf8");
  const path = join(reviewCycleRoot(recordDir, candidateSha256), "inputs", fileName);
  if (existsSync(path) && readFileSync(path, "utf8") !== content) fail("ST-07 Human Review", `immutable review input differs: ${fileName}`);
  if (!existsSync(path)) writeFileAtomic(path, content);
  const snapshotted = reference(projectDir, path, sourceRef.artifact, content);
  if (snapshotted.sha256 !== sourceRef.sha256) fail("ST-07 Human Review", `review input SHA-256 differs: ${fileName}`);
  return snapshotted;
}
function verifyCandidateGit(projectDir: string, candidate: RunnableCandidate, contract: ReturnType<typeof parseBuildContract>): void {
  for (const result of candidate.source_results) {
    const roots = result.source_ids.map((sourceId) => {
      const source = contract.target_sources.find((entry) => entry.source_id === sourceId);
      if (source === undefined) fail("ST-07 Human Review", `Candidate references unknown source ${sourceId}`);
      const found = spawnSync("git", ["-C", resolve(projectDir, source.locator), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      if (found.status !== 0) fail("ST-07 Human Review", `Candidate source ${sourceId} is not an available Git Repository`);
      return resolve(found.stdout.trim());
    });
    if (new Set(roots).size !== 1) fail("ST-07 Human Review", `Candidate Repository binding differs for ${result.repository_id}`);
    const root = roots[0]!;
    if (spawnSync("git", ["-C", root, "cat-file", "-e", `${result.candidate_revision}^{commit}`]).status !== 0) fail("ST-07 Human Review", `Candidate revision is unavailable: ${result.candidate_revision}`);
    const changed = spawnSync("git", ["-C", root, "diff", "--name-only", `${result.base_revision}..${result.candidate_revision}`], { encoding: "utf8" });
    if (changed.status !== 0) fail("ST-07 Human Review", `cannot inspect Candidate diff for ${result.repository_id}`);
    const actual = changed.stdout.trim().split("\n").filter(Boolean).map(portable).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...result.changed_files].sort())) fail("ST-07 Human Review", `Candidate changed files differ for ${result.repository_id}`);
  }
}
function pendingLocked(projectDir: string, recordDir: string): PendingCandidateReview | null {
  const manifestPath = reviewManifestPath(recordDir);
  const htmlPath = reviewHtmlPath(recordDir);
  if (!existsSync(manifestPath) && !existsSync(htmlPath)) return null;
  if (!existsSync(manifestPath) || !existsSync(htmlPath)) fail("ST-07 Human Review", "Review Manifest and HTML must exist together");
  const stored = readCanonical(manifestPath, parseReviewManifest);
  const immutableManifest = immutableReviewManifestPath(recordDir, stored.value.runnable_candidate_ref.sha256);
  if (!existsSync(immutableManifest) || readFileSync(immutableManifest, "utf8") !== stored.content) fail("ST-07 Human Review", "immutable Review Manifest snapshot is missing or differs");
  const manifestReference = reference(projectDir, immutableManifest, "review-manifest", stored.content);
  for (const item of [stored.value.runnable_candidate_ref, stored.value.build_current_ref, stored.value.requirements_ref, stored.value.architecture_current_ref, stored.value.build_contract_ref, stored.value.effective_policy_ref, stored.value.system_map_ref, ...stored.value.machine_evidence_refs]) verifyProjectArtifactReference(projectDir, item);
  const html = renderCandidateReviewHtml(stored.value);
  if (readFileSync(htmlPath, "utf8") !== html) fail("ST-07 Human Review", "Review HTML differs from its pinned Manifest");
  const immutableHtml = immutableReviewHtmlPath(recordDir, stored.value.runnable_candidate_ref.sha256);
  if (!existsSync(immutableHtml) || readFileSync(immutableHtml, "utf8") !== html) fail("ST-07 Human Review", "immutable Review HTML snapshot is missing or differs");
  return { manifest: stored.value, manifestReference, reviewReference: reference(projectDir, immutableHtml, "review-html", html) };
}
export function pendingCandidateReview(projectDir: string): PendingCandidateReview | null {
  const root = resolve(projectDir);
  const recordDir = activeVNextIntentRecordDir(root);
  if (readVNextStateAt(recordDir).current_stage !== "ST-07") return null;
  return pendingLocked(root, recordDir);
}

function stageProposal(disposition: "execute" | "reuse" | "not_applicable", proposalId: string, reason: string, evidence: ArtifactReference[]): StageDispositionProposal {
  return { schema_version: 1, proposal_id: proposalId, stage_id: "ST-07", disposition, reason, evidence, proposed_by: "ai" };
}
function reviseReviewPlan(projectDir: string, plan: StageExecutionPlan, proposal: StageDispositionProposal, deterministic = false): StageExecutionPlan {
  const existing = plan.stage_decisions.find((entry) => entry.stage_id === "ST-07");
  if (existing?.proposal_ref === proposal.proposal_id && existing.disposition === proposal.disposition && JSON.stringify(existing.evidence) === JSON.stringify(proposal.evidence)) return plan;
  return reviseStageExecutionPlan(plan, [proposal], { projectDir, stageContracts: [loadCandidateReviewStageContract()], deterministicApplicability: (entry) => deterministic && entry.stage_id === "ST-07" && entry.disposition === "not_applicable" });
}
function writeReviewCurrent(projectDir: string, recordDir: string, current: ReviewCurrent): ArtifactReference {
  const path = reviewCurrentPath(recordDir);
  const content = serialize(current);
  writeFileAtomic(path, content);
  return reference(projectDir, path, "review-current", content);
}
function advanceForward(projectDir: string, recordDir: string, state: VNextIntentState, oldPlan: StageExecutionPlan, plan: StageExecutionPlan, current: ReviewCurrent, currentRef: ArtifactReference, evidence: ArtifactReference[], at: string): VNextIntentState {
  if (plan.revision !== oldPlan.revision) writeVNextPlanAt(recordDir, plan);
  const graph = loadVNextDefinitions().graph;
  const next = nextForwardStage(graph, "ST-07");
  if (next !== "ST-08") fail("ST-07 Human Review", "fixed Graph must route to ST-08");
  validateCoreRoute(graph, { from: "ST-07", to: next });
  if (!readOrderedAuditEntries(recordDir).some((entry) => entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-07" && entry.fields["Review Current SHA-256"] === currentRef.sha256)) appendAuditEntries(projectDir, recordDir, [
    ...(plan.revision === oldPlan.revision ? [] : [{ event: "PLAN_REVISED" as const, fields: { "Plan Revision": String(plan.revision), Stage: "ST-07", Disposition: current.disposition, "Decision Authority": "core" } }]),
    { event: current.outcome === "not_applicable" ? "STAGE_SKIPPED" : "STAGE_COMPLETED", fields: { Stage: "ST-07", Outcome: current.outcome, Artifact: currentRef.source_of_truth, "Review Current SHA-256": currentRef.sha256, Evidence: evidence.map((entry) => entry.sha256).join(","), "Decision Authority": "core" } },
    { event: "ROUTE_DECIDED", fields: { "From Stage": "ST-07", "Current Stage": "ST-08", Graph: graph.graph_version, "Decision Authority": "core" } },
  ]);
  const advanced: VNextIntentState = { ...state, plan_revision: plan.revision, current_stage: "ST-08", status: "parked", parked_reason: "ST-08 Release is not implemented yet.", updated_at: at };
  writeVNextStateAt(recordDir, advanced, plan);
  return readVNextStateAt(recordDir);
}
function completeNotApplicable(projectDir: string, recordDir: string, inputs: ReviewInputs, at: string): CandidateReviewPrepareResult {
  const approval = inputs.buildContractCurrent.approval_ref;
  verifyProjectArtifactReference(projectDir, approval);
  const current = parseReviewCurrent({ schema_version: 1, artifact: "review-current", version: 1, intent_id: inputs.state.intent_id, disposition: "not_applicable", outcome: "not_applicable", review_manifest_ref: null, human_decision_ref: approval, accepted_candidate_ref: null, feedback_current_ref: null, reason: "ST-06 produced no Runnable Candidate; the exact ST-05 no-build approval is reused as deterministic Evidence.", updated_at: at });
  for (const path of [reviewManifestPath(recordDir), reviewHtmlPath(recordDir)]) {
    if (existsSync(path)) unlinkSync(path);
  }
  const currentRef = writeReviewCurrent(projectDir, recordDir, current);
  const proposal = stageProposal("not_applicable", `st07-no-candidate-${inputs.buildCurrentReference.sha256.slice(7, 19)}`, current.reason, [inputs.buildCurrentReference, approval, currentRef]);
  const plan = reviseReviewPlan(projectDir, inputs.plan, proposal, true);
  const state = advanceForward(projectDir, recordDir, inputs.state, inputs.plan, plan, current, currentRef, proposal.evidence, at);
  return { execution: "advanced", pending: null, current, currentReference: currentRef, state };
}

function prepareLocked(projectDir: string, recordDir: string, options: CandidateReviewPrepareOptions): CandidateReviewPrepareResult {
  loadCandidateReviewStageContract();
  const inputs = loadInputs(projectDir, recordDir);
  const at = options.preparedAt ?? new Date().toISOString();
  if (inputs.buildCurrent.disposition === "not_applicable") return completeNotApplicable(projectDir, recordDir, inputs, at);
  if (inputs.buildCurrent.runnable_candidate_ref === null || inputs.buildContractCurrent.build_contract_ref === null) fail("ST-07 Human Review", "reviewable Build Current requires a Candidate and Build Contract");
  const existing = pendingLocked(projectDir, recordDir);
  if (existing !== null && inputs.buildCurrent.runnable_candidate_ref !== null && existing.manifest.runnable_candidate_ref.sha256 === inputs.buildCurrent.runnable_candidate_ref.sha256 && refsEqual(existing.manifest.build_contract_ref, inputs.buildContractCurrent.build_contract_ref!)) {
    return { execution: "reused", pending: existing, current: null, currentReference: null, state: inputs.state };
  }
  const snapshotted = snapshotCandidate(projectDir, recordDir, inputs.buildCurrent.runnable_candidate_ref);
  if (snapshotted.candidate.intent_id !== inputs.state.intent_id || !refsEqual(snapshotted.candidate.build_contract_ref, inputs.buildContractCurrent.build_contract_ref)) fail("ST-07 Human Review", "Candidate does not match the active Intent and Build Contract");
  verifyProjectArtifactReference(projectDir, inputs.buildContractCurrent.build_contract_ref);
  const contract = readCanonical(resolve(projectDir, inputs.buildContractCurrent.build_contract_ref.source_of_truth), parseBuildContract).value;
  verifyCandidateGit(projectDir, snapshotted.candidate, contract);
  verifyProjectArtifactReference(projectDir, inputs.buildContractCurrent.requirements_ref);
  const requirements = readCanonical(resolve(projectDir, inputs.buildContractCurrent.requirements_ref.source_of_truth), parseRequirementsDefinition).value;
  verifyProjectArtifactReference(projectDir, inputs.buildContractCurrent.architecture_current_ref);
  readCanonical(resolve(projectDir, inputs.buildContractCurrent.architecture_current_ref.source_of_truth), parseArchitectureCurrent);
  for (const item of [inputs.buildContractCurrent.effective_policy_ref, inputs.buildContractCurrent.system_map_ref]) verifyProjectArtifactReference(projectDir, item);
  const requirementItems = [...requirements.functional_requirements, ...requirements.quality_requirements, ...requirements.constraints, ...requirements.invariants];
  const requestedIds = new Set(contract.requirement_assessments.map((entry) => entry.requirement_id));
  const selectedRequirements = requirementItems.filter((entry) => requestedIds.has(entry.id)).map((entry) => ({ requirement_id: entry.id, statement: entry.statement }));
  if (selectedRequirements.length !== requestedIds.size) fail("ST-07 Human Review", "Build Contract requirement coverage differs from Requirements");
  const evidence = [...snapshotted.candidate.bolt_checkpoint_refs, ...snapshotted.candidate.integration_verifier_evidence_refs];
  for (const item of evidence) verifyProjectArtifactReference(projectDir, item);
  const buildCurrentSnapshot = snapshotReferencedArtifact(projectDir, recordDir, snapshotted.reference.sha256, inputs.buildCurrentReference, "build-current.json");
  const architectureSnapshot = snapshotReferencedArtifact(projectDir, recordDir, snapshotted.reference.sha256, inputs.buildContractCurrent.architecture_current_ref, "architecture-current.json");
  const manifest = parseReviewManifest({ schema_version: 1, artifact: "review-manifest", version: 1, intent_id: inputs.state.intent_id, stage_id: "ST-07", disposition: inputs.buildCurrent.disposition, build_current_ref: buildCurrentSnapshot, runnable_candidate_ref: snapshotted.reference, requirements_ref: inputs.buildContractCurrent.requirements_ref, architecture_current_ref: architectureSnapshot, build_contract_ref: inputs.buildContractCurrent.build_contract_ref, effective_policy_ref: inputs.buildContractCurrent.effective_policy_ref, system_map_ref: inputs.buildContractCurrent.system_map_ref, source_results: snapshotted.candidate.source_results, requirements: selectedRequirements, acceptance_criteria: contract.acceptance_criteria, machine_evidence_refs: evidence, human_checks: contract.verifiers.filter((entry) => entry.kind === "human-at-st07").map((entry) => ({ verifier_id: entry.verifier_id, expected: entry.expected })), known_constraints: [...requirements.constraints, ...requirements.invariants].map((entry) => entry.statement), created_at: at });
  const manifestContent = serialize(manifest);
  writeFileAtomic(immutableReviewManifestPath(recordDir, snapshotted.reference.sha256), manifestContent);
  writeFileAtomic(reviewManifestPath(recordDir), manifestContent);
  const manifestReference = reference(projectDir, immutableReviewManifestPath(recordDir, snapshotted.reference.sha256), "review-manifest", manifestContent);
  const html = renderCandidateReviewHtml(manifest);
  writeFileAtomic(immutableReviewHtmlPath(recordDir, snapshotted.reference.sha256), html);
  writeFileAtomic(reviewHtmlPath(recordDir), html);
  const reviewReference = reference(projectDir, immutableReviewHtmlPath(recordDir, snapshotted.reference.sha256), "review-html", html);
  if (!readOrderedAuditEntries(recordDir).some((entry) => entry.event === "STAGE_AWAITING_APPROVAL" && entry.fields["Review Manifest SHA-256"] === manifestReference.sha256)) appendAuditEntries(projectDir, recordDir, [
    { event: "STAGE_STARTED", fields: { Stage: "ST-07", Executor: "human+core", Verifier: "candidate-binding-validator" } },
    { event: "STAGE_AWAITING_APPROVAL", fields: { Stage: "ST-07", Candidate: snapshotted.reference.sha256, "Review Manifest SHA-256": manifestReference.sha256, Review: reviewReference.source_of_truth, "Decision Authority": "human" } },
  ]);
  const parked: VNextIntentState = { ...inputs.state, status: "parked", parked_reason: "ST-07 is awaiting human approval or classified feedback for the exact Review Manifest SHA-256.", updated_at: at };
  writeVNextStateAt(recordDir, parked, inputs.plan);
  return { execution: "prepared", pending: { manifest, manifestReference, reviewReference }, current: null, currentReference: null, state: readVNextStateAt(recordDir) };
}
export function prepareCandidateReview(projectDir: string, options: CandidateReviewPrepareOptions = {}): CandidateReviewPrepareResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => {
    const recordDir = activeVNextIntentRecordDir(root);
    try { return prepareLocked(root, recordDir, options); }
    catch (error) { appendAuditEntry(root, recordDir, "ROUTE_BLOCKED", { Stage: "ST-07", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" }); throw error; }
  });
}

function validateHumanChecks(manifest: ReviewManifest, results: readonly HumanCheckResult[], approval: boolean): HumanCheckResult[] {
  const expected = new Set(manifest.human_checks.map((entry) => entry.verifier_id));
  const parsed = results.map((entry) => ({ ...entry }));
  if (new Set(parsed.map((entry) => entry.verifier_id)).size !== parsed.length) fail("ST-07 Human Review", "human check results contain a duplicate verifier_id");
  if (parsed.some((entry) => !expected.has(entry.verifier_id))) fail("ST-07 Human Review", "human check result references an unknown verifier");
  if (approval && (parsed.length !== expected.size || parsed.some((entry) => entry.result !== "passed"))) fail("ST-07 Human Review", "approval requires every human-at-st07 check to pass");
  return parsed;
}
function writeDecision(projectDir: string, recordDir: string, decision: CandidateReviewDecision): ArtifactReference {
  const path = immutableReviewDecisionPath(recordDir, decision.decision_id);
  const content = serialize(decision);
  if (existsSync(path) && readFileSync(path, "utf8") !== content) fail("ST-07 Human Review", "existing Human Decision records different content");
  if (!existsSync(path)) writeFileAtomic(path, content);
  writeFileAtomic(reviewDecisionPath(recordDir), content);
  return reference(projectDir, path, "human-decision", content);
}
function approvalLocked(projectDir: string, recordDir: string, options: CandidateReviewApproveOptions): CandidateReviewApprovalResult {
  const inputs = loadInputs(projectDir, recordDir);
  const pending = pendingLocked(projectDir, recordDir);
  if (pending === null) fail("ST-07 Human Review", "no Candidate review is awaiting approval");
  if (pending.manifestReference.sha256 !== options.manifestSha256) fail("ST-07 Human Review", "approval SHA-256 does not match the pending Review Manifest");
  const checks = validateHumanChecks(pending.manifest, options.humanCheckResults ?? [], true);
  const at = options.decidedAt ?? new Date().toISOString();
  const decision = parseCandidateReviewDecision({ schema_version: 1, artifact: "human-decision", version: 1, decision_id: `approve-${pending.manifestReference.sha256.slice(7, 19)}`, decision_kind: "candidate-review", intent_id: inputs.state.intent_id, review_manifest_ref: pending.manifestReference, runnable_candidate_ref: pending.manifest.runnable_candidate_ref, decision: "approve-runnable-candidate", human_check_results: checks, feedback_items: [], reason: options.reason, decided_by: "human", decided_at: at });
  const decisionReference = writeDecision(projectDir, recordDir, decision);
  const promotion = promoteAcceptedSystemMapSources(projectDir, activeSpace(projectDir), pending.manifest.system_map_ref, pending.manifest.source_results.map((entry) => ({ source_ids: entry.source_ids, candidate_revision: entry.candidate_revision })), at);
  const accepted = parseAcceptedCandidate({ schema_version: 1, artifact: "accepted-candidate", version: 1, intent_id: inputs.state.intent_id, runnable_candidate_ref: pending.manifest.runnable_candidate_ref, review_manifest_ref: pending.manifestReference, approval_ref: decisionReference, requirements_ref: pending.manifest.requirements_ref, architecture_current_ref: pending.manifest.architecture_current_ref, build_contract_ref: pending.manifest.build_contract_ref, system_map_ref: promotion.systemMapReference, source_results: pending.manifest.source_results, accepted_at: at });
  const acceptedContent = serialize(accepted);
  if (existsSync(acceptedCandidatePath(recordDir)) && readFileSync(acceptedCandidatePath(recordDir), "utf8") !== acceptedContent) fail("ST-07 Human Review", "existing Accepted Candidate differs");
  if (!existsSync(acceptedCandidatePath(recordDir))) writeFileAtomic(acceptedCandidatePath(recordDir), acceptedContent);
  const acceptedReference = reference(projectDir, acceptedCandidatePath(recordDir), "accepted-candidate", acceptedContent);
  const current = parseReviewCurrent({ schema_version: 1, artifact: "review-current", version: 1, intent_id: inputs.state.intent_id, disposition: pending.manifest.disposition, outcome: "approved", review_manifest_ref: pending.manifestReference, human_decision_ref: decisionReference, accepted_candidate_ref: acceptedReference, feedback_current_ref: null, reason: options.reason, updated_at: at });
  const currentReference = writeReviewCurrent(projectDir, recordDir, current);
  const proposal = stageProposal(pending.manifest.disposition, `st07-approved-${pending.manifestReference.sha256.slice(7, 19)}`, current.reason, [decisionReference, acceptedReference, currentReference]);
  const plan = reviseReviewPlan(projectDir, inputs.plan, proposal);
  appendAuditEntries(projectDir, recordDir, [
    { event: "GATE_APPROVED", fields: { Stage: "ST-07", Decision: decision.decision, "Review Manifest SHA-256": pending.manifestReference.sha256, "Candidate SHA-256": pending.manifest.runnable_candidate_ref.sha256, "Decision Authority": "human" } },
    { event: "DECISION_RECORDED", fields: { Stage: "ST-07", Decision: decisionReference.sha256, "System Map Revision": String(promotion.systemMap.revision), "Decision Authority": "core" } },
  ]);
  const state = advanceForward(projectDir, recordDir, inputs.state, inputs.plan, plan, current, currentReference, proposal.evidence, at);
  return { decision, decisionReference, acceptedCandidate: accepted, acceptedCandidateReference: acceptedReference, current, currentReference, state };
}
export function approveCandidateReview(projectDir: string, options: CandidateReviewApproveOptions): CandidateReviewApprovalResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => {
    const recordDir = activeVNextIntentRecordDir(root);
    try { return approvalLocked(root, recordDir, options); }
    catch (error) { appendAuditEntry(root, recordDir, "ROUTE_BLOCKED", { Stage: "ST-07", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" }); throw error; }
  });
}

function feedbackLocked(projectDir: string, recordDir: string, options: CandidateReviewFeedbackOptions): CandidateReviewFeedbackResult {
  const inputs = loadInputs(projectDir, recordDir);
  const pending = pendingLocked(projectDir, recordDir);
  if (pending === null) fail("ST-07 Human Review", "no Candidate review is awaiting feedback");
  if (pending.manifestReference.sha256 !== options.manifestSha256) fail("ST-07 Human Review", "feedback SHA-256 does not match the pending Review Manifest");
  const feedbackItems = options.feedbackItems.map((entry, index) => parseReviewFeedbackItem(entry, `ST-07 Feedback[${index}]`));
  const known = new Set(pending.manifest.requirements.map((entry) => entry.requirement_id));
  for (const item of feedbackItems) {
    const unknown = item.requirement_ids.find((entry) => !known.has(entry));
    if (unknown !== undefined) fail("ST-07 Human Review", `Feedback references unknown requirement ${unknown}`);
  }
  const route = selectFeedbackRoute(feedbackItems);
  const checks = validateHumanChecks(pending.manifest, options.humanCheckResults ?? [], false);
  const at = options.decidedAt ?? new Date().toISOString();
  const decision = parseCandidateReviewDecision({ schema_version: 1, artifact: "human-decision", version: 1, decision_id: `feedback-${pending.manifestReference.sha256.slice(7, 19)}`, decision_kind: "candidate-review", intent_id: inputs.state.intent_id, review_manifest_ref: pending.manifestReference, runnable_candidate_ref: pending.manifest.runnable_candidate_ref, decision: "request-changes", human_check_results: checks, feedback_items: feedbackItems, reason: options.reason, decided_by: "human", decided_at: at });
  const decisionReference = writeDecision(projectDir, recordDir, decision);
  const targetIndex = VNEXT_STAGE_IDS.indexOf(route.stage);
  const invalidated = VNEXT_STAGE_IDS.slice(targetIndex, VNEXT_STAGE_IDS.indexOf("ST-07") + 1);
  const feedback = parseFeedbackCurrent({ schema_version: 1, artifact: "feedback-current", version: 1, intent_id: inputs.state.intent_id, review_manifest_ref: pending.manifestReference, human_decision_ref: decisionReference, rejected_candidate_ref: pending.manifest.runnable_candidate_ref, feedback_items: feedbackItems, selected_reason: route.reason, return_stage: route.stage, invalidated_stages: invalidated, reason: options.reason, updated_at: at });
  const feedbackContent = serialize(feedback);
  writeFileAtomic(immutableFeedbackPath(recordDir, pending.manifest.runnable_candidate_ref.sha256), feedbackContent);
  writeFileAtomic(feedbackCurrentPath(recordDir), feedbackContent);
  const feedbackReference = reference(projectDir, immutableFeedbackPath(recordDir, pending.manifest.runnable_candidate_ref.sha256), "feedback-current", feedbackContent);
  const current = parseReviewCurrent({ schema_version: 1, artifact: "review-current", version: 1, intent_id: inputs.state.intent_id, disposition: pending.manifest.disposition, outcome: "feedback", review_manifest_ref: pending.manifestReference, human_decision_ref: decisionReference, accepted_candidate_ref: null, feedback_current_ref: feedbackReference, reason: options.reason, updated_at: at });
  const currentReference = writeReviewCurrent(projectDir, recordDir, current);
  const proposals = invalidated.map((stageId): StageDispositionProposal => ({ schema_version: 1, proposal_id: `feedback-${decision.decision_id}-${stageId.toLowerCase()}`, stage_id: stageId, disposition: "execute", reason: `ST-07 ${route.reason}: ${options.reason}`, evidence: [decisionReference, feedbackReference], proposed_by: "ai" }));
  const plan = reviseStageExecutionPlan(inputs.plan, proposals, { projectDir });
  writeVNextPlanAt(recordDir, plan);
  const graph = loadVNextDefinitions().graph;
  validateCoreRoute(graph, { from: "ST-07", to: route.stage, feedback_reason: route.reason });
  appendAuditEntries(projectDir, recordDir, [
    { event: "GATE_REJECTED", fields: { Stage: "ST-07", Decision: decision.decision, Reason: route.reason, "Review Manifest SHA-256": pending.manifestReference.sha256, "Decision Authority": "human" } },
    { event: "STAGE_REVISING", fields: { Stage: "ST-07", "Return Stage": route.stage, "Invalidated Stages": invalidated.join(","), Feedback: feedbackReference.sha256, "Decision Authority": "core" } },
    { event: "PLAN_REVISED", fields: { "Plan Revision": String(plan.revision), Stage: route.stage, Disposition: "execute", "Decision Authority": "core" } },
    { event: "ROUTE_DECIDED", fields: { "From Stage": "ST-07", "Current Stage": route.stage, Reason: route.reason, Graph: graph.graph_version, "Decision Authority": "core" } },
  ]);
  const returned: VNextIntentState = { ...inputs.state, plan_revision: plan.revision, current_stage: route.stage, status: "parked", parked_reason: `ST-07 feedback requires re-evaluation from ${route.stage}: ${route.reason}.`, updated_at: at };
  writeVNextStateAt(recordDir, returned, plan);
  return { decision, decisionReference, feedback, feedbackReference, current, currentReference, state: readVNextStateAt(recordDir) };
}
export function submitCandidateFeedback(projectDir: string, options: CandidateReviewFeedbackOptions): CandidateReviewFeedbackResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => {
    const recordDir = activeVNextIntentRecordDir(root);
    try { return feedbackLocked(root, recordDir, options); }
    catch (error) { appendAuditEntry(root, recordDir, "ROUTE_BLOCKED", { Stage: "ST-07", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" }); throw error; }
  });
}

export function main(argv: string[]): void {
  const [command, projectDir, ...rest] = argv;
  try {
    if (command === "prepare" && projectDir !== undefined && rest.length === 0) { process.stdout.write(`${JSON.stringify(prepareCandidateReview(projectDir), null, 2)}\n`); return; }
    if (command === "approve" && projectDir !== undefined && rest.length >= 2 && rest.length <= 3) {
      const checks = rest[2] === undefined ? [] : JSON.parse(readFileSync(resolve(rest[2]), "utf8"));
      process.stdout.write(`${JSON.stringify(approveCandidateReview(projectDir, { manifestSha256: rest[0]!, reason: rest[1]!, humanCheckResults: checks }), null, 2)}\n`); return;
    }
    if (command === "feedback" && projectDir !== undefined && rest.length === 3) {
      const feedback = JSON.parse(readFileSync(resolve(rest[1]!), "utf8"));
      if (!Array.isArray(feedback)) fail("ST-07 Human Review", "feedback file must contain an array");
      process.stdout.write(`${JSON.stringify(submitCandidateFeedback(projectDir, { manifestSha256: rest[0]!, feedbackItems: feedback, reason: rest[2]! }), null, 2)}\n`); return;
    }
    console.error("Usage: aidlc review <prepare project-dir | approve project-dir manifest-sha256 reason [human-checks.json] | feedback project-dir manifest-sha256 feedback.json reason>");
    process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

if (import.meta.main) main(process.argv.slice(2));
