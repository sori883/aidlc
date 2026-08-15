// Harness-neutral PostToolUse Sensor hook. Harness packaging supplies the hook
// registration and payload adapter; this core accepts the common Write/Edit
// payload shape and never blocks the parent file operation.

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCompiledStageGraph } from "../tools/aidlc-graph.ts";
import {
  fireSensor,
  type SensorFireResult,
} from "../tools/aidlc-sensor.ts";
import { resumeIntentState } from "../tools/aidlc-state.ts";

export interface SensorHookPayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    path?: string;
  };
}

export interface SensorHookResult {
  fired: SensorFireResult[];
  skipped: boolean;
  reason?: string;
}

export type SensorFireFunction = (
  projectDir: string,
  id: string,
  stage: string,
  outputPath: string,
) => Promise<SensorFireResult>;

function portable(path: string): string {
  return path.split(sep).join("/");
}

function heartbeat(projectDir: string): void {
  const directory = join(projectDir, ".aidlc-hooks-health");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "sensor-fire.last"),
    `${new Date().toISOString()}\n`,
    "utf8",
  );
}

/** Process one Write/Edit event. Every Sensor outcome remains advisory. */
export async function runSensorFireHook(
  projectDir: string,
  payload: SensorHookPayload,
  fire: SensorFireFunction = fireSensor,
): Promise<SensorHookResult> {
  const projectRoot = resolve(projectDir);
  const toolName = payload.tool_name ?? "";
  if (!["Write", "Edit", "write", "edit"].includes(toolName)) {
    return { fired: [], skipped: true, reason: "not a Write/Edit event" };
  }
  const filePath = payload.tool_input?.file_path ?? payload.tool_input?.path;
  if (!filePath) return { fired: [], skipped: true, reason: "no file path" };

  let resume;
  try {
    resume = resumeIntentState(projectRoot);
  } catch {
    return { fired: [], skipped: true, reason: "no active workflow" };
  }
  if (resume.status !== "Running" || resume.currentStage === "none") {
    return { fired: [], skipped: true, reason: "workflow is not running" };
  }
  const stage = loadCompiledStageGraph().find(
    (candidate) => candidate.slug === resume.currentStage,
  );
  if (stage === undefined) {
    return { fired: [], skipped: true, reason: "active stage is not in graph" };
  }
  const absolute = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(projectRoot, filePath);
  const rel = relative(projectRoot, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { fired: [], skipped: true, reason: "file is outside project" };
  }
  const portablePath = portable(rel);
  const applicable = (stage.sensors_applicable ?? []).filter(
    (sensor) => sensor.matches !== undefined &&
      matchesGlob(portablePath, sensor.matches),
  );
  if (applicable.length === 0) {
    return { fired: [], skipped: true, reason: "no matching Sensors" };
  }

  heartbeat(projectRoot);
  const fired: SensorFireResult[] = [];
  for (const sensor of applicable) {
    try {
      fired.push(await fire(projectRoot, sensor.id, stage.slug, absolute));
    } catch {
      // Invocation faults are hook telemetry, never a reason to block the
      // originating file write. Doctor support will inspect the heartbeat.
    }
  }
  return { fired, skipped: false };
}

async function readStdin(): Promise<string> {
  let source = "";
  for await (const chunk of process.stdin) source += String(chunk);
  return source;
}

async function runCli(): Promise<void> {
  const source = await readStdin();
  let payload: SensorHookPayload;
  try {
    payload = JSON.parse(source || "{}") as SensorHookPayload;
  } catch {
    return;
  }
  const projectDir = process.env.CODEX_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  await runSensorFireHook(projectDir, payload);
}

if (import.meta.main) {
  runCli().catch(() => {
    // Hooks are advisory and always exit successfully.
  });
}
