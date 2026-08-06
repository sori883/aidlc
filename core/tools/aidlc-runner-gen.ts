// Codex Skill generator. Stage and Scope definitions remain authoritative;
// generated runners are thin, explicit entry points over the runtime engine.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CompiledStage,
  loadCompiledStageGraph,
} from "./aidlc-graph.ts";
import {
  loadScopes,
  type ScopeDefinition,
} from "./aidlc-scope-loader.ts";

export const RUNNER_GENERATOR = "aidlc-runner-gen";
export const INIT_RUNNER = "aidlc-init";
export const ORCHESTRATOR_SKILL = "aidlc";

export interface RunnerGeneratorOptions {
  graphPath?: string;
  scopesDir?: string;
  skillsDir?: string;
  authoredSkillDir?: string;
}

export interface RunnerWriteResult {
  skillsDir: string;
  stageRunners: string[];
  scopeRunners: string[];
  writtenFiles: string[];
  prunedDirectories: string[];
}

export interface RunnerCheckResult {
  valid: boolean;
  skillsDir: string;
  missing: string[];
  stale: string[];
  orphaned: string[];
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCOPES_DIR = resolve(MODULE_DIR, "../scopes");
const DEFAULT_SKILLS_DIR = resolve(".agents/skills");
const DEFAULT_AUTHORED_SKILL_DIR = resolve(
  MODULE_DIR,
  "../../harness/codex/skills/aidlc",
);
const OPENAI_YAML = "policy:\n  allow_implicit_invocation: false\n";
const RUNTIME = "pnpm --dir .codex run";

function portable(path: string): string {
  return path.replaceAll("\\", "/");
}

function resolvedSkillsDir(options: RunnerGeneratorOptions): string {
  return resolve(options.skillsDir ?? DEFAULT_SKILLS_DIR);
}

function resolvedAuthoredSkillDir(options: RunnerGeneratorOptions): string {
  return resolve(options.authoredSkillDir ?? DEFAULT_AUTHORED_SKILL_DIR);
}

export function runnableStages(
  graph: readonly CompiledStage[] = loadCompiledStageGraph(),
): CompiledStage[] {
  return graph.filter((stage) => stage.phase !== "initialization");
}

export function runnerScopes(
  scopes: readonly ScopeDefinition[] = loadScopes(DEFAULT_SCOPES_DIR),
): ScopeDefinition[] {
  return scopes.filter((scope) => scope.runner === true);
}

export function stageRunnerName(
  stage: Pick<CompiledStage, "slug" | "plugin">,
): string {
  return stage.plugin ? stage.slug : `aidlc-${stage.slug}`;
}

export function renderStageRunner(stage: CompiledStage): string {
  const name = stageRunnerName(stage);
  return `---
name: ${name}
description: Run the AI-DLC ${stage.slug} Stage in isolation without advancing the active Intent.
---

<!-- generated-by: ${RUNNER_GENERATOR} -->

# AI-DLC Stage Runner: ${stage.slug}

Run the \`${stage.slug}\` Stage once. This is explicit packaging over
\`$aidlc\`; first read \`../aidlc/SKILL.md\` and follow its **Single Stage**
branch. Do not update the active Intent's Current Stage.

1. Request the isolated directive:

   \`${RUNTIME} orchestrate next --project-dir .. --stage ${stage.slug} --single\`

2. Preserve every \`load-steering\` part and repeat the same command with
   \`--continue-token <token>\` until \`run-stage\` is returned.
3. Execute the returned topology, Stage file, inputs, outputs, Rules, Memory,
   Reviewer, and Learnings instructions exactly as \`$aidlc\` specifies. The
   isolated directive has \`single: true\` and \`gate: false\`.
4. Record the isolated lifecycle:

   \`${RUNTIME} orchestrate report --project-dir .. --stage ${stage.slug} --result completed --single\`

Stop after the \`done\` directive. Never report against the main workflow.
`;
}

export function renderInitRunner(): string {
  return `---
name: ${INIT_RUNNER}
description: Create an AI-DLC Intent and run the complete Initialization phase.
---

<!-- generated-by: ${RUNNER_GENERATOR} -->

# AI-DLC Initialization

Create one Intent. Initialization is atomic; its three bootstrap Stages are not
available as isolated Stage runners.

Run every command below from the repository root.

1. Ensure the workspace shell exists:

   \`${RUNTIME} workspace init ..\`

2. Parse \`$ARGUMENTS\` as an optional \`--scope <name>\` and a free-form
   description. Scope defaults to \`poc\`.
3. Derive a concise two-to-four word label from the description. If no
   description exists, use the scope name.
4. Run:

   \`${RUNTIME} intent birth .. "<label>" --scope <scope>\`

5. Print the result and stop. Continue later with \`$aidlc\`.
`;
}

export function renderScopeRunner(scope: ScopeDefinition): string {
  const name = `aidlc-${scope.name}`;
  return `---
name: ${name}
description: Run AI-DLC with the ${scope.name} Scope fixed. ${scope.description}.
---

<!-- generated-by: ${RUNNER_GENERATOR} -->

# AI-DLC Scope Runner: ${scope.name}

Read \`../aidlc/SKILL.md\` and follow the same engine loop with scope
\`${scope.name}\` fixed.

Run every command below from the repository root.

1. Ensure the workspace shell exists:
   \`${RUNTIME} workspace init ..\`.
2. Inspect the active Intent with
   \`${RUNTIME} intent list .. --json\`.
3. If no Intent exists, derive a concise label from \`$ARGUMENTS\` and birth it:
   \`${RUNTIME} intent birth .. "<label>" --scope ${scope.name}\`.
4. If an active Intent exists, read its Scope with
   \`${RUNTIME} state resume ..\`. If it differs from
   \`${scope.name}\`, stop and explain that Scope is fixed at Intent Birth;
   never rewrite its plan implicitly.
5. Run the \`$aidlc\` forwarding loop until the engine returns \`done\`.
`;
}

function loadGraph(options: RunnerGeneratorOptions): CompiledStage[] {
  return loadCompiledStageGraph(
    options.graphPath === undefined ? {} : { graphPath: options.graphPath },
  );
}

function loadRunnerScopes(options: RunnerGeneratorOptions): ScopeDefinition[] {
  return runnerScopes(loadScopes(options.scopesDir ?? DEFAULT_SCOPES_DIR));
}

/** Render every Skill file relative to the configured Skills directory. */
export function runnerSkillFiles(
  options: RunnerGeneratorOptions = {},
): Map<string, string> {
  const files = new Map<string, string>();
  const authoredDir = resolvedAuthoredSkillDir(options);
  for (const filename of [
    "SKILL.md",
    "question-rendering.md",
    join("agents", "openai.yaml"),
  ]) {
    const path = join(authoredDir, filename);
    if (!existsSync(path)) throw new Error(`Missing authored Codex Skill file: ${path}`);
    files.set(join(ORCHESTRATOR_SKILL, filename), readFileSync(path, "utf8"));
  }
  for (const stage of runnableStages(loadGraph(options))) {
    const directory = stageRunnerName(stage);
    files.set(join(directory, "SKILL.md"), renderStageRunner(stage));
    files.set(join(directory, "agents", "openai.yaml"), OPENAI_YAML);
  }
  files.set(join(INIT_RUNNER, "SKILL.md"), renderInitRunner());
  files.set(join(INIT_RUNNER, "agents", "openai.yaml"), OPENAI_YAML);
  for (const scope of loadRunnerScopes(options)) {
    const directory = `aidlc-${scope.name}`;
    files.set(join(directory, "SKILL.md"), renderScopeRunner(scope));
    files.set(join(directory, "agents", "openai.yaml"), OPENAI_YAML);
  }
  return files;
}

function isGeneratedRunner(directory: string): boolean {
  const path = join(directory, "SKILL.md");
  if (!existsSync(path)) return false;
  return new RegExp(`^<!-- generated-by:\\s*${RUNNER_GENERATOR}\\s*-->$`, "m")
    .test(readFileSync(path, "utf8"));
}

export function writeRunnerSkills(
  options: RunnerGeneratorOptions = {},
): RunnerWriteResult {
  const skillsDir = resolvedSkillsDir(options);
  const expected = runnerSkillFiles(options);
  mkdirSync(skillsDir, { recursive: true });
  const expectedDirectories = new Set(
    [...expected.keys()].map((path) => path.split(/[\\/]/, 1)[0]),
  );
  const prunedDirectories: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || expectedDirectories.has(entry.name)) continue;
    const directory = join(skillsDir, entry.name);
    if (!isGeneratedRunner(directory)) continue;
    rmSync(directory, { recursive: true, force: true });
    prunedDirectories.push(directory);
  }

  const writtenFiles: string[] = [];
  for (const [relativePath, content] of expected) {
    const path = join(skillsDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    writtenFiles.push(path);
  }
  return {
    skillsDir,
    stageRunners: runnableStages(loadGraph(options)).map(stageRunnerName),
    scopeRunners: loadRunnerScopes(options).map((scope) => `aidlc-${scope.name}`),
    writtenFiles,
    prunedDirectories,
  };
}

