#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { appendAuditEntries, appendAuditEntry, readOrderedAuditEntries } from "./aidlc-audit.ts";
import { verifyBootstrapReceiptAt } from "./aidlc-vnext-bootstrap.ts";
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
  parseCurrentContext,
  parseDesignBrief,
  parseOrientProposal,
  parseOrientWorkRequest,
  parseSystemMap,
  parseSystemMapBaseline,
  parseWorkspaceProfile,
  type CurrentContext,
  type MapCoverage,
  type MapEntity,
  type MapEvidence,
  type MapRelation,
  type OrientProposal,
  type OrientWorkRequest,
  type SourceSnapshot,
  type SystemMap,
  type SystemMapBaseline,
  type WorkspaceProfile,
} from "./aidlc-vnext-orient-contract.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  writeVNextStateAt,
  type VNextIntentState,
} from "./aidlc-vnext-state.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export interface OrientPrepareOptions {
  observedAt?: string;
}

export interface OrientPrepareResult {
  execution: "prepared" | "reused";
  profile: WorkspaceProfile;
  profileReference: ArtifactReference;
  request: OrientWorkRequest;
  reference: ArtifactReference;
}

export interface OrientCompleteOptions {
  completedAt?: string;
}

export interface OrientCompleteResult {
  systemMap: SystemMap;
  systemMapReference: ArtifactReference;
  baseline: SystemMapBaseline;
  currentContext: CurrentContext;
  currentContextReference: ArtifactReference;
  state: VNextIntentState;
}

const STAGE_CONTRACT_PATH = join(
  runtimeCoreDir(),
  "aidlc-common/stages/st-01-orient.json",
);
const SKIPPED_TREE_ENTRIES = new Set([".git", "node_modules", "aidlc", ".DS_Store"]);

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
      // A successful rename already consumed the temporary path.
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
    fail("ST-01 Orient", `path is outside the project: ${absolute}`);
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
    fail("ST-01 Orient", `cannot read ${path}: ${detail}`);
  }
  if (content !== serialize(value)) fail("ST-01 Orient", `artifact is not canonical: ${path}`);
  return { value, content };
}

export function workspaceProfilePath(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "workspace-profile.json");
}

export function orientWorkRequestPath(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "orient-work-request.json");
}

export function currentContextPath(recordDir: string): string {
  return join(resolve(recordDir), "artifacts", "current-context.json");
}

export function systemMapRoot(projectDir: string, space: string): string {
  return join(workspaceRoot(projectDir), "spaces", space, "codekb", "system-map");
}

export function systemMapBaselinePath(projectDir: string, space: string): string {
  return join(systemMapRoot(projectDir, space), "baseline.json");
}

export function systemMapRevisionPath(
  projectDir: string,
  space: string,
  revision: number,
): string {
  return join(
    systemMapRoot(projectDir, space),
    "revisions",
    String(revision).padStart(6, "0"),
    "system-map.json",
  );
}

export function loadOrientStageContract(path = STAGE_CONTRACT_PATH): VNextStageContract {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("ST-01 Contract", `cannot read ${path}: ${detail}`);
  }
  const contract = parseVNextStageContract(value, path);
  if (contract.stage_id !== "ST-01" || contract.name !== "Orient") {
    fail("ST-01 Contract", "must define ST-01 Orient");
  }
  return contract;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function collectDirectoryFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (SKIPPED_TREE_ENTRIES.has(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDirectoryFiles(root, path));
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
  }
  return files;
}

