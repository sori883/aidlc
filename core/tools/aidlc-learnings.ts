// Deterministic half of the Stage learning gate. `surface` converts canonical
// Stage memory entries into stable candidates. `persist` writes only selections
// already confirmed and admission-checked by the future Conductor.

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendAuditEntry } from "./aidlc-audit.ts";
import { loadCompiledStageGraph } from "./aidlc-graph.ts";
import {
  type MemoryEntry,
  readStageMemory,
} from "./aidlc-memory.ts";
import {
  parseRuleFrontmatter,
  parseRuleHeadings,
} from "./aidlc-rule-loader.ts";
import { activeIntentRecordDir } from "./aidlc-state.ts";
import { activeSpace } from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";
import { loadActiveUnitDag } from "./aidlc-unit-graph.ts";

export interface LearningCandidate {
  id: string;
  source_heading: Exclude<MemoryEntry["heading"], "Open Questions">;
  ts: string;
  summary: string;
  context: string;
  default_scope: "project";
}

export interface ParkedOpenQuestion {
  id: string;
  ts: string;
  summary: string;
  context: string;
}

export interface SurfacedLearnings {
  stage: string;
  memory_path: string;
  candidates: LearningCandidate[];
  parked_open_questions: ParkedOpenQuestion[];
}

export type LearningScope = "project" | "team";
export type AdmissionDecision = "clear" | "escalated";

export interface LearningSelection {
  id: string;
  scope: LearningScope;
  heading: string;
  admission: AdmissionDecision;
}

export interface LearningSelectionsFile {
  version: 1;
  stage: string;
  anything_to_add_answered: true;
  selections: LearningSelection[];
}

export interface PersistedLearning {
  id: string;
  scope: LearningScope;
  heading: string;
  admission: AdmissionDecision;
  path: string;
  already_present: boolean;
}

export interface PersistLearningsResult {
  stage: string;
  persisted: PersistedLearning[];
  receipt_path: string;
}

function candidateId(stage: string, entry: MemoryEntry): string {
  return createHash("sha256")
    .update(JSON.stringify({
      stage,
      heading: entry.heading,
      timestamp: entry.timestamp,
      summary: entry.summary,
      context: entry.context,
    }))
    .digest("hex")
    .slice(0, 16);
}

export function stageMemoryPath(
  projectDir: string,
  slug: string,
  unit?: string,
): string {
  const stage = loadCompiledStageGraph().find((candidate) => candidate.slug === slug);
  if (stage === undefined) throw new Error(`Unknown Stage slug: ${slug}`);
  const recordDir = activeIntentRecordDir(projectDir);
  if (stage.for_each === "unit-of-work") {
    const selectedUnit = unit?.trim();
    if (!selectedUnit) {
      if (loadActiveUnitDag(projectDir) === null) {
        return join(recordDir, stage.phase, slug, "memory.md");
      }
      throw new Error(`Stage "${slug}" requires --unit <name> to locate memory.md.`);
    }
    if (
      selectedUnit === "." || selectedUnit === ".." ||
      selectedUnit.includes("/") || selectedUnit.includes("\\")
    ) throw new Error("Unit name must be one safe path segment.");
    return join(recordDir, stage.phase, selectedUnit, slug, "memory.md");
  }
  if (unit !== undefined) {
    throw new Error(`Stage "${slug}" is not per-Unit; do not pass --unit.`);
  }
  return join(recordDir, stage.phase, slug, "memory.md");
}

