// Deterministic parser for the machine-readable contract embedded in
// inception/delivery-planning/bolt-plan.md.

import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { UnitDag } from "./aidlc-unit-graph.ts";

export const BOLT_PLAN_SCHEMA_VERSION = 1 as const;

export interface BoltDefinition {
  id: string;
  slug: string;
  units: string[];
  dependsOn: string[];
  walkingSkeleton: boolean;
  batch: number;
}

export interface BoltWorktreePlan {
  enabled: boolean;
  baseRef: string;
  targetBranch: string;
  strategy: "squash" | "merge" | "rebase";
}

export interface BoltPlan {
  schemaVersion: typeof BOLT_PLAN_SCHEMA_VERSION;
  bolts: BoltDefinition[];
  batches: string[][];
  worktree: BoltWorktreePlan;
  hash: string;
}

const BOLT_ID = /^B[1-9][0-9]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(sourcePath: string, message: string): never {
  throw new Error(`${sourcePath}: ${message}`);
}

function asRecord(
  value: unknown,
  sourcePath: string,
  context: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(sourcePath, `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  sourcePath: string,
  context: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(sourcePath, `${context} has unknown field(s): ${unknown.join(", ")}`);
  }
}

function parseStringArray(
  value: unknown,
  sourcePath: string,
  context: string,
  allowEmpty: boolean,
): string[] {
  if (
    !Array.isArray(value) || (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    fail(
      sourcePath,
      `${context} must be ${allowEmpty ? "a" : "a non-empty"} string array`,
    );
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    fail(sourcePath, `${context} has duplicate entries`);
  }
  return [...result];
}

function parseBolts(value: unknown, sourcePath: string): BoltDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(sourcePath, "bolt_plan.bolts must be a non-empty array");
  }
  const ids = new Set<string>();
  const slugs = new Set<string>();
  return value.map((entry, index) => {
    const context = `bolt_plan.bolts[${index}]`;
    const row = asRecord(entry, sourcePath, context);
    exactKeys(
      row,
      ["id", "slug", "units", "depends_on", "walking_skeleton", "batch"],
      sourcePath,
      context,
    );
    if (typeof row.id !== "string" || !BOLT_ID.test(row.id)) {
      fail(sourcePath, `${context}.id must match B<positive-integer>`);
    }
    if (ids.has(row.id)) fail(sourcePath, `duplicate Bolt id "${row.id}"`);
    ids.add(row.id);
    if (typeof row.slug !== "string" || !SLUG.test(row.slug)) {
      fail(sourcePath, `${context}.slug must use lowercase kebab-case`);
    }
    if (slugs.has(row.slug)) fail(sourcePath, `duplicate Bolt slug "${row.slug}"`);
    slugs.add(row.slug);
    if (typeof row.walking_skeleton !== "boolean") {
      fail(sourcePath, `${context}.walking_skeleton must be boolean`);
    }
    if (!Number.isSafeInteger(row.batch) || Number(row.batch) < 1) {
      fail(sourcePath, `${context}.batch must be a positive integer`);
    }
    return {
      id: row.id,
      slug: row.slug,
      units: parseStringArray(row.units, sourcePath, `${context}.units`, false),
      dependsOn: parseStringArray(
        row.depends_on,
        sourcePath,
        `${context}.depends_on`,
        true,
      ),
      walkingSkeleton: row.walking_skeleton,
      batch: Number(row.batch),
    };
  });
}

function parseWorktree(value: unknown, sourcePath: string): BoltWorktreePlan {
  const row = asRecord(value, sourcePath, "bolt_plan.worktree");
  exactKeys(
    row,
    ["enabled", "base_ref", "target_branch", "strategy"],
    sourcePath,
    "bolt_plan.worktree",
  );
  if (typeof row.enabled !== "boolean") {
    fail(sourcePath, "bolt_plan.worktree.enabled must be boolean");
  }
  for (const field of ["base_ref", "target_branch"] as const) {
    if (
      typeof row[field] !== "string" || row[field].trim() === "" ||
      /[\r\n]/.test(row[field])
    ) fail(sourcePath, `bolt_plan.worktree.${field} must be a non-empty single-line string`);
  }
  if (!new Set(["squash", "merge", "rebase"]).has(String(row.strategy))) {
    fail(sourcePath, "bolt_plan.worktree.strategy must be squash, merge, or rebase");
  }
  return {
    enabled: row.enabled,
    baseRef: row.base_ref as string,
    targetBranch: row.target_branch as string,
    strategy: row.strategy as BoltWorktreePlan["strategy"],
  };
}

function topologicalBatches(
  bolts: readonly BoltDefinition[],
  sourcePath: string,
): string[][] {
  const byId = new Map(bolts.map((bolt) => [bolt.id, bolt]));
  for (const bolt of bolts) {
    for (const dependency of bolt.dependsOn) {
      if (dependency === bolt.id) {
        fail(sourcePath, `Bolt "${bolt.id}" cannot depend on itself`);
      }
      if (!byId.has(dependency)) {
        fail(sourcePath, `Bolt "${bolt.id}" has unknown dependency "${dependency}"`);
      }
    }
  }
  const remaining = new Set(bolts.map((bolt) => bolt.id));
  const completed = new Set<string>();
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const batch = bolts
      .filter((bolt) => remaining.has(bolt.id))
      .filter((bolt) => bolt.dependsOn.every((dependency) => completed.has(dependency)))
      .map((bolt) => bolt.id);
    if (batch.length === 0) {
      fail(
        sourcePath,
        `Bolt dependency graph is cyclic: ${[...remaining].join(", ")}`,
      );
    }
    batches.push(batch);
    for (const id of batch) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return batches;
}

function dependsTransitively(
  bolt: BoltDefinition,
  target: string,
  byId: ReadonlyMap<string, BoltDefinition>,
  visited = new Set<string>(),
): boolean {
  for (const dependency of bolt.dependsOn) {
    if (dependency === target) return true;
    if (visited.has(dependency)) continue;
    visited.add(dependency);
    const candidate = byId.get(dependency);
    if (candidate !== undefined && dependsTransitively(candidate, target, byId, visited)) {
      return true;
    }
  }
  return false;
}

function validateAgainstUnits(
  bolts: readonly BoltDefinition[],
  unitDag: UnitDag,
  sourcePath: string,
): void {
  const units = new Map(unitDag.units.map((unit) => [unit.name, unit]));
  for (const bolt of bolts) {
    for (const unit of bolt.units) {
      if (!units.has(unit)) fail(sourcePath, `Bolt "${bolt.id}" references unknown Unit "${unit}"`);
    }
  }
  for (const unit of units.keys()) {
    if (!bolts.some((bolt) => bolt.units.includes(unit))) {
      fail(sourcePath, `Unit "${unit}" is not covered by any Bolt`);
    }
  }

  const byId = new Map(bolts.map((bolt) => [bolt.id, bolt]));
  for (const bolt of bolts) {
    for (const unitName of bolt.units) {
      const unit = units.get(unitName)!;
      for (const unitDependency of unit.depends_on) {
        if (bolt.units.includes(unitDependency)) continue;
        const providers = bolts.filter((candidate) =>
          candidate.units.includes(unitDependency) && candidate.batch < bolt.batch
        );
        if (!providers.some((provider) => dependsTransitively(bolt, provider.id, byId))) {
          fail(
            sourcePath,
            `Unit dependency "${unitName}" -> "${unitDependency}" in Bolt ` +
              `"${bolt.id}" is not backed by a preceding Bolt dependency`,
          );
        }
      }
    }
  }
}

function canonicalHash(
  bolts: readonly BoltDefinition[],
  worktree: BoltWorktreePlan,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: BOLT_PLAN_SCHEMA_VERSION,
    bolts,
    worktree,
  })).digest("hex");
}

/** Parse the single fenced YAML `bolt_plan:` contract. */
export function parseBoltPlan(
  source: string,
  unitDag: UnitDag,
  sourcePath = "bolt-plan.md",
): BoltPlan {
  const blocks = [...source.matchAll(/```ya?ml[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```/gi)];
  const candidates: Array<{
    bolts: BoltDefinition[];
    worktree: BoltWorktreePlan;
  }> = [];
  for (const [index, block] of blocks.entries()) {
    const document = parseDocument(block[1] ?? "", { uniqueKeys: true });
    if (document.errors.length > 0) {
      fail(
        sourcePath,
        `invalid YAML block ${index + 1}: ` +
          document.errors.map((error) => error.message).join("; "),
      );
    }
    const root = document.toJS() as unknown;
    if (typeof root !== "object" || root === null || Array.isArray(root)) continue;
    const top = root as Record<string, unknown>;
    if (!("bolt_plan" in top)) continue;
    exactKeys(top, ["bolt_plan"], sourcePath, "Bolt Plan YAML block");
    const contract = asRecord(top.bolt_plan, sourcePath, "bolt_plan");
    exactKeys(contract, ["version", "worktree", "bolts"], sourcePath, "bolt_plan");
    if (contract.version !== BOLT_PLAN_SCHEMA_VERSION) {
      fail(
        sourcePath,
        `bolt_plan.version must be ${BOLT_PLAN_SCHEMA_VERSION}`,
      );
    }
    candidates.push({
      bolts: parseBolts(contract.bolts, sourcePath),
      worktree: parseWorktree(contract.worktree, sourcePath),
    });
  }
  if (candidates.length === 0) fail(sourcePath, "missing fenced YAML bolt_plan block");
  if (candidates.length > 1) fail(sourcePath, "multiple fenced YAML bolt_plan blocks are not allowed");
  const { bolts, worktree } = candidates[0]!;
  const skeletons = bolts.filter((bolt) => bolt.walkingSkeleton);
  if (skeletons.length !== 1) fail(sourcePath, "Bolt Plan must contain exactly one walking skeleton");
  if (
    bolts[0]?.id !== "B1" || !bolts[0].walkingSkeleton ||
    bolts[0].batch !== 1 || bolts[0].dependsOn.length !== 0
  ) {
    fail(sourcePath, "B1 must be the first, dependency-free walking skeleton in batch 1");
  }
  const batches = topologicalBatches(bolts, sourcePath);
  for (const [index, batch] of batches.entries()) {
    const expected = index + 1;
    for (const id of batch) {
      const declared = bolts.find((bolt) => bolt.id === id)!.batch;
      if (declared !== expected) {
        fail(
          sourcePath,
          `Bolt "${id}" declares batch ${declared}; dependency graph requires batch ${expected}`,
        );
      }
    }
  }
  validateAgainstUnits(bolts, unitDag, sourcePath);
  return {
    schemaVersion: BOLT_PLAN_SCHEMA_VERSION,
    bolts,
    batches,
    worktree,
    hash: canonicalHash(bolts, worktree),
  };
}