function directoryRevision(root: string): string {
  const hash = createHash("sha256");
  for (const path of collectDirectoryFiles(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function gitOutput(root: string, args: string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function snapshotRepository(
  projectDir: string,
  root: string,
  observedAt: string,
): SourceSnapshot {
  const absolute = resolve(projectDir, root);
  if (!isInside(projectDir, absolute) || !existsSync(absolute) || !statSync(absolute).isDirectory()) {
    fail("ST-01 Orient", `Repository root is invalid: ${root}`);
  }
  const locator = portableProjectPath(projectDir, absolute);
  const sourceId = `repo-${createHash("sha256").update(locator).digest("hex").slice(0, 12)}`;
  const gitHead = gitOutput(absolute, ["rev-parse", "HEAD"]);
  if (gitHead !== null) {
    const status = gitOutput(absolute, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return {
      source_id: sourceId,
      source_type: "git",
      locator,
      revision: gitHead,
      dirty: status !== null && status !== "",
      observed_at: observedAt,
    };
  }
  return {
    source_id: sourceId,
    source_type: "directory",
    locator,
    revision: directoryRevision(absolute),
    dirty: false,
    observed_at: observedAt,
  };
}

function comparableSnapshots(snapshots: readonly SourceSnapshot[]): unknown {
  return snapshots.map(({ observed_at: _observedAt, expires_at: _expiresAt, ...entry }) => entry);
}

function currentProfile(
  projectDir: string,
  intentId: string,
  space: string,
  roots: readonly string[],
  observedAt: string,
): WorkspaceProfile {
  return parseWorkspaceProfile({
    schema_version: 1,
    artifact: "workspace-profile",
    version: 1,
    intent_id: intentId,
    space,
    repository_snapshots: roots.map((root) =>
      snapshotRepository(projectDir, root, observedAt)
    ),
    observed_at: observedAt,
  });
}

function readDesignBrief(
  projectDir: string,
  recordDir: string,
  intentId: string,
): { reference: ArtifactReference } {
  const path = designBriefPath(recordDir);
  if (!existsSync(path)) fail("ST-01 Orient", `Design Brief does not exist: ${path}`);
  const { value, content } = readCanonical(path, parseDesignBrief);
  if (value.intent_id !== intentId) fail("ST-01 Orient", "Design Brief Intent does not match State");
  const reference = artifactReference(projectDir, path, "design-brief", content);
  verifyProjectArtifactReference(projectDir, reference);
  return { reference };
}

function readBaseline(
  projectDir: string,
  space: string,
): { baseline: SystemMapBaseline; map: SystemMap; mapReference: ArtifactReference } | null {
  const pointerPath = systemMapBaselinePath(projectDir, space);
  if (!existsSync(pointerPath)) return null;
  const { value: baseline } = readCanonical(pointerPath, parseSystemMapBaseline);
  const mapPath = resolve(projectDir, baseline.source_of_truth);
  if (!isInside(projectDir, mapPath) || mapPath !== systemMapRevisionPath(projectDir, space, baseline.revision)) {
    fail("ST-01 Orient", "System Map baseline points outside its canonical revision path");
  }
  const { value: map, content } = readCanonical(mapPath, parseSystemMap);
  const mapReference = artifactReference(projectDir, mapPath, "system-map", content);
  if (
    map.map_id !== baseline.map_id || map.revision !== baseline.revision ||
    mapReference.sha256 !== baseline.sha256
  ) fail("ST-01 Orient", "System Map baseline does not match its immutable revision");
  verifyProjectArtifactReference(projectDir, mapReference);
  return { baseline, map, mapReference };
}

function baselineArtifactReference(
  projectDir: string,
  space: string,
): ArtifactReference | undefined {
  return readBaseline(projectDir, space)?.mapReference;
}

function prepareOrientLocked(
  projectDir: string,
  recordDir: string,
  options: OrientPrepareOptions,
): OrientPrepareResult {
  loadOrientStageContract();
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  if (state.current_stage !== "ST-01") {
    fail("ST-01 Orient", `current Stage must be ST-01, found ${state.current_stage}`);
  }
  const decision = plan.stage_decisions.find((entry) => entry.stage_id === "ST-01");
  if (decision === undefined || decision.disposition === "not_applicable") {
    fail("ST-01 Orient", "ST-01 requires an executable or reusable Orient decision");
  }
  const receipt = verifyBootstrapReceiptAt(projectDir, recordDir);
  const brief = readDesignBrief(projectDir, recordDir, state.intent_id);
  const observedAt = options.observedAt ?? new Date().toISOString();
  const space = activeSpace(projectDir);
  const profilePath = workspaceProfilePath(recordDir);
  const requestPath = orientWorkRequestPath(recordDir);

  if (existsSync(profilePath) && existsSync(requestPath)) {
    const { value: storedProfile, content: profileContent } = readCanonical(
      profilePath,
      parseWorkspaceProfile,
    );
    const liveProfile = currentProfile(
      projectDir,
      state.intent_id,
      space,
      receipt.receipt.repository_roots,
      storedProfile.observed_at,
    );
    if (
      JSON.stringify(comparableSnapshots(liveProfile.repository_snapshots)) ===
        JSON.stringify(comparableSnapshots(storedProfile.repository_snapshots))
    ) {
      const profileReference = artifactReference(
        projectDir,
        profilePath,
        "workspace-profile",
        profileContent,
      );
      const { value: request, content: requestContent } = readCanonical(
        requestPath,
        parseOrientWorkRequest,
      );
      const reference = artifactReference(
        projectDir,
        requestPath,
        "orient-work-request",
        requestContent,
      );
      const liveBaselineReference = baselineArtifactReference(projectDir, space);
      if (
        request.intent_id !== state.intent_id ||
        JSON.stringify(request.workspace_profile_ref) !== JSON.stringify(profileReference)
      ) fail("ST-01 Orient", "stored work request does not match the current Workspace Profile");
      if (
        JSON.stringify(request.system_map_baseline_ref) ===
          JSON.stringify(liveBaselineReference)
      ) {
        if (state.status !== "ready") {
          const { parked_reason: _parkedReason, ...unparkedState } = state;
          writeVNextStateAt(recordDir, {
            ...unparkedState,
            status: "ready",
            updated_at: storedProfile.observed_at,
          }, plan);
        }
        return { execution: "reused", profile: storedProfile, profileReference, request, reference };
      }
    }
  }

  const profile = currentProfile(
    projectDir,
    state.intent_id,
    space,
    receipt.receipt.repository_roots,
    observedAt,
  );
  const profileContent = serialize(profile);
  writeFileAtomic(profilePath, profileContent);
  const profileReference = artifactReference(
    projectDir,
    profilePath,
    "workspace-profile",
    profileContent,
  );
  const existingBaseline = readBaseline(projectDir, space);
  const request = parseOrientWorkRequest({
    schema_version: 1,
    artifact: "orient-work-request",
    version: 1,
    intent_id: state.intent_id,
    stage_id: "ST-01",
    design_brief_ref: brief.reference,
    bootstrap_receipt_ref: receipt.reference,
    workspace_profile_ref: profileReference,
    ...(existingBaseline === null
      ? {}
      : { system_map_baseline_ref: baselineArtifactReference(projectDir, space) }),
    requested_outputs: ["system-map-patch", "current-context-proposal"],
    rules: [
      "Observe only the Design Brief scope and explicitly record unknown or out-of-scope areas.",
      "Use only accepted-code-baseline state; never mix working, planned, or production state.",
      "Every observed fact must cite Evidence from a declared source snapshot.",
      "AI proposes content only; Core validates and owns persistence and Stage routing.",
      "System Map is JSON-only by default; do not generate HTML without a human request.",
    ],
    created_at: observedAt,
  });
  const requestContent = serialize(request);
  writeFileAtomic(requestPath, requestContent);
  const reference = artifactReference(
    projectDir,
    requestPath,
    "orient-work-request",
    requestContent,
  );
  const { parked_reason: _parkedReason, ...unparkedState } = state;
  writeVNextStateAt(recordDir, {
    ...unparkedState,
    status: "ready",
    updated_at: observedAt,
  }, plan);
  return { execution: "prepared", profile, profileReference, request, reference };
}

export function prepareOrient(
  projectDir: string,
  options: OrientPrepareOptions = {},
): OrientPrepareResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return prepareOrientLocked(projectRoot, recordDir, options);
    } catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-01",
        Reason: (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " "),
        "Decision Authority": "core",
      });
      throw error;
    }
  });
}

