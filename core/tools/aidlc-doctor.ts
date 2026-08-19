// AI-DLC workspace Doctor. Diagnosis is read-only; repair changes only
// deterministic generated data, missing scaffolding, and unambiguous cursors.

import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runtimeCoreDir,
} from "./aidlc-runtime-paths.ts";
import {
  appendAuditEntry,
  initializeAuditLog,
  readOrderedAuditEntries,
  type OrderedAuditEntry,
} from "./aidlc-audit.ts";
import {
  checkCompiledStageGraph,
  type CompileOptions,
  loadCompiledStageGraph,
  resolvePlanForScope,
  writeCompiledStageGraph,
} from "./aidlc-graph.ts";
import {
  ensureIntentBirthDirectories,
  setActiveIntentCursor,
} from "./aidlc-intent.ts";
import {
  checkRunnerSkills,
  type RunnerGeneratorOptions,
  writeRunnerSkills,
} from "./aidlc-runner-gen.ts";
import {
  activeIntentRecordDir,
  inspectDerivedIntentState,
  repairDerivedIntentState,
  validateIntentState,
} from "./aidlc-state.ts";
import { checkQualityGates } from "./aidlc-quality-gate.ts";
import { listSensorReceipts } from "./aidlc-sensor.ts";
import { loadActiveUnitDag } from "./aidlc-unit-graph.ts";
import {
  DEFAULT_SPACE,
  initializeWorkspace,
  isManagedMemorySeedEntry,
  workspaceRoot,
} from "./aidlc-workspace.ts";
import {
  withWorkspaceLock,
  workspaceLockDir,
  workspaceLockExists,
} from "./aidlc-workspace-lock.ts";

export type DoctorSeverity = "error" | "warning" | "info";
export type DoctorRepairability = "automatic" | "manual" | "none";

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  repair: DoctorRepairability;
  message: string;
  paths: string[];
}

export interface DoctorReport {
  projectDir: string;
  healthy: boolean;
  structuralHealth: DoctorHealth;
  executionHealth: DoctorHealth;
  findings: DoctorFinding[];
  recoveryActions: string[];
  repairs: string[];
  repairFailures: string[];
}

export interface DoctorHealth {
  audited: boolean;
  healthy: boolean;
  findings: DoctorFinding[];
}

export interface DoctorOptions {
  coreDir?: string;
  skillsDir?: string;
  authoredSkillDir?: string;
  fullAudit?: boolean;
}

interface DoctorContext {
  projectDir: string;
  coreDir: string;
  workspaceDir: string;
  activeSpace: string | null;
  spaceDir: string | null;
  intentsDir: string | null;
  recordDirs: string[];
  activeIntent: string | null;
  activeRecordDir: string | null;
}

interface BundleManifestEntry {
  path: string;
  sha256: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORE_DIR = runtimeCoreDir();
const PHASES = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateField(content: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^- \\*\\*${escaped}\\*\\*:[ \\t]*(.*)$`, "m")
    .exec(content)?.[1]?.trim() ?? null;
}

function replaceStateField(content: string, field: string, value: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^- \\*\\*${escaped}\\*\\*:[^\\n]*$`, "m");
  if (!pattern.test(content)) throw new Error(`State file has no ${field} field`);
  return content.replace(pattern, () => `- **${field}**: ${value}`);
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The successful rename already consumed the temporary path.
    }
    throw error;
  }
}

function finding(
  findings: DoctorFinding[],
  id: string,
  severity: DoctorSeverity,
  repair: DoctorRepairability,
  message: string,
  paths: string[] = [],
): void {
  findings.push({
    id,
    severity,
    repair,
    message,
    paths: paths.map((path) => resolve(path)),
  });
}

function compileOptions(coreDir: string): CompileOptions {
  return {
    catalogPath: join(coreDir, "aidlc-common", "data", "stage-catalog.json"),
    stagesDir: join(coreDir, "aidlc-common", "stages"),
    agentsDir: join(coreDir, "agents"),
    sensorsDir: join(coreDir, "sensors"),
    memoryDir: join(coreDir, "memory"),
    memoryDisplayRoot: "aidlc/spaces/default/memory",
    harnessDir: ".codex",
    graphPath: join(coreDir, "aidlc-common", "data", "stage-graph.json"),
    scopeGridPath: join(coreDir, "aidlc-common", "data", "scope-grid.json"),
    scopesDir: join(coreDir, "scopes"),
  };
}

