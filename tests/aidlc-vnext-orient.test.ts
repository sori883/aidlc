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
import { checkVNextDoctor } from "../core/tools/aidlc-vnext-doctor.ts";
import { executeBootstrap } from "../core/tools/aidlc-vnext-bootstrap.ts";
import { parseVNextCoreDirective } from "../core/tools/aidlc-vnext-directive.ts";
import { birthIntentWithState, switchIntent } from "../core/tools/aidlc-intent.ts";
import {
  completeOrient,
  currentContextPath,
  loadOrientStageContract,
  orientWorkRequestPath,
  prepareOrient,
  systemMapBaselinePath,
  systemMapRevisionPath,
  workspaceProfilePath,
} from "../core/tools/aidlc-vnext-orient.ts";
import {
  parseSystemMap,
  parseSystemMapPatch,
  type OrientProposal,
  type SystemMapPatch,
} from "../core/tools/aidlc-vnext-orient-contract.ts";
import { resolveVNextDirective } from "../core/tools/aidlc-vnext-orchestrate.ts";
import { readVNextStateAt, resumeVNextIntent } from "../core/tools/aidlc-vnext-state.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

const fixtures: string[] = [];

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-orient-"));
  fixtures.push(projectDir);
  mkdirSync(join(projectDir, "app", "src"), { recursive: true });
  writeFileSync(join(projectDir, "app", "src", "server.ts"), "export const port = 3000;\n");
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(
    projectDir,
    "ログイン画面の案内文を変更する",
    "default",
    ["app"],
  );
  executeBootstrap(projectDir, { createdAt: "2026-08-24T00:00:00.000Z" });
  return { projectDir, born };
}

function patchFor(projectDir: string, baseRevision: number | null = null): SystemMapPatch {
  const prepared = prepareOrient(projectDir, {
    observedAt: "2026-08-24T00:01:00.000Z",
  });
  const source = prepared.profile.repository_snapshots[0]!;
  const evidenceSha = sha256(readFileSync(join(projectDir, "app/src/server.ts"), "utf8"));
  return {
    schema_version: 1,
    artifact: "system-map-patch",
    version: 1,
    proposal_id: `patch-${baseRevision ?? 0}`,
    map_id: "default-system",
    base_revision: baseRevision,
    perspective: "accepted-code-baseline",
    source_snapshots: [source],
    evidence: [{
      evidence_id: "ev-server",
      source_id: source.source_id,
      evidence_type: "file",
      locator: "src/server.ts",
      sha256: evidenceSha,
      observed_at: "2026-08-24T00:01:00.000Z",
    }],
    coverage_upserts: [{
      coverage_id: "cov-login-backend",
      scope: "ログイン処理のバックエンド入口",
      status: "observed",
      evidence_refs: ["ev-server"],
      observed_at: "2026-08-24T00:01:00.000Z",
    }],
    entity_upserts: [{
      entity_id: "login-api",
      name: "Login API",
      entity_type: "component",
      capability: "api",
      current_state: "observed",
      provider: { name: "local", service: "bun" },
      evidence_refs: ["ev-server"],
    }],
    relation_upserts: [],
    remove_entity_ids: [],
    remove_relation_ids: [],
    reason: "Intentに必要なログインAPIの入口を観測した。",
    proposed_at: "2026-08-24T00:02:00.000Z",
    proposed_by: "ai",
  };
}

