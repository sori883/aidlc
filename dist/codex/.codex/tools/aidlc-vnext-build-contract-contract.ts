import {
  parseArtifactReference,
  type ArtifactReference,
} from "./aidlc-stage-contract.ts";

export const BUILD_CONTRACT_SCHEMA_VERSION = 1 as const;
export const BUILD_CONTRACT_ARTIFACT_VERSION = 1 as const;
export const BUILD_CONTRACT_DISPOSITIONS = ["execute", "reuse", "not_applicable"] as const;
export const BUILD_VERIFIER_KINDS = ["command", "runtime", "artifact", "human-at-st07"] as const;

export type BuildContractDisposition = (typeof BUILD_CONTRACT_DISPOSITIONS)[number];
export type BuildVerifierKind = (typeof BUILD_VERIFIER_KINDS)[number];

export interface BuildArtifactCheck {
  path: string;
  assertion: "exists" | "sha256-equals" | "content-includes";
  expected: string | null;
}

export interface BuildRuntimeCheck {
  start_argv: string[];
  host: "127.0.0.1" | "localhost";
  port: number;
  path: string;
  expected_status: number;
  startup_timeout_ms: number;
}

export interface BuildTargetSource {
  source_id: string;
  locator: string;
}

export interface BuildTarget {
  source_id: string;
  path: string;
}

export interface BuildRequirementAssessment {
  requirement_id: string;
  build_impact: boolean;
  reason: string;
}

export interface BuildChangeContract {
  contract_id: string;
  title: string;
  requirement_ids: string[];
  targets: BuildTarget[];
  depends_on_contract_ids: string[];
  specification: string[];
}

export interface BuildAcceptanceCriterion {
  criterion_id: string;
  requirement_ids: string[];
  given: string;
  when: string;
  then: string;
  verifier_ids: string[];
}

export interface BuildVerifier {
  verifier_id: string;
  kind: BuildVerifierKind;
  source_id: string | null;
  cwd: string | null;
  argv: string[] | null;
  timeout_ms: number;
  expected_exit_codes: number[];
  artifact_check: BuildArtifactCheck | null;
  runtime_check: BuildRuntimeCheck | null;
  expected: string;
  human_exception_ref: ArtifactReference | null;
}

export interface BoltDefinition {
  bolt_id: string;
  title: string;
  objective: string;
  contract_ids: string[];
  acceptance_criterion_ids: string[];
  targets: BuildTarget[];
  depends_on: string[];
}

export interface BuildIntegrationContract {
  acceptance_criterion_ids: string[];
  verifier_ids: string[];
  candidate_ready_when: string[];
}

export interface BuildContractWorkRequest {
  schema_version: typeof BUILD_CONTRACT_SCHEMA_VERSION;
  artifact: "build-contract-work-request";
  version: typeof BUILD_CONTRACT_ARTIFACT_VERSION;
  intent_id: string;
  stage_id: "ST-05";
  requirements_current_ref: ArtifactReference;
  requirements_ref: ArtifactReference;
  architecture_current_ref: ArtifactReference;
  architecture_ref: ArtifactReference | null;
  current_context_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  base_revision: number | null;
  base_build_contract_ref: ArtifactReference | null;
  requirement_ids: string[];
  target_sources: BuildTargetSource[];
  requested_outputs: ["build-contract-proposal"];
  rules: string[];
  created_at: string;
}

export interface BuildContractProposal {
  schema_version: typeof BUILD_CONTRACT_SCHEMA_VERSION;
  artifact: "build-contract-proposal";
  version: typeof BUILD_CONTRACT_ARTIFACT_VERSION;
  proposal_id: string;
  intent_id: string;
  work_request_sha256: string;
  disposition: BuildContractDisposition;
  requirement_assessments: BuildRequirementAssessment[];
  change_contracts: BuildChangeContract[];
  acceptance_criteria: BuildAcceptanceCriterion[];
  verifiers: BuildVerifier[];
  bolts: BoltDefinition[];
  integration_contract: BuildIntegrationContract | null;
  reuse_ref: ArtifactReference | null;
  evidence: ArtifactReference[];
  reason: string;
  proposed_by: "ai";
}

export interface BuildContractCandidate extends Omit<BuildContractProposal, "artifact" | "work_request_sha256"> {
  artifact: "build-contract-candidate";
  work_request_ref: ArtifactReference;
  requirements_ref: ArtifactReference;
  architecture_current_ref: ArtifactReference;
  architecture_ref: ArtifactReference | null;
  current_context_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  target_sources: BuildTargetSource[];
  derived_batches: string[][];
  created_at: string;
}

export interface BuildContract extends Omit<BuildContractCandidate, "artifact" | "reuse_ref"> {
  artifact: "build-contract";
  revision: number;
  base_revision: number | null;
  candidate_ref: ArtifactReference;
  approval_ref: ArtifactReference;
}

