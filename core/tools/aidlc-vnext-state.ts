import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import {
  parseArtifactReference,
  parseStageExecutionPlan,
  VNEXT_STAGE_IDS,
  type ArtifactReference,
  type StageExecutionPlan,
  type VNextStageId,
} from "./aidlc-stage-contract.ts";
import { verifyProjectArtifactReference } from "./aidlc-effective-policy.ts";
import { readOrderedAuditEntries } from "./aidlc-audit.ts";
import {
  parseDefineIntentWorkRequest,
  parseIntentDefinition,
} from "./aidlc-vnext-define-intent-contract.ts";
import {
  parseCurrentContext,
  parseOrientWorkRequest,
  parseSystemMap,
  parseSystemMapBaseline,
  parseWorkspaceProfile,
} from "./aidlc-vnext-orient-contract.ts";
import {
  parseRequirementsCurrent,
  parseRequirementsDefinition,
  parseRequirementsWorkRequest,
} from "./aidlc-vnext-requirements-contract.ts";
import {
  parseArchitectureAssessmentProposal,
  parseArchitectureCurrent,
  parseArchitectureDecision,
  parseArchitecturePolicyApproval,
  parseArchitectureReuseApproval,
  parseArchitectureWorkRequest,
} from "./aidlc-vnext-architecture-contract.ts";
import {
  parseBuildContract,
  parseBuildContractApproval,
  parseBuildContractCandidate,
  parseBuildContractCurrent,
  parseBuildContractWorkRequest,
  renderBuildContractReviewHtml,
} from "./aidlc-vnext-build-contract-contract.ts";
import {
  parseBoltWorkRequest,
  parseBuildAttemptCheckpoint,
  parseBuildCurrent,
  parseBuildSession,
  parseRunnableCandidate,
  parseVerifierEvidence,
} from "./aidlc-vnext-build-converge-contract.ts";
import {
  parseAcceptedCandidate,
  parseCandidateReviewDecision,
  parseReviewCurrent,
  parseReviewManifest,
  renderCandidateReviewHtml,
} from "./aidlc-vnext-review-contract.ts";
import {
  parseDeploymentMap,
  parseReleaseAttempt,
  parseReleaseAuthority,
  parseReleaseCapabilitySnapshot,
  parseReleaseCurrent,
  parseReleasePlan,
  parseReleaseReceipt,
  parseReleaseStepReceipt,
  parseReleaseWorkRequest,
  renderReleaseReviewHtml,
} from "./aidlc-vnext-release-contract.ts";
import {
  parseFollowUpBrief,
  parseOutcomeCurrent,
  parseOutcomeEvaluation,
  parseOutcomeEvidence,
  parseOutcomeHumanDecision,
  parseOutcomeWorkRequest,
  renderOutcomeEvaluationHtml,
} from "./aidlc-vnext-outcome-contract.ts";
import {
  parseHumanGateRequirementSet,
  renderHumanGateRequirementSection,
  resolveHumanGateRequirementsAt,
  validatePolicyAcknowledgements,
} from "./aidlc-vnext-policy-gates.ts";
import { validateIntentRiskArtifactsAt } from "./aidlc-vnext-risk.ts";

export const VNEXT_STATE_SCHEMA_VERSION = 1 as const;
export const VNEXT_STATE_STATUSES = ["parked", "ready", "completed"] as const;
export type VNextStateStatus = (typeof VNEXT_STATE_STATUSES)[number];

export interface VNextIntentState {
  schema_version: typeof VNEXT_STATE_SCHEMA_VERSION;
  workflow: "vnext";
  intent_id: string;
  catalog_version: string;
  graph_version: string;
  plan_revision: number;
  policy_snapshot: ArtifactReference;
  current_stage: VNextStageId;
  status: VNextStateStatus;
  parked_reason?: string;
  not_before?: string;
  deadline?: string;
  created_at: string;
  updated_at: string;
}

export interface InitializedVNextIntentState {
  state: VNextIntentState;
  statePath: string;
  summaryPath: string;
  planPath: string;
}

export type ActiveIntentWorkflowState =
  | { kind: "vnext"; recordDir: string; selected: string }
  | { kind: "unsupported"; recordDir: string; selected: string }
  | { kind: "incomplete"; recordDir: string; selected: string };

const STATE_KEYS = [
  "schema_version",
  "workflow",
  "intent_id",
  "catalog_version",
  "graph_version",
  "plan_revision",
  "policy_snapshot",
  "current_stage",
  "status",
  "parked_reason",
  "not_before",
  "deadline",
  "created_at",
  "updated_at",
] as const;

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}

function asOneLine(value: unknown, context: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value !== value.trim() ||
    /[\r\n\0]/.test(value)
  ) fail(context, "must be a non-empty single-line string");
  return value;
}

function asPositiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(context, "must be a positive integer");
  }
  return value as number;
}

function asIsoTimestamp(value: unknown, context: string): string {
  const timestamp = asOneLine(value, context);
  if (Number.isNaN(Date.parse(timestamp)) || !timestamp.endsWith("Z")) {
    fail(context, "must be an ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function asStageId(value: unknown, context: string): VNextStageId {
  const stageId = asOneLine(value, context);
  if (!(VNEXT_STAGE_IDS as readonly string[]).includes(stageId)) {
    fail(context, `must be one of: ${VNEXT_STAGE_IDS.join(", ")}`);
  }
  return stageId as VNextStageId;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename has already consumed the temporary path.
    }
    throw error;
  }
}

export function vNextStatePath(recordDir: string): string {
  return join(resolve(recordDir), "aidlc-state.json");
}

export function vNextStateSummaryPath(recordDir: string): string {
  return join(resolve(recordDir), "aidlc-state.md");
}

export function vNextPlanPath(recordDir: string): string {
  return join(resolve(recordDir), "stage-execution-plan.json");
}

export function inspectActiveIntentWorkflowState(
  projectDir: string,
): ActiveIntentWorkflowState {
  const projectRoot = resolve(projectDir);
  const intentsRoot = join(
    workspaceRoot(projectRoot),
    "spaces",
    activeSpace(projectRoot),
    "intents",
  );
  let selected = "";
  try {
    selected = readFileSync(join(intentsRoot, "active-intent"), "utf8").trim();
  } catch {
    // A stable, actionable error is reported below.
  }
  if (selected === "" || selected.includes("/") || selected.includes("\\")) {
    fail("vNext State", "no valid active Intent; run aidlc intent birth first");
  }
  const recordDir = join(intentsRoot, selected);
  if (existsSync(vNextStatePath(recordDir))) {
    return { kind: "vnext", recordDir, selected };
  }
  const oldPlan = join(recordDir, ".aidlc-plan.json");
  const summary = vNextStateSummaryPath(recordDir);
  let oldSummary = false;
  try {
    const content = readFileSync(summary, "utf8");
    oldSummary = content.includes("## Scope Configuration") ||
      content.includes("## Stage Progress");
  } catch {
    // Missing or unreadable summaries are handled as an incomplete vNext Intent.
  }
  return existsSync(oldPlan) || oldSummary
    ? { kind: "unsupported", recordDir, selected }
    : { kind: "incomplete", recordDir, selected };
}

export function unsupportedWorkflowStateMessage(
  selected: string,
): string {
  return `unsupported pre-vNext Workflow State in Intent ${selected}; ` +
    "automatic conversion is disabled; run aidlc intent birth to start a new vNext Intent";
}

export function activeVNextIntentRecordDir(projectDir: string): string {
  const inspected = inspectActiveIntentWorkflowState(projectDir);
  if (inspected.kind === "unsupported") {
    fail("vNext State", unsupportedWorkflowStateMessage(inspected.selected));
  }
  if (inspected.kind === "incomplete") {
    fail("vNext State", `active Intent is not initialized for vNext: ${inspected.selected}`);
  }
  return inspected.recordDir;
}

export function activeVNextStatePath(projectDir: string): string {
  return vNextStatePath(activeVNextIntentRecordDir(projectDir));
}

export function activeVNextPlanPath(projectDir: string): string {
  return vNextPlanPath(activeVNextIntentRecordDir(projectDir));
}

export function parseVNextIntentState(
  value: unknown,
  context = "vNext Intent State",
): VNextIntentState {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, STATE_KEYS, context);
  if (record.schema_version !== VNEXT_STATE_SCHEMA_VERSION) {
    fail(`${context}.schema_version`, `must equal ${VNEXT_STATE_SCHEMA_VERSION}`);
  }
  if (record.workflow !== "vnext") fail(`${context}.workflow`, "must equal vnext");
  const status = asOneLine(record.status, `${context}.status`);
  if (!(VNEXT_STATE_STATUSES as readonly string[]).includes(status)) {
    fail(`${context}.status`, `must be one of: ${VNEXT_STATE_STATUSES.join(", ")}`);
  }
  const parkedReason = record.parked_reason === undefined
    ? undefined
    : asOneLine(record.parked_reason, `${context}.parked_reason`);
  if (status === "parked" && parkedReason === undefined) {
    fail(`${context}.parked_reason`, "is required while status is parked");
  }
  if (status !== "parked" && parkedReason !== undefined) {
    fail(`${context}.parked_reason`, "is allowed only while status is parked");
  }
  const notBefore = record.not_before === undefined
    ? undefined
    : asIsoTimestamp(record.not_before, `${context}.not_before`);
  const deadline = record.deadline === undefined
    ? undefined
    : asIsoTimestamp(record.deadline, `${context}.deadline`);
  if (status !== "parked" && (notBefore !== undefined || deadline !== undefined)) {
    fail(context, "observation schedule is allowed only while status is parked");
  }
  if (deadline !== undefined && notBefore === undefined) {
    fail(`${context}.not_before`, "is required when deadline is present");
  }
  if (
    deadline !== undefined && notBefore !== undefined &&
    Date.parse(deadline) <= Date.parse(notBefore)
  ) fail(`${context}.deadline`, "must be after not_before");
  return {
    schema_version: VNEXT_STATE_SCHEMA_VERSION,
    workflow: "vnext",
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    catalog_version: asOneLine(record.catalog_version, `${context}.catalog_version`),
    graph_version: asOneLine(record.graph_version, `${context}.graph_version`),
    plan_revision: asPositiveInteger(record.plan_revision, `${context}.plan_revision`),
    policy_snapshot: parseArtifactReference(
      record.policy_snapshot,
      `${context}.policy_snapshot`,
    ),
    current_stage: asStageId(record.current_stage, `${context}.current_stage`),
    status: status as VNextStateStatus,
    ...(parkedReason === undefined ? {} : { parked_reason: parkedReason }),
    ...(notBefore === undefined ? {} : { not_before: notBefore }),
    ...(deadline === undefined ? {} : { deadline }),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
    updated_at: asIsoTimestamp(record.updated_at, `${context}.updated_at`),
  };
}

