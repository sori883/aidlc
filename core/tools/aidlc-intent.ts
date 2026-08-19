import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  activeSpace,
  RESERVED_RECORD_NAMES,
  slugify,
  workspaceRoot,
} from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";
import {
  initializeIntentStateAt,
  type InitializedIntentState,
} from "./aidlc-state.ts";
import {
  loadCompiledStageGraph,
  resolvePlanForScope,
} from "./aidlc-graph.ts";
import { detectWorkspace } from "./aidlc-workspace-detect.ts";
import {
  appendAuditEntry,
  initializeAuditLog,
  portableEvidencePath,
} from "./aidlc-audit.ts";

const ACTIVE_INTENT_POINTER = "active-intent";
export { slugify } from "./aidlc-workspace.ts";

export interface IntentRegistryEntry {
  uuid: string;
  slug: string;
  dirName?: string;
  scope?: string;
  repos?: string[];
  status: string;
}

export interface BornIntent {
  uuid: string;
  slug: string;
  dirName: string;
  recordDir: string;
  space: string;
}

export interface BornIntentWithState extends BornIntent {
  state: InitializedIntentState;
  auditPath: string;
}

export interface IntentInfo extends Omit<IntentRegistryEntry, "dirName"> {
  dirName: string | null;
  active: boolean;
}

export function intentsDir(projectDir: string, space?: string): string {
  const selectedSpace = space ?? activeSpace(projectDir);
  return join(workspaceRoot(projectDir), "spaces", selectedSpace, "intents");
}

/** Generate the UUIDv7 identity stored in intents.json. */
export function uuidv7(): string {
  const randomHex = randomUUID().replace(/-/g, "");
  const timestampHex = Date.now().toString(16).padStart(12, "0").slice(-12);
  const body = `${timestampHex}7${randomHex.slice(13)}`;
  return (
    `${body.slice(0, 8)}-${body.slice(8, 12)}-` +
    `${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`
  );
}

export function dateStamp(date: Date = new Date()): string {
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function writeFileAtomic(path: string, content: string): void {
  const temporaryPath = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }
}

export function readIntentRegistry(
  projectDir: string,
  space?: string,
): IntentRegistryEntry[] {
  const path = join(intentsDir(projectDir, space), "intents.json");
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(value)) return value as IntentRegistryEntry[];
  } catch {
    // Upstream treats an absent or malformed registry as an empty registry.
  }
  return [];
}

export function appendIntentToRegistry(
  projectDir: string,
  entry: IntentRegistryEntry,
  space?: string,
): void {
  const root = intentsDir(projectDir, space);
  const registryPath = join(root, "intents.json");
  const registry = readIntentRegistry(projectDir, space);
  registry.push(entry);
  mkdirSync(root, { recursive: true });
  writeFileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function recordDirMatches(entry: IntentRegistryEntry, dirName: string): boolean {
  if (entry.dirName !== undefined) return entry.dirName === dirName;
  if (!dirName.startsWith(`${entry.slug}-`)) return false;
  const suffix = dirName.slice(entry.slug.length + 1);
  const uuidSuffix = entry.uuid.replace(/-/g, "").slice(-suffix.length);
  return /^[0-9a-f]+$/.test(suffix) && suffix === uuidSuffix;
}

function displaySlugFromDirName(dirName: string): string {
  const dated = /^\d{6}-(.+)$/.exec(dirName);
  return dated?.[1] ?? dirName.replace(/-[0-9a-f]+$/, "");
}

function listIntentDirs(projectDir: string, space?: string): string[] {
  const root = intentsDir(projectDir, space);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(root, entry.name, "aidlc-state.md")),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function createUniqueRecordDir(intentsRoot: string, base: string): {
  dirName: string;
  recordDir: string;
} {
  mkdirSync(intentsRoot, { recursive: true });
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const dirName = attempt === 1 ? base : `${base}-${attempt}`;
    const recordDir = join(intentsRoot, dirName);
    try {
      mkdirSync(recordDir);
      return { dirName, recordDir };
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
  }
  throw new Error(
    `Could not find a free intent record directory for "${base}" in ${intentsRoot}`,
  );
}

export function setActiveIntentCursor(
  projectDir: string,
  dirName: string,
  space?: string,
): void {
  const root = intentsDir(projectDir, space);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ACTIVE_INTENT_POINTER), `${dirName}\n`, "utf8");
}