function runnerOptions(
  projectDir: string,
  coreDir: string,
  options: DoctorOptions,
): RunnerGeneratorOptions | null {
  const skillsDir = resolve(options.skillsDir ?? join(projectDir, ".agents", "skills"));
  const packagedAuthored = resolve(
    options.authoredSkillDir ?? join(skillsDir, "aidlc"),
  );
  const sourceAuthored = resolve(coreDir, "../harness/codex/skills/aidlc");
  const authoredSkillDir = existsSync(join(packagedAuthored, "SKILL.md"))
    ? packagedAuthored
    : existsSync(join(sourceAuthored, "SKILL.md"))
    ? sourceAuthored
    : null;
  if (authoredSkillDir === null) return null;
  return {
    graphPath: join(coreDir, "aidlc-common", "data", "stage-graph.json"),
    scopesDir: join(coreDir, "scopes"),
    skillsDir,
    authoredSkillDir,
  };
}

function directoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function validIntentRecords(intentsDir: string): string[] {
  return directoryNames(intentsDir).filter((name) =>
    existsSync(join(intentsDir, name, "aidlc-state.md"))
  );
}

function readPointer(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

function buildContext(projectDir: string, coreDir: string): DoctorContext {
  const workspaceDir = workspaceRoot(projectDir);
  const spacesDir = join(workspaceDir, "spaces");
  const activeSpace = readPointer(join(workspaceDir, "active-space"));
  const validSpace = activeSpace !== null && existsSync(join(spacesDir, activeSpace))
    ? activeSpace
    : null;
  const spaceDir = validSpace === null ? null : join(spacesDir, validSpace);
  const intentsDir = spaceDir === null ? null : join(spaceDir, "intents");
  const recordDirs = intentsDir === null ? [] : validIntentRecords(intentsDir);
  const activeIntent = intentsDir === null
    ? null
    : readPointer(join(intentsDir, "active-intent"));
  const activeRecordDir =
    intentsDir !== null && activeIntent !== null && recordDirs.includes(activeIntent)
      ? join(intentsDir, activeIntent)
      : null;
  return {
    projectDir,
    coreDir,
    workspaceDir,
    activeSpace: validSpace,
    spaceDir,
    intentsDir,
    recordDirs,
    activeIntent,
    activeRecordDir,
  };
}

function expectedPlan(recordDir: string): unknown[] {
  const statePath = join(recordDir, "aidlc-state.md");
  const content = readFileSync(statePath, "utf8");
  const scope = stateField(content, "Scope");
  if (scope === null || scope.length === 0) throw new Error("State file has no Scope field");
  return resolvePlanForScope(scope);
}

function planMatches(recordDir: string): boolean {
  const actual = JSON.parse(readFileSync(join(recordDir, ".aidlc-plan.json"), "utf8"));
  return JSON.stringify(actual) === JSON.stringify(expectedPlan(recordDir));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeManifestPath(projectDir: string, path: string): string | null {
  if (path.length === 0 || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    return null;
  }
  const absolute = resolve(projectDir, path);
  const rel = relative(projectDir, absolute);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    ? null
    : absolute;
}

function inspectBundleManifest(projectDir: string, findings: DoctorFinding[]): void {
  const manifestPath = join(projectDir, "aidlc-bundle.json");
  if (!existsSync(manifestPath)) return;
  try {
    const value = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      generator?: unknown;
      files?: unknown;
    };
    if (value.generator !== "aidlc-codex-bundle" || !Array.isArray(value.files)) {
      throw new Error("invalid generator or files list");
    }
    const drifted: string[] = [];
    for (const raw of value.files) {
      const entry = raw as BundleManifestEntry;
      if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string") {
        throw new Error("invalid file entry");
      }
      const path = safeManifestPath(projectDir, entry.path);
      if (path === null || !existsSync(path) || !statSync(path).isFile()) {
        drifted.push(entry.path);
      } else if (sha256File(path) !== entry.sha256) {
        drifted.push(entry.path);
      }
    }
    if (drifted.length > 0) {
      finding(
        findings,
        "distribution.bundle-drift",
        "error",
        "manual",
        `Distribution bundle has ${drifted.length} missing or modified files; reinstall the bundle after generated repairs are attempted.`,
        [manifestPath, ...drifted.map((path) => join(projectDir, path))],
      );
    }
  } catch (error) {
    finding(
      findings,
      "distribution.manifest-invalid",
      "error",
      "manual",
      `Distribution manifest is invalid: ${detail(error)}`,
      [manifestPath],
    );
  }
}