export interface BuildContractApproval {
  schema_version: typeof BUILD_CONTRACT_SCHEMA_VERSION;
  artifact: "human-decision";
  version: typeof BUILD_CONTRACT_ARTIFACT_VERSION;
  decision_id: string;
  decision_kind: "approval";
  intent_id: string;
  candidate_ref: ArtifactReference;
  decision: "approve-build-contract";
  reason: string;
  decided_by: "human";
  decided_at: string;
}

export interface BuildContractCurrent {
  schema_version: typeof BUILD_CONTRACT_SCHEMA_VERSION;
  artifact: "build-contract-current";
  version: typeof BUILD_CONTRACT_ARTIFACT_VERSION;
  intent_id: string;
  disposition: BuildContractDisposition;
  build_contract_ref: ArtifactReference | null;
  candidate_ref: ArtifactReference;
  approval_ref: ArtifactReference;
  requirements_ref: ArtifactReference;
  architecture_current_ref: ArtifactReference;
  current_context_ref: ArtifactReference;
  system_map_ref: ArtifactReference;
  effective_policy_ref: ArtifactReference;
  reason: string;
  updated_at: string;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const REQUIREMENT_ID_PATTERN = /^(?:REQ-[A-Z]+|CON|INV)-\d{3}$/;
const CONTRACT_ID_PATTERN = /^CHG-\d{3}$/;
const CRITERION_ID_PATTERN = /^AC-\d{3}$/;
const VERIFIER_ID_PATTERN = /^VER-\d{3}$/;
const BOLT_ID_PATTERN = /^BOLT-\d{3}$/;
const SECRET_FIELD_PATTERN = /(?:^|[_-])(secret|password|passwd|token|api[_-]?key|credential|private[_-]?key)(?:$|[_-])/i;

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}

function assertNoSecretFields(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${context}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) fail(context, `secret-bearing field is prohibited: ${key}`);
    assertNoSecretFields(child, `${context}.${key}`);
  }
}

function asOneLine(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\r\n\0]/.test(value)) {
    fail(context, "must be a non-empty single-line string");
  }
  return value;
}

function asStableId(value: unknown, context: string): string {
  const id = asOneLine(value, context);
  if (!STABLE_ID_PATTERN.test(id)) fail(context, "must be a stable identifier");
  return id;
}

function asPattern(value: unknown, pattern: RegExp, context: string, example: string): string {
  const id = asOneLine(value, context);
  if (!pattern.test(id)) fail(context, `must match ${example}`);
  return id;
}

function asRequirementId(value: unknown, context: string): string {
  return asPattern(value, REQUIREMENT_ID_PATTERN, context, "REQ-F-001, REQ-Q-001, CON-001, or INV-001");
}

function asPositiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(context, "must be a positive integer");
  return value as number;
}

