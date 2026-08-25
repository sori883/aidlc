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
  parseArchitectureCurrent,
  parseArchitectureDecision,
} from "./aidlc-vnext-architecture-contract.ts";
import { architectureCurrentPath } from "./aidlc-vnext-architecture.ts";
import {
  parseBuildContract,
  parseBuildContractApproval,
  parseBuildContractCandidate,
  parseBuildContractCurrent,
  parseBuildContractProposal,
  parseBuildContractWorkRequest,
  renderBuildContractReviewHtml,
  type BoltDefinition,
  type BuildContract,
  type BuildContractApproval,
  type BuildContractCandidate,
  type BuildContractCurrent,
  type BuildContractProposal,
  type BuildContractWorkRequest,
  type BuildTarget,
  type BuildTargetSource,
} from "./aidlc-vnext-build-contract-contract.ts";
import {
  parseCurrentContext,
  parseSystemMap,
  type SystemMap,
} from "./aidlc-vnext-orient-contract.ts";
import {
  parseRequirementsCurrent,
  parseRequirementsDefinition,
  type RequirementsDefinition,
} from "./aidlc-vnext-requirements-contract.ts";
import {
  requirementsCurrentPath,
  requirementsRevisionPath,
} from "./aidlc-vnext-requirements.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextPlanAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export interface BuildContractPrepareOptions { preparedAt?: string }
export interface BuildContractReviewOptions { reviewedAt?: string }
export interface BuildContractApproveOptions {
  candidateSha256: string;
  reason: string;
  decidedAt?: string;
}

export interface BuildContractPrepareResult {
  execution: "prepared" | "reused";
  request: BuildContractWorkRequest;
  reference: ArtifactReference;
}

export interface BuildContractReviewResult {
  candidate: BuildContractCandidate;
  candidateReference: ArtifactReference;
  reviewReference: ArtifactReference;
  state: VNextIntentState;
}

export interface BuildContractApproveResult {
  contract: BuildContract | null;
  reference: ArtifactReference | null;
  current: BuildContractCurrent;
  currentReference: ArtifactReference;
  approval: BuildContractApproval;
  approvalReference: ArtifactReference;
  plan: StageExecutionPlan;
  state: VNextIntentState;
}

const STAGE_CONTRACT_PATH = join(runtimeCoreDir(), "aidlc-common/stages/st-05-build-contract.json");

function fail(context: string, message: string): never { throw new Error(`${context}: ${message}`) }
function digest(content: string | Uint8Array): string { return `sha256:${createHash("sha256").update(content).digest("hex")}` }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

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
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("ST-05 Build Contract", `path is outside the project: ${resolve(path)}`);
  }
  return rel === "" ? "." : rel.split(sep).join("/");
}

function artifactReference(projectDir: string, path: string, artifact: string, content?: string): ArtifactReference {
  const bytes = content ?? readFileSync(path, "utf8");
  return parseArtifactReference({
    artifact,
    version: 1,
    source_of_truth: portableProjectPath(projectDir, path),
    sha256: digest(bytes),
  });
}

