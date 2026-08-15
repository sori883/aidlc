#!/usr/bin/env node

// Public GitHub transport only. Bun bundles the modules imported below into
// one Node-compatible install.mjs Release Asset.

import { resolve } from "node:path";
import { nativeCliPath } from "../core/tools/aidlc-distribution-contract.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import { applyInstallation } from "./aidlc-install-apply.ts";
import {
  assertSafeProjectDirectory,
  inspectProjectPath,
  readPreviousInstallation,
} from "./aidlc-install-fs.ts";
import { planInstallation } from "./aidlc-install-plan.ts";
import { downloadDistribution } from "./aidlc-install-transport.ts";
import type {
  CliOptions,
  InstallResult,
} from "./aidlc-install-types.ts";

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

async function install(options: CliOptions): Promise<InstallResult> {
  assertSafeProjectDirectory(options.projectDir);
  const previous = readPreviousInstallation(options.projectDir);
  if (options.command === "update" && previous === null) {
    throw new Error("AI-DLC is not installed; run the install command first");
  }

  const distribution = await downloadDistribution();
  const plan = planInstallation({
    sources: distribution.files,
    previous,
    inspect: (path) => inspectProjectPath(options.projectDir, path),
  });
  const result: InstallResult = {
    command: options.command,
    version: AIDLC_VERSION,
    project: options.projectDir,
    executable: nativeCliPath(process.platform),
    distribution_target: distribution.binary.target,
    written: plan.written,
    unchanged: plan.unchanged,
    removed: plan.removed,
    conflicts: plan.conflicts,
    dry_run: options.dryRun,
  };
  if (plan.conflicts.length === 0 && !options.dryRun) {
    applyInstallation({
      projectDir: options.projectDir,
      harness: options.harness,
      distribution,
      previous,
      plan,
    });
  }
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
    `${result.written.length} file(s) written; ${result.unchanged.length} unchanged; ` +
    `${result.removed.length} obsolete file(s) removed.\n`,
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
