import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  dirname,
  join,
  relative,
} from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { readOrderedAuditEntries } from "../core/tools/aidlc-audit.ts";
import { loadVNextDefinitions } from "../core/tools/aidlc-core-route.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { executeBootstrap } from "../core/tools/aidlc-vnext-bootstrap.ts";
import { checkVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import { completeDefineIntent } from "../core/tools/aidlc-vnext-define-intent.ts";
import { parseVNextCoreDirective } from "../core/tools/aidlc-vnext-directive.ts";
import { completeOrient, prepareOrient } from "../core/tools/aidlc-vnext-orient.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
import {
  completeRequirements,
  loadRequirementsStageContract,
  prepareRequirements,
  requirementsCurrentPath,
  requirementsRevisionPath,
  requirementsWorkRequestPath,
} from "../core/tools/aidlc-vnext-requirements.ts";
import {
  parseRequirementsDefinitionProposal,
  type RequirementsDefinitionProposal,
} from "../core/tools/aidlc-vnext-requirements-contract.ts";
import {
  readVNextPlanAt,
  readVNextStateAt,
  resumeVNextIntent,
  writeVNextPlanAt,
  writeVNextStateAt,
} from "../core/tools/aidlc-vnext-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

const fixtures: string[] = [];

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-requirements-"));
  fixtures.push(projectDir);
  mkdirSync(join(projectDir, "app", "src"), { recursive: true });
  writeFileSync(
    join(projectDir, "app", "src", "login.ts"),
    "export const buttonLabel = '送信';\n",
  );
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(
    projectDir,
    "ログイン画面の『送信』を『ログイン』へ変える",
    "default",
    ["app"],
  );
  executeBootstrap(projectDir, { createdAt: "2026-08-24T02:00:00.000Z" });
  const orient = prepareOrient(projectDir, { observedAt: "2026-08-24T02:01:00.000Z" });
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
      proposal_id: "requirements-fixture-map",
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
        observed_at: "2026-08-24T02:01:00.000Z",
      }],
      coverage_upserts: [{
        coverage_id: "cov-login-copy",
        scope: "ログイン画面のボタン表示",
        status: "observed",
        evidence_refs: ["ev-login-copy"],
        observed_at: "2026-08-24T02:01:00.000Z",
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
      reason: "依頼対象の表示位置を観測した。",
      proposed_at: "2026-08-24T02:02:00.000Z",
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
  }, { completedAt: "2026-08-24T02:03:00.000Z" });
  const intentWork = resolveVNextDirective(projectDir);
  assert.equal(intentWork.kind, "work");
  assert.equal("stage" in intentWork && intentWork.stage, "ST-02");
  assert.equal("request" in intentWork, true);
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
    reason: "Design BriefとCurrent Contextから今回の変更範囲を限定した。",
    proposed_by: "ai",
  }, { completedAt: "2026-08-24T02:04:00.000Z" });
  return { projectDir, born };
}

