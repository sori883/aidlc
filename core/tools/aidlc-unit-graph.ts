// Deterministic Unit-of-Work DAG parser. The authored fenced YAML block in
// unit-of-work-dependency.md is the source of truth; this module validates it
// and derives stable topological batches without inference.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { activeIntentRecordDir } from "./aidlc-state.ts";

export const UNIT_KINDS = [
  "service",
  "spec",
  "ui",
  "packaging",
  "library",
] as const;

export type UnitKind = (typeof UNIT_KINDS)[number];

export interface UnitDefinition {
  name: string;
  depends_on: string[];
  kind?: UnitKind;
}

export interface UnitDag {
  units: UnitDefinition[];
  batches: string[][];
}

const UNIT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function parseUnits(value: unknown, sourcePath: string): UnitDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(sourcePath, "units must be a non-empty array");
  }
  const names = new Set<string>();
  const units = value.map((entry, index) => {
    const context = `units[${index}]`;
    const row = asRecord(entry, sourcePath, context);
    const unknown = Object.keys(row).filter(
      (key) => !["name", "kind", "depends_on"].includes(key),
    );
    if (unknown.length > 0) {
      fail(sourcePath, `${context} has unknown field(s): ${unknown.join(", ")}`);
    }
    if (typeof row.name !== "string" || !UNIT_NAME_PATTERN.test(row.name)) {
      fail(sourcePath, `${context}.name must use lowercase kebab-case`);
    }
    if (names.has(row.name)) {
      fail(sourcePath, `duplicate unit name "${row.name}"`);
    }
    names.add(row.name);
    if (
      !Array.isArray(row.depends_on) ||
      row.depends_on.some((dependency) => typeof dependency !== "string")
    ) {
      fail(sourcePath, `${context}.depends_on must be a string array`);
    }
    const dependencies = row.depends_on as string[];
    if (new Set(dependencies).size !== dependencies.length) {
      fail(sourcePath, `${context}.depends_on has duplicate entries`);
    }
    const unit: UnitDefinition = {
      name: row.name,
      depends_on: [...dependencies],
    };
    if (row.kind !== undefined) {
      if (!(UNIT_KINDS as readonly unknown[]).includes(row.kind)) {
        fail(
          sourcePath,
          `${context}.kind must be one of: ${UNIT_KINDS.join(", ")}`,
        );
      }
      unit.kind = row.kind as UnitKind;
    }
    return unit;
  });

  for (const unit of units) {
    for (const dependency of unit.depends_on) {
      if (dependency === unit.name) {
        fail(sourcePath, `unit "${unit.name}" cannot depend on itself`);
      }
      if (!names.has(dependency)) {
        fail(
          sourcePath,
          `unit "${unit.name}" has unknown dependency "${dependency}"`,
        );
      }
    }
  }
  return units;
}

function topologicalBatches(
  units: readonly UnitDefinition[],
  sourcePath: string,
): string[][] {
  const remaining = new Map(units.map((unit) => [unit.name, unit]));
  const completed = new Set<string>();
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const batch = [...remaining.values()]
      .filter((unit) =>
        unit.depends_on.every((dependency) => completed.has(dependency))
      )
      .map((unit) => unit.name)
      .sort();
    if (batch.length === 0) {
      fail(
        sourcePath,
        `unit dependency graph is cyclic: ${[...remaining.keys()].sort().join(", ")}`,
      );
    }
    batches.push(batch);
    for (const name of batch) {
      remaining.delete(name);
      completed.add(name);
    }
  }
  return batches;
}

/** Parse the single fenced YAML `units:` block. An absent block returns null. */
export function parseUnitDag(
  source: string,
  sourcePath = "unit-of-work-dependency.md",
): UnitDag | null {
  const blocks = [...source.matchAll(/```ya?ml[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```/gi)];
  const candidates: UnitDefinition[][] = [];
  for (const [index, match] of blocks.entries()) {
    const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
    if (document.errors.length > 0) {
      fail(
        sourcePath,
        `invalid YAML block ${index + 1}: ` +
          document.errors.map((error) => error.message).join("; "),
      );
    }
    const value = document.toJS() as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const row = value as Record<string, unknown>;
    if (!("units" in row)) continue;
    const unknown = Object.keys(row).filter((key) => key !== "units");
    if (unknown.length > 0) {
      fail(
        sourcePath,
        `unit DAG block has unknown top-level field(s): ${unknown.join(", ")}`,
      );
    }
    candidates.push(parseUnits(row.units, sourcePath));
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    fail(sourcePath, "multiple fenced YAML units blocks are not allowed");
  }
  const units = candidates[0]!;
  return { units, batches: topologicalBatches(units, sourcePath) };
}

export function activeUnitDagPath(projectDir: string): string {
  return join(
    activeIntentRecordDir(projectDir),
    "inception",
    "units-generation",
    "unit-of-work-dependency.md",
  );
}

/** Read and parse the active Intent's Unit DAG. Missing artifact returns null. */
export function loadActiveUnitDag(projectDir: string): UnitDag | null {
  const path = activeUnitDagPath(projectDir);
  if (!existsSync(path)) return null;
  return parseUnitDag(readFileSync(path, "utf8"), path);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  if (!["check", "show"].includes(command ?? "")) {
    console.error(
      "Usage: aidlc-unit-graph <check|show> [--project-dir <dir>]",
    );
    process.exitCode = 1;
    return;
  }
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  try {
    const dag = loadActiveUnitDag(projectDir);
    if (command === "show") {
      console.log(JSON.stringify(dag, null, 2));
      return;
    }
    if (dag === null) {
      console.log("No Unit DAG: Construction uses single-pass execution.");
      return;
    }
    console.log(
      `Unit DAG is valid: ${dag.units.length} units, ${dag.batches.length} batches`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