export function readVNextStateAt(recordDir: string): VNextIntentState {
  const path = vNextStatePath(recordDir);
  try {
    return parseVNextIntentState(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${path}:`)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail("vNext State", `cannot read ${path}: ${detail}`);
  }
}

export function readVNextPlanAt(recordDir: string): StageExecutionPlan {
  const path = vNextPlanPath(recordDir);
  try {
    return parseStageExecutionPlan(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${path}:`)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail("Stage Execution Plan", `cannot read ${path}: ${detail}`);
  }
}

function renderSummary(state: VNextIntentState, plan: StageExecutionPlan): string {
  const decisions = plan.stage_decisions.map((decision) => {
    const marker = decision.stage_id === state.current_stage ? ">" : "-";
    return `${marker} ${decision.stage_id}: ${decision.disposition}`;
  });
  return [
    "# AI-DLC vNext State",
    "",
    `- Intent: ${state.intent_id}`,
    `- Current Stage: ${state.current_stage}`,
    `- Status: ${state.status}`,
    `- Plan Revision: ${state.plan_revision}`,
    `- Graph: ${state.graph_version}`,
    ...(state.parked_reason === undefined ? [] : [`- Parked Reason: ${state.parked_reason}`]),
    ...(state.not_before === undefined ? [] : [`- Not Before: ${state.not_before}`]),
    ...(state.deadline === undefined ? [] : [`- Deadline: ${state.deadline}`]),
    "",
    "## Stage Execution Plan",
    "",
    ...decisions,
    "",
    "> This file is a human-readable mirror. Core-owned JSON files are authoritative.",
    "",
  ].join("\n");
}

export function writeVNextPlanAt(
  recordDir: string,
  planValue: StageExecutionPlan,
): string {
  const plan = parseStageExecutionPlan(planValue);
  const path = vNextPlanPath(recordDir);
  writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

export function writeVNextStateAt(
  recordDir: string,
  stateValue: VNextIntentState,
  planValue: StageExecutionPlan,
): string {
  const state = parseVNextIntentState(stateValue);
  const plan = parseStageExecutionPlan(planValue);
  if (state.intent_id !== plan.intent_id) fail("vNext State", "Intent does not match Plan");
  if (state.graph_version !== plan.graph_version) fail("vNext State", "Graph does not match Plan");
  if (state.plan_revision !== plan.revision) fail("vNext State", "revision does not match Plan");
  if (JSON.stringify(state.policy_snapshot) !== JSON.stringify(plan.policy_snapshot)) {
    fail("vNext State", "Effective Policy reference does not match Plan");
  }
  const path = vNextStatePath(recordDir);
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  writeFileAtomic(vNextStateSummaryPath(recordDir), renderSummary(state, plan));
  return path;
}

export function initializeVNextIntentStateAt(
  projectDir: string,
  recordDir: string,
  options: {
    intentId: string;
    catalogVersion: string;
    graphVersion: string;
    policySnapshot: ArtifactReference;
    plan: StageExecutionPlan;
    createdAt?: string;
  },
): InitializedVNextIntentState {
  const statePath = vNextStatePath(recordDir);
  const planPath = vNextPlanPath(recordDir);
  if (existsSync(statePath) || existsSync(planPath)) {
    fail("vNext State", "Core-owned State or Plan already exists");
  }
  verifyProjectArtifactReference(projectDir, options.policySnapshot);
  const now = options.createdAt ?? new Date().toISOString();
  const plan = parseStageExecutionPlan(options.plan);
  const state = parseVNextIntentState({
    schema_version: VNEXT_STATE_SCHEMA_VERSION,
    workflow: "vnext",
    intent_id: options.intentId,
    catalog_version: options.catalogVersion,
    graph_version: options.graphVersion,
    plan_revision: plan.revision,
    policy_snapshot: options.policySnapshot,
    current_stage: "ST-00",
    status: "parked",
    parked_reason: "ST-00 is ready for Core Bootstrap execution.",
    created_at: now,
    updated_at: now,
  });
  writeVNextPlanAt(recordDir, plan);
  writeVNextStateAt(recordDir, state, plan);
  return {
    state,
    statePath,
    summaryPath: vNextStateSummaryPath(recordDir),
    planPath,
  };
}

export function validateVNextIntentAt(projectDir: string, recordDir: string): void {
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.intent_id !== plan.intent_id) fail("vNext State", "Intent does not match Plan");
  if (state.graph_version !== plan.graph_version) fail("vNext State", "Graph does not match Plan");
  if (state.plan_revision !== plan.revision) fail("vNext State", "revision does not match Plan");
  if (JSON.stringify(state.policy_snapshot) !== JSON.stringify(plan.policy_snapshot)) {
    fail("vNext State", "Effective Policy reference does not match Plan");
  }
  verifyProjectArtifactReference(projectDir, state.policy_snapshot);
  validateIntentRiskArtifactsAt(projectDir, recordDir, state.intent_id);
  validateOrientArtifactsAt(projectDir, recordDir, state);
  validateDefineIntentArtifactsAt(projectDir, recordDir, state);
  validateRequirementsArtifactsAt(projectDir, recordDir, state);
  validateArchitectureArtifactsAt(projectDir, recordDir, state, plan);
  validateBuildContractArtifactsAt(projectDir, recordDir, state, plan);
  validateBuildConvergeArtifactsAt(projectDir, recordDir, state, plan);
  validateCandidateReviewArtifactsAt(projectDir, recordDir, state, plan);
  validateReleaseArtifactsAt(projectDir, recordDir, state, plan);
  validateOutcomeArtifactsAt(projectDir, recordDir, state, plan);
}

function readJsonArtifact(path: string, context: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(context, `cannot read ${path}: ${detail}`);
  }
}

/** Verify ST-01 artifacts whenever they exist or a later Stage depends on them. */
export function validateOrientArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  if (state.current_stage === "ST-00") return;
  const artifactsDir = join(resolve(recordDir), "artifacts");
  const profilePath = join(artifactsDir, "workspace-profile.json");
  const requestPath = join(artifactsDir, "orient-work-request.json");
  const contextPath = join(artifactsDir, "current-context.json");
  const hasPreparedArtifacts = existsSync(profilePath) || existsSync(requestPath);
  if (hasPreparedArtifacts) {
    if (!existsSync(profilePath) || !existsSync(requestPath)) {
      fail("ST-01 Orient", "Workspace Profile and Work Request must exist together");
    }
    const profile = parseWorkspaceProfile(
      readJsonArtifact(profilePath, "ST-01 Orient"),
      profilePath,
    );
    const request = parseOrientWorkRequest(
      readJsonArtifact(requestPath, "ST-01 Orient"),
      requestPath,
    );
    if (profile.intent_id !== state.intent_id || request.intent_id !== state.intent_id) {
      fail("ST-01 Orient", "prepared Artifact Intent does not match State");
    }
    verifyProjectArtifactReference(projectDir, request.design_brief_ref);
    verifyProjectArtifactReference(projectDir, request.bootstrap_receipt_ref);
    verifyProjectArtifactReference(projectDir, request.workspace_profile_ref);
    if (request.system_map_baseline_ref !== undefined) {
      verifyProjectArtifactReference(projectDir, request.system_map_baseline_ref);
    }
  }
  const stageIndex = VNEXT_STAGE_IDS.indexOf(state.current_stage);
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-02")) return;
  if (!existsSync(contextPath)) {
    fail("ST-01 Orient", "Current Context is required after ST-01 completion");
  }
  const context = parseCurrentContext(
    readJsonArtifact(contextPath, "ST-01 Orient"),
    contextPath,
  );
  if (context.intent_id !== state.intent_id) {
    fail("ST-01 Orient", "Current Context Intent does not match State");
  }
  for (const reference of [
    context.design_brief_ref,
    context.workspace_profile_ref,
    context.system_map_ref,
  ]) verifyProjectArtifactReference(projectDir, reference);
  const mapPath = resolve(projectDir, context.system_map_ref.source_of_truth);
  const map = parseSystemMap(readJsonArtifact(mapPath, "ST-01 Orient"), mapPath);
  if (map.revision !== context.system_map_revision) {
    fail("ST-01 Orient", "Current Context revision does not match its System Map");
  }
  const entityIds = new Set(map.entities.map((entry) => entry.entity_id));
  const relationIds = new Set(map.relations.map((entry) => entry.relation_id));
  for (const id of context.entity_ids) {
    if (!entityIds.has(id)) fail("ST-01 Orient", `Current Context entity is missing: ${id}`);
  }
  for (const id of context.relation_ids) {
    if (!relationIds.has(id)) fail("ST-01 Orient", `Current Context relation is missing: ${id}`);
  }
  const baselinePath = join(
    workspaceRoot(projectDir),
    "spaces",
    activeSpace(projectDir),
    "codekb",
    "system-map",
    "baseline.json",
  );
  const baseline = parseSystemMapBaseline(
    readJsonArtifact(baselinePath, "ST-01 Orient"),
    baselinePath,
  );
  const baselineReference = parseArtifactReference({
    artifact: "system-map",
    version: 1,
    source_of_truth: baseline.source_of_truth,
    sha256: baseline.sha256,
  });
  verifyProjectArtifactReference(projectDir, baselineReference);
}

