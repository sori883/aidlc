import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface SubmoduleEntry {
  name: string;
  path: string;
  url: string;
  initialized: boolean;
}

export interface WorkspaceScan {
  projectType: "Greenfield" | "Brownfield";
  languages: string;
  frameworks: string;
  buildSystem: string;
  nestedRoot?: string;
  submodules: SubmoduleEntry[];
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".java": "Java",
  ".kt": "Kotlin",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".cs": "C#",
  ".cpp": "C++",
  ".c": "C",
  ".h": "C",
  ".hpp": "C++",
  ".swift": "Swift",
  ".php": "PHP",
};

const SOURCE_DIRECTORIES = [
  "src",
  "app",
  "lib",
  "pages",
  "components",
  "tests",
] as const;
const SOURCE_DIRECTORY_SET = new Set<string>(SOURCE_DIRECTORIES);
const EXCLUDED_DIRECTORIES = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".git",
  ".kiro",
  ".next",
  ".opencode",
  ".aidlc",
  "aidlc",
  "aidlc-docs",
  "build",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
const SOURCE_MANIFESTS = [
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
] as const;
const NESTED_EXCLUSIONS = new Set([
  "demo",
  "demos",
  "doc",
  "docs",
  "example",
  "examples",
  "fixtures",
  "reference",
  "sample",
  "samples",
  "scripts",
  "templates",
  "testdata",
]);

interface DirectorySignals {
  brownfield: boolean;
  languageCounts: Record<string, number>;
  frameworks: string[];
  buildSystem: string;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readPackageJson(projectDir: string): PackageJsonShape | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf8"),
    );
    return typeof value === "object" && value !== null
      ? value as PackageJsonShape
      : null;
  } catch {
    return null;
  }
}

function countLanguages(
  directory: string,
  counts: Record<string, number>,
  maxDepth: number,
  skipDirectories?: ReadonlySet<string>,
): void {
  if (maxDepth < 0) return;
  let entries: string[];
  try {
    entries = readdirSync(directory).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      if (!skipDirectories?.has(entry)) {
        countLanguages(path, counts, maxDepth - 1);
      }
      continue;
    }
    if (!stats.isFile()) continue;
    const language = LANGUAGE_BY_EXTENSION[extname(entry).toLowerCase()];
    if (language !== undefined) counts[language] = (counts[language] ?? 0) + 1;
  }
}

