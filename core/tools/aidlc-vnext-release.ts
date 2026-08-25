#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendAuditEntries, appendAuditEntry, readOrderedAuditEntries } from "./aidlc-audit.ts";
import {
  loadVNextDefinitions,
  nextForwardStage,
  reviseStageExecutionPlan,
  validateCoreRoute,
} from "./aidlc-core-route.ts";
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
import { parseBuildContract } from "./aidlc-vnext-build-contract-contract.ts";
import {
  parseAcceptedCandidate,
  parseReviewCurrent,
  type AcceptedCandidate,
  type ReviewCurrent,
} from "./aidlc-vnext-review-contract.ts";
import { acceptedCandidatePath, reviewCurrentPath } from "./aidlc-vnext-review.ts";
import {
  humanGateRequirementReferenceAt,
  renderHumanGateRequirementSection,
  resolveHumanGateRequirementsAt,
  validatePolicyAcknowledgements,
  type PolicyAcknowledgement,
} from "./aidlc-vnext-policy-gates.ts";
import {
  parseDeploymentMap,
  parseDeploymentMapBaseline,
  parseReleaseAttempt,
  parseReleaseAuthority,
  parseReleaseCapabilitySnapshot,
  parseReleaseCurrent,
  parseReleasePlan,
  parseReleasePlanProposal,
  parseReleaseReceipt,
  parseReleaseStepReceipt,
  parseReleaseWorkRequest,
  renderReleaseReviewHtml,
  type DeploymentMap,
  type DeploymentMapBaseline,
  type DeploymentMapTarget,
  type ProposedReleaseTarget,
  type ReleaseAttempt,
  type ReleaseAuthority,
  type ReleaseCapabilitySnapshot,
  type ReleaseCurrent,
  type ReleasePlan,
  type ReleasePlanProposal,
  type ReleaseReceipt,
  type ReleaseSourceTarget,
  type ReleaseStep,
  type ReleaseStepReceipt,
  type ReleaseTarget,
  type ReleaseWorkRequest,
} from "./aidlc-vnext-release-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextPlanAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

const STAGE_PATH = resolve(runtimeCoreDir(), "aidlc-common/stages/st-08-release.json");
const GIT_CAPABILITY_ID = "git-remote-source-promote";
const GIT_ADAPTER_ID = "git-remote-ref-v1";

export interface ReleasePrepareOptions { preparedAt?: string }
export interface ReleaseReviewOptions { reviewedAt?: string }
export interface ReleaseAuthorizeOptions { planSha256: string; reason: string; policyAcknowledgements?: PolicyAcknowledgement[]; decidedAt?: string }
export interface ReleaseExecuteOptions { executedAt?: string }
export interface ReleaseReuseOptions { releaseCurrentPath: string; reason: string; reusedAt?: string }

export interface ReleasePrepareResult {
  execution: "prepared" | "reused" | "advanced";
  request: ReleaseWorkRequest | null;
  reference: ArtifactReference | null;
  current: ReleaseCurrent | null;
  currentReference: ArtifactReference | null;
  state: VNextIntentState;
}

export interface ReleaseReviewResult {
  plan: ReleasePlan;
  planReference: ArtifactReference;
  reviewReference: ArtifactReference;
  state: VNextIntentState;
}

export interface ReleaseAuthorizeResult {
  authority: ReleaseAuthority;
  authorityReference: ArtifactReference;
  attempt: ReleaseAttempt;
  attemptReference: ArtifactReference;
  state: VNextIntentState;
}

export interface ReleaseExecuteResult {
  outcome: "released" | "rolled_back" | "blocked";
  receipt: ReleaseReceipt | null;
  receiptReference: ArtifactReference | null;
  current: ReleaseCurrent | null;
  currentReference: ArtifactReference | null;
  state: VNextIntentState;
}

export interface ReleaseReuseResult {
  current: ReleaseCurrent;
  currentReference: ArtifactReference;
  reusedReleaseCurrentReference: ArtifactReference;
  state: VNextIntentState;
}

export interface PendingReleaseReview {
  plan: ReleasePlan;
  planReference: ArtifactReference;
  reviewReference: ArtifactReference;
}

export interface PendingAuthorizedRelease extends PendingReleaseReview {
  authority: ReleaseAuthority;
  authorityReference: ArtifactReference;
  attempt: ReleaseAttempt;
  attemptReference: ArtifactReference;
}

interface ReleaseInputs {
  state: VNextIntentState;
  plan: StageExecutionPlan;
  reviewCurrent: ReviewCurrent;
  reviewCurrentReference: ArtifactReference;
  acceptedCandidate: AcceptedCandidate | null;
  acceptedCandidateReference: ArtifactReference | null;
}

