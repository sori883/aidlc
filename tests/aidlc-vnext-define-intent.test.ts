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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrderedAuditEntries } from "../core/tools/aidlc-audit.ts";
import { executeBootstrap } from "../core/tools/aidlc-vnext-bootstrap.ts";
import {
  completeDefineIntent,
  defineIntentWorkRequestPath,
  intentDefinitionPath,
  loadDefineIntentStageContract,
  prepareDefineIntent,
} from "../core/tools/aidlc-vnext-define-intent.ts";
import {
  parseIntentDefinitionProposal,
  type IntentDefinitionProposal,
} from "../core/tools/aidlc-vnext-define-intent-contract.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { completeOrient, prepareOrient } from "../core/tools/aidlc-vnext-orient.ts";
import { parseVNextCoreDirective } from "../core/tools/aidlc-vnext-directive.ts";
import { checkVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import { loadVNextDefinitions } from "../core/tools/aidlc-core-route.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
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
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-define-intent-"));
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
  executeBootstrap(projectDir, { createdAt: "2026-08-24T01:00:00.000Z" });
  const orient = prepareOrient(projectDir, { observedAt: "2026-08-24T01:01:00.000Z" });
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
      proposal_id: "define-intent-fixture-map",
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
        observed_at: "2026-08-24T01:01:00.000Z",
      }],
      coverage_upserts: [{
        coverage_id: "cov-login-copy",
        scope: "ログイン画面のボタン表示",
        status: "observed",
        evidence_refs: ["ev-login-copy"],
        observed_at: "2026-08-24T01:01:00.000Z",
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
      proposed_at: "2026-08-24T01:02:00.000Z",
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
  }, { completedAt: "2026-08-24T01:03:00.000Z" });
  return { projectDir, born };
}

