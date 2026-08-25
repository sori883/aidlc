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
  validateCoreRoute,
} from "./aidlc-core-route.ts";
import { verifyProjectArtifactReference } from "./aidlc-effective-policy.ts";
import { intentDefinitionPath } from "./aidlc-vnext-define-intent.ts";
import { parseIntentDefinition } from "./aidlc-vnext-define-intent-contract.ts";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";
import {
  parseArtifactReference,
  parseVNextStageContract,
  type ArtifactReference,
  type VNextStageContract,
} from "./aidlc-stage-contract.ts";
import {
  parseRequirementsCurrent,
  parseRequirementsDefinition,
  parseRequirementsDefinitionProposal,
  parseRequirementsWorkRequest,
  type RequirementsCurrent,
  type RequirementsDefinition,
  type RequirementsDefinitionProposal,
  type RequirementsSourceRef,
  type RequirementsWorkRequest,
} from "./aidlc-vnext-requirements-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export interface RequirementsPrepareOptions {
  preparedAt?: string;
}

export interface RequirementsPrepareResult {
  execution: "prepared" | "reused";
  request: RequirementsWorkRequest;
  reference: ArtifactReference;
}

export interface RequirementsCompleteOptions {
  completedAt?: string;
}

export interface RequirementsCompleteResult {
  definition: RequirementsDefinition;
  reference: ArtifactReference;
  current: RequirementsCurrent;
  currentReference: ArtifactReference;
  state: VNextIntentState;
}

const STAGE_CONTRACT_PATH = join(
  runtimeCoreDir(),
  "aidlc-common/stages/st-03-requirements-constraints.json",
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
    fail("ST-03 Requirements", `path is outside the project: ${absolute}`);
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
    fail("ST-03 Requirements", `cannot read ${path}: ${detail}`);
  }
  if (content !== serialize(value)) {
    fail("ST-03 Requirements", `artifact is not canonical: ${path}`);
  }
  return { value, content };
}

function referencesEqual(left: ArtifactReference, right: ArtifactReference): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceRefsEqual(
  left: readonly RequirementsSourceRef[],
  right: readonly RequirementsSourceRef[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function requirementsRootDir(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "requirements");
}

export function requirementsWorkRequestPath(recordDir: string): string {
  return join(requirementsRootDir(recordDir), "requirements-work-request.json");
}

export function requirementsCurrentPath(recordDir: string): string {
  return join(requirementsRootDir(recordDir), "current.json");
}

export function requirementsRevisionPath(recordDir: string, revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) {
    fail("ST-03 Requirements", "revision must be a positive integer");
  }
  return join(
    requirementsRootDir(recordDir),
    "revisions",
    revision.toString().padStart(6, "0"),
    "requirements.json",
  );
}

export function loadRequirementsStageContract(
  path = STAGE_CONTRACT_PATH,
): VNextStageContract {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("ST-03 Contract", `cannot read ${path}: ${detail}`);
  }
  const contract = parseVNextStageContract(value, path);
  if (contract.stage_id !== "ST-03" || contract.name !== "Requirements & Constraints") {
    fail("ST-03 Contract", "must define ST-03 Requirements & Constraints");
  }
  return contract;
}

function readCurrent(
  projectDir: string,
  recordDir: string,
  intentId: string,
): { current: RequirementsCurrent; content: string } | null {
  const path = requirementsCurrentPath(recordDir);
  if (!existsSync(path)) return null;
  const parsed = readCanonical(path, parseRequirementsCurrent);
  if (parsed.value.intent_id !== intentId) {
    fail("ST-03 Requirements", "Requirements Current Intent does not match State");
  }
  const expectedPath = requirementsRevisionPath(recordDir, parsed.value.current_revision);
  if (
    parsed.value.requirements_ref.source_of_truth !== portableProjectPath(projectDir, expectedPath)
  ) fail("ST-03 Requirements", "Requirements Current points outside its revision path");
  verifyProjectArtifactReference(projectDir, parsed.value.requirements_ref);
  const definition = readCanonical(expectedPath, parseRequirementsDefinition).value;
  if (
    definition.intent_id !== intentId ||
    definition.revision !== parsed.value.current_revision
  ) fail("ST-03 Requirements", "Requirements Current and revision disagree");
  return { current: parsed.value, content: parsed.content };
}

