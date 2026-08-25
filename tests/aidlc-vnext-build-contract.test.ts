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
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { readOrderedAuditEntries } from "../core/tools/aidlc-audit.ts";
import { executeBootstrap } from "../core/tools/aidlc-vnext-bootstrap.ts";
import { completeDefineIntent } from "../core/tools/aidlc-vnext-define-intent.ts";
import { completeOrient, prepareOrient } from "../core/tools/aidlc-vnext-orient.ts";
import { completeRequirements, prepareRequirements } from "../core/tools/aidlc-vnext-requirements.ts";
import { completeArchitecture, prepareArchitecture } from "../core/tools/aidlc-vnext-architecture.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
import { checkVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import { readVNextPlanAt, readVNextStateAt, resumeVNextIntent, writeVNextStateAt } from "../core/tools/aidlc-vnext-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";
import {
  approveBuildContract,
  buildContractApprovalPath,
  buildContractCandidatePath,
  buildContractCurrentPath,
  buildContractReviewPath,
  buildContractRevisionPath,
  buildContractWorkRequestPath,
  loadBuildContractStageContract,
  prepareBuildContract,
  reviewBuildContract,
} from "../core/tools/aidlc-vnext-build-contract.ts";
import {
  parseBuildContract,
  parseBuildContractApproval,
  parseBuildContractCandidate,
  parseBuildContractProposal,
  type BuildContractProposal,
} from "../core/tools/aidlc-vnext-build-contract-contract.ts";

const fixtures: string[] = [];

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-build-contract-"));
  fixtures.push(projectDir);
  mkdirSync(join(projectDir, "app", "src"), { recursive: true });
  writeFileSync(join(projectDir, "app", "src", "login.ts"), "export const buttonLabel = '送信';\n");
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "ログイン画面の『送信』を『ログイン』へ変える", "default", ["app"]);
  executeBootstrap(projectDir, { createdAt: "2026-08-24T04:00:00.000Z" });
  const orient = prepareOrient(projectDir, { observedAt: "2026-08-24T04:01:00.000Z" });
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
      proposal_id: "build-contract-fixture-map",
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
        observed_at: "2026-08-24T04:01:00.000Z",
      }],
      coverage_upserts: [{ coverage_id: "cov-login-copy", scope: "ログイン画面のボタン表示", status: "observed", evidence_refs: ["ev-login-copy"], observed_at: "2026-08-24T04:01:00.000Z" }],
      entity_upserts: [{ entity_id: "login-view", name: "Login View", entity_type: "component", capability: "user-interface", current_state: "observed", evidence_refs: ["ev-login-copy"] }],
      relation_upserts: [],
      remove_entity_ids: [],
      remove_relation_ids: [],
      reason: "依頼対象を観測した。",
      proposed_at: "2026-08-24T04:02:00.000Z",
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
  }, { completedAt: "2026-08-24T04:03:00.000Z" });
  const intentWork = resolveVNextDirective(projectDir);
  completeDefineIntent(projectDir, {
    schema_version: 1,
    artifact: "intent-definition-proposal",
    version: 1,
    proposal_id: "define-login-copy",
    intent_id: born.uuid,
    work_request_sha256: "request" in intentWork ? intentWork.request.sha256 : "",
    purpose: "ログイン操作の意味を明確にする。",
    expected_outcomes: ["ボタンの意味を迷わず理解できる。"],
    in_scope: ["ログイン画面のボタン表示"],
    out_of_scope: ["認証処理", "ログイン画面の構成"],
    success_signals: ["表示が『ログイン』になり、認証動作は変わらない。"],
    unknowns: [],
    reason: "範囲を表示文言だけに限定した。",
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T04:04:00.000Z" });
  const requirements = prepareRequirements(projectDir, { preparedAt: "2026-08-24T04:05:00.000Z" });
  completeRequirements(projectDir, {
    schema_version: 1,
    artifact: "requirements-definition-proposal",
    version: 1,
    proposal_id: "requirements-login-copy",
    intent_id: born.uuid,
    work_request_sha256: requirements.reference.sha256,
    functional_requirements: [{ id: "REQ-F-001", statement: "ボタン表示を『ログイン』へ変更する。", source_refs: [{ artifact: "intent-definition", pointer: "/expected_outcomes/0" }, { artifact: "intent-definition", pointer: "/success_signals/0" }] }],
    quality_requirements: [],
    constraints: [],
    invariants: [{ id: "INV-001", statement: "既存の認証処理を変更しない。", source_refs: [{ artifact: "intent-definition", pointer: "/out_of_scope/0" }] }],
    open_questions: [],
    reason: "表示要求と不変条件へ具体化した。",
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T04:06:00.000Z" });
  const architecture = prepareArchitecture(projectDir, { preparedAt: "2026-08-24T04:07:00.000Z" });
  completeArchitecture(projectDir, {
    schema_version: 1,
    artifact: "architecture-assessment-proposal",
    version: 1,
    proposal_id: "architecture-no-impact",
    intent_id: born.uuid,
    work_request_sha256: architecture.reference.sha256,
    disposition: "not_applicable",
    requirement_assessments: architecture.request.requirement_ids.map((requirementId) => ({ requirement_id: requirementId, architecture_impact: false, reason: "既存Component内の文言変更だけ。", current_entity_refs: ["login-view"] })),
    decisions: [],
    reuse_ref: null,
    approval_ref: null,
    evidence: [architecture.request.requirements_ref, architecture.request.system_map_ref],
    reason: "システム境界や依存関係は変えない。",
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T04:08:00.000Z" });
  return { projectDir, born, source };
}

function executeProposal(projectDir: string, reason = "小さな表示変更を一つのBoltで実装する。"): BuildContractProposal {
  const prepared = prepareBuildContract(projectDir, { preparedAt: "2026-08-24T04:09:00.000Z" });
  const sourceId = prepared.request.target_sources[0]!.source_id;
  return {
    schema_version: 1,
    artifact: "build-contract-proposal",
    version: 1,
    proposal_id: "build-login-copy",
    intent_id: prepared.request.intent_id,
    work_request_sha256: prepared.reference.sha256,
    disposition: "execute",
    requirement_assessments: prepared.request.requirement_ids.map((requirementId) => ({ requirement_id: requirementId, build_impact: true, reason: "実装と検証で保証する。" })),
    change_contracts: [{
      contract_id: "CHG-001",
      title: "ログインボタン表示変更",
      requirement_ids: prepared.request.requirement_ids,
      targets: [{ source_id: sourceId, path: "src/login.ts" }],
      depends_on_contract_ids: [],
      specification: ["buttonLabelを『ログイン』へ変更し、認証処理は触らない。"],
    }],
    acceptance_criteria: [{
      criterion_id: "AC-001",
      requirement_ids: prepared.request.requirement_ids,
      given: "既存のログイン画面がある。",
      when: "変更後の検証を行う。",
      then: "表示は『ログイン』で、既存認証テストは成功する。",
      verifier_ids: ["VER-001"],
    }],
    verifiers: [{
      verifier_id: "VER-001", kind: "command", source_id: sourceId, cwd: ".",
      argv: ["bun", "test"], timeout_ms: 10_000, expected_exit_codes: [0],
      artifact_check: null, runtime_check: null, expected: "終了コード0",
      human_exception_ref: null,
    }],
    bolts: [{ bolt_id: "BOLT-001", title: "表示文言を変更", objective: "一つのファイルで表示を安全に変更する。", contract_ids: ["CHG-001"], acceptance_criterion_ids: ["AC-001"], targets: [{ source_id: sourceId, path: "src/login.ts" }], depends_on: [] }],
    integration_contract: { acceptance_criterion_ids: ["AC-001"], verifier_ids: ["VER-001"], candidate_ready_when: ["全Verifierが成功し、変更対象がContract内に収まる。"] },
    reuse_ref: null,
    evidence: [],
    reason,
    proposed_by: "ai",
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("ST-05 Contract defines Build Contract without owning a route", () => {
  const contract = loadBuildContractStageContract();
  assert.equal(contract.stage_id, "ST-05");
  assert.equal(contract.name, "Build Contract");
  assert.deepEqual(contract.outputs, [
    "build-contract-candidate",
    "build-contract-review",
    "human-decision",
    "build-contract-current",
    "build-contract",
  ]);
  assert.equal("next_stage" in contract, false);
});

test("Core prepares one idempotent Work Request and AI proposal cannot claim approval", () => {
  const { projectDir, born } = fixture();
  const directive = resolveVNextDirective(projectDir);
  assert.equal(directive.kind, "work");
  assert.equal("stage" in directive && directive.stage, "ST-05");
  const first = prepareBuildContract(projectDir);
  assert.deepEqual(first.request.requirement_ids, ["REQ-F-001", "INV-001"]);
  assert.equal(first.request.target_sources.length, 1);
  assert.equal(existsSync(buildContractWorkRequestPath(born.recordDir)), true);
  assert.deepEqual(prepareBuildContract(projectDir), { ...first, execution: "reused" });
  const proposal = executeProposal(projectDir);
  assert.equal(parseBuildContractProposal(proposal).disposition, "execute");
  assert.throws(() => parseBuildContractProposal({ ...proposal, approved: true }), /unknown field\(s\): approved/);
  assert.throws(() => parseBuildContractProposal({ ...proposal, api_token: "secret" }), /secret-bearing field.*api_token/);
});

test("Core validates a one-Bolt small change, derives batches, escapes HTML, and returns approval Directive", () => {
  const { projectDir, born } = fixture();
  const reviewed = reviewBuildContract(projectDir, executeProposal(projectDir, "<script>alert('x')</script>を表示しない。"), { reviewedAt: "2026-08-24T04:10:00.000Z" });
  assert.deepEqual(reviewed.candidate.derived_batches, [["BOLT-001"]]);
  assert.equal(reviewed.state.status, "parked");
  const html = readFileSync(buildContractReviewPath(born.recordDir), "utf8");
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
  assert.equal(html.includes(reviewed.candidateReference.sha256), true);
  assert.match(html, /src\/login\.ts/);
  assert.match(html, /argv=.*bun.*test/);
  assert.match(html, /cwd=\./);
  assert.match(html, /timeout=10000ms/);
  const directive = resolveVNextDirective(projectDir);
  assert.equal(directive.kind, "approval");
  assert.equal("candidate" in directive && directive.candidate.sha256, reviewed.candidateReference.sha256);
  assert.deepEqual("decisions" in directive && directive.decisions, ["approve", "revise"]);
});

test("Core rejects Bolt cycles, repository escapes, and shell-string verifiers", () => {
  const cyclic = fixture();
  const cyclicProposal = executeProposal(cyclic.projectDir);
  cyclicProposal.bolts[0]!.depends_on = ["BOLT-001"];
  assert.throws(() => reviewBuildContract(cyclic.projectDir, cyclicProposal), /cannot depend on itself|cycle/i);

  const escaped = fixture();
  const escapedProposal = executeProposal(escaped.projectDir);
  escapedProposal.change_contracts[0]!.targets[0]!.path = "../outside.ts";
  assert.throws(() => reviewBuildContract(escaped.projectDir, escapedProposal), /stay inside.*repository|boundary/i);

  const shell = fixture();
  const shellProposal = executeProposal(shell.projectDir) as unknown as Record<string, unknown>;
  (shellProposal.verifiers as Array<Record<string, unknown>>)[0]!.argv = "bun test && deploy";
  assert.throws(() => reviewBuildContract(shell.projectDir, shellProposal), /argv.*array/i);
});

test("Core rejects traceability gaps, unbacked cross-Bolt dependencies, and parallel target conflicts", () => {
  const coverage = fixture();
  const missing = executeProposal(coverage.projectDir);
  missing.requirement_assessments.pop();
  assert.throws(() => reviewBuildContract(coverage.projectDir, missing), /requirement coverage.*INV-001/i);

  const dependency = fixture();
  const proposal = executeProposal(dependency.projectDir);
  const sourceId = proposal.bolts[0]!.targets[0]!.source_id;
  proposal.change_contracts.push({ contract_id: "CHG-002", title: "検証設定", requirement_ids: ["INV-001"], targets: [{ source_id: sourceId, path: "test/login.test.ts" }], depends_on_contract_ids: ["CHG-001"], specification: ["既存認証の不変条件を検証する。"] });
  proposal.acceptance_criteria.push({ criterion_id: "AC-002", requirement_ids: ["INV-001"], given: "既存認証テストがある。", when: "変更を検証する。", then: "既存認証テストが成功する。", verifier_ids: ["VER-001"] });
  proposal.bolts.push({ bolt_id: "BOLT-002", title: "不変条件を検証", objective: "既存認証を守る。", contract_ids: ["CHG-002"], acceptance_criterion_ids: ["AC-002"], targets: [{ source_id: sourceId, path: "test/login.test.ts" }], depends_on: [] });
  proposal.integration_contract!.acceptance_criterion_ids.push("AC-002");
  assert.throws(() => reviewBuildContract(dependency.projectDir, proposal), /not backed by the Bolt DAG/i);

  const conflict = fixture();
  const conflicting = executeProposal(conflict.projectDir);
  const conflictSource = conflicting.bolts[0]!.targets[0]!.source_id;
  conflicting.change_contracts.push({ contract_id: "CHG-002", title: "同一ファイルの別変更", requirement_ids: ["REQ-F-001"], targets: [{ source_id: conflictSource, path: "src/login.ts" }], depends_on_contract_ids: [], specification: ["同じ対象へ別の変更を加える。"] });
  conflicting.acceptance_criteria.push({ criterion_id: "AC-002", requirement_ids: ["REQ-F-001"], given: "ログイン画面がある。", when: "別変更を検証する。", then: "期待表示になる。", verifier_ids: ["VER-001"] });
  conflicting.bolts.push({ bolt_id: "BOLT-002", title: "別変更", objective: "同じファイルを変更する。", contract_ids: ["CHG-002"], acceptance_criterion_ids: ["AC-002"], targets: [{ source_id: conflictSource, path: "src/login.ts" }], depends_on: [] });
  conflicting.integration_contract!.acceptance_criterion_ids.push("AC-002");
  assert.throws(() => reviewBuildContract(conflict.projectDir, conflicting), /parallel Bolts.*conflicting target paths/i);
});

test("Human approval is bound to the exact Candidate SHA-256 and advances only to ST-06", () => {
  const { projectDir, born } = fixture();
  const reviewed = reviewBuildContract(projectDir, executeProposal(projectDir), { reviewedAt: "2026-08-24T04:10:00.000Z" });
  assert.throws(() => approveBuildContract(projectDir, { candidateSha256: `sha256:${"0".repeat(64)}`, reason: "承認する。" }), /SHA-256.*does not match/i);
  assert.equal(existsSync(buildContractApprovalPath(born.recordDir)), false);
  const approved = approveBuildContract(projectDir, { candidateSha256: reviewed.candidateReference.sha256, reason: "変更範囲と検証方法を確認した。", decidedAt: "2026-08-24T04:11:00.000Z" });
  assert.equal(approved.contract?.revision, 1);
  assert.equal(approved.state.current_stage, "ST-06");
  assert.equal(approved.current.disposition, "execute");
  assert.equal(existsSync(buildContractRevisionPath(born.recordDir, 1)), true);
  assert.equal(existsSync(buildContractCurrentPath(born.recordDir)), true);
  assert.equal(parseBuildContract(JSON.parse(readFileSync(buildContractRevisionPath(born.recordDir, 1), "utf8"))).derived_batches[0]?.[0], "BOLT-001");
  assert.equal(readVNextPlanAt(born.recordDir).stage_decisions[5]?.proposal_ref, "build-login-copy");
  assert.equal(resumeVNextIntent(projectDir).state.current_stage, "ST-06");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("not_applicable still waits for human approval and creates no Build Contract revision", () => {
  const { projectDir, born } = fixture();
  const prepared = prepareBuildContract(projectDir);
  const proposal: BuildContractProposal = {
    schema_version: 1,
    artifact: "build-contract-proposal",
    version: 1,
    proposal_id: "build-no-impact",
    intent_id: prepared.request.intent_id,
    work_request_sha256: prepared.reference.sha256,
    disposition: "not_applicable",
    requirement_assessments: prepared.request.requirement_ids.map((requirementId) => ({ requirement_id: requirementId, build_impact: false, reason: "実装変更を必要としない。" })),
    change_contracts: [], acceptance_criteria: [], verifiers: [], bolts: [], integration_contract: null, reuse_ref: null,
    evidence: [prepared.request.requirements_ref, prepared.request.architecture_current_ref],
    reason: "コードや設定の変更は不要。",
    proposed_by: "ai",
  };
  const reviewed = reviewBuildContract(projectDir, proposal);
  assert.equal(resolveVNextDirective(projectDir).kind, "approval");
  const approved = approveBuildContract(projectDir, { candidateSha256: reviewed.candidateReference.sha256, reason: "実装不要の根拠を確認した。" });
  assert.equal(approved.reference, null);
  assert.equal(approved.current.build_contract_ref, null);
  assert.equal(existsSync(buildContractRevisionPath(born.recordDir, 1)), false);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-06");
});

test("reuse pins an exact compatible approved Build Contract and writes no local revision", () => {
  const { projectDir, born } = fixture();
  const prepared = prepareBuildContract(projectDir);
  const execute = executeProposal(projectDir);
  const { artifact: _artifact, work_request_sha256: _requestSha, ...proposalContent } = execute;
  const reusableDir = join(projectDir, "approved-reuse");
  mkdirSync(reusableDir, { recursive: true });
  const reusableCandidate = parseBuildContractCandidate({
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
    derived_batches: [["BOLT-001"]],
    created_at: "2026-08-24T04:09:30.000Z",
  });
  const candidatePath = join(reusableDir, "candidate.json");
  const candidateContent = `${JSON.stringify(reusableCandidate, null, 2)}\n`;
  writeFileSync(candidatePath, candidateContent);
  const candidateRef = { artifact: "build-contract-candidate", version: 1, source_of_truth: relative(projectDir, candidatePath), sha256: sha256(candidateContent) };
  const oldApproval = parseBuildContractApproval({ schema_version: 1, artifact: "human-decision", version: 1, decision_id: "approve-reusable", decision_kind: "approval", intent_id: born.uuid, candidate_ref: candidateRef, decision: "approve-build-contract", reason: "既存契約を承認した。", decided_by: "human", decided_at: "2026-08-24T04:09:40.000Z" });
  const oldApprovalPath = join(reusableDir, "approval.json");
  const oldApprovalContent = `${JSON.stringify(oldApproval, null, 2)}\n`;
  writeFileSync(oldApprovalPath, oldApprovalContent);
  const oldApprovalRef = { artifact: "human-decision", version: 1, source_of_truth: relative(projectDir, oldApprovalPath), sha256: sha256(oldApprovalContent) };
  const { artifact: _candidateArtifact, reuse_ref: _reuse, ...candidateBody } = reusableCandidate;
  const reusable = parseBuildContract({ ...candidateBody, artifact: "build-contract", revision: 1, base_revision: null, candidate_ref: candidateRef, approval_ref: oldApprovalRef });
  const reusablePath = join(reusableDir, "build-contract.json");
  const reusableContent = `${JSON.stringify(reusable, null, 2)}\n`;
  writeFileSync(reusablePath, reusableContent);
  const reusableRef = { artifact: "build-contract", version: 1, source_of_truth: relative(projectDir, reusablePath), sha256: sha256(reusableContent) };
  const reuseProposal: BuildContractProposal = {
    schema_version: 1, artifact: "build-contract-proposal", version: 1,
    proposal_id: "reuse-login-build", intent_id: born.uuid,
    work_request_sha256: prepared.reference.sha256,
    disposition: "reuse",
    requirement_assessments: prepared.request.requirement_ids.map((requirementId) => ({ requirement_id: requirementId, build_impact: true, reason: "承認済み契約が同じ入力を満たす。" })),
    change_contracts: [], acceptance_criteria: [], verifiers: [], bolts: [], integration_contract: null,
    reuse_ref: reusableRef, evidence: [reusableRef], reason: "同一入力の承認済み契約を再利用する。", proposed_by: "ai",
  };
  const reviewed = reviewBuildContract(projectDir, reuseProposal);
  assert.deepEqual(reviewed.candidate.derived_batches, [["BOLT-001"]]);
  const approved = approveBuildContract(projectDir, { candidateSha256: reviewed.candidateReference.sha256, reason: "このIntentでも再利用してよい。" });
  assert.deepEqual(approved.reference, reusableRef);
  assert.equal(approved.contract, null);
  assert.equal(existsSync(buildContractRevisionPath(born.recordDir, 1)), false);
  assert.equal(approved.state.current_stage, "ST-06");
});

test("tampering with an approved Candidate fails resume and Doctor closed", () => {
  const { projectDir, born } = fixture();
  const reviewed = reviewBuildContract(projectDir, executeProposal(projectDir));
  approveBuildContract(projectDir, { candidateSha256: reviewed.candidateReference.sha256, reason: "承認する。" });
  writeFileSync(buildContractCandidatePath(born.recordDir), `${readFileSync(buildContractCandidatePath(born.recordDir), "utf8")} `);
  assert.throws(() => resumeVNextIntent(projectDir), /Candidate.*canonical|approval.*Candidate/i);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
});

test("tampering with pending review HTML fails Core and Doctor closed", () => {
  const { projectDir, born } = fixture();
  reviewBuildContract(projectDir, executeProposal(projectDir));
  writeFileSync(buildContractReviewPath(born.recordDir), `${readFileSync(buildContractReviewPath(born.recordDir), "utf8")}<!-- changed -->\n`);
  assert.throws(() => resolveVNextDirective(projectDir), /review HTML does not match/i);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
});

test("approval resumes idempotently after artifacts, Plan, and Audit were saved", () => {
  const { projectDir, born } = fixture();
  const reviewed = reviewBuildContract(projectDir, executeProposal(projectDir));
  const first = approveBuildContract(projectDir, { candidateSha256: reviewed.candidateReference.sha256, reason: "内容を確認して承認した。", decidedAt: "2026-08-24T04:11:00.000Z" });
  writeVNextStateAt(born.recordDir, {
    ...first.state,
    current_stage: "ST-05",
    status: "parked",
    parked_reason: "ST-05 approval persistence was interrupted before State advance.",
    updated_at: "2026-08-24T04:11:30.000Z",
  }, first.plan);
  const resumed = approveBuildContract(projectDir, { candidateSha256: reviewed.candidateReference.sha256, reason: "内容を確認して承認した。", decidedAt: "2026-08-24T04:12:00.000Z" });
  assert.equal(resumed.state.current_stage, "ST-06");
  assert.equal(resumed.current.updated_at, "2026-08-24T04:11:00.000Z");
  assert.equal(readOrderedAuditEntries(born.recordDir).filter((entry) => entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-05").length, 1);
});
