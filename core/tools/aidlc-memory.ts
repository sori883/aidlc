// Per-stage execution diary. Unlike Space memory Rules, this file is scoped to
// one Stage attempt inside the active Intent and records what happened during
// execution for the later Learnings Ritual.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { activeIntentRecordDir } from "./aidlc-state.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export const MEMORY_HEADINGS = [
  "Interpretations",
  "Deviations",
  "Tradeoffs",
  "Open Questions",
] as const;

export type MemoryHeading = typeof MEMORY_HEADINGS[number];

export interface MemoryEntry {
  heading: MemoryHeading;
  timestamp: string;
  summary: string;
  context: string;
}

export interface StageMemory {
  path: string;
  entries: MemoryEntry[];
}

export interface MemoryInitialization {
  path: string;
  created: boolean;
}

export const STAGE_MEMORY_TEMPLATE = `# Stage Memory

## Interpretations

## Deviations

## Tradeoffs

## Open Questions
`;

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function resolveStageMemoryPath(
  projectDir: string,
  memoryPath: string,
): string {
  const projectRoot = resolve(projectDir);
  const recordDir = resolve(activeIntentRecordDir(projectRoot));
  const path = isAbsolute(memoryPath)
    ? resolve(memoryPath)
    : resolve(projectRoot, memoryPath);
  if (!pathIsWithin(recordDir, path) || !path.endsWith("/memory.md")) {
    throw new Error(
      `Stage memory path must be memory.md inside the active Intent: ${memoryPath}`,
    );
  }
  return path;
}

/** Create the canonical diary once. Existing Stage memory is never overwritten. */
export function ensureStageMemory(
  projectDir: string,
  memoryPath: string,
): MemoryInitialization {
  const path = resolveStageMemoryPath(projectDir, memoryPath);
  return withWorkspaceLock(projectDir, () => {
    if (existsSync(path)) return { path, created: false };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, STAGE_MEMORY_TEMPLATE, {
      encoding: "utf8",
      flag: "wx",
    });
    return { path, created: true };
  });
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

/** Parse the four canonical diary sections without LLM classification. */
export function parseStageMemory(source: string, sourcePath: string): StageMemory {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const found = new Set<MemoryHeading>();
  const entries: MemoryEntry[] = [];
  let current: MemoryHeading | undefined;

  for (const [index, line] of lines.entries()) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      current = (MEMORY_HEADINGS as readonly string[]).includes(heading)
        ? heading as MemoryHeading
        : undefined;
      if (current !== undefined) {
        if (found.has(current)) {
          throw new Error(`${sourcePath}:${index + 1}: duplicate ## ${current}`);
        }
        found.add(current);
      }
      continue;
    }
    const trimmed = line.trim();
    if (current === undefined || trimmed === "" || /^<!--.*-->$/.test(trimmed)) {
      continue;
    }
    const match = /^- (\S+) — (.+?); (.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || !validTimestamp(match[1])) {
      throw new Error(
        `${sourcePath}:${index + 1}: expected ` +
          "- <ISO timestamp> — <summary>; <context>",
      );
    }
    entries.push({
      heading: current,
      timestamp: match[1],
      summary: match[2].trim(),
      context: match[3].trim(),
    });
  }

  const missing = MEMORY_HEADINGS.filter((heading) => !found.has(heading));
  if (missing.length > 0) {
    throw new Error(
      `${sourcePath}: missing Stage memory heading(s): ${missing.join(", ")}`,
    );
  }
  return { path: sourcePath, entries };
}

export function readStageMemory(
  projectDir: string,
  memoryPath: string,
): StageMemory {
  const path = resolveStageMemoryPath(projectDir, memoryPath);
  return parseStageMemory(readFileSync(path, "utf8"), path);
}

function oneLine(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || /[\r\n]/.test(normalized)) {
    throw new Error(`${label} must be one non-empty line`);
  }
  return normalized;
}

/** Append one canonical diary entry under the selected heading. */
export function appendStageMemoryEntry(
  projectDir: string,
  memoryPath: string,
  entry: Omit<MemoryEntry, "timestamp"> & { timestamp?: string },
): MemoryEntry {
  if (!(MEMORY_HEADINGS as readonly string[]).includes(entry.heading)) {
    throw new Error(`Unknown Stage memory heading: ${entry.heading}`);
  }
  const timestamp = entry.timestamp ?? new Date().toISOString();
  if (!validTimestamp(timestamp)) throw new Error(`Invalid ISO timestamp: ${timestamp}`);
  const stored: MemoryEntry = {
    heading: entry.heading,
    timestamp,
    summary: oneLine(entry.summary, "Memory summary"),
    context: oneLine(entry.context, "Memory context"),
  };
  const path = resolveStageMemoryPath(projectDir, memoryPath);

  return withWorkspaceLock(projectDir, () => {
    ensureStageMemory(projectDir, memoryPath);
    const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    // Refuse to append to a structurally damaged file.
    parseStageMemory(source, path);
    const heading = `## ${stored.heading}`;
    const start = source.indexOf(heading);
    const next = source.indexOf("\n## ", start + heading.length);
    const insertion = next < 0 ? source.length : next;
    const before = source.slice(0, insertion).replace(/\n*$/, "\n");
    const after = source.slice(insertion).replace(/^\n*/, "\n");
    const line = `- ${stored.timestamp} — ${stored.summary}; ${stored.context}\n`;
    writeFileSync(path, `${before}${line}${after}`, "utf8");
    return stored;
  });
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  const memoryPath = flagValue(args, "--memory-path");
  if (command !== "init" || memoryPath === undefined) {
    console.error(
      "Usage: aidlc-memory init --memory-path <path> [--project-dir <dir>]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(ensureStageMemory(projectDir, memoryPath), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