/** Resolve the selected record only when its state binding exists. */
export function activeIntent(
  projectDir: string,
  space?: string,
): string | null {
  const root = intentsDir(projectDir, space);
  try {
    const selected = readFileSync(
      join(root, ACTIVE_INTENT_POINTER),
      "utf8",
    ).trim();
    if (
      selected.length > 0 &&
      existsSync(join(root, selected, "aidlc-state.md"))
    ) {
      return selected;
    }
  } catch {
    // Fall back to a lone valid intent record.
  }

  const records = listIntentDirs(projectDir, space);
  return records.length === 1 ? records[0] ?? null : null;
}

export function listIntents(
  projectDir: string,
  space?: string,
): IntentInfo[] {
  const selectedSpace = space ?? activeSpace(projectDir);
  const registry = readIntentRegistry(projectDir, selectedSpace);
  const directories = listIntentDirs(projectDir, selectedSpace);
  const selectedIntent = activeIntent(projectDir, selectedSpace);
  const claimedDirectories = new Set<string>();

  const intents: IntentInfo[] = registry.map((entry) => {
    const dirName =
      directories.find((directory) => recordDirMatches(entry, directory)) ??
      null;
    if (dirName !== null) claimedDirectories.add(dirName);
    return {
      ...entry,
      dirName,
      active: dirName !== null && dirName === selectedIntent,
    };
  });
  for (const dirName of directories) {
    if (claimedDirectories.has(dirName)) continue;
    intents.push({
      uuid: "",
      slug: displaySlugFromDirName(dirName),
      status: "unknown",
      dirName,
      active: dirName === selectedIntent,
    });
  }
  return intents;
}

export function switchIntent(
  projectDir: string,
  target: string,
  space = activeSpace(projectDir),
): IntentInfo {
  const intents = listIntents(projectDir, space);
  let match = intents.find((intent) => intent.dirName === target);
  if (match === undefined) {
    const bySlug = intents.filter(
      (intent) => intent.slug === target && intent.dirName !== null,
    );
    if (bySlug.length > 1) {
      throw new Error(
        `Ambiguous intent "${target}" in space "${space}" ` +
          `(${bySlug.length} matches). Use a full record directory name: ` +
          bySlug.map((intent) => intent.dirName).join(", "),
      );
    }
    match = bySlug[0];
  }
  if (match === undefined || match.dirName === null) {
    throw new Error(`Unknown intent "${target}" in space "${space}"`);
  }
  setActiveIntentCursor(projectDir, match.dirName, space);
  return { ...match, active: true };
}

/**
 * Create and select one intent record using the current upstream identity and
 * directory conventions. Full state generation belongs to the next stage.
 */
export function birthIntent(
  projectDir: string,
  label: string,
  space = activeSpace(projectDir),
  scope?: string,
  repos?: string[],
): BornIntent {
  const projectRoot = resolve(projectDir);
  return withWorkspaceLock(projectRoot, () =>
    birthIntentUnlocked(projectRoot, label, space, scope, repos)
  );
}

/**
 * Upstream v2 Intent Birth transaction: mint the record, detect the workspace,
 * resolve its scope plan, and replace the placeholder with the full state file.
 */
