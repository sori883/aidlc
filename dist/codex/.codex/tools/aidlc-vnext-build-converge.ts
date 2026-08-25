#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import {
  parseBuildContract,
  parseBuildContractCurrent,
  type BoltDefinition,
  type BuildContract,
  type BuildVerifier,
} from "./aidlc-vnext-build-contract-contract.ts";
import { buildContractCurrentPath } from "./aidlc-vnext-build-contract.ts";
import {
  parseBoltWorkRequest,
  parseBuildAttemptCheckpoint,
  parseBuildCurrent,
  parseBuildSession,
  parseRunnableCandidate,
  parseVerifierEvidence,
  type BoltSourceWorkspace,
  type BoltWorkRequest,
  type BuildAttemptCheckpoint,
  type BuildChangedFile,
  type BuildCurrent,
  type BuildRepositoryWorkspace,
  type BuildSession,
  type RunnableCandidate,
  type VerifierEvidence,
} from "./aidlc-vnext-build-converge-contract.ts";
import { parseFeedbackCurrent } from "./aidlc-vnext-review-contract.ts";
import { parseSystemMap, type SourceSnapshot, type SystemMap } from "./aidlc-vnext-orient-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextPlanAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { withWorkspaceLock, withWorkspaceLockAsync } from "./aidlc-workspace-lock.ts";

export interface BuildConvergePrepareOptions { preparedAt?: string }
export interface BuildAttemptVerifyOptions { boltId: string; verifiedAt?: string }
export interface RunnableCandidateReuseOptions { candidatePath: string; reason: string; reusedAt?: string }

export interface BuildConvergePrepareResult {
  execution: "prepared" | "reused" | "advanced";
  request: BoltWorkRequest | null;
  reference: ArtifactReference | null;
  currentReference: ArtifactReference | null;
  state: VNextIntentState;
}

export interface BuildAttemptVerifyResult {
  outcome: "retry" | "next_bolt" | "candidate" | "blocked";
  checkpoint: BuildAttemptCheckpoint;
  checkpointReference: ArtifactReference;
  request: BoltWorkRequest | null;
  requestReference: ArtifactReference | null;
  candidate: RunnableCandidate | null;
  candidateReference: ArtifactReference | null;
  state: VNextIntentState;
}

export interface RunnableCandidateReuseResult {
  candidate: RunnableCandidate;
  candidateReference: ArtifactReference;
  current: BuildCurrent;
  currentReference: ArtifactReference;
  state: VNextIntentState;
}

const STAGE_CONTRACT_PATH = join(runtimeCoreDir(), "aidlc-common/stages/st-06-build-converge.json");
const MAX_IDENTICAL_FAILURES = 3;

function fail(context: string, message: string): never { throw new Error(`${context}: ${message}`) }
function digest(content: string | Uint8Array): string { return `sha256:${createHash("sha256").update(content).digest("hex")}` }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function portable(path: string): string { return path.split(sep).join("/") }

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

