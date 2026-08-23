// Project-local native distribution renderer. The Codex bundle remains the
// authored/development representation; this module preserves the upstream
// .codex Runtime layout while replacing executable TypeScript with one native
// entry under .codex/tools/.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { codexBundleFiles } from "./aidlc-codex-bundle.ts";
import type { HarnessDescriptor } from "./aidlc-harness-contract.ts";
import { CODEX_HARNESS } from "../../harness/codex/aidlc-harness.ts";
import {
  isRuntimeDistributionPath,
  nativeCliCommand,
  PROJECT_LAYOUT_FORMAT,
  PROJECT_LAYOUT_MANIFEST,
  PROJECT_LAYOUT_SCHEMA,
  type DistributionPlatform,
} from "./aidlc-distribution-contract.ts";

export { PROJECT_LAYOUT_MANIFEST, PROJECT_LAYOUT_SCHEMA } from "./aidlc-distribution-contract.ts";
export type { DistributionPlatform } from "./aidlc-distribution-contract.ts";

export interface ProjectLayoutOptions {
  outDir?: string;
  platform?: DistributionPlatform;
  descriptor?: HarnessDescriptor;
  bundleFiles?: ReadonlyMap<string, string>;
}

export interface ProjectLayoutManifest {
  format: typeof PROJECT_LAYOUT_FORMAT;
  schema_version: typeof PROJECT_LAYOUT_SCHEMA;
  files: string[];
}

const DEFAULT_OUT_DIR = resolve("dist/project");
function portable(path: string): string {
  return path.split(sep).join("/");
}

export function installedBinaryCommand(
  _platform: DistributionPlatform = process.platform as DistributionPlatform,
  descriptor: HarnessDescriptor = CODEX_HARNESS,
): string {
  // PowerShell and POSIX shells both accept this explicit relative path;
  // Windows resolves the .exe suffix through PATHEXT.
  return nativeCliCommand(descriptor);
}

function rewriteCommands(
  content: string,
  platform: DistributionPlatform,
  descriptor: HarnessDescriptor,
): string {
  const command = installedBinaryCommand(platform, descriptor);
  return content
    .replace(
      /Before the first AI-DLC command[\s\S]*?```\n\n/,
      "The project-local native AI-DLC executable contains every code dependency; do not run a package installer.\n\n",
    )
    .replace(
      /Run every packaged command below from the repository root\. If[\s\S]*?`bun install --cwd \.codex --frozen-lockfile`\.\n/,
      "Run every packaged command below from the project root through the project-local native executable.\n",
    )
    .replaceAll(
    `bun run --cwd ${descriptor.layout.runtimeRoot} aidlc`,
    command,
    )
    .replaceAll("--project-dir ..", "--project-dir .")
    .replaceAll(`${command} workspace init ..`, `${command} workspace init .`)
    .replaceAll(`${command} intent list ..`, `${command} intent list .`)
    .replaceAll(`${command} intent birth ..`, `${command} intent birth .`)
    .replaceAll(`${command} intent switch ..`, `${command} intent switch .`)
    .replaceAll(`${command} space list ..`, `${command} space list .`)
    .replaceAll(`${command} space switch ..`, `${command} space switch .`)
    .replaceAll(`${command} state resume ..`, `${command} state resume .`);
}

function installedHook(content: string): string {
  return content;
}

function mappedRuntimePath(
  path: string,
  descriptor: HarnessDescriptor,
): string | null {
  return isRuntimeDistributionPath(path, descriptor) ? path : null;
}

/** Render the complete installed project layout, excluding the native binary. */
export function projectLayoutFiles(
  options: ProjectLayoutOptions = {},
): Map<string, string> {
  const platform = options.platform ?? process.platform as DistributionPlatform;
  const descriptor = options.descriptor ?? CODEX_HARNESS;
  const bundled = options.bundleFiles ?? codexBundleFiles();
  const files = new Map<string, string>();
  for (const [path, content] of bundled) {
    const runtimePath = mappedRuntimePath(path, descriptor);
    if (runtimePath !== null) {
      files.set(runtimePath, rewriteCommands(content, platform, descriptor));
      continue;
    }
    if (
      descriptor.layout.projectInstructions.includes(path) ||
      path.startsWith(`${descriptor.layout.skillRoot}/`)
    ) {
      files.set(path, rewriteCommands(content, platform, descriptor));
      continue;
    }
    if (path === descriptor.layout.hookConfigPath) {
      files.set(path, installedHook(content));
      continue;
    }
  }
  const manifest: ProjectLayoutManifest = {
    format: PROJECT_LAYOUT_FORMAT,
    schema_version: PROJECT_LAYOUT_SCHEMA,
    files: [...files.keys()].sort(),
  };
  files.set(
    descriptor.layout.projectLayoutManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return files;
}

function safePath(root: string, path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe project distribution path: ${path}`);
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Project distribution path escapes root: ${path}`);
  }
  return absolute;
}

export function writeProjectLayout(
  options: ProjectLayoutOptions = {},
): { outDir: string; files: string[] } {
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const descriptor = options.descriptor ?? CODEX_HARNESS;
  rmSync(outDir, { recursive: true, force: true });
  const files = projectLayoutFiles(options);
  for (const [path, content] of files) {
    const absolute = safePath(outDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return { outDir, files: [...files.keys()].sort() };
}

export function readProjectLayoutFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).isFile()) {
        files.set(portable(relative(root, path)), readFileSync(path, "utf8"));
      }
    }
  };
  visit(resolve(root));
  return files;
}