function inspectDefinitions(
  context: DoctorContext,
  options: DoctorOptions,
  findings: DoctorFinding[],
): void {
  try {
    const checked = checkCompiledStageGraph(compileOptions(context.coreDir));
    if (checked.staleFiles.length > 0) {
      finding(
        findings,
        "definitions.compiled-drift",
        "error",
        "automatic",
        "Compiled Stage graph or Scope grid differs from the authored definitions.",
        checked.staleFiles,
      );
    }
  } catch (error) {
    finding(
      findings,
      "definitions.invalid",
      "error",
      "manual",
      `Authored definitions are invalid: ${detail(error)}`,
      [context.coreDir],
    );
  }
  const runners = runnerOptions(
    context.projectDir,
    context.coreDir,
    options,
  );
  if (runners !== null) {
    try {
      const checked = checkRunnerSkills(runners);
      if (!checked.valid) {
        finding(
          findings,
          "distribution.skills-drift",
          "error",
          "automatic",
          `Generated Skills drifted: ${checked.missing.length} missing, ${checked.stale.length} stale, ${checked.orphaned.length} orphaned.`,
          [checked.skillsDir],
        );
      }
    } catch (error) {
      finding(
        findings,
        "distribution.skills-invalid",
        "error",
        "manual",
        `Skills cannot be validated: ${detail(error)}`,
      );
    }
  }
}