function portableProjectPath(projectDir: string, path: string): string {
  const rel = relative(resolve(projectDir), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("ST-06 Build & Converge", `artifact path is outside the project: ${resolve(path)}`);
  return rel === "" ? "." : portable(rel);
}

function artifactReference(projectDir: string, path: string, artifact: string, content?: string): ArtifactReference {
  const bytes = content ?? readFileSync(path, "utf8");
  return parseArtifactReference({ artifact, version: 1, source_of_truth: portableProjectPath(projectDir, path), sha256: digest(bytes) });
}

function readCanonical<T>(path: string, parser: (value: unknown, context?: string) => T): { value: T; content: string } {
  const content = readFileSync(path, "utf8");
  let value: T;
  try { value = parser(JSON.parse(content), path); }
  catch (error) { fail("ST-06 Build & Converge", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (content !== serialize(value)) fail("ST-06 Build & Converge", `artifact is not canonical: ${path}`);
  return { value, content };
}

function refsEqual(left: ArtifactReference, right: ArtifactReference): boolean { return JSON.stringify(left) === JSON.stringify(right) }

export function buildRootDir(recordDir: string): string { return join(resolve(recordDir), "artifacts", "build"); }
export function buildSessionPath(recordDir: string): string { return join(buildRootDir(recordDir), "build-session.json"); }
export function buildBoltWorkRequestPath(recordDir: string, boltId: string): string { return join(buildRootDir(recordDir), "bolts", boltId, "work-request.json"); }
export function buildAttemptCheckpointPath(recordDir: string, boltId: string, attempt: number): string { return join(buildRootDir(recordDir), "bolts", boltId, "attempts", attempt.toString().padStart(6, "0"), "checkpoint.json"); }
export function buildVerifierEvidencePath(recordDir: string, boltId: string, attempt: number, verifierId: string): string { return join(buildRootDir(recordDir), "bolts", boltId, "attempts", attempt.toString().padStart(6, "0"), "verifiers", `${verifierId}.json`); }
export function buildIntegrationVerifierEvidencePath(recordDir: string, verifierId: string, sessionId = "initial"): string { return join(buildRootDir(recordDir), "integration", safeBranchPart(sessionId), "verifiers", `${verifierId}.json`); }
export function buildRunnableCandidatePath(recordDir: string): string { return join(buildRootDir(recordDir), "runnable-candidate.json"); }
export function buildCurrentPath(recordDir: string): string { return join(buildRootDir(recordDir), "current.json"); }

export function loadBuildConvergeStageContract(path = STAGE_CONTRACT_PATH): VNextStageContract {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { fail("ST-06 Contract", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  const contract = parseVNextStageContract(value, path);
  if (contract.stage_id !== "ST-06" || contract.name !== "Build & Converge") fail("ST-06 Contract", "must define ST-06 Build & Converge");
  return contract;
}

interface BuildInputs {
  current: ReturnType<typeof parseBuildContractCurrent>;
  currentRef: ArtifactReference;
  contract: BuildContract | null;
  contractRef: ArtifactReference | null;
  systemMap: SystemMap;
}

function loadBuildInputs(projectDir: string, recordDir: string, state: VNextIntentState): BuildInputs {
  const currentPath = buildContractCurrentPath(recordDir);
  const currentStored = readCanonical(currentPath, parseBuildContractCurrent);
  const current = currentStored.value;
  if (current.intent_id !== state.intent_id) fail("ST-06 Build & Converge", "Build Contract Current Intent does not match State");
  const currentRef = artifactReference(projectDir, currentPath, "build-contract-current", currentStored.content);
  if (!refsEqual(current.effective_policy_ref, state.policy_snapshot)) fail("ST-06 Build & Converge", "Build Contract policy does not match State");
  verifyProjectArtifactReference(projectDir, current.effective_policy_ref);
  verifyProjectArtifactReference(projectDir, current.approval_ref);
  verifyProjectArtifactReference(projectDir, current.system_map_ref);
  const systemMap = readCanonical(resolve(projectDir, current.system_map_ref.source_of_truth), parseSystemMap).value;
  if (current.disposition === "not_applicable") return { current, currentRef, contract: null, contractRef: null, systemMap };
  if (current.build_contract_ref === null) fail("ST-06 Build & Converge", `${current.disposition} requires a Build Contract`);
  verifyProjectArtifactReference(projectDir, current.build_contract_ref);
  const contract = readCanonical(resolve(projectDir, current.build_contract_ref.source_of_truth), parseBuildContract).value;
  if (contract.intent_id !== state.intent_id) fail("ST-06 Build & Converge", "Build Contract Intent does not match State");
  if (!refsEqual(contract.approval_ref, current.approval_ref)) fail("ST-06 Build & Converge", "Build Contract approval does not match Current");
  return { current, currentRef, contract, contractRef: current.build_contract_ref, systemMap };
}

function runGit(cwd: string, args: string[], context: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) fail("ST-06 Build & Converge", `${context}: ${(result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim()}`);
  return result.stdout.trim();
}

function runGitRaw(cwd: string, args: string[], context: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) fail("ST-06 Build & Converge", `${context}: ${(result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim()}`);
  return result.stdout.replace(/\n$/, "");
}

function gitMaybe(cwd: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { ok: result.status === 0, output: (result.stdout || result.stderr || "").trim() };
}

function repositoryId(root: string): string { return `repo-${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)}` }
function safeBranchPart(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "item" }
function runtimeRoot(projectDir: string): string { return `${resolve(projectDir)}.aidlc-worktrees`; }

function relativeInside(root: string, child: string, context: string): string {
  const rel = relative(resolve(root), resolve(child));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("ST-06 Build & Converge", `${context} crosses a Repository boundary`);
  return rel === "" ? "." : portable(rel);
}

function sourceSnapshot(map: SystemMap, sourceId: string): SourceSnapshot {
  const source = map.source_snapshots.find((entry) => entry.source_id === sourceId);
  if (source === undefined) fail("ST-06 Build & Converge", `System Map has no source snapshot for ${sourceId}`);
  if (source.source_type !== "git") fail("ST-06 Build & Converge", `execute source ${sourceId} must be a Git Repository`);
  if (source.dirty) fail("ST-06 Build & Converge", `accepted source ${sourceId} is marked dirty`);
  return source;
}

function ensureWorktree(repositoryRoot: string, path: string, branch: string, baseRevision: string): void {
  const branchRef = `refs/heads/${branch}`;
  const branchFound = gitMaybe(repositoryRoot, ["show-ref", "--verify", branchRef]);
  if (!branchFound.ok) {
    mkdirSync(dirname(path), { recursive: true });
    runGit(repositoryRoot, ["worktree", "add", "-b", branch, path, baseRevision], `cannot create ${branch} worktree`);
  } else {
    const branchRevision = runGit(repositoryRoot, ["rev-parse", branchRef], `cannot inspect ${branch}`);
    if (branchRevision !== baseRevision) fail("ST-06 Build & Converge", `existing branch ${branch} has drifted from ${baseRevision}`);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      runGit(repositoryRoot, ["worktree", "add", path, branch], `cannot restore ${branch} worktree`);
    }
  }
  const actual = runGit(path, ["rev-parse", "HEAD"], `cannot inspect worktree ${path}`);
  if (actual !== baseRevision) fail("ST-06 Build & Converge", `worktree ${path} base drifted from ${baseRevision}`);
}

function initializeRepositories(
  projectDir: string,
  state: VNextIntentState,
  contract: BuildContract,
  map: SystemMap,
  sessionId: string,
  rejectedCandidate: RunnableCandidate | null = null,
): BuildRepositoryWorkspace[] {
  const byRoot = new Map<string, BuildRepositoryWorkspace>();
  const usedSourceIds = new Set([
    ...contract.bolts.flatMap((bolt) => bolt.targets.map((target) => target.source_id)),
    ...contract.verifiers.flatMap((verifier) => verifier.source_id === null ? [] : [verifier.source_id]),
  ]);
  for (const targetSource of contract.target_sources.filter((source) => usedSourceIds.has(source.source_id))) {
    const snapshot = sourceSnapshot(map, targetSource.source_id);
    const sourceRoot = realpathSync(resolve(projectDir, targetSource.locator));
    if (!existsSync(sourceRoot)) fail("ST-06 Build & Converge", `source path does not exist: ${targetSource.locator}`);
    const repositoryRoot = realpathSync(runGit(sourceRoot, ["rev-parse", "--show-toplevel"], `source ${targetSource.source_id} is not a Git Repository`));
    const head = runGit(repositoryRoot, ["rev-parse", "HEAD"], `cannot read HEAD for ${targetSource.source_id}`);
    if (head !== snapshot.revision) fail("ST-06 Build & Converge", `source ${targetSource.source_id} HEAD ${head} differs from accepted revision ${snapshot.revision}`);
    if (!gitMaybe(repositoryRoot, ["cat-file", "-e", `${snapshot.revision}^{commit}`]).ok) fail("ST-06 Build & Converge", `accepted revision is unavailable for ${targetSource.source_id}`);
    const dirty = runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"], `cannot inspect working tree for ${targetSource.source_id}`);
    if (dirty !== "") fail("ST-06 Build & Converge", `ordinary Git working tree is dirty for ${targetSource.source_id}`);
    const repoId = repositoryId(repositoryRoot);
    let repository = byRoot.get(repositoryRoot);
    if (repository === undefined) {
      const rejected = rejectedCandidate?.source_results.find((entry) => entry.repository_id === repoId);
      const workingRevision = rejected?.candidate_revision ?? snapshot.revision;
      if (rejected !== undefined && rejected.base_revision !== snapshot.revision) {
        fail("ST-06 Build & Converge", `rejected Candidate base differs from accepted System Map for ${repoId}`);
      }
      if (!gitMaybe(repositoryRoot, ["cat-file", "-e", `${workingRevision}^{commit}`]).ok) {
        fail("ST-06 Build & Converge", `working revision is unavailable for ${repoId}: ${workingRevision}`);
      }
      const integrationBranch = `aidlc/${safeBranchPart(sessionId)}/${repoId}/integration`;
      const integrationWorktree = join(runtimeRoot(projectDir), safeBranchPart(state.intent_id), safeBranchPart(sessionId), repoId, "integration");
      ensureWorktree(repositoryRoot, integrationWorktree, integrationBranch, workingRevision);
      repository = {
        repository_id: repoId,
        repository_root: repositoryRoot,
        base_revision: snapshot.revision,
        working_revision: workingRevision,
        integration_branch: integrationBranch,
        integration_worktree: integrationWorktree,
        sources: [],
      };
      byRoot.set(repositoryRoot, repository);
    }
    if (repository.base_revision !== snapshot.revision) fail("ST-06 Build & Converge", `sources in ${repositoryRoot} disagree on accepted revision`);
    repository.sources.push({ source_id: targetSource.source_id, locator: targetSource.locator, relative_path: relativeInside(repositoryRoot, sourceRoot, `source ${targetSource.source_id}`) });
  }
  const missing = [...usedSourceIds].filter((sourceId) => ![...byRoot.values()].some((repository) => repository.sources.some((source) => source.source_id === sourceId)));
  if (missing.length > 0) fail("ST-06 Build & Converge", `Build Contract has no selected source definition for: ${missing.join(", ")}`);
  return [...byRoot.values()].sort((left, right) => left.repository_id.localeCompare(right.repository_id));
}

export function selectReadyBolt(bolts: readonly BoltDefinition[], derivedBatches: readonly (readonly string[])[], completed: readonly string[]): BoltDefinition | null {
  const done = new Set(completed);
  for (const batch of derivedBatches) {
    for (const boltId of batch) {
      if (done.has(boltId)) continue;
      const bolt = bolts.find((entry) => entry.bolt_id === boltId);
      if (bolt === undefined) fail("ST-06 Build & Converge", `derived batch references unknown Bolt ${boltId}`);
      if (bolt.depends_on.every((dependency) => done.has(dependency))) return bolt;
    }
  }
  return null;
}

function readyBolt(contract: BuildContract, completed: readonly string[]): BoltDefinition | null {
  return selectReadyBolt(contract.bolts, contract.derived_batches, completed);
}

function createBoltWorktrees(projectDir: string, session: BuildSession, bolt: BoltDefinition, contract: BuildContract): BoltSourceWorkspace[] {
  const sourceIds = new Set([
    ...bolt.targets.map((entry) => entry.source_id),
    ...contract.acceptance_criteria.filter((entry) => bolt.acceptance_criterion_ids.includes(entry.criterion_id)).flatMap((entry) => entry.verifier_ids).flatMap((id) => contract.verifiers.filter((entry) => entry.verifier_id === id && entry.source_id !== null).map((entry) => entry.source_id!)),
  ]);
  const workspaces: BoltSourceWorkspace[] = [];
  for (const repository of session.repositories) {
    const needed = repository.sources.filter((source) => sourceIds.has(source.source_id));
    if (needed.length === 0) continue;
    const boltBranch = `aidlc/${safeBranchPart(session.session_id)}/${repository.repository_id}/bolt/${safeBranchPart(bolt.bolt_id)}`;
    const boltRoot = join(runtimeRoot(projectDir), safeBranchPart(session.intent_id), safeBranchPart(session.session_id), repository.repository_id, "bolts", safeBranchPart(bolt.bolt_id));
    const integrationHead = runGit(repository.integration_worktree, ["rev-parse", "HEAD"], `cannot inspect integration worktree for ${bolt.bolt_id}`);
    ensureWorktree(repository.repository_root, boltRoot, boltBranch, integrationHead);
    for (const source of needed) {
      workspaces.push({
        source_id: source.source_id,
        locator: source.locator,
        repository_id: repository.repository_id,
        repository_root: repository.repository_root,
        worktree_path: source.relative_path === "." ? boltRoot : join(boltRoot, source.relative_path),
        base_revision: integrationHead,
      });
    }
  }
  const missing = [...sourceIds].filter((sourceId) => !workspaces.some((workspace) => workspace.source_id === sourceId));
  if (missing.length > 0) fail("ST-06 Build & Converge", `Bolt ${bolt.bolt_id} has no Git workspace for: ${missing.join(", ")}`);
  return workspaces.sort((left, right) => left.source_id.localeCompare(right.source_id));
}

function buildRequest(projectDir: string, recordDir: string, session: BuildSession, contract: BuildContract, bolt: BoltDefinition, attempt: number, createdAt: string): { request: BoltWorkRequest; reference: ArtifactReference } {
  const criteria = contract.acceptance_criteria.filter((entry) => bolt.acceptance_criterion_ids.includes(entry.criterion_id));
  const verifierIds = new Set(criteria.flatMap((entry) => entry.verifier_ids));
  const request = parseBoltWorkRequest({
    schema_version: 1,
    artifact: "bolt-work-request",
    version: 1,
    session_id: session.session_id,
    intent_id: session.intent_id,
    stage_id: "ST-06",
    build_contract_ref: session.build_contract_ref,
    bolt,
    change_contracts: contract.change_contracts.filter((entry) => bolt.contract_ids.includes(entry.contract_id)),
    acceptance_criteria: criteria,
    verifiers: contract.verifiers.filter((entry) => verifierIds.has(entry.verifier_id)),
    attempt,
    source_workspaces: createBoltWorktrees(projectDir, session, bolt, contract),
    requested_output: "repository-changes",
    rules: [
      "Implement only this Core-selected Bolt; do not choose another Bolt or Stage.",
      "Change only the listed Bolt targets inside the supplied isolated Git worktrees.",
      "Do not edit Core State, Plan, Audit, Build Contract, work request, or Evidence artifacts.",
      "Run local checks as needed, then ask Core to verify this exact Bolt attempt.",
      "Do not perform destructive, external, credential-bearing, release, or deployment operations.",
    ],
    created_at: createdAt,
  });
  const path = buildBoltWorkRequestPath(recordDir, bolt.bolt_id);
  const content = serialize(request);
  writeFileAtomic(path, content);
  return { request, reference: artifactReference(projectDir, path, "bolt-work-request", content) };
}

function stageProposal(stageId: "ST-06", disposition: "execute" | "reuse" | "not_applicable", proposalId: string, reason: string, evidence: ArtifactReference[]): StageDispositionProposal {
  return { schema_version: 1, proposal_id: proposalId, stage_id: stageId, disposition, reason, evidence, proposed_by: "ai" };
}

function revisePlanForResult(projectDir: string, plan: StageExecutionPlan, contract: VNextStageContract, proposal: StageDispositionProposal, deterministic = false): StageExecutionPlan {
  const existing = plan.stage_decisions.find((entry) => entry.stage_id === "ST-06");
  if (existing?.proposal_ref === proposal.proposal_id && existing.disposition === proposal.disposition && existing.reason === proposal.reason && JSON.stringify(existing.evidence) === JSON.stringify(proposal.evidence)) return plan;
  return reviseStageExecutionPlan(plan, [proposal], {
    projectDir,
    stageContracts: [contract],
    deterministicApplicability: (entry) => deterministic && entry.stage_id === "ST-06" && entry.disposition === "not_applicable" && entry.proposal_id === proposal.proposal_id,
  });
}

function advanceToSt07(projectDir: string, recordDir: string, state: VNextIntentState, oldPlan: StageExecutionPlan, newPlan: StageExecutionPlan, current: BuildCurrent, currentRef: ArtifactReference, evidence: ArtifactReference[], at: string): VNextIntentState {
  if (newPlan.revision !== oldPlan.revision) writeVNextPlanAt(recordDir, newPlan);
  const definitions = loadVNextDefinitions();
  const nextStage = nextForwardStage(definitions.graph, "ST-06");
  if (nextStage !== "ST-07") fail("ST-06 Build & Converge", "fixed Graph must route to ST-07");
  validateCoreRoute(definitions.graph, { from: "ST-06", to: nextStage });
  const completed = readOrderedAuditEntries(recordDir).some((entry) => entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-06" && entry.fields["Build Current SHA-256"] === currentRef.sha256);
  if (!completed) appendAuditEntries(projectDir, recordDir, [
    ...(newPlan.revision === oldPlan.revision ? [] : [{ event: "PLAN_REVISED" as const, fields: { "Plan Revision": String(newPlan.revision), Stage: "ST-06", Disposition: current.disposition, "Proposal Reference": newPlan.stage_decisions.find((entry) => entry.stage_id === "ST-06")?.proposal_ref ?? "", "Decision Authority": "core" } }]),
    { event: current.disposition === "not_applicable" ? "STAGE_SKIPPED" : "STAGE_COMPLETED", fields: { Stage: "ST-06", Disposition: current.disposition, Artifact: currentRef.source_of_truth, "Build Current SHA-256": currentRef.sha256, Evidence: evidence.map((entry) => entry.sha256).join(","), "Decision Authority": "core" } },
    { event: "ROUTE_DECIDED", fields: { "From Stage": "ST-06", "Current Stage": "ST-07", Graph: definitions.graph.graph_version, "Decision Authority": "core" } },
  ]);
  const advanced: VNextIntentState = {
    ...state,
    plan_revision: newPlan.revision,
    current_stage: "ST-07",
    status: "parked",
    parked_reason: "ST-07 Human Feedback & Approval is not implemented yet.",
    updated_at: at,
  };
  writeVNextStateAt(recordDir, advanced, newPlan);
  return readVNextStateAt(recordDir);
}

function completeNotApplicable(projectDir: string, recordDir: string, state: VNextIntentState, plan: StageExecutionPlan, inputs: BuildInputs, at: string): BuildConvergePrepareResult {
  const current = parseBuildCurrent({
    schema_version: 1,
    artifact: "build-current",
    version: 1,
    intent_id: state.intent_id,
    disposition: "not_applicable",
    build_contract_current_ref: inputs.currentRef,
    runnable_candidate_ref: null,
    reason: "The approved Build Contract Current contains no build work, so ST-06 has no executable Bolt.",
    updated_at: at,
  });
  const path = buildCurrentPath(recordDir);
  const content = serialize(current);
  if (existsSync(path)) {
    const stored = readCanonical(path, parseBuildCurrent);
    if (JSON.stringify({ ...stored.value, updated_at: at }) !== JSON.stringify(current) && JSON.stringify(stored.value) !== JSON.stringify(current)) {
      if (loadFeedbackReentry(projectDir, recordDir, state) === null) fail("ST-06 Build & Converge", "Build Current already records different content");
      writeFileAtomic(path, content);
    }
  } else writeFileAtomic(path, content);
  const oldCandidate = buildRunnableCandidatePath(recordDir);
  if (existsSync(oldCandidate)) {
    if (loadFeedbackReentry(projectDir, recordDir, state) === null) fail("ST-06 Build & Converge", "not_applicable cannot discard a Candidate without verified feedback reentry");
    unlinkSync(oldCandidate);
  }
  const storedContent = readFileSync(path, "utf8");
  const currentRef = artifactReference(projectDir, path, "build-current", storedContent);
  const proposal = stageProposal("ST-06", "not_applicable", `st06-no-build-${inputs.currentRef.sha256.slice(7, 19)}`, current.reason, [inputs.currentRef, inputs.current.approval_ref]);
  const revised = revisePlanForResult(projectDir, plan, loadBuildConvergeStageContract(), proposal, true);
  const advanced = advanceToSt07(projectDir, recordDir, state, plan, revised, current, currentRef, proposal.evidence, at);
  return { execution: "advanced", request: null, reference: null, currentReference: currentRef, state: advanced };
}

function nextBuildAttempt(recordDir: string, boltId: string): number {
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    if (!existsSync(buildAttemptCheckpointPath(recordDir, boltId, attempt))) return attempt;
  }
  fail("ST-06 Build & Converge", `Bolt ${boltId} exhausted attempt identifiers`);
}

function loadFeedbackReentry(
  projectDir: string,
  recordDir: string,
  state: VNextIntentState,
): { feedback: ReturnType<typeof parseFeedbackCurrent>; rejectedCandidate: RunnableCandidate } | null {
  const path = join(resolve(recordDir), "artifacts", "review", "feedback-current.json");
  if (!existsSync(path)) return null;
  const feedback = readCanonical(path, parseFeedbackCurrent).value;
  if (feedback.intent_id !== state.intent_id || !feedback.invalidated_stages.includes("ST-06")) return null;
  verifyProjectArtifactReference(projectDir, feedback.human_decision_ref);
  verifyProjectArtifactReference(projectDir, feedback.rejected_candidate_ref);
  const rejectedCandidate = readCanonical(resolve(projectDir, feedback.rejected_candidate_ref.source_of_truth), parseRunnableCandidate).value;
  if (rejectedCandidate.intent_id !== state.intent_id) fail("ST-06 Build & Converge", "rejected Candidate belongs to another Intent");
  return { feedback, rejectedCandidate };
}

function feedbackAffectedBolts(
  contract: BuildContract,
  feedback: ReturnType<typeof parseFeedbackCurrent>,
): Set<string> {
  const requirementIds = new Set(feedback.feedback_items.flatMap((entry) => entry.requirement_ids));
  const criterionIds = new Set(contract.acceptance_criteria.filter((entry) => entry.requirement_ids.some((id) => requirementIds.has(id))).map((entry) => entry.criterion_id));
  const affected = new Set(contract.bolts.filter((bolt) => bolt.acceptance_criterion_ids.some((id) => criterionIds.has(id))).map((bolt) => bolt.bolt_id));
  if (affected.size === 0) fail("ST-06 Build & Converge", "candidate_defect Feedback does not identify an affected Bolt");
  return affected;
}

function prepareBuildConvergeLocked(projectDir: string, recordDir: string, options: BuildConvergePrepareOptions): BuildConvergePrepareResult {
  loadBuildConvergeStageContract();
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-06") fail("ST-06 Build & Converge", `current Stage must be ST-06, found ${state.current_stage}`);
  const inputs = loadBuildInputs(projectDir, recordDir, state);
  const at = options.preparedAt ?? new Date().toISOString();
  if (inputs.current.disposition === "not_applicable") return completeNotApplicable(projectDir, recordDir, state, plan, inputs, at);
  if (inputs.contract === null || inputs.contractRef === null) fail("ST-06 Build & Converge", "execute requires an approved Build Contract");
  const sessionPath = buildSessionPath(recordDir);
  let session: BuildSession;
  let execution: "prepared" | "reused" = "prepared";
  let firstAttempt = 1;
  if (existsSync(sessionPath)) {
    session = readCanonical(sessionPath, parseBuildSession).value;
    const sameInputs = session.intent_id === state.intent_id && refsEqual(session.build_contract_ref, inputs.contractRef) && refsEqual(session.build_contract_current_ref, inputs.currentRef);
    if (session.status === "completed" || !sameInputs) {
      const reentry = loadFeedbackReentry(projectDir, recordDir, state);
      if (reentry === null) fail("ST-06 Build & Converge", "completed or incompatible Build Session has no verified ST-07 feedback reentry");
      const rejected = reentry.feedback.selected_reason === "candidate_defect" ? reentry.rejectedCandidate : null;
      if (rejected !== null && !refsEqual(rejected.build_contract_ref, inputs.contractRef)) fail("ST-06 Build & Converge", "candidate_defect Feedback changed the Build Contract");
      const affected = rejected === null ? new Set(inputs.contract.bolts.map((bolt) => bolt.bolt_id)) : feedbackAffectedBolts(inputs.contract, reentry.feedback);
      const completed = inputs.contract.bolts.map((bolt) => bolt.bolt_id).filter((boltId) => !affected.has(boltId));
      const first = readyBolt(inputs.contract, completed);
      if (first === null) fail("ST-06 Build & Converge", "feedback reentry has no dependency-ready Bolt");
      const sessionId = `build-${state.intent_id}-r${plan.revision}`;
      session = parseBuildSession({
        schema_version: 1, artifact: "build-session", version: 1,
        session_id: sessionId, intent_id: state.intent_id, stage_id: "ST-06", disposition: "execute", status: "active",
        build_contract_current_ref: inputs.currentRef, build_contract_ref: inputs.contractRef,
        effective_policy_ref: inputs.current.effective_policy_ref, completed_bolt_ids: completed,
        current_bolt_id: first.bolt_id,
        repositories: initializeRepositories(projectDir, state, inputs.contract, inputs.systemMap, sessionId, rejected),
        last_failure_signature: null, same_failure_count: 0, blocked_reason: null,
        started_at: at, updated_at: at,
      });
      writeFileAtomic(sessionPath, serialize(session));
      firstAttempt = nextBuildAttempt(recordDir, first.bolt_id);
      appendAuditEntries(projectDir, recordDir, [
        { event: "STAGE_STARTED", fields: { Stage: "ST-06", Executor: "ai+core", Verifier: "build-verifier-runner", Reentry: reentry.feedback.selected_reason } },
        { event: "BOLT_STARTED", fields: { Stage: "ST-06", Bolt: first.bolt_id, Attempt: String(firstAttempt), "Decision Authority": "core" } },
        ...session.repositories.map((repository) => ({ event: "WORKTREE_CREATED" as const, fields: { Stage: "ST-06", Repository: repository.repository_id, Revision: repository.working_revision, Branch: repository.integration_branch, "Decision Authority": "core" } })),
      ]);
    } else {
      if (session.status === "blocked") fail("ST-06 Build & Converge", session.blocked_reason ?? "Build Session is blocked");
      execution = "reused";
    }
  } else {
    const first = readyBolt(inputs.contract, []);
    if (first === null) fail("ST-06 Build & Converge", "execute Build Contract has no ready Bolt");
    const sessionId = `build-${state.intent_id}-r${plan.revision}`;
    session = parseBuildSession({
      schema_version: 1,
      artifact: "build-session",
      version: 1,
      session_id: sessionId,
      intent_id: state.intent_id,
      stage_id: "ST-06",
      disposition: "execute",
      status: "active",
      build_contract_current_ref: inputs.currentRef,
      build_contract_ref: inputs.contractRef,
      effective_policy_ref: inputs.current.effective_policy_ref,
      completed_bolt_ids: [],
      current_bolt_id: first.bolt_id,
      repositories: initializeRepositories(projectDir, state, inputs.contract, inputs.systemMap, sessionId),
      last_failure_signature: null,
      same_failure_count: 0,
      blocked_reason: null,
      started_at: at,
      updated_at: at,
    });
    writeFileAtomic(sessionPath, serialize(session));
    appendAuditEntries(projectDir, recordDir, [
      { event: "STAGE_STARTED", fields: { Stage: "ST-06", Executor: "ai+core", Verifier: "build-verifier-runner" } },
      { event: "BOLT_STARTED", fields: { Stage: "ST-06", Bolt: first.bolt_id, Attempt: "1", "Decision Authority": "core" } },
      ...session.repositories.map((repository) => ({ event: "WORKTREE_CREATED" as const, fields: { Stage: "ST-06", Repository: repository.repository_id, Revision: repository.base_revision, Branch: repository.integration_branch, "Decision Authority": "core" } })),
    ]);
  }
  if (session.current_bolt_id === null) fail("ST-06 Build & Converge", "active session has no current Bolt");
  const bolt = inputs.contract.bolts.find((entry) => entry.bolt_id === session.current_bolt_id);
  if (bolt === undefined) fail("ST-06 Build & Converge", `session references unknown Bolt ${session.current_bolt_id}`);
  const requestPath = buildBoltWorkRequestPath(recordDir, bolt.bolt_id);
  let prepared: { request: BoltWorkRequest; reference: ArtifactReference };
  if (execution === "reused" && existsSync(requestPath)) {
    const stored = readCanonical(requestPath, parseBoltWorkRequest);
    if (stored.value.session_id !== session.session_id || stored.value.bolt.bolt_id !== bolt.bolt_id || !refsEqual(stored.value.build_contract_ref, inputs.contractRef)) fail("ST-06 Build & Converge", "stored Bolt Work Request does not match the session");
    prepared = { request: stored.value, reference: artifactReference(projectDir, requestPath, "bolt-work-request", stored.content) };
  } else prepared = buildRequest(projectDir, recordDir, session, inputs.contract, bolt, firstAttempt, at);
  const { parked_reason: _parked, ...ready } = state;
  writeVNextStateAt(recordDir, { ...ready, status: "ready", updated_at: at }, plan);
  return { execution, request: prepared.request, reference: prepared.reference, currentReference: null, state: readVNextStateAt(recordDir) };
}

export function prepareBuildConverge(projectDir: string, options: BuildConvergePrepareOptions = {}): BuildConvergePrepareResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try { return prepareBuildConvergeLocked(projectRoot, recordDir, options); }
    catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", { Stage: "ST-06", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" });
      throw error;
    }
  });
}