function readCanonical<T>(path: string, parser: (value: unknown, context?: string) => T): { value: T; content: string } {
  const content = readFileSync(path, "utf8");
  let value: T;
  try { value = parser(JSON.parse(content), path); }
  catch (error) { fail("ST-05 Build Contract", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (content !== serialize(value)) fail("ST-05 Build Contract", `artifact is not canonical: ${path}`);
  return { value, content };
}

function referencesEqual(left: ArtifactReference | null, right: ArtifactReference | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function includesReference(references: readonly ArtifactReference[], expected: ArtifactReference): boolean {
  return references.some((reference) => referencesEqual(reference, expected));
}

export function buildContractRootDir(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "build-contract");
}
export function buildContractWorkRequestPath(recordDir: string): string {
  return join(buildContractRootDir(recordDir), "build-contract-work-request.json");
}
export function buildContractCandidatePath(recordDir: string): string {
  return join(buildContractRootDir(recordDir), "review", "build-contract-candidate.json");
}
export function buildContractReviewPath(recordDir: string): string {
  return join(buildContractRootDir(recordDir), "review", "build-contract-review.html");
}
export function buildContractApprovalPath(recordDir: string): string {
  return join(buildContractRootDir(recordDir), "review", "build-contract-approval.json");
}
export function buildContractCurrentPath(recordDir: string): string {
  return join(buildContractRootDir(recordDir), "current.json");
}
export function buildContractRevisionPath(recordDir: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) fail("ST-05 Build Contract", "revision must be a positive integer");
  return join(buildContractRootDir(recordDir), "revisions", revision.toString().padStart(6, "0"), "build-contract.json");
}

export function loadBuildContractStageContract(path = STAGE_CONTRACT_PATH): VNextStageContract {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { fail("ST-05 Contract", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  const contract = parseVNextStageContract(value, path);
  if (contract.stage_id !== "ST-05" || contract.name !== "Build Contract") {
    fail("ST-05 Contract", "must define ST-05 Build Contract");
  }
  return contract;
}

interface BuildInputs {
  requirementsCurrentRef: ArtifactReference;
  requirementsRef: ArtifactReference;
  requirements: RequirementsDefinition;
  architectureCurrentRef: ArtifactReference;
  architectureRef: ArtifactReference | null;
  currentContextRef: ArtifactReference;
  systemMapRef: ArtifactReference;
  effectivePolicyRef: ArtifactReference;
  requirementIds: string[];
  targetSources: BuildTargetSource[];
  systemMap: SystemMap;
}

function loadBuildInputs(projectDir: string, recordDir: string, state: VNextIntentState): BuildInputs {
  const currentRequirementsPath = requirementsCurrentPath(recordDir);
  const requirementsCurrent = readCanonical(currentRequirementsPath, parseRequirementsCurrent);
  if (requirementsCurrent.value.intent_id !== state.intent_id) fail("ST-05 Build Contract", "Requirements Current Intent does not match State");
  const requirementsCurrentRef = artifactReference(projectDir, currentRequirementsPath, "requirements-current", requirementsCurrent.content);
  const requirementsRef = requirementsCurrent.value.requirements_ref;
  verifyProjectArtifactReference(projectDir, requirementsRef);
  const requirementsPath = requirementsRevisionPath(recordDir, requirementsCurrent.value.current_revision);
  if (resolve(projectDir, requirementsRef.source_of_truth) !== resolve(requirementsPath)) {
    fail("ST-05 Build Contract", "Requirements Current does not point to its revision path");
  }
  const requirements = readCanonical(requirementsPath, parseRequirementsDefinition).value;

  const architecturePath = architectureCurrentPath(recordDir);
  const architectureCurrent = readCanonical(architecturePath, parseArchitectureCurrent);
  if (architectureCurrent.value.intent_id !== state.intent_id) fail("ST-05 Build Contract", "Architecture Current Intent does not match State");
  const architectureCurrentRef = artifactReference(projectDir, architecturePath, "architecture-current", architectureCurrent.content);
  const architectureRef = architectureCurrent.value.architecture_ref;
  if (architectureRef !== null) {
    verifyProjectArtifactReference(projectDir, architectureRef);
    readCanonical(resolve(projectDir, architectureRef.source_of_truth), parseArchitectureDecision);
  }
  if (!referencesEqual(architectureCurrent.value.requirements_ref, requirementsRef)) {
    fail("ST-05 Build Contract", "Architecture Current and Requirements Current disagree");
  }

  const currentContextRef = architectureCurrent.value.current_context_ref;
  verifyProjectArtifactReference(projectDir, currentContextRef);
  const context = readCanonical(resolve(projectDir, currentContextRef.source_of_truth), parseCurrentContext).value;
  if (context.intent_id !== state.intent_id) fail("ST-05 Build Contract", "Current Context Intent does not match State");
  const systemMapRef = context.system_map_ref;
  if (!referencesEqual(systemMapRef, architectureCurrent.value.system_map_ref)) fail("ST-05 Build Contract", "Architecture and Current Context System Map references disagree");
  verifyProjectArtifactReference(projectDir, systemMapRef);
  const systemMap = readCanonical(resolve(projectDir, systemMapRef.source_of_truth), parseSystemMap).value;
  const effectivePolicyRef = architectureCurrent.value.effective_policy_ref;
  if (!referencesEqual(effectivePolicyRef, state.policy_snapshot)) fail("ST-05 Build Contract", "Effective Policy does not match State");
  verifyProjectArtifactReference(projectDir, effectivePolicyRef);
  const requirementIds = [
    ...requirements.functional_requirements,
    ...requirements.quality_requirements,
    ...requirements.constraints,
    ...requirements.invariants,
  ].map((entry) => entry.id);
  const targetSources = systemMap.source_snapshots
    .filter((source) => source.source_type !== "external")
    .map((source) => ({ source_id: source.source_id, locator: source.locator }));
  return {
    requirementsCurrentRef,
    requirementsRef,
    requirements,
    architectureCurrentRef,
    architectureRef,
    currentContextRef,
    systemMapRef,
    effectivePolicyRef,
    requirementIds,
    targetSources,
    systemMap,
  };
}

function readBuildCurrent(projectDir: string, recordDir: string, intentId: string): { current: BuildContractCurrent; localRevision: number | null } | null {
  const path = buildContractCurrentPath(recordDir);
  if (!existsSync(path)) return null;
  const current = readCanonical(path, parseBuildContractCurrent).value;
  if (current.intent_id !== intentId) fail("ST-05 Build Contract", "Build Contract Current Intent does not match State");
  let localRevision: number | null = null;
  if (current.build_contract_ref !== null) {
    verifyProjectArtifactReference(projectDir, current.build_contract_ref);
    const contract = readCanonical(resolve(projectDir, current.build_contract_ref.source_of_truth), parseBuildContract).value;
    if (contract.intent_id === intentId && resolve(buildContractRevisionPath(recordDir, contract.revision)) === resolve(projectDir, current.build_contract_ref.source_of_truth)) {
      localRevision = contract.revision;
    }
  }
  return { current, localRevision };
}

function sameRequestInputs(request: BuildContractWorkRequest, state: VNextIntentState, inputs: BuildInputs): boolean {
  return request.intent_id === state.intent_id &&
    referencesEqual(request.requirements_current_ref, inputs.requirementsCurrentRef) &&
    referencesEqual(request.requirements_ref, inputs.requirementsRef) &&
    referencesEqual(request.architecture_current_ref, inputs.architectureCurrentRef) &&
    referencesEqual(request.architecture_ref, inputs.architectureRef) &&
    referencesEqual(request.current_context_ref, inputs.currentContextRef) &&
    referencesEqual(request.system_map_ref, inputs.systemMapRef) &&
    referencesEqual(request.effective_policy_ref, inputs.effectivePolicyRef) &&
    JSON.stringify(request.requirement_ids) === JSON.stringify(inputs.requirementIds) &&
    JSON.stringify(request.target_sources) === JSON.stringify(inputs.targetSources);
}

function prepareBuildContractLocked(projectDir: string, recordDir: string, options: BuildContractPrepareOptions): BuildContractPrepareResult {
  loadBuildContractStageContract();
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-05") fail("ST-05 Build Contract", `current Stage must be ST-05, found ${state.current_stage}`);
  const inputs = loadBuildInputs(projectDir, recordDir, state);
  const current = readBuildCurrent(projectDir, recordDir, state.intent_id);
  const baseRevision = current?.localRevision ?? null;
  const baseBuildContractRef = current?.current.build_contract_ref ?? null;
  const path = buildContractWorkRequestPath(recordDir);
  if (existsSync(path)) {
    const stored = readCanonical(path, parseBuildContractWorkRequest);
    if (sameRequestInputs(stored.value, state, inputs) && stored.value.base_revision === baseRevision && referencesEqual(stored.value.base_build_contract_ref, baseBuildContractRef)) {
      return { execution: "reused", request: stored.value, reference: artifactReference(projectDir, path, "build-contract-work-request", stored.content) };
    }
  }
  const preparedAt = options.preparedAt ?? new Date().toISOString();
  const request = parseBuildContractWorkRequest({
    schema_version: 1,
    artifact: "build-contract-work-request",
    version: 1,
    intent_id: state.intent_id,
    stage_id: "ST-05",
    requirements_current_ref: inputs.requirementsCurrentRef,
    requirements_ref: inputs.requirementsRef,
    architecture_current_ref: inputs.architectureCurrentRef,
    architecture_ref: inputs.architectureRef,
    current_context_ref: inputs.currentContextRef,
    system_map_ref: inputs.systemMapRef,
    effective_policy_ref: inputs.effectivePolicyRef,
    base_revision: baseRevision,
    base_build_contract_ref: baseBuildContractRef,
    requirement_ids: inputs.requirementIds,
    target_sources: inputs.targetSources,
    requested_outputs: ["build-contract-proposal"],
    rules: [
      "Assess every pinned requirement exactly once for build impact.",
      "Cover every impacted requirement with a change contract and every constraint or invariant with an acceptance criterion and verifier.",
      "Propose dependency-based Bolts; do not use a fixed UI, frontend, backend, or walking-skeleton slice.",
      "Represent command verifiers as argv arrays and repository-relative cwd; ST-05 validates but never executes them.",
      "Give every verifier an explicit timeout, approved exit codes, and exactly one kind-specific machine check; runtime probes are localhost-only and human-at-st07 remains deferred.",
      "Do not assign execution batches, approval fields, Core authority, credentials, implementation code, test code, or routes.",
      "Core derives Bolt batches, generates the static human review, binds approval to candidate SHA-256, and owns the fixed transition.",
    ],
    created_at: preparedAt,
  });
  const content = serialize(request);
  writeFileAtomic(path, content);
  const { parked_reason: _parkedReason, ...ready } = state;
  writeVNextStateAt(recordDir, { ...ready, status: "ready", updated_at: preparedAt }, plan);
  return { execution: "prepared", request, reference: artifactReference(projectDir, path, "build-contract-work-request", content) };
}

export function prepareBuildContract(projectDir: string, options: BuildContractPrepareOptions = {}): BuildContractPrepareResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try { return prepareBuildContractLocked(projectRoot, recordDir, options); }
    catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", { Stage: "ST-05", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" });
      throw error;
    }
  });
}