function detectFrameworks(entries: ReadonlySet<string>, projectDir: string): string[] {
  const frameworks: string[] = [];
  const hasAny = (names: readonly string[]) => names.some((name) => entries.has(name));
  if (hasAny(["next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs"])) frameworks.push("Next.js");
  if (hasAny(["vite.config.js", "vite.config.ts", "vite.config.mjs"])) frameworks.push("Vite");
  if (entries.has("angular.json")) frameworks.push("Angular");
  if (hasAny(["nuxt.config.js", "nuxt.config.ts"])) frameworks.push("Nuxt");
  if (entries.has("remix.config.js")) frameworks.push("Remix");
  if (entries.has("gatsby-config.js")) frameworks.push("Gatsby");
  if (hasAny(["astro.config.mjs", "astro.config.js", "astro.config.ts"])) frameworks.push("Astro");
  if (entries.has("svelte.config.js")) frameworks.push("Svelte");
  if (entries.has("nest-cli.json")) frameworks.push("NestJS");

  const packageJson = readPackageJson(projectDir);
  if (
    packageJson?.dependencies?.react !== undefined ||
    packageJson?.peerDependencies?.react !== undefined
  ) {
    frameworks.push("React");
  }
  if (entries.has("manage.py")) frameworks.push("Django");
  if (entries.has("Gemfile")) {
    try {
      if (/^[^#]*\brails\b/m.test(readFileSync(join(projectDir, "Gemfile"), "utf8"))) {
        frameworks.push("Rails");
      }
    } catch {
      // Ignore unreadable manifests.
    }
  }
  if (entries.has("pom.xml")) {
    try {
      if (/spring-boot/.test(readFileSync(join(projectDir, "pom.xml"), "utf8"))) {
        frameworks.push("Spring Boot");
      }
    } catch {
      // Ignore unreadable manifests.
    }
  }
  return frameworks;
}

function detectBuildSystem(entries: ReadonlySet<string>, projectDir: string): string {
  if (entries.has("package.json")) {
    if (entries.has("pnpm-lock.yaml")) return "pnpm (package.json)";
    if (entries.has("yarn.lock")) return "yarn (package.json)";
    if (entries.has("bun.lock") || entries.has("bun.lockb")) return "bun (package.json)";
    return "npm (package.json)";
  }
  if (entries.has("pyproject.toml")) {
    try {
      const content = readFileSync(join(projectDir, "pyproject.toml"), "utf8");
      if (/\[tool\.poetry\]/.test(content)) return "poetry (pyproject.toml)";
      if (/\[tool\.uv\]/.test(content)) return "uv (pyproject.toml)";
      if (/\[tool\.hatch\]/.test(content)) return "hatch (pyproject.toml)";
    } catch {
      // Fall through to the generic Python label.
    }
    return "python (pyproject.toml)";
  }
  if (entries.has("requirements.txt")) return "pip (requirements.txt)";
  if (entries.has("setup.py")) return "setuptools (setup.py)";
  if (entries.has("Cargo.toml")) return "cargo (Cargo.toml)";
  if (entries.has("go.mod")) return "go modules (go.mod)";
  if (entries.has("pom.xml")) return "maven (pom.xml)";
  if (entries.has("build.gradle") || entries.has("build.gradle.kts")) return "gradle (build.gradle)";
  if (entries.has("composer.json")) return "composer (composer.json)";
  if (entries.has("Gemfile")) return "bundler (Gemfile)";
  return "Unknown";
}

function scanDirectory(directory: string, sweepDepth: number): DirectorySignals {
  let entries: string[] = [];
  try {
    entries = readdirSync(directory).sort();
  } catch {
    // Missing directories have no signals.
  }
  const entrySet = new Set(entries.filter((entry) => !EXCLUDED_DIRECTORIES.has(entry)));
  const languageCounts: Record<string, number> = {};
  countLanguages(directory, languageCounts, sweepDepth, SOURCE_DIRECTORY_SET);
  for (const sourceDirectory of SOURCE_DIRECTORIES) {
    if (entrySet.has(sourceDirectory)) {
      countLanguages(join(directory, sourceDirectory), languageCounts, 6);
    }
  }
  const frameworks = detectFrameworks(entrySet, directory);
  const buildSystem = detectBuildSystem(entrySet, directory);
  const packageJson = readPackageJson(directory);
  const hasRuntimeDependencies =
    packageJson?.dependencies !== undefined &&
    Object.keys(packageJson.dependencies).length > 0;
  return {
    brownfield:
      Object.keys(languageCounts).length > 0 ||
      frameworks.length > 0 ||
      hasRuntimeDependencies ||
      SOURCE_MANIFESTS.some((manifest) => entrySet.has(manifest)) ||
      SOURCE_DIRECTORIES.some((sourceDirectory) => entrySet.has(sourceDirectory)),
    languageCounts,
    frameworks,
    buildSystem,
  };
}

export function parseGitmodules(
  content: string,
): Array<{ name: string; path: string; url: string }> {
  const result: Array<{ name: string; path: string; url: string }> = [];
  let current: { name: string; path: string; url: string } | null = null;
  const finish = (): void => {
    if (current === null) return;
    const unsafe =
      current.path.length === 0 ||
      current.path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(current.path) ||
      current.path.split(/[\\/]/).includes("..");
    if (!unsafe) result.push(current);
    current = null;
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      finish();
      const match = /^\[submodule\s+"(.+)"\]$/.exec(line);
      current = match?.[1] === undefined
        ? null
        : { name: match[1], path: "", url: "" };
      continue;
    }
    if (current === null) continue;
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (key === "path") current.path = value;
    if (key === "url") current.url = value;
  }
  finish();
  return result;
}