function validateReusableCandidate(projectDir: string, inputs: BuildInputs, state: VNextIntentState, candidate: RunnableCandidate): void {
  if (inputs.contract === null || inputs.contractRef === null) fail("ST-06 Build & Converge", "Runnable Candidate reuse requires an approved Build Contract");
  if (candidate.intent_id !== state.intent_id || !refsEqual(candidate.build_contract_ref, inputs.contractRef)) fail("ST-06 Build & Converge", "Runnable Candidate is not bound to the same Intent and Build Contract");
  const usedSourceIds = new Set([
    ...inputs.contract.bolts.flatMap((bolt) => bolt.targets.map((target) => target.source_id)),
    ...inputs.contract.verifiers.flatMap((verifier) => verifier.source_id === null ? [] : [verifier.source_id]),
  ]);
  const candidateSourceIds = candidate.source_results.flatMap((entry) => entry.source_ids);
  if ([...usedSourceIds].some((sourceId) => !candidateSourceIds.includes(sourceId)) || candidateSourceIds.some((sourceId) => !usedSourceIds.has(sourceId))) {
    fail("ST-06 Build & Converge", "Runnable Candidate source coverage differs from the approved Build Contract");
  }
  for (const result of candidate.source_results) {
    const roots = result.source_ids.map((sourceId) => {
      const target = inputs.contract!.target_sources.find((entry) => entry.source_id === sourceId);
      if (target === undefined) fail("ST-06 Build & Converge", `Runnable Candidate references unknown source ${sourceId}`);
      const snapshot = sourceSnapshot(inputs.systemMap, sourceId);
      if (snapshot.revision !== result.base_revision) fail("ST-06 Build & Converge", `Runnable Candidate base revision differs for ${sourceId}`);
      const sourceRoot = realpathSync(resolve(projectDir, target.locator));
      return realpathSync(runGit(sourceRoot, ["rev-parse", "--show-toplevel"], `source ${sourceId} is not a Git Repository`));
    });
    if (new Set(roots).size !== 1 || repositoryId(roots[0]!) !== result.repository_id) fail("ST-06 Build & Converge", `Runnable Candidate Repository binding differs for ${result.repository_id}`);
    const repositoryRoot = roots[0]!;
    if (!gitMaybe(repositoryRoot, ["cat-file", "-e", `${result.candidate_revision}^{commit}`]).ok) fail("ST-06 Build & Converge", `Runnable Candidate revision is unavailable: ${result.candidate_revision}`);
    const changed = runGit(repositoryRoot, ["diff", "--name-only", `${result.base_revision}..${result.candidate_revision}`], `cannot inspect reusable Candidate ${result.repository_id}`).split("\n").filter(Boolean).map(portable).sort();
    if (JSON.stringify(changed) !== JSON.stringify([...result.changed_files].sort())) fail("ST-06 Build & Converge", `Runnable Candidate changed-file list differs for ${result.repository_id}`);
  }
  for (const checkpointRef of candidate.bolt_checkpoint_refs) {
    verifyProjectArtifactReference(projectDir, checkpointRef);
    const checkpoint = readCanonical(resolve(projectDir, checkpointRef.source_of_truth), parseBuildAttemptCheckpoint).value;
    if (checkpoint.outcome !== "passed" || !refsEqual(checkpoint.build_contract_ref, inputs.contractRef)) fail("ST-06 Build & Converge", "Runnable Candidate contains an incompatible Bolt checkpoint");
    for (const evidenceRef of checkpoint.verifier_evidence_refs) {
      verifyProjectArtifactReference(projectDir, evidenceRef);
      const evidence = readCanonical(resolve(projectDir, evidenceRef.source_of_truth), parseVerifierEvidence).value;
      if (evidence.result === "failed") fail("ST-06 Build & Converge", "Runnable Candidate checkpoint contains failed Verifier Evidence");
    }
  }
  for (const evidenceRef of candidate.integration_verifier_evidence_refs) {
    verifyProjectArtifactReference(projectDir, evidenceRef);
    const evidence = readCanonical(resolve(projectDir, evidenceRef.source_of_truth), parseVerifierEvidence).value;
    if (evidence.result === "failed") fail("ST-06 Build & Converge", "Runnable Candidate contains failed integration Evidence");
  }
}