export function birthIntentWithState(
  projectDir: string,
  label: string,
  space = activeSpace(projectDir),
  scope = "poc",
  repos?: string[],
): BornIntentWithState {
  const projectRoot = resolve(projectDir);
  // Fail before minting the record so an invalid scope cannot leave a partial
  // Intent or registry row behind.
  const scopePlan = resolvePlanForScope(scope);
  const graph = loadCompiledStageGraph();
  return withWorkspaceLock(projectRoot, () => {
    const born = birthIntentUnlocked(projectRoot, label, space, scope, repos);
    const startedAt = new Date().toISOString();
    const request = `/aidlc ${label}`;
    const auditPath = initializeAuditLog(projectRoot, born.recordDir);
    appendAuditEntry(projectRoot, born.recordDir, "WORKFLOW_STARTED", {
      Scope: scope,
      Request: request,
      ...(repos === undefined || repos.length === 0
        ? {}
        : { Repos: repos.join(", ") }),
    });

    const initializationStageCount = scopePlan.filter(
      (stage) => stage.phase === "initialization" && stage.action === "EXECUTE",
    ).length;
    appendAuditEntry(projectRoot, born.recordDir, "PHASE_STARTED", {
      Phase: "initialization",
      "Stage count": String(initializationStageCount),
      Scope: scope,
    });
    const phases = [...new Set(graph.map((stage) => stage.phase))];
    for (const phase of phases) {
      if (phase === "initialization") continue;
      const stages = scopePlan.filter((stage) => stage.phase === phase);
      if (stages.length > 0 && !stages.some((stage) => stage.action === "EXECUTE")) {
        appendAuditEntry(projectRoot, born.recordDir, "PHASE_SKIPPED", {
          Phase: phase,
          Scope: scope,
          Reason: `scope ${scope} excludes ${phase}`,
        });
      }
    }

    appendAuditEntry(projectRoot, born.recordDir, "STAGE_STARTED", {
      Stage: "workspace-scaffold",
      Agent: "orchestrator",
    });
    ensureIntentBirthDirectories(projectRoot, born.recordDir, space, phases);
    appendAuditEntry(projectRoot, born.recordDir, "WORKSPACE_SCAFFOLDED", {
      Request: request,
      Details:
        "Per-intent artifact dirs + space-level knowledge/ ensured (shell shipped by SEED)",
    });
    appendAuditEntry(projectRoot, born.recordDir, "STAGE_COMPLETED", {
      Stage: "workspace-scaffold",
      Details: "Per-intent artifact dirs + space-level knowledge/ ensured",
    });

    appendAuditEntry(projectRoot, born.recordDir, "STAGE_STARTED", {
      Stage: "workspace-detection",
      Agent: "orchestrator",
    });
    const scan = detectWorkspace(projectRoot);
    const uninitializedSubmodules = scan.submodules.filter(
      (submodule) => !submodule.initialized,
    );
    appendAuditEntry(projectRoot, born.recordDir, "WORKSPACE_SCANNED", {
      "Project Type": scan.projectType,
      Languages: scan.languages,
      Frameworks: scan.frameworks,
      "Build System": scan.buildSystem,
      ...(scan.nestedRoot === undefined
        ? {}
        : { "Nested Root": portableEvidencePath(projectRoot, scan.nestedRoot) }),
      ...(scan.submodules.length === 0
        ? {}
        : {
            Submodules:
              `${scan.submodules.length} declared, ` +
              `${uninitializedSubmodules.length} uninitialized`,
          }),
      Details: "Deterministic rule-based scan",
    });
    appendAuditEntry(projectRoot, born.recordDir, "STAGE_COMPLETED", {
      Stage: "workspace-detection",
      Details:
        `Classified ${scan.projectType}; languages=${scan.languages}; ` +
        `frameworks=${scan.frameworks}`,
    });

    appendAuditEntry(projectRoot, born.recordDir, "STAGE_STARTED", {
      Stage: "state-init",
      Agent: "orchestrator",
    });
    const state = initializeIntentStateAt(projectRoot, born.recordDir, {
      scope,
      projectDescription: label,
      startedAt,
      workspaceScan: scan,
    });
    appendAuditEntry(projectRoot, born.recordDir, "WORKSPACE_INITIALISED", {
      Request: request,
      "Project Type": scan.projectType,
      Scope: scope,
      Languages: scan.languages,
      Frameworks: scan.frameworks,
      "Build System": scan.buildSystem,
      Details:
        `${state.totalStages} stages in scope, routing to ` +
        `${state.firstStage ?? "none"}`,
    });
    appendAuditEntry(projectRoot, born.recordDir, "STAGE_COMPLETED", {
      Stage: "state-init",
      Details:
        `State initialized: ${scope} scope, ${state.totalStages} stages, ` +
        `routing to ${state.firstStage ?? "none"}`,
    });

    const firstStage = graph.find((stage) => stage.slug === state.firstStage);
    if (firstStage !== undefined && firstStage.phase !== "initialization") {
      appendAuditEntry(projectRoot, born.recordDir, "PHASE_COMPLETED", {
        "From phase": "initialization",
        "To phase": firstStage.phase,
        "Stages completed": String(state.completedStages),
      });
      appendAuditEntry(projectRoot, born.recordDir, "PHASE_VERIFIED", {
        "Phase boundary": `initialization → ${firstStage.phase}`,
      });
      appendAuditEntry(projectRoot, born.recordDir, "PHASE_STARTED", {
        Phase: firstStage.phase,
        Scope: scope,
      });
      appendAuditEntry(projectRoot, born.recordDir, "STAGE_STARTED", {
        Stage: firstStage.slug,
        Agent: firstStage.lead_agent,
      });
    }
    return { ...born, state, auditPath };
  });
}

