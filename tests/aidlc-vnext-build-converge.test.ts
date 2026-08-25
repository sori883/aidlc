import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { executeBootstrap } from "../core/tools/aidlc-vnext-bootstrap.ts";
import { completeDefineIntent } from "../core/tools/aidlc-vnext-define-intent.ts";
import { completeOrient, prepareOrient } from "../core/tools/aidlc-vnext-orient.ts";
import { completeRequirements, prepareRequirements } from "../core/tools/aidlc-vnext-requirements.ts";
import { completeArchitecture, prepareArchitecture } from "../core/tools/aidlc-vnext-architecture.ts";
import {
  approveBuildContract,
  prepareBuildContract,
  reviewBuildContract,
} from "../core/tools/aidlc-vnext-build-contract.ts";
import type { BuildContractProposal } from "../core/tools/aidlc-vnext-build-contract-contract.ts";
import { parseBuildVerifier } from "../core/tools/aidlc-vnext-build-contract-contract.ts";
import {
  buildAttemptCheckpointPath,
  buildCurrentPath,
  buildRunnableCandidatePath,
  buildSessionPath,
  loadBuildConvergeStageContract,
  prepareBuildConverge,
  reuseRunnableCandidate,
  selectReadyBolt,
  verifyBuildAttempt,
} from "../core/tools/aidlc-vnext-build-converge.ts";
import {
  parseBoltWorkRequest,
  parseBuildAttemptCheckpoint,
  parseBuildCurrent,
  parseRunnableCandidate,
} from "../core/tools/aidlc-vnext-build-converge-contract.ts";
import { checkVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
import {
  acceptedCandidatePath,
  approveCandidateReview,
  prepareCandidateReview,
  reviewCurrentPath,
  reviewHtmlPath,
  submitCandidateFeedback,
} from "../core/tools/aidlc-vnext-review.ts";
import {
  parseAcceptedCandidate,
  parseReviewCurrent,
} from "../core/tools/aidlc-vnext-review-contract.ts";
import {
  authorizeRelease,
  deploymentMapBaselinePath,
  executeRelease,
  prepareRelease,
  releaseCurrentPath,
  releaseHtmlPath,
  reuseRelease,
  reviewReleasePlan,
} from "../core/tools/aidlc-vnext-release.ts";
import {
  parseDeploymentMapBaseline,
  parseReleaseCurrent,
  type ReleasePlanProposal,
  type ReleaseWorkRequest,
} from "../core/tools/aidlc-vnext-release-contract.ts";
import {
  decideOutcome,
  evaluateOutcome,
  followUpBriefPath,
  outcomeCurrentPath,
  outcomeEvaluationPath,
  outcomeHtmlPath,
  prepareOutcomeEvaluation,
} from "../core/tools/aidlc-vnext-outcome.ts";
import { readVNextPlanAt, readVNextStateAt, resumeVNextIntent, writeVNextStateAt } from "../core/tools/aidlc-vnext-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

const fixtures: string[] = [];

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function fixture(disposition: "execute" | "not_applicable" = "execute", repositoryCount: 1 | 2 = 1, humanReview = false) {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-build-converge-"));
  fixtures.push(projectDir, `${projectDir}.aidlc-worktrees`);
  const sourceDir = join(projectDir, "app");
  mkdirSync(join(sourceDir, "src"), { recursive: true });
  writeFileSync(join(sourceDir, "src/login.ts"), "export const buttonLabel = '送信';\n");
  writeFileSync(
    join(sourceDir, "verify.ts"),
    "import { readFileSync } from 'node:fs';\nconst value = readFileSync('src/login.ts', 'utf8');\nif (!value.includes(`buttonLabel = 'ログイン'`)) { console.error('LOGIN_LABEL_MISMATCH'); process.exit(7); }\n",
  );
  git(sourceDir, "init", "-q");
  git(sourceDir, "config", "user.name", "Fixture");
  git(sourceDir, "config", "user.email", "fixture@example.test");
  git(sourceDir, "add", ".");
  git(sourceDir, "commit", "-qm", "accepted baseline");
  const serviceDir = join(projectDir, "service");
  if (repositoryCount === 2) {
    mkdirSync(join(serviceDir, "src"), { recursive: true });
    writeFileSync(join(serviceDir, "src/feature.ts"), "export const featureEnabled = false;\n");
    writeFileSync(serviceDir + "/verify.ts", "import { readFileSync } from 'node:fs';\nconst value = readFileSync('src/feature.ts', 'utf8');\nif (!value.includes('featureEnabled = true')) { console.error('FEATURE_NOT_ENABLED'); process.exit(8); }\n");
    git(serviceDir, "init", "-q");
    git(serviceDir, "config", "user.name", "Fixture");
    git(serviceDir, "config", "user.email", "fixture@example.test");
    git(serviceDir, "add", ".");
    git(serviceDir, "commit", "-qm", "accepted service baseline");
  }

  initializeWorkspace(projectDir);
  const born = birthIntentWithState(projectDir, "ログイン表示を変更する", "default", repositoryCount === 2 ? ["app", "service"] : ["app"]);
  executeBootstrap(projectDir, { createdAt: "2026-08-24T11:00:00.000Z" });
  const orient = prepareOrient(projectDir, { observedAt: "2026-08-24T11:01:00.000Z" });
  const source = orient.profile.repository_snapshots.find((entry) => entry.locator === "app")!;
  const serviceSource = orient.profile.repository_snapshots.find((entry) => entry.locator === "service");
  assert.equal(source.source_type, "git");
  if (repositoryCount === 2) assert.equal(serviceSource?.source_type, "git");
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
      proposal_id: "st06-map",
      map_id: "default-system",
      base_revision: null,
      perspective: "accepted-code-baseline",
      source_snapshots: orient.profile.repository_snapshots,
      evidence: [{
        evidence_id: "ev-login",
        source_id: source.source_id,
        evidence_type: "file",
        locator: "src/login.ts",
        sha256: sha256(readFileSync(join(sourceDir, "src/login.ts"), "utf8")),
        observed_at: "2026-08-24T11:01:00.000Z",
      }, ...(repositoryCount === 2 ? [{ evidence_id: "ev-service", source_id: serviceSource!.source_id, evidence_type: "file" as const, locator: "src/feature.ts", sha256: sha256(readFileSync(join(serviceDir, "src/feature.ts"), "utf8")), observed_at: "2026-08-24T11:01:00.000Z" }] : [])],
      coverage_upserts: [{ coverage_id: "cov-login", scope: "ログイン表示", status: "observed", evidence_refs: ["ev-login"], observed_at: "2026-08-24T11:01:00.000Z" }, ...(repositoryCount === 2 ? [{ coverage_id: "cov-service", scope: "関連サービス", status: "observed" as const, evidence_refs: ["ev-service"], observed_at: "2026-08-24T11:01:00.000Z" }] : [])],
      entity_upserts: [{ entity_id: "login-view", name: "Login View", entity_type: "component", capability: "user-interface", current_state: "observed", evidence_refs: ["ev-login"] }, ...(repositoryCount === 2 ? [{ entity_id: "feature-service", name: "Feature Service", entity_type: "component" as const, capability: "api" as const, current_state: "observed" as const, evidence_refs: ["ev-service"] }] : [])],
      relation_upserts: [],
      remove_entity_ids: [],
      remove_relation_ids: [],
      reason: "対象を観測した。",
      proposed_at: "2026-08-24T11:02:00.000Z",
      proposed_by: "ai",
    },
    current_context: { entity_ids: ["login-view"], relation_ids: [], additional_findings: ["現在は送信。"], out_of_scope: ["認証処理"], intent_only_notes: [], unknowns: [] },
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T11:03:00.000Z" });
  const intentWork = resolveVNextDirective(projectDir);
  completeDefineIntent(projectDir, {
    schema_version: 1,
    artifact: "intent-definition-proposal",
    version: 1,
    proposal_id: "st06-intent",
    intent_id: born.uuid,
    work_request_sha256: "request" in intentWork ? intentWork.request.sha256 : "",
    purpose: "表示を明確にする。",
    expected_outcomes: ["ログインと表示される。"],
    in_scope: ["ボタン表示"],
    out_of_scope: ["認証処理"],
    success_signals: ["表示変更後も検証が通る。"],
    unknowns: [],
    reason: "表示だけに限定する。",
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T11:04:00.000Z" });
  const requirements = prepareRequirements(projectDir, { preparedAt: "2026-08-24T11:05:00.000Z" });
  completeRequirements(projectDir, {
    schema_version: 1,
    artifact: "requirements-definition-proposal",
    version: 1,
    proposal_id: "st06-requirements",
    intent_id: born.uuid,
    work_request_sha256: requirements.reference.sha256,
    functional_requirements: [{ id: "REQ-F-001", statement: "表示をログインへ変更する。", source_refs: [{ artifact: "intent-definition", pointer: "/expected_outcomes/0" }, { artifact: "intent-definition", pointer: "/success_signals/0" }] }],
    quality_requirements: [],
    constraints: [],
    invariants: [{ id: "INV-001", statement: "認証処理を変えない。", source_refs: [{ artifact: "intent-definition", pointer: "/out_of_scope/0" }] }],
    open_questions: [],
    reason: "表示要求を固定する。",
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T11:06:00.000Z" });
  const architecture = prepareArchitecture(projectDir, { preparedAt: "2026-08-24T11:07:00.000Z" });
  completeArchitecture(projectDir, {
    schema_version: 1,
    artifact: "architecture-assessment-proposal",
    version: 1,
    proposal_id: "st06-architecture",
    intent_id: born.uuid,
    work_request_sha256: architecture.reference.sha256,
    disposition: "not_applicable",
    requirement_assessments: architecture.request.requirement_ids.map((requirementId) => ({ requirement_id: requirementId, architecture_impact: false, reason: "構成を変えない。", current_entity_refs: ["login-view"] })),
    decisions: [], reuse_ref: null, approval_ref: null,
    evidence: [architecture.request.requirements_ref, architecture.request.system_map_ref],
    reason: "構成変更なし。", proposed_by: "ai",
  }, { completedAt: "2026-08-24T11:08:00.000Z" });
  const prepared = prepareBuildContract(projectDir, { preparedAt: "2026-08-24T11:09:00.000Z" });
  const sourceId = prepared.request.target_sources.find((entry) => entry.locator === "app")!.source_id;
  const serviceSourceId = prepared.request.target_sources.find((entry) => entry.locator === "service")?.source_id;
  const assessments = prepared.request.requirement_ids.map((requirementId) => ({
    requirement_id: requirementId,
    build_impact: disposition === "execute",
    reason: disposition === "execute" ? "実装で保証する。" : "製造対象がない。",
  }));
  const proposal: BuildContractProposal = disposition === "execute" ? {
    schema_version: 1, artifact: "build-contract-proposal", version: 1,
    proposal_id: "st06-build", intent_id: born.uuid, work_request_sha256: prepared.reference.sha256,
    disposition: "execute", requirement_assessments: assessments,
    change_contracts: [{ contract_id: "CHG-001", title: "表示変更", requirement_ids: prepared.request.requirement_ids, targets: [{ source_id: sourceId, path: "src/login.ts" }], depends_on_contract_ids: [], specification: ["buttonLabelをログインへ変える。"] }, ...(repositoryCount === 2 ? [{ contract_id: "CHG-002", title: "サービス変更", requirement_ids: prepared.request.requirement_ids, targets: [{ source_id: serviceSourceId!, path: "src/feature.ts" }], depends_on_contract_ids: ["CHG-001"], specification: ["featureEnabledをtrueへ変える。"] }] : [])],
    acceptance_criteria: [{ criterion_id: "AC-001", requirement_ids: prepared.request.requirement_ids, given: "現在は送信。", when: "検証する。", then: "ログインと表示される。", verifier_ids: ["VER-001", ...(humanReview ? ["VER-099"] : [])] }, ...(repositoryCount === 2 ? [{ criterion_id: "AC-002", requirement_ids: prepared.request.requirement_ids, given: "機能が無効。", when: "サービスを検証する。", then: "機能が有効になる。", verifier_ids: ["VER-002"] }] : [])],
    verifiers: [{
      verifier_id: "VER-001", kind: "command", source_id: sourceId, cwd: ".",
      argv: [process.execPath, "verify.ts"], timeout_ms: 10_000,
      expected_exit_codes: [0], artifact_check: null, runtime_check: null,
      expected: "終了コード0", human_exception_ref: null,
    }, ...(humanReview ? [{ verifier_id: "VER-099", kind: "human-at-st07" as const, source_id: null, cwd: null, argv: null, timeout_ms: 0, expected_exit_codes: [], artifact_check: null, runtime_check: null, expected: "表示が自然である。", human_exception_ref: null }] : []), ...(repositoryCount === 2 ? [{ verifier_id: "VER-002", kind: "command" as const, source_id: serviceSourceId!, cwd: ".", argv: [process.execPath, "verify.ts"], timeout_ms: 10_000, expected_exit_codes: [0], artifact_check: null, runtime_check: null, expected: "終了コード0", human_exception_ref: null }] : [])],
    bolts: [{ bolt_id: "BOLT-001", title: "表示を変更", objective: "表示をログインへ変える。", contract_ids: ["CHG-001"], acceptance_criterion_ids: ["AC-001"], targets: [{ source_id: sourceId, path: "src/login.ts" }], depends_on: [] }, ...(repositoryCount === 2 ? [{ bolt_id: "BOLT-002", title: "サービスを変更", objective: "関連サービスを有効にする。", contract_ids: ["CHG-002"], acceptance_criterion_ids: ["AC-002"], targets: [{ source_id: serviceSourceId!, path: "src/feature.ts" }], depends_on: ["BOLT-001"] }] : [])],
    integration_contract: { acceptance_criterion_ids: repositoryCount === 2 ? ["AC-001", "AC-002"] : ["AC-001"], verifier_ids: repositoryCount === 2 ? ["VER-001", "VER-002"] : ["VER-001"], candidate_ready_when: ["全Boltと検証が成功する。"] },
    reuse_ref: null, evidence: [], reason: "一つのBoltで実装する。", proposed_by: "ai",
  } : {
    schema_version: 1, artifact: "build-contract-proposal", version: 1,
    proposal_id: "st06-no-build", intent_id: born.uuid, work_request_sha256: prepared.reference.sha256,
    disposition: "not_applicable", requirement_assessments: assessments,
    change_contracts: [], acceptance_criteria: [], verifiers: [], bolts: [], integration_contract: null,
    reuse_ref: null, evidence: [prepared.request.requirements_ref, prepared.request.architecture_current_ref],
    reason: "製造対象なし。", proposed_by: "ai",
  };
  const reviewed = reviewBuildContract(projectDir, proposal, { reviewedAt: "2026-08-24T11:10:00.000Z" });
  approveBuildContract(projectDir, { candidateSha256: reviewed.candidateReference.sha256, reason: "内容を承認する。", decidedAt: "2026-08-24T11:11:00.000Z" });
  return { projectDir, sourceDir, serviceDir, born, sourceId, serviceSourceId };
}

function attachBareOrigin(projectDir: string, repositoryDir: string, name: string) {
  const bareDir = join(projectDir, "release-remotes", `${name}.git`);
  mkdirSync(join(projectDir, "release-remotes"), { recursive: true });
  git(projectDir, "init", "--bare", "-q", bareDir);
  git(repositoryDir, "remote", "add", "origin", bareDir);
  const targetRef = git(repositoryDir, "symbolic-ref", "HEAD");
  git(repositoryDir, "push", "-q", "origin", `HEAD:${targetRef}`);
  return { bareDir, targetRef, initialRevision: git(repositoryDir, "rev-parse", "HEAD") };
}

async function acceptedReleaseFixture(repositoryCount: 1 | 2 = 1) {
  const built = fixture("execute", repositoryCount);
  const appRemote = attachBareOrigin(built.projectDir, built.sourceDir, "app-origin");
  const serviceRemote = repositoryCount === 2
    ? attachBareOrigin(built.projectDir, built.serviceDir, "service-origin")
    : null;
  const first = prepareBuildConverge(built.projectDir);
  writeFileSync(join(first.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  const next = await verifyBuildAttempt(built.projectDir, { boltId: "BOLT-001", verifiedAt: "2026-08-25T01:00:00.000Z" });
  if (repositoryCount === 2) {
    assert.equal(next.outcome, "next_bolt");
    writeFileSync(join(next.request!.source_workspaces[0]!.worktree_path, "src/feature.ts"), "export const featureEnabled = true;\n");
    const finished = await verifyBuildAttempt(built.projectDir, { boltId: "BOLT-002", verifiedAt: "2026-08-25T01:01:00.000Z" });
    assert.equal(finished.outcome, "candidate");
  } else {
    assert.equal(next.outcome, "candidate");
  }
  const review = prepareCandidateReview(built.projectDir, { preparedAt: "2026-08-25T01:02:00.000Z" });
  const approved = approveCandidateReview(built.projectDir, {
    manifestSha256: review.pending!.manifestReference.sha256,
    reason: "完成候補をRelease対象として承認する。",
    decidedAt: "2026-08-25T01:03:00.000Z",
  });
  assert.equal(approved.state.current_stage, "ST-08");
  return { ...built, appRemote, serviceRemote, accepted: approved.acceptedCandidate };
}

function releaseProposal(request: ReleaseWorkRequest): ReleasePlanProposal {
  const sourceTargets = [...request.source_targets].sort((left, right) => left.repository_id.localeCompare(right.repository_id));
  return {
    schema_version: 1,
    artifact: "release-plan-proposal",
    version: 1,
    proposal_id: "release-source-promotions",
    intent_id: request.intent_id,
    work_request_sha256: "",
    disposition: "execute",
    targets: sourceTargets.map((target, index) => ({
      target_id: `TARGET-${String(index + 1).padStart(3, "0")}`,
      target_kind: "source",
      provider: "git",
      capability_id: "git-remote-source-promote",
      repository_id: target.repository_id,
      locator: `origin#${target.current_branch_ref}`,
      environment: null,
    })),
    steps: sourceTargets.map((target, index) => ({
      step_id: `STEP-${String(index + 1).padStart(3, "0")}`,
      target_id: `TARGET-${String(index + 1).padStart(3, "0")}`,
      operation: "source-promote",
      capability_id: "git-remote-source-promote",
      depends_on: index === 0 ? [] : [`STEP-${String(index).padStart(3, "0")}`],
      desired_state: target.candidate_revision,
      post_release_check: "target-matches-desired",
      rollback_mode: "automatic",
    })),
    release_notes: ["承認済み変更を正式なSourceへ昇格する。"],
    reason: "Accepted Candidateの全Repositoryを昇格する。",
    proposed_by: "ai",
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("ST-06 Stage Contract fixes Build & Converge inputs, outputs, and no next_stage", () => {
  const contract = loadBuildConvergeStageContract();
  assert.equal(contract.stage_id, "ST-06");
  assert.equal(contract.name, "Build & Converge");
  assert.deepEqual(contract.outputs, ["build-session", "bolt-work-request", "build-attempt-checkpoint", "verifier-evidence", "runnable-candidate", "build-current"]);
  assert.equal("next_stage" in contract, false);
});

test("structured verifiers reject shell strings, remote runtime probes, and kind mismatches", () => {
  const command = {
    verifier_id: "VER-001", kind: "command", source_id: "repo-app", cwd: ".",
    argv: ["bun", "test"], timeout_ms: 10_000, expected_exit_codes: [0],
    artifact_check: null, runtime_check: null, expected: "終了コード0", human_exception_ref: null,
  };
  assert.equal(parseBuildVerifier(command).argv?.[0], "bun");
  assert.throws(() => parseBuildVerifier({ ...command, argv: "bun test && deploy" }), /argv.*array/i);
  assert.throws(() => parseBuildVerifier({
    ...command, kind: "runtime", argv: null, expected_exit_codes: [],
    runtime_check: { start_argv: ["bun", "server.ts"], host: "example.com", port: 3000, path: "/health", expected_status: 200, startup_timeout_ms: 5_000 },
  }), /host.*localhost|127\.0\.0\.1/i);
  assert.throws(() => parseBuildVerifier({ ...command, kind: "artifact", argv: null, expected_exit_codes: [], artifact_check: null, timeout_ms: 0 }), /artifact_check/i);
});

test("Core deterministically selects one dependency-ready Bolt even when a batch contains parallel work", () => {
  const bolts = [
    { bolt_id: "BOLT-001", title: "A", objective: "Aを作る。", contract_ids: ["CHG-001"], acceptance_criterion_ids: ["AC-001"], targets: [{ source_id: "repo-app", path: "a.ts" }], depends_on: [] },
    { bolt_id: "BOLT-002", title: "B", objective: "Bを作る。", contract_ids: ["CHG-002"], acceptance_criterion_ids: ["AC-002"], targets: [{ source_id: "repo-app", path: "b.ts" }], depends_on: [] },
    { bolt_id: "BOLT-003", title: "C", objective: "AとBの後にCを作る。", contract_ids: ["CHG-003"], acceptance_criterion_ids: ["AC-003"], targets: [{ source_id: "repo-app", path: "c.ts" }], depends_on: ["BOLT-001", "BOLT-002"] },
  ];
  const batches = [["BOLT-001", "BOLT-002"], ["BOLT-003"]];
  assert.equal(selectReadyBolt(bolts, batches, [])?.bolt_id, "BOLT-001");
  assert.equal(selectReadyBolt(bolts, batches, ["BOLT-001"])?.bolt_id, "BOLT-002");
  assert.equal(selectReadyBolt(bolts, batches, ["BOLT-001", "BOLT-002"])?.bolt_id, "BOLT-003");
  assert.equal(selectReadyBolt(bolts, batches, ["BOLT-001", "BOLT-002", "BOLT-003"]), null);
});

test("Core selects exactly one ready Bolt and prepares isolated Git worktrees", () => {
  const { projectDir, sourceDir } = fixture();
  const result = prepareBuildConverge(projectDir, { preparedAt: "2026-08-24T11:12:00.000Z" });
  assert.equal(result.execution, "prepared");
  assert.equal(result.request?.bolt.bolt_id, "BOLT-001");
  assert.equal(result.request?.attempt, 1);
  assert.equal(result.request?.source_workspaces.length, 1);
  assert.notEqual(result.request?.source_workspaces[0]?.worktree_path, sourceDir);
  assert.equal(existsSync(join(result.request!.source_workspaces[0]!.worktree_path, ".git")), true);
  assert.deepEqual(prepareBuildConverge(projectDir).request, result.request);
  const parsed = parseBoltWorkRequest(JSON.parse(readFileSync(result.reference!.source_of_truth.startsWith("/") ? result.reference!.source_of_truth : join(projectDir, result.reference!.source_of_truth), "utf8")));
  assert.equal(parsed.bolt.bolt_id, "BOLT-001");
  const directive = resolveVNextDirective(projectDir);
  assert.equal(directive.kind, "work");
  assert.equal("stage" in directive && directive.stage, "ST-06");
});

test("Core keeps the same Bolt on failure and stops after the same failure signature three times", async () => {
  const { projectDir, born } = fixture();
  const prepared = prepareBuildConverge(projectDir);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await verifyBuildAttempt(projectDir, { boltId: "BOLT-001", verifiedAt: `2026-08-24T11:${12 + attempt}:00.000Z` });
    const checkpoint = parseBuildAttemptCheckpoint(JSON.parse(readFileSync(buildAttemptCheckpointPath(born.recordDir, "BOLT-001", attempt), "utf8")));
    assert.equal(checkpoint.outcome, "failed");
    if (attempt < 3) {
      assert.equal(result.outcome, "retry");
      assert.equal(result.request?.bolt.bolt_id, prepared.request?.bolt.bolt_id);
      assert.equal(result.request?.attempt, attempt + 1);
    } else {
      assert.equal(result.outcome, "blocked");
      assert.equal(readVNextStateAt(born.recordDir).status, "parked");
      assert.match(readVNextStateAt(born.recordDir).parked_reason ?? "", /same failure signature.*3/i);
    }
  }
});

test("Core rejects out-of-contract changes before running verifiers", async () => {
  const { projectDir, born } = fixture();
  const prepared = prepareBuildConverge(projectDir);
  const worktree = prepared.request!.source_workspaces[0]!.worktree_path;
  writeFileSync(join(worktree, "unexpected.txt"), "outside contract\n");
  await assert.rejects(() => verifyBuildAttempt(projectDir, { boltId: "BOLT-001" }), /outside.*Build Contract|out-of-contract/i);
  assert.equal(readVNextStateAt(born.recordDir).status, "parked");
  assert.equal(existsSync(buildRunnableCandidatePath(born.recordDir)), false);
});

test("Core refuses execute when the accepted Git baseline is dirty or no longer a Git Repository", () => {
  const dirty = fixture();
  writeFileSync(join(dirty.sourceDir, "uncommitted.txt"), "human work\n");
  assert.throws(() => prepareBuildConverge(dirty.projectDir), /working tree is dirty/i);

  const nonGit = fixture();
  rmSync(join(nonGit.sourceDir, ".git"), { recursive: true, force: true });
  assert.throws(() => prepareBuildConverge(nonGit.projectDir), /not a Git Repository|cannot read HEAD/i);
});

test("Core creates a Runnable Candidate only after Bolt and integration verifiers pass", async () => {
  const { projectDir, sourceDir, born } = fixture();
  const prepared = prepareBuildConverge(projectDir);
  const worktree = prepared.request!.source_workspaces[0]!.worktree_path;
  writeFileSync(join(worktree, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  const result = await verifyBuildAttempt(projectDir, { boltId: "BOLT-001", verifiedAt: "2026-08-24T11:13:00.000Z" });
  assert.equal(result.outcome, "candidate");
  const candidate = parseRunnableCandidate(JSON.parse(readFileSync(buildRunnableCandidatePath(born.recordDir), "utf8")));
  assert.equal(candidate.source_results.length, 1);
  assert.notEqual(candidate.source_results[0]!.base_revision, candidate.source_results[0]!.candidate_revision);
  assert.match(git(sourceDir, "show", `${candidate.source_results[0]!.candidate_revision}:src/login.ts`), /ログイン/);
  assert.match(readFileSync(join(sourceDir, "src/login.ts"), "utf8"), /送信/);
  assert.equal(parseBuildCurrent(JSON.parse(readFileSync(buildCurrentPath(born.recordDir), "utf8"))).disposition, "execute");
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-07");
  assert.equal(readVNextPlanAt(born.recordDir).stage_decisions[6]?.disposition, "execute");
  assert.equal(resumeVNextIntent(projectDir).state.current_stage, "ST-07");
  const doctor = checkVNextDoctor(projectDir);
  assert.equal(doctor.healthy, true, JSON.stringify(doctor.findings));
});

test("Core integrates dependent Bolts across two Git Repositories before creating one Candidate", async () => {
  const { projectDir, serviceDir, born } = fixture("execute", 2);
  const first = prepareBuildConverge(projectDir);
  assert.equal(first.request?.bolt.bolt_id, "BOLT-001");
  writeFileSync(join(first.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  const next = await verifyBuildAttempt(projectDir, { boltId: "BOLT-001", verifiedAt: "2026-08-24T11:13:00.000Z" });
  assert.equal(next.outcome, "next_bolt", next.checkpoint.reason);
  assert.equal(next.request?.bolt.bolt_id, "BOLT-002");
  writeFileSync(join(next.request!.source_workspaces[0]!.worktree_path, "src/feature.ts"), "export const featureEnabled = true;\n");
  const finished = await verifyBuildAttempt(projectDir, { boltId: "BOLT-002", verifiedAt: "2026-08-24T11:14:00.000Z" });
  assert.equal(finished.outcome, "candidate");
  const candidate = parseRunnableCandidate(JSON.parse(readFileSync(buildRunnableCandidatePath(born.recordDir), "utf8")));
  assert.equal(candidate.source_results.length, 2);
  const serviceResult = candidate.source_results.find((entry) => entry.source_ids.includes(next.request!.source_workspaces[0]!.source_id));
  assert.match(git(serviceDir, "show", `${serviceResult!.candidate_revision}:src/feature.ts`), /true/);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-07");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("not_applicable deterministically completes ST-06 without Git work or a Runnable Candidate", () => {
  const { projectDir, born } = fixture("not_applicable");
  const result = prepareBuildConverge(projectDir, { preparedAt: "2026-08-24T11:12:00.000Z" });
  assert.equal(result.execution, "advanced");
  assert.equal(result.request, null);
  assert.equal(existsSync(buildRunnableCandidatePath(born.recordDir)), false);
  assert.equal(parseBuildCurrent(JSON.parse(readFileSync(buildCurrentPath(born.recordDir), "utf8"))).disposition, "not_applicable");
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-07");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("Core reuses only a Candidate pinned to the same Intent, Build Contract, source revisions, and passed Evidence", async () => {
  const { projectDir, born } = fixture();
  const prepared = prepareBuildConverge(projectDir);
  writeFileSync(join(prepared.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  await verifyBuildAttempt(projectDir, { boltId: "BOLT-001", verifiedAt: "2026-08-24T11:13:00.000Z" });
  const reusableDir = join(projectDir, "approved-candidates");
  mkdirSync(reusableDir, { recursive: true });
  const reusablePath = join(reusableDir, "runnable-candidate.json");
  writeFileSync(reusablePath, readFileSync(buildRunnableCandidatePath(born.recordDir), "utf8"));
  rmSync(buildCurrentPath(born.recordDir));
  rmSync(buildRunnableCandidatePath(born.recordDir));
  rmSync(buildSessionPath(born.recordDir));
  const state = readVNextStateAt(born.recordDir);
  const plan = readVNextPlanAt(born.recordDir);
  writeVNextStateAt(born.recordDir, {
    ...state,
    current_stage: "ST-06",
    status: "parked",
    parked_reason: "A compatible Candidate may be reused after feedback invalidation checks.",
    updated_at: "2026-08-24T11:14:00.000Z",
  }, plan);
  const reused = reuseRunnableCandidate(projectDir, { candidatePath: reusablePath, reason: "同じ契約と基点の合格済み候補を再利用する。", reusedAt: "2026-08-24T11:15:00.000Z" });
  assert.equal(reused.current.disposition, "reuse");
  assert.equal(reused.state.current_stage, "ST-07");
  assert.equal(readVNextPlanAt(born.recordDir).stage_decisions[6]?.disposition, "reuse");
  assert.equal(resumeVNextIntent(projectDir).state.current_stage, "ST-07");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("tampering with a Runnable Candidate fails resume and Doctor closed", async () => {
  const { projectDir, born } = fixture();
  const prepared = prepareBuildConverge(projectDir);
  writeFileSync(join(prepared.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  await verifyBuildAttempt(projectDir, { boltId: "BOLT-001" });
  writeFileSync(buildRunnableCandidatePath(born.recordDir), `${readFileSync(buildRunnableCandidatePath(born.recordDir), "utf8")} `);
  assert.throws(() => resumeVNextIntent(projectDir), /ST-06|Runnable Candidate|canonical/i);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
});

test("ST-07 prepares a pinned human Review, promotes approval, and advances only to ST-08", async () => {
  const { projectDir, born } = fixture();
  const build = prepareBuildConverge(projectDir);
  writeFileSync(join(build.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  const initialCandidate = await verifyBuildAttempt(projectDir, { boltId: "BOLT-001", verifiedAt: "2026-08-24T12:00:00.000Z" });
  assert.equal(initialCandidate.outcome, "candidate");
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-07");

  const prepared = prepareCandidateReview(projectDir, { preparedAt: "2026-08-24T12:01:00.000Z" });
  assert.equal(prepared.execution, "prepared");
  assert.equal(prepared.pending?.manifest.stage_id, "ST-07");
  assert.equal(existsSync(reviewHtmlPath(born.recordDir)), true);
  assert.match(readFileSync(reviewHtmlPath(born.recordDir), "utf8"), /完成候補の確認/);
  assert.equal(prepareCandidateReview(projectDir).execution, "reused");
  const directive = resolveVNextDirective(projectDir);
  assert.equal(directive.kind, "approval");
  assert.equal("stage" in directive && directive.stage, "ST-07");
  assert.deepEqual("feedback_reasons" in directive ? directive.feedback_reasons : undefined, ["requirements_changed", "architecture_impact", "build_contract_impact", "candidate_defect"]);

  const approved = approveCandidateReview(projectDir, {
    manifestSha256: prepared.pending!.manifestReference.sha256,
    reason: "完成候補が要求どおりなので承認する。",
    decidedAt: "2026-08-24T12:02:00.000Z",
  });
  assert.equal(approved.state.current_stage, "ST-08");
  assert.equal(approved.acceptedCandidate.source_results[0]?.candidate_revision, prepared.pending?.manifest.source_results[0]?.candidate_revision);
  assert.equal(parseAcceptedCandidate(JSON.parse(readFileSync(acceptedCandidatePath(born.recordDir), "utf8"))).approval_ref.sha256, approved.decisionReference.sha256);
  assert.equal(parseReviewCurrent(JSON.parse(readFileSync(reviewCurrentPath(born.recordDir), "utf8"))).outcome, "approved");
  const approvalDoctor = checkVNextDoctor(projectDir);
  assert.equal(approvalDoctor.healthy, true, JSON.stringify(approvalDoctor.findings));
});

test("ST-07 feedback chooses the earliest fixed Stage and preserves the rejected Candidate snapshot", async () => {
  const { projectDir, born } = fixture();
  const build = prepareBuildConverge(projectDir);
  writeFileSync(join(build.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  await verifyBuildAttempt(projectDir, { boltId: "BOLT-001", verifiedAt: "2026-08-24T12:00:00.000Z" });
  const prepared = prepareCandidateReview(projectDir, { preparedAt: "2026-08-24T12:01:00.000Z" });

  const result = submitCandidateFeedback(projectDir, {
    manifestSha256: prepared.pending!.manifestReference.sha256,
    feedbackItems: [
      { feedback_id: "FB-001", summary: "表示位置に不具合がある。", requirement_ids: ["REQ-F-001"], impacts: ["candidate_defect"] },
      { feedback_id: "FB-002", summary: "成功条件に文言を追加したい。", requirement_ids: ["REQ-F-001"], impacts: ["requirements_changed"] },
    ],
    reason: "要求変更を先に反映する。",
    decidedAt: "2026-08-24T12:02:00.000Z",
  });
  assert.equal(result.feedback.return_stage, "ST-03");
  assert.equal(result.feedback.selected_reason, "requirements_changed");
  assert.deepEqual(result.feedback.invalidated_stages, ["ST-03", "ST-04", "ST-05", "ST-06", "ST-07"]);
  assert.equal(result.state.current_stage, "ST-03");
  assert.equal(existsSync(resolve(projectDir, result.feedback.rejected_candidate_ref.source_of_truth)), true);
  assert.equal(readVNextPlanAt(born.recordDir).stage_decisions.find((entry) => entry.stage_id === "ST-03")?.evidence.some((entry) => entry.artifact === "feedback-current"), true);
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("ST-07 deterministically skips review when ST-06 has no Candidate", () => {
  const { projectDir, born } = fixture("not_applicable");
  prepareBuildConverge(projectDir, { preparedAt: "2026-08-24T12:00:00.000Z" });
  const result = prepareCandidateReview(projectDir, { preparedAt: "2026-08-24T12:01:00.000Z" });
  assert.equal(result.execution, "advanced");
  assert.equal(result.state.current_stage, "ST-08");
  assert.equal(result.current?.outcome, "not_applicable");
  assert.equal(existsSync(reviewHtmlPath(born.recordDir)), false);
  assert.equal(existsSync(acceptedCandidatePath(born.recordDir)), false);
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("tampering with the ST-07 Review Manifest fails resume and Doctor closed", async () => {
  const { projectDir, born } = fixture();
  const build = prepareBuildConverge(projectDir);
  writeFileSync(join(build.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  await verifyBuildAttempt(projectDir, { boltId: "BOLT-001" });
  prepareCandidateReview(projectDir);
  const path = join(born.recordDir, "artifacts", "review", "review-manifest.json");
  writeFileSync(path, `${readFileSync(path, "utf8")} `);
  assert.throws(() => resumeVNextIntent(projectDir), /ST-07|Review Manifest|canonical/i);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
});

test("candidate_defect feedback opens a new ST-06 cycle from the rejected Candidate", async () => {
  const { projectDir, born } = fixture();
  const first = prepareBuildConverge(projectDir);
  writeFileSync(join(first.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  const initial = await verifyBuildAttempt(projectDir, { boltId: "BOLT-001", verifiedAt: "2026-08-24T12:00:00.000Z" });
  assert.equal(initial.outcome, "candidate", initial.checkpoint.reason);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-07");
  const review = prepareCandidateReview(projectDir, { preparedAt: "2026-08-24T12:01:00.000Z" });
  submitCandidateFeedback(projectDir, {
    manifestSha256: review.pending!.manifestReference.sha256,
    feedbackItems: [{ feedback_id: "FB-001", summary: "表示位置の実装だけを直す。", requirement_ids: ["REQ-F-001"], impacts: ["candidate_defect"] }],
    reason: "要求とContractは変えず実装を修正する。",
    decidedAt: "2026-08-24T12:02:00.000Z",
  });

  const reopened = prepareBuildConverge(projectDir, { preparedAt: "2026-08-24T12:03:00.000Z" });
  assert.equal(reopened.execution, "prepared");
  assert.equal(reopened.request?.bolt.bolt_id, "BOLT-001");
  assert.equal(reopened.request?.attempt, 2);
  assert.match(readFileSync(join(reopened.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "utf8"), /ログイン/);
  writeFileSync(join(reopened.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン'; // position fixed\n");
  const rebuilt = await verifyBuildAttempt(projectDir, { boltId: "BOLT-001", verifiedAt: "2026-08-24T12:04:00.000Z" });
  assert.equal(rebuilt.outcome, "candidate");
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-07");
  const secondReview = prepareCandidateReview(projectDir, { preparedAt: "2026-08-24T12:05:00.000Z" });
  assert.equal(secondReview.execution, "prepared");
  assert.notEqual(secondReview.pending?.manifestReference.sha256, review.pending?.manifestReference.sha256);
  assert.equal(secondReview.pending?.manifest.source_results[0]?.base_revision, review.pending?.manifest.source_results[0]?.base_revision);
  const accepted = approveCandidateReview(projectDir, {
    manifestSha256: secondReview.pending!.manifestReference.sha256,
    reason: "修正版を承認する。",
    decidedAt: "2026-08-24T12:06:00.000Z",
  });
  assert.equal(accepted.state.current_stage, "ST-08");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("ST-07 approval fails closed until every human-at-st07 check passes", async () => {
  const { projectDir } = fixture("execute", 1, true);
  const build = prepareBuildConverge(projectDir);
  writeFileSync(join(build.request!.source_workspaces[0]!.worktree_path, "src/login.ts"), "export const buttonLabel = 'ログイン';\n");
  await verifyBuildAttempt(projectDir, { boltId: "BOLT-001" });
  const review = prepareCandidateReview(projectDir);
  assert.deepEqual(review.pending?.manifest.human_checks, [{ verifier_id: "VER-099", expected: "表示が自然である。" }]);
  assert.throws(() => approveCandidateReview(projectDir, {
    manifestSha256: review.pending!.manifestReference.sha256,
    reason: "未確認のまま承認する。",
  }), /every human-at-st07 check|human check/i);
  assert.throws(() => approveCandidateReview(projectDir, {
    manifestSha256: review.pending!.manifestReference.sha256,
    humanCheckResults: [{ verifier_id: "VER-099", result: "failed", note: "表示が崩れている。" }],
    reason: "失敗だが承認する。",
  }), /every human-at-st07 check|human check/i);
  const approved = approveCandidateReview(projectDir, {
    manifestSha256: review.pending!.manifestReference.sha256,
    humanCheckResults: [{ verifier_id: "VER-099", result: "passed", note: "実物を確認した。" }],
    reason: "人間確認も合格した。",
  });
  assert.equal(approved.state.current_stage, "ST-08");
});

test("ST-08 pins a Release Plan, requires human authority, promotes the remote Source, and advances only to ST-09", async () => {
  const { projectDir, sourceDir, born, appRemote, accepted } = await acceptedReleaseFixture();
  const prepared = prepareRelease(projectDir, { preparedAt: "2026-08-25T01:04:00.000Z" });
  assert.equal(prepared.execution, "prepared");
  assert.equal(prepared.request?.stage_id, "ST-08");
  assert.equal(prepared.request?.source_targets[0]?.available_remotes.includes("origin"), true);
  assert.equal(resolveVNextDirective(projectDir).kind, "work");

  const proposal = releaseProposal(prepared.request!);
  proposal.work_request_sha256 = prepared.reference!.sha256;
  const reviewed = reviewReleasePlan(projectDir, proposal, { reviewedAt: "2026-08-25T01:05:00.000Z" });
  assert.equal(existsSync(releaseHtmlPath(born.recordDir)), true);
  assert.match(readFileSync(releaseHtmlPath(born.recordDir), "utf8"), /Release前の最終確認/);
  const directive = resolveVNextDirective(projectDir);
  assert.equal(directive.kind, "approval");
  assert.equal("stage" in directive && directive.stage, "ST-08");

  const authorized = authorizeRelease(projectDir, {
    planSha256: reviewed.planReference.sha256,
    reason: "このSource TargetへのReleaseを承認する。",
    decidedAt: "2026-08-25T01:06:00.000Z",
  });
  assert.equal(authorized.state.current_stage, "ST-08");
  assert.equal(git(appRemote.bareDir, "rev-parse", appRemote.targetRef), appRemote.initialRevision);

  const executed = executeRelease(projectDir, { executedAt: "2026-08-25T01:07:00.000Z" });
  assert.equal(executed.outcome, "released");
  assert.equal(executed.state.current_stage, "ST-09");
  assert.equal(git(appRemote.bareDir, "rev-parse", appRemote.targetRef), accepted.source_results[0]?.candidate_revision);
  assert.match(git(sourceDir, "show", `${accepted.source_results[0]!.candidate_revision}:src/login.ts`), /ログイン/);
  assert.equal(parseReleaseCurrent(JSON.parse(readFileSync(releaseCurrentPath(born.recordDir), "utf8"))).outcome, "released");
  const baseline = parseDeploymentMapBaseline(JSON.parse(readFileSync(deploymentMapBaselinePath(projectDir), "utf8")));
  assert.equal(baseline.revision, 1);
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("ST-08 deterministically skips Release only when ST-07 has no Accepted Candidate", () => {
  const { projectDir, born } = fixture("not_applicable");
  prepareBuildConverge(projectDir, { preparedAt: "2026-08-25T02:00:00.000Z" });
  prepareCandidateReview(projectDir, { preparedAt: "2026-08-25T02:01:00.000Z" });
  const result = prepareRelease(projectDir, { preparedAt: "2026-08-25T02:02:00.000Z" });
  assert.equal(result.execution, "advanced");
  assert.equal(result.state.current_stage, "ST-09");
  assert.equal(result.current?.outcome, "not_applicable");
  assert.equal(existsSync(releaseHtmlPath(born.recordDir)), false);
  assert.equal(existsSync(deploymentMapBaselinePath(projectDir)), false);
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("ST-09 fixes every promise, auto-completes only an all-achieved Outcome, and has no next Stage", async () => {
  const { projectDir, born } = await acceptedReleaseFixture();
  const release = prepareRelease(projectDir, { preparedAt: "2026-08-25T04:00:00.000Z" });
  const releasePlan = releaseProposal(release.request!);
  releasePlan.work_request_sha256 = release.reference!.sha256;
  const reviewed = reviewReleasePlan(projectDir, releasePlan, { reviewedAt: "2026-08-25T04:01:00.000Z" });
  authorizeRelease(projectDir, { planSha256: reviewed.planReference.sha256, reason: "Outcome試験のReleaseを承認する。", decidedAt: "2026-08-25T04:02:00.000Z" });
  executeRelease(projectDir, { executedAt: "2026-08-25T04:03:00.000Z" });

  const prepared = prepareOutcomeEvaluation(projectDir, { preparedAt: "2026-08-25T04:04:00.000Z" });
  assert.equal(prepared.execution, "prepared");
  assert.equal(prepared.request?.stage_id, "ST-09");
  assert.equal(prepared.request!.signals.some((entry) => entry.signal_id === "OUT-001"), true);
  assert.equal(prepared.request!.signals.some((entry) => entry.signal_id === "SIG-001"), true);
  assert.equal(prepared.request!.signals.some((entry) => entry.signal_id === "REQ-F-001"), true);
  assert.equal(prepared.request!.signals.some((entry) => entry.signal_id === "AC-001"), true);
  assert.equal(resolveVNextDirective(projectDir).kind, "work");

  const evaluated = evaluateOutcome(projectDir, {
    schema_version: 1,
    artifact: "outcome-evaluation-proposal",
    version: 1,
    proposal_id: "outcome-all-achieved",
    intent_id: prepared.request!.intent_id,
    work_request_sha256: prepared.reference!.sha256,
    observations: prepared.request!.signals.map((signal) => ({
      signal_id: signal.signal_id,
      result: "achieved" as const,
      evidence_refs: [prepared.request!.release_current_ref],
      reason: "Release Currentと承認済みEvidenceで条件を確認した。",
      observed_at: "2026-08-25T04:05:00.000Z",
    })),
    reason: "すべての狙った結果を確認した。",
    proposed_by: "ai",
  }, { evaluatedAt: "2026-08-25T04:06:00.000Z" });
  assert.equal(evaluated.outcome, "completed");
  assert.equal(evaluated.state.status, "completed");
  assert.equal(evaluated.state.current_stage, "ST-09");
  assert.equal(existsSync(outcomeCurrentPath(born.recordDir)), true);
  assert.equal(existsSync(outcomeHtmlPath(born.recordDir)), true);
  assert.match(readFileSync(outcomeHtmlPath(born.recordDir), "utf8"), /すべての狙った結果/);
  assert.equal(resolveVNextDirective(projectDir).kind, "done");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
  const evaluationPath = outcomeEvaluationPath(born.recordDir);
  const tampered = JSON.parse(readFileSync(evaluationPath, "utf8"));
  tampered.unexpected = true;
  writeFileSync(evaluationPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => resumeVNextIntent(projectDir), /Outcome|unknown field/i);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
});

test("ST-09 keeps a non-achieved Outcome for human judgment and drafts, but does not create, a Follow-up Intent", () => {
  const { projectDir, born } = fixture("not_applicable");
  prepareBuildConverge(projectDir, { preparedAt: "2026-08-25T05:00:00.000Z" });
  prepareCandidateReview(projectDir, { preparedAt: "2026-08-25T05:01:00.000Z" });
  prepareRelease(projectDir, { preparedAt: "2026-08-25T05:02:00.000Z" });
  const prepared = prepareOutcomeEvaluation(projectDir, { preparedAt: "2026-08-25T05:03:00.000Z" });
  const evaluated = evaluateOutcome(projectDir, {
    schema_version: 1,
    artifact: "outcome-evaluation-proposal",
    version: 1,
    proposal_id: "outcome-partial",
    intent_id: prepared.request!.intent_id,
    work_request_sha256: prepared.reference!.sha256,
    observations: prepared.request!.signals.map((signal, index) => ({
      signal_id: signal.signal_id,
      result: index === 0 ? "not_achieved" as const : "achieved" as const,
      evidence_refs: [prepared.request!.release_current_ref],
      reason: index === 0 ? "最初の結果はまだ確認できない。" : "条件を確認した。",
      observed_at: "2026-08-25T05:04:00.000Z",
    })),
    reason: "一部の狙った結果を確認できなかった。",
    proposed_by: "ai",
  }, { evaluatedAt: "2026-08-25T05:05:00.000Z" });
  assert.equal(evaluated.outcome, "awaiting_decision");
  assert.equal(resolveVNextDirective(projectDir).kind, "decision");
  const continued = decideOutcome(projectDir, {
    evaluationSha256: evaluated.evaluationReference.sha256,
    decision: "continue-observation",
    reason: "観測時刻を広げてもう一度確認する。",
    notBefore: "2026-08-25T05:10:00.000Z",
    deadline: "2026-08-25T05:20:00.000Z",
    decidedAt: "2026-08-25T05:06:00.000Z",
  });
  assert.equal(continued.outcome, "continued");
  assert.equal(prepareOutcomeEvaluation(projectDir, { preparedAt: "2026-08-25T05:07:00.000Z" }).execution, "waiting");
  const resumed = prepareOutcomeEvaluation(projectDir, { preparedAt: "2026-08-25T05:10:00.000Z" });
  assert.equal(resumed.request?.revision, 2);
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
  const reevaluated = evaluateOutcome(projectDir, {
    schema_version: 1,
    artifact: "outcome-evaluation-proposal",
    version: 1,
    proposal_id: "outcome-partial-after-observation",
    intent_id: resumed.request!.intent_id,
    work_request_sha256: resumed.reference!.sha256,
    observations: resumed.request!.signals.map((signal, index) => ({
      signal_id: signal.signal_id,
      result: index === 0 ? "not_achieved" as const : "achieved" as const,
      evidence_refs: [resumed.request!.release_current_ref],
      reason: index === 0 ? "追加観測後も最初の結果は確認できない。" : "条件を確認した。",
      observed_at: "2026-08-25T05:11:00.000Z",
    })),
    reason: "追加観測後も一部の狙った結果を確認できなかった。",
    proposed_by: "ai",
  }, { evaluatedAt: "2026-08-25T05:12:00.000Z" });
  assert.equal(reevaluated.outcome, "awaiting_decision");
  const decided = decideOutcome(projectDir, {
    evaluationSha256: reevaluated.evaluationReference.sha256,
    decision: "complete-and-draft-follow-up",
    reason: "未達を正直に記録し、別Intent候補だけを残す。",
    decidedAt: "2026-08-25T05:13:00.000Z",
  });
  assert.equal(decided.outcome, "completed");
  assert.equal(decided.state.status, "completed");
  assert.equal(existsSync(followUpBriefPath(born.recordDir)), true);
  assert.equal(decided.followUp?.source_intent_id, born.uuid);
  assert.equal(resolveVNextDirective(projectDir).kind, "done");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("ST-09 parks a future observation window and resumes without sleeping", () => {
  const { projectDir } = fixture("not_applicable");
  prepareBuildConverge(projectDir, { preparedAt: "2026-08-25T06:00:00.000Z" });
  prepareCandidateReview(projectDir, { preparedAt: "2026-08-25T06:01:00.000Z" });
  prepareRelease(projectDir, { preparedAt: "2026-08-25T06:02:00.000Z" });
  const waiting = prepareOutcomeEvaluation(projectDir, {
    preparedAt: "2026-08-25T06:03:00.000Z",
    notBefore: "2026-08-25T07:00:00.000Z",
    deadline: "2026-08-25T08:00:00.000Z",
  });
  assert.equal(waiting.execution, "waiting");
  assert.equal(waiting.state.not_before, "2026-08-25T07:00:00.000Z");
  const resumed = prepareOutcomeEvaluation(projectDir, { preparedAt: "2026-08-25T07:00:00.000Z" });
  assert.equal(resumed.execution, "prepared");
  assert.equal(resumed.request?.deadline, "2026-08-25T08:00:00.000Z");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("ST-08 rejects target drift after authority without performing the approved Release", async () => {
  const { projectDir, sourceDir, born, appRemote } = await acceptedReleaseFixture();
  const prepared = prepareRelease(projectDir);
  const proposal = releaseProposal(prepared.request!);
  proposal.work_request_sha256 = prepared.reference!.sha256;
  const reviewed = reviewReleasePlan(projectDir, proposal);
  authorizeRelease(projectDir, { planSha256: reviewed.planReference.sha256, reason: "観測済みTargetを承認する。" });

  writeFileSync(join(sourceDir, "drift.txt"), "concurrent release\n");
  git(sourceDir, "add", "drift.txt");
  git(sourceDir, "commit", "-qm", "concurrent target drift");
  git(sourceDir, "push", "-q", "origin", `HEAD:${appRemote.targetRef}`);
  const driftRevision = git(appRemote.bareDir, "rev-parse", appRemote.targetRef);

  const result = executeRelease(projectDir);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.state.current_stage, "ST-08");
  assert.equal(git(appRemote.bareDir, "rev-parse", appRemote.targetRef), driftRevision);
  assert.equal(existsSync(releaseCurrentPath(born.recordDir)), false);
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("ST-08 rolls back earlier Source promotions when a later external step fails", async () => {
  const { projectDir, born, appRemote, serviceRemote } = await acceptedReleaseFixture(2);
  const prepared = prepareRelease(projectDir);
  const proposal = releaseProposal(prepared.request!);
  proposal.work_request_sha256 = prepared.reference!.sha256;
  const reviewed = reviewReleasePlan(projectDir, proposal);
  authorizeRelease(projectDir, { planSha256: reviewed.planReference.sha256, reason: "2 RepositoryのReleaseとrollbackを承認する。" });

  const orderedTargets = [...prepared.request!.source_targets].sort((left, right) => left.repository_id.localeCompare(right.repository_id));
  const secondRemote = orderedTargets[1]!.repository_root === "service" ? serviceRemote! : appRemote;
  const rejectingHook = join(secondRemote.bareDir, "hooks", "pre-receive");
  writeFileSync(rejectingHook, "#!/bin/sh\nexit 1\n");
  chmodSync(rejectingHook, 0o755);
  const result = executeRelease(projectDir);
  assert.equal(result.outcome, "rolled_back");
  assert.equal(result.state.current_stage, "ST-09");
  assert.equal(git(appRemote.bareDir, "rev-parse", appRemote.targetRef), appRemote.initialRevision);
  assert.equal(git(serviceRemote!.bareDir, "rev-parse", serviceRemote!.targetRef), serviceRemote!.initialRevision);
  assert.equal(parseReleaseCurrent(JSON.parse(readFileSync(releaseCurrentPath(born.recordDir), "utf8"))).outcome, "rolled_back");
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});

test("tampering with an ST-08 Release Receipt fails resume and Doctor closed", async () => {
  const { projectDir } = await acceptedReleaseFixture();
  const prepared = prepareRelease(projectDir);
  const proposal = releaseProposal(prepared.request!);
  proposal.work_request_sha256 = prepared.reference!.sha256;
  const reviewed = reviewReleasePlan(projectDir, proposal);
  authorizeRelease(projectDir, { planSha256: reviewed.planReference.sha256, reason: "改ざん検知試験のReleaseを承認する。" });
  const executed = executeRelease(projectDir);
  const receiptPath = resolve(projectDir, executed.current!.release_receipt_ref!.source_of_truth);
  const tampered = JSON.parse(readFileSync(receiptPath, "utf8"));
  tampered.unexpected = true;
  writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => resumeVNextIntent(projectDir), /Release|unknown field|SHA-256/i);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
});

test("ST-08 reuses only an exact released Candidate whose external Target still matches", async () => {
  const { projectDir, sourceDir, born, appRemote, accepted } = await acceptedReleaseFixture();
  const prepared = prepareRelease(projectDir);
  const proposal = releaseProposal(prepared.request!);
  proposal.work_request_sha256 = prepared.reference!.sha256;
  const reviewed = reviewReleasePlan(projectDir, proposal);
  authorizeRelease(projectDir, { planSha256: reviewed.planReference.sha256, reason: "再利用元のReleaseを承認する。" });
  const executed = executeRelease(projectDir);
  const reusablePath = join(projectDir, "prior-release-current.json");
  writeFileSync(reusablePath, readFileSync(releaseCurrentPath(born.recordDir), "utf8"));
  const completedState = readVNextStateAt(born.recordDir);
  const completedPlan = readVNextPlanAt(born.recordDir);
  writeVNextStateAt(born.recordDir, { ...completedState, current_stage: "ST-08", status: "parked", parked_reason: "Release reuse verification fixture.", updated_at: "2026-08-25T03:00:00.000Z" }, completedPlan);

  writeFileSync(join(sourceDir, "reuse-drift.txt"), "different external state\n");
  git(sourceDir, "add", "reuse-drift.txt");
  git(sourceDir, "commit", "-qm", "reuse target drift");
  git(sourceDir, "push", "-q", "--force", "origin", `HEAD:${appRemote.targetRef}`);
  assert.throws(() => reuseRelease(projectDir, { releaseCurrentPath: reusablePath, reason: "外部状態が違うので再利用できない。" }), /no longer matches|Target/i);
  git(sourceDir, "push", "-q", "--force", "origin", `${accepted.source_results[0]!.candidate_revision}:${appRemote.targetRef}`);

  const reused = reuseRelease(projectDir, { releaseCurrentPath: reusablePath, reason: "Candidate、Plan、Target、Receiptが一致するため再利用する。", reusedAt: "2026-08-25T03:01:00.000Z" });
  assert.equal(reused.current.disposition, "reuse");
  assert.equal(reused.current.outcome, "released");
  assert.equal(reused.state.current_stage, "ST-09");
  assert.equal(git(appRemote.bareDir, "rev-parse", appRemote.targetRef), accepted.source_results[0]!.candidate_revision);
  assert.equal(executed.receiptReference?.sha256, reused.current.release_receipt_ref?.sha256);
  assert.equal(checkVNextDoctor(projectDir).healthy, true);
});
