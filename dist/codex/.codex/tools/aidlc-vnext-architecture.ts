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
  parseCurrentContext,
  parseSystemMap,
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
  parseArchitectureAssessmentProposal,
  parseArchitectureCurrent,
  parseArchitectureDecision,
  parseArchitectureReuseApproval,
  parseArchitectureWorkRequest,
  type ArchitectureAssessmentProposal,
  type ArchitectureCurrent,
  type ArchitectureDecision,
  type ArchitectureReuseApproval,
  type ArchitectureWorkRequest,
} from "./aidlc-vnext-architecture-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextPlanAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export interface ArchitecturePrepareOptions {
  preparedAt?: string;
}

export interface ArchitecturePrepareResult {
  execution: "prepared" | "reused";
  request: ArchitectureWorkRequest;
  reference: ArtifactReference;
}

export interface ArchitectureCompleteOptions {
  completedAt?: string;
}

export interface ArchitectureCompleteResult {
  decision: ArchitectureDecision | null;
  reference: ArtifactReference | null;
  current: ArchitectureCurrent;
  currentReference: ArtifactReference;
  plan: StageExecutionPlan;
  state: VNextIntentState;
}

const STAGE_CONTRACT_PATH = join(
  runtimeCoreDir(),
  "aidlc-common/stages/st-04-architecture-decision.json",
);

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename already consumed the temporary file.
    }
    throw error;
  }
}

function portableProjectPath(projectDir: string, path: string): string {
  const projectRoot = resolve(projectDir);
  const absolute = resolve(path);
  const rel = relative(projectRoot, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("ST-04 Architecture", `path is outside the project: ${absolute}`);
  }
  return rel === "" ? "." : rel.split(sep).join("/");
}

function artifactReference(
  projectDir: string,
  path: string,
  artifact: string,
  content?: string,
): ArtifactReference {
  const bytes = content ?? readFileSync(path, "utf8");
  return parseArtifactReference({
    artifact,
    version: 1,
    source_of_truth: portableProjectPath(projectDir, path),
    sha256: digest(bytes),
  });
}

function readCanonical<T>(
  path: string,
  parser: (value: unknown, context?: string) => T,
): { value: T; content: string } {
  const content = readFileSync(path, "utf8");
  let value: T;
  try {
    value = parser(JSON.parse(content), path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("ST-04 Architecture", `cannot read ${path}: ${detail}`);
  }
  if (content !== serialize(value)) {
    fail("ST-04 Architecture", `artifact is not canonical: ${path}`);
  }
  return { value, content };
}

function referencesEqual(
  left: ArtifactReference | null,
  right: ArtifactReference | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function includesReference(
  references: readonly ArtifactReference[],
  expected: ArtifactReference,
): boolean {
  return references.some((reference) => referencesEqual(reference, expected));
}

export function architectureRootDir(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "architecture");
}

export function architectureWorkRequestPath(recordDir: string): string {
  return join(architectureRootDir(recordDir), "architecture-work-request.json");
}

export function architectureCurrentPath(recordDir: string): string {
  return join(architectureRootDir(recordDir), "current.json");
}

export function architectureRevisionPath(recordDir: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("ST-04 Architecture", "revision must be a positive integer");
  }
  return join(
    architectureRootDir(recordDir),
    "revisions",
    revision.toString().padStart(6, "0"),
    "architecture-decision.json",
  );
}

export function loadArchitectureStageContract(
  path = STAGE_CONTRACT_PATH,
): VNextStageContract {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("ST-04 Contract", `cannot read ${path}: ${detail}`);
  }
  const contract = parseVNextStageContract(value, path);
  if (contract.stage_id !== "ST-04" || contract.name !== "Architecture Decision") {
    fail("ST-04 Contract", "must define ST-04 Architecture Decision");
  }
  return contract;
}

interface ArchitectureInputs {
  requirementsCurrentRef: ArtifactReference;
  requirementsRef: ArtifactReference;
  requirements: RequirementsDefinition;
  currentContextRef: ArtifactReference;
  systemMapRef: ArtifactReference;
  effectivePolicyRef: ArtifactReference;
  requirementIds: string[];
}