function reuseRunnableCandidateLocked(projectDir: string, recordDir: string, options: RunnableCandidateReuseOptions): RunnableCandidateReuseResult {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-06") fail("ST-06 Build & Converge", `current Stage must be ST-06, found ${state.current_stage}`);
  const inputs = loadBuildInputs(projectDir, recordDir, state);
  const path = resolve(options.candidatePath);
  const stored = readCanonical(path, parseRunnableCandidate);
  const candidate = stored.value;
  const candidateReference = artifactReference(projectDir, path, "runnable-candidate", stored.content);
  validateReusableCandidate(projectDir, inputs, state, candidate);
  const at = options.reusedAt ?? new Date().toISOString();
  const current = parseBuildCurrent({
    schema_version: 1,
    artifact: "build-current",
    version: 1,
    intent_id: state.intent_id,
    disposition: "reuse",
    build_contract_current_ref: inputs.currentRef,
    runnable_candidate_ref: candidateReference,
    reason: options.reason,
    updated_at: at,
  });
  const currentPath = buildCurrentPath(recordDir);
  const currentContent = serialize(current);
  if (existsSync(currentPath) && readFileSync(currentPath, "utf8") !== currentContent) fail("ST-06 Build & Converge", "Build Current already records a different result");
  if (!existsSync(currentPath)) writeFileAtomic(currentPath, currentContent);
  const currentReference = artifactReference(projectDir, currentPath, "build-current", currentContent);
  const proposal = stageProposal("ST-06", "reuse", `reuse-${candidate.session_id}`, current.reason, [candidateReference, currentReference]);
  const revised = revisePlanForResult(projectDir, plan, loadBuildConvergeStageContract(), proposal);
  const advanced = advanceToSt07(projectDir, recordDir, state, plan, revised, current, currentReference, proposal.evidence, at);
  return { candidate, candidateReference, current, currentReference, state: advanced };
}

