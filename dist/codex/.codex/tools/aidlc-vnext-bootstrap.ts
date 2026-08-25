import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { appendAuditEntries, appendAuditEntry, readOrderedAuditEntries } from "./aidlc-audit.ts";
import {
  loadVNextDefinitions,
  nextForwardStage,
  validateCoreRoute,
} from "./aidlc-core-route.ts";
import { verifyProjectArtifactReference } from "./aidlc-effective-policy.ts";
import { readIntentRegistry } from "./aidlc-intent.ts";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";
import {
  parseArtifactReference,
  parseVNextStageContract,
  type ArtifactReference,
  type VNextStageContract,
} from "./aidlc-stage-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  resumeVNextIntent,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export const BOOTSTRAP_RECEIPT_SCHEMA_VERSION = 1 as const;
export const BOOTSTRAP_RECEIPT_VERSION = 1 as const;
export const BOOTSTRAP_CHECK_IDS = [
  "active-intent",
  "stage-plan",
  "core-definitions",
  "effective-policy",
  "workspace-repositories",
] as const;

export type BootstrapCheckId = (typeof BOOTSTRAP_CHECK_IDS)[number];

export interface BootstrapCheck {
  check_id: BootstrapCheckId;
  status: "passed";
  evidence: string;
}

export interface BootstrapReceipt {
  schema_version: typeof BOOTSTRAP_RECEIPT_SCHEMA_VERSION;
  artifact: "bootstrap-receipt";
  version: typeof BOOTSTRAP_RECEIPT_VERSION;
  intent_id: string;
  space: string;
  harness: "codex";
  aidlc_version: string;
  catalog_version: string;
  graph_version: string;
  plan_revision: number;
  policy_snapshot: ArtifactReference;
  repository_roots: string[];
  input_sha256: string;
  checks: BootstrapCheck[];
  result: "ready";
  created_at: string;
}

export interface BootstrapExecutionResult {
  execution: "executed" | "reused";
  receipt: BootstrapReceipt;
  reference: ArtifactReference;
  state: VNextIntentState;
}

export interface BootstrapExecutionOptions {
  createdAt?: string;
}

const RECEIPT_KEYS = [
  "schema_version",
  "artifact",
  "version",
  "intent_id",
  "space",
  "harness",
  "aidlc_version",
  "catalog_version",
  "graph_version",
  "plan_revision",
  "policy_snapshot",
  "repository_roots",
  "input_sha256",
  "checks",
  "result",
  "created_at",
] as const;

const CHECK_KEYS = ["check_id", "status", "evidence"] as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STAGE_CONTRACT_PATH = join(
  runtimeCoreDir(),
  "aidlc-common/stages/st-00-bootstrap.json",
);

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

function asSha256(value: unknown, context: string): string {
  const digest = asOneLine(value, context);
  if (!SHA256_PATTERN.test(digest)) {
    fail(context, "must use sha256:<64 lowercase hex characters>");
  }
  return digest;
}

function parseRepositoryRoots(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(context, "must contain at least one project-relative root");
  }
  const roots = value.map((entry, index) =>
    asOneLine(entry, `${context}[${index}]`)
  );
  const duplicate = roots.find((entry, index) => roots.indexOf(entry) !== index);
  if (duplicate !== undefined) fail(context, `contains duplicate root: ${duplicate}`);
  return roots;
}

function parseChecks(value: unknown, context: string): BootstrapCheck[] {
  if (!Array.isArray(value)) fail(context, "must be an array");
  if (value.length !== BOOTSTRAP_CHECK_IDS.length) {
    fail(context, `must contain exactly ${BOOTSTRAP_CHECK_IDS.length} checks`);
  }
  return value.map((entry, index): BootstrapCheck => {
    const itemContext = `${context}[${index}]`;
    const record = asRecord(entry, itemContext);
    rejectUnknownKeys(record, CHECK_KEYS, itemContext);
    const expected = BOOTSTRAP_CHECK_IDS[index]!;
    if (record.check_id !== expected) {
      fail(`${itemContext}.check_id`, `must equal ${expected}; fixed check order cannot change`);
    }
    if (record.status !== "passed") fail(`${itemContext}.status`, "must equal passed");
    return {
      check_id: expected,
      status: "passed",
      evidence: asOneLine(record.evidence, `${itemContext}.evidence`),
    };
  });
}