function loadArchitectureInputs(
  projectDir: string,
  recordDir: string,
  state: VNextIntentState,
): ArchitectureInputs {
  const currentPath = requirementsCurrentPath(recordDir);
  if (!existsSync(currentPath)) {
    fail("ST-04 Architecture", "Requirements Current is required");
  }
  const requirementsCurrent = readCanonical(currentPath, parseRequirementsCurrent);
  if (requirementsCurrent.value.intent_id !== state.intent_id) {
    fail("ST-04 Architecture", "Requirements Current Intent does not match State");
  }
  const requirementsCurrentRef = artifactReference(
    projectDir,
    currentPath,
    "requirements-current",
    requirementsCurrent.content,
  );
  const requirementsRef = requirementsCurrent.value.requirements_ref;
  verifyProjectArtifactReference(projectDir, requirementsRef);
  const expectedRequirementsPath = requirementsRevisionPath(
    recordDir,
    requirementsCurrent.value.current_revision,
  );
  if (resolve(projectDir, requirementsRef.source_of_truth) !== resolve(expectedRequirementsPath)) {
    fail("ST-04 Architecture", "Requirements Current does not point to its revision path");
  }
  const requirements = readCanonical(expectedRequirementsPath, parseRequirementsDefinition).value;
  if (
    requirements.intent_id !== state.intent_id ||
    requirements.revision !== requirementsCurrent.value.current_revision
  ) fail("ST-04 Architecture", "Requirements Current and Definition disagree");

  const currentContextRef = requirements.current_context_ref;
  verifyProjectArtifactReference(projectDir, currentContextRef);
  const contextPath = resolve(projectDir, currentContextRef.source_of_truth);
  const context = readCanonical(contextPath, parseCurrentContext).value;
  if (context.intent_id !== state.intent_id) {
    fail("ST-04 Architecture", "Current Context Intent does not match State");
  }
  const systemMapRef = context.system_map_ref;
  verifyProjectArtifactReference(projectDir, systemMapRef);
  readCanonical(resolve(projectDir, systemMapRef.source_of_truth), parseSystemMap);

  const effectivePolicyRef = requirements.effective_policy_ref;
  if (!referencesEqual(effectivePolicyRef, state.policy_snapshot)) {
    fail("ST-04 Architecture", "Requirements Effective Policy does not match State");
  }
  verifyProjectArtifactReference(projectDir, effectivePolicyRef);
  const requirementIds = [
    ...requirements.functional_requirements,
    ...requirements.quality_requirements,
    ...requirements.constraints,
    ...requirements.invariants,
  ].map((requirement) => requirement.id);
  if (requirementIds.length === 0) {
    fail("ST-04 Architecture", "Requirements must contain at least one requirement item");
  }
  return {
    requirementsCurrentRef,
    requirementsRef,
    requirements,
    currentContextRef,
    systemMapRef,
    effectivePolicyRef,
    requirementIds,
  };
}

function readArchitectureCurrent(
  projectDir: string,
  recordDir: string,
  intentId: string,
): { current: ArchitectureCurrent; content: string; localRevision: number | null } | null {
  const path = architectureCurrentPath(recordDir);
  if (!existsSync(path)) return null;
  const parsed = readCanonical(path, parseArchitectureCurrent);
  if (parsed.value.intent_id !== intentId) {
    fail("ST-04 Architecture", "Architecture Current Intent does not match State");
  }
  let localRevision: number | null = null;
  if (parsed.value.architecture_ref !== null) {
    verifyProjectArtifactReference(projectDir, parsed.value.architecture_ref);
    const decisionPath = resolve(projectDir, parsed.value.architecture_ref.source_of_truth);
    const decision = readCanonical(decisionPath, parseArchitectureDecision).value;
    if (decision.intent_id === intentId) {
      const expected = architectureRevisionPath(recordDir, decision.revision);
      if (resolve(expected) === decisionPath) localRevision = decision.revision;
    }
  }
  for (const reference of [
    parsed.value.requirements_ref,
    parsed.value.current_context_ref,
    parsed.value.system_map_ref,
    parsed.value.effective_policy_ref,
    ...parsed.value.evidence,
  ]) verifyProjectArtifactReference(projectDir, reference);
  return { current: parsed.value, content: parsed.content, localRevision };
}

