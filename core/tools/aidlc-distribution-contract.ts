import { isAbsolute, sep } from "node:path";

export const AIDLC_REPOSITORY = "sori883/aidlc" as const;
export const GITHUB_DISTRIBUTION_FORMAT = "aidlc-github-distribution" as const;
export const GITHUB_DISTRIBUTION_SCHEMA = 1 as const;
export const PROJECT_INSTALLATION_FORMAT = "aidlc-project-installation" as const;
export const PROJECT_INSTALLATION_SCHEMA = 2 as const;
export const PROJECT_LAYOUT_FORMAT = "aidlc-project-distribution" as const;
export const PROJECT_LAYOUT_SCHEMA = 1 as const;
export const DISTRIBUTION_PROJECT_ROOT = "dist/project" as const;
export const DISTRIBUTION_MANIFEST_ASSET = "aidlc-distribution.json" as const;
export const PROJECT_LAYOUT_MANIFEST = ".codex/distribution-manifest.json" as const;
export const INSTALLATION_MANIFEST = ".codex/aidlc-installation.json" as const;
export const LEGACY_INSTALLATION_MANIFEST = ".aidlc/installation.json" as const;
export const NATIVE_CLI_PATH = ".codex/tools/aidlc" as const;

export type Harness = "codex";
export type DistributionArea = "core" | "harness";
export type DistributionPlatform = "darwin" | "linux" | "win32";
export type DistributionArch = "x64" | "arm64";
export type DistributionLibc = "glibc" | "musl";

export interface DistributionFileRecord {
  path: string;
  sha256: string;
  bytes: number;
  executable: false;
  area: DistributionArea;
}

export interface DistributionBinaryRecord {
  target: string;
  asset: string;
  sha256: string;
  bytes: number;
  platform: DistributionPlatform;
  arch: DistributionArch;
  libc?: DistributionLibc;
}

export interface GithubDistributionManifest {
  format: typeof GITHUB_DISTRIBUTION_FORMAT;
  schema_version: typeof GITHUB_DISTRIBUTION_SCHEMA;
  version: string;
  repository: typeof AIDLC_REPOSITORY;
  tag: string;
  project_root: typeof DISTRIBUTION_PROJECT_ROOT;
  files: DistributionFileRecord[];
  binaries: DistributionBinaryRecord[];
}

export interface ManagedFile {
  path: string;
  sha256: string;
  bytes: number;
  executable: boolean;
}

export interface InstallationManifest {
  format: typeof PROJECT_INSTALLATION_FORMAT;
  schema_version: 1 | typeof PROJECT_INSTALLATION_SCHEMA;
  version: string;
  harness: Harness;
  installed_at: string;
  distribution?: {
    type: "github-release";
    repository: typeof AIDLC_REPOSITORY;
    tag: string;
    target: string;
  };
  files: ManagedFile[];
}

const CORE_RUNTIME_TREES = new Set([
  "aidlc-common",
  "knowledge",
  "memory",
  "scopes",
  "sensors",
  "tools",
]);
const DISTRIBUTED_RUNTIME_TREES = new Set([...CORE_RUNTIME_TREES, "agents"]);
const DISTRIBUTION_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const DISTRIBUTION_ARCHITECTURES = new Set(["x64", "arm64"]);

export function nativeCliPath(platform: string): string {
  return platform === "win32" ? `${NATIVE_CLI_PATH}.exe` : NATIVE_CLI_PATH;
}

export function nativeCliCommand(): string {
  return `./${NATIVE_CLI_PATH}`;
}

export function distributionArea(path: string): DistributionArea {
  if (!path.startsWith(".codex/")) return "harness";
  const tail = path.slice(".codex/".length);
  const [tree] = tail.split("/");
  if (tree !== undefined && CORE_RUNTIME_TREES.has(tree)) return "core";
  if (tree === "agents" && path.endsWith(".md")) return "core";
  return "harness";
}