export function parseBootstrapReceipt(
  value: unknown,
  context = "Bootstrap Receipt",
): BootstrapReceipt {
  const record = asRecord(value, context);
  rejectUnknownKeys(record, RECEIPT_KEYS, context);
  if (record.schema_version !== BOOTSTRAP_RECEIPT_SCHEMA_VERSION) {
    fail(`${context}.schema_version`, `must equal ${BOOTSTRAP_RECEIPT_SCHEMA_VERSION}`);
  }
  if (record.artifact !== "bootstrap-receipt") {
    fail(`${context}.artifact`, "must equal bootstrap-receipt");
  }
  if (record.version !== BOOTSTRAP_RECEIPT_VERSION) {
    fail(`${context}.version`, `must equal ${BOOTSTRAP_RECEIPT_VERSION}`);
  }
  if (record.harness !== "codex") fail(`${context}.harness`, "must equal codex");
  if (record.result !== "ready") fail(`${context}.result`, "must equal ready");
  return {
    schema_version: BOOTSTRAP_RECEIPT_SCHEMA_VERSION,
    artifact: "bootstrap-receipt",
    version: BOOTSTRAP_RECEIPT_VERSION,
    intent_id: asOneLine(record.intent_id, `${context}.intent_id`),
    space: asOneLine(record.space, `${context}.space`),
    harness: "codex",
    aidlc_version: asOneLine(record.aidlc_version, `${context}.aidlc_version`),
    catalog_version: asOneLine(record.catalog_version, `${context}.catalog_version`),
    graph_version: asOneLine(record.graph_version, `${context}.graph_version`),
    plan_revision: asPositiveInteger(record.plan_revision, `${context}.plan_revision`),
    policy_snapshot: parseArtifactReference(
      record.policy_snapshot,
      `${context}.policy_snapshot`,
    ),
    repository_roots: parseRepositoryRoots(
      record.repository_roots,
      `${context}.repository_roots`,
    ),
    input_sha256: asSha256(record.input_sha256, `${context}.input_sha256`),
    checks: parseChecks(record.checks, `${context}.checks`),
    result: "ready",
    created_at: asIsoTimestamp(record.created_at, `${context}.created_at`),
  };
}

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
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
      // A successful rename already consumed the temporary file.
    }
    throw error;
  }
}

function serializeReceipt(receipt: BootstrapReceipt): string {
  return `${JSON.stringify(parseBootstrapReceipt(receipt), null, 2)}\n`;
}

function portableProjectPath(projectDir: string, path: string): string {
  const projectRoot = resolve(projectDir);
  const absolute = resolve(path);
  const rel = relative(projectRoot, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("Bootstrap Receipt", "source_of_truth must remain inside the project");
  }
  return rel === "" ? "." : rel.split(sep).join("/");
}

export function bootstrapReceiptPath(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "bootstrap-receipt-r1.json");
}

export function loadBootstrapStageContract(
  path = STAGE_CONTRACT_PATH,
): VNextStageContract {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("ST-00 Contract", `cannot read ${path}: ${detail}`);
  }
  const contract = parseVNextStageContract(value, path);
  if (contract.stage_id !== "ST-00" || contract.name !== "Bootstrap") {
    fail("ST-00 Contract", "must define ST-00 Bootstrap");
  }
  return contract;
}

function requireDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail("ST-00 Bootstrap", `${label} does not exist or is not a directory: ${path}`);
  }
}

function selectedRepositoryRoots(
  projectDir: string,
  recordDir: string,
  intentId: string,
  space: string,
): string[] {
  const matching = readIntentRegistry(projectDir, space).filter((entry) =>
    entry.uuid === intentId && entry.dirName === basename(recordDir)
  );
  if (matching.length !== 1) {
    fail("ST-00 Bootstrap", "active Intent must have exactly one matching registry entry");
  }
  const configured = matching[0]?.repos;
  if (configured !== undefined && !Array.isArray(configured)) {
    fail("ST-00 Bootstrap", "Intent Repository roots must be an array");
  }
  const roots = configured === undefined || configured.length === 0 ? ["."] : configured;
  const normalized = roots.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "" || entry !== entry.trim()) {
      fail("ST-00 Bootstrap", `Repository root[${index}] must be a non-empty string`);
    }
    if (isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      fail("ST-00 Bootstrap", `Repository root must be project-relative and safe: ${entry}`);
    }
    const absolute = resolve(projectDir, entry);
    const rel = relative(resolve(projectDir), absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      fail("ST-00 Bootstrap", `Repository root escapes the project: ${entry}`);
    }
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      fail("ST-00 Bootstrap", `Repository root does not exist: ${entry}`);
    }
    return rel === "" ? "." : rel.split(sep).join("/");
  });
  const duplicate = normalized.find((entry, index) => normalized.indexOf(entry) !== index);
  if (duplicate !== undefined) {
    fail("ST-00 Bootstrap", `duplicate Repository root: ${duplicate}`);
  }
  return normalized;
}