function safeRelativePath(value: string, context: string): string {
  if (value === "" || value === ".") return ".";
  const portable = value.replaceAll("\\", "/");
  if (isAbsolute(value) || portable.startsWith("/") || portable.split("/").some((part) => part === ".." || part === "")) {
    fail("ST-05 Build Contract", `${context} must stay inside its repository source`);
  }
  return portable;
}

function validateTargets(projectDir: string, request: BuildContractWorkRequest, targets: readonly BuildTarget[], context: string): void {
  const sources = new Map(request.target_sources.map((source) => [source.source_id, source]));
  for (const target of targets) {
    const source = sources.get(target.source_id);
    if (source === undefined) fail("ST-05 Build Contract", `${context} references unknown source_id: ${target.source_id}`);
    const path = safeRelativePath(target.path, `${context} target path`);
    const sourceRoot = resolve(projectDir, source.locator);
    const absolute = resolve(sourceRoot, path);
    const rel = relative(sourceRoot, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("ST-05 Build Contract", `${context} target crosses repository boundary`);
  }
}

function validateCoverage(request: BuildContractWorkRequest, proposal: BuildContractProposal): void {
  const expected = new Set(request.requirement_ids);
  const actual = new Set(proposal.requirement_assessments.map((entry) => entry.requirement_id));
  for (const id of expected) if (!actual.has(id)) fail("ST-05 Build Contract", `requirement coverage is missing: ${id}`);
  for (const id of actual) if (!expected.has(id)) fail("ST-05 Build Contract", `assessment references unknown requirement: ${id}`);
}

function topologicalBatches(bolts: readonly BoltDefinition[]): string[][] {
  const ids = new Set(bolts.map((bolt) => bolt.bolt_id));
  for (const bolt of bolts) {
    for (const dependency of bolt.depends_on) {
      if (!ids.has(dependency)) fail("ST-05 Build Contract", `Bolt ${bolt.bolt_id} has dangling dependency: ${dependency}`);
      if (dependency === bolt.bolt_id) fail("ST-05 Build Contract", `Bolt ${bolt.bolt_id} cannot depend on itself`);
    }
  }
  const remaining = new Map(bolts.map((bolt) => [bolt.bolt_id, new Set(bolt.depends_on)]));
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id).sort();
    if (ready.length === 0) fail("ST-05 Build Contract", "Bolt DAG contains a cycle");
    batches.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const dependencies of remaining.values()) for (const id of ready) dependencies.delete(id);
  }
  return batches;
}