/** Verify ST-02 inputs and its canonical Intent Definition after completion. */
export function validateDefineIntentArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  const stageIndex = VNEXT_STAGE_IDS.indexOf(state.current_stage);
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-02")) return;
  const artifactsDir = join(resolve(recordDir), "artifacts");
  const requestPath = join(artifactsDir, "define-intent-work-request.json");
  const definitionPath = join(artifactsDir, "intent-definition.json");
  const hasRequest = existsSync(requestPath);
  if (hasRequest) {
    const request = parseDefineIntentWorkRequest(
      readJsonArtifact(requestPath, "ST-02 Define Intent"),
      requestPath,
    );
    if (request.intent_id !== state.intent_id) {
      fail("ST-02 Define Intent", "Work Request Intent does not match State");
    }
    for (const reference of [
      request.design_brief_ref,
      request.current_context_ref,
      request.effective_policy_ref,
    ]) verifyProjectArtifactReference(projectDir, reference);
  }
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-03")) return;
  if (!hasRequest || !existsSync(definitionPath)) {
    fail("ST-02 Define Intent", "Work Request and Intent Definition are required after ST-02 completion");
  }
  const content = readFileSync(definitionPath, "utf8");
  const definition = parseIntentDefinition(
    readJsonArtifact(definitionPath, "ST-02 Define Intent"),
    definitionPath,
  );
  if (content !== `${JSON.stringify(definition, null, 2)}\n`) {
    fail("ST-02 Define Intent", "Intent Definition is not canonical");
  }
  if (definition.intent_id !== state.intent_id) {
    fail("ST-02 Define Intent", "Intent Definition Intent does not match State");
  }
  for (const reference of [
    definition.design_brief_ref,
    definition.current_context_ref,
    definition.effective_policy_ref,
  ]) verifyProjectArtifactReference(projectDir, reference);
  const request = parseDefineIntentWorkRequest(
    readJsonArtifact(requestPath, "ST-02 Define Intent"),
    requestPath,
  );
  if (
    JSON.stringify(definition.design_brief_ref) !== JSON.stringify(request.design_brief_ref) ||
    JSON.stringify(definition.current_context_ref) !== JSON.stringify(request.current_context_ref) ||
    JSON.stringify(definition.effective_policy_ref) !== JSON.stringify(request.effective_policy_ref)
  ) fail("ST-02 Define Intent", "Intent Definition inputs do not match its Work Request");
  const recordedDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const completed = readOrderedAuditEntries(recordDir).some((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-02" &&
    entry.fields["Intent Definition SHA-256"] === recordedDigest
  );
  if (!completed) {
    fail("ST-02 Define Intent", "Audit does not pin the canonical Intent Definition SHA-256");
  }
}

/** Verify ST-03 inputs and the immutable Requirements revision after completion. */
export function validateRequirementsArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  const stageIndex = VNEXT_STAGE_IDS.indexOf(state.current_stage);
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-03")) return;

  const requirementsDir = join(resolve(recordDir), "artifacts", "requirements");
  const requestPath = join(requirementsDir, "requirements-work-request.json");
  const currentPath = join(requirementsDir, "current.json");
  const hasRequest = existsSync(requestPath);
  let request: ReturnType<typeof parseRequirementsWorkRequest> | undefined;

  if (hasRequest) {
    const content = readFileSync(requestPath, "utf8");
    request = parseRequirementsWorkRequest(
      readJsonArtifact(requestPath, "ST-03 Requirements"),
      requestPath,
    );
    if (content !== `${JSON.stringify(request, null, 2)}\n`) {
      fail("ST-03 Requirements", "Work Request is not canonical");
    }
    if (request.intent_id !== state.intent_id) {
      fail("ST-03 Requirements", "Work Request Intent does not match State");
    }
    for (const reference of [
      request.intent_definition_ref,
      request.current_context_ref,
      request.effective_policy_ref,
    ]) verifyProjectArtifactReference(projectDir, reference);
    if (request.base_requirements_ref !== null) {
      verifyProjectArtifactReference(projectDir, request.base_requirements_ref);
    }
  }

  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-04")) return;
  if (!hasRequest || request === undefined || !existsSync(currentPath)) {
    fail(
      "ST-03 Requirements",
      "Work Request and Requirements Current are required after ST-03 completion",
    );
  }

  const currentContent = readFileSync(currentPath, "utf8");
  const current = parseRequirementsCurrent(
    readJsonArtifact(currentPath, "ST-03 Requirements"),
    currentPath,
  );
  if (currentContent !== `${JSON.stringify(current, null, 2)}\n`) {
    fail("ST-03 Requirements", "Requirements Current is not canonical");
  }
  if (current.intent_id !== state.intent_id) {
    fail("ST-03 Requirements", "Requirements Current Intent does not match State");
  }
  verifyProjectArtifactReference(projectDir, current.requirements_ref);

  const revisionPath = join(
    requirementsDir,
    "revisions",
    current.current_revision.toString().padStart(6, "0"),
    "requirements.json",
  );
  if (
    resolve(projectDir, current.requirements_ref.source_of_truth) !== resolve(revisionPath)
  ) {
    fail("ST-03 Requirements", "Requirements Current does not point to its revision path");
  }
  const definitionContent = readFileSync(revisionPath, "utf8");
  const definition = parseRequirementsDefinition(
    readJsonArtifact(revisionPath, "ST-03 Requirements"),
    revisionPath,
  );
  if (definitionContent !== `${JSON.stringify(definition, null, 2)}\n`) {
    fail("ST-03 Requirements", "Requirements Definition is not canonical");
  }
  if (
    definition.intent_id !== state.intent_id ||
    definition.revision !== current.current_revision
  ) {
    fail("ST-03 Requirements", "Requirements Current and Definition disagree");
  }
  if (
    definition.base_revision !== request.base_revision ||
    JSON.stringify(definition.intent_definition_ref) !==
      JSON.stringify(request.intent_definition_ref) ||
    JSON.stringify(definition.current_context_ref) !==
      JSON.stringify(request.current_context_ref) ||
    JSON.stringify(definition.effective_policy_ref) !==
      JSON.stringify(request.effective_policy_ref)
  ) {
    fail("ST-03 Requirements", "Requirements Definition inputs do not match its Work Request");
  }
  const recordedDigest = `sha256:${createHash("sha256").update(definitionContent).digest("hex")}`;
  const completed = readOrderedAuditEntries(recordDir).some((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-03" &&
    entry.fields["Requirements Revision"] === String(definition.revision) &&
    entry.fields["Requirements SHA-256"] === recordedDigest
  );
  if (!completed) {
    fail("ST-03 Requirements", "Audit does not pin the Requirements revision and SHA-256");
  }
}

/** Verify ST-04 inputs, Core disposition, and Architecture artifacts after completion. */
export function validateArchitectureArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
  planValue?: StageExecutionPlan,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  const plan = planValue ?? readVNextPlanAt(recordDir);
  const stageIndex = VNEXT_STAGE_IDS.indexOf(state.current_stage);
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-04")) return;

  const architectureDir = join(resolve(recordDir), "artifacts", "architecture");
  const requestPath = join(architectureDir, "architecture-work-request.json");
  const currentPath = join(architectureDir, "current.json");
  const hasRequest = existsSync(requestPath);
  let request: ReturnType<typeof parseArchitectureWorkRequest> | undefined;
  if (hasRequest) {
    const content = readFileSync(requestPath, "utf8");
    request = parseArchitectureWorkRequest(
      readJsonArtifact(requestPath, "ST-04 Architecture"),
      requestPath,
    );
    if (content !== `${JSON.stringify(request, null, 2)}\n`) {
      fail("ST-04 Architecture", "Work Request is not canonical");
    }
    if (request.intent_id !== state.intent_id) {
      fail("ST-04 Architecture", "Work Request Intent does not match State");
    }
    for (const reference of [
      request.requirements_current_ref,
      request.requirements_ref,
      request.current_context_ref,
      request.system_map_ref,
      request.effective_policy_ref,
    ]) verifyProjectArtifactReference(projectDir, reference);
    if (request.base_architecture_ref !== null) {
      verifyProjectArtifactReference(projectDir, request.base_architecture_ref);
    }
  }
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-05")) return;
  if (!hasRequest || request === undefined || !existsSync(currentPath)) {
    fail(
      "ST-04 Architecture",
      "Work Request and Architecture Current are required after ST-04 completion",
    );
  }

  const currentContent = readFileSync(currentPath, "utf8");
  const current = parseArchitectureCurrent(
    readJsonArtifact(currentPath, "ST-04 Architecture"),
    currentPath,
  );
  if (currentContent !== `${JSON.stringify(current, null, 2)}\n`) {
    fail("ST-04 Architecture", "Architecture Current is not canonical");
  }
  if (current.intent_id !== state.intent_id) {
    fail("ST-04 Architecture", "Architecture Current Intent does not match State");
  }
  for (const [label, actual, expected] of [
    ["Requirements", current.requirements_ref, request.requirements_ref],
    ["Current Context", current.current_context_ref, request.current_context_ref],
    ["System Map", current.system_map_ref, request.system_map_ref],
    ["Effective Policy", current.effective_policy_ref, request.effective_policy_ref],
  ] as const) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail("ST-04 Architecture", `${label} reference does not match the Work Request`);
    }
    verifyProjectArtifactReference(projectDir, actual);
  }
  for (const evidence of current.evidence) verifyProjectArtifactReference(projectDir, evidence);
  const policyApprovalRefs = current.evidence.filter((entry) =>
    entry.artifact === "architecture-policy-approval"
  );
  if (policyApprovalRefs.length > 1) {
    fail("ST-04 Architecture", "Current contains more than one Policy approval");
  }
  if (policyApprovalRefs.length === 1) {
    const approvalPath = resolve(projectDir, policyApprovalRefs[0]!.source_of_truth);
    const approval = parseArchitecturePolicyApproval(
      readJsonArtifact(approvalPath, "ST-04 Architecture"),
      approvalPath,
    );
    if (approval.intent_id !== state.intent_id) {
      fail("ST-04 Architecture", "Policy approval belongs to a different Intent");
    }
    verifyProjectArtifactReference(projectDir, approval.proposal_ref);
    const approvedProposal = parseArchitectureAssessmentProposal(
      readJsonArtifact(
        resolve(projectDir, approval.proposal_ref.source_of_truth),
        "ST-04 Architecture",
      ),
    );
    if (
      approvedProposal.intent_id !== state.intent_id ||
      approvedProposal.disposition !== current.disposition ||
      approvedProposal.reason !== current.reason ||
      JSON.stringify(approvedProposal.requirement_assessments) !==
        JSON.stringify(current.requirement_assessments) ||
      JSON.stringify(approvedProposal.evidence) !== JSON.stringify(
        current.evidence.filter((entry) =>
          entry.artifact !== "architecture-policy-approval"
        ),
      )
    ) fail("ST-04 Architecture", "Policy approval does not match Architecture Current");
    const gatePath = verifyProjectArtifactReference(
      projectDir,
      approval.gate_requirement_set_ref,
    );
    const gate = parseHumanGateRequirementSet(
      readJsonArtifact(gatePath, "ST-04 Architecture"),
      gatePath,
    );
    if (
      gate.stage_id !== "ST-04" || gate.intent_id !== state.intent_id ||
      JSON.stringify(gate.effective_policy_ref) !==
        JSON.stringify(request.effective_policy_ref)
    ) fail("ST-04 Architecture", "Policy approval Gate does not match the Work Request");
    validatePolicyAcknowledgements(gate, approval.policy_acknowledgements);
  }

  const expectedIds = new Set(request.requirement_ids);
  const assessmentIds = current.requirement_assessments.map((entry) => entry.requirement_id);
  for (const requirementId of expectedIds) {
    if (!assessmentIds.includes(requirementId)) {
      fail("ST-04 Architecture", `requirement coverage is missing: ${requirementId}`);
    }
  }
  if (assessmentIds.some((requirementId) => !expectedIds.has(requirementId))) {
    fail("ST-04 Architecture", "Architecture Current contains an unknown requirement assessment");
  }
  const stageDecision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-04");
  if (stageDecision?.disposition !== current.disposition) {
    fail("ST-04 Architecture", "Architecture Current disposition does not match the Core Plan");
  }

  if (current.disposition === "not_applicable") {
    if (current.requirement_assessments.some((entry) => entry.architecture_impact)) {
      fail("ST-04 Architecture", "not_applicable contains an architecture-impact assessment");
    }
    for (const required of [request.requirements_ref, request.system_map_ref]) {
      if (!current.evidence.some((entry) => JSON.stringify(entry) === JSON.stringify(required))) {
        fail("ST-04 Architecture", `not_applicable Evidence does not pin ${required.artifact}`);
      }
    }
  } else if (current.architecture_ref !== null) {
    verifyProjectArtifactReference(projectDir, current.architecture_ref);
    const decisionPath = resolve(projectDir, current.architecture_ref.source_of_truth);
    const decisionContent = readFileSync(decisionPath, "utf8");
    const decision = parseArchitectureDecision(
      readJsonArtifact(decisionPath, "ST-04 Architecture"),
      decisionPath,
    );
    if (decisionContent !== `${JSON.stringify(decision, null, 2)}\n`) {
      fail("ST-04 Architecture", "Architecture Decision is not canonical");
    }
    if (current.disposition === "execute") {
      const expectedPath = join(
        architectureDir,
        "revisions",
        decision.revision.toString().padStart(6, "0"),
        "architecture-decision.json",
      );
      if (resolve(expectedPath) !== decisionPath || decision.intent_id !== state.intent_id) {
        fail("ST-04 Architecture", "executed Architecture Decision is outside its Intent revision path");
      }
    } else {
      const approvalRef = current.evidence.find((entry) => entry.artifact === "human-decision");
      if (approvalRef === undefined) {
        fail("ST-04 Architecture", "reuse lacks its human approval Evidence");
      }
      verifyProjectArtifactReference(projectDir, approvalRef);
      const approvalPath = resolve(projectDir, approvalRef.source_of_truth);
      const approval = parseArchitectureReuseApproval(
        readJsonArtifact(approvalPath, "ST-04 Architecture"),
        approvalPath,
      );
      if (
        approval.intent_id !== state.intent_id ||
        JSON.stringify(approval.approved_architecture_ref) !==
          JSON.stringify(current.architecture_ref) ||
        JSON.stringify(approval.requirements_ref) !== JSON.stringify(current.requirements_ref)
      ) fail("ST-04 Architecture", "reuse approval binding is invalid");
    }
  }
  const currentDigest = `sha256:${createHash("sha256").update(currentContent).digest("hex")}`;
  const completed = readOrderedAuditEntries(recordDir).some((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-04" &&
    entry.fields["Architecture Current SHA-256"] === currentDigest
  );
  if (!completed) {
    fail("ST-04 Architecture", "Audit does not pin the canonical Architecture Current SHA-256");
  }
}

