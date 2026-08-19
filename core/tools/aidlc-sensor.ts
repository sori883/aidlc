// Advisory Sensor dispatcher. Invocation errors fail the CLI; once a fire is
// accepted, every outcome is audit-paired and returns successfully.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
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
  stateFilePath,
} from "./aidlc-state.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";

export type SensorOutcome = "passed" | "failed" | "budget-override";

export interface SensorFireResult {
  id: string;
  fire_id: string;
  stage: string;
  output_path: string;
  outcome: SensorOutcome;
  detail_path?: string;
  receipt_path?: string;
  receipt_fresh?: boolean;
  result?: Record<string, unknown>;
}

export const SENSOR_RECEIPT_VERSION = 1 as const;
export const SENSOR_CHECKER_PROTOCOL_VERSION = 1 as const;

export interface SensorReceiptInput {
  path: string;
  sha256: string;
}

export interface SensorReceipt {
  version: typeof SENSOR_RECEIPT_VERSION;
  checker_protocol_version: typeof SENSOR_CHECKER_PROTOCOL_VERSION;
  fire_id: string;
  sensor: string;
  sensor_version: string;
  stage: string;
  outcome: SensorOutcome;
  output_path: string;
  output_sha256: string;
  input_sha256: string;
  inputs: SensorReceiptInput[];
  checker_result: CheckerProtocolResult | null;
  created_at: string;
}

export interface SensorReceiptFreshness {
  fresh: boolean;
  reasons: string[];
  current_output_sha256: string;
  current_input_sha256: string;
  current_sensor_version: string;
}

export interface SensorProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export interface CheckerProtocolResult extends Record<string, unknown> {
  pass: boolean;
}

export interface SensorProcessClassification {
  outcome: SensorOutcome;
  checkerResult: CheckerProtocolResult | null;
  reason?:
    | "timeout"
    | "spawn-failed"
    | "missing-exit-status"
    | "invalid-checker-protocol"
    | "checker-budget-override"
    | "unexpected-exit-status"
    | "exit-status-mismatch";
}

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = runtimeCoreDir();
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_CAPTURE = 1_000_000;