export function reuseRunnableCandidate(projectDir: string, options: RunnableCandidateReuseOptions): RunnableCandidateReuseResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try { return reuseRunnableCandidateLocked(projectRoot, recordDir, options); }
    catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", { Stage: "ST-06", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" });
      throw error;
    }
  });
}

interface RepositoryChange {
  repository: BuildRepositoryWorkspace;
  boltRoot: string;
  files: Array<{ repoPath: string; status: BuildChangedFile["status"] }>;
}

function boltRootFor(session: BuildSession, projectDir: string, repositoryIdValue: string, boltId: string): string {
  return join(runtimeRoot(projectDir), safeBranchPart(session.intent_id), safeBranchPart(session.session_id), repositoryIdValue, "bolts", safeBranchPart(boltId));
}

function parseStatus(output: string): Array<{ repoPath: string; status: BuildChangedFile["status"] }> {
  if (output === "") return [];
  return output.split("\n").filter(Boolean).map((line) => {
    if (line.length < 4) fail("ST-06 Build & Converge", "Git returned an invalid status record");
    const code = line.slice(0, 2);
    let path = line.slice(3);
    if (path.startsWith('"')) fail("ST-06 Build & Converge", "quoted or control-character Git paths are not supported");
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    const status: BuildChangedFile["status"] = arrow >= 0 || code.includes("R") ? "renamed" : code === "??" || code.includes("A") ? "added" : code.includes("D") ? "deleted" : "modified";
    return { repoPath: portable(path), status };
  });
}

function pathWithin(target: string, path: string): boolean {
  const normalized = target.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === "." || path === normalized || path.startsWith(`${normalized}/`);
}

