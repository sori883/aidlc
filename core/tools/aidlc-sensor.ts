// Advisory Sensor dispatcher. Invocation errors fail the CLI; once a fire is
// accepted, every outcome is audit-paired and returns successfully.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isCompiledExecutable,
  runtimeCoreDir,
} from "./aidlc-runtime-paths.ts";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  type CompiledStage,
  loadCompiledStageGraph,
} from "./aidlc-graph.ts";
import {
  type SensorDefinition,
  loadSensors,
} from "./aidlc-sensor-loader.ts";
import {
  activeIntentRecordDir,
  resumeIntentState,
} from "./aidlc-state.ts";

export type SensorOutcome = "passed" | "failed" | "budget-override";

export interface SensorFireResult {
  id: string;
  fire_id: string;
  stage: string;
  output_path: string;
  outcome: SensorOutcome;
  detail_path?: string;
  result?: Record<string, unknown>;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = runtimeCoreDir();
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_CAPTURE = 1_000_000;

function portable(path: string): string {
  return path.split(sep).join("/");
}

function workspaceRelativePath(projectDir: string, inputPath: string): {
  absolute: string;
  relative: string;
} {
  const projectRoot = resolve(projectDir);
  const absolute = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(projectRoot, inputPath);
  const rel = relative(projectRoot, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Sensor output path must be inside the project: ${inputPath}`);
  }
  return { absolute, relative: portable(rel) };
}

function stageAndBinding(
  stageSlug: string,
  sensorId: string,
): { stage: CompiledStage; matches: string } {
  const stage = loadCompiledStageGraph().find(
    (candidate) => candidate.slug === stageSlug,
  );
  if (stage === undefined) throw new Error(`Unknown stage: "${stageSlug}"`);
  const binding = (stage.sensors_applicable ?? []).find(
    (candidate) => candidate.id === sensorId,
  );
  if (binding === undefined) {
    throw new Error(`Sensor "${sensorId}" is not bound to stage "${stageSlug}"`);
  }
  if (!binding.matches) {
    throw new Error(`Sensor "${sensorId}" has no matches glob and cannot fire`);
  }
  return { stage, matches: binding.matches };
}

function sensorDefinition(id: string): SensorDefinition {
  const sensor = loadSensors().find((candidate) => candidate.id === id);
  if (sensor === undefined) throw new Error(`Unknown sensor: "${id}"`);
  return sensor;
}

function commandTokens(sensor: SensorDefinition): string[] {
  if (isCompiledExecutable()) {
    return [process.execPath, "__sensor-script", sensor.id];
  }
  const expanded = sensor.command.replaceAll("{{HARNESS_DIR}}", CORE_DIR);
  const tokens = expanded.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens.length === 0) throw new Error(`Sensor "${sensor.id}" has an empty command`);
  return tokens.map((token) => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) return token.slice(1, -1);
    return token;
  });
}

function runProcess(
  command: string,
  args: string[],
  projectDir: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((settle) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;
    const child = spawn(command, args, {
      cwd: projectDir,
      env: { ...process.env, AIDLC_PROJECT_DIR: projectDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (stdout.length < MAX_CAPTURE) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < MAX_CAPTURE) stderr += String(chunk);
    });
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({
        code,
        stdout: stdout.slice(0, MAX_CAPTURE),
        stderr: stderr.slice(0, MAX_CAPTURE),
        timedOut,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    });
  });
}

function parseCheckerResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const candidate = lines.at(-1);
  if (candidate === undefined) return null;
  try {
    const value = JSON.parse(candidate) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function writeFailureDetail(
  recordDir: string,
  sensorId: string,
  stage: string,
  fireId: string,
  outputPath: string,
  outcome: Exclude<SensorOutcome, "passed">,
  processResult: ProcessResult,
  checkerResult: Record<string, unknown> | null,
): string {
  const directory = join(recordDir, ".aidlc-sensors", stage);
  const filename = `${sensorId}-${fireId}.md`;
  const finalPath = join(directory, filename);
  const temporaryPath = join(
    directory,
    `.${filename}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`,
  );
  mkdirSync(directory, { recursive: true });
  const body = `# Sensor ${outcome}\n\n` +
    `- **Sensor**: ${sensorId}\n` +
    `- **Stage**: ${stage}\n` +
    `- **Fire ID**: ${fireId}\n` +
    `- **Output**: ${outputPath}\n` +
    `- **Exit code**: ${String(processResult.code)}\n` +
    `- **Timed out**: ${String(processResult.timedOut)}\n\n` +
    `## Result\n\n\`\`\`json\n${JSON.stringify(checkerResult ?? {}, null, 2)}\n\`\`\`\n\n` +
    `## Standard Error\n\n\`\`\`text\n${processResult.spawnError ?? processResult.stderr}\n\`\`\`\n`;
  writeFileSync(temporaryPath, body, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, finalPath);
  return finalPath;
}

/** Fire one compile-bound Sensor. Accepted outcomes are always advisory. */
export async function fireSensor(
  projectDir: string,
  id: string,
  stageSlug: string,
  outputPath: string,
): Promise<SensorFireResult> {
  const projectRoot = resolve(projectDir);
  const resume = resumeIntentState(projectRoot);
  if (resume.currentStage !== stageSlug) {
    throw new Error(
      `Cannot fire Sensor for "${stageSlug}": Current Stage is "${resume.currentStage}"`,
    );
  }
  const sensor = sensorDefinition(id);
  const { matches } = stageAndBinding(stageSlug, id);
  const target = workspaceRelativePath(projectRoot, outputPath);
  if (!matchesGlob(target.relative, matches)) {
    throw new Error(
      `Sensor "${id}" does not match output path "${target.relative}" (${matches})`,
    );
  }

  const recordDir = activeIntentRecordDir(projectRoot);
  const fireId = randomBytes(4).toString("hex");
  const tokens = commandTokens(sensor);
  const fileFlag = "file_path" in sensor.input_schema
    ? "--file-path"
    : "--output-path";
  appendAuditEntry(projectRoot, recordDir, "SENSOR_FIRED", {
    Sensor: id,
    Stage: stageSlug,
    "Fire ID": fireId,
    Output: target.relative,
    Severity: sensor.default_severity,
  });

  const processResult = await runProcess(
    tokens[0]!,
    [
      ...tokens.slice(1),
      "--stage",
      stageSlug,
      fileFlag,
      target.absolute,
    ],
    projectRoot,
    (sensor.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  );
  const checkerResult = parseCheckerResult(processResult.stdout);
  const budgetOverride = processResult.timedOut ||
    processResult.spawnError !== undefined ||
    checkerResult === null ||
    checkerResult.budget_override === true ||
    processResult.code === null ||
    (processResult.code !== 0 && processResult.code !== 1);
  const outcome: SensorOutcome = budgetOverride
    ? "budget-override"
    : processResult.code === 0 && checkerResult.pass === true
    ? "passed"
    : "failed";

  if (outcome === "passed") {
    appendAuditEntry(projectRoot, recordDir, "SENSOR_PASSED", {
      Sensor: id,
      Stage: stageSlug,
      "Fire ID": fireId,
      Output: target.relative,
    });
    return {
      id,
      fire_id: fireId,
      stage: stageSlug,
      output_path: target.relative,
      outcome,
      ...(checkerResult === null ? {} : { result: checkerResult }),
    };
  }

  let detailRelative = "unavailable";
  let detailError: string | undefined;
  try {
    const detailPath = writeFailureDetail(
      recordDir,
      id,
      stageSlug,
      fireId,
      target.relative,
      outcome,
      processResult,
      checkerResult,
    );
    detailRelative = portable(relative(projectRoot, detailPath));
  } catch (error) {
    detailError = error instanceof Error ? error.message : String(error);
  }
  appendAuditEntry(
    projectRoot,
    recordDir,
    outcome === "failed" ? "SENSOR_FAILED" : "SENSOR_BUDGET_OVERRIDE",
    {
      Sensor: id,
      Stage: stageSlug,
      "Fire ID": fireId,
      Output: target.relative,
      Detail: detailRelative,
      ...(detailError === undefined ? {} : { "Detail Error": detailError }),
      ...(outcome === "budget-override"
        ? { Reason: processResult.timedOut ? "timeout" : "checker unavailable" }
        : {}),
    },
  );
  return {
    id,
    fire_id: fireId,
    stage: stageSlug,
    output_path: target.relative,
    outcome,
    ...(detailRelative === "unavailable" ? {} : { detail_path: detailRelative }),
    ...(checkerResult === null ? {} : { result: checkerResult }),
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export async function main(argv: string[]): Promise<void> {
  const [command, id, ...args] = argv;
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  if (command === "list") {
    console.log(JSON.stringify(
      loadSensors().map((sensor) => ({
        id: sensor.id,
        kind: sensor.kind,
        description: sensor.description,
      })),
      null,
      2,
    ));
    return;
  }
  if (command === "describe") {
    if (id === undefined) throw new Error("describe requires <id>");
    const sensor = sensorDefinition(id);
    console.log(JSON.stringify({
      id: sensor.id,
      kind: sensor.kind,
      command: sensor.command,
      default_severity: sensor.default_severity,
      description: sensor.description,
      ...(sensor.category === undefined ? {} : { category: sensor.category }),
      ...(sensor.matches === undefined ? {} : { matches: sensor.matches }),
      ...(sensor.timeout_seconds === undefined
        ? {}
        : { timeout_seconds: sensor.timeout_seconds }),
      manifest_path: sensor.sourcePath,
    }, null, 2));
    return;
  }
  if (command === "fire") {
    if (id === undefined) throw new Error("fire requires <id>");
    const stage = flagValue(args, "--stage");
    const outputPath = flagValue(args, "--output-path") ??
      flagValue(args, "--file-path");
    if (stage === undefined || outputPath === undefined) {
      throw new Error("fire requires --stage <slug> and --output-path <path>");
    }
    console.log(JSON.stringify(
      await fireSensor(projectDir, id, stage, outputPath),
      null,
      2,
    ));
    return;
  }
  throw new Error(
    "Usage: aidlc-sensor <list|describe|fire> [id] [--stage <slug>] " +
      "[--output-path <path>] [--project-dir <dir>]",
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