export function isRuntimeDistributionPath(path: string): boolean {
  if (!path.startsWith(".codex/") || path.endsWith(".ts")) return false;
  const [tree] = path.slice(".codex/".length).split("/");
  return tree !== undefined && DISTRIBUTED_RUNTIME_TREES.has(tree);
}

export function assertSafeDistributionPath(path: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment.length === 0)
  ) {
    throw new Error(`Unsafe distribution path: ${path}`);
  }
  return path;
}

export function encodedDistributionPath(path: string): string {
  return assertSafeDistributionPath(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateGithubDistributionManifest(
  value: unknown,
  expectedVersion: string,
): GithubDistributionManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Distribution manifest is not an object");
  }
  const manifest = value as Partial<GithubDistributionManifest>;
  if (
    manifest.format !== GITHUB_DISTRIBUTION_FORMAT ||
    manifest.schema_version !== GITHUB_DISTRIBUTION_SCHEMA ||
    manifest.version !== expectedVersion ||
    manifest.repository !== AIDLC_REPOSITORY ||
    manifest.tag !== `v${expectedVersion}` ||
    manifest.project_root !== DISTRIBUTION_PROJECT_ROOT ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.binaries)
  ) throw new Error("Distribution manifest identity is invalid");

  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file?.path !== "string") throw new Error("Invalid project file record");
    assertSafeDistributionPath(file.path);
    if (
      paths.has(file.path) ||
      !isHexDigest(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.executable !== false ||
      (file.area !== "core" && file.area !== "harness") ||
      file.path.endsWith(".ts")
    ) throw new Error(`Invalid project file record: ${file.path}`);
    paths.add(file.path);
  }

  const assets = new Set<string>();
  const targets = new Set<string>();
  for (const binary of manifest.binaries) {
    if (
      !isHexDigest(binary?.sha256) ||
      !Number.isSafeInteger(binary.bytes) ||
      binary.bytes <= 10 * 1024 * 1024 ||
      typeof binary.asset !== "string" ||
      binary.asset.length === 0 ||
      binary.asset.includes("/") ||
      binary.asset.includes("\\") ||
      typeof binary.target !== "string" ||
      binary.target.length === 0 ||
      !DISTRIBUTION_PLATFORMS.has(binary.platform) ||
      !DISTRIBUTION_ARCHITECTURES.has(binary.arch) ||
      (binary.libc !== undefined && binary.libc !== "glibc" && binary.libc !== "musl") ||
      assets.has(binary.asset) ||
      targets.has(binary.target)
    ) throw new Error(`Invalid binary record: ${String(binary?.asset)}`);
    assets.add(binary.asset);
    targets.add(binary.target);
  }
  return manifest as GithubDistributionManifest;
}

export function validateInstallationManifest(value: unknown): InstallationManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Installation manifest is not an object");
  }
  const manifest = value as Partial<InstallationManifest>;
  if (
    manifest.format !== PROJECT_INSTALLATION_FORMAT ||
    (manifest.schema_version !== 1 && manifest.schema_version !== PROJECT_INSTALLATION_SCHEMA) ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0 ||
    manifest.harness !== "codex" ||
    typeof manifest.installed_at !== "string" ||
    !Array.isArray(manifest.files)
  ) throw new Error("Installation manifest identity is invalid");

  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file?.path !== "string") throw new Error("Invalid managed file record");
    assertSafeDistributionPath(file.path);
    if (
      paths.has(file.path) ||
      !isHexDigest(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.executable !== "boolean"
    ) throw new Error(`Invalid managed file record: ${file.path}`);
    paths.add(file.path);
  }

  if (manifest.distribution !== undefined && (
    manifest.distribution.type !== "github-release" ||
    manifest.distribution.repository !== AIDLC_REPOSITORY ||
    typeof manifest.distribution.tag !== "string" ||
    typeof manifest.distribution.target !== "string"
  )) throw new Error("Installation distribution record is invalid");
  return manifest as InstallationManifest;
}