function collectChanges(projectDir: string, session: BuildSession, request: BoltWorkRequest): { repositoryChanges: RepositoryChange[]; changedFiles: BuildChangedFile[] } {
  const allowed = request.bolt.targets.map((target) => {
    const repository = session.repositories.find((entry) => entry.sources.some((source) => source.source_id === target.source_id));
    const source = repository?.sources.find((entry) => entry.source_id === target.source_id);
    if (repository === undefined || source === undefined) fail("ST-06 Build & Converge", `target source ${target.source_id} is not in the Build Session`);
    const prefix = source.relative_path === "." ? "" : `${source.relative_path}/`;
    return { sourceId: target.source_id, repositoryId: repository.repository_id, repoTarget: `${prefix}${target.path}`.replace(/\/+/g, "/") };
  });
  const repositoryChanges: RepositoryChange[] = [];
  const changedFiles: BuildChangedFile[] = [];
  for (const repository of session.repositories) {
    const boltRoot = boltRootFor(session, projectDir, repository.repository_id, request.bolt.bolt_id);
    if (!existsSync(boltRoot)) continue;
    const status = runGitRaw(boltRoot, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all"], `cannot inspect Bolt ${request.bolt.bolt_id}`);
    const files = parseStatus(status);
    for (const file of files) {
      const match = allowed.find((target) => target.repositoryId === repository.repository_id && pathWithin(target.repoTarget, file.repoPath));
      if (match === undefined) fail("ST-06 Build & Converge", `out-of-contract path changed outside the Build Contract: ${file.repoPath}`);
      const source = repository.sources.find((entry) => entry.source_id === match.sourceId)!;
      const sourcePrefix = source.relative_path === "." ? "" : `${source.relative_path}/`;
      const sourcePath = file.repoPath.startsWith(sourcePrefix) ? file.repoPath.slice(sourcePrefix.length) : file.repoPath;
      const absolute = join(boltRoot, ...file.repoPath.split("/"));
      changedFiles.push({ source_id: match.sourceId, path: sourcePath, status: file.status, sha256: file.status === "deleted" ? null : digest(readFileSync(absolute)) });
    }
    repositoryChanges.push({ repository, boltRoot, files });
  }
  return { repositoryChanges, changedFiles: changedFiles.sort((left, right) => `${left.source_id}:${left.path}`.localeCompare(`${right.source_id}:${right.path}`)) };
}

function safeVerifierCwd(workspace: BoltSourceWorkspace, cwd: string): string {
  const resolved = resolve(workspace.worktree_path, cwd);
  relativeInside(workspace.worktree_path, resolved, `verifier cwd for ${workspace.source_id}`);
  return resolved;
}

function evidenceFromCommand(session: BuildSession, request: BoltWorkRequest, verifier: BuildVerifier, result: ReturnType<typeof spawnSync>, at: string, scope: "bolt" | "integration"): VerifierEvidence {
  const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString() ?? "";
  const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr?.toString() ?? "";
  const exitCode = result.status;
  const passed = exitCode !== null && verifier.expected_exit_codes.includes(exitCode) && result.error === undefined;
  const detail = passed ? `Command exited with approved code ${exitCode}.` : result.error?.message.replace(/[\r\n]+/g, " ") ?? `Command exited with code ${exitCode ?? "null"}.`;
  return parseVerifierEvidence({
    schema_version: 1, artifact: "verifier-evidence", version: 1,
    intent_id: session.intent_id, session_id: session.session_id,
    bolt_id: scope === "bolt" ? request.bolt.bolt_id : null,
    attempt: scope === "bolt" ? request.attempt : null,
    scope, verifier_id: verifier.verifier_id, verifier_kind: verifier.kind,
    result: passed ? "passed" : "failed", exit_code: exitCode,
    stdout_sha256: digest(stdout), stderr_sha256: digest(stderr), detail, executed_at: at,
  });
}

async function runRuntimeVerifier(session: BuildSession, request: BoltWorkRequest, verifier: BuildVerifier, cwd: string, at: string, scope: "bolt" | "integration"): Promise<VerifierEvidence> {
  const check = verifier.runtime_check!;
  const child = spawn(check.start_argv[0]!, check.start_argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let passed = false;
  let detail = "Runtime probe did not become ready before timeout.";
  const deadline = Date.now() + check.startup_timeout_ms;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) { detail = `Runtime exited before the probe with code ${child.exitCode}.`; break; }
      try {
        const response = await fetch(`http://${check.host}:${check.port}${check.path}`, { signal: AbortSignal.timeout(Math.min(1_000, Math.max(100, deadline - Date.now()))) });
        if (response.status === check.expected_status) { passed = true; detail = `Local probe returned approved status ${response.status}.`; break; }
        detail = `Local probe returned status ${response.status}.`;
      } catch { /* retry until the approved startup timeout */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => { if (child.exitCode !== null) resolvePromise(); else { child.once("exit", () => resolvePromise()); setTimeout(() => { child.kill("SIGKILL"); resolvePromise(); }, 1_000); } });
  }
  const stdout = child.stdout === null ? "" : await new Response(child.stdout as unknown as BodyInit).text().catch(() => "");
  const stderr = child.stderr === null ? "" : await new Response(child.stderr as unknown as BodyInit).text().catch(() => "");
  return parseVerifierEvidence({
    schema_version: 1, artifact: "verifier-evidence", version: 1,
    intent_id: session.intent_id, session_id: session.session_id,
    bolt_id: scope === "bolt" ? request.bolt.bolt_id : null, attempt: scope === "bolt" ? request.attempt : null,
    scope, verifier_id: verifier.verifier_id, verifier_kind: verifier.kind,
    result: passed ? "passed" : "failed", exit_code: child.exitCode,
    stdout_sha256: digest(stdout), stderr_sha256: digest(stderr), detail, executed_at: at,
  });
}

async function runVerifier(session: BuildSession, request: BoltWorkRequest, verifier: BuildVerifier, workspaces: readonly BoltSourceWorkspace[], at: string, scope: "bolt" | "integration"): Promise<VerifierEvidence> {
  if (verifier.kind === "human-at-st07") return parseVerifierEvidence({
    schema_version: 1, artifact: "verifier-evidence", version: 1,
    intent_id: session.intent_id, session_id: session.session_id, bolt_id: scope === "bolt" ? request.bolt.bolt_id : null,
    attempt: scope === "bolt" ? request.attempt : null, scope, verifier_id: verifier.verifier_id, verifier_kind: verifier.kind,
    result: "deferred", exit_code: null, stdout_sha256: null, stderr_sha256: null,
    detail: "Human verification is explicitly deferred to ST-07.", executed_at: at,
  });
  const workspace = workspaces.find((entry) => entry.source_id === verifier.source_id);
  if (workspace === undefined) fail("ST-06 Build & Converge", `Verifier ${verifier.verifier_id} has no selected source workspace`);
  const cwd = safeVerifierCwd(workspace, verifier.cwd!);
  if (verifier.kind === "command") {
    const result = spawnSync(verifier.argv![0]!, verifier.argv!.slice(1), { cwd, encoding: "utf8", timeout: verifier.timeout_ms, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } });
    return evidenceFromCommand(session, request, verifier, result, at, scope);
  }
  if (verifier.kind === "artifact") {
    const check = verifier.artifact_check!;
    const path = resolve(cwd, check.path);
    relativeInside(workspace.worktree_path, path, `artifact verifier ${verifier.verifier_id}`);
    let passed = existsSync(path);
    let detail = passed ? `Artifact exists at ${check.path}.` : `Artifact is missing at ${check.path}.`;
    if (passed && check.assertion === "sha256-equals") { const actual = digest(readFileSync(path)); passed = actual === check.expected; detail = passed ? "Artifact SHA-256 matches." : `Artifact SHA-256 ${actual} does not match.`; }
    if (passed && check.assertion === "content-includes") { passed = readFileSync(path, "utf8").includes(check.expected!); detail = passed ? "Artifact contains the approved text." : "Artifact does not contain the approved text."; }
    return parseVerifierEvidence({ schema_version: 1, artifact: "verifier-evidence", version: 1, intent_id: session.intent_id, session_id: session.session_id, bolt_id: scope === "bolt" ? request.bolt.bolt_id : null, attempt: scope === "bolt" ? request.attempt : null, scope, verifier_id: verifier.verifier_id, verifier_kind: verifier.kind, result: passed ? "passed" : "failed", exit_code: null, stdout_sha256: null, stderr_sha256: null, detail, executed_at: at });
  }
  return runRuntimeVerifier(session, request, verifier, cwd, at, scope);
}

async function executeVerifiers(projectDir: string, recordDir: string, session: BuildSession, request: BoltWorkRequest, verifiers: readonly BuildVerifier[], workspaces: readonly BoltSourceWorkspace[], at: string, scope: "bolt" | "integration"): Promise<{ evidence: VerifierEvidence[]; references: ArtifactReference[] }> {
  const evidence: VerifierEvidence[] = [];
  const references: ArtifactReference[] = [];
  for (const verifier of verifiers) {
    const result = await runVerifier(session, request, verifier, workspaces, at, scope);
    const path = scope === "bolt" ? buildVerifierEvidencePath(recordDir, request.bolt.bolt_id, request.attempt, verifier.verifier_id) : buildIntegrationVerifierEvidencePath(recordDir, verifier.verifier_id, session.session_id);
    const content = serialize(result);
    if (existsSync(path) && readFileSync(path, "utf8") !== content) fail("ST-06 Build & Converge", `immutable Verifier Evidence already differs: ${path}`);
    if (!existsSync(path)) writeFileAtomic(path, content);
    evidence.push(result);
    references.push(artifactReference(projectDir, path, "verifier-evidence", content));
  }
  return { evidence, references };
}