function sha256(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function fileDigest(path: string): string {
  return existsSync(path) && statSync(path).isFile()
    ? sha256(readFileSync(path))
    : "missing";
}

function stableStateIdentity(projectDir: string): Record<string, string> {
  const source = readFileSync(stateFilePath(projectDir), "utf8");
  const field = (name: string): string => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^- \\*\\*${escaped}\\*\\*:[ \\t]*(.*)$`, "m")
      .exec(source)?.[1]?.trim() ?? "missing";
  };
  return {
    project: field("Project"),
    scope: field("Scope"),
    project_type: field("Project Type").toLowerCase(),
  };
}

function immediateMarkdownFiles(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(directory, name));
}

function sensorVersion(sensor: SensorDefinition): string {
  return existsSync(sensor.sourcePath)
    ? fileDigest(sensor.sourcePath)
    : sha256(JSON.stringify(sensor));
}

function receiptSnapshot(
  projectDir: string,
  sensor: SensorDefinition,
  stage: CompiledStage,
  target: { absolute: string; relative: string },
): {
  sensorVersion: string;
  outputSha256: string;
  inputSha256: string;
  inputs: SensorReceiptInput[];
} {
  const projectRoot = resolve(projectDir);
  const inputPaths = new Set<string>([target.absolute]);
  if (target.absolute.endsWith(".md")) {
    for (const path of immediateMarkdownFiles(dirname(target.absolute))) inputPaths.add(path);
    const template = join(
      workspaceRoot(projectRoot),
      "spaces",
      activeSpace(projectRoot),
      "memory",
      "templates",
      target.absolute.split(sep).at(-1) ?? "",
    );
    if (existsSync(template)) inputPaths.add(template);
  } else {
    for (const name of [
      "package.json", "bun.lock", "bun.lockb", "tsconfig.json",
      "eslint.config.js", "eslint.config.mjs", ".eslintrc.json",
    ]) {
      const path = join(projectRoot, name);
      if (existsSync(path)) inputPaths.add(path);
    }
  }
  const inputs = [...inputPaths]
    .sort()
    .map((path) => ({
      path: portable(relative(projectRoot, path)),
      sha256: fileDigest(path),
    }));
  const version = sensorVersion(sensor);
  return {
    sensorVersion: version,
    outputSha256: fileDigest(target.absolute),
    inputSha256: sha256(JSON.stringify({
      sensor: sensor.id,
      sensor_version: version,
      stage: {
        slug: stage.slug,
        consumes: stage.consumes ?? [],
        produces: stage.produces ?? [],
      },
      state: stableStateIdentity(projectRoot),
      inputs,
    })),
    inputs,
  };
}

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
): Promise<SensorProcessResult> {
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

/** Find the last complete checker-protocol JSON line, ignoring wrapper logs. */
export function parseCheckerProtocolResult(
  stdout: string,
): CheckerProtocolResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (
        typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).pass === "boolean"
      ) return value as CheckerProtocolResult;
    } catch {
      // Package-manager and script wrapper lines are not checker protocol.
    }
  }
  return null;
}

/** Classify one checker process independently from its package-manager shell. */
export function classifySensorProcessResult(
  processResult: SensorProcessResult,
): SensorProcessClassification {
  if (processResult.timedOut) {
    return { outcome: "budget-override", checkerResult: null, reason: "timeout" };
  }
  if (processResult.spawnError !== undefined) {
    return {
      outcome: "budget-override",
      checkerResult: null,
      reason: "spawn-failed",
    };
  }
  if (processResult.code === null) {
    return {
      outcome: "budget-override",
      checkerResult: null,
      reason: "missing-exit-status",
    };
  }
  const checkerResult = parseCheckerProtocolResult(processResult.stdout);
  if (checkerResult === null) {
    return {
      outcome: "budget-override",
      checkerResult,
      reason: "invalid-checker-protocol",
    };
  }
  if (checkerResult.budget_override === true) {
    return {
      outcome: "budget-override",
      checkerResult,
      reason: "checker-budget-override",
    };
  }
  if (processResult.code !== 0 && processResult.code !== 1) {
    return {
      outcome: "budget-override",
      checkerResult,
      reason: "unexpected-exit-status",
    };
  }
  if (checkerResult.pass === false) {
    return { outcome: "failed", checkerResult };
  }
  if (processResult.code === 0) {
    return { outcome: "passed", checkerResult };
  }
  return {
    outcome: "budget-override",
    checkerResult,
    reason: "exit-status-mismatch",
  };
}

function writeFailureDetail(
  recordDir: string,
  sensorId: string,
  stage: string,
  fireId: string,
  outputPath: string,
  outcome: Exclude<SensorOutcome, "passed">,
  processResult: SensorProcessResult,
  checkerResult: CheckerProtocolResult | null,
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

function writeSensorReceipt(
  recordDir: string,
  receipt: SensorReceipt,
): string {
  const directory = join(recordDir, ".aidlc-sensors", receipt.stage, "receipts");
  const filename = `${receipt.sensor}-${receipt.fire_id}.json`;
  const finalPath = join(directory, filename);
  const temporaryPath = join(
    directory,
    `.${filename}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  renameSync(temporaryPath, finalPath);
  return finalPath;
}

export function readSensorReceipt(path: string): SensorReceipt {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SensorReceipt>;
  if (
    value.version !== SENSOR_RECEIPT_VERSION ||
    value.checker_protocol_version !== SENSOR_CHECKER_PROTOCOL_VERSION ||
    typeof value.fire_id !== "string" || typeof value.sensor !== "string" ||
    typeof value.sensor_version !== "string" || typeof value.stage !== "string" ||
    !["passed", "failed", "budget-override"].includes(String(value.outcome)) ||
    typeof value.output_path !== "string" || typeof value.output_sha256 !== "string" ||
    typeof value.input_sha256 !== "string" || !Array.isArray(value.inputs) ||
    value.inputs.some((input) =>
      typeof input?.path !== "string" || typeof input?.sha256 !== "string"
    ) || typeof value.created_at !== "string"
  ) throw new Error(`Invalid Sensor receipt: ${path}`);
  return value as SensorReceipt;
}

export function sensorReceiptFreshness(
  projectDir: string,
  receipt: SensorReceipt,
): SensorReceiptFreshness {
  const projectRoot = resolve(projectDir);
  const sensor = sensorDefinition(receipt.sensor);
  const stage = loadCompiledStageGraph().find((candidate) => candidate.slug === receipt.stage);
  if (stage === undefined) throw new Error(`Unknown receipt Stage: ${receipt.stage}`);
  const target = workspaceRelativePath(projectRoot, receipt.output_path);
  const current = receiptSnapshot(projectRoot, sensor, stage, target);
  const reasons: string[] = [];
  if (receipt.output_sha256 !== current.outputSha256) reasons.push("output-changed");
  if (receipt.input_sha256 !== current.inputSha256) reasons.push("input-changed");
  if (receipt.sensor_version !== current.sensorVersion) reasons.push("sensor-version-changed");
  return {
    fresh: reasons.length === 0,
    reasons,
    current_output_sha256: current.outputSha256,
    current_input_sha256: current.inputSha256,
    current_sensor_version: current.sensorVersion,
  };
}

export function listSensorReceipts(projectDir: string): Array<{
  path: string;
  receipt: SensorReceipt;
  freshness: SensorReceiptFreshness;
}> {
  const projectRoot = resolve(projectDir);
  const root = join(activeIntentRecordDir(projectRoot), ".aidlc-sensors");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .flatMap((stage) => {
      const directory = join(root, stage, "receipts");
      if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
      return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(directory, name));
    })
    .map((path) => {
      const receipt = readSensorReceipt(path);
      return {
        path: portable(relative(projectRoot, path)),
        receipt,
        freshness: sensorReceiptFreshness(projectRoot, receipt),
      };
    });
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
  const { stage, matches } = stageAndBinding(stageSlug, id);
  const target = workspaceRelativePath(projectRoot, outputPath);
  if (!matchesGlob(target.relative, matches)) {
    throw new Error(
      `Sensor "${id}" does not match output path "${target.relative}" (${matches})`,
    );
  }

  const recordDir = activeIntentRecordDir(projectRoot);
  const fireId = randomBytes(4).toString("hex");
  const tokens = commandTokens(sensor);
  const snapshot = receiptSnapshot(projectRoot, sensor, stage, target);
  const fileFlag = "file_path" in sensor.input_schema
    ? "--file-path"
    : "--output-path";
  appendAuditEntry(projectRoot, recordDir, "SENSOR_FIRED", {
    Sensor: id,
    Stage: stageSlug,
    "Fire ID": fireId,
    Output: target.relative,
    Severity: sensor.default_severity,
    "Sensor Version": snapshot.sensorVersion,
    "Output SHA-256": snapshot.outputSha256,
    "Input SHA-256": snapshot.inputSha256,
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
  const classification = classifySensorProcessResult(processResult);
  const { checkerResult, outcome } = classification;
  const receipt: SensorReceipt = {
    version: SENSOR_RECEIPT_VERSION,
    checker_protocol_version: SENSOR_CHECKER_PROTOCOL_VERSION,
    fire_id: fireId,
    sensor: id,
    sensor_version: snapshot.sensorVersion,
    stage: stageSlug,
    outcome,
    output_path: target.relative,
    output_sha256: snapshot.outputSha256,
    input_sha256: snapshot.inputSha256,
    inputs: snapshot.inputs,
    checker_result: checkerResult,
    created_at: new Date().toISOString(),
  };
  let receiptRelative = "unavailable";
  let receiptError: string | undefined;
  let receiptFresh = false;
  try {
    const receiptPath = writeSensorReceipt(recordDir, receipt);
    receiptRelative = portable(relative(projectRoot, receiptPath));
    receiptFresh = sensorReceiptFreshness(projectRoot, receipt).fresh;
  } catch (error) {
    receiptError = error instanceof Error ? error.message : String(error);
  }

  if (outcome === "passed") {
    appendAuditEntry(projectRoot, recordDir, "SENSOR_PASSED", {
      Sensor: id,
      Stage: stageSlug,
      "Fire ID": fireId,
      Output: target.relative,
      Receipt: receiptRelative,
      "Receipt Fresh": String(receiptFresh),
      ...(receiptError === undefined ? {} : { "Receipt Error": receiptError }),
    });
    return {
      id,
      fire_id: fireId,
      stage: stageSlug,
      output_path: target.relative,
      outcome,
      ...(receiptRelative === "unavailable" ? {} : { receipt_path: receiptRelative }),
      receipt_fresh: receiptFresh,
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
      Receipt: receiptRelative,
      "Receipt Fresh": String(receiptFresh),
      ...(detailError === undefined ? {} : { "Detail Error": detailError }),
      ...(receiptError === undefined ? {} : { "Receipt Error": receiptError }),
      ...(outcome === "budget-override"
        ? { Reason: classification.reason ?? "checker unavailable" }
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
    ...(receiptRelative === "unavailable" ? {} : { receipt_path: receiptRelative }),
    receipt_fresh: receiptFresh,
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