function requiredMemoryFiles(coreDir: string): string[] {
  const root = join(coreDir, "memory");
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!isManagedMemorySeedEntry(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  walk(root);
  return files.sort();
}

function inspectWorkspace(context: DoctorContext, findings: DoctorFinding[]): void {
  if (!existsSync(context.workspaceDir)) {
    finding(
      findings,
      "workspace.missing",
      "error",
      "automatic",
      "AI-DLC Workspace has not been initialized.",
      [context.workspaceDir],
    );
    return;
  }
  const spacesDir = join(context.workspaceDir, "spaces");
  const spaces = directoryNames(spacesDir);
  const pointerPath = join(context.workspaceDir, "active-space");
  const pointer = readPointer(pointerPath);
  if (pointer === null || !spaces.includes(pointer)) {
    const repair = spaces.length === 1 || (pointer === null && spaces.includes(DEFAULT_SPACE))
      ? "automatic"
      : "manual";
    finding(
      findings,
      "workspace.active-space-invalid",
      "error",
      repair,
      pointer === null
        ? "Active Space pointer is missing or empty."
        : `Active Space pointer references missing Space "${pointer}".`,
      [pointerPath],
    );
    return;
  }
  if (context.spaceDir === null) return;
  const missingMemory = requiredMemoryFiles(context.coreDir)
    .map((path) => join(context.spaceDir ?? "", "memory", path))
    .filter((path) => !existsSync(path));
  if (missingMemory.length > 0) {
    finding(
      findings,
      "workspace.memory-missing",
      "error",
      "automatic",
      `Active Space is missing ${missingMemory.length} Memory seed files.`,
      missingMemory,
    );
  }
}

function inspectIntentRegistry(context: DoctorContext, findings: DoctorFinding[]): void {
  if (context.intentsDir === null) return;
  const registryPath = join(context.intentsDir, "intents.json");
  if (existsSync(registryPath)) {
    try {
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      if (!Array.isArray(registry)) throw new Error("expected an array");
      const rows = registry as Array<Record<string, unknown>>;
      if (rows.some((entry) =>
        typeof entry !== "object" || entry === null ||
        typeof entry.slug !== "string" || typeof entry.status !== "string"
      )) {
        throw new Error("every entry requires string slug and status");
      }
      const missing = rows
        .map((entry) =>
          typeof entry === "object" && entry !== null &&
              typeof (entry as Record<string, unknown>).dirName === "string"
            ? String((entry as Record<string, unknown>).dirName)
            : null
        )
        .filter((name): name is string => name !== null)
        .filter((name) => !context.recordDirs.includes(name));
      if (missing.length > 0) {
        finding(
          findings,
          "intent.registry-dangling",
          "error",
          "manual",
          `Intent registry references ${missing.length} missing records.`,
          [registryPath],
        );
      }
      if (rows.every((entry) => typeof entry.dirName === "string")) {
        const registered = new Set(rows.map((entry) => String(entry.dirName)));
        const orphaned = context.recordDirs.filter((name) => !registered.has(name));
        if (orphaned.length > 0) {
          finding(
            findings,
            "intent.registry-orphaned",
            "warning",
            "manual",
            `Found ${orphaned.length} Intent records not represented in the registry.`,
            orphaned.map((name) => join(context.intentsDir ?? "", name)),
          );
        }
      }
    } catch (error) {
      finding(
        findings,
        "intent.registry-invalid",
        "error",
        "manual",
        `Intent registry is invalid: ${detail(error)}`,
        [registryPath],
      );
    }
  }
  if (context.recordDirs.length === 0) return;
  if (
    context.activeIntent === null ||
    !context.recordDirs.includes(context.activeIntent)
  ) {
    finding(
      findings,
      "intent.active-pointer-invalid",
      "error",
      context.recordDirs.length === 1 ? "automatic" : "manual",
      context.activeIntent === null
        ? "Active Intent pointer is missing or empty."
        : `Active Intent pointer references missing record "${context.activeIntent}".`,
      [join(context.intentsDir, "active-intent")],
    );
  }
}

function inspectActiveIntent(
  context: DoctorContext,
  findings: DoctorFinding[],
  recoveryActions: string[],
): void {
  const recordDir = context.activeRecordDir;
  if (recordDir === null) return;
  const missingDirs = [
    ...PHASES.map((phase) => join(recordDir, phase)),
    join(recordDir, "verification"),
  ].filter((path) => !existsSync(path));
  if (missingDirs.length > 0) {
    finding(
      findings,
      "intent.scaffold-missing",
      "error",
      "automatic",
      `Active Intent is missing ${missingDirs.length} Stage record directories.`,
      missingDirs,
    );
  }
  const auditDir = join(recordDir, "audit");
  const auditFiles = existsSync(auditDir)
    ? readdirSync(auditDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    : [];
  if (auditFiles.length === 0) {
    finding(
      findings,
      "intent.audit-missing",
      "error",
      "automatic",
      "Active Intent Audit shard is missing.",
      [auditDir],
    );
  }
  let planValid = false;
  try {
    planValid = planMatches(recordDir);
  } catch {
    planValid = false;
  }
  if (!planValid) {
    let automatic = true;
    try {
      expectedPlan(recordDir);
    } catch {
      automatic = false;
    }
    finding(
      findings,
      "state.plan-invalid",
      "error",
      automatic ? "automatic" : "manual",
      "Execution plan is missing, malformed, or differs from the State Scope.",
      [join(recordDir, ".aidlc-plan.json")],
    );
    return;
  }
  try {
    validateIntentState(context.projectDir);
  } catch (error) {
    finding(
      findings,
      "state.invalid",
      "error",
      "manual",
      `State structure is invalid: ${detail(error)}`,
      [join(recordDir, "aidlc-state.md")],
    );
    return;
  }
  try {
    const derived = inspectDerivedIntentState(context.projectDir);
    if (derived.driftedFields.length > 0) {
      finding(
        findings,
        "state.derived-drift",
        "error",
        "automatic",
        `Derived State fields drifted: ${derived.driftedFields.join(", ")}.`,
        [join(recordDir, "aidlc-state.md")],
      );
    }
    if (!derived.workflowCompleted && derived.currentStage !== null) {
      recoveryActions.push(
        `Resume Stage "${derived.currentStage}" with the AI-DLC orchestrator; do not reset State.`,
      );
    }
  } catch (error) {
    finding(
      findings,
      "state.progress-ambiguous",
      "error",
      "manual",
      `State progress cannot be derived safely: ${detail(error)}`,
      [join(recordDir, "aidlc-state.md")],
    );
  }
  try {
    loadActiveUnitDag(context.projectDir);
  } catch (error) {
    finding(
      findings,
      "state.unit-dag-invalid",
      "error",
      "manual",
      `Unit DAG is invalid: ${detail(error)}`,
      [recordDir],
    );
  }
}

function inspectRuntime(context: DoctorContext, findings: DoctorFinding[]): void {
  if (workspaceLockExists(context.projectDir)) {
    finding(
      findings,
      "runtime.workspace-locked",
      "warning",
      "manual",
      "Workspace lock exists. Wait for the owner to finish; normal lock acquisition reaps stale owners.",
      [workspaceLockDir(context.projectDir)],
    );
  }
  const heartbeat = join(context.projectDir, ".aidlc-hooks-health", "sensor-fire.last");
  if (existsSync(heartbeat)) {
    const value = readPointer(heartbeat);
    if (value === null || Number.isNaN(Date.parse(value))) {
      finding(
        findings,
        "runtime.sensor-heartbeat-invalid",
        "warning",
        "manual",
        "Sensor Hook heartbeat is malformed; review Codex Hook trust and configuration.",
        [heartbeat],
      );
    }
  }
}

function constructionCompleted(state: string, entries: readonly OrderedAuditEntry[]): boolean {
  if (stateField(state, "Status") === "Completed") return true;
  return entries.some((entry) =>
    entry.event === "PHASE_COMPLETED" &&
    (entry.fields.Phase ?? entry.fields["Phase name"] ?? "").toLowerCase() === "construction"
  );
}

function stageExecutes(recordDir: string, slug: string): boolean {
  try {
    const plan = JSON.parse(
      readFileSync(join(recordDir, ".aidlc-plan.json"), "utf8"),
    ) as Array<{ slug?: unknown; action?: unknown }>;
    return Array.isArray(plan) && plan.some((entry) =>
      entry?.slug === slug && entry.action === "EXECUTE"
    );
  } catch {
    return false;
  }
}

function inspectBoltExecution(
  context: DoctorContext,
  state: string,
  entries: readonly OrderedAuditEntry[],
  findings: DoctorFinding[],
): void {
  const recordDir = context.activeRecordDir;
  if (recordDir === null) return;
  const planPath = join(recordDir, "inception", "delivery-planning", "bolt-plan.md");
  if (!existsSync(planPath)) return;
  const constructionEvidence = constructionCompleted(state, entries) ||
    entries.some((entry) =>
      entry.event === "BOLT_STARTED" ||
      entry.event === "BOLT_COMPLETED" ||
      entry.event === "BOLT_FAILED"
    );
  if (!constructionEvidence) return;
  const started = entries.filter((entry) => entry.event === "BOLT_STARTED");
  const completed = entries.filter((entry) => entry.event === "BOLT_COMPLETED");
  if (started.length === 0 || completed.length === 0) {
    finding(
      findings,
      "execution.bolt-events-missing",
      "error",
      "manual",
      `Bolt Plan exists but Audit has ${started.length} BOLT_STARTED and ${completed.length} BOLT_COMPLETED events; historical Bolt success cannot be inferred.`,
      [planPath, join(recordDir, "audit")],
    );
  }
  if (
    constructionCompleted(state, entries) &&
    (stateField(state, "Construction Autonomy Mode") ?? "unset") === "unset"
  ) {
    finding(
      findings,
      "execution.autonomy-unset",
      "error",
      "manual",
      "Construction is complete but its autonomy mode is unset; Doctor will not infer the missing human choice.",
      [join(recordDir, "aidlc-state.md")],
    );
  }
}

function inspectSensorExecution(
  context: DoctorContext,
  entries: readonly OrderedAuditEntry[],
  findings: DoctorFinding[],
): void {
  const recordDir = context.activeRecordDir;
  if (recordDir === null) return;
  const sensorEvents = entries.filter((entry) => entry.event.startsWith("SENSOR_"));
  const withoutFireId = sensorEvents.filter((entry) => !entry.fields["Fire ID"]);
  if (withoutFireId.length > 0) {
    finding(
      findings,
      "execution.sensor-fire-id-missing",
      "error",
      "manual",
      `${withoutFireId.length} Sensor Audit events have no Fire ID and cannot be correlated safely.`,
      [...new Set(withoutFireId.map((entry) => entry.path))],
    );
  }
  const fires = new Map<string, OrderedAuditEntry[]>();
  const terminals = new Map<string, OrderedAuditEntry[]>();
  const terminalEvents = new Set([
    "SENSOR_PASSED",
    "SENSOR_FAILED",
    "SENSOR_BUDGET_OVERRIDE",
  ]);
  for (const entry of sensorEvents) {
    const fireId = entry.fields["Fire ID"];
    if (!fireId) continue;
    const target = entry.event === "SENSOR_FIRED"
      ? fires
      : terminalEvents.has(entry.event) ? terminals : null;
    if (target !== null) target.set(fireId, [...(target.get(fireId) ?? []), entry]);
  }
  const duplicateFires = [...fires].filter(([, rows]) => rows.length > 1);
  if (duplicateFires.length > 0) {
    finding(
      findings,
      "execution.sensor-fire-duplicate",
      "error",
      "manual",
      `${duplicateFires.length} Fire IDs have duplicate SENSOR_FIRED events.`,
      [join(recordDir, "audit")],
    );
  }
  const missingTerminal = [...fires.keys()].filter((fireId) =>
    (terminals.get(fireId)?.length ?? 0) === 0
  );
  if (missingTerminal.length > 0) {
    finding(
      findings,
      "execution.sensor-terminal-missing",
      "error",
      "manual",
      `${missingTerminal.length} Sensor fires have no terminal outcome.`,
      [join(recordDir, "audit")],
    );
  }
  const duplicateTerminals = [...terminals].filter(([, rows]) => rows.length > 1);
  if (duplicateTerminals.length > 0) {
    finding(
      findings,
      "execution.sensor-terminal-duplicate",
      "error",
      "manual",
      `${duplicateTerminals.length} Fire IDs have more than one terminal Sensor outcome.`,
      [join(recordDir, "audit")],
    );
  }
  const orphanTerminals = [...terminals.keys()].filter((fireId) => !fires.has(fireId));
  if (orphanTerminals.length > 0) {
    finding(
      findings,
      "execution.sensor-terminal-orphaned",
      "error",
      "manual",
      `${orphanTerminals.length} terminal Sensor outcomes have no matching SENSOR_FIRED event.`,
      [join(recordDir, "audit")],
    );
  }
  const overrides = [...terminals.values()].flat().filter((entry) =>
    entry.event === "SENSOR_BUDGET_OVERRIDE"
  ).length;
  if (fires.size >= 10 && overrides / fires.size > 0.10) {
    finding(
      findings,
      "execution.sensor-override-ratio",
      "warning",
      "manual",
      `Sensor budget override ratio is ${overrides}/${fires.size} (${(100 * overrides / fires.size).toFixed(1)}%), above the 10% audit threshold.`,
      [join(recordDir, "audit")],
    );
  }

  let receipts: ReturnType<typeof listSensorReceipts> = [];
  try {
    receipts = listSensorReceipts(context.projectDir);
  } catch (error) {
    finding(
      findings,
      "execution.sensor-receipt-invalid",
      "error",
      "manual",
      `Sensor receipts cannot be validated: ${detail(error)}`,
      [join(recordDir, ".aidlc-sensors")],
    );
    return;
  }
  const receiptFireIds = new Set(receipts.map((entry) => entry.receipt.fire_id));
  const firesWithoutReceipts = [...fires.keys()].filter((fireId) =>
    !receiptFireIds.has(fireId)
  );
  if (firesWithoutReceipts.length > 0) {
    finding(
      findings,
      "execution.sensor-receipts-missing",
      "warning",
      "manual",
      `${firesWithoutReceipts.length} Sensor fires have no hash-bound receipt; those historical results are unverifiable.`,
      [join(recordDir, ".aidlc-sensors"), join(recordDir, "audit")],
    );
  }
  const stale = receipts.filter((entry) => !entry.freshness.fresh);
  if (stale.length > 0) {
    finding(
      findings,
      "execution.sensor-receipt-stale",
      "error",
      "none",
      `${stale.length} Sensor receipts are stale and must be replaced by a new Sensor fire.`,
      stale.map((entry) => join(context.projectDir, entry.path)),
    );
  }
}

function inspectQualityGateExecution(
  context: DoctorContext,
  state: string,
  findings: DoctorFinding[],
): void {
  const recordDir = context.activeRecordDir;
  if (recordDir === null) return;
  const manifestPath = join(
    recordDir,
    "construction",
    "ci-pipeline",
    "quality-gate-manifest.json",
  );
  if (!existsSync(manifestPath)) {
    if (constructionCompleted(state, []) && stageExecutes(recordDir, "ci-pipeline")) {
      finding(
        findings,
        "execution.quality-gate-manifest-missing",
        "error",
        "manual",
        "Completed workflow has no Quality Gate Manifest; CI readiness is unverifiable.",
        [manifestPath],
      );
    }
    return;
  }
  try {
    const checked = checkQualityGates(context.projectDir, { manifestPath });
    if (!checked.valid) {
      finding(
        findings,
        "execution.quality-gate-invalid",
        "error",
        "manual",
        `Quality Gate Manifest and CI differ: ${checked.findings.map((row) => row.code).join(", ")}.`,
        [manifestPath, ...checked.findings.map((row) => join(context.projectDir, row.path))],
      );
    }
  } catch (error) {
    finding(
      findings,
      "execution.quality-gate-invalid",
      "error",
      "manual",
      `Quality Gate Manifest cannot be validated: ${detail(error)}`,
      [manifestPath],
    );
  }
}

function inspectProjectRootExecution(
  context: DoctorContext,
  state: string,
  findings: DoctorFinding[],
): void {
  const stored = stateField(state, "Project Root");
  if (stored === null || resolve(stored) === context.projectDir) return;
  finding(
    findings,
    "execution.project-root-mismatch",
    "error",
    "automatic",
    `State Project Root is "${stored}" but the current project root is "${context.projectDir}".`,
    [join(context.activeRecordDir ?? context.projectDir, "aidlc-state.md")],
  );
}

function inspectExecution(
  context: DoctorContext,
  findings: DoctorFinding[],
): void {
  const recordDir = context.activeRecordDir;
  if (recordDir === null) return;
  const statePath = join(recordDir, "aidlc-state.md");
  if (!existsSync(statePath)) return;
  const state = readFileSync(statePath, "utf8");
  const entries = readOrderedAuditEntries(recordDir);
  inspectBoltExecution(context, state, entries, findings);
  inspectSensorExecution(context, entries, findings);
  inspectQualityGateExecution(context, state, findings);
  inspectProjectRootExecution(context, state, findings);
}

/** Diagnose one project without changing it. */
export function checkDoctor(
  projectDir: string,
  options: DoctorOptions = {},
): DoctorReport {
  const projectRoot = resolve(projectDir);
  const coreDir = resolve(options.coreDir ?? DEFAULT_CORE_DIR);
  const context = buildContext(projectRoot, coreDir);
  const structuralFindings: DoctorFinding[] = [];
  const executionFindings: DoctorFinding[] = [];
  const recoveryActions: string[] = [];
  const inspect = (name: string, operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      finding(
        structuralFindings,
        `doctor.${name}-inspection-failed`,
        "error",
        "manual",
        `${name} inspection failed safely: ${detail(error)}`,
      );
    }
  };
  inspect("definitions", () => inspectDefinitions(context, options, structuralFindings));
  inspect("bundle", () => inspectBundleManifest(projectRoot, structuralFindings));
  inspect("workspace", () => inspectWorkspace(context, structuralFindings));
  inspect("intent", () => inspectIntentRegistry(context, structuralFindings));
  inspect("state", () =>
    inspectActiveIntent(context, structuralFindings, recoveryActions)
  );
  inspect("runtime", () => inspectRuntime(context, structuralFindings));
  if (options.fullAudit === true) {
    try {
      inspectExecution(context, executionFindings);
    } catch (error) {
      finding(
        executionFindings,
        "doctor.execution-inspection-failed",
        "error",
        "manual",
        `execution inspection failed safely: ${detail(error)}`,
      );
    }
  }
  structuralFindings.sort((left, right) => left.id.localeCompare(right.id));
  executionFindings.sort((left, right) => left.id.localeCompare(right.id));
  const findings = [...structuralFindings, ...executionFindings];
  const structuralHealthy = structuralFindings.every((entry) => entry.severity === "info");
  const executionHealthy = executionFindings.every((entry) => entry.severity === "info");
  findings.sort((left, right) => left.id.localeCompare(right.id));
  return {
    projectDir: projectRoot,
    healthy: structuralHealthy && (options.fullAudit !== true || executionHealthy),
    structuralHealth: {
      audited: true,
      healthy: structuralHealthy,
      findings: structuralFindings,
    },
    executionHealth: {
      audited: options.fullAudit === true,
      healthy: options.fullAudit === true ? executionHealthy : true,
      findings: executionFindings,
    },
    findings,
    recoveryActions: [...new Set(recoveryActions)],
    repairs: [],
    repairFailures: [],
  };
}

function repairActiveSpace(context: DoctorContext): void {
  const spaces = directoryNames(join(context.workspaceDir, "spaces"));
  const current = readPointer(join(context.workspaceDir, "active-space"));
  const selected = spaces.length === 1
    ? spaces[0]
    : current === null && spaces.includes(DEFAULT_SPACE)
    ? DEFAULT_SPACE
    : null;
  if (selected === null || selected === undefined) {
    throw new Error("Active Space cannot be selected unambiguously");
  }
  writeFileAtomic(join(context.workspaceDir, "active-space"), `${selected}\n`);
}

function repairMemory(context: DoctorContext): void {
  if (context.spaceDir === null) throw new Error("No valid active Space");
  const sourceRoot = join(context.coreDir, "memory");
  for (const relativePath of requiredMemoryFiles(context.coreDir)) {
    const target = join(context.spaceDir, "memory", relativePath);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceRoot, relativePath), target, constants.COPYFILE_EXCL);
  }
}