function upsertById<T>(
  existing: readonly T[],
  updates: readonly T[],
  removals: readonly string[],
  id: (value: T) => string,
): T[] {
  const values = new Map(existing.map((entry) => [id(entry), entry]));
  for (const remove of removals) values.delete(remove);
  for (const update of updates) values.set(id(update), update);
  return [...values.values()].sort((left, right) => id(left).localeCompare(id(right)));
}

function assertPatchSnapshots(
  profile: WorkspaceProfile,
  patchSnapshots: readonly SourceSnapshot[],
  existing: SystemMap | null,
): void {
  const profileById = new Map(profile.repository_snapshots.map((entry) => [entry.source_id, entry]));
  for (const snapshot of patchSnapshots) {
    if (snapshot.source_type === "external") {
      if (snapshot.expires_at !== undefined && Date.parse(snapshot.expires_at) <= Date.now()) {
        fail("ST-01 Orient", `external source is expired: ${snapshot.source_id}`);
      }
      continue;
    }
    const expected = profileById.get(snapshot.source_id);
    if (expected === undefined) {
      fail("ST-01 Orient", `Patch contains an unselected Repository source: ${snapshot.source_id}`);
    }
    if (
      JSON.stringify(comparableSnapshots([snapshot])) !==
        JSON.stringify(comparableSnapshots([expected]))
    ) fail("ST-01 Orient", `Patch source snapshot does not match Workspace Profile: ${snapshot.source_id}`);
  }
  if (existing !== null) {
    const existingById = new Map(existing.source_snapshots.map((entry) => [entry.source_id, entry]));
    for (const snapshot of patchSnapshots) {
      const previous = existingById.get(snapshot.source_id);
      if (
        previous !== undefined && snapshot.source_type !== "external" &&
        (previous.revision !== snapshot.revision || previous.locator !== snapshot.locator)
      ) {
        fail(
          "ST-01 Orient",
          `source ${snapshot.source_id} changed from the accepted baseline; promotion requires ST-07`,
        );
      }
    }
  }
}

