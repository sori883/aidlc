import { mkdirSync } from "node:fs";
import {
  INSTALLATION_MANIFEST,
  PROJECT_INSTALLATION_FORMAT,
  PROJECT_INSTALLATION_SCHEMA,
  type Harness,
  type InstallationManifest,
} from "../core/tools/aidlc-distribution-contract.ts";
import type { HarnessDescriptor } from "../core/tools/aidlc-harness-contract.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import { atomicWrite, safeDestination } from "./aidlc-install-fs.ts";
import { finishLegacyMigration } from "./aidlc-install-legacy.ts";
import type {
  DownloadedDistribution,
  InstallPlan,
  PreviousInstallation,
} from "./aidlc-install-types.ts";

export interface ApplyInstallationOptions {
  projectDir: string;
  harness: Harness;
  harnessDescriptor?: HarnessDescriptor;
  distribution: DownloadedDistribution;
  previous: PreviousInstallation | null;
  plan: InstallPlan;
  installedAt?: string;
}

export function installationManifest(
  options: ApplyInstallationOptions,
): InstallationManifest {
  return {
    format: PROJECT_INSTALLATION_FORMAT,
    schema_version: PROJECT_INSTALLATION_SCHEMA,
    version: AIDLC_VERSION,
    harness: options.harness,
    installed_at: options.installedAt ?? new Date().toISOString(),
    distribution: {
      type: "github-release",
      repository: options.distribution.manifest.repository,
      tag: options.distribution.manifest.tag,
      target: options.distribution.binary.target,
    },
    files: options.plan.nextFiles,
  };
}

export function applyInstallation(options: ApplyInstallationOptions): void {
  if (options.plan.conflicts.length > 0) {
    throw new Error("Cannot apply an installation plan with conflicts");
  }
  mkdirSync(options.projectDir, { recursive: true });
  const written = new Set(options.plan.written);
  for (const source of options.distribution.files) {
    if (!written.has(source.path)) continue;
    atomicWrite(
      safeDestination(options.projectDir, source.path),
      source.content,
      source.executable,
    );
  }
  atomicWrite(
    safeDestination(
      options.projectDir,
      options.harnessDescriptor?.layout.installationManifestPath ??
        INSTALLATION_MANIFEST,
    ),
    Buffer.from(`${JSON.stringify(installationManifest(options), null, 2)}\n`),
    false,
  );
  finishLegacyMigration(options.projectDir, options.previous, options.plan.removed);
}