function repairActiveIntent(context: DoctorContext): void {
  if (context.intentsDir === null || context.activeSpace === null) {
    throw new Error("No valid active Space");
  }
  if (context.recordDirs.length !== 1) {
    throw new Error("Active Intent cannot be selected unambiguously");
  }
  setActiveIntentCursor(
    context.projectDir,
    context.recordDirs[0] ?? "",
    context.activeSpace,
  );
}

function repairPlan(recordDir: string): void {
  writeFileAtomic(
    join(recordDir, ".aidlc-plan.json"),
    `${JSON.stringify(expectedPlan(recordDir), null, 2)}\n`,
  );
}

function repairProjectRoot(context: DoctorContext): void {
  if (context.activeRecordDir === null) throw new Error("No active Intent record");
  const statePath = join(context.activeRecordDir, "aidlc-state.md");
  const source = readFileSync(statePath, "utf8");
  const stored = stateField(source, "Project Root");
  if (stored === null) throw new Error("State file has no Project Root field");
  if (resolve(stored) === context.projectDir) return;
  writeFileAtomic(
    statePath,
    replaceStateField(source, "Project Root", context.projectDir),
  );
}

function applyAutomaticRepair(
  id: string,
  projectDir: string,
  options: DoctorOptions,
): void {
  const coreDir = resolve(options.coreDir ?? DEFAULT_CORE_DIR);
  const context = buildContext(projectDir, coreDir);
  if (id === "definitions.compiled-drift") {
    writeCompiledStageGraph(compileOptions(coreDir));
    return;
  }
  if (id === "distribution.skills-drift") {
    const runners = runnerOptions(projectDir, coreDir, options);
    if (runners === null) throw new Error("Authored main Skill is unavailable");
    writeRunnerSkills(runners);
    return;
  }
  if (id === "workspace.missing") {
    initializeWorkspace(projectDir, { memorySourceDir: join(coreDir, "memory") });
    return;
  }
  if (id === "workspace.active-space-invalid") {
    repairActiveSpace(context);
    return;
  }
  if (id === "workspace.memory-missing") {
    repairMemory(context);
    return;
  }
  if (id === "intent.active-pointer-invalid") {
    repairActiveIntent(context);
    return;
  }
  if (id === "intent.scaffold-missing") {
    if (context.activeRecordDir === null || context.activeSpace === null) {
      throw new Error("No active Intent record");
    }
    ensureIntentBirthDirectories(
      projectDir,
      context.activeRecordDir,
      context.activeSpace,
      loadCompiledStageGraph().map((stage) => stage.phase),
    );
    return;
  }
  if (id === "intent.audit-missing") {
    if (context.activeRecordDir === null) throw new Error("No active Intent record");
    initializeAuditLog(projectDir, context.activeRecordDir);
    return;
  }
  if (id === "state.plan-invalid") {
    if (context.activeRecordDir === null) throw new Error("No active Intent record");
    repairPlan(context.activeRecordDir);
    return;
  }
  if (id === "state.derived-drift") {
    repairDerivedIntentState(projectDir);
    return;
  }
  if (id === "execution.project-root-mismatch") {
    repairProjectRoot(context);
    return;
  }
  throw new Error(`No automatic repair implementation for ${id}`);
}

