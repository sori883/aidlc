// Provider-extensible Quality Gate Manifest validation. The Core compares the
// approved quality declaration with package scripts and provider-native CI
// files before the CI Pipeline Stage can open its approval gate.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import {
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";
import { activeIntentRecordDir } from "./aidlc-state.ts";

export const QUALITY_GATE_MANIFEST_VERSION = 1 as const;
const QUALITY_GATE_CLI_CONTRACT = loadCliContract("aidlc-quality-gate.ts");
const GATE_KINDS = new Set([
  "node-test",
  "workerd-test",
  "browser-test",
  "coverage",
  "build",
  "architecture",
  "security",
]);
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const RUNTIMES = new Set(["bun", "node", "none"]);

export interface QualityGateWorkflow {
  name: string;
  path: string;
}

export interface QualityGateDefinition {
  id: string;
  kind: string;
  required: boolean;
  script: string;
  workflow: string;
  job: string;
  runtime: "bun" | "node" | "none";
}

export interface QualityGateManifest {
  version: typeof QUALITY_GATE_MANIFEST_VERSION;
  provider: { id: string };
  package: { path: string; manager: "bun" | "npm" | "pnpm" | "yarn" };
  workflows: QualityGateWorkflow[];
  gates: QualityGateDefinition[];
  aggregate: { workflow: string; job: string; required_check: string };
  required_checks: string[];
}

export interface QualityGateFinding {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface ActionlintResult {
  status: "not-requested" | "unavailable" | "passed" | "failed";
  output: string;
}

export interface QualityGateCheckResult {
  valid: boolean;
  manifest_path: string;
  provider: string;
  findings: QualityGateFinding[];
  actionlint: ActionlintResult;
}

export interface QualityGateCheckOptions {
  manifestPath?: string;
  actionlint?: boolean;
}

interface ParsedWorkflow {
  path: string;
  name: string;
  root: Record<string, unknown>;
  jobs: Record<string, Record<string, unknown>>;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${context} has unknown field(s): ${unknown.join(", ")}`);
  }
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
    throw new Error(`${context} must be a non-empty single-line string`);
  }
  return value;
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${context} must be a string array`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    throw new Error(`${context} has duplicate entries`);
  }
  return [...result];
}

function safeProjectPath(projectDir: string, input: string, context: string): string {
  const root = resolve(projectDir);
  const absolute = resolve(root, input);
  const rel = relative(root, absolute);
  if (
    input.trim() === "" || rel === "" || rel === ".." ||
    rel.startsWith(`..${sep}`) || isAbsolute(rel)
  ) throw new Error(`${context} must be a project-relative file path`);
  return absolute;
}