function proposalFor(projectDir: string): RequirementsDefinitionProposal {
  const prepared = prepareRequirements(projectDir, {
    preparedAt: "2026-08-24T02:05:00.000Z",
  });
  return {
    schema_version: 1,
    artifact: "requirements-definition-proposal",
    version: 1,
    proposal_id: "requirements-login-copy",
    intent_id: prepared.request.intent_id,
    work_request_sha256: prepared.reference.sha256,
    functional_requirements: [{
      id: "REQ-F-001",
      statement: "ログイン画面のボタン表示を『送信』から『ログイン』へ変更する。",
      source_refs: [
        { artifact: "intent-definition", pointer: "/expected_outcomes/0" },
        { artifact: "intent-definition", pointer: "/in_scope/0" },
        { artifact: "intent-definition", pointer: "/success_signals/0" },
        { artifact: "current-context", pointer: "/additional_findings/0" },
      ],
    }],
    quality_requirements: [],
    constraints: [],
    invariants: [{
      id: "INV-001",
      statement: "ボタン操作後の既存認証処理とログイン画面構成を変更しない。",
      source_refs: [
        { artifact: "intent-definition", pointer: "/out_of_scope/0" },
        { artifact: "intent-definition", pointer: "/out_of_scope/1" },
        { artifact: "intent-definition", pointer: "/success_signals/0" },
        { artifact: "current-context", pointer: "/out_of_scope/0" },
      ],
    }],
    open_questions: [],
    reason: "ST-02の成功条件を一つの表示要求と既存動作の不変条件へ具体化した。",
    proposed_by: "ai",
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("ST-03 Contract defines Requirements Definition without owning a route", () => {
  const contract = loadRequirementsStageContract();
  const stage = loadVNextDefinitions().catalog.stages.find((entry) => entry.stage_id === "ST-03");
  assert.equal(stage?.name, "Requirements & Constraints");
  assert.equal(contract.stage_id, "ST-03");
  assert.equal(contract.name, "Requirements & Constraints");
  assert.deepEqual(contract.outputs, ["requirements-definition"]);
  assert.equal(contract.human_decisions.includes("value_judgment"), true);
  assert.equal("next_stage" in contract, false);
});

test("Core prepares one idempotent ST-03 Work Request with fixed coverage", () => {
  const { projectDir, born } = fixture();
  assert.equal(
    readVNextStateAt(born.recordDir).parked_reason,
    "ST-03 Requirements & Constraints is ready for Core preparation.",
  );
  const first = resolveVNextDirective(projectDir);
  assert.equal(first.kind, "work");
  assert.equal("stage" in first && first.stage, "ST-03");
  assert.equal("request" in first && first.request.artifact, "requirements-work-request");
  const request = prepareRequirements(projectDir).request;
  assert.equal(request.base_revision, null);
  assert.deepEqual(request.coverage_required, [
    { artifact: "intent-definition", pointer: "/expected_outcomes/0" },
    { artifact: "intent-definition", pointer: "/success_signals/0" },
  ]);
  assert.equal(existsSync(requirementsWorkRequestPath(born.recordDir)), true);
  assert.deepEqual(resolveVNextDirective(projectDir), first);
  assert.throws(
    () => parseVNextCoreDirective({ ...first, next_stage: "ST-09" }),
    /unknown field\(s\): next_stage/,
  );
});

test("Requirements Proposal is strict and rejects duplicate IDs or later-Stage fields", () => {
  const { projectDir } = fixture();
  const valid = proposalFor(projectDir);
  assert.equal(parseRequirementsDefinitionProposal(valid).functional_requirements.length, 1);
  assert.throws(
    () => parseRequirementsDefinitionProposal({ ...valid, architecture: "Use Lambda" }),
    /unknown field\(s\): architecture/,
  );
  assert.throws(
    () => parseRequirementsDefinitionProposal({ ...valid, next_stage: "ST-09" }),
    /unknown field\(s\): next_stage/,
  );
  assert.throws(
    () => parseRequirementsDefinitionProposal({
      ...valid,
      functional_requirements: [
        valid.functional_requirements[0]!,
        { ...valid.functional_requirements[0]! },
      ],
    }),
    /duplicate requirement ID/,
  );
  assert.throws(
    () => parseRequirementsDefinitionProposal({ ...valid, api_key: "secret" }),
    /secret-bearing field.*api_key/,
  );
});

test("Core rejects not_applicable because every Intent needs explicit requirements", () => {
  const { projectDir, born } = fixture();
  const state = readVNextStateAt(born.recordDir);
  const plan = readVNextPlanAt(born.recordDir);
  const revised = {
    ...plan,
    stage_decisions: plan.stage_decisions.map((decision) =>
      decision.stage_id === "ST-03"
        ? {
          ...decision,
          disposition: "not_applicable" as const,
          reason: "Attempt to omit the Requirements Definition.",
          evidence: [plan.policy_snapshot],
        }
        : decision
    ),
  };
  writeVNextPlanAt(born.recordDir, revised);
  writeVNextStateAt(born.recordDir, state, revised);
  assert.throws(() => prepareRequirements(projectDir), /ST-03 cannot be not_applicable/);
});

test("Core persists immutable revision 1, current pointer, and advances exactly to ST-04", () => {
  const { projectDir, born } = fixture();
  const result = completeRequirements(projectDir, proposalFor(projectDir), {
    completedAt: "2026-08-24T02:06:00.000Z",
  });
  assert.equal(result.definition.artifact, "requirements-definition");
  assert.equal(result.definition.revision, 1);
  assert.equal(result.definition.base_revision, null);
  assert.equal(result.definition.intent_definition_ref.artifact, "intent-definition");
  assert.equal(result.current.current_revision, 1);
  assert.equal(existsSync(requirementsRevisionPath(born.recordDir, 1)), true);
  assert.equal(existsSync(requirementsCurrentPath(born.recordDir)), true);
  assert.equal(existsSync(join(born.recordDir, "artifacts", "requirements.html")), false);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-04");
  assert.equal(
    readOrderedAuditEntries(born.recordDir).some((entry) =>
      entry.event === "ROUTE_DECIDED" && entry.fields["Current Stage"] === "ST-04"
    ),
    true,
  );
});

test("Core rejects missing coverage, broken source pointers, and blocking questions", () => {
  const first = fixture();
  const missingCoverage = proposalFor(first.projectDir);
  missingCoverage.functional_requirements[0]!.source_refs =
    missingCoverage.functional_requirements[0]!.source_refs.filter(
      (reference) => reference.pointer !== "/expected_outcomes/0",
    );
  assert.throws(
    () => completeRequirements(first.projectDir, missingCoverage),
    /required coverage is missing.*expected_outcomes\/0/,
  );
  assert.equal(existsSync(requirementsCurrentPath(first.born.recordDir)), false);

  const second = fixture();
  const broken = proposalFor(second.projectDir);
  broken.functional_requirements[0]!.source_refs.push({
    artifact: "current-context",
    pointer: "/missing/0",
  });
  assert.throws(
    () => completeRequirements(second.projectDir, broken),
    /source pointer does not exist.*missing\/0/,
  );

  const third = fixture();
  const blocked = proposalFor(third.projectDir);
  blocked.open_questions.push({
    id: "Q-001",
    question: "認証処理も変更対象に含めるか。",
    blocking: true,
    reason: "対象範囲の価値判断が必要。",
    source_refs: [{ artifact: "intent-definition", pointer: "/out_of_scope/0" }],
  });
  assert.throws(
    () => completeRequirements(third.projectDir, blocked),
    /blocking open question.*Q-001/,
  );
});

test("wrong Work Request hash is rejected without creating a revision", () => {
  const { projectDir, born } = fixture();
  const proposal = proposalFor(projectDir);
  assert.throws(
    () => completeRequirements(projectDir, {
      ...proposal,
      work_request_sha256: `sha256:${"0".repeat(64)}`,
    }),
    /does not reference the current Requirements Work Request/,
  );
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-03");
  assert.equal(existsSync(requirementsRevisionPath(born.recordDir, 1)), false);
});

test("completion resumes after revision 1 was saved before current and route commit", () => {
  const { projectDir, born } = fixture();
  const proposal = proposalFor(projectDir);
  const prepared = prepareRequirements(projectDir);
  const interrupted = {
    schema_version: 1,
    artifact: "requirements-definition",
    version: 1,
    intent_id: proposal.intent_id,
    revision: 1,
    base_revision: null,
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
    created_at: "2026-08-24T02:06:00.000Z",
  };
  const revisionPath = requirementsRevisionPath(born.recordDir, 1);
  mkdirSync(dirname(revisionPath), { recursive: true });
  writeFileSync(revisionPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

  const result = completeRequirements(projectDir, proposal, {
    completedAt: "2026-08-24T02:07:00.000Z",
  });
  assert.equal(result.definition.created_at, "2026-08-24T02:06:00.000Z");
  assert.equal(result.state.current_stage, "ST-04");
  assert.equal(result.current.current_revision, 1);
});

test("completion resumes after current was saved before Audit and State", () => {
  const { projectDir, born } = fixture();
  const proposal = proposalFor(projectDir);
  const prepared = prepareRequirements(projectDir);
  const interrupted = {
    schema_version: 1,
    artifact: "requirements-definition",
    version: 1,
    intent_id: proposal.intent_id,
    revision: 1,
    base_revision: null,
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
    created_at: "2026-08-24T02:06:00.000Z",
  };
  const revisionPath = requirementsRevisionPath(born.recordDir, 1);
  const revisionContent = `${JSON.stringify(interrupted, null, 2)}\n`;
  mkdirSync(dirname(revisionPath), { recursive: true });
  writeFileSync(revisionPath, revisionContent, "utf8");
  const current = {
    schema_version: 1,
    artifact: "requirements-current",
    version: 1,
    intent_id: proposal.intent_id,
    current_revision: 1,
    requirements_ref: {
      artifact: "requirements-definition",
      version: 1,
      source_of_truth: relative(projectDir, revisionPath),
      sha256: sha256(revisionContent),
    },
    updated_at: "2026-08-24T02:06:00.000Z",
  };
  writeFileSync(
    requirementsCurrentPath(born.recordDir),
    `${JSON.stringify(current, null, 2)}\n`,
    "utf8",
  );

  const result = completeRequirements(projectDir, proposal, {
    completedAt: "2026-08-24T02:07:00.000Z",
  });
  assert.equal(result.definition.revision, 1);
  assert.equal(result.state.current_stage, "ST-04");
  assert.equal(
    readOrderedAuditEntries(born.recordDir).filter((entry) =>
      entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-03"
    ).length,
    1,
  );
});

test("completion resumes after Audit was saved before the State transition", () => {
  const { projectDir, born } = fixture();
  const proposal = proposalFor(projectDir);
  const before = readVNextStateAt(born.recordDir);
  completeRequirements(projectDir, proposal, {
    completedAt: "2026-08-24T02:06:00.000Z",
  });
  const plan = readVNextPlanAt(born.recordDir);
  const { parked_reason: _parkedReason, ...interrupted } = before;
  writeVNextStateAt(born.recordDir, {
    ...interrupted,
    status: "ready",
    updated_at: "2026-08-24T02:06:00.000Z",
  }, plan);

  const result = completeRequirements(projectDir, proposal, {
    completedAt: "2026-08-24T02:07:00.000Z",
  });
  assert.equal(result.definition.revision, 1);
  assert.equal(result.state.current_stage, "ST-04");
  assert.equal(
    readOrderedAuditEntries(born.recordDir).filter((entry) =>
      entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-03"
    ).length,
    1,
  );
});

test("resume and Doctor fail closed when the Requirements revision is edited", () => {
  const { projectDir, born } = fixture();
  completeRequirements(projectDir, proposalFor(projectDir));
  const path = requirementsRevisionPath(born.recordDir, 1);
  writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");
  assert.throws(() => resumeVNextIntent(projectDir), /Requirements.*canonical|sha256 mismatch/);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
});
