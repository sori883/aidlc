import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { readOrderedAuditEntries } from "../core/tools/aidlc-audit.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { executeBootstrap } from "../core/tools/aidlc-vnext-bootstrap.ts";
import { completeDefineIntent } from "../core/tools/aidlc-vnext-define-intent.ts";
import { completeOrient, prepareOrient } from "../core/tools/aidlc-vnext-orient.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
import { completeRequirements, prepareRequirements } from "../core/tools/aidlc-vnext-requirements.ts";
import {
  architectureCurrentPath,
  approveArchitecturePolicy,
  architectureRevisionPath,
  architecturePolicyReviewPath,
  architectureWorkRequestPath,
  completeArchitecture,
  loadArchitectureStageContract,
  prepareArchitecture,
  reviewArchitecturePolicy,
} from "../core/tools/aidlc-vnext-architecture.ts";
import {
  parseArchitectureAssessmentProposal,
  parseArchitectureDecision,
  type ArchitectureAssessmentProposal,
} from "../core/tools/aidlc-vnext-architecture-contract.ts";
import {
  readVNextPlanAt,
  readVNextStateAt,
  resumeVNextIntent,
  writeVNextStateAt,
} from "../core/tools/aidlc-vnext-state.ts";
import { checkVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

const fixtures: string[] = [];

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function fixture(options: {
  policyRule?: {
    rule_id: string;
    minimum_severity: "low" | "medium" | "high" | "critical";
    stage_ids: ["ST-04"];
    acknowledgement: string;
  };
  risks?: Array<{
    risk_id: string;
    severity: "low" | "medium" | "high" | "critical";
    statement: string;
    evidence_refs: [];
  }>;
} = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-architecture-"));
  fixtures.push(projectDir);
  mkdirSync(join(projectDir, "app", "src"), { recursive: true });
  writeFileSync(
    join(projectDir, "app", "src", "login.ts"),
    "export const buttonLabel = '送信';\n",
  );
  initializeWorkspace(projectDir);
  if (options.policyRule !== undefined) {
    writeFileSync(
      join(projectDir, "aidlc", "spaces", "default", "memory", "project-policy.json"),
      `${JSON.stringify({
        schema_version: 1,
        artifact: "human-gate-policy-source",
        layer: "project",
        rules: [options.policyRule],
      }, null, 2)}\n`,
    );
  }
  const born = birthIntentWithState(
    projectDir,
    "ログイン画面の『送信』を『ログイン』へ変える",
    "default",
    ["app"],
    options.risks,
  );
  executeBootstrap(projectDir, { createdAt: "2026-08-24T03:00:00.000Z" });
  const orient = prepareOrient(projectDir, { observedAt: "2026-08-24T03:01:00.000Z" });
  const source = orient.profile.repository_snapshots[0]!;
  completeOrient(projectDir, {
    schema_version: 1,
    artifact: "orient-proposal",
    version: 1,
    intent_id: born.uuid,
    work_request_sha256: orient.reference.sha256,
    system_map_patch: {
      schema_version: 1,
      artifact: "system-map-patch",
      version: 1,
      proposal_id: "architecture-fixture-map",
      map_id: "default-system",
      base_revision: null,
      perspective: "accepted-code-baseline",
      source_snapshots: [source],
      evidence: [{
        evidence_id: "ev-login-copy",
        source_id: source.source_id,
        evidence_type: "file",
        locator: "src/login.ts",
        sha256: sha256(readFileSync(join(projectDir, "app/src/login.ts"), "utf8")),
        observed_at: "2026-08-24T03:01:00.000Z",
      }],
      coverage_upserts: [{
        coverage_id: "cov-login-copy",
        scope: "ログイン画面のボタン表示",
        status: "observed",
        evidence_refs: ["ev-login-copy"],
        observed_at: "2026-08-24T03:01:00.000Z",
      }],
      entity_upserts: [{
        entity_id: "login-view",
        name: "Login View",
        entity_type: "component",
        capability: "user-interface",
        current_state: "observed",
        evidence_refs: ["ev-login-copy"],
      }],
      relation_upserts: [],
      remove_entity_ids: [],
      remove_relation_ids: [],
      reason: "依頼対象の現在位置を観測した。",
      proposed_at: "2026-08-24T03:02:00.000Z",
      proposed_by: "ai",
    },
    current_context: {
      entity_ids: ["login-view"],
      relation_ids: [],
      additional_findings: ["現在の表示は『送信』。"],
      out_of_scope: ["認証処理"],
      intent_only_notes: [],
      unknowns: [],
    },
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T03:03:00.000Z" });
  const intentWork = resolveVNextDirective(projectDir);
  completeDefineIntent(projectDir, {
    schema_version: 1,
    artifact: "intent-definition-proposal",
    version: 1,
    proposal_id: "define-login-copy",
    intent_id: born.uuid,
    work_request_sha256: "request" in intentWork ? intentWork.request.sha256 : "",
    purpose: "ログイン操作の意味を利用者へ明確に伝える。",
    expected_outcomes: ["ログインボタンの意味を迷わず理解できる。"],
    in_scope: ["ログイン画面のボタン表示"],
    out_of_scope: ["認証処理", "ログイン画面の構成"],
    success_signals: ["ボタン表示が『ログイン』になり、既存の認証動作が変わらない。"],
    unknowns: [],
    reason: "変更範囲を表示文言だけに限定した。",
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T03:04:00.000Z" });
  const requirements = prepareRequirements(projectDir, {
    preparedAt: "2026-08-24T03:05:00.000Z",
  });
  completeRequirements(projectDir, {
    schema_version: 1,
    artifact: "requirements-definition-proposal",
    version: 1,
    proposal_id: "requirements-login-copy",
    intent_id: born.uuid,
    work_request_sha256: requirements.reference.sha256,
    functional_requirements: [{
      id: "REQ-F-001",
      statement: "ログイン画面のボタン表示を『送信』から『ログイン』へ変更する。",
      source_refs: [
        { artifact: "intent-definition", pointer: "/expected_outcomes/0" },
        { artifact: "intent-definition", pointer: "/success_signals/0" },
      ],
    }],
    quality_requirements: [],
    constraints: [],
    invariants: [{
      id: "INV-001",
      statement: "既存の認証処理と画面構成を変更しない。",
      source_refs: [{ artifact: "intent-definition", pointer: "/out_of_scope/0" }],
    }],
    open_questions: [],
    reason: "表示要求と既存動作の不変条件へ具体化した。",
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T03:06:00.000Z" });
  return { projectDir, born };
}

function notApplicableProposal(projectDir: string): ArchitectureAssessmentProposal {
  const prepared = prepareArchitecture(projectDir, {
    preparedAt: "2026-08-24T03:07:00.000Z",
  });
  return {
    schema_version: 1,
    artifact: "architecture-assessment-proposal",
    version: 1,
    proposal_id: "architecture-login-copy-no-impact",
    intent_id: prepared.request.intent_id,
    work_request_sha256: prepared.reference.sha256,
    disposition: "not_applicable",
    requirement_assessments: prepared.request.requirement_ids.map((requirementId) => ({
      requirement_id: requirementId,
      architecture_impact: false,
      reason: "既存Component内の表示文言だけを変更し、境界や依存関係を変えない。",
      current_entity_refs: ["login-view"],
    })),
    decisions: [],
    reuse_ref: null,
    approval_ref: null,
    evidence: [
      prepared.request.requirements_ref,
      prepared.request.system_map_ref,
    ],
    reason: "全要件が既存構成の内部変更だけで満たせる。",
    proposed_by: "ai",
  };
}

function executeProposal(projectDir: string): ArchitectureAssessmentProposal {
  const prepared = prepareArchitecture(projectDir, {
    preparedAt: "2026-08-24T03:07:00.000Z",
  });
  return {
    schema_version: 1,
    artifact: "architecture-assessment-proposal",
    version: 1,
    proposal_id: "architecture-login-copy-execute",
    intent_id: prepared.request.intent_id,
    work_request_sha256: prepared.reference.sha256,
    disposition: "execute",
    requirement_assessments: prepared.request.requirement_ids.map((requirementId) => ({
      requirement_id: requirementId,
      architecture_impact: true,
      reason: "表示設定を共有UI Componentへ集約する構成判断が必要。",
      current_entity_refs: ["login-view"],
    })),
    decisions: [{
      decision_id: "ADR-001",
      title: "ログイン表示設定を既存UI Componentへ集約する",
      context: "表示設定の重複を避けながら既存認証境界を維持する必要がある。",
      decision: "既存Login View内の表示設定を単一の定数へ集約する。",
      rationale: "新しいServiceやAPIを増やさず、変更範囲を既存Component内に限定できる。",
      requirement_ids: prepared.request.requirement_ids,
      current_entity_refs: ["login-view"],
      planned_changes: [{
        change_id: "CHG-001",
        action: "modify",
        target_kind: "component",
        target_id: "login-view",
        description: "表示設定を単一の定数へ集約する。",
      }],
      alternatives: ["画面へ文字列を直接埋め込む。"],
      consequences: ["表示設定の変更箇所が一つになる。"],
      reversibility: "easy",
    }],
    reuse_ref: null,
    approval_ref: null,
    evidence: [],
    reason: "既存Component内部の構成を明示的に決定する。",
    proposed_by: "ai",
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("ST-04 Contract defines Architecture Decision without owning a route", () => {
  const contract = loadArchitectureStageContract();
  assert.equal(contract.stage_id, "ST-04");
  assert.equal(contract.name, "Architecture Decision");
  assert.deepEqual(contract.outputs, ["architecture-current", "architecture-decision"]);
  assert.equal(contract.inputs.some((input) => input.artifact === "requirements-definition"), true);
  assert.equal("next_stage" in contract, false);
});

test("Core prepares one idempotent ST-04 Work Request from pinned Stage artifacts", () => {
  const { projectDir, born } = fixture();
  const first = resolveVNextDirective(projectDir);
  assert.equal(first.kind, "work");
  assert.equal("stage" in first && first.stage, "ST-04");
  assert.equal("request" in first && first.request.artifact, "architecture-work-request");
  const prepared = prepareArchitecture(projectDir);
  assert.deepEqual(prepared.request.requirement_ids, ["REQ-F-001", "INV-001"]);
  assert.equal(prepared.request.requirements_ref.artifact, "requirements-definition");
  assert.equal(prepared.request.system_map_ref.artifact, "system-map");
  assert.equal(prepared.request.base_revision, null);
  assert.equal(existsSync(architectureWorkRequestPath(born.recordDir)), true);
  assert.deepEqual(resolveVNextDirective(projectDir), first);
});

test("Architecture Proposal rejects later-Stage fields, secrets, and an invalid disposition body", () => {
  const { projectDir } = fixture();
  const valid = notApplicableProposal(projectDir);
  assert.equal(parseArchitectureAssessmentProposal(valid).disposition, "not_applicable");
  assert.throws(
    () => parseArchitectureAssessmentProposal({ ...valid, next_stage: "ST-09" }),
    /unknown field\(s\): next_stage/,
  );
  assert.throws(
    () => parseArchitectureAssessmentProposal({ ...valid, api_token: "secret" }),
    /secret-bearing field.*api_token/,
  );
  assert.throws(
    () => parseArchitectureAssessmentProposal({ ...valid, decisions: executeProposal(projectDir).decisions }),
    /not_applicable.*decisions/i,
  );
});

test("not_applicable records a verified no-impact result and advances exactly to ST-05", () => {
  const { projectDir, born } = fixture();
  const result = completeArchitecture(projectDir, notApplicableProposal(projectDir), {
    completedAt: "2026-08-24T03:08:00.000Z",
  });
  assert.equal(result.current.disposition, "not_applicable");
  assert.equal(result.current.architecture_ref, null);
  assert.equal(result.decision, null);
  assert.equal(existsSync(architectureRevisionPath(born.recordDir, 1)), false);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-05");
  assert.equal(readVNextPlanAt(born.recordDir).stage_decisions[4]?.disposition, "not_applicable");
  assert.equal(readVNextPlanAt(born.recordDir).stage_decisions[4]?.decision_authority, "core");
  assert.equal(
    readOrderedAuditEntries(born.recordDir).some((entry) =>
      entry.event === "ROUTE_DECIDED" && entry.fields["Current Stage"] === "ST-05"
    ),
    true,
  );
});

test("Core rejects not_applicable when coverage, no-impact proof, or current entity evidence is invalid", () => {
  const missing = fixture();
  const missingProposal = notApplicableProposal(missing.projectDir);
  missingProposal.requirement_assessments.pop();
  assert.throws(
    () => completeArchitecture(missing.projectDir, missingProposal),
    /requirement coverage.*INV-001/i,
  );

  const impacted = fixture();
  const impactedProposal = notApplicableProposal(impacted.projectDir);
  impactedProposal.requirement_assessments[0]!.architecture_impact = true;
  assert.throws(
    () => completeArchitecture(impacted.projectDir, impactedProposal),
    /not_applicable.*architecture_impact/i,
  );

  const dangling = fixture();
  const danglingProposal = notApplicableProposal(dangling.projectDir);
  danglingProposal.requirement_assessments[0]!.current_entity_refs = ["missing-entity"];
  assert.throws(
    () => completeArchitecture(dangling.projectDir, danglingProposal),
    /current entity.*missing-entity/i,
  );
});

test("execute writes one immutable Architecture Decision revision and pins it in current", () => {
  const { projectDir, born } = fixture();
  const result = completeArchitecture(projectDir, executeProposal(projectDir), {
    completedAt: "2026-08-24T03:08:00.000Z",
  });
  assert.equal(result.current.disposition, "execute");
  assert.equal(result.decision?.revision, 1);
  assert.equal(result.decision?.base_revision, null);
  assert.equal(result.current.architecture_ref?.artifact, "architecture-decision");
  assert.equal(existsSync(architectureRevisionPath(born.recordDir, 1)), true);
  assert.equal(
    parseArchitectureDecision(JSON.parse(readFileSync(architectureRevisionPath(born.recordDir, 1), "utf8"))).decisions[0]?.decision_id,
    "ADR-001",
  );
  assert.equal(existsSync(join(born.recordDir, "artifacts", "architecture.html")), false);
  assert.equal(result.state.current_stage, "ST-05");
});

test("ST-04 Policy Gate binds the exact Architecture Proposal and rejects missing acknowledgements", () => {
  const { projectDir } = fixture({
    policyRule: {
      rule_id: "project-high-risk-architecture",
      minimum_severity: "high",
      stage_ids: ["ST-04"],
      acknowledgement: "Architecture判断と残存リスクを確認する",
    },
    risks: [{
      risk_id: "login-lockout",
      severity: "high",
      statement: "設計ミスでログインできなくなる可能性がある",
      evidence_refs: [],
    }],
  });
  const proposal = notApplicableProposal(projectDir);
  assert.throws(
    () => completeArchitecture(projectDir, proposal),
    /Policy approval is required.*policy-review/i,
  );
  const review = reviewArchitecturePolicy(projectDir, proposal, {
    reviewedAt: "2026-08-24T03:07:30.000Z",
  });
  assert.equal(review.gate.requirements.length, 1);
  assert.equal(existsSync(architecturePolicyReviewPath(review.recordDir)), true);
  assert.throws(
    () => approveArchitecturePolicy(projectDir, {
      proposalSha256: review.proposalReference.sha256,
      reason: "リスクを確認した。",
      policyAcknowledgements: [],
    }),
    /missing acknowledgement/i,
  );
  const result = approveArchitecturePolicy(projectDir, {
    proposalSha256: review.proposalReference.sha256,
    reason: "リスクを確認した。",
    policyAcknowledgements: [{
      requirement_id: "project-high-risk-architecture:login-lockout",
      acknowledged: true,
      reason: "表示文言だけの変更で、認証処理は変えない。",
    }],
    decidedAt: "2026-08-24T03:08:00.000Z",
  });
  assert.equal(result.state.current_stage, "ST-05");
  assert.equal(
    result.current.evidence.some((reference) =>
      reference.artifact === "architecture-policy-approval"
    ),
    true,
  );
  assert.equal(resumeVNextIntent(projectDir).state.current_stage, "ST-05");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("reuse requires a human approval bound to the current Requirements and writes no new revision", () => {
  const { projectDir, born } = fixture();
  const executed = completeArchitecture(projectDir, executeProposal(projectDir), {
    completedAt: "2026-08-24T03:08:00.000Z",
  });
  const plan = readVNextPlanAt(born.recordDir);
  const afterExecute = readVNextStateAt(born.recordDir);
  writeVNextStateAt(born.recordDir, {
    ...afterExecute,
    current_stage: "ST-04",
    status: "parked",
    parked_reason: "ST-04 Architecture Decision is ready for Core preparation.",
    updated_at: "2026-08-24T03:09:00.000Z",
  }, plan);
  const prepared = prepareArchitecture(projectDir, {
    preparedAt: "2026-08-24T03:10:00.000Z",
  });
  const approvalPath = join(born.recordDir, "artifacts", "human-decisions", "approve-architecture-reuse.json");
  const approval = {
    schema_version: 1,
    artifact: "human-decision",
    version: 1,
    decision_id: "approve-architecture-reuse",
    decision_kind: "approval",
    intent_id: born.uuid,
    approved_architecture_ref: executed.reference!,
    requirements_ref: prepared.request.requirements_ref,
    decision: "approve-reuse",
    reason: "既存の構成判断を同じ要件へ再利用してよい。",
    decided_by: "human",
    decided_at: "2026-08-24T03:10:00.000Z",
  };
  mkdirSync(dirname(approvalPath), { recursive: true });
  const approvalContent = `${JSON.stringify(approval, null, 2)}\n`;
  writeFileSync(approvalPath, approvalContent);
  const approvalRef = {
    artifact: "human-decision",
    version: 1,
    source_of_truth: relative(projectDir, approvalPath),
    sha256: sha256(approvalContent),
  };
  const proposal: ArchitectureAssessmentProposal = {
    ...notApplicableProposal(projectDir),
    proposal_id: "architecture-login-copy-reuse",
    work_request_sha256: prepared.reference.sha256,
    disposition: "reuse",
    requirement_assessments: prepared.request.requirement_ids.map((requirementId) => ({
      requirement_id: requirementId,
      architecture_impact: true,
      reason: "既存Architecture Decisionがこの要件を満たす。",
      current_entity_refs: ["login-view"],
    })),
    reuse_ref: executed.reference!,
    approval_ref: approvalRef,
    evidence: [executed.reference!, approvalRef],
    reason: "承認済みの既存Architecture Decisionを再利用する。",
  };
  const result = completeArchitecture(projectDir, proposal, {
    completedAt: "2026-08-24T03:11:00.000Z",
  });
  assert.equal(result.current.disposition, "reuse");
  assert.deepEqual(result.current.architecture_ref, executed.reference);
  assert.equal(result.decision, null);
  assert.equal(existsSync(architectureRevisionPath(born.recordDir, 2)), false);
  assert.equal(readVNextPlanAt(born.recordDir).stage_decisions[4]?.disposition, "reuse");
});

test("tampering with the Architecture Decision fails resume and Doctor closed", () => {
  const { projectDir, born } = fixture();
  completeArchitecture(projectDir, executeProposal(projectDir));
  const path = architectureRevisionPath(born.recordDir, 1);
  writeFileSync(path, `${readFileSync(path, "utf8")} `);
  assert.throws(() => resumeVNextIntent(projectDir), /Architecture.*canonical|sha256 mismatch/i);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
  assert.equal(existsSync(architectureCurrentPath(born.recordDir)), true);
});

test("completion resumes without duplicating Audit after artifacts and Plan were saved", () => {
  const { projectDir, born } = fixture();
  const proposal = notApplicableProposal(projectDir);
  const before = readVNextStateAt(born.recordDir);
  completeArchitecture(projectDir, proposal, {
    completedAt: "2026-08-24T03:08:00.000Z",
  });
  const revisedPlan = readVNextPlanAt(born.recordDir);
  const { parked_reason: _parkedReason, ...interrupted } = before;
  writeVNextStateAt(born.recordDir, {
    ...interrupted,
    plan_revision: revisedPlan.revision,
    status: "ready",
    updated_at: "2026-08-24T03:08:30.000Z",
  }, revisedPlan);

  const result = completeArchitecture(projectDir, proposal, {
    completedAt: "2026-08-24T03:09:00.000Z",
  });
  assert.equal(result.state.current_stage, "ST-05");
  assert.equal(result.current.updated_at, "2026-08-24T03:08:00.000Z");
  assert.equal(
    readOrderedAuditEntries(born.recordDir).filter((entry) =>
      entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-04"
    ).length,
    1,
  );
});