/** Verify ST-05 pinned inputs, candidate approval, immutable revision, and Core disposition. */
export function validateBuildContractArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
  planValue?: StageExecutionPlan,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  const plan = planValue ?? readVNextPlanAt(recordDir);
  const stageIndex = VNEXT_STAGE_IDS.indexOf(state.current_stage);
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-05")) return;
  const root = join(resolve(recordDir), "artifacts", "build-contract");
  const requestPath = join(root, "build-contract-work-request.json");
  const candidatePath = join(root, "review", "build-contract-candidate.json");
  const reviewPath = join(root, "review", "build-contract-review.html");
  const approvalPath = join(root, "review", "build-contract-approval.json");
  const currentPath = join(root, "current.json");
  let request: ReturnType<typeof parseBuildContractWorkRequest> | undefined;
  if (existsSync(requestPath)) {
    const content = readFileSync(requestPath, "utf8");
    request = parseBuildContractWorkRequest(readJsonArtifact(requestPath, "ST-05 Build Contract"), requestPath);
    if (content !== `${JSON.stringify(request, null, 2)}\n`) fail("ST-05 Build Contract", "Work Request is not canonical");
    if (request.intent_id !== state.intent_id) fail("ST-05 Build Contract", "Work Request Intent does not match State");
    for (const reference of [
      request.requirements_current_ref,
      request.requirements_ref,
      request.architecture_current_ref,
      ...(request.architecture_ref === null ? [] : [request.architecture_ref]),
      request.current_context_ref,
      request.system_map_ref,
      request.effective_policy_ref,
      ...(request.base_build_contract_ref === null ? [] : [request.base_build_contract_ref]),
    ]) verifyProjectArtifactReference(projectDir, reference);
  }
  const hasCandidate = existsSync(candidatePath) || existsSync(reviewPath);
  let candidate: ReturnType<typeof parseBuildContractCandidate> | undefined;
  let candidateReference: ArtifactReference | undefined;
  if (hasCandidate) {
    if (!existsSync(candidatePath) || !existsSync(reviewPath) || request === undefined) fail("ST-05 Build Contract", "Candidate, review HTML, and Work Request must exist together");
    const content = readFileSync(candidatePath, "utf8");
    candidate = parseBuildContractCandidate(readJsonArtifact(candidatePath, "ST-05 Build Contract"), candidatePath);
    if (content !== `${JSON.stringify(candidate, null, 2)}\n`) fail("ST-05 Build Contract", "Candidate is not canonical");
    candidateReference = parseArtifactReference({
      artifact: "build-contract-candidate",
      version: 1,
      source_of_truth: relative(resolve(projectDir), candidatePath).split(sep).join("/"),
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    });
    if (
      candidate.intent_id !== state.intent_id ||
      JSON.stringify(candidate.work_request_ref) !== JSON.stringify(parseArtifactReference({
        artifact: "build-contract-work-request",
        version: 1,
        source_of_truth: relative(resolve(projectDir), requestPath).split(sep).join("/"),
        sha256: `sha256:${createHash("sha256").update(readFileSync(requestPath, "utf8")).digest("hex")}`,
      }))
    ) fail("ST-05 Build Contract", "Candidate is not bound to the current Work Request");
    for (const [actual, expected, label] of [
      [candidate.requirements_ref, request.requirements_ref, "Requirements"],
      [candidate.architecture_current_ref, request.architecture_current_ref, "Architecture Current"],
      [candidate.current_context_ref, request.current_context_ref, "Current Context"],
      [candidate.system_map_ref, request.system_map_ref, "System Map"],
      [candidate.effective_policy_ref, request.effective_policy_ref, "Effective Policy"],
    ] as const) if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("ST-05 Build Contract", `${label} reference does not match the Work Request`);
    const gate = stageIndex >= VNEXT_STAGE_IDS.indexOf("ST-06") && existsSync(approvalPath)
      ? (() => {
        const storedApproval = parseBuildContractApproval(readJsonArtifact(approvalPath, "ST-05 Build Contract"), approvalPath);
        verifyProjectArtifactReference(projectDir, storedApproval.gate_requirement_set_ref);
        return parseHumanGateRequirementSet(readJsonArtifact(resolve(projectDir, storedApproval.gate_requirement_set_ref.source_of_truth), "ST-05 Build Contract"));
      })()
      : resolveHumanGateRequirementsAt(
        projectDir,
        recordDir,
        "ST-05",
        candidate.effective_policy_ref,
      );
    if (readFileSync(reviewPath, "utf8") !== renderBuildContractReviewHtml(candidate, candidateReference, renderHumanGateRequirementSection(gate))) fail("ST-05 Build Contract", "review HTML does not match the exact Candidate and current Policy Gate requirements");
  }
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-06")) return;
  if (request === undefined || candidate === undefined || candidateReference === undefined || !existsSync(approvalPath) || !existsSync(currentPath)) {
    fail("ST-05 Build Contract", "Work Request, Candidate, approval, and Current are required after ST-05 completion");
  }
  const approvalContent = readFileSync(approvalPath, "utf8");
  const approval = parseBuildContractApproval(readJsonArtifact(approvalPath, "ST-05 Build Contract"), approvalPath);
  if (approvalContent !== `${JSON.stringify(approval, null, 2)}\n`) fail("ST-05 Build Contract", "approval is not canonical");
  if (approval.intent_id !== state.intent_id || JSON.stringify(approval.candidate_ref) !== JSON.stringify(candidateReference)) fail("ST-05 Build Contract", "approval is not bound to the exact Candidate");
  const gatePath = verifyProjectArtifactReference(
    projectDir,
    approval.gate_requirement_set_ref,
  );
  const approvedGate = parseHumanGateRequirementSet(
    readJsonArtifact(gatePath, "ST-05 Build Contract"),
  );
  if (
    approvedGate.stage_id !== "ST-05" ||
    approvedGate.intent_id !== state.intent_id ||
    JSON.stringify(approvedGate.effective_policy_ref) !==
      JSON.stringify(candidate.effective_policy_ref)
  ) fail("ST-05 Build Contract", "approval Gate requirements do not match the Candidate");
  validatePolicyAcknowledgements(
    approvedGate,
    approval.policy_acknowledgements,
  );
  const approvalReference = parseArtifactReference({
    artifact: "human-decision",
    version: 1,
    source_of_truth: relative(resolve(projectDir), approvalPath).split(sep).join("/"),
    sha256: `sha256:${createHash("sha256").update(approvalContent).digest("hex")}`,
  });
  const currentContent = readFileSync(currentPath, "utf8");
  const current = parseBuildContractCurrent(readJsonArtifact(currentPath, "ST-05 Build Contract"), currentPath);
  if (currentContent !== `${JSON.stringify(current, null, 2)}\n`) fail("ST-05 Build Contract", "Current is not canonical");
  if (
    current.intent_id !== state.intent_id || current.disposition !== candidate.disposition ||
    JSON.stringify(current.candidate_ref) !== JSON.stringify(candidateReference) ||
    JSON.stringify(current.approval_ref) !== JSON.stringify(approvalReference)
  ) fail("ST-05 Build Contract", "Current does not match Candidate and approval");
  const stageDecision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-05");
  if (stageDecision?.disposition !== current.disposition) fail("ST-05 Build Contract", "Current disposition does not match the Core Plan");
  if (current.disposition === "not_applicable") {
    if (current.build_contract_ref !== null || candidate.requirement_assessments.some((entry) => entry.build_impact)) fail("ST-05 Build Contract", "not_applicable contains build work");
  } else {
    if (current.build_contract_ref === null) fail("ST-05 Build Contract", `${current.disposition} requires a Build Contract reference`);
    verifyProjectArtifactReference(projectDir, current.build_contract_ref);
    const referenced = parseBuildContract(readJsonArtifact(resolve(projectDir, current.build_contract_ref.source_of_truth), "ST-05 Build Contract"));
    if (current.disposition === "execute") {
      const expected = join(root, "revisions", referenced.revision.toString().padStart(6, "0"), "build-contract.json");
      if (resolve(projectDir, current.build_contract_ref.source_of_truth) !== resolve(expected)) fail("ST-05 Build Contract", "executed Build Contract is outside its immutable revision path");
    }
  }
  const currentDigest = `sha256:${createHash("sha256").update(currentContent).digest("hex")}`;
  if (!readOrderedAuditEntries(recordDir).some((entry) => entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-05" && entry.fields["Build Contract Current SHA-256"] === currentDigest)) {
    fail("ST-05 Build Contract", "Audit does not pin the canonical Build Contract Current SHA-256");
  }
}

