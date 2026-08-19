import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";

export const DEFAULT_SPACE = "default";
export const RESERVED_RECORD_NAMES: ReadonlySet<string> = new Set([
  "help",
  "list",
  "switch",
  "birth",
  "create",
  "archive",
  "rename",
  "show",
]);

/** Files created by the host OS are not part of the portable Memory seed. */
export function isManagedMemorySeedEntry(name: string): boolean {
  return name !== ".DS_Store";
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MEMORY_SOURCE_DIR = resolve(runtimeCoreDir(), "memory");

export interface InitializeWorkspaceOptions {
  memorySourceDir?: string;
}

export interface InitializeWorkspaceResult {
  projectDir: string;
  workspaceDir: string;
  activeSpace: string;
  createdFiles: string[];
  preservedFiles: string[];
}

export function workspaceRoot(projectDir: string): string {
  return join(resolve(projectDir), "aidlc");
}

export function slugify(text: string, maxLength = 48): string {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  if (!/^[a-z]/.test(slug)) slug = `intent-${slug}`.replace(/-+$/g, "");
  if (slug.length === 0) slug = "intent";
  return slug;
}

/** Resolve the selected space, defaulting exactly as upstream does. */
export function activeSpace(projectDir: string): string {
  try {
    const value = readFileSync(
      join(workspaceRoot(projectDir), "active-space"),
      "utf8",
    ).trim();
    if (value.length > 0) return value;
  } catch {
    // A fresh workspace selects the always-valid default space.
  }
  return DEFAULT_SPACE;
}

function requireDirectory(path: string, label: string): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    // Report a single, stable validation error below.
  }
  if (!isDirectory) throw new Error(`${label} is not a directory: ${path}`);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function writeFileIfMissing(
  path: string,
  content: string,
  createdFiles: string[],
  preservedFiles: string[],
): void {
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
    createdFiles.push(path);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    if (!lstatSync(path).isFile()) {
      throw new Error(`Workspace path must be a file: ${path}`);
    }
    preservedFiles.push(path);
  }
}

function copyMissingTree(
  sourceDir: string,
  targetDir: string,
  createdFiles: string[],
  preservedFiles: string[],
): void {
  mkdirSync(targetDir, { recursive: true });
  const entries = readdirSync(sourceDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!isManagedMemorySeedEntry(entry.name)) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(targetPath) && !lstatSync(targetPath).isDirectory()) {
        throw new Error(`Workspace path must be a directory: ${targetPath}`);
      }
      copyMissingTree(sourcePath, targetPath, createdFiles, preservedFiles);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Memory seed contains an unsupported entry: ${sourcePath}`);
    }

    try {
      copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL);
      createdFiles.push(targetPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (!lstatSync(targetPath).isFile()) {
        throw new Error(`Workspace path must be a file: ${targetPath}`);
      }
      preservedFiles.push(targetPath);
    }
  }
}

/**
 * Materialize the harness-neutral workspace shell shipped by upstream AI-DLC.
 * Intent records and state are deliberately created by the later intent-birth
 * flow, not by workspace initialization.
 */
export function initializeWorkspace(
  projectDir: string,
  options: InitializeWorkspaceOptions = {},
): InitializeWorkspaceResult {
  const resolvedProjectDir = resolve(projectDir);
  const memorySourceDir = resolve(
    options.memorySourceDir ?? DEFAULT_MEMORY_SOURCE_DIR,
  );
  requireDirectory(resolvedProjectDir, "Project directory");
  requireDirectory(memorySourceDir, "Memory source directory");

  const workspaceDir = workspaceRoot(resolvedProjectDir);
  const createdFiles: string[] = [];
  const preservedFiles: string[] = [];
  mkdirSync(workspaceDir, { recursive: true });

  const activeSpacePath = join(workspaceDir, "active-space");
  writeFileIfMissing(
    activeSpacePath,
    `${DEFAULT_SPACE}\n`,
    createdFiles,
    preservedFiles,
  );

  const activeSpace = readFileSync(activeSpacePath, "utf8").trim();
  if (activeSpace.length === 0) {
    throw new Error(`Active space pointer is empty: ${activeSpacePath}`);
  }

  const defaultMemoryDir = join(
    workspaceDir,
    "spaces",
    DEFAULT_SPACE,
    "memory",
  );
  copyMissingTree(
    memorySourceDir,
    defaultMemoryDir,
    createdFiles,
    preservedFiles,
  );

  return {
    projectDir: resolvedProjectDir,
    workspaceDir,
    activeSpace,
    createdFiles,
    preservedFiles,
  };
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  if (command !== "init" || args.length > 1) {
    console.error("Usage: aidlc-workspace init [project-dir]");
    process.exitCode = 1;
    return;
  }

  try {
    const result = initializeWorkspace(args[0] ?? ".");
    console.log(
      `Initialized AI-DLC workspace at ${result.workspaceDir} ` +
        `(${result.createdFiles.length} files created, ` +
        `${result.preservedFiles.length} preserved).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