export function parseQualityGateManifest(
  source: string,
  sourcePath = "quality-gate-manifest.json",
): QualityGateManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${sourcePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = record(value, sourcePath);
  exactKeys(
    root,
    ["version", "provider", "package", "workflows", "gates", "aggregate", "required_checks"],
    sourcePath,
  );
  if (root.version !== QUALITY_GATE_MANIFEST_VERSION) {
    throw new Error(`${sourcePath}: version must be ${QUALITY_GATE_MANIFEST_VERSION}`);
  }
  const provider = record(root.provider, `${sourcePath}.provider`);
  exactKeys(provider, ["id"], `${sourcePath}.provider`);
  const providerId = stringValue(provider.id, `${sourcePath}.provider.id`);
  const packageRow = record(root.package, `${sourcePath}.package`);
  exactKeys(packageRow, ["path", "manager"], `${sourcePath}.package`);
  const manager = stringValue(packageRow.manager, `${sourcePath}.package.manager`);
  if (!PACKAGE_MANAGERS.has(manager)) {
    throw new Error(`${sourcePath}.package.manager is unsupported: ${manager}`);
  }
  if (!Array.isArray(root.workflows) || root.workflows.length === 0) {
    throw new Error(`${sourcePath}.workflows must be a non-empty array`);
  }
  const workflowNames = new Set<string>();
  const workflowPaths = new Set<string>();
  const workflows = root.workflows.map((entry, index) => {
    const row = record(entry, `${sourcePath}.workflows[${index}]`);
    exactKeys(row, ["name", "path"], `${sourcePath}.workflows[${index}]`);
    const name = stringValue(row.name, `${sourcePath}.workflows[${index}].name`);
    const path = stringValue(row.path, `${sourcePath}.workflows[${index}].path`);
    if (workflowNames.has(name)) throw new Error(`${sourcePath}: duplicate workflow name ${name}`);
    if (workflowPaths.has(path)) throw new Error(`${sourcePath}: duplicate workflow path ${path}`);
    workflowNames.add(name);
    workflowPaths.add(path);
    return { name, path };
  });
  if (!Array.isArray(root.gates) || root.gates.length === 0) {
    throw new Error(`${sourcePath}.gates must be a non-empty array`);
  }
  const gateIds = new Set<string>();
  const gates = root.gates.map((entry, index) => {
    const context = `${sourcePath}.gates[${index}]`;
    const row = record(entry, context);
    exactKeys(
      row,
      ["id", "kind", "required", "script", "workflow", "job", "runtime"],
      context,
    );
    const id = stringValue(row.id, `${context}.id`);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`${context}.id must be kebab-case`);
    if (gateIds.has(id)) throw new Error(`${sourcePath}: duplicate gate id ${id}`);
    gateIds.add(id);
    const kind = stringValue(row.kind, `${context}.kind`);
    if (!GATE_KINDS.has(kind)) throw new Error(`${context}.kind is unsupported: ${kind}`);
    if (typeof row.required !== "boolean") throw new Error(`${context}.required must be boolean`);
    const runtime = stringValue(row.runtime, `${context}.runtime`);
    if (!RUNTIMES.has(runtime)) throw new Error(`${context}.runtime is unsupported: ${runtime}`);
    return {
      id,
      kind,
      required: row.required,
      script: stringValue(row.script, `${context}.script`),
      workflow: stringValue(row.workflow, `${context}.workflow`),
      job: stringValue(row.job, `${context}.job`),
      runtime: runtime as QualityGateDefinition["runtime"],
    };
  });
  const aggregateRow = record(root.aggregate, `${sourcePath}.aggregate`);
  exactKeys(aggregateRow, ["workflow", "job", "required_check"], `${sourcePath}.aggregate`);
  const aggregate = {
    workflow: stringValue(aggregateRow.workflow, `${sourcePath}.aggregate.workflow`),
    job: stringValue(aggregateRow.job, `${sourcePath}.aggregate.job`),
    required_check: stringValue(
      aggregateRow.required_check,
      `${sourcePath}.aggregate.required_check`,
    ),
  };
  return {
    version: QUALITY_GATE_MANIFEST_VERSION,
    provider: { id: providerId },
    package: {
      path: stringValue(packageRow.path, `${sourcePath}.package.path`),
      manager: manager as QualityGateManifest["package"]["manager"],
    },
    workflows,
    gates,
    aggregate,
    required_checks: stringArray(root.required_checks, `${sourcePath}.required_checks`),
  };
}

function finding(
  findings: QualityGateFinding[],
  code: string,
  path: string,
  message: string,
  severity: QualityGateFinding["severity"] = "error",
): void {
  findings.push({ code, severity, path, message });
}

function parseWorkflow(
  projectDir: string,
  declaration: QualityGateWorkflow,
  findings: QualityGateFinding[],
): ParsedWorkflow | null {
  let path: string;
  try {
    path = safeProjectPath(projectDir, declaration.path, "workflow.path");
  } catch (error) {
    finding(findings, "workflow.path-invalid", declaration.path, String(error));
    return null;
  }
  if (!existsSync(path)) {
    finding(findings, "workflow.missing", declaration.path, "Declared workflow file does not exist");
    return null;
  }
  const document = parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    finding(
      findings,
      "workflow.yaml-invalid",
      declaration.path,
      document.errors.map((error) => error.message).join("; "),
    );
    return null;
  }
  let root: Record<string, unknown>;
  try {
    root = record(document.toJS(), declaration.path);
  } catch (error) {
    finding(findings, "workflow.shape-invalid", declaration.path, String(error));
    return null;
  }
  const name = typeof root.name === "string" ? root.name : "";
  if (name !== declaration.name) {
    finding(
      findings,
      "workflow.name-mismatch",
      declaration.path,
      `Manifest declares "${declaration.name}" but YAML name is "${name || "missing"}"`,
    );
  }
  if (!("on" in root)) {
    finding(findings, "workflow.trigger-missing", declaration.path, "Workflow has no on trigger");
  }
  let jobs: Record<string, Record<string, unknown>> = {};
  try {
    const rawJobs = record(root.jobs, `${declaration.path}.jobs`);
    jobs = Object.fromEntries(
      Object.entries(rawJobs).map(([id, job]) => [id, record(job, `${declaration.path}.jobs.${id}`)]),
    );
  } catch (error) {
    finding(findings, "workflow.jobs-invalid", declaration.path, String(error));
  }
  return { path: declaration.path, name: declaration.name, root, jobs };
}