/** Verify ST-06 session, immutable attempts, verifier Evidence, candidate, Current, and Core disposition. */
export function validateBuildConvergeArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
  planValue?: StageExecutionPlan,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  const plan = planValue ?? readVNextPlanAt(recordDir);
  const stageIndex = VNEXT_STAGE_IDS.indexOf(state.current_stage);
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-06")) return;
  const root = join(resolve(recordDir), "artifacts", "build");
  const sessionPath = join(root, "build-session.json");
  const currentPath = join(root, "current.json");
  const candidatePath = join(root, "runnable-candidate.json");
  const contractCurrentPath = join(resolve(recordDir), "artifacts", "build-contract", "current.json");
  const contractCurrentContent = readFileSync(contractCurrentPath, "utf8");
  const contractCurrent = parseBuildContractCurrent(readJsonArtifact(contractCurrentPath, "ST-06 Build & Converge"), contractCurrentPath);
  const contractCurrentRef = parseArtifactReference({
    artifact: "build-contract-current",
    version: 1,
    source_of_truth: relative(resolve(projectDir), contractCurrentPath).split(sep).join("/"),
    sha256: `sha256:${createHash("sha256").update(contractCurrentContent).digest("hex")}`,
  });
  let session: ReturnType<typeof parseBuildSession> | undefined;
  if (existsSync(sessionPath)) {
    const content = readFileSync(sessionPath, "utf8");
    session = parseBuildSession(readJsonArtifact(sessionPath, "ST-06 Build & Converge"), sessionPath);
    if (content !== `${JSON.stringify(session, null, 2)}\n`) fail("ST-06 Build & Converge", "Build Session is not canonical");
    if (session.intent_id !== state.intent_id || JSON.stringify(session.build_contract_current_ref) !== JSON.stringify(contractCurrentRef)) fail("ST-06 Build & Converge", "Build Session does not match State or Build Contract Current");
    for (const reference of [session.build_contract_current_ref, session.build_contract_ref, session.effective_policy_ref]) verifyProjectArtifactReference(projectDir, reference);
    for (const boltId of [...session.completed_bolt_ids, ...(session.current_bolt_id === null ? [] : [session.current_bolt_id])]) {
      const requestPath = join(root, "bolts", boltId, "work-request.json");
      if (!existsSync(requestPath)) {
        if (session.completed_bolt_ids.includes(boltId)) fail("ST-06 Build & Converge", `completed Bolt ${boltId} has no Work Request`);
        continue;
      }
      const requestContent = readFileSync(requestPath, "utf8");
      const request = parseBoltWorkRequest(readJsonArtifact(requestPath, "ST-06 Build & Converge"), requestPath);
      if (requestContent !== `${JSON.stringify(request, null, 2)}\n` || request.session_id !== session.session_id || JSON.stringify(request.build_contract_ref) !== JSON.stringify(session.build_contract_ref)) fail("ST-06 Build & Converge", `Bolt Work Request ${boltId} is not canonical or bound to its session`);
    }
  }
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-07")) return;
  if (!existsSync(currentPath)) fail("ST-06 Build & Converge", "Build Current is required after ST-06 completion");
  const currentContent = readFileSync(currentPath, "utf8");
  const current = parseBuildCurrent(readJsonArtifact(currentPath, "ST-06 Build & Converge"), currentPath);
  if (currentContent !== `${JSON.stringify(current, null, 2)}\n`) fail("ST-06 Build & Converge", "Build Current is not canonical");
  if (current.intent_id !== state.intent_id || JSON.stringify(current.build_contract_current_ref) !== JSON.stringify(contractCurrentRef)) fail("ST-06 Build & Converge", "Build Current does not match State or Build Contract Current");
  const decision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-06");
  if (decision?.disposition !== current.disposition) fail("ST-06 Build & Converge", "Build Current disposition does not match the Core Plan");
  if (current.disposition === "not_applicable") {
    if (current.runnable_candidate_ref !== null || existsSync(candidatePath)) fail("ST-06 Build & Converge", "not_applicable cannot contain a Runnable Candidate");
  } else {
    if (current.runnable_candidate_ref === null) fail("ST-06 Build & Converge", `${current.disposition} requires a Runnable Candidate`);
    if (current.disposition === "execute" && (!existsSync(candidatePath) || session === undefined || session.status !== "completed")) fail("ST-06 Build & Converge", "execute requires a completed local session and Runnable Candidate");
    try {
      verifyProjectArtifactReference(projectDir, current.runnable_candidate_ref);
    } catch (error) {
      fail("ST-06 Build & Converge", `Runnable Candidate reference is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const referencedCandidatePath = resolve(projectDir, current.runnable_candidate_ref.source_of_truth);
    if (current.disposition === "execute" && referencedCandidatePath !== resolve(candidatePath)) fail("ST-06 Build & Converge", "executed Runnable Candidate reference points outside its canonical path");
    const candidateContent = readFileSync(referencedCandidatePath, "utf8");
    const candidate = parseRunnableCandidate(readJsonArtifact(referencedCandidatePath, "ST-06 Build & Converge"), referencedCandidatePath);
    if (candidateContent !== `${JSON.stringify(candidate, null, 2)}\n`) fail("ST-06 Build & Converge", "Runnable Candidate is not canonical");
    if (candidate.intent_id !== state.intent_id || contractCurrent.build_contract_ref === null || JSON.stringify(candidate.build_contract_ref) !== JSON.stringify(contractCurrent.build_contract_ref)) fail("ST-06 Build & Converge", "Runnable Candidate does not match the Intent or approved Build Contract");
    if (current.disposition === "execute" && candidate.session_id !== session!.session_id) fail("ST-06 Build & Converge", "Runnable Candidate does not match its local session");
    for (const reference of candidate.bolt_checkpoint_refs) {
      verifyProjectArtifactReference(projectDir, reference);
      const path = resolve(projectDir, reference.source_of_truth);
      const content = readFileSync(path, "utf8");
      const checkpoint = parseBuildAttemptCheckpoint(readJsonArtifact(path, "ST-06 Build & Converge"), path);
      if (content !== `${JSON.stringify(checkpoint, null, 2)}\n` || checkpoint.outcome !== "passed" || checkpoint.session_id !== candidate.session_id) fail("ST-06 Build & Converge", "Runnable Candidate contains an invalid Bolt checkpoint");
      for (const verifierRef of checkpoint.verifier_evidence_refs) {
        verifyProjectArtifactReference(projectDir, verifierRef);
        const verifierPath = resolve(projectDir, verifierRef.source_of_truth);
        const evidence = parseVerifierEvidence(readJsonArtifact(verifierPath, "ST-06 Build & Converge"), verifierPath);
        if (evidence.result === "failed") fail("ST-06 Build & Converge", "passed checkpoint contains failed Verifier Evidence");
      }
    }
    for (const reference of candidate.integration_verifier_evidence_refs) {
      verifyProjectArtifactReference(projectDir, reference);
      const path = resolve(projectDir, reference.source_of_truth);
      const evidence = parseVerifierEvidence(readJsonArtifact(path, "ST-06 Build & Converge"), path);
      if (evidence.result === "failed" || evidence.session_id !== candidate.session_id) fail("ST-06 Build & Converge", "Runnable Candidate contains invalid integration Evidence");
    }
  }
  const currentDigest = `sha256:${createHash("sha256").update(currentContent).digest("hex")}`;
  if (!readOrderedAuditEntries(recordDir).some((entry) => (entry.event === "STAGE_COMPLETED" || entry.event === "STAGE_SKIPPED") && entry.fields.Stage === "ST-06" && entry.fields["Build Current SHA-256"] === currentDigest)) {
    fail("ST-06 Build & Converge", "Audit does not pin the canonical Build Current SHA-256");
  }
}

/** Verify ST-07 pinned review, human decision, Accepted Candidate, and Current. */
export function validateCandidateReviewArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
  planValue?: StageExecutionPlan,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  const plan = planValue ?? readVNextPlanAt(recordDir);
  const stageIndex = VNEXT_STAGE_IDS.indexOf(state.current_stage);
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-07")) return;
  const root = join(resolve(recordDir), "artifacts", "review");
  const manifestPath = join(root, "review-manifest.json");
  const htmlPath = join(root, "review.html");
  let manifest: ReturnType<typeof parseReviewManifest> | null = null;
  let manifestReference: ArtifactReference | null = null;
  if (existsSync(manifestPath) || existsSync(htmlPath)) {
    if (!existsSync(manifestPath) || !existsSync(htmlPath)) fail("ST-07 Human Review", "Review Manifest and HTML must exist together");
    const content = readFileSync(manifestPath, "utf8");
    manifest = parseReviewManifest(readJsonArtifact(manifestPath, "ST-07 Human Review"), manifestPath);
    if (content !== `${JSON.stringify(manifest, null, 2)}\n`) fail("ST-07 Human Review", "Review Manifest is not canonical");
    manifestReference = parseArtifactReference({ artifact: "review-manifest", version: 1, source_of_truth: relative(resolve(projectDir), manifestPath).split(sep).join("/"), sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` });
    if (manifest.intent_id !== state.intent_id) fail("ST-07 Human Review", "Review Manifest Intent does not match State");
    for (const reference of [manifest.build_current_ref, manifest.runnable_candidate_ref, manifest.requirements_ref, manifest.architecture_current_ref, manifest.build_contract_ref, manifest.effective_policy_ref, manifest.system_map_ref, ...manifest.machine_evidence_refs]) verifyProjectArtifactReference(projectDir, reference);
    const completedReviewPath = join(root, "current.json");
    const gate = stageIndex >= VNEXT_STAGE_IDS.indexOf("ST-08") && existsSync(completedReviewPath)
      ? (() => {
        const completedReview = parseReviewCurrent(readJsonArtifact(completedReviewPath, "ST-07 Human Review"), completedReviewPath);
        const completedDecisionPath = resolve(projectDir, completedReview.human_decision_ref.source_of_truth);
        const completedDecision = parseCandidateReviewDecision(readJsonArtifact(completedDecisionPath, "ST-07 Human Review"), completedDecisionPath);
        verifyProjectArtifactReference(projectDir, completedDecision.gate_requirement_set_ref);
        return parseHumanGateRequirementSet(readJsonArtifact(resolve(projectDir, completedDecision.gate_requirement_set_ref.source_of_truth), "ST-07 Human Review"));
      })()
      : resolveHumanGateRequirementsAt(projectDir, recordDir, "ST-07", manifest.effective_policy_ref);
    if (readFileSync(htmlPath, "utf8") !== renderCandidateReviewHtml(manifest, renderHumanGateRequirementSection(gate))) fail("ST-07 Human Review", "Review HTML differs from its pinned Manifest and Gate Requirement Set");
  }
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-08")) return;
  const currentPath = join(root, "current.json");
  if (!existsSync(currentPath)) fail("ST-07 Human Review", "Review Current is required after ST-07 completion");
  const currentContent = readFileSync(currentPath, "utf8");
  const current = parseReviewCurrent(readJsonArtifact(currentPath, "ST-07 Human Review"), currentPath);
  if (currentContent !== `${JSON.stringify(current, null, 2)}\n` || current.intent_id !== state.intent_id) fail("ST-07 Human Review", "Review Current is not canonical or belongs to another Intent");
  const stageDecision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-07");
  if (stageDecision?.disposition !== current.disposition) fail("ST-07 Human Review", "Review Current disposition does not match the Core Plan");
  verifyProjectArtifactReference(projectDir, current.human_decision_ref);
  if (current.outcome === "approved") {
    if (manifest === null || manifestReference === null || current.review_manifest_ref === null || current.accepted_candidate_ref === null) fail("ST-07 Human Review", "approved review is missing its Manifest or Accepted Candidate");
    verifyProjectArtifactReference(projectDir, current.review_manifest_ref);
    const pinnedManifestContent = readFileSync(resolve(projectDir, current.review_manifest_ref.source_of_truth), "utf8");
    if (current.review_manifest_ref.sha256 !== manifestReference.sha256 || pinnedManifestContent !== readFileSync(manifestPath, "utf8")) fail("ST-07 Human Review", "Review Current does not pin the canonical Manifest content");
    manifestReference = current.review_manifest_ref;
    verifyProjectArtifactReference(projectDir, current.accepted_candidate_ref);
    const decisionPath = resolve(projectDir, current.human_decision_ref.source_of_truth);
    const decisionContent = readFileSync(decisionPath, "utf8");
    const decision = parseCandidateReviewDecision(readJsonArtifact(decisionPath, "ST-07 Human Review"), decisionPath);
    if (decisionContent !== `${JSON.stringify(decision, null, 2)}\n` || decision.decision !== "approve-runnable-candidate" || JSON.stringify(decision.review_manifest_ref) !== JSON.stringify(manifestReference) || JSON.stringify(decision.runnable_candidate_ref) !== JSON.stringify(manifest.runnable_candidate_ref)) fail("ST-07 Human Review", "approval is not bound to the exact Manifest and Candidate");
    verifyProjectArtifactReference(projectDir, decision.gate_requirement_set_ref);
    const gatePath = resolve(projectDir, decision.gate_requirement_set_ref.source_of_truth);
    const gate = parseHumanGateRequirementSet(readJsonArtifact(gatePath, "ST-07 Human Review"), gatePath);
    if (gate.stage_id !== "ST-07" || gate.intent_id !== state.intent_id || JSON.stringify(gate.effective_policy_ref) !== JSON.stringify(manifest.effective_policy_ref)) fail("ST-07 Human Review", "approval Gate Requirement Set is not bound to ST-07, the Intent, and Effective Policy");
    validatePolicyAcknowledgements(gate, decision.policy_acknowledgements);
    const acceptedPath = resolve(projectDir, current.accepted_candidate_ref.source_of_truth);
    const acceptedContent = readFileSync(acceptedPath, "utf8");
    const accepted = parseAcceptedCandidate(readJsonArtifact(acceptedPath, "ST-07 Human Review"), acceptedPath);
    if (acceptedContent !== `${JSON.stringify(accepted, null, 2)}\n` || accepted.intent_id !== state.intent_id || JSON.stringify(accepted.review_manifest_ref) !== JSON.stringify(manifestReference) || JSON.stringify(accepted.runnable_candidate_ref) !== JSON.stringify(manifest.runnable_candidate_ref) || JSON.stringify(accepted.approval_ref) !== JSON.stringify(current.human_decision_ref)) fail("ST-07 Human Review", "Accepted Candidate binding is invalid");
    verifyProjectArtifactReference(projectDir, accepted.system_map_ref);
  } else if (current.outcome !== "not_applicable") {
    fail("ST-07 Human Review", "feedback cannot advance to ST-08");
  }
  const currentDigest = `sha256:${createHash("sha256").update(currentContent).digest("hex")}`;
  if (!readOrderedAuditEntries(recordDir).some((entry) => (entry.event === "STAGE_COMPLETED" || entry.event === "STAGE_SKIPPED") && entry.fields.Stage === "ST-07" && entry.fields["Review Current SHA-256"] === currentDigest)) fail("ST-07 Human Review", "Audit does not pin the canonical Review Current SHA-256");
}

