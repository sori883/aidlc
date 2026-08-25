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
import { designBriefPath } from "./aidlc-intent.ts";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";
import {
  parseArtifactReference,
  parseVNextStageContract,
  type ArtifactReference,
  type VNextStageContract,
} from "./aidlc-stage-contract.ts";
import {
  parseDefineIntentWorkRequest,
  parseIntentDefinition,
  parseIntentDefinitionProposal,
  type DefineIntentWorkRequest,
  type IntentDefinition,
} from "./aidlc-vnext-define-intent-contract.ts";
import {
  currentContextPath,
} from "./aidlc-vnext-orient.ts";
import {
  parseCurrentContext,
  parseDesignBrief,
} from "./aidlc-vnext-orient-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export interface DefineIntentPrepareOptions {
  preparedAt?: string;
}

export interface DefineIntentPrepareResult {
  execution: "prepared" | "reused";
  request: DefineIntentWorkRequest;
  reference: ArtifactReference;
}

export interface DefineIntentCompleteOptions {
  completedAt?: string;
}

export interface DefineIntentCompleteResult {
  definition: IntentDefinition;
  reference: ArtifactReference;
  state: VNextIntentState;
}

const STAGE_CONTRACT_PATH = join(
  runtimeCoreDir(),
  "aidlc-common/stages/st-02-define-intent.json",
);

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
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

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function portableProjectPath(projectDir: string, path: string): string {
  const projectRoot = resolve(projectDir);
  const absolute = resolve(path);
  const rel = relative(projectRoot, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("ST-02 Define Intent", `path is outside the project: ${absolute}`);
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
    fail("ST-02 Define Intent", `cannot read ${path}: ${detail}`);
  }
  if (content !== serialize(value)) {
    fail("ST-02 Define Intent", `artifact is not canonical: ${path}`);
  }
  return { value, content };
}

export function defineIntentWorkRequestPath(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "define-intent-work-request.json");
}

export function intentDefinitionPath(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "intent-definition.json");
}

export function loadDefineIntentStageContract(
  path = STAGE_CONTRACT_PATH,
): VNextStageContract {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("ST-02 Contract", `cannot read ${path}: ${detail}`);
  }
  const contract = parseVNextStageContract(value, path);
  if (contract.stage_id !== "ST-02" || contract.name !== "Define Intent") {
    fail("ST-02 Contract", "must define ST-02 Define Intent");
  }
  return contract;
}

function inputReferences(
  projectDir: string,
  recordDir: string,
  intentId: string,
  policyReference: ArtifactReference,
): {
  designBriefReference: ArtifactReference;
  currentContextReference: ArtifactReference;
  effectivePolicyReference: ArtifactReference;
} {
  const briefPath = designBriefPath(recordDir);
  const contextPath = currentContextPath(recordDir);
  if (!existsSync(briefPath) || !existsSync(contextPath)) {
    fail("ST-02 Define Intent", "Design Brief and Current Context are required");
  }
  const brief = readCanonical(briefPath, parseDesignBrief);
  const current = readCanonical(contextPath, parseCurrentContext);
  if (brief.value.intent_id !== intentId || current.value.intent_id !== intentId) {
    fail("ST-02 Define Intent", "input Artifact Intent does not match State");
  }
  const designBriefReference = artifactReference(
    projectDir,
    briefPath,
    "design-brief",
    brief.content,
  );
  const currentContextReference = artifactReference(
    projectDir,
    contextPath,
    "current-context",
    current.content,
  );
  for (const reference of [
    designBriefReference,
    currentContextReference,
    policyReference,
  ]) verifyProjectArtifactReference(projectDir, reference);
  return {
    designBriefReference,
    currentContextReference,
    effectivePolicyReference: policyReference,
  };
}

function prepareDefineIntentLocked(
  projectDir: string,
  recordDir: string,
  options: DefineIntentPrepareOptions,
): DefineIntentPrepareResult {
  loadDefineIntentStageContract();
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-02") {
    fail("ST-02 Define Intent", `current Stage must be ST-02, found ${state.current_stage}`);
  }
  const decision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-02");
  if (decision === undefined) fail("ST-02 Define Intent", "Plan has no ST-02 decision");
  if (decision.disposition === "not_applicable") {
    fail("ST-02 Define Intent", "ST-02 cannot be not_applicable; every Intent needs a definition");
  }
  const inputs = inputReferences(
    projectDir,
    recordDir,
    state.intent_id,
    state.policy_snapshot,
  );
  const path = defineIntentWorkRequestPath(recordDir);
  if (existsSync(path)) {
    const stored = readCanonical(path, parseDefineIntentWorkRequest);
    if (
      stored.value.intent_id === state.intent_id &&
      JSON.stringify(stored.value.design_brief_ref) ===
        JSON.stringify(inputs.designBriefReference) &&
      JSON.stringify(stored.value.current_context_ref) ===
        JSON.stringify(inputs.currentContextReference) &&
      JSON.stringify(stored.value.effective_policy_ref) ===
        JSON.stringify(inputs.effectivePolicyReference)
    ) {
      const reference = artifactReference(
        projectDir,
        path,
        "define-intent-work-request",
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
  const request = parseDefineIntentWorkRequest({
    schema_version: 1,
    artifact: "define-intent-work-request",
    version: 1,
    intent_id: state.intent_id,
    stage_id: "ST-02",
    design_brief_ref: inputs.designBriefReference,
    current_context_ref: inputs.currentContextReference,
    effective_policy_ref: inputs.effectivePolicyReference,
    requested_outputs: ["intent-definition-proposal"],
    rules: [
      "Define only purpose, expected outcomes, scope, exclusions, success signals, and known unknowns.",
      "Do not add requirements detail, architecture decisions, build plans, implementation instructions, or routes.",
      "Keep small changes short and ask a human before proposing when a value judgment or priority choice is unresolved.",
      "AI proposes content only; Core validates, persists, and owns the fixed Stage transition.",
    ],
    created_at: preparedAt,
  });
  const content = serialize(request);
  writeFileAtomic(path, content);
  const reference = artifactReference(
    projectDir,
    path,
    "define-intent-work-request",
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

export function prepareDefineIntent(
  projectDir: string,
  options: DefineIntentPrepareOptions = {},
): DefineIntentPrepareResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return prepareDefineIntentLocked(projectRoot, recordDir, options);
    } catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-02",
        Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "),
        "Decision Authority": "core",
      });
      throw error;
    }
  });
}