function coverageRequired(intent: ReturnType<typeof parseIntentDefinition>): RequirementsSourceRef[] {
  return [
    ...intent.expected_outcomes.map((_, index) => ({
      artifact: "intent-definition" as const,
      pointer: `/expected_outcomes/${index}`,
    })),
    ...intent.success_signals.map((_, index) => ({
      artifact: "intent-definition" as const,
      pointer: `/success_signals/${index}`,
    })),
  ];
}

function prepareRequirementsLocked(
  projectDir: string,
  recordDir: string,
  options: RequirementsPrepareOptions,
): RequirementsPrepareResult {
  loadRequirementsStageContract();
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-03") {
    fail("ST-03 Requirements", `current Stage must be ST-03, found ${state.current_stage}`);
  }
  const decision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-03");
  if (decision === undefined) fail("ST-03 Requirements", "Plan has no ST-03 decision");
  if (decision.disposition === "not_applicable") {
    fail(
      "ST-03 Requirements",
      "ST-03 cannot be not_applicable; every Intent needs explicit requirements",
    );
  }

  const intentPath = intentDefinitionPath(recordDir);
  if (!existsSync(intentPath)) fail("ST-03 Requirements", "Intent Definition is required");
  const intent = readCanonical(intentPath, parseIntentDefinition);
  if (intent.value.intent_id !== state.intent_id) {
    fail("ST-03 Requirements", "Intent Definition Intent does not match State");
  }
  const intentReference = artifactReference(
    projectDir,
    intentPath,
    "intent-definition",
    intent.content,
  );
  const currentContextReference = intent.value.current_context_ref;
  const effectivePolicyReference = intent.value.effective_policy_ref;
  if (!referencesEqual(effectivePolicyReference, state.policy_snapshot)) {
    fail("ST-03 Requirements", "Intent Definition Policy does not match State");
  }
  for (const reference of [
    intentReference,
    currentContextReference,
    effectivePolicyReference,
  ]) verifyProjectArtifactReference(projectDir, reference);

  const current = readCurrent(projectDir, recordDir, state.intent_id);
  const baseRevision = current?.current.current_revision ?? null;
  const baseReference = current?.current.requirements_ref ?? null;
  const requiredCoverage = coverageRequired(intent.value);
  const path = requirementsWorkRequestPath(recordDir);
  if (existsSync(path)) {
    const stored = readCanonical(path, parseRequirementsWorkRequest);
    if (
      stored.value.intent_id === state.intent_id &&
      referencesEqual(stored.value.intent_definition_ref, intentReference) &&
      referencesEqual(stored.value.current_context_ref, currentContextReference) &&
      referencesEqual(stored.value.effective_policy_ref, effectivePolicyReference) &&
      stored.value.base_revision === baseRevision &&
      JSON.stringify(stored.value.base_requirements_ref) === JSON.stringify(baseReference) &&
      sourceRefsEqual(stored.value.coverage_required, requiredCoverage)
    ) {
      const reference = artifactReference(
        projectDir,
        path,
        "requirements-work-request",
        stored.content,
      );
      if (state.status !== "ready") {
        const { parked_reason: _parkedReason, ...unparkedState } = state;
        writeVNextStateAt(recordDir, {
          ...unparkedState,
          status: "ready",
          updated_at: stored.value.created_at,
        }, plan);
      }
      return { execution: "reused", request: stored.value, reference };
    }
  }

  const preparedAt = options.preparedAt ?? new Date().toISOString();
  const request = parseRequirementsWorkRequest({
    schema_version: 1,
    artifact: "requirements-work-request",
    version: 1,
    intent_id: state.intent_id,
    stage_id: "ST-03",
    intent_definition_ref: intentReference,
    current_context_ref: currentContextReference,
    effective_policy_ref: effectivePolicyReference,
    base_revision: baseRevision,
    base_requirements_ref: baseReference,
    coverage_required: requiredCoverage,
    requested_outputs: ["requirements-definition-proposal"],
    rules: [
      "Define observable functional requirements, relevant quality requirements, constraints, invariants, and open questions only.",
      "Every requirement item must cite an existing JSON Pointer in the pinned Intent Definition, Current Context, or Effective Policy.",
      "Cover every expected outcome and success signal from the Intent Definition without expanding its scope.",
      "Do not add architecture choices, acceptance test procedures, Bolt plans, implementation instructions, or routes.",
      "Ask a human before submission when a value judgment, conflict, or risk acceptance remains unresolved.",
      "AI proposes content only; Core validates, versions, persists, and owns the fixed Stage transition.",
    ],
    created_at: preparedAt,
  });
  const content = serialize(request);
  writeFileAtomic(path, content);
  const reference = artifactReference(
    projectDir,
    path,
    "requirements-work-request",
    content,
  );
  const { parked_reason: _parkedReason, ...unparkedState } = state;
  writeVNextStateAt(recordDir, {
    ...unparkedState,
    status: "ready",
    updated_at: preparedAt,
  }, plan);
  return { execution: "prepared", request, reference };
}

