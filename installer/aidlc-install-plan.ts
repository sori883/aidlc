import type { ManagedFile } from "../core/tools/aidlc-distribution-contract.ts";
import { legacyManagedFilesToRetire } from "./aidlc-install-legacy.ts";
import type {
  InstallPlan,
  PreviousInstallation,
  ProjectPathState,
  SourceFile,
} from "./aidlc-install-types.ts";

export interface PlanInstallationOptions {
  sources: readonly SourceFile[];
  previous: PreviousInstallation | null;
  inspect: (path: string) => ProjectPathState;
}

function managedSource(source: SourceFile): ManagedFile {
  return {
    path: source.path,
    sha256: source.sha256,
    bytes: source.content.byteLength,
    executable: source.executable,
  };
}

export function planInstallation(options: PlanInstallationOptions): InstallPlan {
  const { sources, previous, inspect } = options;
  const previousFiles = new Map(
    (previous?.manifest.files ?? []).map((file) => [file.path, file]),
  );
  const sourcePaths = new Set(sources.map((source) => source.path));
  const written: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  const conflicts: string[] = [];

  for (const source of sources) {
    const state = inspect(source.path);
    if (state.kind === "unsafe" || state.kind === "other") {
      conflicts.push(source.path);
      continue;
    }
    if (state.kind === "missing") {
      written.push(source.path);
      continue;
    }
    if (state.sha256 === source.sha256) {
      unchanged.push(source.path);
      continue;
    }
    if (previousFiles.get(source.path)?.sha256 === state.sha256) written.push(source.path);
    else conflicts.push(source.path);
  }

  for (const managed of legacyManagedFilesToRetire(previous, sourcePaths)) {
    const state = inspect(managed.path);
    if (state.kind === "missing") continue;
    if (state.kind !== "file" || state.sha256 !== managed.sha256) {
      conflicts.push(managed.path);
      continue;
    }
    removed.push(managed.path);
  }

  const nextFiles = sources.map(managedSource);
  if (previous?.legacyLayout !== true) {
    for (const managed of previous?.manifest.files ?? []) {
      if (!sourcePaths.has(managed.path)) nextFiles.push(managed);
    }
  }

  return {
    written: written.sort(),
    unchanged: unchanged.sort(),
    removed: removed.sort(),
    conflicts: conflicts.sort(),
    nextFiles: nextFiles.sort((left, right) => left.path.localeCompare(right.path)),
  };
}