export function surfaceLearnings(
  projectDir: string,
  slug: string,
  unit?: string,
): SurfacedLearnings {
  const memoryPath = stageMemoryPath(projectDir, slug, unit);
  const memory = readStageMemory(projectDir, memoryPath);
  const candidates: LearningCandidate[] = [];
  const parked: ParkedOpenQuestion[] = [];

  for (const entry of memory.entries) {
    const id = candidateId(slug, entry);
    if (entry.heading === "Open Questions") {
      parked.push({
        id,
        ts: entry.timestamp,
        summary: entry.summary,
        context: entry.context,
      });
    } else {
      candidates.push({
        id,
        source_heading: entry.heading,
        ts: entry.timestamp,
        summary: entry.summary,
        context: entry.context,
        default_scope: "project",
      });
    }
  }
  return {
    stage: slug,
    memory_path: relative(resolve(projectDir), memory.path),
    candidates,
    parked_open_questions: parked,
  };
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseSelections(
  source: string,
  sourcePath: string,
): LearningSelectionsFile {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourcePath}: invalid JSON: ${detail}`);
  }
  const record = asRecord(value, sourcePath);
  const unknown = Object.keys(record).filter((key) =>
    !["version", "stage", "anything_to_add_answered", "selections"].includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(`${sourcePath}: unknown field(s): ${unknown.join(", ")}`);
  }
  if (
    record.version !== 1 || typeof record.stage !== "string" ||
    record.anything_to_add_answered !== true
  ) {
    throw new Error(
      `${sourcePath}: version must be 1, stage must be a string, and ` +
        "anything_to_add_answered must be true",
    );
  }
  if (!Array.isArray(record.selections)) {
    throw new Error(`${sourcePath}: selections must be an array`);
  }
  const selections = record.selections.map((item, index): LearningSelection => {
    const selection = asRecord(item, `${sourcePath}: selections[${index}]`);
    const extra = Object.keys(selection).filter((key) =>
      !["id", "scope", "heading", "admission"].includes(key)
    );
    if (extra.length > 0) {
      throw new Error(
        `${sourcePath}: selections[${index}] unknown field(s): ${extra.join(", ")}`,
      );
    }
    if (
      typeof selection.id !== "string" || !/^[a-f0-9]{16}$/.test(selection.id) ||
      (selection.scope !== "project" && selection.scope !== "team") ||
      typeof selection.heading !== "string" || selection.heading.trim() === "" ||
      (selection.admission !== "clear" && selection.admission !== "escalated")
    ) {
      throw new Error(`${sourcePath}: invalid selections[${index}]`);
    }
    return {
      id: selection.id,
      scope: selection.scope,
      heading: selection.heading.trim(),
      admission: selection.admission,
    };
  });
  return {
    version: 1,
    stage: record.stage,
    anything_to_add_answered: true,
    selections,
  };
}

function learningReceiptPath(
  projectDir: string,
  slug: string,
  unit?: string,
): string {
  const suffix = unit === undefined ? "" : `-${unit}`;
  return join(
    activeIntentRecordDir(projectDir),
    ".aidlc-learnings",
    `${slug}${suffix}-receipt.json`,
  );
}

function memoryDigest(projectDir: string, slug: string, unit?: string): string {
  return createHash("sha256")
    .update(readFileSync(stageMemoryPath(projectDir, slug, unit), "utf8"))
    .digest("hex");
}

/** Verify that the mandatory learning question was answered for current Memory. */
export function assertLearningGateCompleted(
  projectDir: string,
  slug: string,
  unit?: string,
): void {
  const path = learningReceiptPath(projectDir, slug, unit);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `Learning gate is incomplete for "${slug}". Run learnings:surface, ` +
        "answer the mandatory question, then run learnings:persist.",
    );
  }
  const receipt = asRecord(value, path);
  if (
    receipt.version !== 1 || receipt.stage !== slug ||
    receipt.unit !== (unit ?? null) ||
    receipt.anything_to_add_answered !== true ||
    receipt.memory_sha256 !== memoryDigest(projectDir, slug, unit)
  ) {
    throw new Error(
      `Learning gate receipt is stale or invalid for "${slug}"; surface and persist again.`,
    );
  }
}

function selectionsPath(
  projectDir: string,
  providedPath: string,
): string {
  const recordDir = resolve(activeIntentRecordDir(projectDir));
  const allowedDir = join(recordDir, ".aidlc-learnings");
  const path = isAbsolute(providedPath)
    ? resolve(providedPath)
    : resolve(projectDir, providedPath);
  const fromAllowed = relative(allowedDir, path);
  if (
    fromAllowed === "" || fromAllowed.startsWith("..") || isAbsolute(fromAllowed) ||
    !path.endsWith(".json")
  ) {
    throw new Error(
      `Selections JSON must be a file under ${allowedDir}: ${providedPath}`,
    );
  }
  return path;
}

function insertRuleEntry(
  source: string,
  sourcePath: string,
  heading: string,
  line: string,
): string {
  const headings = parseRuleHeadings(source);
  if (!headings.has(heading)) {
    throw new Error(`${sourcePath}: destination heading does not exist: ## ${heading}`);
  }
  const marker = `## ${heading}`;
  const start = source.indexOf(marker);
  const next = source.indexOf("\n## ", start + marker.length);
  const insertion = next < 0 ? source.length : next;
  const before = source.slice(0, insertion).replace(/\n*$/, "\n");
  const after = source.slice(insertion).replace(/^\n*/, "\n");
  return `${before}${line}\n${after}`;
}

