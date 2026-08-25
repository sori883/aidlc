import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import {
  verifyProjectArtifactReference,
  INTENT_RISK_SEVERITIES,
  type IntentRiskSeverity,
} from "./aidlc-effective-policy.ts";
import type { ArtifactReference } from "./aidlc-stage-contract.ts";
import {
  parseIntentRiskCurrent,
  parseIntentRiskDecision,
  parseIntentRiskProposal,
  parseIntentRiskRegister,
  type IntentRiskCurrent,
  type IntentRiskDecision,
  type IntentRiskEntry,
  type IntentRiskProposal,
  type IntentRiskRegister,
  type IntentRiskSeed,
} from "./aidlc-vnext-risk-contract.ts";

export interface InitializeIntentRiskOptions {
  risks?: readonly IntentRiskSeed[];
  createdAt?: string;
}

export interface RiskMutationOptions {
  createdAt?: string;
}

export interface WrittenIntentRiskRegister {
  register: IntentRiskRegister;
  registerReference: ArtifactReference;
  current: IntentRiskCurrent;
  currentReference: ArtifactReference;
}

const SEVERITY_RANK = new Map<IntentRiskSeverity, number>(
  INTENT_RISK_SEVERITIES.map((severity, index) => [severity, index]),
);

function fail(message: string): never {
  throw new Error(`Intent Risk: ${message}`);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function portablePath(projectDir: string, path: string): string {
  const root = resolve(projectDir);
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`path is outside the Project: ${absolute}`);
  }
  return rel.split(sep).join("/");
}

function reference(
  projectDir: string,
  path: string,
  artifact: string,
  content: string,
): ArtifactReference {
  return {
    artifact,
    version: 1,
    source_of_truth: portablePath(projectDir, path),
    sha256: digest(content),
  };
}

function atomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

export function intentRiskRootDir(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "risks");
}

export function intentRiskCurrentPath(recordDir: string): string {
  return join(intentRiskRootDir(recordDir), "current.json");
}

export function intentRiskRevisionPath(recordDir: string, revision: number): string {
  return join(
    intentRiskRootDir(recordDir),
    "revisions",
    String(revision).padStart(6, "0"),
    "intent-risk-register.json",
  );
}

export function intentRiskProposalPath(recordDir: string, proposalId: string): string {
  return join(intentRiskRootDir(recordDir), "proposals", proposalId, "proposal.json");
}

export function intentRiskDecisionPath(recordDir: string, decisionId: string): string {
  return join(intentRiskRootDir(recordDir), "decisions", decisionId, "decision.json");
}

function verifyReferences(projectDir: string, references: ArtifactReference[]): void {
  for (const item of references) verifyProjectArtifactReference(projectDir, item);
}

function writeRevision(
  projectDir: string,
  recordDir: string,
  register: IntentRiskRegister,
): WrittenIntentRiskRegister {
  const path = intentRiskRevisionPath(recordDir, register.revision);
  const content = serialize(register);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== content) {
      fail(`immutable revision ${register.revision} already has different content`);
    }
  } else {
    atomic(path, content);
  }
  const registerReference = reference(
    projectDir,
    path,
    "intent-risk-register",
    content,
  );
  const current = parseIntentRiskCurrent({
    schema_version: 1,
    artifact: "intent-risk-current",
    version: 1,
    intent_id: register.intent_id,
    current_revision: register.revision,
    register_ref: registerReference,
    updated_at: register.created_at,
  });
  const currentContent = serialize(current);
  const currentPath = intentRiskCurrentPath(recordDir);
  atomic(currentPath, currentContent);
  return {
    register,
    registerReference,
    current,
    currentReference: reference(
      projectDir,
      currentPath,
      "intent-risk-current",
      currentContent,
    ),
  };
}

