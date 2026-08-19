#!/usr/bin/env bun

// Build the public GitHub Release transport without publishing an npm package.
// The native executable contains the TypeScript execution layer; generated
// Core data and Codex Harness files stay external under dist/project/.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AIDLC_REPOSITORY,
  DISTRIBUTION_MANIFEST_ASSET,
  DISTRIBUTION_PROJECT_ROOT,
  distributionArea,
  GITHUB_DISTRIBUTION_FORMAT,
  GITHUB_DISTRIBUTION_SCHEMA,
  type DistributionBinaryRecord,
  type DistributionFileRecord,
  type DistributionPlatform,
  type GithubDistributionManifest,
} from "../core/tools/aidlc-distribution-contract.ts";
import { writeProjectLayout } from "../core/tools/aidlc-project-layout.ts";
import { CODEX_HARNESS } from "../harness/codex/aidlc-harness.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import {
  buildBinary,
  nativeTargetName,
  type BinaryTargetName,
} from "./build-binaries.ts";
import { assertVersionedArtifacts } from "./check-version.ts";

export interface GithubBinaryTarget {
  buildTarget: Exclude<BinaryTargetName, "native">;
  asset: string;
  platform: DistributionPlatform;
  arch: "x64" | "arm64";
  libc?: "glibc" | "musl";
}

export type {
  DistributionBinaryRecord,
  DistributionFileRecord,
  GithubDistributionManifest,
} from "../core/tools/aidlc-distribution-contract.ts";