function writeCheckpoint(projectDir: string, recordDir: string, checkpoint: BuildAttemptCheckpoint): ArtifactReference {
  const path = buildAttemptCheckpointPath(recordDir, checkpoint.bolt_id, checkpoint.attempt);
  const content = serialize(checkpoint);
  if (existsSync(path) && readFileSync(path, "utf8") !== content) fail("ST-06 Build & Converge", `immutable attempt ${checkpoint.bolt_id}/${checkpoint.attempt} already differs`);
  if (!existsSync(path)) writeFileAtomic(path, content);
  return artifactReference(projectDir, path, "build-attempt-checkpoint", content);
}

function failureSignature(evidence: readonly VerifierEvidence[], issues: readonly string[]): string {
  return digest(serialize({
    issues: [...issues].sort(),
    verifiers: evidence.filter((entry) => entry.result === "failed").map((entry) => ({ verifier_id: entry.verifier_id, result: entry.result, exit_code: entry.exit_code, stdout_sha256: entry.stdout_sha256, stderr_sha256: entry.stderr_sha256, detail: entry.detail })),
  }));
}

function writeSession(path: string, session: BuildSession): void { writeFileAtomic(path, serialize(parseBuildSession(session))); }

function blockState(projectDir: string, recordDir: string, state: VNextIntentState, plan: StageExecutionPlan, session: BuildSession | null, reason: string, at: string): VNextIntentState {
  if (session !== null) writeSession(buildSessionPath(recordDir), parseBuildSession({ ...session, status: "blocked", blocked_reason: reason, updated_at: at }));
  const blocked: VNextIntentState = { ...state, status: "parked", parked_reason: reason, updated_at: at };
  writeVNextStateAt(recordDir, blocked, plan);
  appendAuditEntry(projectDir, recordDir, "ROUTE_BLOCKED", { Stage: "ST-06", Reason: reason.replace(/[\r\n]+/g, " "), "Decision Authority": "core" });
  return readVNextStateAt(recordDir);
}

function commitAndIntegrate(projectDir: string, recordDir: string, session: BuildSession, request: BoltWorkRequest, changes: readonly RepositoryChange[]): void {
  for (const change of changes) {
    if (change.files.length === 0) continue;
    runGit(change.boltRoot, ["add", "--all"], `cannot stage Bolt ${request.bolt.bolt_id}`);
    runGit(change.boltRoot, ["-c", "user.name=AI-DLC Core", "-c", "user.email=aidlc-core@local", "commit", "-m", `aidlc(${request.bolt.bolt_id}): ${request.bolt.title}`], `cannot commit Bolt ${request.bolt.bolt_id}`);
    const boltBranch = runGit(change.boltRoot, ["branch", "--show-current"], `cannot read Bolt branch ${request.bolt.bolt_id}`);
    runGit(change.repository.integration_worktree, ["merge", "--ff-only", boltBranch], `cannot fast-forward integration branch for ${request.bolt.bolt_id}`);
    appendAuditEntries(projectDir, recordDir, [
      { event: "WORKTREE_MERGED", fields: { Stage: "ST-06", Bolt: request.bolt.bolt_id, Repository: change.repository.repository_id, Branch: boltBranch, "Decision Authority": "core" } },
    ]);
    const remove = gitMaybe(change.repository.repository_root, ["worktree", "remove", "--force", change.boltRoot]);
    if (!remove.ok) fail("ST-06 Build & Converge", `cannot remove completed Bolt worktree: ${remove.output}`);
  }
}

function integrationWorkspaces(session: BuildSession): BoltSourceWorkspace[] {
  return session.repositories.flatMap((repository) => repository.sources.map((source) => ({
    source_id: source.source_id,
    locator: source.locator,
    repository_id: repository.repository_id,
    repository_root: repository.repository_root,
    worktree_path: source.relative_path === "." ? repository.integration_worktree : join(repository.integration_worktree, source.relative_path),
    base_revision: repository.base_revision,
  })));
}

function checkpointReferences(projectDir: string, recordDir: string, contract: BuildContract): ArtifactReference[] {
  return contract.bolts.map((bolt) => {
    const root = join(buildRootDir(recordDir), "bolts", bolt.bolt_id, "attempts");
    if (!existsSync(root)) fail("ST-06 Build & Converge", `Bolt ${bolt.bolt_id} has no attempt checkpoint`);
    const attempts = Array.from({ length: 10_000 }, (_, index) => index + 1).filter((attempt) => existsSync(buildAttemptCheckpointPath(recordDir, bolt.bolt_id, attempt)));
    const last = attempts.at(-1);
    if (last === undefined) fail("ST-06 Build & Converge", `Bolt ${bolt.bolt_id} has no attempt checkpoint`);
    const path = buildAttemptCheckpointPath(recordDir, bolt.bolt_id, last);
    const stored = readCanonical(path, parseBuildAttemptCheckpoint);
    if (stored.value.outcome !== "passed") fail("ST-06 Build & Converge", `Bolt ${bolt.bolt_id} is not passed`);
    return artifactReference(projectDir, path, "build-attempt-checkpoint", stored.content);
  });
}

async function completeCandidate(projectDir: string, recordDir: string, state: VNextIntentState, plan: StageExecutionPlan, session: BuildSession, contract: BuildContract, request: BoltWorkRequest, at: string): Promise<{ candidate: RunnableCandidate; candidateRef: ArtifactReference; currentRef: ArtifactReference; state: VNextIntentState }> {
  const integrationIds = new Set(contract.integration_contract?.verifier_ids ?? []);
  const integrationVerifiers = contract.verifiers.filter((entry) => integrationIds.has(entry.verifier_id));
  const integration = await executeVerifiers(projectDir, recordDir, session, request, integrationVerifiers, integrationWorkspaces(session), at, "integration");
  const failed = integration.evidence.filter((entry) => entry.result === "failed");
  if (failed.length > 0) {
    const reason = `Integration verification failed: ${failed.map((entry) => entry.verifier_id).join(", ")}. A Build Contract revision is required before more target paths can be changed.`;
    blockState(projectDir, recordDir, state, plan, session, reason, at);
    fail("ST-06 Build & Converge", reason);
  }
  const sourceResults = session.repositories.map((repository) => {
    const revision = runGit(repository.integration_worktree, ["rev-parse", "HEAD"], `cannot read candidate revision for ${repository.repository_id}`);
    const changed = runGit(repository.integration_worktree, ["diff", "--name-only", `${repository.base_revision}..${revision}`], `cannot read candidate diff for ${repository.repository_id}`).split("\n").filter(Boolean).map(portable).sort();
    if (changed.length === 0) fail("ST-06 Build & Converge", `Repository ${repository.repository_id} has no candidate changes`);
    return { repository_id: repository.repository_id, source_ids: repository.sources.map((entry) => entry.source_id), source_locator: repository.sources.map((entry) => entry.locator).join(","), base_revision: repository.base_revision, candidate_revision: revision, integration_branch: repository.integration_branch, changed_files: changed };
  });
  const checkpoints = checkpointReferences(projectDir, recordDir, contract);
  const candidate = parseRunnableCandidate({ schema_version: 1, artifact: "runnable-candidate", version: 1, intent_id: state.intent_id, session_id: session.session_id, disposition: "execute", build_contract_ref: session.build_contract_ref, source_results: sourceResults, bolt_checkpoint_refs: checkpoints, integration_verifier_evidence_refs: integration.references, created_at: at });
  const candidatePath = buildRunnableCandidatePath(recordDir);
  const candidateContent = serialize(candidate);
  if (existsSync(candidatePath) && readFileSync(candidatePath, "utf8") !== candidateContent) {
    if (loadFeedbackReentry(projectDir, recordDir, state) === null) fail("ST-06 Build & Converge", "Runnable Candidate already differs without verified feedback reentry");
    writeFileAtomic(candidatePath, candidateContent);
  } else if (!existsSync(candidatePath)) writeFileAtomic(candidatePath, candidateContent);
  const candidateRef = artifactReference(projectDir, candidatePath, "runnable-candidate", candidateContent);
  const current = parseBuildCurrent({ schema_version: 1, artifact: "build-current", version: 1, intent_id: state.intent_id, disposition: "execute", build_contract_current_ref: session.build_contract_current_ref, runnable_candidate_ref: candidateRef, reason: "All Core-selected Bolts and integration verifiers passed.", updated_at: at });
  const currentPath = buildCurrentPath(recordDir);
  const currentContent = serialize(current);
  if (existsSync(currentPath) && readFileSync(currentPath, "utf8") !== currentContent) {
    if (loadFeedbackReentry(projectDir, recordDir, state) === null) fail("ST-06 Build & Converge", "Build Current already differs without verified feedback reentry");
    writeFileAtomic(currentPath, currentContent);
  } else if (!existsSync(currentPath)) writeFileAtomic(currentPath, currentContent);
  const currentRef = artifactReference(projectDir, currentPath, "build-current", currentContent);
  const completedSession = parseBuildSession({ ...session, status: "completed", current_bolt_id: null, last_failure_signature: null, same_failure_count: 0, blocked_reason: null, updated_at: at });
  writeSession(buildSessionPath(recordDir), completedSession);
  const proposal = stageProposal("ST-06", "execute", session.session_id, current.reason, [candidateRef, currentRef]);
  const revised = revisePlanForResult(projectDir, plan, loadBuildConvergeStageContract(), proposal);
  const advanced = advanceToSt07(projectDir, recordDir, state, plan, revised, current, currentRef, proposal.evidence, at);
  return { candidate, candidateRef, currentRef, state: advanced };
}

