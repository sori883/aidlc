import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendIntentToRegistry,
  dateStamp,
  intentsDir,
  listIntents,
  setActiveIntentCursor,
  uuidv7,
} from "./aidlc-intent.ts";
import { listSpaces } from "./aidlc-space.ts";
import {
  DEFAULT_SPACE,
  initializeWorkspace,
  slugify,
  workspaceRoot,
} from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

const LEGACY_ROOT_NAME = "aidlc-docs";
const MIGRATED_MARKER = ".migrated";

export interface FlatMigrationOptions {
  removeSource?: boolean;
}

export interface FlatMigrationResult {
  intentDirName: string;
  uuid: string;
  slug: string;
  movedFrom: string;
  sourceRemoved: boolean;
}

function legacyRoot(projectDir: string): string {
  return join(resolve(projectDir), LEGACY_ROOT_NAME);
}

export function migratedMarkerPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), MIGRATED_MARKER);
}

function anyIntentRecordExists(projectDir: string): boolean {
  return listSpaces(projectDir).some((space) =>
    listIntents(projectDir, space.name).some((intent) => intent.dirName !== null)
  );
}

export function needsFlatMigration(projectDir: string): boolean {
  if (existsSync(migratedMarkerPath(projectDir))) return false;
  if (!existsSync(join(legacyRoot(projectDir), "aidlc-state.md"))) return false;
  return !anyIntentRecordExists(projectDir);
}

function stateField(content: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^[ \\t]*-?[ \\t]*\\*\\*${escaped}\\*\\*[ \\t]*:[ \\t]*(.+)$`, "im"),
    new RegExp(`^[ \\t]*${escaped}[ \\t]*:[ \\t]*(.+)$`, "im"),
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(content)?.[1]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return null;
}

function migrationSlug(statePath: string): string {
  try {
    const state = readFileSync(statePath, "utf8");
    for (const field of ["Workflow", "Intent", "Project", "Scope"]) {
      const value = stateField(state, field);
      if (value !== null) return slugify(value, 24);
    }
  } catch {
    // An unreadable state uses the upstream default slug.
  }
  return "default";
}

function nextIntentDirName(root: string, base: string): string {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!existsSync(join(root, candidate))) return candidate;
  }
  throw new Error(`Could not find a free migration target for "${base}" in ${root}`);
}

function mergeTree(source: string, destination: string): void {
  const stats = lstatSync(source);
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source).sort()) {
      mergeTree(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (!stats.isFile()) return;
  mkdirSync(dirname(destination), { recursive: true });
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    const exists =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST";
    if (!exists) throw error;
  }
}

function cloneId(projectDir: string): string {
  const path = join(workspaceRoot(projectDir), ".aidlc-clone-id");
  try {
    const value = readFileSync(path, "utf8").trim();
    if (/^[a-z0-9]{1,32}$/.test(value)) return value;
  } catch {
    // Mint a clone-local ID below.
  }
  const value = randomUUID().replace(/-/g, "").slice(0, 12);
  writeFileSync(path, `${value}\n`, "utf8");
  return value;
}

function auditShardName(projectDir: string): string {
  const host = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "host";
  return `${host}-${cloneId(projectDir)}.md`;
}

export function migrateFlatLayout(
  projectDir: string,
  options: FlatMigrationOptions = {},
): FlatMigrationResult | null {
  const projectRoot = resolve(projectDir);
  if (!needsFlatMigration(projectRoot)) return null;
  initializeWorkspace(projectRoot);

  return withWorkspaceLock(projectRoot, () => {
    if (!needsFlatMigration(projectRoot)) return null;
    const source = legacyRoot(projectRoot);
    const statePath = join(source, "aidlc-state.md");
    const slug = migrationSlug(statePath);
    const uuid = uuidv7();
    const root = intentsDir(projectRoot, DEFAULT_SPACE);
    const intentDirName = nextIntentDirName(root, `${dateStamp()}-${slug}`);
    const destination = join(root, intentDirName);
    const staging = join(
      workspaceRoot(projectRoot),
      `.migrate-staging-${process.pid}-${randomUUID()}`,
    );

    try {
      cpSync(source, staging, { recursive: true, errorOnExist: true });
      const legacyAudit = join(staging, "audit.md");
      if (existsSync(legacyAudit)) {
        const auditDir = join(staging, "audit");
        mkdirSync(auditDir, { recursive: true });
        renameSync(legacyAudit, join(auditDir, auditShardName(projectRoot)));
      }

      const legacyKnowledge = join(staging, "knowledge");
      if (existsSync(legacyKnowledge)) {
        const spaceKnowledge = join(
          workspaceRoot(projectRoot),
          "spaces",
          DEFAULT_SPACE,
          "knowledge",
        );
        mergeTree(legacyKnowledge, spaceKnowledge);
        rmSync(legacyKnowledge, { recursive: true, force: true });
      }

      mkdirSync(root, { recursive: true });
      renameSync(staging, destination);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }

    appendIntentToRegistry(
      projectRoot,
      { uuid, slug, dirName: intentDirName, status: "in-flight" },
      DEFAULT_SPACE,
    );
    setActiveIntentCursor(projectRoot, intentDirName, DEFAULT_SPACE);
    writeFileSync(
      migratedMarkerPath(projectRoot),
      `migrated ${new Date().toISOString()} → ${intentDirName}\n`,
      "utf8",
    );

    const removeSource = options.removeSource === true;
    if (removeSource) rmSync(source, { recursive: true, force: true });
    return {
      intentDirName,
      uuid,
      slug,
      movedFrom: source,
      sourceRemoved: removeSource,
    };
  });
}

export function main(argv: string[]): void {
  const [command, projectDir, flag, ...args] = argv;
  if (
    command !== "migrate" ||
    projectDir === undefined ||
    (flag !== undefined && flag !== "--remove-source") ||
    args.length > 0
  ) {
    console.error(
      "Usage: aidlc-workspace-migrate migrate <project-dir> [--remove-source]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const result = migrateFlatLayout(projectDir, {
      removeSource: flag === "--remove-source",
    });
    if (result === null) {
      console.log("No legacy workspace migration is needed.");
      return;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
