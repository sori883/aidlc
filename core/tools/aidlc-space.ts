import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  activeSpace,
  DEFAULT_SPACE,
  RESERVED_RECORD_NAMES,
  slugify,
  workspaceRoot,
} from "./aidlc-workspace.ts";

export interface SpaceInfo {
  name: string;
  active: boolean;
}

export interface CreatedSpace {
  name: string;
  spaceDir: string;
}

export function spacesRoot(projectDir: string): string {
  return join(workspaceRoot(projectDir), "spaces");
}

export function listSpaces(projectDir: string): SpaceInfo[] {
  const selected = activeSpace(projectDir);
  const names = new Set<string>([DEFAULT_SPACE]);
  const root = spacesRoot(projectDir);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {
    // A fresh shell still exposes the always-valid default space.
  }
  return [...names]
    .sort()
    .map((name) => ({ name, active: name === selected }));
}

export function createSpace(projectDir: string, rawName: string): CreatedSpace {
  const projectRoot = resolve(projectDir);
  const defaultSpaceDir = join(spacesRoot(projectRoot), DEFAULT_SPACE);
  if (!existsSync(defaultSpaceDir) || !statSync(defaultSpaceDir).isDirectory()) {
    throw new Error("Initialize the workspace before creating a space");
  }

  const name = slugify(rawName);
  if (RESERVED_RECORD_NAMES.has(name)) {
    throw new Error(`"${name}" is a reserved name and cannot be a space name`);
  }
  const spaceDir = join(spacesRoot(projectRoot), name);
  if (existsSync(spaceDir)) {
    throw new Error(`Space "${name}" already exists at ${spaceDir}`);
  }

  const memoryDir = join(spaceDir, "memory");
  mkdirSync(join(memoryDir, "phases"), { recursive: true });
  mkdirSync(join(memoryDir, "templates"), { recursive: true });
  mkdirSync(join(spaceDir, "intents"), { recursive: true });
  mkdirSync(join(spaceDir, "codekb"), { recursive: true });
  mkdirSync(join(spaceDir, "knowledge"), { recursive: true });

  const defaultOrgPath = join(defaultSpaceDir, "memory", "org.md");
  const organizationRules = existsSync(defaultOrgPath)
    ? readFileSync(defaultOrgPath, "utf8")
    : "# Organization defaults\n";
  writeFileSync(join(memoryDir, "org.md"), organizationRules, "utf8");
  writeFileSync(join(memoryDir, "team.md"), "# Team practices\n", "utf8");
  writeFileSync(
    join(memoryDir, "project.md"),
    "# Project overrides\n",
    "utf8",
  );
  writeFileSync(join(memoryDir, "templates", ".gitkeep"), "", "utf8");
  writeFileSync(join(spaceDir, "codekb", ".gitkeep"), "", "utf8");
  writeFileSync(join(spaceDir, "knowledge", ".gitkeep"), "", "utf8");

  return { name, spaceDir };
}

export function switchSpace(projectDir: string, rawName: string): SpaceInfo {
  const name = slugify(rawName);
  const spaces = listSpaces(projectDir);
  if (!spaces.some((space) => space.name === name)) {
    throw new Error(
      `Unknown space "${name}". Existing: ${spaces.map((space) => space.name).join(", ")}`,
    );
  }
  const pointerPath = join(workspaceRoot(projectDir), "active-space");
  writeFileSync(pointerPath, `${name}\n`, "utf8");
  return { name, active: true };
}

function runCli(): void {
  const [command, projectDir, name, ...args] = process.argv.slice(2);
  const validList =
    command === "list" &&
    projectDir !== undefined &&
    (name === undefined || (name === "--json" && args.length === 0));
  const validMutation =
    (command === "create" || command === "switch") &&
    projectDir !== undefined &&
    name !== undefined &&
    args.length === 0;
  if (!validList && !validMutation) {
    console.error(
      "Usage: aidlc-space list <project-dir> [--json]\n" +
        "       aidlc-space create <project-dir> <name>\n" +
        "       aidlc-space switch <project-dir> <name>",
    );
    process.exitCode = 1;
    return;
  }

  try {
    if (projectDir === undefined) throw new Error("project directory is required");
    if (command === "list") {
      const spaces = listSpaces(projectDir);
      const selected = spaces.find((space) => space.active)?.name ?? DEFAULT_SPACE;
      if (name === "--json") {
        process.stdout.write(`${JSON.stringify({ active: selected, spaces })}\n`);
        return;
      }
      process.stdout.write(
        `Spaces:\n${spaces.map((space) => `${space.active ? "*" : " "} ${space.name}`).join("\n")}\n`,
      );
      return;
    }
    if (name === undefined) throw new Error("space name is required");
    if (command === "create") {
      const result = createSpace(projectDir, name);
      console.log(`Space created: ${result.name}`);
      return;
    }
    const result = switchSpace(projectDir, name);
    console.log(`Active space → ${result.name}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