/** Ensure the lazy per-Intent and Space-shared directories created at Birth. */
export function ensureIntentBirthDirectories(
  projectDir: string,
  recordDir: string,
  space: string,
  phases: readonly string[],
): void {
  mkdirSync(recordDir, { recursive: true });
  for (const phase of phases) {
    mkdirSync(join(recordDir, phase), { recursive: true });
  }
  mkdirSync(join(recordDir, "verification"), { recursive: true });
  mkdirSync(
    join(workspaceRoot(projectDir), "spaces", space, "knowledge"),
    { recursive: true },
  );
}

function birthIntentUnlocked(
  projectRoot: string,
  label: string,
  space: string,
  scope?: string,
  repos?: string[],
): BornIntent {
  const spaceDir = join(workspaceRoot(projectRoot), "spaces", space);
  if (!existsSync(spaceDir)) {
    throw new Error(
      `Space "${space}" does not exist in ${workspaceRoot(projectRoot)}. ` +
        "Initialize the workspace first.",
    );
  }

  const slug = slugify(label, 24);
  if (RESERVED_RECORD_NAMES.has(slug)) {
    throw new Error(`"${slug}" is a reserved name and cannot be an intent label`);
  }

  const uuid = uuidv7();
  const root = intentsDir(projectRoot, space);
  const { dirName, recordDir } = createUniqueRecordDir(
    root,
    `${dateStamp()}-${slug}`,
  );
  writeFileSync(
    join(recordDir, "aidlc-state.md"),
    "# AI-DLC State Tracking\n",
    { encoding: "utf8", flag: "wx" },
  );

  const entry: IntentRegistryEntry = {
    uuid,
    slug,
    dirName,
    ...(scope === undefined ? {} : { scope }),
    ...(repos === undefined || repos.length === 0 ? {} : { repos }),
    status: "in-flight",
  };
  appendIntentToRegistry(projectRoot, entry, space);
  setActiveIntentCursor(projectRoot, dirName, space);

  return { uuid, slug, dirName, recordDir, space };
}

export function main(argv: string[]): void {
  const [command, projectDir, label, ...args] = argv;
  const validBirth =
    command === "birth" &&
    projectDir !== undefined &&
    label !== undefined &&
    (args.length === 0 || (args.length === 2 && args[0] === "--scope"));
  const validSwitch =
    command === "switch" &&
    projectDir !== undefined &&
    label !== undefined &&
    args.length === 0;
  const validList =
    command === "list" &&
    projectDir !== undefined &&
    (label === undefined || (label === "--json" && args.length === 0));
  if (!validBirth && !validSwitch && !validList) {
    console.error(
      "Usage: aidlc-intent list <project-dir> [--json]\n" +
        "       aidlc-intent birth <project-dir> <label> [--scope <scope>]\n" +
        "       aidlc-intent switch <project-dir> <intent>",
    );
    process.exitCode = 1;
    return;
  }

  try {
    if (projectDir === undefined) throw new Error("project directory is required");
    if (command === "list") {
      const space = activeSpace(projectDir);
      const intents = listIntents(projectDir, space);
      const selected = intents.find((intent) => intent.active)?.dirName ?? null;
      if (label === "--json") {
        process.stdout.write(
          `${JSON.stringify({
            active: selected,
            space,
            intents: intents.map((intent) => ({
              uuid: intent.uuid,
              slug: intent.slug,
              status: intent.status,
              repos: intent.repos ?? [],
              dirName: intent.dirName,
              active: intent.active,
            })),
          })}\n`,
        );
        return;
      }
      if (intents.length === 0) {
        process.stdout.write(`No intents in space "${space}" yet.\n`);
        return;
      }
      process.stdout.write(
        `Intents in space "${space}":\n` +
          `${intents.map((intent) => `${intent.active ? "*" : " "} ${intent.dirName ?? intent.slug}  [${intent.status}]`).join("\n")}\n`,
      );
      return;
    }
    if (label === undefined) throw new Error("intent label is required");
    if (command === "switch") {
      const result = switchIntent(projectDir, label);
      console.log(`Active intent → ${result.dirName} (space: ${activeSpace(projectDir)})`);
      return;
    }
    const result = birthIntentWithState(
      projectDir,
      label,
      activeSpace(projectDir),
      args[1] ?? "poc",
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