function proposalFor(projectDir: string, baseRevision: number | null = null): OrientProposal {
  const prepared = prepareOrient(projectDir, {
    observedAt: "2026-08-24T00:01:00.000Z",
  });
  return {
    schema_version: 1,
    artifact: "orient-proposal",
    version: 1,
    intent_id: prepared.request.intent_id,
    work_request_sha256: prepared.reference.sha256,
    system_map_patch: patchFor(projectDir, baseRevision),
    current_context: {
      entity_ids: ["login-api"],
      relation_ids: [],
      additional_findings: ["ログインAPIはapp/src/server.tsにある。"],
      out_of_scope: ["本番Deploymentの実態"],
      intent_only_notes: ["作業中の未承認差分は共有Mapへ含めない。"],
      unknowns: ["外部IdPの構成は未観測。"],
    },
    proposed_by: "ai",
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("ST-01 Contract defines JSON-only Orient outputs without owning the next route", () => {
  const contract = loadOrientStageContract();
  assert.equal(contract.stage_id, "ST-01");
  assert.equal(contract.name, "Orient");
  assert.deepEqual(contract.outputs, ["workspace-profile", "system-map", "current-context"]);
  assert.equal(contract.verifiers.includes("system-map-validator"), true);
  assert.equal(contract.outputs.some((output) => output.includes("html")), false);
  assert.equal("next_stage" in contract, false);
});

test("Core prepares an idempotent ST-01 work request and AI cannot smuggle a route", () => {
  const { projectDir, born } = fixture();
  const first = resolveVNextDirective(projectDir);
  assert.equal(first.kind, "work");
  assert.equal("stage" in first && first.stage, "ST-01");
  assert.equal("request" in first && first.request.artifact, "orient-work-request");
  assert.equal(existsSync(workspaceProfilePath(born.recordDir)), true);
  assert.equal(existsSync(orientWorkRequestPath(born.recordDir)), true);

  const second = resolveVNextDirective(projectDir);
  assert.deepEqual(second, first);
  assert.throws(
    () => parseVNextCoreDirective({ ...first, next_stage: "ST-09" }),
    /unknown field\(s\): next_stage/,
  );
});

test("Repository source IDs stay distinct across Intents with different selected roots", () => {
  const { projectDir } = fixture();
  const appSource = prepareOrient(projectDir).profile.repository_snapshots[0]!;
  mkdirSync(join(projectDir, "backend"), { recursive: true });
  writeFileSync(join(projectDir, "backend", "main.ts"), "export const service = 'backend';\n");
  birthIntentWithState(projectDir, "バックエンドを観測する", "default", ["backend"]);
  executeBootstrap(projectDir);
  const backendSource = prepareOrient(projectDir).profile.repository_snapshots[0]!;

  assert.notEqual(backendSource.source_id, appSource.source_id);
  assert.equal(appSource.locator, "app");
  assert.equal(backendSource.locator, "backend");
});

test("System Map validation rejects unknown fields, duplicate IDs, dangling relations, mixed future state, and secret-shaped data", () => {
  const { projectDir } = fixture();
  const validPatch = patchFor(projectDir);
  assert.throws(
    () => parseSystemMapPatch({ ...validPatch, approved: true }),
    /unknown field\(s\): approved/,
  );
  assert.throws(
    () => parseSystemMapPatch({
      ...validPatch,
      entity_upserts: [validPatch.entity_upserts[0], validPatch.entity_upserts[0]],
    }),
    /duplicate entity_id: login-api/,
  );

  const mapShape = {
    ...validPatch,
    artifact: "system-map",
    revision: 1,
    base_revision: null,
    baseline_kind: "imported",
    created_at: "2026-08-24T00:03:00.000Z",
    coverage: validPatch.coverage_upserts,
    entities: validPatch.entity_upserts,
    relations: [{
      relation_id: "missing-target",
      from_entity_id: "login-api",
      to_entity_id: "not-there",
      relation_type: "calls",
      current_state: "observed",
      evidence_refs: ["ev-server"],
    }],
  };
  const {
    proposal_id: _proposalId,
    coverage_upserts: _coverageUpserts,
    entity_upserts: _entityUpserts,
    relation_upserts: _relationUpserts,
    remove_entity_ids: _removeEntities,
    remove_relation_ids: _removeRelations,
    reason: _reason,
    proposed_at: _proposedAt,
    proposed_by: _proposedBy,
    ...map
  } = mapShape;
  assert.throws(() => parseSystemMap(map), /unknown relation endpoint: not-there/);
  assert.throws(
    () => parseSystemMap({
      ...map,
      entities: [{ ...map.entities[0], current_state: "planned" }],
      relations: [],
    }),
    /current_state.*must be one of: observed, stale, unknown/,
  );
  assert.throws(
    () => parseSystemMapPatch({
      ...validPatch,
      entity_upserts: [{
        ...validPatch.entity_upserts[0],
        provider: { name: "aws", service: "lambda", api_key: "secret" },
      }],
    }),
    /secret-bearing field.*api_key/,
  );
});

test("Core rejects Evidence outside a Repository or with the wrong digest", () => {
  const { projectDir } = fixture();
  const escaped = patchFor(projectDir);
  escaped.evidence[0] = { ...escaped.evidence[0]!, locator: "../outside.ts" };
  assert.throws(() => completeOrient(projectDir, {
    ...proposalFor(projectDir),
    system_map_patch: escaped,
  }), /Evidence locator escapes Repository/);

  const wrong = patchFor(projectDir);
  wrong.evidence[0] = { ...wrong.evidence[0]!, sha256: `sha256:${"0".repeat(64)}` };
  assert.throws(() => completeOrient(projectDir, {
    ...proposalFor(projectDir),
    system_map_patch: wrong,
  }), /Evidence SHA-256 does not match/);
});

test("Core persists an immutable Map revision and pinned Current Context, then advances only to ST-02", () => {
  const { projectDir, born } = fixture();
  const proposal = proposalFor(projectDir);
  const result = completeOrient(projectDir, proposal, {
    completedAt: "2026-08-24T00:03:00.000Z",
  });

  assert.equal(result.systemMap.revision, 1);
  assert.equal(result.systemMap.baseline_kind, "imported");
  assert.equal(result.currentContext.system_map_ref.sha256, result.systemMapReference.sha256);
  assert.equal(result.currentContext.system_map_revision, 1);
  assert.deepEqual(result.currentContext.entity_ids, ["login-api"]);
  assert.equal(readVNextStateAt(born.recordDir).current_stage, "ST-02");
  assert.equal(existsSync(systemMapRevisionPath(projectDir, "default", 1)), true);
  assert.equal(existsSync(systemMapBaselinePath(projectDir, "default")), true);
  assert.equal(existsSync(currentContextPath(born.recordDir)), true);
  assert.equal(existsSync(join(systemMapRevisionPath(projectDir, "default", 1), "..", "system-map.html")), false);

  const baseline = JSON.parse(readFileSync(systemMapBaselinePath(projectDir, "default"), "utf8"));
  assert.deepEqual(Object.keys(baseline).sort(), [
    "artifact", "map_id", "revision", "schema_version", "sha256", "source_of_truth", "version",
  ]);
  assert.equal(baseline.revision, 1);
  assert.equal(baseline.sha256, result.systemMapReference.sha256);
  assert.equal(
    readOrderedAuditEntries(born.recordDir).some((entry) =>
      entry.event === "ROUTE_DECIDED" && entry.fields["Current Stage"] === "ST-02"
    ),
    true,
  );
});

test("a stale base_revision cannot overwrite a newer shared System Map", () => {
  const { projectDir } = fixture();
  completeOrient(projectDir, proposalFor(projectDir));
  birthIntentWithState(
    projectDir,
    "同じSystem Mapを使う二つ目のIntent",
    "default",
    ["app"],
  );
  executeBootstrap(projectDir);
  assert.throws(
    () => completeOrient(projectDir, proposalFor(projectDir, null)),
    /base_revision null does not match current revision 1/,
  );
});

test("a prepared Intent refreshes its work request when another Intent advances the baseline", () => {
  const { projectDir, born: first } = fixture();
  const oldRequest = prepareOrient(projectDir).reference;
  birthIntentWithState(projectDir, "共有Mapを先に更新するIntent", "default", ["app"]);
  executeBootstrap(projectDir);
  completeOrient(projectDir, proposalFor(projectDir));

  switchIntent(projectDir, first.dirName);
  const refreshed = resolveVNextDirective(projectDir);
  assert.equal(refreshed.kind, "work");
  assert.notEqual("request" in refreshed && refreshed.request.sha256, oldRequest.sha256);
  const request = JSON.parse(readFileSync(orientWorkRequestPath(first.recordDir), "utf8"));
  assert.equal(request.system_map_baseline_ref.artifact, "system-map");
  assert.equal(request.system_map_baseline_ref.version, 1);
});

test("changed external Evidence makes dependent observations stale until they are re-observed", () => {
  const { projectDir } = fixture();
  const first = proposalFor(projectDir);
  first.system_map_patch.source_snapshots.push({
    source_id: "external-idp",
    source_type: "external",
    locator: "https://idp.example.test/config",
    revision: "v1",
    dirty: false,
    observed_at: "2026-08-24T00:01:00.000Z",
    expires_at: "2027-08-24T00:01:00.000Z",
  });
  first.system_map_patch.evidence.push({
    evidence_id: "ev-idp",
    source_id: "external-idp",
    evidence_type: "external-record",
    locator: "configuration",
    sha256: sha256("idp-v1"),
    observed_at: "2026-08-24T00:01:00.000Z",
  });
  first.system_map_patch.entity_upserts.push({
    entity_id: "external-idp",
    name: "External IdP",
    entity_type: "external-system",
    capability: "identity-provider",
    current_state: "observed",
    provider: { name: "example", service: "identity" },
    evidence_refs: ["ev-idp"],
  });
  first.current_context.entity_ids.push("external-idp");
  completeOrient(projectDir, first);

  birthIntentWithState(projectDir, "IdPの鮮度を再確認する", "default", ["app"]);
  executeBootstrap(projectDir);
  const changed = proposalFor(projectDir, 1);
  changed.system_map_patch.source_snapshots.push({
    source_id: "external-idp",
    source_type: "external",
    locator: "https://idp.example.test/config",
    revision: "v2",
    dirty: false,
    observed_at: "2026-08-24T00:04:00.000Z",
    expires_at: "2027-08-24T00:04:00.000Z",
  });
  changed.system_map_patch.evidence.push({
    evidence_id: "ev-idp",
    source_id: "external-idp",
    evidence_type: "external-record",
    locator: "configuration",
    sha256: sha256("idp-v2"),
    observed_at: "2026-08-24T00:04:00.000Z",
  });
  changed.current_context.entity_ids.push("external-idp");

  const result = completeOrient(projectDir, changed);
  assert.equal(
    result.systemMap.entities.find((entry) => entry.entity_id === "external-idp")?.current_state,
    "stale",
  );
});

test("resume and Doctor fail closed when a pinned System Map revision is edited", () => {
  const { projectDir } = fixture();
  completeOrient(projectDir, proposalFor(projectDir));
  const mapPath = systemMapRevisionPath(projectDir, "default", 1);
  writeFileSync(mapPath, `${readFileSync(mapPath, "utf8")} `, "utf8");

  assert.throws(() => resumeVNextIntent(projectDir), /sha256 mismatch/);
  const report = checkVNextDoctor(projectDir);
  assert.equal(report.healthy, false);
  assert.equal(
    report.findings.some((entry) => entry.code === "VNEXT_CORE_STATE_INVALID"),
    true,
  );
});
