import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  INSTALLATION_MANIFEST,
  LEGACY_INSTALLATION_MANIFEST,
  portablePath,
  validateInstallationManifest,
} from "../core/tools/aidlc-distribution-contract.ts";
import type { PreviousInstallation, ProjectPathState } from "./aidlc-install-types.ts";

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function safeDestination(projectDir: string, path: string): string {
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

export function hasUnsafeAncestor(projectDir: string, path: string): boolean {
  const segments = portablePath(path).split("/").slice(0, -1);
  let current = projectDir;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return true;
  }
  return false;
}

export function assertSafeProjectDirectory(projectDir: string): void {
  if (!existsSync(projectDir)) return;
  const project = lstatSync(projectDir);
  if (project.isSymbolicLink() || !project.isDirectory()) {
    throw new Error(`Project is not a safe directory: ${projectDir}`);
  }
}

export function inspectProjectPath(projectDir: string, path: string): ProjectPathState {
  const destination = safeDestination(projectDir, path);
  if (hasUnsafeAncestor(projectDir, path)) return { kind: "unsafe" };
  if (!existsSync(destination)) return { kind: "missing" };
  if (!lstatSync(destination).isFile()) return { kind: "other" };
  return { kind: "file", sha256: digest(readFileSync(destination)) };
}

export function readPreviousInstallation(projectDir: string): PreviousInstallation | null {
  const manifestPath = [INSTALLATION_MANIFEST, LEGACY_INSTALLATION_MANIFEST]
    .find((candidate) => existsSync(safeDestination(projectDir, candidate)));
  if (manifestPath === undefined) return null;
  if (hasUnsafeAncestor(projectDir, manifestPath)) {
    throw new Error(`Unsafe installation manifest: ${manifestPath}`);
  }
  const path = safeDestination(projectDir, manifestPath);
  if (!lstatSync(path).isFile()) throw new Error(`Invalid installation manifest: ${path}`);
  try {
    return {
      manifest: validateInstallationManifest(JSON.parse(readFileSync(path, "utf8"))),
      path: manifestPath,
      legacyLayout: manifestPath === LEGACY_INSTALLATION_MANIFEST,
    };
  } catch (error) {
    throw new Error(
      `Invalid installation manifest: ${path}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function atomicWrite(path: string, content: Buffer, executable: boolean): void {
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