function dependsTransitively(bolts: ReadonlyMap<string, BoltDefinition>, from: string, on: string, seen = new Set<string>()): boolean {
  if (from === on) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return bolts.get(from)?.depends_on.some((dependency) => dependency === on || dependsTransitively(bolts, dependency, on, seen)) ?? false;
}

function targetOverlap(left: BuildTarget, right: BuildTarget): boolean {
  if (left.source_id !== right.source_id) return false;
  const a = left.path.replace(/\/$/, "");
  const b = right.path.replace(/\/$/, "");
  if (a === "." || b === ".") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function validateChangeContractDag(proposal: BuildContractProposal): void {
  const contracts = new Map(proposal.change_contracts.map((entry) => [entry.contract_id, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail("ST-05 Build Contract", "Change Contract dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of contracts.get(id)?.depends_on_contract_ids ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of contracts.keys()) visit(id);
}

function validateExecute(projectDir: string, request: BuildContractWorkRequest, proposal: BuildContractProposal): string[][] {
  const impacted = new Set(proposal.requirement_assessments.filter((entry) => entry.build_impact).map((entry) => entry.requirement_id));
  if (impacted.size === 0) fail("ST-05 Build Contract", "execute requires at least one build-impact requirement");
  const contractIds = new Set(proposal.change_contracts.map((entry) => entry.contract_id));
  const criterionIds = new Set(proposal.acceptance_criteria.map((entry) => entry.criterion_id));
  const verifierIds = new Set(proposal.verifiers.map((entry) => entry.verifier_id));
  const coveredRequirements = new Set(proposal.change_contracts.flatMap((entry) => entry.requirement_ids));
  for (const id of impacted) if (!coveredRequirements.has(id)) fail("ST-05 Build Contract", `impacted requirement lacks a change contract: ${id}`);
  for (const contract of proposal.change_contracts) {
    validateTargets(projectDir, request, contract.targets, `Change Contract ${contract.contract_id}`);
    for (const id of contract.requirement_ids) if (!request.requirement_ids.includes(id)) fail("ST-05 Build Contract", `Change Contract ${contract.contract_id} references unknown requirement: ${id}`);
    for (const id of contract.depends_on_contract_ids) if (!contractIds.has(id)) fail("ST-05 Build Contract", `Change Contract ${contract.contract_id} has dangling dependency: ${id}`);
  }
  validateChangeContractDag(proposal);
  for (const criterion of proposal.acceptance_criteria) {
    for (const id of criterion.requirement_ids) if (!request.requirement_ids.includes(id)) fail("ST-05 Build Contract", `Acceptance Criterion ${criterion.criterion_id} references unknown requirement: ${id}`);
    for (const id of criterion.verifier_ids) if (!verifierIds.has(id)) fail("ST-05 Build Contract", `Acceptance Criterion ${criterion.criterion_id} has dangling verifier: ${id}`);
    const machines = criterion.verifier_ids.map((id) => proposal.verifiers.find((entry) => entry.verifier_id === id)!).filter((entry) => entry.kind !== "human-at-st07");
    if (machines.length === 0) {
      const humans = criterion.verifier_ids.map((id) => proposal.verifiers.find((entry) => entry.verifier_id === id)!);
      if (humans.some((entry) => entry.human_exception_ref === null)) fail("ST-05 Build Contract", `Acceptance Criterion ${criterion.criterion_id} lacks machine verification and approved human exception`);
    }
  }
  for (const id of request.requirement_ids.filter((id) => id.startsWith("CON-") || id.startsWith("INV-"))) {
    if (!proposal.acceptance_criteria.some((criterion) => criterion.requirement_ids.includes(id))) fail("ST-05 Build Contract", `constraint or invariant lacks an acceptance criterion: ${id}`);
  }
  for (const verifier of proposal.verifiers) {
    if (verifier.human_exception_ref !== null) {
      if (verifier.human_exception_ref.artifact !== "human-decision") fail("ST-05 Build Contract", `Verifier ${verifier.verifier_id} exception must be a human-decision`);
      verifyProjectArtifactReference(projectDir, verifier.human_exception_ref);
    }
    if (verifier.source_id !== null && verifier.cwd !== null) {
      const cwd = safeRelativePath(verifier.cwd, `Verifier ${verifier.verifier_id} cwd`);
      validateTargets(projectDir, request, [{ source_id: verifier.source_id, path: cwd }], `Verifier ${verifier.verifier_id}`);
      if (verifier.kind === "artifact") {
        const artifactPath = safeRelativePath(verifier.artifact_check!.path, `Verifier ${verifier.verifier_id} artifact path`);
        validateTargets(projectDir, request, [{ source_id: verifier.source_id, path: cwd === "." ? artifactPath : `${cwd}/${artifactPath}` }], `Verifier ${verifier.verifier_id}`);
      }
    }
    if (verifier.kind === "command") {
      if (verifier.argv!.some((arg) => /(?:--?(?:password|passwd|token|api[-_]?key|secret))(?:=|$)/i.test(arg))) fail("ST-05 Build Contract", `Verifier ${verifier.verifier_id} argv may contain a secret-bearing option`);
    }
    if (verifier.kind === "runtime" && verifier.runtime_check!.start_argv.some((arg) => /(?:--?(?:password|passwd|token|api[-_]?key|secret))(?:=|$)/i.test(arg))) {
      fail("ST-05 Build Contract", `Verifier ${verifier.verifier_id} start_argv may contain a secret-bearing option`);
    }
  }
  const batches = topologicalBatches(proposal.bolts);
  const bolts = new Map(proposal.bolts.map((bolt) => [bolt.bolt_id, bolt]));
  const contractOwner = new Map<string, string>();
  const criterionOwner = new Map<string, string>();
  for (const bolt of proposal.bolts) {
    validateTargets(projectDir, request, bolt.targets, `Bolt ${bolt.bolt_id}`);
    for (const id of bolt.contract_ids) {
      if (!contractIds.has(id)) fail("ST-05 Build Contract", `Bolt ${bolt.bolt_id} has dangling contract: ${id}`);
      if (contractOwner.has(id)) fail("ST-05 Build Contract", `Change Contract ${id} belongs to more than one Bolt`);
      contractOwner.set(id, bolt.bolt_id);
    }
    for (const id of bolt.acceptance_criterion_ids) {
      if (!criterionIds.has(id)) fail("ST-05 Build Contract", `Bolt ${bolt.bolt_id} has dangling acceptance criterion: ${id}`);
      if (criterionOwner.has(id)) fail("ST-05 Build Contract", `Acceptance Criterion ${id} belongs to more than one Bolt`);
      criterionOwner.set(id, bolt.bolt_id);
    }
    const ownedTargets = proposal.change_contracts.filter((entry) => bolt.contract_ids.includes(entry.contract_id)).flatMap((entry) => entry.targets);
    for (const target of ownedTargets) if (!bolt.targets.some((entry) => entry.source_id === target.source_id && entry.path === target.path)) fail("ST-05 Build Contract", `Bolt ${bolt.bolt_id} omits a Change Contract target`);
  }
  for (const id of contractIds) if (!contractOwner.has(id)) fail("ST-05 Build Contract", `orphan Change Contract is not assigned to a Bolt: ${id}`);
  for (const id of criterionIds) if (!criterionOwner.has(id)) fail("ST-05 Build Contract", `orphan Acceptance Criterion is not assigned to a Bolt: ${id}`);
  for (const contract of proposal.change_contracts) {
    const owner = contractOwner.get(contract.contract_id)!;
    for (const dependency of contract.depends_on_contract_ids) {
      const dependencyOwner = contractOwner.get(dependency)!;
      if (owner !== dependencyOwner && !dependsTransitively(bolts, owner, dependencyOwner)) fail("ST-05 Build Contract", `Change Contract dependency ${contract.contract_id} -> ${dependency} is not backed by the Bolt DAG`);
    }
  }
  for (let leftIndex = 0; leftIndex < proposal.bolts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < proposal.bolts.length; rightIndex += 1) {
      const left = proposal.bolts[leftIndex]!;
      const right = proposal.bolts[rightIndex]!;
      if (!dependsTransitively(bolts, left.bolt_id, right.bolt_id) && !dependsTransitively(bolts, right.bolt_id, left.bolt_id) && left.targets.some((a) => right.targets.some((b) => targetOverlap(a, b)))) {
        fail("ST-05 Build Contract", `parallel Bolts ${left.bolt_id} and ${right.bolt_id} have conflicting target paths`);
      }
    }
  }
  const integration = proposal.integration_contract!;
  for (const id of integration.acceptance_criterion_ids) if (!criterionIds.has(id)) fail("ST-05 Build Contract", `Integration Contract has dangling acceptance criterion: ${id}`);
  for (const id of integration.verifier_ids) if (!verifierIds.has(id)) fail("ST-05 Build Contract", `Integration Contract has dangling verifier: ${id}`);
  return batches;
}

function validateNotApplicable(request: BuildContractWorkRequest, proposal: BuildContractProposal): string[][] {
  const impacted = proposal.requirement_assessments.find((entry) => entry.build_impact);
  if (impacted !== undefined) fail("ST-05 Build Contract", `not_applicable requires build_impact=false for ${impacted.requirement_id}`);
  for (const required of [request.requirements_ref, request.architecture_current_ref]) {
    if (!includesReference(proposal.evidence, required)) fail("ST-05 Build Contract", `not_applicable Evidence must pin ${required.artifact}`);
  }
  return [];
}

function validateReuse(projectDir: string, request: BuildContractWorkRequest, proposal: BuildContractProposal): string[][] {
  const reference = proposal.reuse_ref!;
  if (reference.artifact !== "build-contract") fail("ST-05 Build Contract", "reuse_ref must be a build-contract");
  if (!includesReference(proposal.evidence, reference)) fail("ST-05 Build Contract", "reuse Evidence must include the Build Contract");
  verifyProjectArtifactReference(projectDir, reference);
  const contract = readCanonical(resolve(projectDir, reference.source_of_truth), parseBuildContract).value;
  for (const [label, actual, expected] of [
    ["Requirements", contract.requirements_ref, request.requirements_ref],
    ["Architecture Current", contract.architecture_current_ref, request.architecture_current_ref],
    ["Current Context", contract.current_context_ref, request.current_context_ref],
    ["System Map", contract.system_map_ref, request.system_map_ref],
    ["Effective Policy", contract.effective_policy_ref, request.effective_policy_ref],
  ] as const) if (!referencesEqual(actual, expected)) fail("ST-05 Build Contract", `reuse ${label} input does not match the current Work Request`);
  verifyProjectArtifactReference(projectDir, contract.approval_ref);
  const approval = readCanonical(resolve(projectDir, contract.approval_ref.source_of_truth), parseBuildContractApproval).value;
  if (!referencesEqual(approval.candidate_ref, contract.candidate_ref)) fail("ST-05 Build Contract", "reused Build Contract approval binding is invalid");
  return contract.derived_batches;
}

function reviewBuildContractLocked(projectDir: string, recordDir: string, proposalValue: unknown, options: BuildContractReviewOptions): BuildContractReviewResult {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-05") fail("ST-05 Build Contract", `current Stage must be ST-05, found ${state.current_stage}`);
  if (existsSync(buildContractApprovalPath(recordDir))) fail("ST-05 Build Contract", "an approved candidate cannot be revised");
  const prepared = prepareBuildContractLocked(projectDir, recordDir, {});
  const proposal = parseBuildContractProposal(proposalValue);
  if (proposal.intent_id !== state.intent_id) fail("ST-05 Build Contract", "Proposal Intent does not match State");
  if (proposal.work_request_sha256 !== prepared.reference.sha256) fail("ST-05 Build Contract", "Proposal does not reference the current Build Contract Work Request");
  validateCoverage(prepared.request, proposal);
  for (const reference of proposal.evidence) verifyProjectArtifactReference(projectDir, reference);
  const batches = proposal.disposition === "execute"
    ? validateExecute(projectDir, prepared.request, proposal)
    : proposal.disposition === "reuse"
    ? validateReuse(projectDir, prepared.request, proposal)
    : validateNotApplicable(prepared.request, proposal);
  const reviewedAt = options.reviewedAt ?? new Date().toISOString();
  const { artifact: _proposalArtifact, work_request_sha256: _workRequestSha, ...proposalContent } = proposal;
  const candidate = parseBuildContractCandidate({
    ...proposalContent,
    artifact: "build-contract-candidate",
    work_request_ref: prepared.reference,
    requirements_ref: prepared.request.requirements_ref,
    architecture_current_ref: prepared.request.architecture_current_ref,
    architecture_ref: prepared.request.architecture_ref,
    current_context_ref: prepared.request.current_context_ref,
    system_map_ref: prepared.request.system_map_ref,
    effective_policy_ref: prepared.request.effective_policy_ref,
    target_sources: prepared.request.target_sources,
    derived_batches: batches,
    created_at: reviewedAt,
  });
  const candidateContent = serialize(candidate);
  const candidatePath = buildContractCandidatePath(recordDir);
  writeFileAtomic(candidatePath, candidateContent);
  const candidateReference = artifactReference(projectDir, candidatePath, "build-contract-candidate", candidateContent);
  const reviewContent = renderBuildContractReviewHtml(candidate, candidateReference);
  const reviewPath = buildContractReviewPath(recordDir);
  writeFileAtomic(reviewPath, reviewContent);
  const reviewReference = artifactReference(projectDir, reviewPath, "build-contract-review", reviewContent);
  const parked: VNextIntentState = {
    ...state,
    status: "parked",
    parked_reason: "ST-05 Build Contract candidate is awaiting human approval of its exact SHA-256.",
    updated_at: reviewedAt,
  };
  writeVNextStateAt(recordDir, parked, plan);
  const alreadyAwaiting = readOrderedAuditEntries(recordDir).some((entry) => entry.event === "STAGE_AWAITING_APPROVAL" && entry.fields.Stage === "ST-05" && entry.fields["Candidate SHA-256"] === candidateReference.sha256);
  if (!alreadyAwaiting) appendAuditEntry(projectDir, recordDir, "STAGE_AWAITING_APPROVAL", { Stage: "ST-05", Candidate: candidateReference.source_of_truth, "Candidate SHA-256": candidateReference.sha256, Review: reviewReference.source_of_truth, "Decision Authority": "human" });
  return { candidate, candidateReference, reviewReference, state: readVNextStateAt(recordDir) };
}

export function reviewBuildContract(projectDir: string, proposalValue: unknown, options: BuildContractReviewOptions = {}): BuildContractReviewResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try { return reviewBuildContractLocked(projectRoot, recordDir, proposalValue, options); }
    catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", { Stage: "ST-05", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" });
      throw error;
    }
  });
}