export function initializeIntentRiskRegisterAt(
  projectDir: string,
  recordDir: string,
  intentId: string,
  options: InitializeIntentRiskOptions = {},
): WrittenIntentRiskRegister {
  const path = intentRiskCurrentPath(recordDir);
  if (existsSync(path)) {
    const register = readCurrentIntentRiskRegisterAt(projectDir, recordDir);
    if (register.intent_id !== intentId) fail("existing Register belongs to another Intent");
    const content = readFileSync(path, "utf8");
    const current = parseIntentRiskCurrent(JSON.parse(content));
    return {
      register,
      registerReference: current.register_ref,
      current,
      currentReference: reference(
        projectDir,
        path,
        "intent-risk-current",
        content,
      ),
    };
  }
  const risks: IntentRiskEntry[] = (options.risks ?? []).map((risk) => ({
    ...risk,
    status: "active",
    last_decision_ref: null,
  }));
  const register = parseIntentRiskRegister({
    schema_version: 1,
    artifact: "intent-risk-register",
    version: 1,
    intent_id: intentId,
    revision: 1,
    base_revision: null,
    risks,
    created_at: options.createdAt ?? new Date().toISOString(),
  });
  verifyReferences(projectDir, register.risks.flatMap((risk) => risk.evidence_refs));
  return writeRevision(projectDir, recordDir, register);
}

export function readCurrentIntentRiskRegisterWithReferenceAt(
  projectDir: string,
  recordDir: string,
): { register: IntentRiskRegister; reference: ArtifactReference; current: IntentRiskCurrent } {
  const currentPath = intentRiskCurrentPath(recordDir);
  if (!existsSync(currentPath)) fail(`missing Current pointer: ${currentPath}`);
  const current = parseIntentRiskCurrent(
    JSON.parse(readFileSync(currentPath, "utf8")),
  );
  if (current.register_ref.artifact !== "intent-risk-register") {
    fail("Current pointer must reference intent-risk-register");
  }
  const path = verifyProjectArtifactReference(projectDir, current.register_ref);
  const register = parseIntentRiskRegister(JSON.parse(readFileSync(path, "utf8")));
  if (
    register.intent_id !== current.intent_id ||
    register.revision !== current.current_revision
  ) fail("Current pointer does not match the immutable Register");
  verifyReferences(
    projectDir,
    register.risks.flatMap((risk) => [
      ...risk.evidence_refs,
      ...(risk.last_decision_ref === null ? [] : [risk.last_decision_ref]),
    ]),
  );
  return { register, reference: current.register_ref, current };
}

export function readCurrentIntentRiskRegisterAt(
  projectDir: string,
  recordDir: string,
): IntentRiskRegister {
  return readCurrentIntentRiskRegisterWithReferenceAt(projectDir, recordDir).register;
}

/** Validate the mutable Current pointer and every immutable Risk revision. */
export function validateIntentRiskArtifactsAt(
  projectDir: string,
  recordDir: string,
  expectedIntentId?: string,
): void {
  const currentPath = intentRiskCurrentPath(recordDir);
  if (!existsSync(currentPath)) fail("Risk Register Current is missing");
  const currentContent = readFileSync(currentPath, "utf8");
  const current = parseIntentRiskCurrent(JSON.parse(currentContent));
  if (currentContent !== serialize(current)) fail("Risk Register Current is not canonical");
  if (expectedIntentId !== undefined && current.intent_id !== expectedIntentId) {
    fail("Risk Register belongs to another Intent");
  }
  const revisionsRoot = join(intentRiskRootDir(recordDir), "revisions");
  const revisionNames = existsSync(revisionsRoot)
    ? readdirSync(revisionsRoot).filter((entry) => /^\d{6}$/.test(entry)).sort()
    : [];
  const expectedNames = Array.from(
    { length: current.current_revision },
    (_value, index) => String(index + 1).padStart(6, "0"),
  );
  if (JSON.stringify(revisionNames) !== JSON.stringify(expectedNames)) {
    fail("Risk Register revisions must be contiguous and immutable");
  }
  for (let revision = 1; revision <= current.current_revision; revision += 1) {
    const path = intentRiskRevisionPath(recordDir, revision);
    const content = readFileSync(path, "utf8");
    const register = parseIntentRiskRegister(JSON.parse(content));
    if (content !== serialize(register)) fail(`Risk Register revision ${revision} is not canonical`);
    if (register.intent_id !== current.intent_id || register.revision !== revision) {
      fail(`Risk Register revision ${revision} has an invalid Intent or revision binding`);
    }
    verifyReferences(
      projectDir,
      register.risks.flatMap((risk) => [
        ...risk.evidence_refs,
        ...(risk.last_decision_ref === null ? [] : [risk.last_decision_ref]),
      ]),
    );
  }
  verifyProjectArtifactReference(projectDir, current.register_ref);
  const latestContent = readFileSync(intentRiskRevisionPath(recordDir, current.current_revision), "utf8");
  if (current.register_ref.sha256 !== digest(latestContent)) {
    fail("Risk Register Current does not pin the latest immutable revision");
  }
}