/** Persist only human-confirmed, conflict-cleared/escalated Rule selections. */
export function persistLearnings(
  projectDir: string,
  slug: string,
  providedSelectionsPath: string,
  unit?: string,
): PersistLearningsResult {
  const path = selectionsPath(projectDir, providedSelectionsPath);
  const selections = parseSelections(readFileSync(path, "utf8"), path);
  if (selections.stage !== slug) {
    throw new Error(
      `${path}: selections stage "${selections.stage}" does not match "${slug}"`,
    );
  }
  const duplicate = selections.selections.find((selection, index, all) =>
    all.findIndex((candidate) => candidate.id === selection.id) !== index
  );
  if (duplicate !== undefined) {
    throw new Error(`${path}: duplicate learning selection: ${duplicate.id}`);
  }

  return withWorkspaceLock(projectDir, () => {
    const surfaced = surfaceLearnings(projectDir, slug, unit);
    const candidates = new Map(surfaced.candidates.map((candidate) => [
      candidate.id,
      candidate,
    ]));
    const space = activeSpace(projectDir);
    const memoryDir = join(projectDir, "aidlc", "spaces", space, "memory");
    const pending = new Map<string, string>();
    const persisted: PersistedLearning[] = [];

    for (const selection of selections.selections) {
      const candidate = candidates.get(selection.id);
      if (candidate === undefined) {
        throw new Error(
          `${path}: selection ${selection.id} is not a surfaced candidate for ${slug}`,
        );
      }
      const targetPath = join(memoryDir, `${selection.scope}.md`);
      let target = pending.get(targetPath) ?? readFileSync(targetPath, "utf8");
      parseRuleFrontmatter(target, targetPath);
      const cid = `<!-- cid:${slug}:${candidate.id} -->`;
      const alreadyPresent = target.includes(cid);
      if (!alreadyPresent) {
        const line =
          `- ${candidate.ts} — ${candidate.summary}; ${candidate.context} ${cid}`;
        target = insertRuleEntry(target, targetPath, selection.heading, line);
        pending.set(targetPath, target);
      }
      persisted.push({
        id: candidate.id,
        scope: selection.scope,
        heading: selection.heading,
        admission: selection.admission,
        path: relative(resolve(projectDir), targetPath),
        already_present: alreadyPresent,
      });
    }

    for (const [targetPath, source] of pending) {
      writeFileSync(targetPath, source, "utf8");
    }
    const recordDir = activeIntentRecordDir(projectDir);
    for (const learning of persisted) {
      if (learning.already_present) continue;
      appendAuditEntry(projectDir, recordDir, "RULE_LEARNED", {
        Stage: slug,
        Candidate: learning.id,
        Scope: learning.scope,
        Heading: learning.heading,
        Admission: learning.admission,
        Destination: learning.path,
      });
    }
    const receiptPath = learningReceiptPath(projectDir, slug, unit);
    writeFileSync(receiptPath, `${JSON.stringify({
      version: 1,
      stage: slug,
      unit: unit ?? null,
      anything_to_add_answered: true,
      memory_sha256: memoryDigest(projectDir, slug, unit),
      selections_sha256: createHash("sha256")
        .update(readFileSync(path, "utf8"))
        .digest("hex"),
      persisted_ids: persisted.map((learning) => learning.id),
      completed_at: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    return {
      stage: slug,
      persisted,
      receipt_path: relative(resolve(projectDir), receiptPath),
    };
  });
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  const slug = flagValue(args, "--slug");
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  const unit = flagValue(args, "--unit");
  const usage =
    "Usage: aidlc-learnings surface --slug <stage> [--unit <name>] " +
    "[--project-dir <dir>]\n" +
    "       aidlc-learnings persist --slug <stage> --selections-json <path> " +
    "[--unit <name>] [--project-dir <dir>]";
  if (!(["surface", "persist"] as const).includes(command as "surface" | "persist") ||
    slug === undefined) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  try {
    if (command === "surface") {
      console.log(JSON.stringify(surfaceLearnings(projectDir, slug, unit), null, 2));
      return;
    }
    const selection = flagValue(args, "--selections-json");
    if (selection === undefined) throw new Error("persist requires --selections-json");
    console.log(JSON.stringify(
      persistLearnings(projectDir, slug, selection, unit),
      null,
      2,
    ));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