function sameRequestInputs(
  request: ArchitectureWorkRequest,
  state: VNextIntentState,
  inputs: ArchitectureInputs,
): boolean {
  return request.intent_id === state.intent_id &&
    referencesEqual(request.requirements_current_ref, inputs.requirementsCurrentRef) &&
    referencesEqual(request.requirements_ref, inputs.requirementsRef) &&
    referencesEqual(request.current_context_ref, inputs.currentContextRef) &&
    referencesEqual(request.system_map_ref, inputs.systemMapRef) &&
    referencesEqual(request.effective_policy_ref, inputs.effectivePolicyRef) &&
    JSON.stringify(request.requirement_ids) === JSON.stringify(inputs.requirementIds);
}

function prepareArchitectureLocked(
  projectDir: string,
  recordDir: string,
  options: ArchitecturePrepareOptions,
): ArchitecturePrepareResult {
  loadArchitectureStageContract();
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-04") {
    fail("ST-04 Architecture", `current Stage must be ST-04, found ${state.current_stage}`);
  }
  const inputs = loadArchitectureInputs(projectDir, recordDir, state);
  const current = readArchitectureCurrent(projectDir, recordDir, state.intent_id);
  const baseRevision = current?.localRevision ?? null;
  const baseArchitectureRef = current?.current.architecture_ref ?? null;
  const path = architectureWorkRequestPath(recordDir);
  if (existsSync(path)) {
    const stored = readCanonical(path, parseArchitectureWorkRequest);
    if (
      sameRequestInputs(stored.value, state, inputs) &&
      stored.value.base_revision === baseRevision &&
      referencesEqual(stored.value.base_architecture_ref, baseArchitectureRef)
    ) {
      const reference = artifactReference(
        projectDir,
        path,
        "architecture-work-request",
        stored.content,
      );
      if (state.status !== "ready") {
        const { parked_reason: _parkedReason, ...ready } = state;
        writeVNextStateAt(recordDir, {
          ...ready,
          status: "ready",
          updated_at: stored.value.created_at,
        }, plan);
      }
      return { execution: "reused", request: stored.value, reference };
    }
  }

  const preparedAt = options.preparedAt ?? new Date().toISOString();
  const request = parseArchitectureWorkRequest({
    schema_version: 1,
    artifact: "architecture-work-request",
    version: 1,
    intent_id: state.intent_id,
    stage_id: "ST-04",
    requirements_current_ref: inputs.requirementsCurrentRef,
    requirements_ref: inputs.requirementsRef,
    current_context_ref: inputs.currentContextRef,
    system_map_ref: inputs.systemMapRef,
    effective_policy_ref: inputs.effectivePolicyRef,
    base_revision: baseRevision,
    base_architecture_ref: baseArchitectureRef,
    requirement_ids: inputs.requirementIds,
    requested_outputs: ["architecture-assessment-proposal"],
    rules: [
      "Assess every pinned requirement exactly once for Component, API, Database, external-service, deployment, relation, or boundary impact.",
      "Use execute only when a new system-structure decision is needed; keep planned changes in the Architecture Decision and never mutate the current System Map.",
      "Use reuse only with an existing canonical Architecture Decision and a human approval bound to this Intent and Requirements.",
      "Use not_applicable only when every requirement has zero architecture impact and pinned Requirements and System Map Evidence proves that result.",
      "Do not add detailed API fields, Database schema, test cases, Bolt plans, implementation instructions, credentials, or routes.",
      "AI proposes content only; Core validates, versions, persists, revises the Plan, and owns the fixed Stage transition.",
    ],
    created_at: preparedAt,
  });
  const content = serialize(request);
  writeFileAtomic(path, content);
  const reference = artifactReference(projectDir, path, "architecture-work-request", content);
  const { parked_reason: _parkedReason, ...ready } = state;
  writeVNextStateAt(recordDir, {
    ...ready,
    status: "ready",
    updated_at: preparedAt,
  }, plan);
  return { execution: "prepared", request, reference };
}

