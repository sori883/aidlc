// Deterministic Codex distribution bundle generator. Authored AI-DLC core
// definitions and M11 runner generation remain the only sources of truth.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAgents, type AgentDefinition } from "./aidlc-agent-loader.ts";
import { loadCliContracts } from "./aidlc-cli-contract.ts";
import { runnerSkillFiles } from "./aidlc-runner-gen.ts";
import { CODEX_HARNESS } from "../../harness/codex/aidlc-harness.ts";

export const CODEX_BUNDLE_GENERATOR = "aidlc-codex-bundle";
export const CODEX_BUNDLE_SCHEMA = 1;
export const CODEX_BUNDLE_MANIFEST = "aidlc-bundle.json";

export interface CodexBundleOptions {
  outDir?: string;
  coreDir?: string;
  harnessDir?: string;
}

export interface CodexBundleManifest {
  generator: typeof CODEX_BUNDLE_GENERATOR;
  schema_version: typeof CODEX_BUNDLE_SCHEMA;
  files: Array<{ path: string; sha256: string }>;
}

export interface CodexBundleWriteResult {
  outDir: string;
  files: string[];
  removed: string[];
}

export interface CodexBundleCheckResult {
  valid: boolean;
  outDir: string;
  missing: string[];
  stale: string[];
  orphaned: string[];
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORE_DIR = resolve(MODULE_DIR, "..");
const DEFAULT_HARNESS_DIR = resolve(MODULE_DIR, "../../harness/codex");
const DEFAULT_OUT_DIR = resolve("dist/codex");
const CODEX_RUNTIME_ROOT = CODEX_HARNESS.layout.runtimeRoot;
const CORE_TREES = [
  "aidlc-common",
  "agents",
  "knowledge",
  "memory",
  "scopes",
  "sensors",
  "tools",
] as const;

function portable(path: string): string {
  return path.split(sep).join("/");
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolvedPaths(options: CodexBundleOptions): {
  outDir: string;
  coreDir: string;
  harnessDir: string;
} {
  return {
    outDir: resolve(options.outDir ?? DEFAULT_OUT_DIR),
    coreDir: resolve(options.coreDir ?? DEFAULT_CORE_DIR),
    harnessDir: resolve(options.harnessDir ?? DEFAULT_HARNESS_DIR),
  };
}

function requireFile(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing Codex bundle source file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function collectTree(
  files: Map<string, string>,
  sourceDir: string,
  destinationDir: string,
  transform?: (path: string, content: string) => string,
): void {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`Missing Codex bundle source directory: ${sourceDir}`);
  }
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".DS_Store") continue;
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      collectTree(files, sourcePath, destinationPath, transform);
    } else if (entry.isFile()) {
      const path = portable(destinationPath);
      const content = readFileSync(sourcePath, "utf8");
      files.set(path, transform?.(path, content) ?? content);
    } else {
      throw new Error(`Unsupported Codex bundle source entry: ${sourcePath}`);
    }
  }
}

export function codexRuntimeToolScripts(
  runtimePackageSource: string,
): ReadonlyMap<string, string> {
  const parsed = JSON.parse(runtimePackageSource) as {
    scripts?: Record<string, unknown>;
  };
  const scripts = new Map<string, string>();
  for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
    if (typeof command !== "string") continue;
    const match = command.match(/^bun tools\/(aidlc-[a-z0-9-]+\.ts)$/);
    if (match?.[1] !== undefined) scripts.set(match[1], name);
  }
  return scripts;
}