export function prepareRequirements(
  projectDir: string,
  options: RequirementsPrepareOptions = {},
): RequirementsPrepareResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return prepareRequirementsLocked(projectRoot, recordDir, options);
    } catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-03",
        Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "),
        "Decision Authority": "core",
      });
      throw error;
    }
  });
}

function readInputJson(projectDir: string, reference: ArtifactReference): unknown {
  verifyProjectArtifactReference(projectDir, reference);
  try {
    return JSON.parse(readFileSync(resolve(projectDir, reference.source_of_truth), "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("ST-03 Requirements", `cannot read ${reference.artifact}: ${detail}`);
  }
}

function jsonPointerExists(value: unknown, pointer: string): boolean {
  let current = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return false;
      const index = Number(token);
      if (index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) return false;
    if (!Object.prototype.hasOwnProperty.call(current, token)) return false;
    current = (current as Record<string, unknown>)[token];
  }
  return true;
}

function allRequirementSourceRefs(
  proposal: RequirementsDefinitionProposal,
): RequirementsSourceRef[] {
  return [
    ...proposal.functional_requirements,
    ...proposal.quality_requirements,
    ...proposal.constraints,
    ...proposal.invariants,
  ].flatMap((item) => item.source_refs);
}

function validateProposalSources(
  projectDir: string,
  request: RequirementsWorkRequest,
  proposal: RequirementsDefinitionProposal,
): void {
  const inputByArtifact = new Map<string, unknown>([
    ["intent-definition", readInputJson(projectDir, request.intent_definition_ref)],
    ["current-context", readInputJson(projectDir, request.current_context_ref)],
    ["effective-policy", readInputJson(projectDir, request.effective_policy_ref)],
  ]);
  const allReferences = [
    ...allRequirementSourceRefs(proposal),
    ...proposal.open_questions.flatMap((question) => question.source_refs),
  ];
  for (const reference of allReferences) {
    const input = inputByArtifact.get(reference.artifact);
    if (input === undefined || !jsonPointerExists(input, reference.pointer)) {
      fail(
        "ST-03 Requirements",
        `source pointer does not exist: ${reference.artifact}:${reference.pointer}`,
      );
    }
  }
  const covered = new Set(
    allRequirementSourceRefs(proposal).map(
      (reference) => `${reference.artifact}:${reference.pointer}`,
    ),
  );
  for (const required of request.coverage_required) {
    const key = `${required.artifact}:${required.pointer}`;
    if (!covered.has(key)) {
      fail("ST-03 Requirements", `required coverage is missing: ${key}`);
    }
  }
  const blocker = proposal.open_questions.find((question) => question.blocking);
  if (blocker !== undefined) {
    fail("ST-03 Requirements", `blocking open question must be resolved: ${blocker.id}`);
  }
}

function recoverInterruptedPreparation(
  projectDir: string,
  recordDir: string,
  state: VNextIntentState,
  proposal: RequirementsDefinitionProposal,
): RequirementsPrepareResult | null {
  const requestPath = requirementsWorkRequestPath(recordDir);
  if (!existsSync(requestPath) || !existsSync(requirementsCurrentPath(recordDir))) {
    return null;
  }
  const stored = readCanonical(requestPath, parseRequirementsWorkRequest);
  const reference = artifactReference(
    projectDir,
    requestPath,
    "requirements-work-request",
    stored.content,
  );
  if (
    stored.value.intent_id !== state.intent_id ||
    proposal.intent_id !== state.intent_id ||
    proposal.work_request_sha256 !== reference.sha256
  ) return null;

  const intentPath = intentDefinitionPath(recordDir);
  if (!existsSync(intentPath)) return null;
  const intent = readCanonical(intentPath, parseIntentDefinition);
  const liveIntentReference = artifactReference(
    projectDir,
    intentPath,
    "intent-definition",
    intent.content,
  );
  if (
    !referencesEqual(stored.value.intent_definition_ref, liveIntentReference) ||
    !referencesEqual(stored.value.current_context_ref, intent.value.current_context_ref) ||
    !referencesEqual(stored.value.effective_policy_ref, intent.value.effective_policy_ref) ||
    !referencesEqual(stored.value.effective_policy_ref, state.policy_snapshot)
  ) return null;

  const current = readCurrent(projectDir, recordDir, state.intent_id);
  const interruptedRevision = (stored.value.base_revision ?? 0) + 1;
  if (current === null || current.current.current_revision !== interruptedRevision) {
    return null;
  }
  const definition = readCanonical(
    requirementsRevisionPath(recordDir, interruptedRevision),
    parseRequirementsDefinition,
  ).value;
  const storedBody = {
    proposal_id: definition.proposal_id,
    functional_requirements: definition.functional_requirements,
    quality_requirements: definition.quality_requirements,
    constraints: definition.constraints,
    invariants: definition.invariants,
    open_questions: definition.open_questions,
    reason: definition.reason,
  };
  const proposalBody = {
    proposal_id: proposal.proposal_id,
    functional_requirements: proposal.functional_requirements,
    quality_requirements: proposal.quality_requirements,
    constraints: proposal.constraints,
    invariants: proposal.invariants,
    open_questions: proposal.open_questions,
    reason: proposal.reason,
  };
  if (
    definition.base_revision !== stored.value.base_revision ||
    !referencesEqual(definition.intent_definition_ref, stored.value.intent_definition_ref) ||
    !referencesEqual(definition.current_context_ref, stored.value.current_context_ref) ||
    !referencesEqual(definition.effective_policy_ref, stored.value.effective_policy_ref) ||
    JSON.stringify(storedBody) !== JSON.stringify(proposalBody)
  ) return null;
  for (const inputReference of [
    stored.value.intent_definition_ref,
    stored.value.current_context_ref,
    stored.value.effective_policy_ref,
  ]) verifyProjectArtifactReference(projectDir, inputReference);
  return {
    execution: "reused",
    request: stored.value,
    reference,
  };
}

function completeRequirementsLocked(
  projectDir: string,
  recordDir: string,
  proposalValue: unknown,
  options: RequirementsCompleteOptions,
): RequirementsCompleteResult {
  const state = readVNextStateAt(recordDir);
  if (state.current_stage !== "ST-03") {
    fail("ST-03 Requirements", `current Stage must be ST-03, found ${state.current_stage}`);
  }
  const plan = readVNextPlanAt(recordDir);
  loadRequirementsStageContract();
  const decision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-03");
  if (decision === undefined) fail("ST-03 Requirements", "Plan has no ST-03 decision");
  if (decision.disposition === "not_applicable") {
    fail(
      "ST-03 Requirements",
      "ST-03 cannot be not_applicable; every Intent needs explicit requirements",
    );
  }
  const proposal = parseRequirementsDefinitionProposal(proposalValue);
  if (proposal.intent_id !== state.intent_id) {
    fail("ST-03 Requirements", "Proposal Intent does not match State");
  }
  const prepared = recoverInterruptedPreparation(
    projectDir,
    recordDir,
    state,
    proposal,
  ) ?? prepareRequirementsLocked(projectDir, recordDir, {});
  if (proposal.work_request_sha256 !== prepared.reference.sha256) {
    fail(
      "ST-03 Requirements",
      "Proposal does not reference the current Requirements Work Request",
    );
  }
  validateProposalSources(projectDir, prepared.request, proposal);

  const completedAt = options.completedAt ?? new Date().toISOString();
  const revision = (prepared.request.base_revision ?? 0) + 1;
  let definition = parseRequirementsDefinition({
    schema_version: 1,
    artifact: "requirements-definition",
    version: 1,
    intent_id: state.intent_id,
    revision,
    base_revision: prepared.request.base_revision,
    proposal_id: proposal.proposal_id,
    intent_definition_ref: prepared.request.intent_definition_ref,
    current_context_ref: prepared.request.current_context_ref,
    effective_policy_ref: prepared.request.effective_policy_ref,
    functional_requirements: proposal.functional_requirements,
    quality_requirements: proposal.quality_requirements,
    constraints: proposal.constraints,
    invariants: proposal.invariants,
    open_questions: proposal.open_questions,
    reason: proposal.reason,
    created_at: completedAt,
  });
  const revisionPath = requirementsRevisionPath(recordDir, revision);
  let revisionContent = serialize(definition);
  if (existsSync(revisionPath)) {
    const stored = readCanonical(revisionPath, parseRequirementsDefinition);
    const { created_at: _candidateCreatedAt, ...candidateStable } = definition;
    const { created_at: _storedCreatedAt, ...storedStable } = stored.value;
    if (JSON.stringify(storedStable) !== JSON.stringify(candidateStable)) {
      fail(
        "ST-03 Requirements",
        `immutable Requirements revision ${revision} already exists with different content`,
      );
    }
    definition = stored.value;
    revisionContent = stored.content;
  } else {
    writeFileAtomic(revisionPath, revisionContent);
  }
  const reference = artifactReference(
    projectDir,
    revisionPath,
    "requirements-definition",
    revisionContent,
  );
  verifyProjectArtifactReference(projectDir, reference);

  const current = parseRequirementsCurrent({
    schema_version: 1,
    artifact: "requirements-current",
    version: 1,
    intent_id: state.intent_id,
    current_revision: revision,
    requirements_ref: reference,
    updated_at: completedAt,
  });
  const currentPath = requirementsCurrentPath(recordDir);
  const currentContent = serialize(current);
  writeFileAtomic(currentPath, currentContent);
  const currentReference = artifactReference(
    projectDir,
    currentPath,
    "requirements-current",
    currentContent,
  );

  const definitions = loadVNextDefinitions();
  const nextStage = nextForwardStage(definitions.graph, "ST-03");
  if (nextStage !== "ST-04") fail("ST-03 Requirements", "fixed Graph must route to ST-04");
  validateCoreRoute(definitions.graph, { from: "ST-03", to: nextStage });
  const alreadyCompleted = readOrderedAuditEntries(recordDir).some((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-03" &&
    entry.fields["Requirements SHA-256"] === reference.sha256
  );
  if (!alreadyCompleted) {
    appendAuditEntries(projectDir, recordDir, [
      {
        event: "STAGE_STARTED",
        fields: {
          Stage: "ST-03",
          Executor: "ai+core",
          Verifier: "requirements-definition-validator",
        },
      },
      {
        event: "STAGE_COMPLETED",
        fields: {
          Stage: "ST-03",
          Artifact: reference.source_of_truth,
          "Requirements Revision": String(revision),
          "Requirements SHA-256": reference.sha256,
          "Decision Authority": "core",
        },
      },
      {
        event: "ROUTE_DECIDED",
        fields: {
          "From Stage": "ST-03",
          "Current Stage": "ST-04",
          Graph: definitions.graph.graph_version,
          "Decision Authority": "core",
        },
      },
    ]);
  }
  const advanced: VNextIntentState = {
    ...state,
    current_stage: "ST-04",
    status: "parked",
    parked_reason: "ST-04 Stage Contract is not implemented yet.",
    updated_at: completedAt,
  };
  writeVNextStateAt(recordDir, advanced, plan);
  return {
    definition,
    reference,
    current,
    currentReference,
    state: readVNextStateAt(recordDir),
  };
}

export function completeRequirements(
  projectDir: string,
  proposalValue: unknown,
  options: RequirementsCompleteOptions = {},
): RequirementsCompleteResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return completeRequirementsLocked(projectRoot, recordDir, proposalValue, options);
    } catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-03",
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
      "Usage: aidlc requirements prepare <project-dir>\n" +
        "       aidlc requirements complete <project-dir> <proposal.json>",
    );
    process.exitCode = 1;
    return;
  }
  try {
    if (projectDir === undefined) throw new Error("project directory is required");
    const result = command === "prepare"
      ? prepareRequirements(projectDir)
      : completeRequirements(
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
