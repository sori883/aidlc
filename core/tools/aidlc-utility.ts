// Read-only utility surfaces shared by Stage and Agent instructions.
// M17 starts with upstream-compatible workspace detection; later verbs are
// added behind the same auto-discovered CLI contract.

import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";
import { loadScopes } from "./aidlc-scope-loader.ts";
import {
  loadCompiledScopeGrid,
  loadCompiledStageGraph,
} from "./aidlc-graph.ts";
import {
  detectWorkspace,
  type SubmoduleEntry,
  type WorkspaceScan,
} from "./aidlc-workspace-detect.ts";
import { activeIntent, readIntentRegistry } from "./aidlc-intent.ts";
import { activeSpace } from "./aidlc-workspace.ts";
import { addStagesToExecutionPlan } from "./aidlc-state.ts";

const UTILITY_CLI_CONTRACT = loadCliContract("aidlc-utility.ts");
const UTILITY_COMMANDS = [
  "detect",
  "scope-table",
  "stage-table",
  "codekb-path",
  "recompose",
] as const;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SCOPE_TABLE_BEGIN =
  "<!-- BEGIN: compiled scope grid via `bun aidlc-utility.ts scope-table` - do NOT hand-edit -->";
const SCOPE_TABLE_END = "<!-- END: compiled scope grid -->";
const STAGE_TABLE_BEGIN =
  "<!-- BEGIN: compiled stage graph via `bun aidlc-utility.ts stage-table` - do NOT hand-edit -->";
const STAGE_TABLE_END = "<!-- END: compiled stage graph -->";

export interface UtilityDetectResult {
  projectType: WorkspaceScan["projectType"];
  languages: string;
  frameworks: string;
  buildSystem: string;
  nestedRoot?: string;
  submodules: SubmoduleEntry[];
  scopesDir: string;
  scopeGridPath: string;
  scopes: string[];
}

export interface CodekbPathResult {
  space: string;
  repo: string;
  dir: string;
}

function safePathSegment(value: string, label: string): string {
  if (
    value === "" || value !== value.trim() || value === "." || value === ".." ||
    value.includes("/") || value.includes("\\") || value.includes("\0")
  ) {
    throw new Error(`${label} must be one non-empty path segment`);
  }
  return value;
}

/** Resolve the active Space's durable per-Repo code knowledge directory. */
export function resolveCodekbPath(
  projectDir: string,
  requestedRepo?: string,
): CodekbPathResult {
  const resolvedProjectDir = resolve(projectDir);
  const space = safePathSegment(activeSpace(resolvedProjectDir), "Space name");
  const selectedIntent = activeIntent(resolvedProjectDir, space);
  const recordedRepos = selectedIntent === null
    ? []
    : readIntentRegistry(resolvedProjectDir, space)
      .find((entry) => entry.dirName === selectedIntent)?.repos
      ?.map((repo) => repo.trim())
      .filter(Boolean) ?? [];
  const repo = safePathSegment(
    requestedRepo ??
      (recordedRepos.length === 1
        ? recordedRepos[0]!
        : basename(resolvedProjectDir)),
    "Repository name",
  );
  return {
    space,
    repo,
    dir: `aidlc/spaces/${space}/codekb/${repo}`,
  };
}

/** Read the project and name the exact Scope registries used by this runtime. */
export function detectProject(projectDir: string): UtilityDetectResult {
  const scan = detectWorkspace(projectDir);
  const scopesDir = resolve(MODULE_DIR, "../scopes");
  return {
    projectType: scan.projectType,
    languages: scan.languages,
    frameworks: scan.frameworks,
    buildSystem: scan.buildSystem,
    ...(scan.nestedRoot === undefined ? {} : { nestedRoot: scan.nestedRoot }),
    submodules: scan.submodules,
    scopesDir,
    scopeGridPath: resolve(MODULE_DIR, "../aidlc-common/data/scope-grid.json"),
    scopes: loadScopes(scopesDir).map((scope) => scope.name),
  };
}

/** Render the compiled Scope grid in the canonical upstream table shape. */
export function renderScopeTable(): string {
  const grid = loadCompiledScopeGrid();
  const lines = [
    "| Scope          | Depth         | TestStrategy | EXECUTE / Total |",
    "|----------------|---------------|--------------|-----------------|",
  ];
  for (const scope of loadScopes()) {
    const stages = grid[scope.name]?.stages;
    if (stages === undefined) {
      throw new Error(`Scope grid has no entry for "${scope.name}"`);
    }
    const total = Object.keys(stages).length;
    const execute = Object.values(stages).filter((action) => action === "EXECUTE").length;
    const testStrategy = scope.testStrategy ?? "(default)";
    lines.push(
      `| ${scope.name.padEnd(14)} | ${scope.depth.padEnd(13)} | ` +
        `${testStrategy.padEnd(12)} | ${`${execute} / ${total}`.padEnd(15)} |`,
    );
  }
  return lines.join("\n");
}

