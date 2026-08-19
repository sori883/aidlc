import type {
  DistributionBinaryRecord,
  GithubDistributionManifest,
  Harness,
  InstallationManifest,
  ManagedFile,
} from "../core/tools/aidlc-distribution-contract.ts";
import type { HarnessDescriptor } from "../core/tools/aidlc-harness-contract.ts";

export type InstallCommand = "install" | "update";

export interface CliOptions {
  command: InstallCommand;
  projectDir: string;
  harness: Harness;
  harnessDescriptor: HarnessDescriptor;
  dryRun: boolean;
  json: boolean;
}

export interface SourceFile {
  path: string;
  content: Buffer;
  sha256: string;
  executable: boolean;
}

export interface DownloadedDistribution {
  manifest: GithubDistributionManifest;
  binary: DistributionBinaryRecord;
  files: SourceFile[];
}

export interface PreviousInstallation {
  manifest: InstallationManifest;
  path: string;
  legacyLayout: boolean;
}

export type ProjectPathState =
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "other" }
  | { kind: "file"; sha256: string };

export interface InstallPlan {
  written: string[];
  unchanged: string[];
  removed: string[];
  conflicts: string[];
  nextFiles: ManagedFile[];
}

export interface InstallResult {
  command: InstallCommand;
  version: string;
  project: string;
  executable: string;
  distribution_target: string;
  written: string[];
  unchanged: string[];
  removed: string[];
  conflicts: string[];
  dry_run: boolean;
}