export function checkRunnerSkills(
  options: RunnerGeneratorOptions = {},
): RunnerCheckResult {
  const skillsDir = resolvedSkillsDir(options);
  const expected = runnerSkillFiles(options);
  const missing: string[] = [];
  const stale: string[] = [];
  for (const [relativePath, content] of expected) {
    const path = join(skillsDir, relativePath);
    if (!existsSync(path)) missing.push(portable(relativePath));
    else if (readFileSync(path, "utf8") !== content) stale.push(portable(relativePath));
  }
  const expectedDirectories = new Set(
    [...expected.keys()].map((path) => path.split(/[\\/]/, 1)[0]),
  );
  const orphaned = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) =>
        entry.isDirectory() &&
        !expectedDirectories.has(entry.name) &&
        isGeneratedRunner(join(skillsDir, entry.name))
      )
      .map((entry) => entry.name)
      .sort()
    : [];
  return {
    valid: missing.length === 0 && stale.length === 0 && orphaned.length === 0,
    skillsDir,
    missing,
    stale,
    orphaned,
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  const options: RunnerGeneratorOptions = {};
  const out = flagValue(args, "--out");
  if (out !== undefined) options.skillsDir = out;
  if (command === "write") {
    const result = writeRunnerSkills(options);
    console.log(
      `Generated ${result.stageRunners.length} Stage runners, ` +
        `${result.scopeRunners.length} Scope runners, and ${INIT_RUNNER} ` +
        `under ${result.skillsDir}.`,
    );
    return;
  }
  if (command === "check") {
    const result = checkRunnerSkills(options);
    if (result.valid) {
      console.log(`Codex Skill set is in sync at ${result.skillsDir}.`);
      return;
    }
    if (result.missing.length > 0) console.error(`Missing: ${result.missing.join(", ")}`);
    if (result.stale.length > 0) console.error(`Stale: ${result.stale.join(", ")}`);
    if (result.orphaned.length > 0) console.error(`Orphaned: ${result.orphaned.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (command === "list") {
    console.log(runnableStages(loadGraph(options)).map((stage) => stage.slug).join("\n"));
    return;
  }
  console.error("Usage: aidlc-runner-gen <write|check|list> [--out <skills-dir>]");
  process.exitCode = 1;
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