function asBoundedInteger(value: unknown, minimum: number, maximum: number, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(context, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function asNullableRevision(value: unknown, context: string): number | null {
  return value === null ? null : asPositiveInteger(value, context);
}

function asIsoTimestamp(value: unknown, context: string): string {
  const text = asOneLine(value, context);
  if (Number.isNaN(Date.parse(text)) || !text.endsWith("Z")) fail(context, "must be an ISO-8601 UTC timestamp");
  return text;
}

function asSha(value: unknown, context: string): string {
  const text = asOneLine(value, context);
  if (!SHA256_PATTERN.test(text)) fail(context, "must use sha256:<64 lowercase hex characters>");
  return text;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], context: string): T {
  const text = asOneLine(value, context);
  if (!(allowed as readonly string[]).includes(text)) fail(context, `must be one of: ${allowed.join(", ")}`);
  return text as T;
}

function asUniqueStrings(
  value: unknown,
  context: string,
  minimum = 0,
  parser: (value: unknown, context: string) => string = asOneLine,
): string[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const values = value.map((entry, index) => parser(entry, `${context}[${index}]`));
  if (values.length < minimum) fail(context, `must contain at least ${minimum} item(s)`);
  const duplicate = values.find((entry, index) => values.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate value: ${duplicate}`);
  return values;
}

function asArgs(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(context, "must be a non-empty argv array");
  return value.map((entry, index) => asOneLine(entry, `${context}[${index}]`));
}

function asReferences(value: unknown, context: string): ArtifactReference[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const values = value.map((entry, index) => parseArtifactReference(entry, `${context}[${index}]`));
  const keys = values.map((entry) => JSON.stringify(entry));
  if (new Set(keys).size !== keys.length) fail(context, "contains a duplicate Artifact Reference");
  return values;
}

function asNullableReference(value: unknown, context: string): ArtifactReference | null {
  return value === null ? null : parseArtifactReference(value, context);
}

function parseTargetSource(value: unknown, context: string): BuildTargetSource {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["source_id", "locator"], context);
  return { source_id: asStableId(record.source_id, `${context}.source_id`), locator: asOneLine(record.locator, `${context}.locator`) };
}

function parseTarget(value: unknown, context: string): BuildTarget {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["source_id", "path"], context);
  return { source_id: asStableId(record.source_id, `${context}.source_id`), path: asOneLine(record.path, `${context}.path`) };
}

function asTargets(value: unknown, context: string): BuildTarget[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  const targets = value.map((entry, index) => parseTarget(entry, `${context}[${index}]`));
  const keys = targets.map((entry) => `${entry.source_id}:${entry.path}`);
  if (new Set(keys).size !== keys.length) fail(context, "contains a duplicate target");
  return targets;
}

function parseAssessment(value: unknown, context: string): BuildRequirementAssessment {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["requirement_id", "build_impact", "reason"], context);
  if (typeof record.build_impact !== "boolean") fail(`${context}.build_impact`, "must be a boolean");
  return {
    requirement_id: asRequirementId(record.requirement_id, `${context}.requirement_id`),
    build_impact: record.build_impact,
    reason: asOneLine(record.reason, `${context}.reason`),
  };
}

export function parseBuildChangeContract(value: unknown, context = "Build Change Contract"): BuildChangeContract {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["contract_id", "title", "requirement_ids", "targets", "depends_on_contract_ids", "specification"], context);
  return {
    contract_id: asPattern(record.contract_id, CONTRACT_ID_PATTERN, `${context}.contract_id`, "CHG-001"),
    title: asOneLine(record.title, `${context}.title`),
    requirement_ids: asUniqueStrings(record.requirement_ids, `${context}.requirement_ids`, 1, asRequirementId),
    targets: asTargets(record.targets, `${context}.targets`),
    depends_on_contract_ids: asUniqueStrings(record.depends_on_contract_ids, `${context}.depends_on_contract_ids`, 0, (entry, itemContext) => asPattern(entry, CONTRACT_ID_PATTERN, itemContext, "CHG-001")),
    specification: asUniqueStrings(record.specification, `${context}.specification`, 1),
  };
}

export function parseBuildAcceptanceCriterion(value: unknown, context = "Build Acceptance Criterion"): BuildAcceptanceCriterion {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["criterion_id", "requirement_ids", "given", "when", "then", "verifier_ids"], context);
  return {
    criterion_id: asPattern(record.criterion_id, CRITERION_ID_PATTERN, `${context}.criterion_id`, "AC-001"),
    requirement_ids: asUniqueStrings(record.requirement_ids, `${context}.requirement_ids`, 1, asRequirementId),
    given: asOneLine(record.given, `${context}.given`),
    when: asOneLine(record.when, `${context}.when`),
    then: asOneLine(record.then, `${context}.then`),
    verifier_ids: asUniqueStrings(record.verifier_ids, `${context}.verifier_ids`, 1, (entry, itemContext) => asPattern(entry, VERIFIER_ID_PATTERN, itemContext, "VER-001")),
  };
}

function parseArtifactCheck(value: unknown, context: string): BuildArtifactCheck | null {
  if (value === null) return null;
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["path", "assertion", "expected"], context);
  const assertion = asEnum(record.assertion, ["exists", "sha256-equals", "content-includes"] as const, `${context}.assertion`);
  const expected = record.expected === null ? null : asOneLine(record.expected, `${context}.expected`);
  if (assertion === "exists" && expected !== null) fail(`${context}.expected`, "must be null for exists");
  if (assertion !== "exists" && expected === null) fail(`${context}.expected`, `is required for ${assertion}`);
  return { path: asOneLine(record.path, `${context}.path`), assertion, expected };
}

function parseRuntimeCheck(value: unknown, context: string): BuildRuntimeCheck | null {
  if (value === null) return null;
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["start_argv", "host", "port", "path", "expected_status", "startup_timeout_ms"], context);
  if (record.host !== "127.0.0.1" && record.host !== "localhost") fail(`${context}.host`, "must be localhost or 127.0.0.1");
  const path = asOneLine(record.path, `${context}.path`);
  if (!path.startsWith("/")) fail(`${context}.path`, "must start with /");
  return {
    start_argv: asArgs(record.start_argv, `${context}.start_argv`),
    host: record.host,
    port: asBoundedInteger(record.port, 1, 65535, `${context}.port`),
    path,
    expected_status: asBoundedInteger(record.expected_status, 100, 599, `${context}.expected_status`),
    startup_timeout_ms: asBoundedInteger(record.startup_timeout_ms, 100, 300_000, `${context}.startup_timeout_ms`),
  };
}

export function parseBuildVerifier(value: unknown, context = "Build Verifier"): BuildVerifier {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["verifier_id", "kind", "source_id", "cwd", "argv", "timeout_ms", "expected_exit_codes", "artifact_check", "runtime_check", "expected", "human_exception_ref"], context);
  const kind = asEnum(record.kind, BUILD_VERIFIER_KINDS, `${context}.kind`);
  const sourceId = record.source_id === null ? null : asStableId(record.source_id, `${context}.source_id`);
  const cwd = record.cwd === null ? null : asOneLine(record.cwd, `${context}.cwd`);
  const argv = record.argv === null ? null : asArgs(record.argv, `${context}.argv`);
  const artifactCheck = parseArtifactCheck(record.artifact_check, `${context}.artifact_check`);
  const runtimeCheck = parseRuntimeCheck(record.runtime_check, `${context}.runtime_check`);
  if (kind !== "human-at-st07" && (sourceId === null || cwd === null)) {
    fail(context, `${kind} verifier requires source_id and cwd`);
  }
  if (kind === "command" && (argv === null || artifactCheck !== null || runtimeCheck !== null)) {
    fail(context, "command verifier requires argv and null artifact/runtime checks");
  }
  if (kind === "artifact" && (argv !== null || artifactCheck === null || runtimeCheck !== null)) {
    fail(context, "artifact verifier requires artifact_check only");
  }
  if (kind === "runtime" && (argv !== null || artifactCheck !== null || runtimeCheck === null)) {
    fail(context, "runtime verifier requires runtime_check only");
  }
  if (kind === "human-at-st07" && (sourceId !== null || cwd !== null || argv !== null || artifactCheck !== null || runtimeCheck !== null)) {
    fail(context, "human-at-st07 verifier must set execution fields to null");
  }
  if (!Array.isArray(record.expected_exit_codes)) fail(`${context}.expected_exit_codes`, "must be an array");
  const exitCodes = record.expected_exit_codes.map((entry, index) => asBoundedInteger(entry, 0, 255, `${context}.expected_exit_codes[${index}]`));
  if (new Set(exitCodes).size !== exitCodes.length) fail(`${context}.expected_exit_codes`, "contains a duplicate exit code");
  if (kind === "command" && exitCodes.length === 0) fail(`${context}.expected_exit_codes`, "command verifier requires at least one exit code");
  if (kind !== "command" && exitCodes.length !== 0) fail(`${context}.expected_exit_codes`, `must be empty for ${kind}`);
  const timeoutMs = asBoundedInteger(record.timeout_ms, 0, 3_600_000, `${context}.timeout_ms`);
  if ((kind === "command" || kind === "runtime") && timeoutMs < 100) fail(`${context}.timeout_ms`, `${kind} verifier requires at least 100ms`);
  if ((kind === "artifact" || kind === "human-at-st07") && timeoutMs !== 0) fail(`${context}.timeout_ms`, `must be 0 for ${kind}`);
  return {
    verifier_id: asPattern(record.verifier_id, VERIFIER_ID_PATTERN, `${context}.verifier_id`, "VER-001"),
    kind,
    source_id: sourceId,
    cwd,
    argv,
    timeout_ms: timeoutMs,
    expected_exit_codes: exitCodes,
    artifact_check: artifactCheck,
    runtime_check: runtimeCheck,
    expected: asOneLine(record.expected, `${context}.expected`),
    human_exception_ref: asNullableReference(record.human_exception_ref, `${context}.human_exception_ref`),
  };
}

export function parseBoltDefinition(value: unknown, context = "Bolt Definition"): BoltDefinition {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["bolt_id", "title", "objective", "contract_ids", "acceptance_criterion_ids", "targets", "depends_on"], context);
  return {
    bolt_id: asPattern(record.bolt_id, BOLT_ID_PATTERN, `${context}.bolt_id`, "BOLT-001"),
    title: asOneLine(record.title, `${context}.title`),
    objective: asOneLine(record.objective, `${context}.objective`),
    contract_ids: asUniqueStrings(record.contract_ids, `${context}.contract_ids`, 1, (entry, itemContext) => asPattern(entry, CONTRACT_ID_PATTERN, itemContext, "CHG-001")),
    acceptance_criterion_ids: asUniqueStrings(record.acceptance_criterion_ids, `${context}.acceptance_criterion_ids`, 1, (entry, itemContext) => asPattern(entry, CRITERION_ID_PATTERN, itemContext, "AC-001")),
    targets: asTargets(record.targets, `${context}.targets`),
    depends_on: asUniqueStrings(record.depends_on, `${context}.depends_on`, 0, (entry, itemContext) => asPattern(entry, BOLT_ID_PATTERN, itemContext, "BOLT-001")),
  };
}

function parseIntegration(value: unknown, context: string): BuildIntegrationContract | null {
  if (value === null) return null;
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["acceptance_criterion_ids", "verifier_ids", "candidate_ready_when"], context);
  return {
    acceptance_criterion_ids: asUniqueStrings(record.acceptance_criterion_ids, `${context}.acceptance_criterion_ids`, 1, (entry, itemContext) => asPattern(entry, CRITERION_ID_PATTERN, itemContext, "AC-001")),
    verifier_ids: asUniqueStrings(record.verifier_ids, `${context}.verifier_ids`, 1, (entry, itemContext) => asPattern(entry, VERIFIER_ID_PATTERN, itemContext, "VER-001")),
    candidate_ready_when: asUniqueStrings(record.candidate_ready_when, `${context}.candidate_ready_when`, 1),
  };
}

function assertUniqueBy<T>(items: readonly T[], id: (item: T) => string, context: string): void {
  const ids = items.map(id);
  const duplicate = ids.find((entry, index) => ids.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate ID: ${duplicate}`);
}

function parseProposalBody(record: Record<string, unknown>, context: string) {
  const requirementAssessments = Array.isArray(record.requirement_assessments)
    ? record.requirement_assessments.map((entry, index) => parseAssessment(entry, `${context}.requirement_assessments[${index}]`))
    : fail(`${context}.requirement_assessments`, "must be an array");
  const changeContracts = Array.isArray(record.change_contracts)
    ? record.change_contracts.map((entry, index) => parseBuildChangeContract(entry, `${context}.change_contracts[${index}]`))
    : fail(`${context}.change_contracts`, "must be an array");
  const criteria = Array.isArray(record.acceptance_criteria)
    ? record.acceptance_criteria.map((entry, index) => parseBuildAcceptanceCriterion(entry, `${context}.acceptance_criteria[${index}]`))
    : fail(`${context}.acceptance_criteria`, "must be an array");
  const verifiers = Array.isArray(record.verifiers)
    ? record.verifiers.map((entry, index) => parseBuildVerifier(entry, `${context}.verifiers[${index}]`))
    : fail(`${context}.verifiers`, "must be an array");
  const bolts = Array.isArray(record.bolts)
    ? record.bolts.map((entry, index) => parseBoltDefinition(entry, `${context}.bolts[${index}]`))
    : fail(`${context}.bolts`, "must be an array");
  assertUniqueBy(requirementAssessments, (entry) => entry.requirement_id, `${context}.requirement_assessments`);
  assertUniqueBy(changeContracts, (entry) => entry.contract_id, `${context}.change_contracts`);
  assertUniqueBy(criteria, (entry) => entry.criterion_id, `${context}.acceptance_criteria`);
  assertUniqueBy(verifiers, (entry) => entry.verifier_id, `${context}.verifiers`);
  assertUniqueBy(bolts, (entry) => entry.bolt_id, `${context}.bolts`);
  return {
    requirement_assessments: requirementAssessments,
    change_contracts: changeContracts,
    acceptance_criteria: criteria,
    verifiers,
    bolts,
    integration_contract: parseIntegration(record.integration_contract, `${context}.integration_contract`),
    reuse_ref: asNullableReference(record.reuse_ref, `${context}.reuse_ref`),
    evidence: asReferences(record.evidence, `${context}.evidence`),
    reason: asOneLine(record.reason, `${context}.reason`),
  };
}

function validateDispositionBody(
  disposition: BuildContractDisposition,
  body: ReturnType<typeof parseProposalBody>,
  context: string,
): void {
  const implementationCounts = body.change_contracts.length +
    body.acceptance_criteria.length + body.verifiers.length + body.bolts.length;
  if (disposition === "execute") {
    if (implementationCounts === 0 || body.integration_contract === null || body.reuse_ref !== null) {
      fail(context, "execute requires implementation content and no reuse_ref");
    }
  } else if (disposition === "reuse") {
    if (implementationCounts !== 0 || body.integration_contract !== null || body.reuse_ref === null) {
      fail(context, "reuse requires only reuse_ref and assessments");
    }
  } else if (implementationCounts !== 0 || body.integration_contract !== null || body.reuse_ref !== null) {
    fail(context, "not_applicable cannot contain implementation content or reuse_ref");
  }
}

function commonArtifact(record: Record<string, unknown>, artifact: string, context: string): void {
  if (record.schema_version !== BUILD_CONTRACT_SCHEMA_VERSION) fail(`${context}.schema_version`, `must equal ${BUILD_CONTRACT_SCHEMA_VERSION}`);
  if (record.artifact !== artifact) fail(`${context}.artifact`, `must equal ${artifact}`);
  if (record.version !== BUILD_CONTRACT_ARTIFACT_VERSION) fail(`${context}.version`, `must equal ${BUILD_CONTRACT_ARTIFACT_VERSION}`);
  assertNoSecretFields(record, context);
}

export function parseBuildContractWorkRequest(value: unknown, context = "Build Contract Work Request"): BuildContractWorkRequest {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["schema_version", "artifact", "version", "intent_id", "stage_id", "requirements_current_ref", "requirements_ref", "architecture_current_ref", "architecture_ref", "current_context_ref", "system_map_ref", "effective_policy_ref", "base_revision", "base_build_contract_ref", "requirement_ids", "target_sources", "requested_outputs", "rules", "created_at"], context);
  commonArtifact(record, "build-contract-work-request", context);
  if (record.stage_id !== "ST-05") fail(`${context}.stage_id`, "must equal ST-05");
  if (!Array.isArray(record.target_sources)) fail(`${context}.target_sources`, "must be an array");
  const targetSources = record.target_sources.map((entry, index) => parseTargetSource(entry, `${context}.target_sources[${index}]`));
  assertUniqueBy(targetSources, (entry) => entry.source_id, `${context}.target_sources`);
  if (!Array.isArray(record.requested_outputs) || record.requested_outputs.length !== 1 || record.requested_outputs[0] !== "build-contract-proposal") {
    fail(`${context}.requested_outputs`, "must equal [build-contract-proposal]");
  }
  return {
    schema_version: 1,
    artifact: "build-contract-work-request",
    version: 1,
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    stage_id: "ST-05",
    requirements_current_ref: parseArtifactReference(record.requirements_current_ref, `${context}.requirements_current_ref`),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    architecture_current_ref: parseArtifactReference(record.architecture_current_ref, `${context}.architecture_current_ref`),
    architecture_ref: asNullableReference(record.architecture_ref, `${context}.architecture_ref`),
    current_context_ref: parseArtifactReference(record.current_context_ref, `${context}.current_context_ref`),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    effective_policy_ref: parseArtifactReference(record.effective_policy_ref, `${context}.effective_policy_ref`),
    base_revision: asNullableRevision(record.base_revision, `${context}.base_revision`),
    base_build_contract_ref: asNullableReference(record.base_build_contract_ref, `${context}.base_build_contract_ref`),
    requirement_ids: asUniqueStrings(record.requirement_ids, `${context}.requirement_ids`, 1, asRequirementId),
    target_sources: targetSources,
    requested_outputs: ["build-contract-proposal"],
    rules: asUniqueStrings(record.rules, `${context}.rules`, 1),
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseBuildContractProposal(value: unknown, context = "Build Contract Proposal"): BuildContractProposal {
  const record = asRecord(value, context);
  assertNoSecretFields(record, context);
  rejectUnknownKeys(record, ["schema_version", "artifact", "version", "proposal_id", "intent_id", "work_request_sha256", "disposition", "requirement_assessments", "change_contracts", "acceptance_criteria", "verifiers", "bolts", "integration_contract", "reuse_ref", "evidence", "reason", "proposed_by"], context);
  commonArtifact(record, "build-contract-proposal", context);
  const disposition = asEnum(record.disposition, BUILD_CONTRACT_DISPOSITIONS, `${context}.disposition`);
  const body = parseProposalBody(record, context);
  if (record.proposed_by !== "ai") fail(`${context}.proposed_by`, "must equal ai");
  validateDispositionBody(disposition, body, context);
  return {
    schema_version: 1,
    artifact: "build-contract-proposal",
    version: 1,
    proposal_id: asStableId(record.proposal_id, `${context}.proposal_id`),
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    work_request_sha256: asSha(record.work_request_sha256, `${context}.work_request_sha256`),
    disposition,
    ...body,
    proposed_by: "ai",
  };
}

const CANDIDATE_KEYS = ["schema_version", "artifact", "version", "proposal_id", "intent_id", "disposition", "requirement_assessments", "change_contracts", "acceptance_criteria", "verifiers", "bolts", "integration_contract", "reuse_ref", "evidence", "reason", "proposed_by", "work_request_ref", "requirements_ref", "architecture_current_ref", "architecture_ref", "current_context_ref", "system_map_ref", "effective_policy_ref", "target_sources", "derived_batches", "created_at"] as const;

export function parseBuildContractCandidate(value: unknown, context = "Build Contract Candidate"): BuildContractCandidate {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, CANDIDATE_KEYS, context);
  commonArtifact(record, "build-contract-candidate", context);
  const body = parseProposalBody(record, context);
  const disposition = asEnum(record.disposition, BUILD_CONTRACT_DISPOSITIONS, `${context}.disposition`);
  validateDispositionBody(disposition, body, context);
  if (record.proposed_by !== "ai") fail(`${context}.proposed_by`, "must equal ai");
  if (!Array.isArray(record.target_sources)) fail(`${context}.target_sources`, "must be an array");
  const targetSources = record.target_sources.map((entry, index) => parseTargetSource(entry, `${context}.target_sources[${index}]`));
  if (!Array.isArray(record.derived_batches)) fail(`${context}.derived_batches`, "must be an array");
  const batches = record.derived_batches.map((entry, index) => asUniqueStrings(entry, `${context}.derived_batches[${index}]`, 1, (item, itemContext) => asPattern(item, BOLT_ID_PATTERN, itemContext, "BOLT-001")));
  return {
    schema_version: 1,
    artifact: "build-contract-candidate",
    version: 1,
    proposal_id: asStableId(record.proposal_id, `${context}.proposal_id`),
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    disposition,
    ...body,
    proposed_by: "ai",
    work_request_ref: parseArtifactReference(record.work_request_ref, `${context}.work_request_ref`),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    architecture_current_ref: parseArtifactReference(record.architecture_current_ref, `${context}.architecture_current_ref`),
    architecture_ref: asNullableReference(record.architecture_ref, `${context}.architecture_ref`),
    current_context_ref: parseArtifactReference(record.current_context_ref, `${context}.current_context_ref`),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    effective_policy_ref: parseArtifactReference(record.effective_policy_ref, `${context}.effective_policy_ref`),
    target_sources: targetSources,
    derived_batches: batches,
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

export function parseBuildContractApproval(value: unknown, context = "Build Contract Approval"): BuildContractApproval {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["schema_version", "artifact", "version", "decision_id", "decision_kind", "intent_id", "candidate_ref", "decision", "reason", "decided_by", "decided_at"], context);
  commonArtifact(record, "human-decision", context);
  if (record.decision_kind !== "approval") fail(`${context}.decision_kind`, "must equal approval");
  if (record.decision !== "approve-build-contract") fail(`${context}.decision`, "must equal approve-build-contract");
  if (record.decided_by !== "human") fail(`${context}.decided_by`, "must equal human");
  return {
    schema_version: 1,
    artifact: "human-decision",
    version: 1,
    decision_id: asStableId(record.decision_id, `${context}.decision_id`),
    decision_kind: "approval",
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    candidate_ref: parseArtifactReference(record.candidate_ref, `${context}.candidate_ref`),
    decision: "approve-build-contract",
    reason: asOneLine(record.reason, `${context}.reason`),
    decided_by: "human",
    decided_at: asIsoTimestamp(record.decided_at, `${context}.decided_at`),
  };
}

export function parseBuildContract(value: unknown, context = "Build Contract"): BuildContract {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, [...CANDIDATE_KEYS.filter((key) => key !== "reuse_ref"), "revision", "base_revision", "candidate_ref", "approval_ref"], context);
  commonArtifact(record, "build-contract", context);
  const candidateShape: Record<string, unknown> = {
    ...record,
    artifact: "build-contract-candidate",
    reuse_ref: null,
  };
  delete candidateShape.revision;
  delete candidateShape.base_revision;
  delete candidateShape.candidate_ref;
  delete candidateShape.approval_ref;
  const parsed = parseBuildContractCandidate(candidateShape, `${context}.content`);
  if (parsed.disposition !== "execute") fail(`${context}.disposition`, "must equal execute");
  const { artifact: _artifact, reuse_ref: _reuse, ...content } = parsed;
  return {
    ...content,
    artifact: "build-contract",
    revision: asPositiveInteger(record.revision, `${context}.revision`),
    base_revision: asNullableRevision(record.base_revision, `${context}.base_revision`),
    candidate_ref: parseArtifactReference(record.candidate_ref, `${context}.candidate_ref`),
    approval_ref: parseArtifactReference(record.approval_ref, `${context}.approval_ref`),
  };
}

export function parseBuildContractCurrent(value: unknown, context = "Build Contract Current"): BuildContractCurrent {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, ["schema_version", "artifact", "version", "intent_id", "disposition", "build_contract_ref", "candidate_ref", "approval_ref", "requirements_ref", "architecture_current_ref", "current_context_ref", "system_map_ref", "effective_policy_ref", "reason", "updated_at"], context);
  commonArtifact(record, "build-contract-current", context);
  return {
    schema_version: 1,
    artifact: "build-contract-current",
    version: 1,
    intent_id: asStableId(record.intent_id, `${context}.intent_id`),
    disposition: asEnum(record.disposition, BUILD_CONTRACT_DISPOSITIONS, `${context}.disposition`),
    build_contract_ref: asNullableReference(record.build_contract_ref, `${context}.build_contract_ref`),
    candidate_ref: parseArtifactReference(record.candidate_ref, `${context}.candidate_ref`),
    approval_ref: parseArtifactReference(record.approval_ref, `${context}.approval_ref`),
    requirements_ref: parseArtifactReference(record.requirements_ref, `${context}.requirements_ref`),
    architecture_current_ref: parseArtifactReference(record.architecture_current_ref, `${context}.architecture_current_ref`),
    current_context_ref: parseArtifactReference(record.current_context_ref, `${context}.current_context_ref`),
    system_map_ref: parseArtifactReference(record.system_map_ref, `${context}.system_map_ref`),
    effective_policy_ref: parseArtifactReference(record.effective_policy_ref, `${context}.effective_policy_ref`),
    reason: asOneLine(record.reason, `${context}.reason`),
    updated_at: asIsoTimestamp(record.updated_at, `${context}.updated_at`),
  };
}

