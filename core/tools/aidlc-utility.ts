// Read-only utility surfaces shared by Stage and Agent instructions.
// M17 starts with upstream-compatible workspace detection; later verbs are
// added behind the same auto-discovered CLI contract.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";
import { loadScopes } from "./aidlc-scope-loader.ts";
import {
  detectWorkspace,
  type SubmoduleEntry,
  type WorkspaceScan,
} from "./aidlc-workspace-detect.ts";

const UTILITY_CLI_CONTRACT = loadCliContract("aidlc-utility.ts");
const UTILITY_COMMANDS = ["detect"] as const;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

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
  return index === -1 ? undefined : args[index + 1];
}

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  const usage =
    "Usage: aidlc-utility detect [--project-dir <path>] [--json]";
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
    const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
    const result = detectProject(projectDir);
    process.stdout.write(
      args.includes("--json")
        ? `${JSON.stringify(result)}\n`
        : renderText(result),
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
