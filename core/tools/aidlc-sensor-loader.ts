import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import {
  type LoadedStage,
  loadStages,
} from "./aidlc-stage-loader.ts";

export type SensorKind = "deterministic";
export type SensorSeverity = "advisory" | "blocking";

export interface SensorDefinition {
  id: string;
  kind: SensorKind;
  command: string;
  default_severity: SensorSeverity;
  description: string;
  category: string;
  matches?: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  timeout_seconds: number;
  instructions: string;
  sourcePath: string;
}

export interface SensorResolution {
  id: string;
  path: string;
  matches?: string;
}

const DEFAULT_SENSORS_DIR = resolve("core/sensors");
const SENSOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_KEYS = new Set([
  "id",
  "kind",
  "command",
  "default_severity",
  "description",
  "category",
  "matches",
  "input_schema",
  "output_schema",
  "timeout_seconds",
]);

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(context, "must be a non-empty string");
  }
  return value;
}

function validateSchemaNode(value: unknown, context: string): void {
  if (typeof value === "string" && value.trim() !== "") return;
  if (Array.isArray(value)) {
    if (value.length !== 1) fail(context, "array schemas must contain exactly one item");
    validateSchemaNode(value[0], `${context}[0]`);
    return;
  }
  const record = asRecord(value, context);
  if (Object.keys(record).length === 0) fail(context, "schema object must not be empty");
  for (const [key, child] of Object.entries(record)) {
    validateSchemaNode(child, `${context}.${key}`);
  }
}

function parseSensorMarkdown(source: string, sourcePath: string): SensorDefinition {
  const match = source.match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match?.[1]) fail(sourcePath, "missing YAML frontmatter");

  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0) {
    fail(
      sourcePath,
      `invalid YAML frontmatter: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const record = asRecord(document.toJS(), `${sourcePath} frontmatter`);
  const unknownKeys = Object.keys(record).filter(
    (key) => !FRONTMATTER_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    fail(sourcePath, `unknown frontmatter field(s): ${unknownKeys.join(", ")}`);
  }

  const id = asString(record.id, `${sourcePath}.id`);
  if (!SENSOR_ID_PATTERN.test(id)) {
    fail(`${sourcePath}.id`, "must use lowercase kebab-case");
  }
  if (basename(sourcePath) !== `aidlc-${id}.md`) {
    fail(sourcePath, `filename must be "aidlc-${id}.md"`);
  }

  const kind = asString(record.kind, `${sourcePath}.kind`);
  if (kind !== "deterministic") {
    fail(`${sourcePath}.kind`, "must be deterministic");
  }
  const severity = asString(
    record.default_severity,
    `${sourcePath}.default_severity`,
  );
  if (severity !== "advisory" && severity !== "blocking") {
    fail(`${sourcePath}.default_severity`, "must be advisory or blocking");
  }
  if (
    typeof record.timeout_seconds !== "number" ||
    !Number.isInteger(record.timeout_seconds) ||
    record.timeout_seconds < 1
  ) {
    fail(`${sourcePath}.timeout_seconds`, "must be a positive integer");
  }

  const inputSchema = asRecord(record.input_schema, `${sourcePath}.input_schema`);
  const outputSchema = asRecord(record.output_schema, `${sourcePath}.output_schema`);
  validateSchemaNode(inputSchema, `${sourcePath}.input_schema`);
  validateSchemaNode(outputSchema, `${sourcePath}.output_schema`);
  const instructions = (match[2] ?? "").trim();
  if (instructions === "") fail(sourcePath, "sensor instructions must not be empty");

  const sensor: SensorDefinition = {
    id,
    kind,
    command: asString(record.command, `${sourcePath}.command`),
    default_severity: severity,
    description: asString(record.description, `${sourcePath}.description`),
    category: asString(record.category, `${sourcePath}.category`),
    input_schema: inputSchema,
    output_schema: outputSchema,
    timeout_seconds: record.timeout_seconds,
    instructions,
    sourcePath,
  };
  if (record.matches !== undefined) {
    sensor.matches = asString(record.matches, `${sourcePath}.matches`);
  }
  return sensor;
}

export function loadSensors(sensorsDir = DEFAULT_SENSORS_DIR): SensorDefinition[] {
  const absoluteDir = resolve(sensorsDir);
  if (!existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) {
    fail(absoluteDir, "sensors directory does not exist");
  }

  const sensors: SensorDefinition[] = [];
  const seen = new Map<string, string>();
  for (const filename of readdirSync(absoluteDir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()) {
    const sourcePath = join(absoluteDir, filename);
    const sensor = parseSensorMarkdown(
      readFileSync(sourcePath, "utf8"),
      sourcePath,
    );
    const previous = seen.get(sensor.id);
    if (previous !== undefined) {
      fail(sourcePath, `duplicate sensor id "${sensor.id}"; already defined in ${previous}`);
    }
    seen.set(sensor.id, sourcePath);
    sensors.push(sensor);
  }
  return sensors;
}

export function validateStageSensorReferences(
  stages: readonly LoadedStage[],
  sensors: readonly SensorDefinition[],
): void {
  const known = new Set(sensors.map((sensor) => sensor.id));
  for (const stage of stages) {
    const seen = new Set<string>();
    stage.sensors.forEach((id, index) => {
      if (seen.has(id)) {
        throw new Error(`${stage.slug}: duplicate sensors entry "${id}"`);
      }
      seen.add(id);
      if (!known.has(id)) {
        throw new Error(`${stage.slug}: unknown sensors[${index}] "${id}"`);
      }
    });
  }
}

export function resolveSensorsForStage(
  stage: LoadedStage,
  sensors: readonly SensorDefinition[],
  harnessDir = ".codex",
): SensorResolution[] {
  const byId = new Map(sensors.map((sensor) => [sensor.id, sensor]));
  return stage.sensors.map((id) => {
    const sensor = byId.get(id);
    if (sensor === undefined) {
      throw new Error(`${stage.slug}: unknown sensor "${id}"`);
    }
    const resolution: SensorResolution = {
      id,
      path: posix.join(harnessDir, "sensors", basename(sensor.sourcePath)),
    };
    if (sensor.matches !== undefined) resolution.matches = sensor.matches;
    return resolution;
  });
}

function runCli(): void {
  const command = process.argv[2];
  if (command !== "check") {
    console.error("Usage: aidlc-sensor-loader check");
    process.exitCode = 1;
    return;
  }
  try {
    const sensors = loadSensors();
    const stages = loadStages();
    validateStageSensorReferences(stages, sensors);
    console.log(
      `Loaded ${sensors.length} sensors and validated ${stages.length} stage references.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