/** Deterministic, static, escaped human review for the exact candidate digest. */
export function renderBuildContractReviewHtml(
  candidate: BuildContractCandidate,
  candidateRef: ArtifactReference,
): string {
  const escape = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const rows = candidate.requirement_assessments.map((entry) =>
    `<tr><td>${escape(entry.requirement_id)}</td><td>${entry.build_impact ? "変更あり" : "変更なし"}</td><td>${escape(entry.reason)}</td></tr>`
  ).join("");
  const bolts = candidate.bolts.length === 0
    ? "<p>実装Boltはありません。</p>"
    : `<ol>${candidate.derived_batches.map((batch, index) =>
      `<li>Batch ${index + 1}: ${batch.map(escape).join(", ")}</li>`
    ).join("")}</ol>`;
  const targets = candidate.change_contracts.length === 0 ? "" : `<section><h2>変更対象</h2><ul>${candidate.change_contracts.flatMap((contract) => contract.targets.map((target) => `<li><strong>${escape(contract.contract_id)}</strong>: ${escape(target.source_id)} / ${escape(target.path)}</li>`)).join("")}</ul></section>`;
  const verifierDescription = (verifier: BuildVerifier): string => {
    if (verifier.kind === "command") return `source=${escape(verifier.source_id!)} / cwd=${escape(verifier.cwd!)} / argv=<code>${escape(JSON.stringify(verifier.argv))}</code> / timeout=${verifier.timeout_ms}ms / exit=${escape(verifier.expected_exit_codes.join(","))}`;
    if (verifier.kind === "artifact") return `source=${escape(verifier.source_id!)} / cwd=${escape(verifier.cwd!)} / path=${escape(verifier.artifact_check!.path)} / assertion=${escape(verifier.artifact_check!.assertion)}`;
    if (verifier.kind === "runtime") return `source=${escape(verifier.source_id!)} / cwd=${escape(verifier.cwd!)} / start=<code>${escape(JSON.stringify(verifier.runtime_check!.start_argv))}</code> / probe=http://${escape(verifier.runtime_check!.host)}:${verifier.runtime_check!.port}${escape(verifier.runtime_check!.path)} / status=${verifier.runtime_check!.expected_status}`;
    return "ST-07で人間が確認します。ST-06では実行しません。";
  };
  const verifiers = candidate.verifiers.length === 0 ? "" : `<section><h2>ST-06が実行する検証</h2><p>以下の値は候補SHA-256に含まれます。Coreは別のcommandへ置き換えません。</p><ul>${candidate.verifiers.map((verifier) => `<li><strong>${escape(verifier.verifier_id)} / ${escape(verifier.kind)}</strong><br>${verifierDescription(verifier)}<br>合格条件: ${escape(verifier.expected)}</li>`).join("")}</ul></section>`;
  const codeStyle = candidate.verifiers.length === 0 ? "" : "code{overflow-wrap:anywhere}";
  return `<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ST-05 Build Contract レビュー</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 20px;line-height:1.65;color:#172033}h1{font-size:1.8rem}section{border:1px solid #d8deea;border-radius:12px;padding:20px;margin:18px 0}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8deea;padding:8px;text-align:left}.hash{overflow-wrap:anywhere;background:#f4f6fa;padding:10px;border-radius:8px}.notice{background:#fff8df}${codeStyle}</style></head><body><h1>ST-05 Build Contract 最終確認</h1><section class="notice"><p>この候補を承認すると、Coreは同じSHA-256の内容だけを実装契約として確定し、ST-06へ進めます。修正したい場合は承認せず、AIへ修正を依頼してください。</p><p class="hash"><strong>候補SHA-256:</strong> ${escape(candidateRef.sha256)}</p></section><section><h2>結論</h2><p>${escape(candidate.disposition)} — ${escape(candidate.reason)}</p></section><section><h2>要件ごとの実装影響</h2><table><thead><tr><th>要件</th><th>実装</th><th>理由</th></tr></thead><tbody>${rows}</tbody></table></section>${targets}<section><h2>Bolt実行順</h2>${bolts}</section>${verifiers}<section><h2>確認すること</h2><p>変更対象、受入条件、検証方法、Boltの依存順に納得できれば、この候補SHA-256を指定して承認してください。</p></section></body></html>\n`;
}