function jobRuns(job: Record<string, unknown>): string[] {
  if (!Array.isArray(job.steps)) return [];
  return job.steps.flatMap((step) => {
    if (typeof step !== "object" || step === null || Array.isArray(step)) return [];
    const run = (step as Record<string, unknown>).run;
    return typeof run === "string" ? [run] : [];
  });
}

function jobUses(job: Record<string, unknown>): string[] {
  if (!Array.isArray(job.steps)) return [];
  return job.steps.flatMap((step) => {
    if (typeof step !== "object" || step === null || Array.isArray(step)) return [];
    const uses = (step as Record<string, unknown>).uses;
    return typeof uses === "string" ? [uses] : [];
  });
}

function jobNeeds(job: Record<string, unknown>): string[] {
  return typeof job.needs === "string"
    ? [job.needs]
    : Array.isArray(job.needs)
    ? job.needs.filter((value): value is string => typeof value === "string")
    : [];
}

function scriptPattern(manager: QualityGateManifest["package"]["manager"], script: string): RegExp {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = manager === "bun"
    ? "bun\\s+run"
    : manager === "yarn" ? "yarn(?:\\s+run)?" : `${manager}\\s+run`;
  return new RegExp(`(?:^|[;&|]\\s*)${prefix}\\s+${escaped}(?:\\s|$)`, "m");
}

function frozenInstallPattern(manager: QualityGateManifest["package"]["manager"]): RegExp {
  if (manager === "bun") return /bun\s+install\s+--frozen-lockfile/;
  if (manager === "npm") return /npm\s+ci(?:\s|$)/;
  if (manager === "pnpm") return /pnpm\s+install\s+--frozen-lockfile/;
  return /yarn\s+install\s+--immutable/;
}

function runtimeReady(
  runtime: QualityGateDefinition["runtime"],
  manager: QualityGateManifest["package"]["manager"],
  uses: readonly string[],
): boolean {
  const runtimeReady = runtime === "none" ||
    (runtime === "node" && uses.some((value) => /^actions\/setup-node@/.test(value))) ||
    (runtime === "bun" && uses.some((value) => /^oven-sh\/setup-bun@/.test(value)));
  const managerReady = manager === "npm" ||
    (manager === "pnpm" && uses.some((value) => /^pnpm\/action-setup@/.test(value))) ||
    (manager === "yarn" && uses.some((value) => /^actions\/setup-node@/.test(value))) ||
    (manager === "bun" && uses.some((value) => /^oven-sh\/setup-bun@/.test(value)));
  return runtimeReady && managerReady;
}

function workflowRunReferences(workflow: ParsedWorkflow): string[] {
  const on = workflow.root.on;
  if (typeof on !== "object" || on === null || Array.isArray(on)) return [];
  const workflowRun = (on as Record<string, unknown>).workflow_run;
  if (typeof workflowRun !== "object" || workflowRun === null || Array.isArray(workflowRun)) {
    return [];
  }
  const workflows = (workflowRun as Record<string, unknown>).workflows;
  return typeof workflows === "string"
    ? [workflows]
    : Array.isArray(workflows)
    ? workflows.filter((value): value is string => typeof value === "string")
    : [];
}