export function prepareArchitecture(
  projectDir: string,
  options: ArchitecturePrepareOptions = {},
): ArchitecturePrepareResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return prepareArchitectureLocked(projectRoot, recordDir, options);
    } catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-04",
        Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "),
        "Decision Authority": "core",
      });
      throw error;
    }
  });
}

function recoverPreparedRequest(
  projectDir: string,
  recordDir: string,
  state: VNextIntentState,
  proposal: ArchitectureAssessmentProposal,
): ArchitecturePrepareResult | null {
  const path = architectureWorkRequestPath(recordDir);
  if (!existsSync(path)) return null;
  const stored = readCanonical(path, parseArchitectureWorkRequest);
  const reference = artifactReference(projectDir, path, "architecture-work-request", stored.content);
  if (proposal.work_request_sha256 !== reference.sha256) return null;
  const inputs = loadArchitectureInputs(projectDir, recordDir, state);
  if (!sameRequestInputs(stored.value, state, inputs)) return null;
  if (stored.value.base_architecture_ref !== null) {
    verifyProjectArtifactReference(projectDir, stored.value.base_architecture_ref);
  }
  return { execution: "reused", request: stored.value, reference };
}

function mapEntityIds(projectDir: string, reference: ArtifactReference): Set<string> {
  verifyProjectArtifactReference(projectDir, reference);
  const map = readCanonical(
    resolve(projectDir, reference.source_of_truth),
    parseSystemMap,
  ).value;
  return new Set(map.entities.map((entity) => entity.entity_id));
}

function validateRequirementCoverage(
  request: ArchitectureWorkRequest,
  proposal: ArchitectureAssessmentProposal,
): void {
  const expected = new Set(request.requirement_ids);
  const actual = new Set(proposal.requirement_assessments.map((entry) => entry.requirement_id));
  for (const requirementId of expected) {
    if (!actual.has(requirementId)) {
      fail("ST-04 Architecture", `requirement coverage is missing: ${requirementId}`);
    }
  }
  for (const requirementId of actual) {
    if (!expected.has(requirementId)) {
      fail("ST-04 Architecture", `assessment references an unknown requirement: ${requirementId}`);
    }
  }
}

function validateCurrentEntityReferences(
  projectDir: string,
  request: ArchitectureWorkRequest,
  proposal: ArchitectureAssessmentProposal,
): void {
  const entities = mapEntityIds(projectDir, request.system_map_ref);
  const references = [
    ...proposal.requirement_assessments.flatMap((entry) => entry.current_entity_refs),
    ...proposal.decisions.flatMap((entry) => entry.current_entity_refs),
  ];
  for (const entityId of references) {
    if (!entities.has(entityId)) {
      fail("ST-04 Architecture", `current entity does not exist in System Map: ${entityId}`);
    }
  }
}

function validateExecute(
  projectDir: string,
  request: ArchitectureWorkRequest,
  proposal: ArchitectureAssessmentProposal,
): void {
  const impacted = new Set(
    proposal.requirement_assessments
      .filter((entry) => entry.architecture_impact)
      .map((entry) => entry.requirement_id),
  );
  if (impacted.size === 0) {
    fail("ST-04 Architecture", "execute requires at least one architecture-impact requirement");
  }
  const covered = new Set(proposal.decisions.flatMap((decision) => decision.requirement_ids));
  for (const requirementId of covered) {
    if (!request.requirement_ids.includes(requirementId)) {
      fail("ST-04 Architecture", `decision references an unknown requirement: ${requirementId}`);
    }
  }
  for (const requirementId of impacted) {
    if (!covered.has(requirementId)) {
      fail("ST-04 Architecture", `impacted requirement lacks a decision: ${requirementId}`);
    }
  }
  const hard = proposal.decisions.some((decision) => decision.reversibility === "hard");
  if (hard && proposal.approval_ref === null) {
    fail("ST-04 Architecture", "hard-to-reverse decision requires a human-decision approval_ref");
  }
  if (proposal.approval_ref !== null) {
    verifyProjectArtifactReference(projectDir, proposal.approval_ref);
  }
}

