import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCliCommand } from "./aidlc-distribution-contract.ts";

const MODULE_CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function isCompiledExecutable(): boolean {
  return import.meta.url.includes("/$bunfs/");
}

/** Project-local Codex Runtime root containing tools/ and authored data. */
export function projectInstallDir(): string {
  const explicit = process.env.AIDLC_INSTALL_DIR?.trim();
  if (explicit) return resolve(explicit);
  return isCompiledExecutable()
    ? resolve(dirname(process.execPath), "..")
    : resolve(dirname(MODULE_CORE_DIR), ".codex");
}

/** Project root that owns the project-local AI-DLC installation. */
export function runtimeProjectDir(): string {
  const explicit = process.env.AIDLC_PROJECT_DIR?.trim();
  if (explicit) return resolve(explicit);
  return isCompiledExecutable()
    ? resolve(projectInstallDir(), "..")
    : process.cwd();
}

/** Root containing tools/, aidlc-common/, agents/, memory/, scopes/, and sensors/. */
export function runtimeCoreDir(): string {
  const explicit = process.env.AIDLC_RUNTIME_CORE_DIR?.trim();
  if (explicit) return resolve(explicit);
  return isCompiledExecutable()
    ? projectInstallDir()
    : MODULE_CORE_DIR;
}

/** Root containing the installed Harness files such as .codex/ and .agents/. */
export function runtimeHarnessDir(): string {
  const explicit = process.env.AIDLC_HARNESS_DIR?.trim();
  if (explicit) return resolve(explicit);
  return isCompiledExecutable()
    ? runtimeProjectDir()
    : resolve(MODULE_CORE_DIR, "../harness/codex");
}

/** @deprecated Use runtimeHarnessDir(). */
export function runtimeDistributionDir(): string {
  return runtimeHarnessDir();
}

export function runtimeCorePath(...segments: string[]): string {
  return join(runtimeCoreDir(), ...segments);
}

/** Command rendered into project-local Harness instructions. */
export function projectBinaryCommand(): string {
  return nativeCliCommand();
}