function fail(context: string, message: string): never { throw new Error(`${context}: ${message}`) }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function digest(value: string | Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}` }
function portable(value: string): string { return value.split(sep).join("/") }
function refsEqual(left: ArtifactReference | null, right: ArtifactReference | null): boolean { return JSON.stringify(left) === JSON.stringify(right) }

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
  const root = realpathSync(resolve(projectDir));
  const target = existsSync(path) ? realpathSync(resolve(path)) : resolve(path).replace(resolve(projectDir), root);
  const value = relative(root, target);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) fail("ST-08 Release", `path is outside the Project: ${path}`);
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
  catch (error) { fail("ST-08 Release", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (content !== serialize(value)) fail("ST-08 Release", `artifact is not canonical: ${path}`);
  return { value, content };
}

function runGit(cwd: string, args: string[], context: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) fail("ST-08 Release", `${context}: ${(result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim()}`);
  return result.stdout.trim();
}

function tryGit(cwd: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { ok: result.status === 0, output: (result.stderr || result.stdout || "").trim() };
}

function remoteRevision(repositoryRoot: string, locator: string): string {
  const delimiter = locator.indexOf("#");
  if (delimiter < 1) fail("ST-08 Release", `invalid Git target locator: ${locator}`);
  const remote = locator.slice(0, delimiter);
  const ref = locator.slice(delimiter + 1);
  if (!/^[-A-Za-z0-9._]+$/.test(remote) || !ref.startsWith("refs/heads/") || /[\s\0]/.test(ref)) fail("ST-08 Release", `unsafe Git target locator: ${locator}`);
  const output = runGit(repositoryRoot, ["ls-remote", "--refs", remote, ref], `cannot observe ${locator}`);
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 1) fail("ST-08 Release", `target ${locator} must resolve to exactly one ref`);
  const [revision, observedRef] = lines[0]!.split(/\s+/);
  if (observedRef !== ref || revision === undefined || !/^[a-f0-9]{40,64}$/.test(revision)) fail("ST-08 Release", `target ${locator} returned an invalid revision`);
  return revision;
}

function locatorParts(locator: string): { remote: string; ref: string } {
  const delimiter = locator.indexOf("#");
  const remote = locator.slice(0, delimiter);
  const ref = locator.slice(delimiter + 1);
  if (delimiter < 1 || !/^[-A-Za-z0-9._]+$/.test(remote) || !ref.startsWith("refs/heads/") || /[\s\0]/.test(ref)) fail("ST-08 Release", `unsafe Git target locator: ${locator}`);
  return { remote, ref };
}

export function releaseRootDir(recordDir: string): string { return join(resolve(recordDir), "artifacts", "release") }
export function releaseCapabilitySnapshotPath(recordDir: string): string { return join(releaseRootDir(recordDir), "release-capability-snapshot.json") }
export function releaseWorkRequestPath(recordDir: string): string { return join(releaseRootDir(recordDir), "work-request.json") }
export function releasePlanPath(recordDir: string): string { return join(releaseRootDir(recordDir), "release-plan.json") }
export function releaseHtmlPath(recordDir: string): string { return join(releaseRootDir(recordDir), "review", "release.html") }
export function releaseAuthorityPath(recordDir: string): string { return join(releaseRootDir(recordDir), "review", "release-authority.json") }
export function releaseCurrentPath(recordDir: string): string { return join(releaseRootDir(recordDir), "current.json") }
export function releasePlanRevisionPath(recordDir: string, revision: number): string { return join(releaseRootDir(recordDir), "revisions", revision.toString().padStart(6, "0"), "release-plan.json") }
export function releaseHtmlRevisionPath(recordDir: string, revision: number): string { return join(releaseRootDir(recordDir), "revisions", revision.toString().padStart(6, "0"), "release.html") }
export function releaseAuthorityRevisionPath(recordDir: string, authorityId: string): string { return join(releaseRootDir(recordDir), "decisions", authorityId, "release-authority.json") }
export function releaseAttemptPath(recordDir: string, attempt: number): string { return join(releaseRootDir(recordDir), "attempts", attempt.toString().padStart(6, "0"), "attempt.json") }
export function releaseStepReceiptPath(recordDir: string, attempt: number, stepId: string, rollback = false): string { return join(releaseRootDir(recordDir), "attempts", attempt.toString().padStart(6, "0"), "steps", `${stepId}${rollback ? "-rollback" : ""}.json`) }
export function releaseReceiptPath(recordDir: string, attempt: number): string { return join(releaseRootDir(recordDir), "attempts", attempt.toString().padStart(6, "0"), "release-receipt.json") }
export function deploymentMapRootDir(projectDir: string): string { return join(workspaceRoot(projectDir), "spaces", activeSpace(projectDir), "codekb", "deployment-map") }
export function deploymentMapBaselinePath(projectDir: string): string { return join(deploymentMapRootDir(projectDir), "baseline.json") }
export function deploymentMapRevisionPath(projectDir: string, revision: number): string { return join(deploymentMapRootDir(projectDir), "revisions", revision.toString().padStart(6, "0"), "deployment-map.json") }

export function loadReleaseStageContract(path = STAGE_PATH): VNextStageContract {
  const contract = parseVNextStageContract(JSON.parse(readFileSync(path, "utf8")), "ST-08 Release Stage Contract");
  if (contract.stage_id !== "ST-08" || contract.name !== "Release") fail("ST-08 Contract", "must define ST-08 Release");
  return contract;
}

function loadInputs(projectDir: string, recordDir: string): ReleaseInputs {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-08") fail("ST-08 Release", `current Stage must be ST-08, found ${state.current_stage}`);
  const currentStored = readCanonical(reviewCurrentPath(recordDir), parseReviewCurrent);
  const reviewCurrentReference = reference(projectDir, reviewCurrentPath(recordDir), "review-current", currentStored.content);
  const reviewCurrent = currentStored.value;
  if (reviewCurrent.intent_id !== state.intent_id) fail("ST-08 Release", "Review Current belongs to another Intent");
  if (reviewCurrent.outcome === "not_applicable") return { state, plan, reviewCurrent, reviewCurrentReference, acceptedCandidate: null, acceptedCandidateReference: null };
  if (reviewCurrent.outcome !== "approved" || reviewCurrent.accepted_candidate_ref === null) fail("ST-08 Release", "ST-07 must approve an exact Accepted Candidate");
  verifyProjectArtifactReference(projectDir, reviewCurrent.accepted_candidate_ref);
  const acceptedStored = readCanonical(resolve(projectDir, reviewCurrent.accepted_candidate_ref.source_of_truth), parseAcceptedCandidate);
  const acceptedCandidateReference = reference(projectDir, resolve(projectDir, reviewCurrent.accepted_candidate_ref.source_of_truth), "accepted-candidate", acceptedStored.content);
  if (!refsEqual(acceptedCandidateReference, reviewCurrent.accepted_candidate_ref) || acceptedStored.value.intent_id !== state.intent_id) fail("ST-08 Release", "Accepted Candidate binding differs from Review Current");
  for (const item of [acceptedStored.value.runnable_candidate_ref, acceptedStored.value.review_manifest_ref, acceptedStored.value.approval_ref, acceptedStored.value.requirements_ref, acceptedStored.value.architecture_current_ref, acceptedStored.value.build_contract_ref, acceptedStored.value.system_map_ref]) verifyProjectArtifactReference(projectDir, item);
  return { state, plan, reviewCurrent, reviewCurrentReference, acceptedCandidate: acceptedStored.value, acceptedCandidateReference };
}

function capabilitySnapshot(state: VNextIntentState, at: string): ReleaseCapabilitySnapshot {
  return parseReleaseCapabilitySnapshot({
    schema_version: 1,
    artifact: "release-capability-snapshot",
    version: 1,
    intent_id: state.intent_id,
    effective_policy_ref: state.policy_snapshot,
    capabilities: [{ capability_id: GIT_CAPABILITY_ID, provider: "git", operation: "source-promote", target_kind: "source", adapter_id: GIT_ADAPTER_ID, credential_slots: [], supports_rollback: true }],
    created_at: at,
  });
}

function repositoryRootForSources(projectDir: string, accepted: AcceptedCandidate, sourceIds: string[]): string {
  const contract = readCanonical(resolve(projectDir, accepted.build_contract_ref.source_of_truth), parseBuildContract).value;
  const roots = sourceIds.map((sourceId) => {
    const source = contract.target_sources.find((entry) => entry.source_id === sourceId);
    if (source === undefined) fail("ST-08 Release", `Build Contract has no source ${sourceId}`);
    return resolve(runGit(resolve(projectDir, source.locator), ["rev-parse", "--show-toplevel"], `cannot resolve Repository for ${sourceId}`));
  });
  if (new Set(roots).size !== 1) fail("ST-08 Release", "one accepted source result must bind to exactly one Repository");
  return roots[0]!;
}

function workSourceTargets(projectDir: string, accepted: AcceptedCandidate): ReleaseSourceTarget[] {
  return [...accepted.source_results].sort((left, right) => left.repository_id.localeCompare(right.repository_id)).map((result) => {
    const root = repositoryRootForSources(projectDir, accepted, result.source_ids);
    runGit(root, ["cat-file", "-e", `${result.candidate_revision}^{commit}`], `Candidate revision is unavailable for ${result.repository_id}`);
    const branchRef = runGit(root, ["symbolic-ref", "HEAD"], `cannot identify delivery branch for ${result.repository_id}`);
    const remotes = runGit(root, ["remote"], `cannot list remotes for ${result.repository_id}`).split("\n").filter(Boolean).sort();
    return {
      repository_id: result.repository_id,
      source_ids: [...result.source_ids].sort(),
      source_locators: result.source_ids.map((sourceId) => {
        const contract = readCanonical(resolve(projectDir, accepted.build_contract_ref.source_of_truth), parseBuildContract).value;
        return contract.target_sources.find((entry) => entry.source_id === sourceId)!.locator;
      }).sort(),
      repository_root: projectPath(projectDir, root),
      base_revision: result.base_revision,
      candidate_revision: result.candidate_revision,
      integration_branch: result.integration_branch,
      current_branch_ref: branchRef,
      available_remotes: remotes,
    };
  });
}

function currentDeploymentBaseline(projectDir: string): { baseline: DeploymentMapBaseline; reference: ArtifactReference } | null {
  const path = deploymentMapBaselinePath(projectDir);
  if (!existsSync(path)) return null;
  const stored = readCanonical(path, parseDeploymentMapBaseline);
  const sourcePath = resolve(projectDir, stored.value.source_of_truth);
  const source = readCanonical(sourcePath, parseDeploymentMap);
  const sourceReference = reference(projectDir, sourcePath, "deployment-map", source.content);
  if (stored.value.sha256 !== sourceReference.sha256 || stored.value.revision !== source.value.revision) fail("ST-08 Release", "Deployment Map baseline does not pin its immutable revision");
  return { baseline: stored.value, reference: reference(projectDir, path, "deployment-map-baseline", stored.content) };
}

function stageProposal(disposition: "execute" | "reuse" | "not_applicable", proposalId: string, reason: string, evidence: ArtifactReference[]): StageDispositionProposal {
  return { schema_version: 1, proposal_id: proposalId, stage_id: "ST-08", disposition, reason, evidence, proposed_by: "ai" };
}

function reviseReleasePlan(projectDir: string, plan: StageExecutionPlan, proposal: StageDispositionProposal, deterministic = false): StageExecutionPlan {
  const current = plan.stage_decisions.find((entry) => entry.stage_id === "ST-08");
  if (current?.proposal_ref === proposal.proposal_id && current.disposition === proposal.disposition && JSON.stringify(current.evidence) === JSON.stringify(proposal.evidence)) return plan;
  return reviseStageExecutionPlan(plan, [proposal], { projectDir, stageContracts: [loadReleaseStageContract()], deterministicApplicability: (entry) => deterministic && entry.stage_id === "ST-08" && entry.disposition === "not_applicable" });
}

function advanceToStage09(projectDir: string, recordDir: string, state: VNextIntentState, oldPlan: StageExecutionPlan, plan: StageExecutionPlan, current: ReleaseCurrent, currentReference: ArtifactReference, at: string): VNextIntentState {
  if (plan.revision !== oldPlan.revision) writeVNextPlanAt(recordDir, plan);
  const graph = loadVNextDefinitions().graph;
  const next = nextForwardStage(graph, "ST-08");
  if (next !== "ST-09") fail("ST-08 Release", "fixed Graph must route ST-08 to ST-09");
  validateCoreRoute(graph, { from: "ST-08", to: next });
  if (!readOrderedAuditEntries(recordDir).some((entry) => (entry.event === "STAGE_COMPLETED" || entry.event === "STAGE_SKIPPED") && entry.fields.Stage === "ST-08" && entry.fields["Release Current SHA-256"] === currentReference.sha256)) appendAuditEntries(projectDir, recordDir, [
    ...(plan.revision === oldPlan.revision ? [] : [{ event: "PLAN_REVISED" as const, fields: { "Plan Revision": String(plan.revision), Stage: "ST-08", Disposition: current.disposition, "Decision Authority": "core" } }]),
    { event: current.outcome === "not_applicable" ? "STAGE_SKIPPED" : "STAGE_COMPLETED", fields: { Stage: "ST-08", Outcome: current.outcome, Artifact: currentReference.source_of_truth, "Release Current SHA-256": currentReference.sha256, "Decision Authority": "core" } },
    { event: "ROUTE_DECIDED", fields: { "From Stage": "ST-08", "Current Stage": "ST-09", Graph: graph.graph_version, "Decision Authority": "core" } },
  ]);
  const advanced: VNextIntentState = { ...state, plan_revision: plan.revision, current_stage: "ST-09", status: "parked", parked_reason: "ST-09 Outcome Evaluation is ready to compare promised results with observed Evidence.", updated_at: at };
  writeVNextStateAt(recordDir, advanced, plan);
  return readVNextStateAt(recordDir);
}

function completeNotApplicable(projectDir: string, recordDir: string, inputs: ReleaseInputs, at: string): ReleasePrepareResult {
  const current = parseReleaseCurrent({ schema_version: 1, artifact: "release-current", version: 1, intent_id: inputs.state.intent_id, disposition: "not_applicable", outcome: "not_applicable", review_current_ref: inputs.reviewCurrentReference, accepted_candidate_ref: null, release_plan_ref: null, release_authority_ref: null, release_receipt_ref: null, deployment_map_ref: null, reason: "ST-07 produced no Accepted Candidate, so Release has no permitted external target.", updated_at: at });
  const content = serialize(current);
  writeFileAtomic(releaseCurrentPath(recordDir), content);
  const currentReference = reference(projectDir, releaseCurrentPath(recordDir), "release-current", content);
  const proposal = stageProposal("not_applicable", `st08-no-candidate-${inputs.reviewCurrentReference.sha256.slice(7, 19)}`, current.reason, [inputs.reviewCurrentReference, currentReference]);
  const plan = reviseReleasePlan(projectDir, inputs.plan, proposal, true);
  const state = advanceToStage09(projectDir, recordDir, inputs.state, inputs.plan, plan, current, currentReference, at);
  return { execution: "advanced", request: null, reference: null, current, currentReference, state };
}

function prepareLocked(projectDir: string, recordDir: string, options: ReleasePrepareOptions): ReleasePrepareResult {
  loadReleaseStageContract();
  const inputs = loadInputs(projectDir, recordDir);
  const at = options.preparedAt ?? new Date().toISOString();
  if (inputs.acceptedCandidate === null || inputs.acceptedCandidateReference === null) return completeNotApplicable(projectDir, recordDir, inputs, at);
  verifyProjectArtifactReference(projectDir, inputs.state.policy_snapshot);
  const snapshot = capabilitySnapshot(inputs.state, at);
  const snapshotContent = serialize(snapshot);
  const snapshotPath = releaseCapabilitySnapshotPath(recordDir);
  if (existsSync(snapshotPath)) {
    const existing = readCanonical(snapshotPath, parseReleaseCapabilitySnapshot);
    const comparable = (value: ReleaseCapabilitySnapshot) => ({ ...value, created_at: "" });
    if (JSON.stringify(comparable(existing.value)) !== JSON.stringify(comparable(snapshot))) fail("ST-08 Release", "existing Capability Snapshot differs from the active Policy");
  } else writeFileAtomic(snapshotPath, snapshotContent);
  const snapshotStored = readCanonical(snapshotPath, parseReleaseCapabilitySnapshot);
  const snapshotReference = reference(projectDir, snapshotPath, "release-capability-snapshot", snapshotStored.content);
  const baseline = currentDeploymentBaseline(projectDir);
  const request = parseReleaseWorkRequest({
    schema_version: 1,
    artifact: "release-work-request",
    version: 1,
    intent_id: inputs.state.intent_id,
    stage_id: "ST-08",
    review_current_ref: inputs.reviewCurrentReference,
    accepted_candidate_ref: inputs.acceptedCandidateReference,
    effective_policy_ref: inputs.state.policy_snapshot,
    system_map_ref: inputs.acceptedCandidate.system_map_ref,
    capability_snapshot_ref: snapshotReference,
    deployment_map_baseline_ref: baseline?.reference ?? null,
    source_targets: workSourceTargets(projectDir, inputs.acceptedCandidate),
    requested_output: "release-plan-proposal",
    rules: [
      "Use only a capability_id from the pinned Capability Snapshot.",
      "Do not provide shell commands, credential values, or an alternative Stage route.",
      "Every Accepted Candidate Repository must have exactly one Source promotion target and step.",
      "The Core re-observes every Target before approval and before execution.",
    ],
    created_at: at,
  });
  const requestPath = releaseWorkRequestPath(recordDir);
  if (existsSync(requestPath)) {
    const stored = readCanonical(requestPath, parseReleaseWorkRequest);
    const comparable = (value: ReleaseWorkRequest) => ({ ...value, created_at: "" });
    if (JSON.stringify(comparable(stored.value)) !== JSON.stringify(comparable(request))) fail("ST-08 Release", "existing Work Request differs from the accepted inputs");
    return { execution: "reused", request: stored.value, reference: reference(projectDir, requestPath, "release-work-request", stored.content), current: null, currentReference: null, state: inputs.state };
  }
  const content = serialize(request);
  writeFileAtomic(requestPath, content);
  const requestReference = reference(projectDir, requestPath, "release-work-request", content);
  appendAuditEntry(projectDir, recordDir, "STAGE_STARTED", { Stage: "ST-08", "Work Request SHA-256": requestReference.sha256, "Accepted Candidate SHA-256": inputs.acceptedCandidateReference.sha256, "Decision Authority": "core" });
  return { execution: "prepared", request, reference: requestReference, current: null, currentReference: null, state: inputs.state };
}

export function prepareRelease(projectDir: string, options: ReleasePrepareOptions = {}): ReleasePrepareResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => prepareLocked(root, activeVNextIntentRecordDir(root), options));
}

function reuseLocked(projectDir: string, recordDir: string, options: ReleaseReuseOptions): ReleaseReuseResult {
  const inputs = loadInputs(projectDir, recordDir);
  if (inputs.acceptedCandidate === null || inputs.acceptedCandidateReference === null) fail("ST-08 Release", "Release reuse requires the active Accepted Candidate");
  const sourcePath = resolve(options.releaseCurrentPath);
  projectPath(projectDir, sourcePath);
  const sourceStored = readCanonical(sourcePath, parseReleaseCurrent);
  const reusedReleaseCurrentReference = reference(projectDir, sourcePath, "release-current", sourceStored.content);
  const prior = sourceStored.value;
  if (prior.outcome !== "released" || prior.disposition === "not_applicable" || prior.accepted_candidate_ref === null || prior.release_plan_ref === null || prior.release_authority_ref === null || prior.release_receipt_ref === null || prior.deployment_map_ref === null) fail("ST-08 Release", "only a completed released Current can be reused");
  for (const item of [prior.review_current_ref, prior.accepted_candidate_ref, prior.release_plan_ref, prior.release_authority_ref, prior.release_receipt_ref, prior.deployment_map_ref]) verifyProjectArtifactReference(projectDir, item);
  const priorAccepted = readCanonical(resolve(projectDir, prior.accepted_candidate_ref.source_of_truth), parseAcceptedCandidate).value;
  const priorPlan = readCanonical(resolve(projectDir, prior.release_plan_ref.source_of_truth), parseReleasePlan).value;
  const priorAuthority = readCanonical(resolve(projectDir, prior.release_authority_ref.source_of_truth), parseReleaseAuthority).value;
  const priorReceipt = readCanonical(resolve(projectDir, prior.release_receipt_ref.source_of_truth), parseReleaseReceipt).value;
  const priorDeployment = readCanonical(resolve(projectDir, prior.deployment_map_ref.source_of_truth), parseDeploymentMap).value;
  if (JSON.stringify(priorAccepted.source_results) !== JSON.stringify(inputs.acceptedCandidate.source_results)) fail("ST-08 Release", "reused Release belongs to a different Accepted Candidate source result");
  if (priorPlan.effective_policy_ref.sha256 !== inputs.state.policy_snapshot.sha256) fail("ST-08 Release", "reused Release was authorized under a different Effective Policy");
  if (!refsEqual(priorAuthority.release_plan_ref, prior.release_plan_ref) || !refsEqual(priorReceipt.release_plan_ref, prior.release_plan_ref) || !refsEqual(priorReceipt.authority_ref, prior.release_authority_ref) || !refsEqual(priorReceipt.accepted_candidate_ref, prior.accepted_candidate_ref)) fail("ST-08 Release", "reused Plan, Authority, Receipt, and Candidate are not one exact chain");
  const receiptStates = new Map(priorReceipt.target_states.map((entry) => [entry.target_id, entry.observed_state]));
  for (const target of priorPlan.targets) {
    const sourceResult = inputs.acceptedCandidate.source_results.find((entry) => entry.repository_id === target.repository_id);
    const step = priorPlan.steps.find((entry) => entry.target_id === target.target_id);
    if (sourceResult === undefined || step === undefined || step.desired_state !== sourceResult.candidate_revision || receiptStates.get(target.target_id) !== step.desired_state) fail("ST-08 Release", `reused Target ${target.target_id} does not represent the active Candidate revision`);
    const repositoryRoot = repositoryRootForSources(projectDir, inputs.acceptedCandidate, sourceResult.source_ids);
    if (remoteRevision(repositoryRoot, target.locator) !== step.desired_state) fail("ST-08 Release", `reused Target ${target.target_id} no longer matches its released state`);
  }
  const mapped = priorDeployment.targets.filter((entry) => refsEqual(entry.release_receipt_ref, prior.release_receipt_ref));
  if (mapped.length !== priorPlan.targets.length || mapped.some((entry) => ![...receiptStates.values()].includes(entry.observed_state))) fail("ST-08 Release", "reused Deployment Map does not reflect the exact Receipt");
  const at = options.reusedAt ?? new Date().toISOString();
  const current = parseReleaseCurrent({ schema_version: 1, artifact: "release-current", version: 1, intent_id: inputs.state.intent_id, disposition: "reuse", outcome: "released", review_current_ref: inputs.reviewCurrentReference, accepted_candidate_ref: inputs.acceptedCandidateReference, release_plan_ref: prior.release_plan_ref, release_authority_ref: prior.release_authority_ref, release_receipt_ref: prior.release_receipt_ref, deployment_map_ref: prior.deployment_map_ref, reason: options.reason, updated_at: at });
  const currentContent = serialize(current);
  writeFileAtomic(releaseCurrentPath(recordDir), currentContent);
  const currentReference = reference(projectDir, releaseCurrentPath(recordDir), "release-current", currentContent);
  const proposal = stageProposal("reuse", `st08-reuse-${reusedReleaseCurrentReference.sha256.slice(7, 19)}`, options.reason, [reusedReleaseCurrentReference, inputs.acceptedCandidateReference, prior.release_plan_ref, prior.release_authority_ref, prior.release_receipt_ref, prior.deployment_map_ref, currentReference]);
  const plan = reviseReleasePlan(projectDir, inputs.plan, proposal);
  const state = advanceToStage09(projectDir, recordDir, inputs.state, inputs.plan, plan, current, currentReference, at);
  return { current, currentReference, reusedReleaseCurrentReference, state };
}

export function reuseRelease(projectDir: string, options: ReleaseReuseOptions): ReleaseReuseResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => reuseLocked(root, activeVNextIntentRecordDir(root), options));
}

function validateProposalAgainstRequest(projectDir: string, request: ReleaseWorkRequest, proposal: ReleasePlanProposal, at: string): { targets: ReleaseTarget[]; steps: ReleaseStep[] } {
  if (proposal.intent_id !== request.intent_id || proposal.work_request_sha256 !== reference(projectDir, releaseWorkRequestPath(activeVNextIntentRecordDir(projectDir)), "release-work-request").sha256) fail("ST-08 Release", "proposal does not bind the exact Work Request");
  if (proposal.targets.length !== request.source_targets.length || proposal.steps.length !== request.source_targets.length) fail("ST-08 Release", "each Accepted Candidate Repository requires exactly one Target and one Step");
  const capability = readCanonical(resolve(projectDir, request.capability_snapshot_ref.source_of_truth), parseReleaseCapabilitySnapshot).value.capabilities.find((entry) => entry.capability_id === GIT_CAPABILITY_ID);
  if (capability?.adapter_id !== GIT_ADAPTER_ID) fail("ST-08 Release", "the initial registered Git capability is unavailable");
  const targets: ReleaseTarget[] = [];
  const targetIds = new Set<string>();
  for (const proposed of proposal.targets) {
    if (proposed.target_kind !== "source" || proposed.provider !== "git" || proposed.capability_id !== GIT_CAPABILITY_ID || proposed.repository_id === null || proposed.environment !== null) fail("ST-08 Release", "initial Release supports only the registered Git Source promotion capability");
    const source = request.source_targets.find((entry) => entry.repository_id === proposed.repository_id);
    if (source === undefined || targetIds.has(proposed.target_id)) fail("ST-08 Release", `Target ${proposed.target_id} has no unique Accepted Candidate Repository`);
    const { remote, ref } = locatorParts(proposed.locator);
    if (!source.available_remotes.includes(remote) || ref !== source.current_branch_ref) fail("ST-08 Release", `Target ${proposed.target_id} is outside the observed Repository delivery ref`);
    const observed = remoteRevision(resolve(projectDir, source.repository_root), proposed.locator);
    if (observed !== source.base_revision) fail("ST-08 Release", `Target ${proposed.target_id} no longer matches the Accepted Candidate base revision`);
    targets.push({ ...proposed, observed_before: observed, observed_at: at });
    targetIds.add(proposed.target_id);
  }
  for (const step of proposal.steps) {
    const target = targets.find((entry) => entry.target_id === step.target_id);
    const source = request.source_targets.find((entry) => entry.repository_id === target?.repository_id);
    if (target === undefined || source === undefined || step.operation !== "source-promote" || step.capability_id !== target.capability_id || step.desired_state !== source.candidate_revision || step.rollback_mode !== "automatic") fail("ST-08 Release", `Step ${step.step_id} is not the exact registered Source promotion`);
  }
  return { targets, steps: proposal.steps };
}

function nextReleasePlanRevision(recordDir: string): number {
  const root = join(releaseRootDir(recordDir), "revisions");
  if (!existsSync(root)) return 1;
  return Math.max(0, ...readdirSync(root).filter((entry) => /^\d{6}$/.test(entry)).map(Number)) + 1;
}

function reviewLocked(projectDir: string, recordDir: string, proposalValue: ReleasePlanProposal, options: ReleaseReviewOptions): ReleaseReviewResult {
  const inputs = loadInputs(projectDir, recordDir);
  if (inputs.acceptedCandidate === null || inputs.acceptedCandidateReference === null) fail("ST-08 Release", "no Accepted Candidate can be planned for Release");
  const requestStored = readCanonical(releaseWorkRequestPath(recordDir), parseReleaseWorkRequest);
  const requestReference = reference(projectDir, releaseWorkRequestPath(recordDir), "release-work-request", requestStored.content);
  const proposal = parseReleasePlanProposal(proposalValue);
  const at = options.reviewedAt ?? new Date().toISOString();
  const checked = validateProposalAgainstRequest(projectDir, requestStored.value, proposal, at);
  const revision = nextReleasePlanRevision(recordDir);
  const plan = parseReleasePlan({ schema_version: 1, artifact: "release-plan", version: 1, revision, intent_id: inputs.state.intent_id, stage_id: "ST-08", disposition: "execute", work_request_ref: requestReference, review_current_ref: inputs.reviewCurrentReference, accepted_candidate_ref: inputs.acceptedCandidateReference, effective_policy_ref: inputs.state.policy_snapshot, capability_snapshot_ref: requestStored.value.capability_snapshot_ref, targets: checked.targets, steps: checked.steps, release_notes: proposal.release_notes, reason: proposal.reason, created_at: at });
  const content = serialize(plan);
  const immutablePath = releasePlanRevisionPath(recordDir, revision);
  writeFileAtomic(immutablePath, content);
  writeFileAtomic(releasePlanPath(recordDir), content);
  const planReference = reference(projectDir, immutablePath, "release-plan", content);
  const gate = resolveHumanGateRequirementsAt(projectDir, recordDir, "ST-08", plan.effective_policy_ref, { createdAt: at });
  const html = renderReleaseReviewHtml(plan, renderHumanGateRequirementSection(gate));
  writeFileAtomic(releaseHtmlRevisionPath(recordDir, revision), html);
  writeFileAtomic(releaseHtmlPath(recordDir), html);
  const reviewReference = reference(projectDir, releaseHtmlRevisionPath(recordDir, revision), "release-html", html);
  const stage = stageProposal("execute", proposal.proposal_id, proposal.reason, [requestReference, planReference, reviewReference]);
  const revised = reviseReleasePlan(projectDir, inputs.plan, stage);
  if (revised.revision !== inputs.plan.revision) writeVNextPlanAt(recordDir, revised);
  const parked = { ...inputs.state, plan_revision: revised.revision, status: "parked" as const, parked_reason: "Release Plan requires explicit human authority before any external operation.", updated_at: at };
  writeVNextStateAt(recordDir, parked, revised);
  appendAuditEntries(projectDir, recordDir, [
    ...(revised.revision === inputs.plan.revision ? [] : [{ event: "PLAN_REVISED" as const, fields: { "Plan Revision": String(revised.revision), Stage: "ST-08", Disposition: "execute", "Decision Authority": "core" } }]),
    { event: "STAGE_AWAITING_APPROVAL", fields: { Stage: "ST-08", "Release Plan SHA-256": planReference.sha256, Review: reviewReference.source_of_truth, "Decision Authority": "human" } },
  ]);
  return { plan, planReference, reviewReference, state: readVNextStateAt(recordDir) };
}

export function reviewReleasePlan(projectDir: string, proposal: ReleasePlanProposal, options: ReleaseReviewOptions = {}): ReleaseReviewResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => reviewLocked(root, activeVNextIntentRecordDir(root), proposal, options));
}

function pendingReviewLocked(projectDir: string, recordDir: string): PendingReleaseReview | null {
  if (!existsSync(releasePlanPath(recordDir)) && !existsSync(releaseHtmlPath(recordDir))) return null;
  if (!existsSync(releasePlanPath(recordDir)) || !existsSync(releaseHtmlPath(recordDir))) fail("ST-08 Release", "Release Plan and Review HTML must exist together");
  const stored = readCanonical(releasePlanPath(recordDir), parseReleasePlan);
  const immutable = releasePlanRevisionPath(recordDir, stored.value.revision);
  if (!existsSync(immutable) || readFileSync(immutable, "utf8") !== stored.content) fail("ST-08 Release", "immutable Release Plan is missing or differs");
  const gate = resolveHumanGateRequirementsAt(projectDir, recordDir, "ST-08", stored.value.effective_policy_ref);
  const html = renderReleaseReviewHtml(stored.value, renderHumanGateRequirementSection(gate));
  if (readFileSync(releaseHtmlPath(recordDir), "utf8") !== html || readFileSync(releaseHtmlRevisionPath(recordDir, stored.value.revision), "utf8") !== html) fail("ST-08 Release", "Release Review HTML differs from its exact Plan");
  return { plan: stored.value, planReference: reference(projectDir, immutable, "release-plan", stored.content), reviewReference: reference(projectDir, releaseHtmlRevisionPath(recordDir, stored.value.revision), "release-html", html) };
}

export function pendingReleaseReview(projectDir: string): PendingReleaseReview | null {
  const root = resolve(projectDir);
  const recordDir = activeVNextIntentRecordDir(root);
  if (readVNextStateAt(recordDir).current_stage !== "ST-08") return null;
  return pendingReviewLocked(root, recordDir);
}

function nextAttempt(recordDir: string): number {
  const root = join(releaseRootDir(recordDir), "attempts");
  if (!existsSync(root)) return 1;
  return Math.max(0, ...readdirSync(root).filter((entry) => /^\d{6}$/.test(entry)).map(Number)) + 1;
}

function authorizeLocked(projectDir: string, recordDir: string, options: ReleaseAuthorizeOptions): ReleaseAuthorizeResult {
  const inputs = loadInputs(projectDir, recordDir);
  const pending = pendingReviewLocked(projectDir, recordDir);
  if (pending === null || inputs.acceptedCandidateReference === null) fail("ST-08 Release", "no Release Plan is awaiting authority");
  if (pending.planReference.sha256 !== options.planSha256) fail("ST-08 Release", "authority SHA-256 does not match the pending Release Plan");
  const baseline = currentDeploymentBaseline(projectDir);
  const request = readCanonical(resolve(projectDir, pending.plan.work_request_ref.source_of_truth), parseReleaseWorkRequest).value;
  if (!refsEqual(request.deployment_map_baseline_ref, baseline?.reference ?? null)) fail("ST-08 Release", "Deployment Map baseline changed before authority");
  for (const target of pending.plan.targets) {
    const source = request.source_targets.find((entry) => entry.repository_id === target.repository_id);
    if (source === undefined || remoteRevision(resolve(projectDir, source.repository_root), target.locator) !== target.observed_before) fail("ST-08 Release", `Target ${target.target_id} changed before authority`);
  }
  const at = options.decidedAt ?? new Date().toISOString();
  const gate = resolveHumanGateRequirementsAt(projectDir, recordDir, "ST-08", pending.plan.effective_policy_ref, { createdAt: at });
  const acknowledgements = validatePolicyAcknowledgements(gate, options.policyAcknowledgements ?? [], { projectDir, recordDir, requireCurrentRiskRegister: true });
  const gateReference = humanGateRequirementReferenceAt(projectDir, recordDir, gate);
  const authority = parseReleaseAuthority({ schema_version: 1, artifact: "release-authority", version: 1, authority_id: `release-authority-${pending.planReference.sha256.slice(7, 19)}`, intent_id: inputs.state.intent_id, release_plan_ref: pending.planReference, accepted_candidate_ref: inputs.acceptedCandidateReference, gate_requirement_set_ref: gateReference, policy_acknowledgements: acknowledgements, decision: "authorize-release", reason: options.reason, decided_by: "human", decided_at: at });
  const content = serialize(authority);
  const immutable = releaseAuthorityRevisionPath(recordDir, authority.authority_id);
  if (existsSync(immutable) && readFileSync(immutable, "utf8") !== content) fail("ST-08 Release", "immutable Release Authority differs");
  if (!existsSync(immutable)) writeFileAtomic(immutable, content);
  writeFileAtomic(releaseAuthorityPath(recordDir), content);
  const authorityReference = reference(projectDir, immutable, "release-authority", content);
  const attemptNumber = nextAttempt(recordDir);
  const attempt = parseReleaseAttempt({ schema_version: 1, artifact: "release-attempt", version: 1, intent_id: inputs.state.intent_id, attempt: attemptNumber, status: "active", release_plan_ref: pending.planReference, authority_ref: authorityReference, step_receipt_refs: [], failure: null, started_at: at, updated_at: at });
  const attemptContent = serialize(attempt);
  writeFileAtomic(releaseAttemptPath(recordDir, attemptNumber), attemptContent);
  const attemptReference = reference(projectDir, releaseAttemptPath(recordDir, attemptNumber), "release-attempt", attemptContent);
  const parked: VNextIntentState = { ...inputs.state, status: "parked", parked_reason: "Release is authorized. Run the explicit Release execute action to perform external operations.", updated_at: at };
  writeVNextStateAt(recordDir, parked, inputs.plan);
  appendAuditEntries(projectDir, recordDir, [
    { event: "GATE_APPROVED", fields: { Stage: "ST-08", Decision: authorityReference.sha256, "Release Plan SHA-256": pending.planReference.sha256, "Decision Authority": "human" } },
    { event: "DECISION_RECORDED", fields: { Stage: "ST-08", Attempt: String(attemptNumber), Authority: authorityReference.sha256, "Decision Authority": "core" } },
  ]);
  return { authority, authorityReference, attempt, attemptReference, state: readVNextStateAt(recordDir) };
}

export function authorizeRelease(projectDir: string, options: ReleaseAuthorizeOptions): ReleaseAuthorizeResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => authorizeLocked(root, activeVNextIntentRecordDir(root), options));
}

function pendingAuthorizedLocked(projectDir: string, recordDir: string): PendingAuthorizedRelease | null {
  if (!existsSync(releaseAuthorityPath(recordDir))) return null;
  const pending = pendingReviewLocked(projectDir, recordDir);
  if (pending === null) fail("ST-08 Release", "authority exists without a Release Plan");
  const authorityStored = readCanonical(releaseAuthorityPath(recordDir), parseReleaseAuthority);
  const immutable = releaseAuthorityRevisionPath(recordDir, authorityStored.value.authority_id);
  if (!existsSync(immutable) || readFileSync(immutable, "utf8") !== authorityStored.content) fail("ST-08 Release", "immutable Release Authority is missing or differs");
  const authorityReference = reference(projectDir, immutable, "release-authority", authorityStored.content);
  if (!refsEqual(authorityStored.value.release_plan_ref, pending.planReference)) fail("ST-08 Release", "authority does not bind the pending Release Plan");
  const attemptsRoot = join(releaseRootDir(recordDir), "attempts");
  const attempts = existsSync(attemptsRoot) ? readdirSync(attemptsRoot).filter((entry) => /^\d{6}$/.test(entry)).map(Number).sort((a, b) => b - a) : [];
  const active = attempts.map((attempt) => readCanonical(releaseAttemptPath(recordDir, attempt), parseReleaseAttempt)).find((entry) => entry.value.status === "active" && refsEqual(entry.value.authority_ref, authorityReference));
  if (active === undefined) fail("ST-08 Release", "authority has no active Release Attempt");
  return { ...pending, authority: authorityStored.value, authorityReference, attempt: active.value, attemptReference: reference(projectDir, releaseAttemptPath(recordDir, active.value.attempt), "release-attempt", active.content) };
}

export function pendingAuthorizedRelease(projectDir: string): PendingAuthorizedRelease | null {
  const root = resolve(projectDir);
  const recordDir = activeVNextIntentRecordDir(root);
  if (readVNextStateAt(recordDir).current_stage !== "ST-08") return null;
  return pendingAuthorizedLocked(root, recordDir);
}

function orderedSteps(steps: ReleaseStep[]): ReleaseStep[] {
  const pending = new Map(steps.map((entry) => [entry.step_id, entry]));
  const completed = new Set<string>();
  const result: ReleaseStep[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((entry) => entry.depends_on.every((dependency) => completed.has(dependency))).sort((left, right) => left.step_id.localeCompare(right.step_id));
    if (ready.length === 0) fail("ST-08 Release", "Release Plan has no deterministic ready Step");
    const selected = ready[0]!;
    pending.delete(selected.step_id);
    completed.add(selected.step_id);
    result.push(selected);
  }
  return result;
}

function writeStepReceipt(projectDir: string, recordDir: string, receipt: ReleaseStepReceipt, rollback = false): ArtifactReference {
  const path = releaseStepReceiptPath(recordDir, receipt.attempt, receipt.step_id, rollback);
  const content = serialize(receipt);
  if (existsSync(path) && readFileSync(path, "utf8") !== content) fail("ST-08 Release", `immutable Step Receipt differs: ${receipt.step_id}`);
  if (!existsSync(path)) writeFileAtomic(path, content);
  return reference(projectDir, path, "release-step-receipt", content);
}

function writeAttempt(recordDir: string, attempt: ReleaseAttempt): void { writeFileAtomic(releaseAttemptPath(recordDir, attempt.attempt), serialize(parseReleaseAttempt(attempt))) }

function blockAttempt(projectDir: string, recordDir: string, pending: PendingAuthorizedRelease, reason: string, at: string, refs: ArtifactReference[]): ReleaseExecuteResult {
  const attempt = parseReleaseAttempt({ ...pending.attempt, status: "blocked", step_receipt_refs: refs, failure: reason, updated_at: at });
  writeAttempt(recordDir, attempt);
  if (existsSync(releaseAuthorityPath(recordDir))) unlinkSync(releaseAuthorityPath(recordDir));
  const state: VNextIntentState = { ...readVNextStateAt(recordDir), status: "parked", parked_reason: `Release blocked before a completed external outcome: ${reason}`, updated_at: at };
  writeVNextStateAt(recordDir, state, readVNextPlanAt(recordDir));
  appendAuditEntry(projectDir, recordDir, "ROUTE_BLOCKED", { Stage: "ST-08", Attempt: String(attempt.attempt), Reason: reason.replace(/[\r\n]+/g, " "), "Decision Authority": "core" });
  return { outcome: "blocked", receipt: null, receiptReference: null, current: null, currentReference: null, state: readVNextStateAt(recordDir) };
}

function deploymentTargetId(target: ReleaseTarget): string {
  return `deployment-${createHash("sha256").update(`${target.target_kind}\0${target.provider}\0${target.repository_id ?? ""}\0${target.locator}\0${target.environment ?? ""}`).digest("hex").slice(0, 16)}`;
}

function promoteDeploymentMap(projectDir: string, request: ReleaseWorkRequest, plan: ReleasePlan, receipt: ReleaseReceipt, receiptReference: ArtifactReference, at: string): { map: DeploymentMap; reference: ArtifactReference } {
  const baseline = currentDeploymentBaseline(projectDir);
  if (!refsEqual(request.deployment_map_baseline_ref, baseline?.reference ?? null)) fail("ST-08 Release", "Deployment Map changed concurrently; automatic overwrite is prohibited");
  const prior = baseline === null ? null : readCanonical(resolve(projectDir, baseline.baseline.source_of_truth), parseDeploymentMap).value;
  const states = new Map(receipt.target_states.map((entry) => [entry.target_id, entry.observed_state]));
  const updates: DeploymentMapTarget[] = plan.targets.map((target) => ({ target_id: deploymentTargetId(target), target_kind: target.target_kind, provider: target.provider, locator: target.locator, environment: target.environment, observed_state: states.get(target.target_id)!, observed_at: at, release_receipt_ref: receiptReference }));
  const ids = new Set(updates.map((entry) => entry.target_id));
  const map = parseDeploymentMap({ schema_version: 1, artifact: "deployment-map", version: 1, map_id: "default-deployment", revision: (prior?.revision ?? 0) + 1, base_revision: prior?.revision ?? null, targets: [...(prior?.targets.filter((entry) => !ids.has(entry.target_id)) ?? []), ...updates].sort((left, right) => left.target_id.localeCompare(right.target_id)), updated_at: at });
  const content = serialize(map);
  const path = deploymentMapRevisionPath(projectDir, map.revision);
  writeFileAtomic(path, content);
  const mapReference = reference(projectDir, path, "deployment-map", content);
  const baselineValue = parseDeploymentMapBaseline({ schema_version: 1, artifact: "deployment-map-baseline", version: 1, map_id: "default-deployment", revision: map.revision, source_of_truth: mapReference.source_of_truth, sha256: mapReference.sha256, updated_at: at });
  writeFileAtomic(deploymentMapBaselinePath(projectDir), serialize(baselineValue));
  return { map, reference: mapReference };
}

function finalizeRelease(projectDir: string, recordDir: string, inputs: ReleaseInputs, pending: PendingAuthorizedRelease, outcome: "released" | "rolled_back", receiptRefs: ArtifactReference[], targetStates: Array<{ target_id: string; observed_state: string }>, at: string): ReleaseExecuteResult {
  if (inputs.acceptedCandidateReference === null) fail("ST-08 Release", "final Release requires an Accepted Candidate");
  const receipt = parseReleaseReceipt({ schema_version: 1, artifact: "release-receipt", version: 1, intent_id: inputs.state.intent_id, attempt: pending.attempt.attempt, outcome, release_plan_ref: pending.planReference, authority_ref: pending.authorityReference, accepted_candidate_ref: inputs.acceptedCandidateReference, step_receipt_refs: receiptRefs, target_states: targetStates, completed_at: at });
  const receiptContent = serialize(receipt);
  writeFileAtomic(releaseReceiptPath(recordDir, pending.attempt.attempt), receiptContent);
  const receiptReference = reference(projectDir, releaseReceiptPath(recordDir, pending.attempt.attempt), "release-receipt", receiptContent);
  const request = readCanonical(resolve(projectDir, pending.plan.work_request_ref.source_of_truth), parseReleaseWorkRequest).value;
  const deployment = promoteDeploymentMap(projectDir, request, pending.plan, receipt, receiptReference, at);
  const attempt = parseReleaseAttempt({ ...pending.attempt, status: outcome === "released" ? "succeeded" : "rolled_back", step_receipt_refs: receiptRefs, failure: outcome === "released" ? null : "A later Release Step failed; all completed external changes were rolled back.", updated_at: at });
  writeAttempt(recordDir, attempt);
  const current = parseReleaseCurrent({ schema_version: 1, artifact: "release-current", version: 1, intent_id: inputs.state.intent_id, disposition: "execute", outcome, review_current_ref: inputs.reviewCurrentReference, accepted_candidate_ref: inputs.acceptedCandidateReference, release_plan_ref: pending.planReference, release_authority_ref: pending.authorityReference, release_receipt_ref: receiptReference, deployment_map_ref: deployment.reference, reason: outcome === "released" ? "All authorized Release Steps reached their approved Target state." : "A later Release Step failed and all completed external operations were returned to their observed pre-release state.", updated_at: at });
  const currentContent = serialize(current);
  writeFileAtomic(releaseCurrentPath(recordDir), currentContent);
  const currentReference = reference(projectDir, releaseCurrentPath(recordDir), "release-current", currentContent);
  const proposal = stageProposal("execute", `st08-release-${pending.planReference.sha256.slice(7, 19)}`, current.reason, [pending.planReference, pending.authorityReference, receiptReference, deployment.reference, currentReference]);
  const plan = reviseReleasePlan(projectDir, inputs.plan, proposal);
  const state = advanceToStage09(projectDir, recordDir, inputs.state, inputs.plan, plan, current, currentReference, at);
  return { outcome, receipt, receiptReference, current, currentReference, state };
}

function executeLocked(projectDir: string, recordDir: string, options: ReleaseExecuteOptions): ReleaseExecuteResult {
  const inputs = loadInputs(projectDir, recordDir);
  const pending = pendingAuthorizedLocked(projectDir, recordDir);
  if (pending === null) fail("ST-08 Release", "an exact human Release Authority is required");
  const at = options.executedAt ?? new Date().toISOString();
  const request = readCanonical(resolve(projectDir, pending.plan.work_request_ref.source_of_truth), parseReleaseWorkRequest).value;
  const baseline = currentDeploymentBaseline(projectDir);
  if (!refsEqual(request.deployment_map_baseline_ref, baseline?.reference ?? null)) return blockAttempt(projectDir, recordDir, pending, "Deployment Map baseline changed after authority", at, []);
  for (const target of pending.plan.targets) {
    const source = request.source_targets.find((entry) => entry.repository_id === target.repository_id);
    if (source === undefined) return blockAttempt(projectDir, recordDir, pending, `Target ${target.target_id} lost its Repository binding`, at, []);
    let observed: string;
    try { observed = remoteRevision(resolve(projectDir, source.repository_root), target.locator); }
    catch (error) { return blockAttempt(projectDir, recordDir, pending, error instanceof Error ? error.message : String(error), at, []); }
    if (observed !== target.observed_before) return blockAttempt(projectDir, recordDir, pending, `Target ${target.target_id} drifted after authority`, at, []);
  }

  const receiptRefs: ArtifactReference[] = [];
  const succeeded: Array<{ step: ReleaseStep; target: ReleaseTarget; repositoryRoot: string }> = [];
  for (const step of orderedSteps(pending.plan.steps)) {
    const target = pending.plan.targets.find((entry) => entry.target_id === step.target_id)!;
    const source = request.source_targets.find((entry) => entry.repository_id === target.repository_id)!;
    const repositoryRoot = resolve(projectDir, source.repository_root);
    const before = remoteRevision(repositoryRoot, target.locator);
    const { remote, ref } = locatorParts(target.locator);
    let outcome: ReleaseStepReceipt["outcome"] = "succeeded";
    let operationId: string | null = null;
    let detail = "Registered Git Source promotion reached the approved revision.";
    if (before === step.desired_state) {
      outcome = "recovered";
      detail = "Target already matched the approved revision; no duplicate external operation was sent.";
    } else {
      const pushed = tryGit(repositoryRoot, ["push", "--porcelain", remote, `${step.desired_state}:${ref}`]);
      if (!pushed.ok) {
        const afterFailure = remoteRevision(repositoryRoot, target.locator);
        const failed = parseReleaseStepReceipt({ schema_version: 1, artifact: "release-step-receipt", version: 1, intent_id: inputs.state.intent_id, attempt: pending.attempt.attempt, step_id: step.step_id, target_id: target.target_id, capability_id: step.capability_id, idempotency_key: digest(`${pending.planReference.sha256}\0${step.step_id}\0${step.desired_state}`), outcome: "failed", before_state: before, after_state: afterFailure, external_operation_id: null, detail: `Registered Git Source promotion failed: ${pushed.output || "remote rejected the update"}`.replace(/[\r\n]+/g, " ").slice(0, 500), executed_at: at });
        receiptRefs.push(writeStepReceipt(projectDir, recordDir, failed));
        if (succeeded.length === 0) return blockAttempt(projectDir, recordDir, pending, `Step ${step.step_id} failed before any completed promotion`, at, receiptRefs);
        let rollbackFailed = false;
        for (const completed of [...succeeded].reverse()) {
          const parts = locatorParts(completed.target.locator);
          const current = remoteRevision(completed.repositoryRoot, completed.target.locator);
          const rollback = tryGit(completed.repositoryRoot, ["push", "--porcelain", `--force-with-lease=${parts.ref}:${completed.step.desired_state}`, parts.remote, `${completed.target.observed_before}:${parts.ref}`]);
          const after = remoteRevision(completed.repositoryRoot, completed.target.locator);
          const ok = rollback.ok && after === completed.target.observed_before;
          const rollbackReceipt = parseReleaseStepReceipt({ schema_version: 1, artifact: "release-step-receipt", version: 1, intent_id: inputs.state.intent_id, attempt: pending.attempt.attempt, step_id: completed.step.step_id, target_id: completed.target.target_id, capability_id: completed.step.capability_id, idempotency_key: digest(`${pending.planReference.sha256}\0rollback\0${completed.step.step_id}\0${completed.target.observed_before}`), outcome: ok ? "rolled_back" : "rollback_failed", before_state: current, after_state: after, external_operation_id: ok ? `git:${completed.target.locator}@${completed.target.observed_before}` : null, detail: ok ? "Completed promotion returned to its authority-time observed state." : `Rollback could not restore the observed state: ${rollback.output}`.replace(/[\r\n]+/g, " ").slice(0, 500), executed_at: at });
          receiptRefs.push(writeStepReceipt(projectDir, recordDir, rollbackReceipt, true));
          if (!ok) rollbackFailed = true;
        }
        if (rollbackFailed) return blockAttempt(projectDir, recordDir, pending, "one or more rollback operations could not restore the observed Target state", at, receiptRefs);
        const targetStates = pending.plan.targets.map((entry) => ({ target_id: entry.target_id, observed_state: remoteRevision(resolve(projectDir, request.source_targets.find((sourceEntry) => sourceEntry.repository_id === entry.repository_id)!.repository_root), entry.locator) }));
        return finalizeRelease(projectDir, recordDir, inputs, pending, "rolled_back", receiptRefs, targetStates, at);
      }
      operationId = `git:${target.locator}@${step.desired_state}`;
    }
    const after = remoteRevision(repositoryRoot, target.locator);
    if (after !== step.desired_state) return blockAttempt(projectDir, recordDir, pending, `Step ${step.step_id} post-release verification did not reach the approved revision`, at, receiptRefs);
    const receipt = parseReleaseStepReceipt({ schema_version: 1, artifact: "release-step-receipt", version: 1, intent_id: inputs.state.intent_id, attempt: pending.attempt.attempt, step_id: step.step_id, target_id: target.target_id, capability_id: step.capability_id, idempotency_key: digest(`${pending.planReference.sha256}\0${step.step_id}\0${step.desired_state}`), outcome, before_state: before, after_state: after, external_operation_id: operationId, detail, executed_at: at });
    receiptRefs.push(writeStepReceipt(projectDir, recordDir, receipt));
    succeeded.push({ step, target, repositoryRoot });
    writeAttempt(recordDir, parseReleaseAttempt({ ...pending.attempt, step_receipt_refs: receiptRefs, updated_at: at }));
  }
  const targetStates = pending.plan.targets.map((entry) => ({ target_id: entry.target_id, observed_state: remoteRevision(resolve(projectDir, request.source_targets.find((sourceEntry) => sourceEntry.repository_id === entry.repository_id)!.repository_root), entry.locator) }));
  return finalizeRelease(projectDir, recordDir, inputs, pending, "released", receiptRefs, targetStates, at);
}

export function executeRelease(projectDir: string, options: ReleaseExecuteOptions = {}): ReleaseExecuteResult {
  const root = resolve(projectDir);
  return withWorkspaceLock(root, () => executeLocked(root, activeVNextIntentRecordDir(root), options));
}

export function main(argv: string[]): void {
  const [command, projectDir, ...rest] = argv;
  try {
    if (command === "prepare" && projectDir !== undefined && rest.length === 0) { process.stdout.write(`${JSON.stringify(prepareRelease(projectDir), null, 2)}\n`); return; }
    if (command === "review" && projectDir !== undefined && rest.length >= 1 && rest.length <= 2) { process.stdout.write(`${JSON.stringify(reviewReleasePlan(projectDir, JSON.parse(readFileSync(resolve(rest[0]!), "utf8")), rest[1] === undefined ? {} : { reviewedAt: rest[1] }), null, 2)}\n`); return; }
    if (command === "authorize" && projectDir !== undefined && rest.length >= 2 && rest.length <= 4) {
      const third = rest[2];
      const acknowledgementPath = third !== undefined && existsSync(resolve(third)) ? resolve(third) : null;
      const acknowledgements = acknowledgementPath === null ? [] : JSON.parse(readFileSync(acknowledgementPath, "utf8"));
      const decidedAt = rest[3] ?? (acknowledgementPath === null ? third : undefined);
      process.stdout.write(`${JSON.stringify(authorizeRelease(projectDir, { planSha256: rest[0]!, reason: rest[1]!, policyAcknowledgements: acknowledgements, ...(decidedAt === undefined ? {} : { decidedAt }) }), null, 2)}\n`); return;
    }
    if (command === "execute" && projectDir !== undefined && rest.length <= 1) { process.stdout.write(`${JSON.stringify(executeRelease(projectDir, rest[0] === undefined ? {} : { executedAt: rest[0] }), null, 2)}\n`); return; }
    if (command === "reuse" && projectDir !== undefined && rest.length >= 2 && rest.length <= 3) { process.stdout.write(`${JSON.stringify(reuseRelease(projectDir, rest[2] === undefined ? { releaseCurrentPath: rest[0]!, reason: rest[1]! } : { releaseCurrentPath: rest[0]!, reason: rest[1]!, reusedAt: rest[2] }), null, 2)}\n`); return; }
    console.error("Usage: aidlc-vnext-release.ts prepare <project-dir> | review <project-dir> <proposal.json> [reviewed-at] | authorize <project-dir> <plan-sha256> <reason> [policy-acknowledgements.json] [decided-at] | execute <project-dir> [executed-at] | reuse <project-dir> <release-current.json> <reason> [reused-at]");
    process.exitCode = 1;
  } catch (error) {
    const root = projectDir === undefined ? null : resolve(projectDir);
    if (root !== null) {
      try { appendAuditEntry(root, activeVNextIntentRecordDir(root), "ROUTE_BLOCKED", { Stage: "ST-08", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" }); } catch { /* preserve the original error */ }
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