interface BootstrapInputs {
  intent_id: string;
  space: string;
  harness: "codex";
  aidlc_version: string;
  catalog_version: string;
  graph_version: string;
  plan_revision: number;
  policy_snapshot: ArtifactReference;
  repository_roots: string[];
}

function inputDigest(inputs: BootstrapInputs): string {
  return digest(JSON.stringify(inputs));
}

function checksFor(inputs: BootstrapInputs): BootstrapCheck[] {
  return [
    {
      check_id: "active-intent",
      status: "passed",
      evidence: `Active vNext Intent ${inputs.intent_id} is selected in Space ${inputs.space}.`,
    },
    {
      check_id: "stage-plan",
      status: "passed",
      evidence: `Stage Execution Plan revision ${inputs.plan_revision} is valid at ST-00.`,
    },
    {
      check_id: "core-definitions",
      status: "passed",
      evidence: `Catalog ${inputs.catalog_version} and Graph ${inputs.graph_version} are valid.`,
    },
    {
      check_id: "effective-policy",
      status: "passed",
      evidence: `Effective Policy ${inputs.policy_snapshot.sha256} is verified.`,
    },
    {
      check_id: "workspace-repositories",
      status: "passed",
      evidence: `Codex and Bun ${process.versions.bun ?? "unknown"} can access: ${inputs.repository_roots.join(", ")}.`,
    },
  ];
}

function expectedInputs(projectDir: string, recordDir: string): BootstrapInputs {
  loadBootstrapStageContract();
  const definitions = loadVNextDefinitions();
  let resumed: ReturnType<typeof resumeVNextIntent>;
  try {
    resumed = resumeVNextIntent(projectDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/sha256 mismatch/i.test(message)) {
      fail("ST-00 Bootstrap", `Effective Policy SHA-256 does not match: ${message}`);
    }
    throw error;
  }
  const { state, plan } = resumed;
  if (resumed.recordDir !== recordDir) {
    fail("ST-00 Bootstrap", "active Intent changed while acquiring the Workspace lock");
  }
  if (state.current_stage !== "ST-00") {
    fail("ST-00 Bootstrap", `current Stage must be ST-00, found ${state.current_stage}`);
  }
  if (state.catalog_version !== definitions.catalog.catalog_version) {
    fail("ST-00 Bootstrap", "State Catalog version does not match the Runtime Catalog");
  }
  if (
    state.graph_version !== definitions.graph.graph_version ||
    plan.graph_version !== definitions.graph.graph_version
  ) {
    fail("ST-00 Bootstrap", "State or Plan Graph version does not match the Runtime Graph");
  }
  const decision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-00");
  if (decision === undefined) fail("ST-00 Bootstrap", "Plan has no ST-00 decision");
  if (decision.disposition === "not_applicable") {
    fail("ST-00 Bootstrap", "ST-00 cannot be not_applicable");
  }
  const space = activeSpace(projectDir);
  const workspace = workspaceRoot(projectDir);
  requireDirectory(projectDir, "Project root");
  requireDirectory(workspace, "Workspace root");
  requireDirectory(join(workspace, "spaces", space), "active Space");
  requireDirectory(recordDir, "active Intent record");
  verifyProjectArtifactReference(projectDir, state.policy_snapshot);
  if (typeof process.versions.bun !== "string" || process.versions.bun === "") {
    fail("ST-00 Bootstrap", "Bun runtime is required");
  }
  return {
    intent_id: state.intent_id,
    space,
    harness: "codex",
    aidlc_version: AIDLC_VERSION,
    catalog_version: state.catalog_version,
    graph_version: state.graph_version,
    plan_revision: state.plan_revision,
    policy_snapshot: state.policy_snapshot,
    repository_roots: selectedRepositoryRoots(
      projectDir,
      recordDir,
      state.intent_id,
      space,
    ),
  };
}