async function verifyBuildAttemptLocked(projectDir: string, recordDir: string, options: BuildAttemptVerifyOptions): Promise<BuildAttemptVerifyResult> {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-06") fail("ST-06 Build & Converge", `current Stage must be ST-06, found ${state.current_stage}`);
  const inputs = loadBuildInputs(projectDir, recordDir, state);
  if (inputs.contract === null || inputs.contractRef === null || inputs.current.disposition === "not_applicable") fail("ST-06 Build & Converge", "there is no executable Build Contract");
  const session = readCanonical(buildSessionPath(recordDir), parseBuildSession).value;
  if (session.status !== "active") fail("ST-06 Build & Converge", session.blocked_reason ?? `session is ${session.status}`);
  if (session.current_bolt_id !== options.boltId) fail("ST-06 Build & Converge", `Core selected ${session.current_bolt_id}, not ${options.boltId}`);
  const requestPath = buildBoltWorkRequestPath(recordDir, options.boltId);
  const requestStored = readCanonical(requestPath, parseBoltWorkRequest);
  const request = requestStored.value;
  if (request.session_id !== session.session_id || request.bolt.bolt_id !== options.boltId || !refsEqual(request.build_contract_ref, inputs.contractRef)) fail("ST-06 Build & Converge", "Bolt Work Request is stale or inconsistent");
  const at = options.verifiedAt ?? new Date().toISOString();
  let collected: ReturnType<typeof collectChanges>;
  try { collected = collectChanges(projectDir, session, request); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    blockState(projectDir, recordDir, state, plan, session, reason, at);
    throw error;
  }
  const verifierRun = await executeVerifiers(projectDir, recordDir, session, request, request.verifiers, request.source_workspaces, at, "bolt");
  const issues = collected.changedFiles.length === 0 ? ["The Bolt produced no repository changes."] : [];
  const failed = verifierRun.evidence.filter((entry) => entry.result === "failed");
  const passed = failed.length === 0 && issues.length === 0;
  const signature = passed ? null : failureSignature(verifierRun.evidence, issues);
  const outcome = passed ? "passed" : "failed";
  const reason = passed ? "All Bolt verifiers passed and changed paths match the Build Contract." : [...issues, ...failed.map((entry) => `${entry.verifier_id}: ${entry.detail}`)].join(" ");
  const checkpoint = parseBuildAttemptCheckpoint({ schema_version: 1, artifact: "build-attempt-checkpoint", version: 1, intent_id: state.intent_id, session_id: session.session_id, build_contract_ref: session.build_contract_ref, bolt_id: request.bolt.bolt_id, attempt: request.attempt, outcome, changed_files: collected.changedFiles, verifier_evidence_refs: verifierRun.references, failure_signature: signature, reason, created_at: at });
  const checkpointReference = writeCheckpoint(projectDir, recordDir, checkpoint);
  if (!passed) {
    const count = session.last_failure_signature === signature ? session.same_failure_count + 1 : 1;
    const blocked = count >= MAX_IDENTICAL_FAILURES;
    const updated = parseBuildSession({ ...session, status: blocked ? "blocked" : "active", last_failure_signature: signature, same_failure_count: count, blocked_reason: blocked ? `The same failure signature occurred ${MAX_IDENTICAL_FAILURES} times for ${request.bolt.bolt_id}.` : null, updated_at: at });
    writeSession(buildSessionPath(recordDir), updated);
    appendAuditEntry(projectDir, recordDir, "BOLT_FAILED", { Stage: "ST-06", Bolt: request.bolt.bolt_id, Attempt: String(request.attempt), "Failure Signature": signature!, Count: String(count), "Decision Authority": "core" });
    if (blocked) {
      const blockedState = blockState(projectDir, recordDir, state, plan, updated, updated.blocked_reason!, at);
      return { outcome: "blocked", checkpoint, checkpointReference, request: null, requestReference: null, candidate: null, candidateReference: null, state: blockedState };
    }
    const next = buildRequest(projectDir, recordDir, updated, inputs.contract, request.bolt, request.attempt + 1, at);
    const { parked_reason: _parked, ...ready } = state;
    writeVNextStateAt(recordDir, { ...ready, status: "ready", updated_at: at }, plan);
    return { outcome: "retry", checkpoint, checkpointReference, request: next.request, requestReference: next.reference, candidate: null, candidateReference: null, state: readVNextStateAt(recordDir) };
  }
  commitAndIntegrate(projectDir, recordDir, session, request, collected.repositoryChanges);
  const completedIds = [...session.completed_bolt_ids, request.bolt.bolt_id];
  appendAuditEntry(projectDir, recordDir, "BOLT_COMPLETED", { Stage: "ST-06", Bolt: request.bolt.bolt_id, Attempt: String(request.attempt), Checkpoint: checkpointReference.sha256, "Decision Authority": "core" });
  const nextBolt = readyBolt(inputs.contract, completedIds);
  if (nextBolt !== null) {
    const updated = parseBuildSession({ ...session, completed_bolt_ids: completedIds, current_bolt_id: nextBolt.bolt_id, last_failure_signature: null, same_failure_count: 0, blocked_reason: null, updated_at: at });
    writeSession(buildSessionPath(recordDir), updated);
    const next = buildRequest(projectDir, recordDir, updated, inputs.contract, nextBolt, 1, at);
    appendAuditEntry(projectDir, recordDir, "BOLT_STARTED", { Stage: "ST-06", Bolt: nextBolt.bolt_id, Attempt: "1", "Decision Authority": "core" });
    return { outcome: "next_bolt", checkpoint, checkpointReference, request: next.request, requestReference: next.reference, candidate: null, candidateReference: null, state: readVNextStateAt(recordDir) };
  }
  const updated = parseBuildSession({ ...session, completed_bolt_ids: completedIds, current_bolt_id: null, last_failure_signature: null, same_failure_count: 0, blocked_reason: null, updated_at: at });
  writeSession(buildSessionPath(recordDir), updated);
  const completed = await completeCandidate(projectDir, recordDir, state, plan, updated, inputs.contract, request, at);
  return { outcome: "candidate", checkpoint, checkpointReference, request: null, requestReference: null, candidate: completed.candidate, candidateReference: completed.candidateRef, state: completed.state };
}

export async function verifyBuildAttempt(projectDir: string, options: BuildAttemptVerifyOptions): Promise<BuildAttemptVerifyResult> {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLockAsync(projectRoot, async () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try { return await verifyBuildAttemptLocked(projectRoot, recordDir, options); }
    catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", { Stage: "ST-06", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" });
      throw error;
    }
  });
}

export async function main(argv: string[]): Promise<void> {
  const [command, projectDir, argument, ...rest] = argv;
  const validPrepare = command === "prepare" && projectDir !== undefined && argument === undefined;
  const validVerify = command === "verify" && projectDir !== undefined && argument !== undefined && rest.length === 0;
  const validReuse = command === "reuse" && projectDir !== undefined && argument !== undefined && rest.length === 1;
  if (!validPrepare && !validVerify && !validReuse) {
    console.error("Usage: aidlc build prepare <project-dir>\n       aidlc build verify <project-dir> <bolt-id>\n       aidlc build reuse <project-dir> <runnable-candidate.json> <reason>");
    process.exitCode = 1;
    return;
  }
  try {
    if (projectDir === undefined) throw new Error("project directory is required");
    const result = command === "prepare"
      ? prepareBuildConverge(projectDir)
      : command === "verify"
      ? await verifyBuildAttempt(projectDir, { boltId: argument! })
      : reuseRunnableCandidate(projectDir, { candidatePath: argument!, reason: rest[0]! });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