/** Apply only unambiguous automatic repairs, then return a fresh diagnosis. */
export function repairDoctor(
  projectDir: string,
  options: DoctorOptions = {},
): DoctorReport {
  const projectRoot = resolve(projectDir);
  const repairs: string[] = [];
  const repairFailures: string[] = [];
  const attempted = new Set<string>();
  for (let pass = 0; pass < 4; pass += 1) {
    const report = checkDoctor(projectRoot, options);
    const candidates = report.findings.filter(
      (entry) => entry.repair === "automatic" && !attempted.has(entry.id),
    );
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      attempted.add(candidate.id);
      try {
        withWorkspaceLock(projectRoot, () => {
          applyAutomaticRepair(candidate.id, projectRoot, options);
        });
        repairs.push(candidate.id);
      } catch (error) {
        repairFailures.push(`${candidate.id}: ${detail(error)}`);
      }
    }
  }
  const final = checkDoctor(projectRoot, options);
  if (repairs.length > 0) {
    try {
      const context = buildContext(
        projectRoot,
        resolve(options.coreDir ?? DEFAULT_CORE_DIR),
      );
      if (context.activeRecordDir !== null) {
        appendAuditEntry(projectRoot, context.activeRecordDir, "DOCTOR_REPAIRED", {
          Repairs: repairs.join(", "),
        });
      }
    } catch (error) {
      repairFailures.push(`doctor.audit: ${detail(error)}`);
    }
  }
  return { ...final, repairs, repairFailures };
}