function assertEvidence(
  projectDir: string,
  snapshots: readonly SourceSnapshot[],
  evidence: readonly MapEvidence[],
): void {
  const sources = new Map(snapshots.map((entry) => [entry.source_id, entry]));
  for (const item of evidence) {
    const source = sources.get(item.source_id);
    if (source === undefined) fail("ST-01 Orient", `Evidence source is unknown: ${item.source_id}`);
    if (item.evidence_type === "external-record") {
      if (source.source_type !== "external") {
        fail("ST-01 Orient", `external Evidence requires an external source: ${item.evidence_id}`);
      }
      continue;
    }
    if (source.source_type === "external") {
      fail("ST-01 Orient", `file Evidence cannot use an external source: ${item.evidence_id}`);
    }
    if (isAbsolute(item.locator) || item.locator.split(/[\\/]/).includes("..")) {
      fail("ST-01 Orient", `Evidence locator escapes Repository: ${item.locator}`);
    }
    const repositoryRoot = resolve(projectDir, source.locator);
    const evidencePath = resolve(repositoryRoot, item.locator);
    if (!isInside(repositoryRoot, evidencePath)) {
      fail("ST-01 Orient", `Evidence locator escapes Repository: ${item.locator}`);
    }
    if (!existsSync(evidencePath) || !lstatSync(evidencePath).isFile()) {
      fail("ST-01 Orient", `Evidence file does not exist: ${item.locator}`);
    }
    if (digest(readFileSync(evidencePath)) !== item.sha256) {
      fail("ST-01 Orient", `Evidence SHA-256 does not match: ${item.locator}`);
    }
  }
}