function proposalFor(projectDir: string): IntentDefinitionProposal {
  const prepared = prepareDefineIntent(projectDir, {
    preparedAt: "2026-08-24T01:04:00.000Z",
  });
  return {
    schema_version: 1,
    artifact: "intent-definition-proposal",
    version: 1,
    proposal_id: "define-login-copy",
    intent_id: prepared.request.intent_id,
    work_request_sha256: prepared.reference.sha256,
    purpose: "ログイン操作の意味を利用者へ明確に伝える。",
    expected_outcomes: ["ログインボタンの意味を迷わず理解できる。"],
    in_scope: ["ログイン画面のボタン表示"],
    out_of_scope: ["認証処理", "ログイン画面の構成"],
    success_signals: ["ボタン表示が『ログイン』になり、既存の認証動作が変わらない。"],
    unknowns: [],
    reason: "Design BriefとCurrent Contextから今回の変更範囲を限定した。",
    proposed_by: "ai",
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("ST-02 uses the clearer Define Intent name without changing its fixed ID", () => {
  const contract = loadDefineIntentStageContract();
  const stage = loadVNextDefinitions().catalog.stages.find((entry) => entry.stage_id === "ST-02");
  assert.equal(stage?.name, "Define Intent");
  assert.equal(contract.stage_id, "ST-02");
  assert.equal(contract.name, "Define Intent");
  assert.deepEqual(contract.outputs, ["intent-definition"]);
  assert.equal(contract.human_decisions.includes("value_judgment"), true);
  assert.equal("next_stage" in contract, false);
});

test("Core prepares one idempotent ST-02 work request and AI cannot choose a route", () => {
  const { projectDir, born } = fixture();
  assert.equal(
    readVNextStateAt(born.recordDir).parked_reason,
    "ST-02 Define Intent is ready for Core preparation.",
  );
  const first = resolveVNextDirective(projectDir);
  assert.equal(first.kind, "work");
  assert.equal("stage" in first && first.stage, "ST-02");
  assert.equal("request" in first && first.request.artifact, "define-intent-work-request");
  assert.equal(existsSync(defineIntentWorkRequestPath(born.recordDir)), true);

  const second = resolveVNextDirective(projectDir);
  assert.deepEqual(second, first);
  assert.throws(
    () => parseVNextCoreDirective({ ...first, next_stage: "ST-09" }),
    /unknown field\(s\): next_stage/,
  );
});

test("Intent Definition Proposal is strict, lightweight, and cannot mix later-Stage design", () => {
  const { projectDir } = fixture();
  const valid = proposalFor(projectDir);
  assert.equal(parseIntentDefinitionProposal(valid).unknowns.length, 0);
  assert.throws(
    () => parseIntentDefinitionProposal({ ...valid, next_stage: "ST-09" }),
    /unknown field\(s\): next_stage/,
  );
  assert.throws(
    () => parseIntentDefinitionProposal({ ...valid, architecture: "Use Lambda" }),
    /unknown field\(s\): architecture/,
  );
  assert.throws(
    () => parseIntentDefinitionProposal({
      ...valid,
      out_of_scope: [...valid.out_of_scope, valid.in_scope[0]!],
    }),
    /both in_scope and out_of_scope/,
  );
  assert.throws(
    () => parseIntentDefinitionProposal({ ...valid, success_signals: [] }),
    /success_signals.*at least 1/,
  );
  assert.throws(
    () => parseIntentDefinitionProposal({ ...valid, api_key: "secret" }),
    /secret-bearing field.*api_key/,
  );
});

test("Core rejects not_applicable because every Intent needs a definition", () => {
  const { projectDir, born } = fixture();
  const state = readVNextStateAt(born.recordDir);
  const plan = readVNextPlanAt(born.recordDir);
  const revised = {
    ...plan,
    stage_decisions: plan.stage_decisions.map((decision) =>
      decision.stage_id === "ST-02"
        ? {
          ...decision,
          disposition: "not_applicable" as const,
          reason: "Attempt to omit the Intent Definition.",
          evidence: [plan.policy_snapshot],
        }
        : decision
    ),
  };
  writeVNextPlanAt(born.recordDir, revised);
  writeVNextStateAt(born.recordDir, state, revised);
  assert.throws(() => prepareDefineIntent(projectDir), /ST-02 cannot be not_applicable/);
});

test("Core pins the ST-01 inputs, persists JSON only, and advances exactly to ST-03", () => {
  const { projectDir, born } = fixture();
  const result = completeDefineIntent(projectDir, proposalFor(projectDir), {
    completedAt: "2026-08-24T01:05:00.000Z",
  });

  assert.equal(result.definition.artifact, "intent-definition");
  assert.equal(result.definition.design_brief_ref.artifact, "design-brief");
  assert.equal(result.definition.current_context_ref.artifact, "current-context");
  assert.deepEqual(result.definition.in_scope, ["ログイン画面のボタン表示"]);
  assert.equal(existsSync(intentDefinitionPath(born.recordDir)), true);
  assert.equal(existsSync(join(born.recordDir, "artifacts", "intent-definition.html")), false);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-03");
  assert.equal(
    readOrderedAuditEntries(born.recordDir).some((entry) =>
      entry.event === "ROUTE_DECIDED" && entry.fields["Current Stage"] === "ST-03"
    ),
    true,
  );
});

test("wrong Work Request hash is rejected without advancing State", () => {
  const { projectDir, born } = fixture();
  const proposal = proposalFor(projectDir);
  assert.throws(
    () => completeDefineIntent(projectDir, {
      ...proposal,
      work_request_sha256: `sha256:${"0".repeat(64)}`,
    }),
    /does not reference the current Define Intent Work Request/,
  );
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-02");
  assert.equal(existsSync(intentDefinitionPath(born.recordDir)), false);
});

test("completion resumes after the canonical Intent Definition was saved before the route commit", () => {
  const { projectDir, born } = fixture();
  const proposal = proposalFor(projectDir);
  const prepared = prepareDefineIntent(projectDir);
  const interruptedDefinition = {
    schema_version: 1,
    artifact: "intent-definition",
    version: 1,
    intent_id: proposal.intent_id,
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
    created_at: "2026-08-24T01:05:00.000Z",
  };
  writeFileSync(
    intentDefinitionPath(born.recordDir),
    `${JSON.stringify(interruptedDefinition, null, 2)}\n`,
    "utf8",
  );

  const result = completeDefineIntent(projectDir, proposal, {
    completedAt: "2026-08-24T01:06:00.000Z",
  });

  assert.equal(result.definition.created_at, "2026-08-24T01:05:00.000Z");
  assert.equal(result.state.current_stage, "ST-03");
  assert.equal(
    readOrderedAuditEntries(born.recordDir).some((entry) =>
      entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-02"
    ),
    true,
  );
});

test("resume and Doctor fail closed when the Intent Definition is edited", () => {
  const { projectDir, born } = fixture();
  completeDefineIntent(projectDir, proposalFor(projectDir));
  const path = intentDefinitionPath(born.recordDir);
  writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");

  assert.throws(() => resumeVNextIntent(projectDir), /Intent Definition.*canonical|sha256 mismatch/);
  assert.equal(checkVNextDoctor(projectDir).healthy, false);
});
