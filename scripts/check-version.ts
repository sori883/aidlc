#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

interface PackageJson {
  version?: unknown;
}

export interface VersionedArtifact {
  label: string;
  version: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSIONED_INSTALLER_DOCS = [
  "README.md",
  "docs/release-packaging.md",
  "docs/bun-migration-plan.md",
] as const;

function packageVersion(path: string): string {
  const value = JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error(`Package version is missing: ${path}`);
  }
  return value.version;
}

export function assertVersionedArtifacts(
  expected: string,
  artifacts: readonly VersionedArtifact[],
): void {
  const drift = artifacts.filter(({ version }) => version !== expected);
  if (drift.length > 0) {
    throw new Error(
      `Version drift; expected ${expected}: ` +
      drift.map(({ label, version }) => `${label}=${version}`).join(", "),
    );
  }
}

export function checkVersionConsistency(root = REPO_ROOT): string {
  const canonical = packageVersion(join(root, "package.json"));
  const runtime = packageVersion(join(root, "harness/codex/runtime/package.json"));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const readmeCurrent = readme.match(/現在のリリースバージョンは`([^`]+)`/)?.[1];
  if (readmeCurrent === undefined) {
    throw new Error("README current release version is missing");
  }
  assertVersionedArtifacts(canonical, [
    { label: "core/tools/aidlc-version.ts", version: AIDLC_VERSION },
    { label: "harness/codex/runtime/package.json", version: runtime },
    { label: "README.md current release", version: readmeCurrent },
  ]);

  const expectedUrlVersion = `v${canonical}`;
  for (const relativePath of VERSIONED_INSTALLER_DOCS) {
    const content = readFileSync(join(root, relativePath), "utf8");
    const versions = [...content.matchAll(/releases\/download\/(v\d+\.\d+\.\d+)\/install\.mjs/g)]
      .map((match) => match[1]!);
    if (versions.length === 0) throw new Error(`Installer URL is missing: ${relativePath}`);
    assertVersionedArtifacts(
      expectedUrlVersion,
      versions.map((version, index) => ({
        label: `${relativePath} installer URL #${index + 1}`,
        version,
      })),
    );
  }
  return canonical;
}

export function main(argv: string[]): void {
  if (argv.length > 0) throw new Error("Usage: bun scripts/check-version.ts");
  const version = checkVersionConsistency();
  console.log(`Version sources are consistent (${version}).`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