function validateNotApplicable(
  request: ArchitectureWorkRequest,
  proposal: ArchitectureAssessmentProposal,
): void {
  const impacted = proposal.requirement_assessments.find((entry) => entry.architecture_impact);
  if (impacted !== undefined) {
    fail(
      "ST-04 Architecture",
      `not_applicable requires architecture_impact=false for ${impacted.requirement_id}`,
    );
  }
  for (const required of [request.requirements_ref, request.system_map_ref]) {
    if (!includesReference(proposal.evidence, required)) {
      fail(
        "ST-04 Architecture",
        `not_applicable Evidence must pin ${required.artifact}`,
      );
    }
  }
}

function readReuseApproval(
  projectDir: string,
  request: ArchitectureWorkRequest,
  proposal: ArchitectureAssessmentProposal,
): { decision: ArchitectureDecision; approval: ArchitectureReuseApproval } {
  if (proposal.reuse_ref === null || proposal.approval_ref === null) {
    fail("ST-04 Architecture", "reuse requires decision and approval references");
  }
  if (
    proposal.reuse_ref.artifact !== "architecture-decision" ||
    proposal.approval_ref.artifact !== "human-decision"
  ) fail("ST-04 Architecture", "reuse references have invalid artifact types");
  for (const reference of [proposal.reuse_ref, proposal.approval_ref]) {
    if (!includesReference(proposal.evidence, reference)) {
      fail("ST-04 Architecture", `reuse Evidence must include ${reference.artifact}`);
    }
    verifyProjectArtifactReference(projectDir, reference);
  }
  const decision = readCanonical(
    resolve(projectDir, proposal.reuse_ref.source_of_truth),
    parseArchitectureDecision,
  ).value;
  const approval = readCanonical(
    resolve(projectDir, proposal.approval_ref.source_of_truth),
    parseArchitectureReuseApproval,
  ).value;
  if (
    approval.intent_id !== request.intent_id ||
    !referencesEqual(approval.approved_architecture_ref, proposal.reuse_ref) ||
    !referencesEqual(approval.requirements_ref, request.requirements_ref)
  ) {
    fail(
      "ST-04 Architecture",
      "reuse approval is not bound to the exact Intent, Architecture Decision, and Requirements",
    );
  }
  if (!proposal.requirement_assessments.some((entry) => entry.architecture_impact)) {
    fail("ST-04 Architecture", "reuse requires at least one architecture-impact requirement");
  }
  return { decision, approval };
}

function stageProposal(
  proposal: ArchitectureAssessmentProposal,
): StageDispositionProposal {
  return {
    schema_version: 1,
    proposal_id: proposal.proposal_id,
    stage_id: "ST-04",
    disposition: proposal.disposition,
    reason: proposal.reason,
    evidence: proposal.evidence,
    proposed_by: "ai",
  };
}

function revisePlan(
  projectDir: string,
  plan: StageExecutionPlan,
  contract: VNextStageContract,
  proposal: ArchitectureAssessmentProposal,
): StageExecutionPlan {
  const coreProposal = stageProposal(proposal);
  const existing = plan.stage_decisions.find((decision) => decision.stage_id === "ST-04");
  if (
    existing?.proposal_ref === coreProposal.proposal_id &&
    existing.disposition === coreProposal.disposition &&
    existing.reason === coreProposal.reason &&
    JSON.stringify(existing.evidence) === JSON.stringify(coreProposal.evidence)
  ) return plan;
  return reviseStageExecutionPlan(plan, [coreProposal], {
    projectDir,
    stageContracts: [contract],
    deterministicApplicability: (candidate) =>
      candidate.stage_id === "ST-04" &&
      candidate.disposition === "not_applicable" &&
      candidate.proposal_id === proposal.proposal_id,
  });
}