export function codexProjectCommands(
  coreDir: string = DEFAULT_CORE_DIR,
): ReadonlyMap<string, ReadonlySet<string>> {
  const commands = new Map<string, ReadonlySet<string>>();
  for (const [tool, contract] of loadCliContracts(
    join(coreDir, "tools", "contracts"),
  )) {
    const projectAware = new Set(
      Object.entries(contract.commands)
        .filter(([, command]) => command.flags.includes("--project-dir"))
        .map(([name]) => name),
    );
    if (projectAware.size > 0) commands.set(tool, projectAware);
  }
  return commands;
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function integratedRoute(tool: string, script: string): string {
  const worker = tool.match(/^aidlc-sensor-(.+)\.ts$/)?.[1];
  return worker === undefined
    ? script
    : `__sensor-script ${worker}`;
}

/** Render Harness-neutral Markdown as executable Codex instructions. */
export function transformCodexMarkdown(
  content: string,
  toolScripts: ReadonlyMap<string, string>,
  projectCommands: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): string {
  let rendered = content;
  for (const [tool, script] of toolScripts) {
    const toolPath = `{{HARNESS_DIR}}/tools/${tool}`;
    const route = integratedRoute(tool, script);
    for (const command of projectCommands.get(tool) ?? []) {
      rendered = rendered.replace(
        new RegExp(
          `bun\\s+${escapedRegex(toolPath)}\\s+${escapedRegex(command)}\\b`,
          "g",
        ),
        `bun run --cwd ${CODEX_RUNTIME_ROOT} aidlc ${route} ${command} --project-dir ..`,
      );
    }
    rendered = rendered.replace(
      new RegExp(`bun\\s+${escapedRegex(toolPath)}`, "g"),
      `bun run --cwd ${CODEX_RUNTIME_ROOT} aidlc ${route}`,
    );
  }
  return rendered
    .replaceAll(
      "{{HARNESS_DIR}}/tools/data/scope-grid.json",
      `${CODEX_RUNTIME_ROOT}/aidlc-common/data/scope-grid.json`,
    )
    .replaceAll("{{HARNESS_DIR}}/", `${CODEX_RUNTIME_ROOT}/`);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Render one project-scoped Codex custom Agent from an AI-DLC Agent. */
export function renderCodexAgentToml(
  agent: AgentDefinition,
  toolScripts: ReadonlyMap<string, string> = codexRuntimeToolScripts(
    requireFile(join(DEFAULT_HARNESS_DIR, "runtime", "package.json")),
  ),
  projectCommands: ReadonlyMap<string, ReadonlySet<string>> =
    codexProjectCommands(),
): string {
  const instructions = [
    transformCodexMarkdown(agent.instructions, toolScripts, projectCommands),
    "",
    "AI-DLC Codex constraints:",
    "- Work only on the exact Stage task and paths supplied by the conductor.",
    "- Do not spawn or delegate to another agent.",
    `- The source persona is ${CODEX_HARNESS.layout.agentRoot}/${agent.name}.md.`,
    `- Harness-neutral disallowed tool category: ${agent.disallowedTools}.`,
  ].join("\n");
  return [
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description)}`,
    `developer_instructions = ${tomlString(instructions)}`,
    "",
  ].join("\n");
}

function manifestFor(files: ReadonlyMap<string, string>): CodexBundleManifest {
  return {
    generator: CODEX_BUNDLE_GENERATOR,
    schema_version: CODEX_BUNDLE_SCHEMA,
    files: [...files]
      .map(([path, content]) => ({ path, sha256: digest(content) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function parseManifest(outDir: string): CodexBundleManifest | null {
  const path = join(outDir, CODEX_BUNDLE_MANIFEST);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as CodexBundleManifest;
    if (
      value.generator !== CODEX_BUNDLE_GENERATOR ||
      value.schema_version !== CODEX_BUNDLE_SCHEMA ||
      !Array.isArray(value.files)
    ) return null;
    if (value.files.some((entry) =>
      typeof entry?.path !== "string" || typeof entry.sha256 !== "string"
    )) return null;
    return value;
  } catch {
    return null;
  }
}

/** Render every file in the distributable bundle, relative to its root. */
export function codexBundleFiles(
  options: CodexBundleOptions = {},
): Map<string, string> {
  const { coreDir, harnessDir } = resolvedPaths(options);
  const files = new Map<string, string>();
  const runtimePackageSource = requireFile(
    join(harnessDir, "runtime", "package.json"),
  );
  const toolScripts = codexRuntimeToolScripts(runtimePackageSource);
  const projectCommands = codexProjectCommands(coreDir);
  const transformCore = (path: string, content: string): string => {
    if (path.endsWith(".md")) {
      return transformCodexMarkdown(content, toolScripts, projectCommands);
    }
    if (path === `${CODEX_RUNTIME_ROOT}/tools/aidlc-hook.ts`) {
      return requireFile(join(harnessDir, "hooks", "aidlc-sensor-fire.ts")).replace(
        '"../../../core/hooks/aidlc-sensor-fire.ts"',
        '"../hooks/aidlc-sensor-core.ts"',
      );
    }
    if (path.endsWith(".ts")) {
      return content.replaceAll(
        '"../../harness/codex/aidlc-harness.ts"',
        '"../harness/aidlc-harness.ts"',
      );
    }
    return content;
  };
  files.set(
    CODEX_HARNESS.layout.projectInstructions[0]!,
    requireFile(join(harnessDir, "AGENTS.md")),
  );
  files.set(
    CODEX_HARNESS.layout.hookConfigPath,
    requireFile(join(harnessDir, "hooks.json")),
  );
  files.set(
    `${CODEX_RUNTIME_ROOT}/package.json`,
    runtimePackageSource,
  );
  files.set(
    `${CODEX_RUNTIME_ROOT}/bun.lock`,
    requireFile(join(harnessDir, "runtime", "bun.lock")),
  );
  for (const tree of CORE_TREES) {
    collectTree(
      files,
      join(coreDir, tree),
      join(CODEX_RUNTIME_ROOT, tree),
      transformCore,
    );
  }
  files.set(
    `${CODEX_RUNTIME_ROOT}/hooks/aidlc-sensor-core.ts`,
    requireFile(join(coreDir, "hooks", "aidlc-sensor-fire.ts")),
  );
  files.set(
    `${CODEX_RUNTIME_ROOT}/hooks/aidlc-sensor-fire.ts`,
    requireFile(join(harnessDir, "hooks", "aidlc-sensor-fire.ts")).replace(
      '"../../../core/hooks/aidlc-sensor-fire.ts"',
      '"./aidlc-sensor-core.ts"',
    ),
  );
  files.set(
    `${CODEX_RUNTIME_ROOT}/harness/aidlc-harness.ts`,
    requireFile(join(harnessDir, "aidlc-harness.ts")).replace(
      '"../../core/tools/aidlc-harness-contract.ts"',
      '"../tools/aidlc-harness-contract.ts"',
    ),
  );
  for (const agent of loadAgents(join(coreDir, "agents"))) {
    files.set(
      `${CODEX_HARNESS.layout.agentRoot}/${agent.name}.toml`,
      renderCodexAgentToml(agent, toolScripts, projectCommands),
    );
  }
  for (const [path, content] of runnerSkillFiles({
    graphPath: join(coreDir, "aidlc-common", "data", "stage-graph.json"),
    scopesDir: join(coreDir, "scopes"),
    authoredSkillDir: join(harnessDir, "skills", "aidlc"),
  })) {
    files.set(portable(join(CODEX_HARNESS.layout.skillRoot, path)), content);
  }
  const manifest = manifestFor(files);
  files.set(CODEX_BUNDLE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

function safeGeneratedPath(outDir: string, path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe generated bundle path: ${path}`);
  }
  const absolute = resolve(outDir, path);
  const rel = relative(outDir, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Generated bundle path escapes output directory: ${path}`);
  }
  return absolute;
}

function ensureWritableRoot(outDir: string): CodexBundleManifest | null {
  if (!existsSync(outDir)) return null;
  if (!statSync(outDir).isDirectory()) {
    throw new Error(`Codex bundle output must be a directory: ${outDir}`);
  }
  const entries = readdirSync(outDir).filter((entry) => entry !== ".DS_Store");
  if (entries.length === 0) return null;
  const previous = parseManifest(outDir);
  if (previous === null) {
    throw new Error(
      `Refusing to overwrite non-bundle directory without ${CODEX_BUNDLE_MANIFEST}: ${outDir}`,
    );
  }
  return previous;
}

export function writeCodexBundle(
  options: CodexBundleOptions = {},
): CodexBundleWriteResult {
  const { outDir } = resolvedPaths(options);
  const previous = ensureWritableRoot(outDir);
  const expected = codexBundleFiles(options);
  const expectedPaths = new Set(expected.keys());
  const removed: string[] = [];
  for (const entry of previous?.files ?? []) {
    if (expectedPaths.has(entry.path)) continue;
    const path = safeGeneratedPath(outDir, entry.path);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    unlinkSync(path);
    removed.push(portable(entry.path));
  }
  for (const [path, content] of expected) {
    const absolute = safeGeneratedPath(outDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return {
    outDir,
    files: [...expected.keys()].sort(),
    removed: removed.sort(),
  };
}

export function checkCodexBundle(
  options: CodexBundleOptions = {},
): CodexBundleCheckResult {
  const { outDir } = resolvedPaths(options);
  const expected = codexBundleFiles(options);
  const missing: string[] = [];
  const stale: string[] = [];
  for (const [path, content] of expected) {
    const absolute = safeGeneratedPath(outDir, path);
    if (!existsSync(absolute)) missing.push(path);
    else if (!statSync(absolute).isFile() || readFileSync(absolute, "utf8") !== content) {
      stale.push(path);
    }
  }
  const expectedPaths = new Set(expected.keys());
  const orphaned = (parseManifest(outDir)?.files ?? [])
    .map((entry) => entry.path)
    .filter((path) => !expectedPaths.has(path) && existsSync(safeGeneratedPath(outDir, path)))
    .sort();
  return {
    valid: missing.length === 0 && stale.length === 0 && orphaned.length === 0,
    outDir,
    missing: missing.sort(),
    stale: stale.sort(),
    orphaned,
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  const outDir = flagValue(args, "--out");
  const options: CodexBundleOptions = outDir === undefined ? {} : { outDir };
  if (command === "write") {
    const result = writeCodexBundle(options);
    console.log(`Generated ${result.files.length} Codex bundle files at ${result.outDir}.`);
    return;
  }
  if (command === "check") {
    const result = checkCodexBundle(options);
    if (result.valid) {
      console.log(`Codex bundle is in sync at ${result.outDir}.`);
      return;
    }
    if (result.missing.length > 0) console.error(`Missing: ${result.missing.join(", ")}`);
    if (result.stale.length > 0) console.error(`Stale: ${result.stale.join(", ")}`);
    if (result.orphaned.length > 0) console.error(`Orphaned: ${result.orphaned.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.error("Usage: aidlc-codex-bundle <write|check> [--out <directory>]");
  process.exitCode = 1;
}

if (import.meta.main) runCli();