export function canonicalScopeTable(): string {
  return `${SCOPE_TABLE_BEGIN}\n\n${renderScopeTable()}\n\n${SCOPE_TABLE_END}`;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

/** Render the runtime Stage graph in graph order without recomputing it. */
export function renderStageTable(): string {
  const lines = [
    "| Slug | # | Stage | Phase | Execution | Lead Agent | Support Agents | Mode |",
    "|------|---|-------|-------|-----------|------------|----------------|------|",
  ];
  for (const stage of loadCompiledStageGraph()) {
    lines.push(
      `| ${stage.slug} | ${stage.number} | ${stage.name} | ` +
        `${titleCase(stage.phase)} | ${stage.execution} | ` +
        `${stage.lead_agent === "orchestrator" ? "(orchestrator)" : stage.lead_agent} | ` +
        `${stage.support_agents.length === 0 ? "—" : stage.support_agents.join(", ")} | ` +
        `${stage.mode} |`,
    );
  }
  return lines.join("\n");
}

export function canonicalStageTable(): string {
  return `${STAGE_TABLE_BEGIN}\n\n${renderStageTable()}\n\n${STAGE_TABLE_END}`;
}

function renderText(result: UtilityDetectResult): string {
  const uninitialized = result.submodules.filter((entry) => !entry.initialized).length;
  return [
    `Project type: ${result.projectType}`,
    `Languages: ${result.languages}`,
    `Frameworks: ${result.frameworks}`,
    `Build system: ${result.buildSystem}`,
    ...(result.nestedRoot === undefined ? [] : [`Nested root: ${result.nestedRoot}`]),
    ...(result.submodules.length === 0
      ? []
      : [
          `Submodules: ${result.submodules.length} declared, ` +
            `${uninitialized} uninitialized`,
        ]),
    `Scopes dir: ${result.scopesDir}`,
    `Scope grid: ${result.scopeGridPath}`,
    `Valid scopes: ${result.scopes.join(", ")}`,
    "",
  ].join("\n");
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  const usage =
    "Usage: aidlc-utility detect [--project-dir <path>] [--json]\n" +
    "       aidlc-utility scope-table\n" +
    "       aidlc-utility stage-table\n" +
    "       aidlc-utility codekb-path [--project-dir <path>] [--repo <name>] [--json]\n" +
    "       aidlc-utility recompose --add <stage[,stage...]> [--project-dir <path>] [--json]";
  if (
    !UTILITY_COMMANDS.includes(command as (typeof UTILITY_COMMANDS)[number]) ||
    !cliHasCommand(UTILITY_CLI_CONTRACT, command)
  ) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  try {
    const unknownFlags = cliUnknownFlags(UTILITY_CLI_CONTRACT, command, args);
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown flag(s) for ${command}: ${unknownFlags.join(", ")}`);
    }
    if (command === "scope-table") {
      process.stdout.write(`${canonicalScopeTable()}\n`);
      return;
    }
    if (command === "stage-table") {
      process.stdout.write(`${canonicalStageTable()}\n`);
      return;
    }
    const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
    if (command === "codekb-path") {
      const result = resolveCodekbPath(projectDir, flagValue(args, "--repo"));
      process.stdout.write(
        args.includes("--json")
          ? `${JSON.stringify(result)}\n`
          : `${result.dir}/\n`,
      );
      return;
    }
    if (command === "recompose") {
      const additions = (flagValue(args, "--add") ?? "")
        .split(",")
        .map((slug) => slug.trim())
        .filter(Boolean);
      const result = addStagesToExecutionPlan(projectDir, additions);
      process.stdout.write(
        args.includes("--json")
          ? `${JSON.stringify(result)}\n`
          : `Recomposed: added ${result.added.join(", ")}\n` +
            `Stages in scope: ${result.stagesInScope}\n` +
            `Next stage: ${result.nextStage ?? "none"}\n`,
      );
      return;
    }
    const result = detectProject(projectDir);
    process.stdout.write(
      args.includes("--json") ? `${JSON.stringify(result)}\n` : renderText(result),
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