function completeArchitectureLocked(
  projectDir: string,
  recordDir: string,
  proposalValue: unknown,
  options: ArchitectureCompleteOptions,
): ArchitectureCompleteResult {
  const state = readVNextStateAt(recordDir);
  if (state.current_stage !== "ST-04") {
    fail("ST-04 Architecture", `current Stage must be ST-04, found ${state.current_stage}`);
  }
  const plan = readVNextPlanAt(recordDir);
  const contract = loadArchitectureStageContract();
  const proposal = parseArchitectureAssessmentProposal(proposalValue);
  if (proposal.intent_id !== state.intent_id) {
    fail("ST-04 Architecture", "Proposal Intent does not match State");
  }
  const prepared = recoverPreparedRequest(projectDir, recordDir, state, proposal) ??
    prepareArchitectureLocked(projectDir, recordDir, {});
  if (proposal.work_request_sha256 !== prepared.reference.sha256) {
    fail("ST-04 Architecture", "Proposal does not reference the current Architecture Work Request");
  }
  validateRequirementCoverage(prepared.request, proposal);
  validateCurrentEntityReferences(projectDir, prepared.request, proposal);
  for (const reference of proposal.evidence) verifyProjectArtifactReference(projectDir, reference);

  if (proposal.disposition === "execute") {
    validateExecute(projectDir, prepared.request, proposal);
  } else if (proposal.disposition === "reuse") {
    readReuseApproval(projectDir, prepared.request, proposal);
  } else {
    validateNotApplicable(prepared.request, proposal);
  }

  const completedAt = options.completedAt ?? new Date().toISOString();
  let decision: ArchitectureDecision | null = null;
  let reference: ArtifactReference | null = null;
  if (proposal.disposition === "execute") {
    const revision = (prepared.request.base_revision ?? 0) + 1;
    decision = parseArchitectureDecision({
      schema_version: 1,
      artifact: "architecture-decision",
      version: 1,
      intent_id: state.intent_id,
      revision,
      base_revision: prepared.request.base_revision,
      proposal_id: proposal.proposal_id,
      requirements_ref: prepared.request.requirements_ref,
      current_context_ref: prepared.request.current_context_ref,
      system_map_ref: prepared.request.system_map_ref,
      effective_policy_ref: prepared.request.effective_policy_ref,
      requirement_assessments: proposal.requirement_assessments,
      decisions: proposal.decisions,
      reason: proposal.reason,
      created_at: completedAt,
    });
    const revisionPath = architectureRevisionPath(recordDir, revision);
    let content = serialize(decision);
    if (existsSync(revisionPath)) {
      const stored = readCanonical(revisionPath, parseArchitectureDecision);
      const { created_at: _candidateCreatedAt, ...candidateStable } = decision;
      const { created_at: _storedCreatedAt, ...storedStable } = stored.value;
      if (JSON.stringify(candidateStable) !== JSON.stringify(storedStable)) {
        fail(
          "ST-04 Architecture",
          `immutable Architecture Decision revision ${revision} already exists with different content`,
        );
      }
      decision = stored.value;
      content = stored.content;
    } else {
      writeFileAtomic(revisionPath, content);
    }
    reference = artifactReference(
      projectDir,
      revisionPath,
      "architecture-decision",
      content,
    );
    verifyProjectArtifactReference(projectDir, reference);
  } else if (proposal.disposition === "reuse") {
    reference = proposal.reuse_ref;
  }

  let current = parseArchitectureCurrent({
    schema_version: 1,
    artifact: "architecture-current",
    version: 1,
    intent_id: state.intent_id,
    disposition: proposal.disposition,
    architecture_ref: reference,
    requirements_ref: prepared.request.requirements_ref,
    current_context_ref: prepared.request.current_context_ref,
    system_map_ref: prepared.request.system_map_ref,
    effective_policy_ref: prepared.request.effective_policy_ref,
    requirement_assessments: proposal.requirement_assessments,
    evidence: proposal.evidence,
    reason: proposal.reason,
    updated_at: completedAt,
  });
  const currentPath = architectureCurrentPath(recordDir);
  let currentContent = serialize(current);
  if (existsSync(currentPath)) {
    const stored = readCanonical(currentPath, parseArchitectureCurrent);
    const { updated_at: _candidateUpdatedAt, ...candidateStable } = current;
    const { updated_at: _storedUpdatedAt, ...storedStable } = stored.value;
    if (JSON.stringify(candidateStable) === JSON.stringify(storedStable)) {
      current = stored.value;
      currentContent = stored.content;
    } else {
      writeFileAtomic(currentPath, currentContent);
    }
  } else {
    writeFileAtomic(currentPath, currentContent);
  }
  const currentReference = artifactReference(
    projectDir,
    currentPath,
    "architecture-current",
    currentContent,
  );

  const revisedPlan = revisePlan(projectDir, plan, contract, proposal);
  if (revisedPlan.revision !== plan.revision) writeVNextPlanAt(recordDir, revisedPlan);

  const definitions = loadVNextDefinitions();
  const nextStage = nextForwardStage(definitions.graph, "ST-04");
  if (nextStage !== "ST-05") fail("ST-04 Architecture", "fixed Graph must route to ST-05");
  validateCoreRoute(definitions.graph, { from: "ST-04", to: nextStage });
  const alreadyCompleted = readOrderedAuditEntries(recordDir).some((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-04" &&
    entry.fields["Architecture Current SHA-256"] === currentReference.sha256
  );
  if (!alreadyCompleted) {
    appendAuditEntries(projectDir, recordDir, [
      ...(revisedPlan.revision === plan.revision ? [] : [{
        event: "PLAN_REVISED" as const,
        fields: {
          "Plan Revision": String(revisedPlan.revision),
          Stage: "ST-04",
          Disposition: proposal.disposition,
          "Proposal Reference": proposal.proposal_id,
          "Decision Authority": "core",
        },
      }]),
      {
        event: "STAGE_STARTED",
        fields: {
          Stage: "ST-04",
          Executor: "ai+core",
          Verifier: "architecture-assessment-validator",
        },
      },
      {
        event: "STAGE_COMPLETED",
        fields: {
          Stage: "ST-04",
          Disposition: proposal.disposition,
          Artifact: currentReference.source_of_truth,
          "Architecture Current SHA-256": currentReference.sha256,
          ...(reference === null ? {} : {
            "Architecture Decision": reference.source_of_truth,
            "Architecture Decision SHA-256": reference.sha256,
          }),
          "Decision Authority": "core",
        },
      },
      {
        event: "ROUTE_DECIDED",
        fields: {
          "From Stage": "ST-04",
          "Current Stage": "ST-05",
          Graph: definitions.graph.graph_version,
          "Decision Authority": "core",
        },
      },
    ]);
  }
  const advanced: VNextIntentState = {
    ...state,
    plan_revision: revisedPlan.revision,
    current_stage: "ST-05",
    status: "parked",
    parked_reason: "ST-05 Build Contract is not implemented yet.",
    updated_at: completedAt,
  };
  writeVNextStateAt(recordDir, advanced, revisedPlan);
  return {
    decision,
    reference,
    current,
    currentReference,
    plan: revisedPlan,
    state: readVNextStateAt(recordDir),
  };
}

export function completeArchitecture(
  projectDir: string,
  proposalValue: unknown,
  options: ArchitectureCompleteOptions = {},
): ArchitectureCompleteResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return completeArchitectureLocked(projectRoot, recordDir, proposalValue, options);
    } catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-04",
        Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "),
        "Decision Authority": "core",
      });
      throw error;
    }
  });
}

export function main(argv: string[]): void {
  const [command, projectDir, proposalPath, ...rest] = argv;
  const validPrepare = command === "prepare" && projectDir !== undefined && proposalPath === undefined;
  const validComplete = command === "complete" && projectDir !== undefined && proposalPath !== undefined && rest.length === 0;
  if (!validPrepare && !validComplete) {
    console.error(
      "Usage: aidlc architecture prepare <project-dir>\n" +
        "       aidlc architecture complete <project-dir> <proposal.json>",
    );
    process.exitCode = 1;
    return;
  }
  try {
    if (projectDir === undefined) throw new Error("project directory is required");
    const result = command === "prepare"
      ? prepareArchitecture(projectDir)
      : completeArchitecture(
        projectDir,
        JSON.parse(readFileSync(resolve(proposalPath!), "utf8")),
      );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