function rank(severity: IntentRiskSeverity): number {
  return SEVERITY_RANK.get(severity) ?? -1;
}

export function proposeIntentRisksAt(
  projectDir: string,
  recordDir: string,
  input: IntentRiskProposal,
  options: RiskMutationOptions = {},
): IntentRiskRegister {
  const proposal = parseIntentRiskProposal(input);
  const current = readCurrentIntentRiskRegisterAt(projectDir, recordDir);
  if (proposal.intent_id !== current.intent_id) fail("Proposal belongs to another Intent");
  if (proposal.base_revision !== current.revision) {
    fail(`Proposal base_revision ${proposal.base_revision} is stale; current is ${current.revision}`);
  }
  verifyReferences(
    projectDir,
    proposal.risks.flatMap((risk) => risk.evidence_refs),
  );
  const risks = current.risks.map((risk) => ({ ...risk }));
  for (const proposed of proposal.risks) {
    const index = risks.findIndex((risk) => risk.risk_id === proposed.risk_id);
    if (index === -1) {
      risks.push({ ...proposed, status: "active", last_decision_ref: null });
      continue;
    }
    const existing = risks[index]!;
    if (existing.status !== "active") {
      fail(`AI proposal cannot reactivate ${existing.risk_id}`);
    }
    if (rank(proposed.severity) < rank(existing.severity)) {
      fail(`AI proposal cannot reduce severity for ${existing.risk_id}`);
    }
    risks[index] = {
      ...existing,
      severity: proposed.severity,
      statement: proposed.statement,
      evidence_refs: proposed.evidence_refs,
    };
  }
  const proposalPath = intentRiskProposalPath(recordDir, proposal.proposal_id);
  const proposalContent = serialize(proposal);
  if (existsSync(proposalPath) && readFileSync(proposalPath, "utf8") !== proposalContent) {
    fail(`Proposal ${proposal.proposal_id} already exists with different content`);
  }
  if (!existsSync(proposalPath)) atomic(proposalPath, proposalContent);
  const next = parseIntentRiskRegister({
    ...current,
    revision: current.revision + 1,
    base_revision: current.revision,
    risks,
    created_at: options.createdAt ?? proposal.proposed_at,
  });
  return writeRevision(projectDir, recordDir, next).register;
}

export function decideIntentRiskAt(
  projectDir: string,
  recordDir: string,
  input: IntentRiskDecision,
  options: RiskMutationOptions = {},
): IntentRiskRegister {
  const decision = parseIntentRiskDecision(input);
  const current = readCurrentIntentRiskRegisterAt(projectDir, recordDir);
  if (decision.intent_id !== current.intent_id) fail("Decision belongs to another Intent");
  verifyReferences(projectDir, decision.evidence_refs);
  const index = current.risks.findIndex((risk) => risk.risk_id === decision.risk_id);
  if (index === -1) fail(`unknown risk_id: ${decision.risk_id}`);
  const path = intentRiskDecisionPath(recordDir, decision.decision_id);
  const content = serialize(decision);
  if (existsSync(path) && readFileSync(path, "utf8") !== content) {
    fail(`Decision ${decision.decision_id} already exists with different content`);
  }
  if (!existsSync(path)) atomic(path, content);
  const decisionReference = reference(
    projectDir,
    path,
    "intent-risk-decision",
    content,
  );
  const risks = current.risks.map((risk) => ({ ...risk }));
  const existing = risks[index]!;
  risks[index] = {
    ...existing,
    severity: decision.severity ?? existing.severity,
    status: decision.action === "dismiss"
      ? "dismissed"
      : decision.action === "resolve"
      ? "resolved"
      : "active",
    evidence_refs: decision.evidence_refs.length === 0
      ? existing.evidence_refs
      : decision.evidence_refs,
    last_decision_ref: decisionReference,
  };
  const next = parseIntentRiskRegister({
    ...current,
    revision: current.revision + 1,
    base_revision: current.revision,
    risks,
    created_at: options.createdAt ?? decision.decided_at,
  });
  return writeRevision(projectDir, recordDir, next).register;
}
