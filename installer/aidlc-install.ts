#!/usr/bin/env node

// Public GitHub transport only. The native executable contains the TypeScript
// execution layer; Core data and Codex Harness files are fetched separately.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

type Command = "install" | "update";
type Harness = "codex";

interface CliOptions {
  command: Command;
  projectDir: string;
  harness: Harness;
  dryRun: boolean;
  json: boolean;
}

interface DistributionFileRecord {
  path: string;
  sha256: string;
  bytes: number;
  executable: boolean;
  area: "core" | "harness";
}

interface DistributionBinaryRecord {
  target: string;
  asset: string;
  sha256: string;
  bytes: number;
  platform: "darwin" | "linux" | "win32";
  arch: "x64" | "arm64";
  libc?: "glibc" | "musl";
}

interface GithubDistributionManifest {
  format: "aidlc-github-distribution";
  schema_version: 1;
  version: string;
  repository: string;
  tag: string;
  project_root: string;
  files: DistributionFileRecord[];
  binaries: DistributionBinaryRecord[];
}

interface ManagedFile {
  path: string;
  sha256: string;
  bytes: number;
  executable: boolean;
}

interface InstallationManifest {
  format: "aidlc-project-installation";
  schema_version: 1 | 2;
  version: string;
  harness: Harness;
  installed_at: string;
  distribution?: {
    type: "github-release";
    repository: string;
    tag: string;
    target: string;
  };
  files: ManagedFile[];
}

interface SourceFile {
  path: string;
  content: Buffer;
  executable: boolean;
}

interface InstallResult {
  command: Command;
  version: string;
  project: string;
  executable: string;
  distribution_target: string;
  written: string[];
  unchanged: string[];
  conflicts: string[];
  dry_run: boolean;
}

const REPOSITORY = "sori883/aidlc";
const RELEASE_TAG = `v${AIDLC_VERSION}`;
const RELEASE_ROOT = (
  process.env.AIDLC_RELEASE_ROOT ??
  `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}`
).replace(/\/$/, "");
const RAW_PROJECT_ROOT = (
  process.env.AIDLC_RAW_PROJECT_ROOT ??
  `https://raw.githubusercontent.com/${REPOSITORY}/${RELEASE_TAG}/dist/project`
).replace(/\/$/, "");
const INSTALLATION_MANIFEST = ".aidlc/installation.json";
const DISTRIBUTION_MANIFEST_ASSET = "aidlc-distribution.json";
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_CONCURRENCY = 12;

function usage(): string {
  return "Usage: install.mjs <install|update> [--project <directory>] " +
    "[--harness codex] [--dry-run] [--json]";
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

function parseArgs(argv: string[]): CliOptions | null {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const command = argv[0];
  if (command !== "install" && command !== "update") throw new Error(usage());
  const valueFlags = new Set(["--project", "--harness"]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (valueFlags.has(arg)) {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      continue;
    }
    if (arg !== "--dry-run" && arg !== "--json") {
      throw new Error(`Unknown option: ${arg}\n${usage()}`);
    }
  }
  const harness = flagValue(argv, "--harness") ?? "codex";
  if (harness !== "codex") throw new Error(`Unsupported Harness: ${harness}`);
  return {
    command,
    projectDir: resolve(flagValue(argv, "--project") ?? "."),
    harness,
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
  };
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function safeRemotePath(path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe distribution path: ${path}`);
  }
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

async function fetchBytes(
  url: string,
  expected?: { sha256: string; bytes: number },
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": `aidlc-installer/${AIDLC_VERSION}` },
    });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (expected !== undefined) {
      if (content.byteLength !== expected.bytes) {
        throw new Error(
          `Downloaded size mismatch for ${url}: expected ${expected.bytes}, got ${content.byteLength}`,
        );
      }
      const actual = digest(content);
      if (actual !== expected.sha256) {
        throw new Error(`Downloaded SHA-256 mismatch for ${url}`);
      }
    }
    return content;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Download timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateDistributionManifest(value: unknown): GithubDistributionManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Distribution manifest is not an object");
  }
  const manifest = value as Partial<GithubDistributionManifest>;
  if (
    manifest.format !== "aidlc-github-distribution" ||
    manifest.schema_version !== 1 ||
    manifest.version !== AIDLC_VERSION ||
    manifest.repository !== REPOSITORY ||
    manifest.tag !== RELEASE_TAG ||
    manifest.project_root !== "dist/project" ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.binaries)
  ) throw new Error("Distribution manifest identity is invalid");

  const seen = new Set<string>();
  for (const file of manifest.files) {
    safeRemotePath(file.path);
    if (
      seen.has(file.path) ||
      !isHexDigest(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.executable !== false ||
      (file.area !== "core" && file.area !== "harness") ||
      file.path.endsWith(".ts")
    ) throw new Error(`Invalid project file record: ${file.path}`);
    seen.add(file.path);
  }
  for (const binary of manifest.binaries) {
    if (
      !isHexDigest(binary.sha256) ||
      !Number.isSafeInteger(binary.bytes) ||
      binary.bytes <= 10 * 1024 * 1024 ||
      typeof binary.asset !== "string" ||
      binary.asset.includes("/") ||
      typeof binary.target !== "string"
    ) throw new Error(`Invalid binary record: ${String(binary.asset)}`);
  }
  return manifest as GithubDistributionManifest;
}

async function distributionManifest(): Promise<GithubDistributionManifest> {
  const content = await fetchBytes(`${RELEASE_ROOT}/${DISTRIBUTION_MANIFEST_ASSET}`);
  try {
    return validateDistributionManifest(JSON.parse(content.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Distribution manifest is not valid JSON");
    throw error;
  }
}

function linuxLibc(): "glibc" | "musl" {
  const report = process.report?.getReport() as {
    header?: { glibcVersionRuntime?: string };
  } | undefined;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function selectBinary(
  manifest: GithubDistributionManifest,
): DistributionBinaryRecord {
  const platform = process.platform;
  const arch = process.arch;
  const libc = platform === "linux" ? linuxLibc() : undefined;
  const match = manifest.binaries.find((binary) =>
    binary.platform === platform &&
    binary.arch === arch &&
    (platform !== "linux" || binary.libc === libc));
  if (match === undefined) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}${libc === undefined ? "" : `-${libc}`}`,
    );
  }
  return match;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(values.length, 1)) }, worker),
  );
  return results;
}