function buildReceipt(inputs: BootstrapInputs, createdAt: string): BootstrapReceipt {
  return parseBootstrapReceipt({
    schema_version: BOOTSTRAP_RECEIPT_SCHEMA_VERSION,
    artifact: "bootstrap-receipt",
    version: BOOTSTRAP_RECEIPT_VERSION,
    ...inputs,
    input_sha256: inputDigest(inputs),
    checks: checksFor(inputs),
    result: "ready",
    created_at: createdAt,
  });
}

function receiptReference(
  projectDir: string,
  path: string,
  content: string,
): ArtifactReference {
  return parseArtifactReference({
    artifact: "bootstrap-receipt",
    version: BOOTSTRAP_RECEIPT_VERSION,
    source_of_truth: portableProjectPath(projectDir, path),
    sha256: digest(content),
  });
}

function readCanonicalReceipt(path: string): { receipt: BootstrapReceipt; content: string } {
  const content = readFileSync(path, "utf8");
  let receipt: BootstrapReceipt;
  try {
    receipt = parseBootstrapReceipt(JSON.parse(content), path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("ST-00 Bootstrap", `Receipt was modified or is invalid: ${detail}`);
  }
  if (content !== serializeReceipt(receipt)) {
    fail("ST-00 Bootstrap", "Receipt is not canonical");
  }
  return { receipt, content };
}

function assertReceiptMatchesInputs(
  receipt: BootstrapReceipt,
  inputs: BootstrapInputs,
): void {
  if (receipt.input_sha256 !== inputDigest(inputs)) {
    fail("ST-00 Bootstrap", "Receipt input fingerprint does not match current Core inputs");
  }
  const comparable = {
    intent_id: receipt.intent_id,
    space: receipt.space,
    harness: receipt.harness,
    aidlc_version: receipt.aidlc_version,
    catalog_version: receipt.catalog_version,
    graph_version: receipt.graph_version,
    plan_revision: receipt.plan_revision,
    policy_snapshot: receipt.policy_snapshot,
    repository_roots: receipt.repository_roots,
  };
  if (JSON.stringify(comparable) !== JSON.stringify(inputs)) {
    fail("ST-00 Bootstrap", "Receipt does not match current Core inputs");
  }
  if (JSON.stringify(receipt.checks) !== JSON.stringify(checksFor(inputs))) {
    fail("ST-00 Bootstrap", "Receipt checks do not match current Core verification");
  }
}

function assertRecordedReceiptUnchanged(
  recordDir: string,
  reference: ArtifactReference,
): void {
  const completed = readOrderedAuditEntries(recordDir).filter((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-00"
  );
  if (
    completed.length > 0 &&
    !completed.some((entry) => entry.fields["Receipt SHA-256"] === reference.sha256)
  ) {
    fail("ST-00 Bootstrap", "Receipt was modified after ST-00 completion");
  }
}

export function verifyBootstrapReceiptAt(
  projectDir: string,
  recordDir: string,
): { receipt: BootstrapReceipt; reference: ArtifactReference } {
  const projectRoot = resolve(projectDir);
  const path = bootstrapReceiptPath(recordDir);
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail("ST-00 Bootstrap", `Bootstrap Receipt does not exist: ${path}`);
  }
  const { receipt, content } = readCanonicalReceipt(path);
  const state = readVNextStateAt(recordDir);
  if (receipt.intent_id !== state.intent_id) {
    fail("ST-00 Bootstrap", "Receipt Intent does not match Core State");
  }
  const reference = receiptReference(projectRoot, path, content);
  verifyProjectArtifactReference(projectRoot, reference);
  const completions = readOrderedAuditEntries(recordDir).filter((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-00"
  );
  if (completions.length === 0) {
    fail("ST-00 Bootstrap", "Audit has no ST-00 completion Evidence");
  }
  assertRecordedReceiptUnchanged(recordDir, reference);
  if (!completions.some((entry) => entry.fields["Receipt SHA-256"] === reference.sha256)) {
    fail("ST-00 Bootstrap", "Audit Receipt SHA-256 does not match the Receipt");
  }
  return { receipt, reference };
}

function recordCompletionOnce(
  projectDir: string,
  recordDir: string,
  execution: "executed" | "reused",
  reference: ArtifactReference,
  graphVersion: string,
): void {
  const events = readOrderedAuditEntries(recordDir);
  const completed = events.some((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-00" &&
    entry.fields["Receipt SHA-256"] === reference.sha256
  );
  if (!completed) {
    appendAuditEntries(projectDir, recordDir, [
      {
        event: "STAGE_STARTED",
        fields: { Stage: "ST-00", Executor: "core", Verifier: "aidlc-vnext-bootstrap" },
      },
      {
        event: "STAGE_COMPLETED",
        fields: {
          Stage: "ST-00",
          Artifact: reference.source_of_truth,
          "Receipt SHA-256": reference.sha256,
          Execution: execution,
          "Decision Authority": "core",
        },
      },
    ]);
  }
  const routed = readOrderedAuditEntries(recordDir).some((entry) =>
    entry.event === "ROUTE_DECIDED" && entry.fields["From Stage"] === "ST-00" &&
    entry.fields["Current Stage"] === "ST-01"
  );
  if (!routed) {
    appendAuditEntry(projectDir, recordDir, "ROUTE_DECIDED", {
      "From Stage": "ST-00",
      "Current Stage": "ST-01",
      Graph: graphVersion,
      "Decision Authority": "core",
    });
  }
}

function executeBootstrapLocked(
  projectDir: string,
  recordDir: string,
  options: BootstrapExecutionOptions,
): BootstrapExecutionResult {
  const inputs = expectedInputs(projectDir, recordDir);
  const plan = readVNextPlanAt(recordDir);
  const decision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-00")!;
  const path = bootstrapReceiptPath(recordDir);
  let execution: "executed" | "reused";
  let receipt: BootstrapReceipt;
  let content: string;

  if (existsSync(path)) {
    ({ receipt, content } = readCanonicalReceipt(path));
    assertReceiptMatchesInputs(receipt, inputs);
    execution = "reused";
  } else {
    if (decision.disposition === "reuse") {
      fail("ST-00 Bootstrap", "reuse requires the same Intent's Bootstrap Receipt");
    }
    receipt = buildReceipt(inputs, options.createdAt ?? new Date().toISOString());
    content = serializeReceipt(receipt);
    writeFileAtomic(path, content);
    execution = "executed";
  }

  const reference = receiptReference(projectDir, path, content);
  verifyProjectArtifactReference(projectDir, reference);
  if (decision.disposition === "reuse") {
    const declared = decision.evidence.find((entry) =>
      entry.artifact === "bootstrap-receipt"
    );
    if (declared === undefined || JSON.stringify(declared) !== JSON.stringify(reference)) {
      fail("ST-00 Bootstrap", "reuse Evidence does not match the same Intent's Receipt");
    }
  }
  assertRecordedReceiptUnchanged(recordDir, reference);

  const definitions = loadVNextDefinitions();
  const nextStage = nextForwardStage(definitions.graph, "ST-00");
  if (nextStage !== "ST-01") fail("ST-00 Bootstrap", "fixed Graph must route to ST-01");
  validateCoreRoute(definitions.graph, { from: "ST-00", to: nextStage });
  recordCompletionOnce(
    projectDir,
    recordDir,
    execution,
    reference,
    definitions.graph.graph_version,
  );

  const state = readVNextStateAt(recordDir);
  const advanced = {
    ...state,
    current_stage: nextStage,
    status: "parked" as const,
    parked_reason: "ST-01 Orient is ready for Core preparation.",
    updated_at: options.createdAt ?? new Date().toISOString(),
  };
  writeVNextStateAt(recordDir, advanced, plan);
  return { execution, receipt, reference, state: readVNextStateAt(recordDir) };
}

export function executeBootstrap(
  projectDir: string,
  options: BootstrapExecutionOptions = {},
): BootstrapExecutionResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return executeBootstrapLocked(projectRoot, recordDir, options);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n]+/g, " ")
        .trim();
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-00",
        Reason: reason,
        "Decision Authority": "core",
      });
      throw error;
    }
  });
}

export function main(argv: string[]): void {
  const [command, projectDir, ...rest] = argv;
  if (command !== "run" || projectDir === undefined || rest.length !== 0) {
    console.error("Usage: aidlc bootstrap run <project-dir>");
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(executeBootstrap(projectDir), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