function applyPatch(
  existing: SystemMap | null,
  proposal: OrientProposal,
  createdAt: string,
): SystemMap {
  const patch = proposal.system_map_patch;
  const currentRevision = existing?.revision ?? null;
  if (patch.base_revision !== currentRevision) {
    fail(
      "ST-01 Orient",
      `Patch base_revision ${String(patch.base_revision)} does not match current revision ${String(currentRevision)}`,
    );
  }
  if (existing !== null && patch.map_id !== existing.map_id) {
    fail("ST-01 Orient", "Patch map_id does not match the shared System Map");
  }
  const changedSourceIds = new Set<string>();
  const existingSources = new Map(
    (existing?.source_snapshots ?? []).map((entry) => [entry.source_id, entry]),
  );
  for (const snapshot of patch.source_snapshots) {
    const previous = existingSources.get(snapshot.source_id);
    if (
      previous !== undefined &&
      (previous.revision !== snapshot.revision || previous.locator !== snapshot.locator)
    ) changedSourceIds.add(snapshot.source_id);
  }
  const changedEvidenceIds = new Set<string>();
  const existingEvidence = new Map(
    (existing?.evidence ?? []).map((entry) => [entry.evidence_id, entry]),
  );
  for (const item of existing?.evidence ?? []) {
    if (changedSourceIds.has(item.source_id)) changedEvidenceIds.add(item.evidence_id);
  }
  for (const item of patch.evidence) {
    const previous = existingEvidence.get(item.evidence_id);
    if (
      previous !== undefined &&
      (previous.source_id !== item.source_id || previous.locator !== item.locator ||
        previous.sha256 !== item.sha256)
    ) changedEvidenceIds.add(item.evidence_id);
  }
  const dependsOnChangedEvidence = (entry: { evidence_refs: readonly string[] }): boolean =>
    entry.evidence_refs.some((reference) => changedEvidenceIds.has(reference));
  const staleCoverage = (existing?.coverage ?? []).map((entry) =>
    dependsOnChangedEvidence(entry) ? { ...entry, status: "stale" as const } : entry
  );
  const staleEntities = (existing?.entities ?? []).map((entry) =>
    dependsOnChangedEvidence(entry) ? { ...entry, current_state: "stale" as const } : entry
  );
  const staleRelations = (existing?.relations ?? []).map((entry) =>
    dependsOnChangedEvidence(entry) ? { ...entry, current_state: "stale" as const } : entry
  );
  const sources = upsertById(
    existing?.source_snapshots ?? [],
    patch.source_snapshots,
    [],
    (entry) => entry.source_id,
  );
  const evidence = upsertById<MapEvidence>(
    existing?.evidence ?? [],
    patch.evidence,
    [],
    (entry) => entry.evidence_id,
  );
  const coverage = upsertById<MapCoverage>(
    staleCoverage,
    patch.coverage_upserts,
    [],
    (entry) => entry.coverage_id,
  );
  const entities = upsertById<MapEntity>(
    staleEntities,
    patch.entity_upserts,
    patch.remove_entity_ids,
    (entry) => entry.entity_id,
  );
  const relations = upsertById<MapRelation>(
    staleRelations,
    patch.relation_upserts,
    patch.remove_relation_ids,
    (entry) => entry.relation_id,
  );
  return parseSystemMap({
    schema_version: 1,
    artifact: "system-map",
    version: 1,
    map_id: patch.map_id,
    revision: (currentRevision ?? 0) + 1,
    base_revision: currentRevision,
    baseline_kind: existing === null ? "imported" : "accepted",
    perspective: "accepted-code-baseline",
    source_snapshots: sources,
    evidence,
    coverage,
    entities,
    relations,
    created_at: createdAt,
  });
}

function assertContextSelection(
  proposal: OrientProposal,
  map: SystemMap,
): void {
  const entityIds = new Set(map.entities.map((entry) => entry.entity_id));
  const relationIds = new Set(map.relations.map((entry) => entry.relation_id));
  for (const id of proposal.current_context.entity_ids) {
    if (!entityIds.has(id)) fail("ST-01 Orient", `Current Context selects unknown entity_id: ${id}`);
  }
  for (const id of proposal.current_context.relation_ids) {
    if (!relationIds.has(id)) fail("ST-01 Orient", `Current Context selects unknown relation_id: ${id}`);
  }
}

