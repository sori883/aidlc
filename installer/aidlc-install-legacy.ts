import { rmdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { ManagedFile } from "../core/tools/aidlc-distribution-contract.ts";
import { safeDestination } from "./aidlc-install-fs.ts";
import type { PreviousInstallation } from "./aidlc-install-types.ts";

export function legacyManagedFilesToRetire(
  previous: PreviousInstallation | null,
  sourcePaths: ReadonlySet<string>,
): ManagedFile[] {
  if (previous?.legacyLayout !== true) return [];
  return previous.manifest.files.filter((file) =>
    file.path.startsWith(".aidlc/") && !sourcePaths.has(file.path));
}

function pruneEmptyManagedDirectories(projectDir: string, paths: readonly string[]): void {
  const directories = new Set<string>();
  for (const path of paths) {
    let current = dirname(safeDestination(projectDir, path));
    while (current !== projectDir) {
      directories.add(current);
      current = dirname(current);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
}

export function finishLegacyMigration(
  projectDir: string,
  previous: PreviousInstallation | null,
  removed: readonly string[],
): void {
  if (previous?.legacyLayout !== true) return;
  for (const path of removed) rmSync(safeDestination(projectDir, path), { force: true });
  rmSync(safeDestination(projectDir, previous.path), { force: true });
  pruneEmptyManagedDirectories(projectDir, [...removed, previous.path]);
}