function formatReport(report: DoctorReport): string {
  const lines = [
    `AI-DLC Doctor: ${report.healthy ? "healthy" : "attention required"}`,
    `Project: ${report.projectDir}`,
    `Structural health: ${report.structuralHealth.healthy ? "healthy" : "attention required"}`,
    `Execution health: ${report.executionHealth.audited ? (report.executionHealth.healthy ? "healthy" : "attention required") : "not audited"}`,
  ];
  for (const entry of report.findings) {
    lines.push(
      `[${entry.severity.toUpperCase()}] ${entry.id}: ${entry.message} (repair: ${entry.repair})`,
    );
  }
  for (const repair of report.repairs) lines.push(`[REPAIRED] ${repair}`);
  for (const failure of report.repairFailures) lines.push(`[REPAIR FAILED] ${failure}`);
  for (const action of report.recoveryActions) lines.push(`[RECOVERY] ${action}`);
  return `${lines.join("\n")}\n`;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  const projectDir = flagValue(args, "--project-dir");
  if (!["check", "repair"].includes(command ?? "") || projectDir === undefined) {
    console.error(
      "Usage: aidlc-doctor <check|repair> --project-dir <dir> [--full] [--json]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const options = { fullAudit: args.includes("--full") };
    const report = command === "repair"
      ? repairDoctor(projectDir, options)
      : checkDoctor(projectDir, options);
    process.stdout.write(
      args.includes("--json")
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatReport(report),
    );
    if (report.findings.some((entry) => entry.severity === "error")) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(detail(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