export const GITHUB_BINARY_TARGETS: readonly GithubBinaryTarget[] = [
  {
    buildTarget: "darwin-x64",
    asset: "aidlc-darwin-x64",
    platform: "darwin",
    arch: "x64",
  },
  {
    buildTarget: "darwin-arm64",
    asset: "aidlc-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
  },
  {
    buildTarget: "linux-x64-baseline",
    asset: "aidlc-linux-x64",
    platform: "linux",
    arch: "x64",
    libc: "glibc",
  },
  {
    buildTarget: "linux-arm64",
    asset: "aidlc-linux-arm64",
    platform: "linux",
    arch: "arm64",
    libc: "glibc",
  },
  {
    buildTarget: "linux-x64-musl",
    asset: "aidlc-linux-x64-musl",
    platform: "linux",
    arch: "x64",
    libc: "musl",
  },
  {
    buildTarget: "linux-arm64-musl",
    asset: "aidlc-linux-arm64-musl",
    platform: "linux",
    arch: "arm64",
    libc: "musl",
  },
  {
    buildTarget: "windows-x64",
    asset: "aidlc-windows-x64.exe",
    platform: "win32",
    arch: "x64",
  },
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_DIST = join(REPO_ROOT, "dist", "project");
const RELEASE_DIR = join(REPO_ROOT, "build", "github-release");
const INSTALLER_SOURCE = join(REPO_ROOT, "installer", "aidlc-install.ts");
const INSTALLER_ASSET = "install.mjs";

function portable(path: string): string {
  return path.split(sep).join("/");
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function visitFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(portable(relative(root, path)));
      else throw new Error(`Unsupported distribution entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

function directorySnapshot(root: string): Map<string, Buffer> {
  return new Map(visitFiles(root).map((path) => [path, readFileSync(join(root, path))]));
}

function assertSameDistribution(expectedRoot: string, actualRoot: string): void {
  const expected = directorySnapshot(expectedRoot);
  const actual = directorySnapshot(actualRoot);
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const drift = paths.filter((path) => {
    const left = expected.get(path);
    const right = actual.get(path);
    return left === undefined || right === undefined || !left.equals(right);
  });
  if (drift.length > 0) {
    throw new Error(
      `dist/project is stale (${drift.length} path(s)): ${drift.slice(0, 10).join(", ")}`,
    );
  }
}

export function writeTrackedProjectDistribution(): string[] {
  return writeProjectLayout({
    outDir: PROJECT_DIST,
    platform: "linux",
    descriptor: CODEX_HARNESS,
  }).files;
}

export function checkTrackedProjectDistribution(): void {
  if (!existsSync(PROJECT_DIST)) {
    throw new Error("dist/project is missing; run bun run distribution:write");
  }
  const temporary = mkdtempSync(join(tmpdir(), "aidlc-project-distribution-"));
  try {
    writeProjectLayout({
      outDir: temporary,
      platform: "linux",
      descriptor: CODEX_HARNESS,
    });
    assertSameDistribution(PROJECT_DIST, temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function projectFileRecords(): DistributionFileRecord[] {
  return visitFiles(PROJECT_DIST).map((path) => {
    if (path.endsWith(".ts")) {
      throw new Error(`Executable TypeScript leaked into the external distribution: ${path}`);
    }
    const content = readFileSync(join(PROJECT_DIST, path));
    return {
      path,
      sha256: digest(content),
      bytes: content.byteLength,
      executable: false,
      area: distributionArea(path, CODEX_HARNESS),
    };
  });
}

function nativeReleaseTarget(): GithubBinaryTarget {
  const native = nativeTargetName();
  const normalized = native === "linux-x64" ? "linux-x64-baseline" : native;
  const target = GITHUB_BINARY_TARGETS.find(({ buildTarget }) => buildTarget === normalized);
  if (target === undefined) throw new Error(`No GitHub Release target for ${native}`);
  return target;
}

function buildReleaseBinary(
  target: GithubBinaryTarget,
  nativeOnly: boolean,
): DistributionBinaryRecord {
  const report = buildBinary(nativeOnly ? "native" : target.buildTarget);
  assertVersionedArtifacts(AIDLC_VERSION, [{
    label: `binary build report:${target.buildTarget}`,
    version: report.version,
  }]);
  const destination = join(RELEASE_DIR, target.asset);
  cpSync(report.executable, destination);
  if (target.platform !== "win32") chmodSync(destination, 0o755);
  const content = readFileSync(destination);
  return {
    target: target.buildTarget,
    asset: target.asset,
    sha256: digest(content),
    bytes: content.byteLength,
    platform: target.platform,
    arch: target.arch,
    ...(target.libc === undefined ? {} : { libc: target.libc }),
  };
}

function buildInstaller(): void {
  if (!existsSync(INSTALLER_SOURCE)) {
    throw new Error(`Installer source is missing: ${INSTALLER_SOURCE}`);
  }
  const output = join(RELEASE_DIR, INSTALLER_ASSET);
  const result = spawnSync(process.execPath, [
    "build",
    INSTALLER_SOURCE,
    "--target=node",
    "--outfile",
    output,
  ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`Installer build failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function writeChecksums(): void {
  const assets = visitFiles(RELEASE_DIR).filter((path) => path !== "SHA256SUMS");
  const lines = assets.map((path) => {
    const content = readFileSync(join(RELEASE_DIR, path));
    return `${digest(content)}  ${path}`;
  });
  writeFileSync(join(RELEASE_DIR, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
}

export function packageGithubRelease(
  options: { nativeOnly?: boolean } = {},
): GithubDistributionManifest {
  checkTrackedProjectDistribution();
  rmSync(RELEASE_DIR, { recursive: true, force: true });
  mkdirSync(RELEASE_DIR, { recursive: true });

  const nativeOnly = options.nativeOnly ?? false;
  const targets = nativeOnly ? [nativeReleaseTarget()] : [...GITHUB_BINARY_TARGETS];
  const binaries = targets.map((target) => buildReleaseBinary(target, nativeOnly));
  buildInstaller();

  const manifest: GithubDistributionManifest = {
    format: GITHUB_DISTRIBUTION_FORMAT,
    schema_version: GITHUB_DISTRIBUTION_SCHEMA,
    version: AIDLC_VERSION,
    repository: AIDLC_REPOSITORY,
    tag: `v${AIDLC_VERSION}`,
    project_root: DISTRIBUTION_PROJECT_ROOT,
    files: projectFileRecords(),
    binaries,
  };
  assertVersionedArtifacts(AIDLC_VERSION, [{
    label: DISTRIBUTION_MANIFEST_ASSET,
    version: manifest.version,
  }]);
  writeFileSync(
    join(RELEASE_DIR, DISTRIBUTION_MANIFEST_ASSET),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeChecksums();
  return manifest;
}

function usage(): string {
  return "Usage: bun scripts/package-github-release.ts " +
    "[--write-project | --check-project | --native-only]";
}

export function main(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  if (argv.length === 1 && argv[0] === "--write-project") {
    const files = writeTrackedProjectDistribution();
    console.log(`Wrote dist/project (${files.length} declared files).`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--check-project") {
    checkTrackedProjectDistribution();
    console.log("dist/project is up to date.");
    return;
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--native-only")) {
    throw new Error(usage());
  }
  const manifest = packageGithubRelease({ nativeOnly: argv[0] === "--native-only" });
  console.log(
    `Packaged AI-DLC ${manifest.version} for ${manifest.binaries.length} target(s) ` +
    `at ${RELEASE_DIR}.`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