function completeOrientLocked(
  projectDir: string,
  recordDir: string,
  proposalValue: unknown,
  options: OrientCompleteOptions,
): OrientCompleteResult {
  const state = readVNextStateAt(recordDir);
  if (state.current_stage !== "ST-01") {
    fail("ST-01 Orient", `current Stage must be ST-01, found ${state.current_stage}`);
  }
  const plan = readVNextPlanAt(recordDir);
  const prepared = prepareOrientLocked(projectDir, recordDir, {});
  const proposal = parseOrientProposal(proposalValue);
  if (proposal.intent_id !== state.intent_id) fail("ST-01 Orient", "Proposal Intent does not match State");
  if (proposal.work_request_sha256 !== prepared.reference.sha256) {
    fail("ST-01 Orient", "Proposal does not reference the current Orient Work Request");
  }
  const space = activeSpace(projectDir);
  const current = readBaseline(projectDir, space);
  const currentMap = current?.map ?? null;
  const currentRevision = currentMap?.revision ?? null;
  if (proposal.system_map_patch.base_revision !== currentRevision) {
    fail(
      "ST-01 Orient",
      `Patch base_revision ${String(proposal.system_map_patch.base_revision)} does not match current revision ${String(currentRevision)}`,
    );
  }
  assertPatchSnapshots(prepared.profile, proposal.system_map_patch.source_snapshots, currentMap);
  const allSnapshots = upsertById(
    currentMap?.source_snapshots ?? [],
    proposal.system_map_patch.source_snapshots,
    [],
    (entry) => entry.source_id,
  );
  assertEvidence(projectDir, allSnapshots, proposal.system_map_patch.evidence);
  const completedAt = options.completedAt ?? new Date().toISOString();
  const systemMap = applyPatch(currentMap, proposal, completedAt);
  assertContextSelection(proposal, systemMap);

  const mapPath = systemMapRevisionPath(projectDir, space, systemMap.revision);
  const mapContent = serialize(systemMap);
  if (existsSync(mapPath)) {
    if (readFileSync(mapPath, "utf8") !== mapContent) {
      fail("ST-01 Orient", `immutable System Map revision already exists: ${systemMap.revision}`);
    }
  } else {
    writeFileAtomic(mapPath, mapContent);
  }
  const systemMapReference = artifactReference(projectDir, mapPath, "system-map", mapContent);
  const baseline = parseSystemMapBaseline({
    schema_version: 1,
    artifact: "system-map-baseline",
    version: 1,
    map_id: systemMap.map_id,
    revision: systemMap.revision,
    source_of_truth: systemMapReference.source_of_truth,
    sha256: systemMapReference.sha256,
  });
  writeFileAtomic(systemMapBaselinePath(projectDir, space), serialize(baseline));

  const briefReference = artifactReference(
    projectDir,
    designBriefPath(recordDir),
    "design-brief",
  );
  const currentContext = parseCurrentContext({
    schema_version: 1,
    artifact: "current-context",
    version: 1,
    intent_id: state.intent_id,
    design_brief_ref: briefReference,
    workspace_profile_ref: prepared.profileReference,
    system_map_ref: systemMapReference,
    system_map_revision: systemMap.revision,
    ...proposal.current_context,
    created_at: completedAt,
  });
  const contextPath = currentContextPath(recordDir);
  const contextContent = serialize(currentContext);
  writeFileAtomic(contextPath, contextContent);
  const currentContextReference = artifactReference(
    projectDir,
    contextPath,
    "current-context",
    contextContent,
  );

  const definitions = loadVNextDefinitions();
  const nextStage = nextForwardStage(definitions.graph, "ST-01");
  if (nextStage !== "ST-02") fail("ST-01 Orient", "fixed Graph must route to ST-02");
  validateCoreRoute(definitions.graph, { from: "ST-01", to: nextStage });
  const alreadyCompleted = readOrderedAuditEntries(recordDir).some((entry) =>
    entry.event === "STAGE_COMPLETED" && entry.fields.Stage === "ST-01" &&
    entry.fields["System Map SHA-256"] === systemMapReference.sha256
  );
  if (!alreadyCompleted) {
    appendAuditEntries(projectDir, recordDir, [
      {
        event: "STAGE_STARTED",
        fields: { Stage: "ST-01", Executor: "ai+core", Verifier: "system-map-validator" },
      },
      {
        event: "STAGE_COMPLETED",
        fields: {
          Stage: "ST-01",
          Artifact: currentContextReference.source_of_truth,
          "System Map Revision": String(systemMap.revision),
          "System Map SHA-256": systemMapReference.sha256,
          "Decision Authority": "core",
        },
      },
      {
        event: "ROUTE_DECIDED",
        fields: {
          "From Stage": "ST-01",
          "Current Stage": "ST-02",
          Graph: definitions.graph.graph_version,
          "Decision Authority": "core",
        },
      },
    ]);
  }
  const advanced: VNextIntentState = {
    ...state,
    current_stage: "ST-02",
    status: "parked",
    parked_reason: "ST-02 Stage Contract is not implemented yet.",
    updated_at: completedAt,
  };
  writeVNextStateAt(recordDir, advanced, plan);
  return {
    systemMap,
    systemMapReference,
    baseline,
    currentContext,
    currentContextReference,
    state: readVNextStateAt(recordDir),
  };
}

export function completeOrient(
  projectDir: string,
  proposalValue: unknown,
  options: OrientCompleteOptions = {},
): OrientCompleteResult {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () => {
    const recordDir = activeVNextIntentRecordDir(projectRoot);
    try {
      return completeOrientLocked(projectRoot, recordDir, proposalValue, options);
    } catch (error) {
      appendAuditEntry(projectRoot, recordDir, "ROUTE_BLOCKED", {
        Stage: "ST-01",
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
      "Usage: aidlc orient prepare <project-dir>\n" +
        "       aidlc orient complete <project-dir> <proposal.json>",
    );
    process.exitCode = 1;
    return;
  }
  try {
    if (projectDir === undefined) throw new Error("project directory is required");
    const result = command === "prepare"
      ? prepareOrient(projectDir)
      : completeOrient(projectDir, JSON.parse(readFileSync(resolve(proposalPath!), "utf8")));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