function detectSubmodules(projectDir: string): SubmoduleEntry[] {
  try {
    return parseGitmodules(
      readFileSync(join(projectDir, ".gitmodules"), "utf8"),
    ).map((entry) => ({
      ...entry,
      initialized: existsSync(join(projectDir, entry.path, ".git")),
    }));
  } catch {
    return [];
  }
}

export function detectWorkspace(projectDir: string): WorkspaceScan {
  const projectRoot = resolve(projectDir);
  let topEntries: string[] = [];
  try {
    topEntries = readdirSync(projectRoot).sort();
  } catch {
    throw new Error(`Project directory is not readable: ${projectRoot}`);
  }
  const rootSignals = scanDirectory(projectRoot, 0);
  const languageCounts = { ...rootSignals.languageCounts };
  const frameworks = [...rootSignals.frameworks];
  let buildSystem = rootSignals.buildSystem;
  let brownfield = rootSignals.brownfield;
  const nestedRoots: string[] = [];

  if (!brownfield) {
    for (const entry of topEntries) {
      if (entry.startsWith(".")) continue;
      if (EXCLUDED_DIRECTORIES.has(entry)) continue;
      if (NESTED_EXCLUSIONS.has(entry.toLowerCase())) continue;
      if (SOURCE_DIRECTORY_SET.has(entry)) continue;
      const nestedPath = join(projectRoot, entry);
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(nestedPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      const nested = scanDirectory(nestedPath, 1);
      if (!nested.brownfield) continue;
      brownfield = true;
      nestedRoots.push(entry);
      for (const [language, count] of Object.entries(nested.languageCounts)) {
        languageCounts[language] = (languageCounts[language] ?? 0) + count;
      }
      for (const framework of nested.frameworks) {
        if (!frameworks.includes(framework)) frameworks.push(framework);
      }
      if (buildSystem === "Unknown") buildSystem = nested.buildSystem;
    }
  }

  const sortedLanguages = Object.entries(languageCounts)
    .sort(([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName));
  let languages = "Unknown";
  const primary = sortedLanguages[0];
  if (primary !== undefined) {
    const threshold = Math.max(1, Math.floor(primary[1] * 0.2));
    languages = sortedLanguages
      .filter(([, count], index) => index === 0 || count >= threshold)
      .map(([language]) => language)
      .join(", ");
  }

  const submodules = detectSubmodules(projectRoot);
  if (submodules.length > 0) brownfield = true;
  return {
    projectType: brownfield ? "Brownfield" : "Greenfield",
    languages,
    frameworks: frameworks.length > 0 ? frameworks.join(", ") : "Unknown",
    buildSystem,
    ...(nestedRoots.length === 0 ? {} : { nestedRoot: nestedRoots.join(", ") }),
    submodules,
  };
}

export function main(argv: string[]): void {
  const [command, projectDir, flag, ...args] = argv;
  if (
    command !== "detect" ||
    projectDir === undefined ||
    (flag !== undefined && flag !== "--json") ||
    args.length > 0
  ) {
    console.error("Usage: aidlc-workspace-detect detect <project-dir> [--json]");
    process.exitCode = 1;
    return;
  }
  try {
    const result = detectWorkspace(projectDir);
    if (flag === "--json") {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    process.stdout.write(
      `Project type: ${result.projectType}\n` +
        `Languages: ${result.languages}\n` +
        `Frameworks: ${result.frameworks}\n` +
        `Build system: ${result.buildSystem}\n` +
        (result.nestedRoot === undefined ? "" : `Nested root: ${result.nestedRoot}\n`) +
        `Submodules: ${result.submodules.length}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