function checkGithubActions(
  projectDir: string,
  manifest: QualityGateManifest,
  findings: QualityGateFinding[],
): string[] {
  const parsed = manifest.workflows
    .map((workflow) => parseWorkflow(projectDir, workflow, findings))
    .filter((workflow): workflow is ParsedWorkflow => workflow !== null);
  const workflows = new Map(parsed.map((workflow) => [workflow.name, workflow]));
  let packageJson: Record<string, unknown> = {};
  const packagePath = safeProjectPath(projectDir, manifest.package.path, "package.path");
  try {
    packageJson = record(JSON.parse(readFileSync(packagePath, "utf8")), manifest.package.path);
  } catch (error) {
    finding(findings, "package.invalid", manifest.package.path, String(error));
  }
  const scripts = typeof packageJson.scripts === "object" && packageJson.scripts !== null &&
      !Array.isArray(packageJson.scripts)
    ? packageJson.scripts as Record<string, unknown>
    : {};
  for (const gate of manifest.gates) {
    if (typeof scripts[gate.script] !== "string") {
      finding(
        findings,
        "gate.script-missing",
        manifest.package.path,
        `Gate ${gate.id} requires missing package script "${gate.script}"`,
      );
    }
    const workflow = workflows.get(gate.workflow);
    if (workflow === undefined) {
      finding(
        findings,
        "gate.workflow-missing",
        "manifest",
        `Gate ${gate.id} references unknown workflow "${gate.workflow}"`,
      );
      continue;
    }
    const job = workflow.jobs[gate.job];
    if (job === undefined) {
      finding(
        findings,
        "gate.job-missing",
        workflow.path,
        `Gate ${gate.id} references missing job "${gate.job}"`,
      );
      continue;
    }
    const runs = jobRuns(job);
    const uses = jobUses(job);
    if (typeof job["runs-on"] !== "string" || String(job["runs-on"]).trim() === "") {
      finding(
        findings,
        "gate.runner-missing",
        workflow.path,
        `Job ${gate.job} has no concrete runs-on runner`,
      );
    }
    if (!runtimeReady(gate.runtime, manifest.package.manager, uses)) {
      finding(
        findings,
        "gate.runtime-not-prepared",
        workflow.path,
        `Job ${gate.job} does not prepare ${gate.runtime}/${manifest.package.manager} on a fresh runner`,
      );
    }
    if (!runs.some((run) => frozenInstallPattern(manifest.package.manager).test(run))) {
      finding(
        findings,
        "gate.frozen-install-missing",
        workflow.path,
        `Job ${gate.job} has no frozen dependency install`,
      );
    }
    if (!runs.some((run) => scriptPattern(manifest.package.manager, gate.script).test(run))) {
      finding(
        findings,
        "gate.script-not-run",
        workflow.path,
        `Job ${gate.job} does not run package script "${gate.script}"`,
      );
    }
  }
  const aggregateWorkflow = workflows.get(manifest.aggregate.workflow);
  const aggregateJob = aggregateWorkflow?.jobs[manifest.aggregate.job];
  if (aggregateWorkflow === undefined || aggregateJob === undefined) {
    finding(
      findings,
      "aggregate.job-missing",
      aggregateWorkflow?.path ?? "manifest",
      `Aggregate job ${manifest.aggregate.workflow}/${manifest.aggregate.job} does not exist`,
    );
  } else {
    const requiredJobs = manifest.gates
      .filter((gate) => gate.required && gate.workflow === manifest.aggregate.workflow)
      .map((gate) => gate.job);
    for (const gate of manifest.gates.filter((candidate) => candidate.required)) {
      if (gate.workflow !== manifest.aggregate.workflow) {
        finding(
          findings,
          "aggregate.cross-workflow-gate",
          "manifest",
          `Required gate ${gate.id} is outside aggregate workflow ${manifest.aggregate.workflow}`,
        );
      }
    }
    const needs = new Set(jobNeeds(aggregateJob));
    for (const job of requiredJobs) {
      if (!needs.has(job)) {
        finding(
          findings,
          "aggregate.need-missing",
          aggregateWorkflow.path,
          `Aggregate job ${manifest.aggregate.job} does not need required job ${job}`,
        );
      }
    }
    const jobName = typeof aggregateJob.name === "string"
      ? aggregateJob.name
      : manifest.aggregate.job;
    const actualCheck = `${manifest.aggregate.workflow} / ${jobName}`;
    if (manifest.aggregate.required_check !== actualCheck) {
      finding(
        findings,
        "aggregate.check-name-mismatch",
        aggregateWorkflow.path,
        `Required check is "${manifest.aggregate.required_check}" but workflow exposes "${actualCheck}"`,
      );
    }
  }
  if (!manifest.required_checks.includes(manifest.aggregate.required_check)) {
    finding(
      findings,
      "required-check.aggregate-missing",
      "manifest",
      "required_checks does not include aggregate.required_check",
    );
  }
  const exposedChecks = new Set(parsed.flatMap((workflow) =>
    Object.entries(workflow.jobs).map(([jobId, job]) => {
      const jobName = typeof job.name === "string" ? job.name : jobId;
      return `${workflow.name} / ${jobName}`;
    })
  ));
  for (const check of manifest.required_checks) {
    if (!exposedChecks.has(check)) {
      finding(
        findings,
        "required-check.unknown",
        "manifest",
        `Required check "${check}" is not exposed by a declared workflow job`,
      );
    }
  }
  for (const workflow of parsed) {
    for (const reference of workflowRunReferences(workflow)) {
      if (!workflows.has(reference)) {
        finding(
          findings,
          "workflow-run.target-missing",
          workflow.path,
          `workflow_run references unknown workflow name "${reference}"`,
        );
      }
    }
  }
  return parsed.map((workflow) => resolve(projectDir, workflow.path));
}