function completeDefineIntentLocked(
  projectDir: string,
  recordDir: string,
  proposalValue: unknown,
  options: DefineIntentCompleteOptions,
): DefineIntentCompleteResult {
  const state = readVNextStateAt(recordDir);
  if (state.current_stage !== "ST-02") {
    fail("ST-02 Define Intent", `current Stage must be ST-02, found ${state.current_stage}`);
  }
  const plan = readVNextPlanAt(recordDir);
  const prepared = prepareDefineIntentLocked(projectDir, recordDir, {});
  const proposal = parseIntentDefinitionProposal(proposalValue);
  if (proposal.intent_id !== state.intent_id) {
    fail("ST-02 Define Intent", "Proposal Intent does not match State");
  }
  if (proposal.work_request_sha256 !== prepared.reference.sha256) {
    fail(
      "ST-02 Define Intent",
      "Proposal does not reference the current Define Intent Work Request",
    );
  }
  const completedAt = options.completedAt ?? new Date().toISOString();
  let definition = parseIntentDefinition({
    schema_version: 1,
    artifact: "intent-definition",
    version: 1,
    intent_id: state.intent_id,
    proposal_id: proposal.proposal_id,
    design_brief_ref: prepared.request.design_brief_ref,
    current_context_ref: prepared.request.current_context_ref,
    effective_policy_ref: prepared.request.effective_policy_ref,
    purpose: proposal.purpose,
    expected_outcomes: proposal.expected_outcomes,
    in_scope: proposal.in_scope,
    out_of_scope: proposal.out_of_scope,
    success_signals: proposal.success_signals,
    unknowns: proposal.unknowns,
    reason: proposal.reason,
    created_at: completedAt,
  });
  const path = intentDefinitionPath(recordDir);
  let content = serialize(definition);
  if (existsSync(path)) {
    const stored = readCanonical(path, parseIntentDefinition);
    const { created_at: _candidateCreatedAt, ...candidateStable } = definition;
    const { created_at: _storedCreatedAt, ...storedStable } = stored.value;
    if (JSON.stringify(storedStable) !== JSON.stringify(candidateStable)) {
      fail("ST-02 Define Intent", "canonical Intent Definition already exists with different content");
    }
    definition = stored.value;
    content = stored.content;
  } else {
    writeFileAtomic(path, content);
  }
  const reference = artifactReference(projectDir, path, "intent-definition", content);
  verifyProjectArtifactReference(projectDir, reference);

  const definitions = loadVNextDefinitions();
  const nextStage = nextForwardStage(definitions.graph, "ST-02");
  if (nextStage !== "ST-03") fail("ST-02 Define Intent", "fixed Graph must route to ST-03");
  validateCoreRoute(definitions.graph, { from: "ST-02", to: nextStage });
  const alreadyCompleted = readOrderedAuditEntries(recordDir).some((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-02" &&
    entry.fields["Intent Definition SHA-256"] === reference.sha256
  );
  if (!alreadyCompleted) {
    appendAuditEntries(projectDir, recordDir, [
      {
        event: "STAGE_STARTED",
        fields: { Stage: "ST-02", Executor: "ai+core", Verifier: "intent-definition-validator" },
      },
      {
        event: "STAGE_COMPLETED",
        fields: {
          Stage: "ST-02",
          Artifact: reference.source_of_truth,
          "Intent Definition SHA-256": reference.sha256,
          "Decision Authority": "core",
        },
      },
      {
        event: "ROUTE_DECIDED",
        fields: {
          "From Stage": "ST-02",
          "Current Stage": "ST-03",
          Graph: definitions.graph.graph_version,
          "Decision Authority": "core",
        },
      },
    ]);
  }
  const advanced: VNextIntentState = {
    ...state,
    current_stage: "ST-03",
    status: "parked",
    parked_reason: "ST-03 Requirements & Constraints is ready for Core preparation.",
    updated_at: completedAt,
  };
  writeVNextStateAt(recordDir, advanced, plan);
  return { definition, reference, state: readVNextStateAt(recordDir) };
}

export function completeDefineIntent(
  projectDir: string,
  proposalValue: unknown,
  options: DefineIntentCompleteOptions = {},
): DefineIntentCompleteResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return completeDefineIntentLocked(projectRoot, recordDir, proposalValue, options);
    } catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-02",
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
      "Usage: aidlc define-intent prepare <project-dir>\n" +
        "       aidlc define-intent complete <project-dir> <proposal.json>",
    );
    process.exitCode = 1;
    return;
  }
  try {
    if (projectDir === undefined) throw new Error("project directory is required");
    const result = command === "prepare"
      ? prepareDefineIntent(projectDir)
      : completeDefineIntent(
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