/** Verify ST-08 capability/request, immutable approval, receipts, Current, and Deployment Map. */
export function validateReleaseArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
  planValue?: StageExecutionPlan,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  const plan = planValue ?? readVNextPlanAt(recordDir);
  const stageIndex = VNEXT_STAGE_IDS.indexOf(state.current_stage);
  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-08")) return;
  const context = "ST-08 Release";
  const root = join(resolve(recordDir), "artifacts", "release");
  const capabilityPath = join(root, "release-capability-snapshot.json");
  const requestPath = join(root, "work-request.json");
  const planPath = join(root, "release-plan.json");
  const htmlPath = join(root, "review", "release.html");
  const authorityPath = join(root, "review", "release-authority.json");
  const currentPath = join(root, "current.json");

  const canonical = <T>(path: string, parser: (value: unknown, context?: string) => T): { value: T; content: string } => {
    const content = readFileSync(path, "utf8");
    const value = parser(readJsonArtifact(path, context), path);
    if (content !== `${JSON.stringify(value, null, 2)}\n`) fail(context, `artifact is not canonical: ${path}`);
    return { value, content };
  };
  const localReference = (path: string, artifact: string, content?: string): ArtifactReference => parseArtifactReference({
    artifact,
    version: 1,
    source_of_truth: relative(resolve(projectDir), resolve(path)).split(sep).join("/"),
    sha256: `sha256:${createHash("sha256").update(content ?? readFileSync(path, "utf8")).digest("hex")}`,
  });

  let request: ReturnType<typeof parseReleaseWorkRequest> | null = null;
  if (existsSync(capabilityPath) || existsSync(requestPath)) {
    if (!existsSync(capabilityPath) || !existsSync(requestPath)) fail(context, "Capability Snapshot and Work Request must exist together");
    const capability = canonical(capabilityPath, parseReleaseCapabilitySnapshot).value;
    const requestStored = canonical(requestPath, parseReleaseWorkRequest);
    request = requestStored.value;
    if (capability.intent_id !== state.intent_id || request.intent_id !== state.intent_id) fail(context, "prepared Release artifacts belong to another Intent");
    if (JSON.stringify(capability.effective_policy_ref) !== JSON.stringify(state.policy_snapshot) || JSON.stringify(request.effective_policy_ref) !== JSON.stringify(state.policy_snapshot)) fail(context, "Release Policy snapshot differs from State");
    for (const reference of [capability.effective_policy_ref, request.review_current_ref, request.accepted_candidate_ref, request.effective_policy_ref, request.system_map_ref, request.capability_snapshot_ref, ...(request.deployment_map_baseline_ref === null ? [] : [request.deployment_map_baseline_ref])]) verifyProjectArtifactReference(projectDir, reference);
    if (JSON.stringify(request.capability_snapshot_ref) !== JSON.stringify(localReference(capabilityPath, "release-capability-snapshot"))) fail(context, "Work Request does not pin the canonical Capability Snapshot");
  }

  let releasePlan: ReturnType<typeof parseReleasePlan> | null = null;
  let releasePlanReference: ArtifactReference | null = null;
  if (existsSync(planPath) || existsSync(htmlPath)) {
    if (!existsSync(planPath) || !existsSync(htmlPath) || request === null) fail(context, "Release Plan, Review HTML, and Work Request must exist together");
    const stored = canonical(planPath, parseReleasePlan);
    releasePlan = stored.value;
    const immutablePath = join(root, "revisions", releasePlan.revision.toString().padStart(6, "0"), "release-plan.json");
    const immutableHtmlPath = join(root, "revisions", releasePlan.revision.toString().padStart(6, "0"), "release.html");
    if (!existsSync(immutablePath) || !existsSync(immutableHtmlPath) || readFileSync(immutablePath, "utf8") !== stored.content) fail(context, "immutable Release Plan revision is missing or differs");
    const gate = stageIndex >= VNEXT_STAGE_IDS.indexOf("ST-09") && existsSync(authorityPath)
      ? (() => {
        const completedAuthority = parseReleaseAuthority(readJsonArtifact(authorityPath, context), authorityPath);
        verifyProjectArtifactReference(projectDir, completedAuthority.gate_requirement_set_ref);
        return parseHumanGateRequirementSet(readJsonArtifact(resolve(projectDir, completedAuthority.gate_requirement_set_ref.source_of_truth), context));
      })()
      : resolveHumanGateRequirementsAt(projectDir, recordDir, "ST-08", releasePlan.effective_policy_ref);
    const expectedHtml = renderReleaseReviewHtml(releasePlan, renderHumanGateRequirementSection(gate));
    if (readFileSync(htmlPath, "utf8") !== expectedHtml || readFileSync(immutableHtmlPath, "utf8") !== expectedHtml) fail(context, "Release Review HTML differs from the exact Plan");
    releasePlanReference = localReference(immutablePath, "release-plan", stored.content);
    for (const reference of [releasePlan.work_request_ref, releasePlan.review_current_ref, releasePlan.accepted_candidate_ref, releasePlan.effective_policy_ref, releasePlan.capability_snapshot_ref]) verifyProjectArtifactReference(projectDir, reference);
    if (JSON.stringify(releasePlan.work_request_ref) !== JSON.stringify(localReference(requestPath, "release-work-request")) || JSON.stringify(releasePlan.accepted_candidate_ref) !== JSON.stringify(request.accepted_candidate_ref)) fail(context, "Release Plan does not pin its exact accepted inputs");
  }

  let currentAuthority: ReturnType<typeof parseReleaseAuthority> | null = null;
  let currentAuthorityReference: ArtifactReference | null = null;
  if (existsSync(authorityPath)) {
    if (releasePlan === null || releasePlanReference === null) fail(context, "Release Authority exists without a Plan");
    const stored = canonical(authorityPath, parseReleaseAuthority);
    currentAuthority = stored.value;
    const immutablePath = join(root, "decisions", currentAuthority.authority_id, "release-authority.json");
    if (!existsSync(immutablePath) || readFileSync(immutablePath, "utf8") !== stored.content) fail(context, "immutable Release Authority is missing or differs");
    currentAuthorityReference = localReference(immutablePath, "release-authority", stored.content);
    if (currentAuthority.intent_id !== state.intent_id || JSON.stringify(currentAuthority.release_plan_ref) !== JSON.stringify(releasePlanReference)) fail(context, "Release Authority does not bind the active Plan");
    verifyProjectArtifactReference(projectDir, currentAuthority.gate_requirement_set_ref);
    const gatePath = resolve(projectDir, currentAuthority.gate_requirement_set_ref.source_of_truth);
    const gate = parseHumanGateRequirementSet(readJsonArtifact(gatePath, context), gatePath);
    if (gate.stage_id !== "ST-08" || gate.intent_id !== state.intent_id || JSON.stringify(gate.effective_policy_ref) !== JSON.stringify(releasePlan.effective_policy_ref)) fail(context, "Release Authority Gate Requirement Set is not bound to ST-08, the Intent, and Effective Policy");
    validatePolicyAcknowledgements(gate, currentAuthority.policy_acknowledgements);
  }

  const attemptsRoot = join(root, "attempts");
  if (existsSync(attemptsRoot)) {
    for (const attemptDir of readdirSync(attemptsRoot).filter((entry) => /^\d{6}$/.test(entry)).sort()) {
      const attemptPath = join(attemptsRoot, attemptDir, "attempt.json");
      if (!existsSync(attemptPath)) fail(context, `Release Attempt ${attemptDir} has no checkpoint`);
      const attempt = canonical(attemptPath, parseReleaseAttempt).value;
      if (attempt.intent_id !== state.intent_id || Number(attemptDir) !== attempt.attempt) fail(context, `Release Attempt ${attemptDir} has an invalid binding`);
      for (const reference of [attempt.release_plan_ref, attempt.authority_ref, ...attempt.step_receipt_refs]) verifyProjectArtifactReference(projectDir, reference);
      for (const reference of attempt.step_receipt_refs) {
        const path = resolve(projectDir, reference.source_of_truth);
        const receipt = canonical(path, parseReleaseStepReceipt).value;
        if (receipt.intent_id !== state.intent_id || receipt.attempt !== attempt.attempt) fail(context, "Step Receipt belongs to another Release Attempt");
      }
    }
  }

  if (stageIndex < VNEXT_STAGE_IDS.indexOf("ST-09")) return;
  if (!existsSync(currentPath)) fail(context, "Release Current is required after ST-08 completion");
  const currentStored = canonical(currentPath, parseReleaseCurrent);
  const current = currentStored.value;
  if (current.intent_id !== state.intent_id) fail(context, "Release Current belongs to another Intent");
  const decision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-08");
  if (decision?.disposition !== current.disposition) fail(context, "Release Current disposition differs from the Core Plan");
  verifyProjectArtifactReference(projectDir, current.review_current_ref);
  if (current.outcome === "not_applicable") {
    if (request !== null || releasePlan !== null || currentAuthority !== null) fail(context, "not_applicable Release cannot contain executable artifacts");
  } else {
    if (current.release_plan_ref === null || current.release_authority_ref === null || current.release_receipt_ref === null || current.deployment_map_ref === null || current.accepted_candidate_ref === null) fail(context, "completed Release is missing Candidate, Plan, Authority, Receipt, or Deployment Map");
    for (const reference of [current.accepted_candidate_ref!, current.release_plan_ref, current.release_authority_ref, current.release_receipt_ref, current.deployment_map_ref]) verifyProjectArtifactReference(projectDir, reference);
    const completedPlan = current.disposition === "reuse"
      ? canonical(resolve(projectDir, current.release_plan_ref.source_of_truth), parseReleasePlan).value
      : releasePlan;
    const completedPlanReference = current.disposition === "reuse" ? current.release_plan_ref : releasePlanReference;
    if (completedPlan === null || completedPlanReference === null || JSON.stringify(current.release_plan_ref) !== JSON.stringify(completedPlanReference)) fail(context, "Release Current does not pin an immutable Plan");
    const authority = canonical(resolve(projectDir, current.release_authority_ref.source_of_truth), parseReleaseAuthority).value;
    const receipt = canonical(resolve(projectDir, current.release_receipt_ref.source_of_truth), parseReleaseReceipt).value;
    const deployment = canonical(resolve(projectDir, current.deployment_map_ref.source_of_truth), parseDeploymentMap).value;
    if (JSON.stringify(authority.release_plan_ref) !== JSON.stringify(completedPlanReference) || JSON.stringify(receipt.release_plan_ref) !== JSON.stringify(completedPlanReference) || JSON.stringify(receipt.authority_ref) !== JSON.stringify(current.release_authority_ref) || receipt.outcome !== current.outcome) fail(context, "completed Release bindings are inconsistent");
    verifyProjectArtifactReference(projectDir, authority.gate_requirement_set_ref);
    const gatePath = resolve(projectDir, authority.gate_requirement_set_ref.source_of_truth);
    const gate = parseHumanGateRequirementSet(readJsonArtifact(gatePath, context), gatePath);
    if (gate.stage_id !== "ST-08" || gate.intent_id !== authority.intent_id || JSON.stringify(gate.effective_policy_ref) !== JSON.stringify(completedPlan.effective_policy_ref)) fail(context, "completed Release Gate Requirement Set is not bound to ST-08, its Intent, and Effective Policy");
    validatePolicyAcknowledgements(gate, authority.policy_acknowledgements);
    if (current.disposition === "reuse") {
      const activeAccepted = canonical(resolve(projectDir, current.accepted_candidate_ref.source_of_truth), parseAcceptedCandidate).value;
      const priorAccepted = canonical(resolve(projectDir, receipt.accepted_candidate_ref.source_of_truth), parseAcceptedCandidate).value;
      if (JSON.stringify(activeAccepted.source_results) !== JSON.stringify(priorAccepted.source_results) || completedPlan.effective_policy_ref.sha256 !== state.policy_snapshot.sha256) fail(context, "reused Release does not match the active Candidate sources or Effective Policy");
    }
    for (const reference of receipt.step_receipt_refs) verifyProjectArtifactReference(projectDir, reference);
    const receiptTargetStates = new Set(receipt.target_states.map((entry) => entry.observed_state));
    const mapped = deployment.targets.filter((entry) => JSON.stringify(entry.release_receipt_ref) === JSON.stringify(current.release_receipt_ref));
    if (mapped.length !== receipt.target_states.length || mapped.some((entry) => !receiptTargetStates.has(entry.observed_state))) fail(context, "Deployment Map does not reflect the exact Release Receipt target states");
  }
  const currentDigest = `sha256:${createHash("sha256").update(currentStored.content).digest("hex")}`;
  if (!readOrderedAuditEntries(recordDir).some((entry) => (entry.event === "STAGE_COMPLETED" || entry.event === "STAGE_SKIPPED") && entry.fields.Stage === "ST-08" && entry.fields["Release Current SHA-256"] === currentDigest)) fail(context, "Audit does not pin the canonical Release Current SHA-256");
}