function runActionlint(paths: readonly string[], requested: boolean): ActionlintResult {
  if (!requested) return { status: "not-requested", output: "" };
  const result = spawnSync("actionlint", [...paths], { encoding: "utf8" });
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { status: "unavailable", output: result.error.message };
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { status: result.status === 0 ? "passed" : "failed", output };
}

export function defaultQualityGateManifestPath(projectDir: string): string {
  return join(
    activeIntentRecordDir(resolve(projectDir)),
    "construction",
    "ci-pipeline",
    "quality-gate-manifest.json",
  );
}

export function checkQualityGates(
  projectDir: string,
  options: QualityGateCheckOptions = {},
): QualityGateCheckResult {
  const projectRoot = resolve(projectDir);
  const manifestPath = options.manifestPath === undefined
    ? defaultQualityGateManifestPath(projectRoot)
    : safeProjectPath(projectRoot, options.manifestPath, "manifest path");
  const portableManifest = relative(projectRoot, manifestPath).split(sep).join("/");
  const manifest = parseQualityGateManifest(readFileSync(manifestPath, "utf8"), portableManifest);
  const findings: QualityGateFinding[] = [];
  let workflowPaths: string[] = [];
  if (manifest.provider.id === "github-actions") {
    workflowPaths = checkGithubActions(projectRoot, manifest, findings);
  } else {
    finding(
      findings,
      "provider.unsupported",
      portableManifest,
      `Unsupported Quality Gate provider: ${manifest.provider.id}`,
    );
  }
  const actionlint = runActionlint(workflowPaths, options.actionlint === true);
  if (actionlint.status === "failed") {
    finding(findings, "actionlint.failed", ".github/workflows", actionlint.output);
  }
  return {
    valid: findings.every((row) => row.severity !== "error"),
    manifest_path: portableManifest,
    provider: manifest.provider.id,
    findings,
    actionlint,
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  try {
    if (command !== "check" || !cliHasCommand(QUALITY_GATE_CLI_CONTRACT, command)) {
      throw new Error("Usage: aidlc-quality-gate check --project-dir <dir> [--manifest <path>] [--actionlint]");
    }
    const unknown = cliUnknownFlags(QUALITY_GATE_CLI_CONTRACT, command, args);
    if (unknown.length > 0) throw new Error(`Unknown flag(s): ${unknown.join(", ")}`);
    const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
    const manifest = flagValue(args, "--manifest");
    const result = checkQualityGates(projectDir, {
      ...(manifest === undefined ? {} : { manifestPath: manifest }),
      actionlint: args.includes("--actionlint"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