function smokeNativeBinary(content: Buffer): void {
  const directory = mkdtempSync(join(tmpdir(), "aidlc-installer-smoke-"));
  const executable = join(directory, process.platform === "win32" ? "aidlc.exe" : "aidlc");
  try {
    writeFileSync(executable, content);
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const smoke = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: "" },
    });
    if (smoke.status !== 0 || smoke.stdout.trim() !== `aidlc ${AIDLC_VERSION}`) {
      throw new Error(
        `Downloaded native CLI failed verification (${String(smoke.status)}): ${smoke.stderr}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function sourceFiles(): Promise<{
  manifest: GithubDistributionManifest;
  binary: DistributionBinaryRecord;
  files: SourceFile[];
}> {
  const manifest = await distributionManifest();
  const binary = selectBinary(manifest);
  const binaryContentPromise = fetchBytes(
    `${RELEASE_ROOT}/${encodeURIComponent(binary.asset)}`,
    binary,
  );
  const projectFilesPromise = mapConcurrent(
    manifest.files,
    DOWNLOAD_CONCURRENCY,
    async (file): Promise<SourceFile> => ({
      path: file.path,
      content: await fetchBytes(
        `${RAW_PROJECT_ROOT}/${safeRemotePath(file.path)}`,
        file,
      ),
      executable: false,
    }),
  );
  const [binaryContent, projectFiles] = await Promise.all([
    binaryContentPromise,
    projectFilesPromise,
  ]);
  smokeNativeBinary(binaryContent);
  const executableName = process.platform === "win32" ? "aidlc.exe" : "aidlc";
  return {
    manifest,
    binary,
    files: [
      {
        path: portable(join(".aidlc", "bin", executableName)),
        content: binaryContent,
        executable: true,
      },
      ...projectFiles,
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function safeDestination(projectDir: string, path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe installation path: ${path}`);
  }
  const destination = resolve(projectDir, path);
  const rel = relative(projectDir, destination);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Installation path escapes project: ${path}`);
  }
  return destination;
}

function hasUnsafeAncestor(projectDir: string, path: string): boolean {
  const segments = portable(path).split("/").slice(0, -1);
  let current = projectDir;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return true;
  }
  return false;
}

function readManifest(projectDir: string): InstallationManifest | null {
  const path = safeDestination(projectDir, INSTALLATION_MANIFEST);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as InstallationManifest;
  if (
    value.format !== "aidlc-project-installation" ||
    (value.schema_version !== 1 && value.schema_version !== 2) ||
    !Array.isArray(value.files)
  ) throw new Error(`Invalid installation manifest: ${path}`);
  return value;
}

function atomicWrite(path: string, content: Buffer, executable: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  writeFileSync(temporary, content);
  if (executable && process.platform !== "win32") chmodSync(temporary, 0o755);
  if (process.platform !== "win32" || !existsSync(path)) {
    renameSync(temporary, path);
    return;
  }
  const backup = `${path}.${process.pid}-${Date.now()}.previous`;
  renameSync(path, backup);
  try {
    renameSync(temporary, path);
    rmSync(backup, { force: true });
  } catch (error) {
    if (existsSync(path)) rmSync(path, { force: true });
    renameSync(backup, path);
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function install(options: CliOptions): Promise<InstallResult> {
  if (existsSync(options.projectDir)) {
    const project = lstatSync(options.projectDir);
    if (project.isSymbolicLink() || !project.isDirectory()) {
      throw new Error(`Project is not a safe directory: ${options.projectDir}`);
    }
  }
  const previous = readManifest(options.projectDir);
  if (options.command === "update" && previous === null) {
    throw new Error("AI-DLC is not installed; run the install command first");
  }

  const distribution = await sourceFiles();
  const sources = distribution.files;
  const previousFiles = new Map((previous?.files ?? []).map((file) => [file.path, file]));
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];

  for (const source of sources) {
    const destination = safeDestination(options.projectDir, source.path);
    const nextHash = digest(source.content);
    if (hasUnsafeAncestor(options.projectDir, source.path)) {
      conflicts.push(source.path);
      continue;
    }
    if (!existsSync(destination)) {
      written.push(source.path);
      continue;
    }
    if (!lstatSync(destination).isFile()) {
      conflicts.push(source.path);
      continue;
    }
    const currentHash = digest(readFileSync(destination));
    if (currentHash === nextHash) {
      unchanged.push(source.path);
      continue;
    }
    const managed = previousFiles.get(source.path);
    if (managed !== undefined && managed.sha256 === currentHash) written.push(source.path);
    else conflicts.push(source.path);
  }

  const executableName = process.platform === "win32" ? "aidlc.exe" : "aidlc";
  const result: InstallResult = {
    command: options.command,
    version: AIDLC_VERSION,
    project: options.projectDir,
    executable: portable(join(".aidlc", "bin", executableName)),
    distribution_target: distribution.binary.target,
    written: written.sort(),
    unchanged: unchanged.sort(),
    conflicts: conflicts.sort(),
    dry_run: options.dryRun,
  };
  if (conflicts.length > 0 || options.dryRun) return result;

  mkdirSync(options.projectDir, { recursive: true });
  for (const source of sources) {
    if (!written.includes(source.path)) continue;
    atomicWrite(
      safeDestination(options.projectDir, source.path),
      source.content,
      source.executable,
    );
  }
  const nextFiles: ManagedFile[] = sources.map((source) => ({
    path: source.path,
    sha256: digest(source.content),
    bytes: source.content.byteLength,
    executable: source.executable,
  }));
  for (const managed of previous?.files ?? []) {
    if (!nextFiles.some((candidate) => candidate.path === managed.path)) {
      nextFiles.push(managed);
    }
  }
  nextFiles.sort((left, right) => left.path.localeCompare(right.path));
  const manifest: InstallationManifest = {
    format: "aidlc-project-installation",
    schema_version: 2,
    version: AIDLC_VERSION,
    harness: options.harness,
    installed_at: new Date().toISOString(),
    distribution: {
      type: "github-release",
      repository: distribution.manifest.repository,
      tag: distribution.manifest.tag,
      target: distribution.binary.target,
    },
    files: nextFiles,
  };
  atomicWrite(
    safeDestination(options.projectDir, INSTALLATION_MANIFEST),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    false,
  );
  return result;
}

function renderResult(result: InstallResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.conflicts.length > 0) {
    process.stderr.write(
      `AI-DLC ${result.command} stopped; existing files would be overwritten:\n` +
      `${result.conflicts.map((path) => `  - ${path}`).join("\n")}\n`,
    );
    return;
  }
  const action = result.dry_run ? "Would install" : "Installed";
  process.stdout.write(
    `${action} AI-DLC ${result.version} in ${result.project}\n` +
    `Native CLI: ./${result.executable}\n` +
    `${result.written.length} file(s) written; ${result.unchanged.length} unchanged.\n`,
  );
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options === null) return 0;
  const result = await install(options);
  renderResult(result, options.json);
  return result.conflicts.length > 0 ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