export function pendingBuildContractReview(projectDir: string, recordDir = activeVNextIntentRecordDir(projectDir)): { candidate: ArtifactReference; review: ArtifactReference } | null {
  const candidatePath = buildContractCandidatePath(recordDir);
  const reviewPath = buildContractReviewPath(recordDir);
  if (!existsSync(candidatePath) && !existsSync(reviewPath)) return null;
  if (!existsSync(candidatePath) || !existsSync(reviewPath)) fail("ST-05 Build Contract", "candidate and review HTML must exist together");
  const candidate = readCanonical(candidatePath, parseBuildContractCandidate);
  const candidateRef = artifactReference(projectDir, candidatePath, "build-contract-candidate", candidate.content);
  const reviewContent = readFileSync(reviewPath, "utf8");
  if (reviewContent !== renderBuildContractReviewHtml(candidate.value, candidateRef)) fail("ST-05 Build Contract", "review HTML does not match the exact candidate");
  return { candidate: candidateRef, review: artifactReference(projectDir, reviewPath, "build-contract-review", reviewContent) };
}

function stageProposal(candidate: BuildContractCandidate, approvalRef: ArtifactReference, finalRef: ArtifactReference | null): StageDispositionProposal {
  const evidence = candidate.disposition === "execute"
    ? [finalRef!, approvalRef]
    : candidate.disposition === "reuse"
    ? [candidate.reuse_ref!, approvalRef]
    : [...candidate.evidence, candidate.work_request_ref, approvalRef];
  return { schema_version: 1, proposal_id: candidate.proposal_id, stage_id: "ST-05", disposition: candidate.disposition, reason: candidate.reason, evidence, proposed_by: "ai" };
}

