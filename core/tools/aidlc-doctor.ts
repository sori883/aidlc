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
  appendAuditEntry,
  initializeAuditLog,
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
import { loadActiveUnitDag } from "./aidlc-unit-graph.ts";
import {
  DEFAULT_SPACE,
  initializeWorkspace,
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
  findings: DoctorFinding[];
  recoveryActions: string[];
  repairs: string[];
  repairFailures: string[];
}

export interface DoctorOptions {
  coreDir?: string;
  skillsDir?: string;
  authoredSkillDir?: string;
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
const DEFAULT_CORE_DIR = resolve(MODULE_DIR, "..");
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

/** Diagnose one project without changing it. */
export function checkDoctor(
  projectDir: string,
  options: DoctorOptions = {},
): DoctorReport {
  const projectRoot = resolve(projectDir);
  const coreDir = resolve(options.coreDir ?? DEFAULT_CORE_DIR);
  const context = buildContext(projectRoot, coreDir);
  const findings: DoctorFinding[] = [];
  const recoveryActions: string[] = [];
  const inspect = (name: string, operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      finding(
        findings,
        `doctor.${name}-inspection-failed`,
        "error",
        "manual",
        `${name} inspection failed safely: ${detail(error)}`,
      );
    }
  };
  inspect("definitions", () => inspectDefinitions(context, options, findings));
  inspect("bundle", () => inspectBundleManifest(projectRoot, findings));
  inspect("workspace", () => inspectWorkspace(context, findings));
  inspect("intent", () => inspectIntentRegistry(context, findings));
  inspect("state", () =>
    inspectActiveIntent(context, findings, recoveryActions)
  );
  inspect("runtime", () => inspectRuntime(context, findings));
  findings.sort((left, right) => left.id.localeCompare(right.id));
  return {
    projectDir: projectRoot,
    healthy: findings.every((entry) => entry.severity === "info"),
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

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  const projectDir = flagValue(args, "--project-dir");
  if (!["check", "repair"].includes(command ?? "") || projectDir === undefined) {
    console.error(
      "Usage: aidlc-doctor <check|repair> --project-dir <dir> [--json]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const report = command === "repair"
      ? repairDoctor(projectDir)
      : checkDoctor(projectDir);
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

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