/** Verify ST-09 signal coverage, immutable Evidence/Evaluation, human authority, and terminal Current. */
export function validateOutcomeArtifactsAt(
  projectDir: string,
  recordDir: string,
  stateValue?: VNextIntentState,
  planValue?: StageExecutionPlan,
): void {
  const state = stateValue ?? readVNextStateAt(recordDir);
  const plan = planValue ?? readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-09") return;
  const context = "ST-09 Outcome Evaluation";
  const root = join(resolve(recordDir), "artifacts", "outcome");
  const requestPath = join(root, "work-request.json");
  const evidencePath = join(root, "outcome-evidence.json");
  const evaluationPath = join(root, "outcome-evaluation.json");
  const htmlPath = join(root, "outcome.html");
  const decisionPath = join(root, "review", "human-decision.json");
  const followUpPath = join(root, "follow-up-brief.json");
  const currentPath = join(root, "current.json");
  const canonical = <T>(path: string, parser: (value: unknown, context?: string) => T): { value: T; content: string } => {
    const content = readFileSync(path, "utf8");
    const value = parser(readJsonArtifact(path, context), path);
    if (content !== `${JSON.stringify(value, null, 2)}\n`) fail(context, `artifact is not canonical: ${path}`);
    return { value, content };
  };
  const localReference = (path: string, artifact: string, content?: string): ArtifactReference => parseArtifactReference({ artifact, version: 1, source_of_truth: relative(resolve(projectDir), resolve(path)).split(sep).join("/"), sha256: `sha256:${createHash("sha256").update(content ?? readFileSync(path, "utf8")).digest("hex")}` });

  let request: ReturnType<typeof parseOutcomeWorkRequest> | null = null;
  let requestReference: ArtifactReference | null = null;
  if (existsSync(requestPath)) {
    const stored = canonical(requestPath, parseOutcomeWorkRequest);
    request = stored.value;
    const immutablePath = join(root, "requests", request.revision.toString().padStart(6, "0"), "work-request.json");
    if (!existsSync(immutablePath) || readFileSync(immutablePath, "utf8") !== stored.content) fail(context, "immutable Work Request revision is missing or differs");
    requestReference = localReference(immutablePath, "outcome-work-request", stored.content);
    if (request.intent_id !== state.intent_id || JSON.stringify(request.effective_policy_ref) !== JSON.stringify(state.policy_snapshot)) fail(context, "Work Request belongs to another Intent or Policy");
    for (const reference of [request.intent_definition_ref, request.requirements_ref, ...(request.review_manifest_ref === null ? [] : [request.review_manifest_ref]), request.release_current_ref, request.effective_policy_ref]) verifyProjectArtifactReference(projectDir, reference);
  }

  let evidence: ReturnType<typeof parseOutcomeEvidence> | null = null;
  let evidenceReference: ArtifactReference | null = null;
  let evaluation: ReturnType<typeof parseOutcomeEvaluation> | null = null;
  let evaluationReference: ArtifactReference | null = null;
  if (existsSync(evidencePath) || existsSync(evaluationPath) || existsSync(htmlPath)) {
    if (request === null || requestReference === null || !existsSync(evidencePath) || !existsSync(evaluationPath) || !existsSync(htmlPath)) fail(context, "Work Request, Evidence, Evaluation, and HTML must exist together");
    const evidenceStored = canonical(evidencePath, parseOutcomeEvidence);
    const evaluationStored = canonical(evaluationPath, parseOutcomeEvaluation);
    evidence = evidenceStored.value;
    evaluation = evaluationStored.value;
    const immutableEvidencePath = join(root, "revisions", evidence.revision.toString().padStart(6, "0"), "outcome-evidence.json");
    const immutableEvaluationPath = join(root, "revisions", evaluation.revision.toString().padStart(6, "0"), "outcome-evaluation.json");
    const immutableHtmlPath = join(root, "revisions", evaluation.revision.toString().padStart(6, "0"), "outcome.html");
    if (!existsSync(immutableEvidencePath) || !existsSync(immutableEvaluationPath) || !existsSync(immutableHtmlPath) || readFileSync(immutableEvidencePath, "utf8") !== evidenceStored.content || readFileSync(immutableEvaluationPath, "utf8") !== evaluationStored.content) fail(context, "immutable Outcome revision is incomplete or differs");
    evidenceReference = localReference(immutableEvidencePath, "outcome-evidence", evidenceStored.content);
    evaluationReference = localReference(immutableEvaluationPath, "outcome-evaluation", evaluationStored.content);
    verifyProjectArtifactReference(projectDir, evaluation.gate_requirement_set_ref);
    const gatePath = resolve(projectDir, evaluation.gate_requirement_set_ref.source_of_truth);
    const gate = parseHumanGateRequirementSet(readJsonArtifact(gatePath, context), gatePath);
    if (gate.stage_id !== "ST-09" || gate.intent_id !== state.intent_id || JSON.stringify(gate.effective_policy_ref) !== JSON.stringify(request.effective_policy_ref)) fail(context, "Outcome Gate Requirement Set is not bound to ST-09, the Intent, and Effective Policy");
    const expectedHtml = renderOutcomeEvaluationHtml(evaluation, renderHumanGateRequirementSection(gate));
    if (readFileSync(htmlPath, "utf8") !== expectedHtml || readFileSync(immutableHtmlPath, "utf8") !== expectedHtml) fail(context, "Outcome HTML differs from the canonical Evaluation");
    if (evidence.intent_id !== state.intent_id || evaluation.intent_id !== state.intent_id || evidence.revision !== evaluation.revision || JSON.stringify(evidence.work_request_ref) !== JSON.stringify(requestReference) || JSON.stringify(evaluation.work_request_ref) !== JSON.stringify(requestReference) || JSON.stringify(evaluation.outcome_evidence_ref) !== JSON.stringify(evidenceReference)) fail(context, "Outcome revision bindings are inconsistent");
    const expectedSignals = [...request.signals.map((entry) => entry.signal_id)].sort();
    const actualSignals = [...evaluation.signal_results.map((entry) => entry.signal_id)].sort();
    if (JSON.stringify(expectedSignals) !== JSON.stringify(actualSignals) || JSON.stringify(evidence.observations) !== JSON.stringify(evaluation.signal_results)) fail(context, "Outcome Evaluation does not cover the exact Work Request signals");
    for (const observation of evidence.observations) for (const reference of observation.evidence_refs) verifyProjectArtifactReference(projectDir, reference);
  }

  let decisionReference: ArtifactReference | null = null;
  if (existsSync(decisionPath)) {
    if (evaluationReference === null) fail(context, "human decision exists without an Evaluation");
    const stored = canonical(decisionPath, parseOutcomeHumanDecision);
    const immutablePath = join(root, "decisions", stored.value.decision_id, "human-decision.json");
    if (!existsSync(immutablePath) || readFileSync(immutablePath, "utf8") !== stored.content) fail(context, "immutable human decision is missing or differs");
    decisionReference = localReference(immutablePath, "outcome-human-decision", stored.content);
    if (stored.value.intent_id !== state.intent_id || JSON.stringify(stored.value.outcome_evaluation_ref) !== JSON.stringify(evaluationReference) || evaluation === null || JSON.stringify(stored.value.gate_requirement_set_ref) !== JSON.stringify(evaluation.gate_requirement_set_ref)) fail(context, "human decision does not bind the current Evaluation and Gate Requirement Set");
    verifyProjectArtifactReference(projectDir, stored.value.gate_requirement_set_ref);
    const gatePath = resolve(projectDir, stored.value.gate_requirement_set_ref.source_of_truth);
    const gate = parseHumanGateRequirementSet(readJsonArtifact(gatePath, context), gatePath);
    if (stored.value.decision !== "continue-observation") validatePolicyAcknowledgements(gate, stored.value.policy_acknowledgements);
    else if (stored.value.policy_acknowledgements.length !== 0) fail(context, "continue-observation must not claim Policy acknowledgement");
  }

  let followUpReference: ArtifactReference | null = null;
  if (existsSync(followUpPath)) {
    const stored = canonical(followUpPath, parseFollowUpBrief);
    followUpReference = localReference(followUpPath, "follow-up-brief", stored.content);
    if (evaluationReference === null || decisionReference === null || stored.value.source_intent_id !== state.intent_id || JSON.stringify(stored.value.outcome_evaluation_ref) !== JSON.stringify(evaluationReference) || JSON.stringify(stored.value.human_decision_ref) !== JSON.stringify(decisionReference)) fail(context, "Follow-up Brief binding is invalid");
  }

  if (state.status !== "completed") {
    if (existsSync(currentPath)) fail(context, "Outcome Current cannot exist before terminal completion");
    return;
  }
  if (requestReference === null || evidenceReference === null || evaluation === null || evaluationReference === null || !existsSync(currentPath)) fail(context, "terminal State requires Work Request, Evidence, Evaluation, HTML, and Current");
  const currentStored = canonical(currentPath, parseOutcomeCurrent);
  const current = currentStored.value;
  if (current.intent_id !== state.intent_id || JSON.stringify(current.work_request_ref) !== JSON.stringify(requestReference) || JSON.stringify(current.outcome_evidence_ref) !== JSON.stringify(evidenceReference) || JSON.stringify(current.outcome_evaluation_ref) !== JSON.stringify(evaluationReference) || JSON.stringify(current.human_decision_ref) !== JSON.stringify(decisionReference) || JSON.stringify(current.follow_up_brief_ref) !== JSON.stringify(followUpReference) || current.overall_result !== evaluation.overall_result) fail(context, "Outcome Current bindings are inconsistent");
  if (decisionReference === null) {
    const gatePath = resolve(projectDir, evaluation.gate_requirement_set_ref.source_of_truth);
    const gate = parseHumanGateRequirementSet(readJsonArtifact(gatePath, context), gatePath);
    if (gate.requirements.length !== 0) fail(context, "auto completion is prohibited when ST-09 Policy requirements exist");
  }
  const stageDecision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-09");
  if (stageDecision?.disposition !== current.disposition) fail(context, "Outcome Current disposition differs from the Core Plan");
  const currentDigest = `sha256:${createHash("sha256").update(currentStored.content).digest("hex")}`;
  if (!readOrderedAuditEntries(recordDir).some((entry) => entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-09" && entry.fields["Outcome Current SHA-256"] === currentDigest && entry.fields.Terminal === "true")) fail(context, "Audit does not pin the terminal Outcome Current SHA-256");
}

export function resumeVNextIntent(projectDir: string): {
  recordDir: string;
  state: VNextIntentState;
  plan: StageExecutionPlan;
} {
  const recordDir = activeVNextIntentRecordDir(projectDir);
  validateVNextIntentAt(projectDir, recordDir);
  return {
    recordDir,
    state: readVNextStateAt(recordDir),
    plan: readVNextPlanAt(recordDir),
  };
}

export function main(argv: string[]): void {
  const [command, projectDir, ...rest] = argv;
  if (
    (command !== "show" && command !== "resume" && command !== "check") ||
    projectDir === undefined || rest.length !== 0
  ) {
    console.error("Usage: aidlc state <show|resume|check> <project-dir>");
    process.exitCode = 1;
    return;
  }
  try {
    if (command === "check") {
      const recordDir = activeVNextIntentRecordDir(projectDir);
      validateVNextIntentAt(projectDir, recordDir);
      process.stdout.write(`${JSON.stringify({ valid: true, workflow: "vnext" })}\n`);
      return;
    }
    const resumed = resumeVNextIntent(projectDir);
    process.stdout.write(
      `${JSON.stringify({ state: resumed.state, plan: resumed.plan }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