function revisePlan(projectDir: string, plan: StageExecutionPlan, contract: VNextStageContract, candidate: BuildContractCandidate, approvalRef: ArtifactReference, finalRef: ArtifactReference | null): StageExecutionPlan {
  const proposal = stageProposal(candidate, approvalRef, finalRef);
  const existing = plan.stage_decisions.find((entry) => entry.stage_id === "ST-05");
  if (existing?.proposal_ref === proposal.proposal_id && existing.disposition === proposal.disposition && existing.reason === proposal.reason && JSON.stringify(existing.evidence) === JSON.stringify(proposal.evidence)) return plan;
  return reviseStageExecutionPlan(plan, [proposal], {
    projectDir,
    stageContracts: [contract],
    deterministicApplicability: (entry) => entry.stage_id === "ST-05" && entry.disposition === "not_applicable" && entry.proposal_id === candidate.proposal_id,
  });
}

function approveBuildContractLocked(projectDir: string, recordDir: string, options: BuildContractApproveOptions): BuildContractApproveResult {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-05") fail("ST-05 Build Contract", `current Stage must be ST-05, found ${state.current_stage}`);
  const contractDefinition = loadBuildContractStageContract();
  const pending = pendingBuildContractReview(projectDir, recordDir);
  if (pending === null) fail("ST-05 Build Contract", "no validated candidate is awaiting approval");
  if (pending.candidate.sha256 !== options.candidateSha256) fail("ST-05 Build Contract", "approval SHA-256 does not match the pending candidate");
  const candidate = readCanonical(buildContractCandidatePath(recordDir), parseBuildContractCandidate).value;
  if (candidate.intent_id !== state.intent_id) fail("ST-05 Build Contract", "Candidate Intent does not match State");
  const decidedAt = options.decidedAt ?? new Date().toISOString();
  let approval = parseBuildContractApproval({
    schema_version: 1,
    artifact: "human-decision",
    version: 1,
    decision_id: `approve-${candidate.proposal_id}`,
    decision_kind: "approval",
    intent_id: state.intent_id,
    candidate_ref: pending.candidate,
    decision: "approve-build-contract",
    reason: options.reason,
    decided_by: "human",
    decided_at: decidedAt,
  });
  const approvalPath = buildContractApprovalPath(recordDir);
  let approvalContent = serialize(approval);
  if (existsSync(approvalPath)) {
    const stored = readCanonical(approvalPath, parseBuildContractApproval);
    const { decided_at: _candidateAt, ...candidateStable } = approval;
    const { decided_at: _storedAt, ...storedStable } = stored.value;
    if (JSON.stringify(candidateStable) !== JSON.stringify(storedStable)) fail("ST-05 Build Contract", "existing approval is bound to different content");
    approval = stored.value;
    approvalContent = stored.content;
  } else writeFileAtomic(approvalPath, approvalContent);
  const approvalReference = artifactReference(projectDir, approvalPath, "human-decision", approvalContent);
  verifyProjectArtifactReference(projectDir, approvalReference);

  let buildContract: BuildContract | null = null;
  let reference: ArtifactReference | null = candidate.disposition === "reuse" ? candidate.reuse_ref : null;
  if (candidate.disposition === "execute") {
    const request = readCanonical(buildContractWorkRequestPath(recordDir), parseBuildContractWorkRequest).value;
    const revision = (request.base_revision ?? 0) + 1;
    const { artifact: _artifact, reuse_ref: _reuse, ...candidateContent } = candidate;
    buildContract = parseBuildContract({
      ...candidateContent,
      artifact: "build-contract",
      revision,
      base_revision: request.base_revision,
      candidate_ref: pending.candidate,
      approval_ref: approvalReference,
    });
    const revisionPath = buildContractRevisionPath(recordDir, revision);
    let content = serialize(buildContract);
    if (existsSync(revisionPath)) {
      const stored = readCanonical(revisionPath, parseBuildContract);
      if (JSON.stringify(stored.value) !== JSON.stringify(buildContract)) fail("ST-05 Build Contract", `immutable Build Contract revision ${revision} already exists with different content`);
      buildContract = stored.value;
      content = stored.content;
    } else writeFileAtomic(revisionPath, content);
    reference = artifactReference(projectDir, revisionPath, "build-contract", content);
    verifyProjectArtifactReference(projectDir, reference);
  }
  let current = parseBuildContractCurrent({
    schema_version: 1,
    artifact: "build-contract-current",
    version: 1,
    intent_id: state.intent_id,
    disposition: candidate.disposition,
    build_contract_ref: reference,
    candidate_ref: pending.candidate,
    approval_ref: approvalReference,
    requirements_ref: candidate.requirements_ref,
    architecture_current_ref: candidate.architecture_current_ref,
    current_context_ref: candidate.current_context_ref,
    system_map_ref: candidate.system_map_ref,
    effective_policy_ref: candidate.effective_policy_ref,
    reason: candidate.reason,
    updated_at: decidedAt,
  });
  const currentPath = buildContractCurrentPath(recordDir);
  let currentContent = serialize(current);
  if (existsSync(currentPath)) {
    const stored = readCanonical(currentPath, parseBuildContractCurrent);
    const { updated_at: _candidateUpdatedAt, ...candidateStable } = current;
    const { updated_at: _storedUpdatedAt, ...storedStable } = stored.value;
    if (JSON.stringify(storedStable) !== JSON.stringify(candidateStable)) fail("ST-05 Build Contract", "Build Contract Current already records different content");
    current = stored.value;
    currentContent = stored.content;
  } else writeFileAtomic(currentPath, currentContent);
  const currentReference = artifactReference(projectDir, currentPath, "build-contract-current", currentContent);
  const revisedPlan = revisePlan(projectDir, plan, contractDefinition, candidate, approvalReference, reference);
  if (revisedPlan.revision !== plan.revision) writeVNextPlanAt(recordDir, revisedPlan);
  const definitions = loadVNextDefinitions();
  const nextStage = nextForwardStage(definitions.graph, "ST-05");
  if (nextStage !== "ST-06") fail("ST-05 Build Contract", "fixed Graph must route to ST-06");
  validateCoreRoute(definitions.graph, { from: "ST-05", to: nextStage });
  const alreadyCompleted = readOrderedAuditEntries(recordDir).some((entry) => entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-05" && entry.fields["Build Contract Current SHA-256"] === currentReference.sha256);
  if (!alreadyCompleted) appendAuditEntries(projectDir, recordDir, [
    ...(revisedPlan.revision === plan.revision ? [] : [{ event: "PLAN_REVISED" as const, fields: { "Plan Revision": String(revisedPlan.revision), Stage: "ST-05", Disposition: candidate.disposition, "Proposal Reference": candidate.proposal_id, "Decision Authority": "core" } }]),
    { event: "STAGE_STARTED", fields: { Stage: "ST-05", Executor: "ai+core+human", Verifier: "build-contract-schema-validator" } },
    { event: "GATE_APPROVED", fields: { Stage: "ST-05", Decision: approval.decision, "Candidate SHA-256": pending.candidate.sha256, "Decision Authority": "human" } },
    { event: "STAGE_COMPLETED", fields: { Stage: "ST-05", Disposition: candidate.disposition, Artifact: currentReference.source_of_truth, "Build Contract Current SHA-256": currentReference.sha256, "Candidate SHA-256": pending.candidate.sha256, ...(reference === null ? {} : { "Build Contract": reference.source_of_truth, "Build Contract SHA-256": reference.sha256 }), "Decision Authority": "core" } },
    { event: "ROUTE_DECIDED", fields: { "From Stage": "ST-05", "Current Stage": "ST-06", Graph: definitions.graph.graph_version, "Decision Authority": "core" } },
  ]);
  const advanced: VNextIntentState = {
    ...state,
    plan_revision: revisedPlan.revision,
    current_stage: "ST-06",
    status: "parked",
    parked_reason: "ST-06 Build & Converge is not implemented yet.",
    updated_at: decidedAt,
  };
  writeVNextStateAt(recordDir, advanced, revisedPlan);
  return { contract: buildContract, reference, current, currentReference, approval, approvalReference, plan: revisedPlan, state: readVNextStateAt(recordDir) };
}

export function approveBuildContract(projectDir: string, options: BuildContractApproveOptions): BuildContractApproveResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try { return approveBuildContractLocked(projectRoot, recordDir, options); }
    catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", { Stage: "ST-05", Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "), "Decision Authority": "core" });
      throw error;
    }
  });
}

export function main(argv: string[]): void {
  const [command, projectDir, argument, ...rest] = argv;
  const validPrepare = command === "prepare" && projectDir !== undefined && argument === undefined;
  const validReview = command === "review" && projectDir !== undefined && argument !== undefined && rest.length === 0;
  const validApprove = command === "approve" && projectDir !== undefined && argument !== undefined && rest.length === 1;
  if (!validPrepare && !validReview && !validApprove) {
    console.error("Usage: aidlc build-contract prepare <project-dir>\n       aidlc build-contract review <project-dir> <proposal.json>\n       aidlc build-contract approve <project-dir> <candidate-sha256> <reason>");
    process.exitCode = 1;
    return;
  }
  try {
    if (projectDir === undefined) throw new Error("project directory is required");
    const result = command === "prepare"
      ? prepareBuildContract(projectDir)
      : command === "review"
      ? reviewBuildContract(projectDir, JSON.parse(readFileSync(resolve(argument!), "utf8")))
      : approveBuildContract(projectDir, { candidateSha256: argument!, reason: rest[0]! });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
