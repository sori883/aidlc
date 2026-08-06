// Codex PostToolUse adapter. Codex emits one apply_patch command that may
// contain several files; the harness-neutral Sensor hook accepts one path at a
// time, so this adapter fans the event out deterministically.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runSensorFireHook,
  type SensorHookResult,
} from "../../../core/hooks/aidlc-sensor-fire.ts";

export interface CodexPostToolUsePayload {
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
  };
}

export interface CodexSensorHookResult {
  files: string[];
  results: SensorHookResult[];
  skipped: boolean;
  reason?: string;
}

const PATCH_PATH_LINE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

function matchedPaths(command: string): string[] {
  return [...command.matchAll(PATCH_PATH_LINE)]
    .map((match) => match[1]?.trim())
    .filter((path): path is string => path !== undefined && path.length > 0);
}

/** Extract every path modified by Codex apply_patch, preserving patch order. */
export function codexPatchPaths(command: string): string[] {
  return [...new Set(matchedPaths(command))];
}

/** Convert one Codex PostToolUse payload into advisory per-file Sensor fires. */
export async function runCodexSensorHook(
  payload: CodexPostToolUsePayload,
): Promise<CodexSensorHookResult> {
  if (payload.hook_event_name !== "PostToolUse") {
    return { files: [], results: [], skipped: true, reason: "not PostToolUse" };
  }
  if (payload.tool_name !== "apply_patch") {
    return { files: [], results: [], skipped: true, reason: "not apply_patch" };
  }
  const command = payload.tool_input?.command;
  if (command === undefined || command.length === 0) {
    return { files: [], results: [], skipped: true, reason: "no patch command" };
  }
  const files = codexPatchPaths(command);
  if (files.length === 0) {
    return { files, results: [], skipped: true, reason: "no patch file paths" };
  }
  const projectDir = resolve(
    process.env.CODEX_PROJECT_DIR ?? payload.cwd ?? process.cwd(),
  );
  const results: SensorHookResult[] = [];
  for (const file of files) {
    results.push(await runSensorFireHook(projectDir, {
      tool_name: "Write",
      tool_input: { file_path: file },
    }));
  }
  return { files, results, skipped: false };
}

async function readStdin(): Promise<string> {
  let source = "";
  for await (const chunk of process.stdin) source += String(chunk);
  return source;
}

async function runCli(): Promise<void> {
  try {
    const source = await readStdin();
    const payload = JSON.parse(source || "{}") as CodexPostToolUsePayload;
    await runCodexSensorHook(payload);
  } catch {
    // Sensors are advisory. Adapter or payload failures never block edits.
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) void runCli();
