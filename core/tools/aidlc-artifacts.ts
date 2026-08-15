// Deterministic M8 artifact resolver. Stage frontmatter is the contract;
// files under the active Intent (or the Space code knowledge base for reverse
// engineering) are the completion evidence. No central artifact registry is
// maintained.

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CompiledStage,
  loadCompiledStageGraph,
  type ResolvedPlanStage,
  validateArtifactContracts,
} from "./aidlc-graph.ts";
import { activeIntent, readIntentRegistry } from "./aidlc-intent.ts";
import {
  activeIntentRecordDir,
  planFilePath,
  stateFilePath,
} from "./aidlc-state.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import type { UnitKind } from "./aidlc-unit-graph.ts";

export interface ArtifactResolutionOptions {
  unit?: string;
  repo?: string;
  unitKind?: UnitKind;
  singlePass?: boolean;
}

export interface ArtifactProducer {
  stage: CompiledStage;
  optional: boolean;
}

export interface AbsentArtifact {
  path: string;
  expected: boolean;
}

export interface ResolvedStageArtifacts {
  consumes: string[];
  consumesAbsent: AbsentArtifact[];
  produces: string[];
  optionalProduces: string[];
}

export interface ArtifactEvidence {
  valid: boolean;
  missing: string[];
}

const UNIT_PLACEHOLDER = "{unit-name}";

function safePathSegment(value: string, label: string): string {
  if (
    value === "" || value !== value.trim() || value === "." || value === ".." ||
    value.includes("/") || value.includes("\\") || value.includes("\0")
  ) {
    throw new Error(`${label} must be one non-empty path segment`);
  }
  return value;
}

function safeArtifactName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`Artifact "${value}" must use lowercase kebab-case`);
  }
  return value;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function workspacePath(projectDir: string, absolutePath: string): string {
  return portablePath(relative(resolve(projectDir), absolutePath));
}

function stateRouteIsActive(
  stateContent: string,
  slug: string,
  plan: readonly ResolvedPlanStage[],
): boolean {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = new RegExp(
    `^- \\[[ xS?R-]\\] ${escaped} — (EXECUTE|SKIP)(:[^\\n]*)?$`,
    "m",
  ).exec(stateContent);
  if (row?.[1] === "EXECUTE") return true;
  // A reason suffix is written only when a stage that was on the active route
  // is skipped at runtime. Its absent output is therefore unexpected.
  if (row?.[1] === "SKIP" && row[2] !== undefined) return true;
  if (row?.[1] === "SKIP") return false;
  return plan.find((candidate) => candidate.slug === slug)?.action === "EXECUTE";
}

function applicableConsumes(
  projectType: string,
  stage: CompiledStage,
): CompiledStage["consumes"] {
  const normalized = projectType.toLowerCase();
  return (stage.consumes ?? []).filter(
    (consume) => consume.conditional_on === undefined ||
      consume.conditional_on === normalized,
  );
}

function activeRepos(projectDir: string): string[] {
  const selected = activeIntent(projectDir);
  const registry = readIntentRegistry(projectDir, activeSpace(projectDir));
  const configured = registry.find((entry) => entry.dirName === selected)?.repos
    ?.map((repo) => repo.trim())
    .filter(Boolean) ?? [];
  return configured.length > 0 ? configured : [basename(resolve(projectDir))];
}

function standardArtifactPath(
  projectDir: string,
  stage: CompiledStage,
  artifact: string,
  unit?: string,
  singlePass = false,
): string {
  const recordDir = activeIntentRecordDir(projectDir);
  const safeArtifact = safeArtifactName(artifact);
  const safeUnit = unit === undefined
    ? UNIT_PLACEHOLDER
    : safePathSegment(unit, "Unit name");
  const absolute = stage.for_each === "unit-of-work" && !singlePass
    ? join(
        recordDir,
        stage.phase,
        safeUnit,
        stage.slug,
        `${safeArtifact}.md`,
      )
    : join(recordDir, stage.phase, stage.slug, `${safeArtifact}.md`);
  return workspacePath(projectDir, absolute);
}

function codeKnowledgePaths(
  projectDir: string,
  artifact: string,
  options: ArtifactResolutionOptions,
): string[] {
  const repos = (options.repo === undefined ? activeRepos(projectDir) : [options.repo])
    .map((repo) => safePathSegment(repo, "Repository name"));
  const safeArtifact = safeArtifactName(artifact);
  const root = workspaceRoot(projectDir);
  const space = activeSpace(projectDir);
  return repos.map((repo) =>
    workspacePath(
      projectDir,
      join(root, "spaces", space, "codekb", repo, `${safeArtifact}.md`),
    )
  );
}

function concretePerUnitPaths(
  projectDir: string,
  stage: CompiledStage,
  artifact: string,
): string[] {
  const constructionDir = join(activeIntentRecordDir(projectDir), stage.phase);
  if (!existsSync(constructionDir)) return [];
  return readdirSync(constructionDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => standardArtifactPath(
      projectDir,
      stage,
      artifact,
      entry.name,
    ))
    .filter((path) => existsSync(resolve(projectDir, path)))
    .sort();
}

/** Build the unique artifact -> producing stage index. */
export function buildArtifactProducerIndex(
  graph: readonly CompiledStage[],
): Map<string, ArtifactProducer> {
  validateArtifactContracts(graph);
  const result = new Map<string, ArtifactProducer>();
  for (const stage of graph) {
    for (const artifact of stage.produces ?? []) {
      result.set(artifact, { stage, optional: false });
    }
    for (const artifact of stage.optional_produces ?? []) {
      result.set(artifact, { stage, optional: true });
    }
  }
  return result;
}

/** Resolve output paths for one declared artifact. */
export function artifactOutputPaths(
  projectDir: string,
  stage: CompiledStage,
  artifact: string,
  options: ArtifactResolutionOptions = {},
): string[] {
  if (stage.slug === "reverse-engineering") {
    return codeKnowledgePaths(projectDir, artifact, options);
  }
  return [standardArtifactPath(
    projectDir,
    stage,
    artifact,
    options.unit,
    options.singlePass,
  )];
}

/** Apply a Stage's optional per-kind output matrix for one Unit. */
export function producedArtifactsForUnit(
  stage: CompiledStage,
  artifacts: readonly string[],
  kind?: UnitKind,
): string[] {
  if (kind === undefined || stage.produces_kinds === undefined) {
    return [...artifacts];
  }
  return artifacts.filter((artifact) => {
    const kinds = stage.produces_kinds?.[artifact];
    return kinds === undefined || kinds.includes(kind);
  });
}

function consumedArtifactPaths(
  projectDir: string,
  producer: CompiledStage,
  artifact: string,
  consumer: CompiledStage,
  options: ArtifactResolutionOptions,
): { candidates: string[]; present: string[] } {
  if (producer.slug === "reverse-engineering") {
    const candidates = codeKnowledgePaths(projectDir, artifact, options);
    return {
      candidates,
      present: candidates.filter((path) => existsSync(resolve(projectDir, path))),
    };
  }
  if (producer.for_each === "unit-of-work" && options.unit === undefined) {
    if (options.singlePass) {
      const candidates = [standardArtifactPath(
        projectDir,
        producer,
        artifact,
        undefined,
        true,
      )];
      return {
        candidates,
        present: candidates.filter((path) => existsSync(resolve(projectDir, path))),
      };
    }
    const present = concretePerUnitPaths(projectDir, producer, artifact);
    return {
      candidates: present.length > 0
        ? present
        : [standardArtifactPath(projectDir, producer, artifact)],
      present,
    };
  }
  const unit = producer.for_each === "unit-of-work" &&
      consumer.for_each === "unit-of-work"
    ? options.unit
    : undefined;
  const candidates = [standardArtifactPath(projectDir, producer, artifact, unit)];
  return {
    candidates,
    present: candidates.filter((path) => existsSync(resolve(projectDir, path))),
  };
}

/** Resolve a stage's complete consumes/produces contract in the active Intent. */
export function resolveStageArtifacts(
  projectDir: string,
  stage: CompiledStage,
  graph: readonly CompiledStage[],
  plan: readonly ResolvedPlanStage[],
  stateContent: string,
  projectType: string,
  options: ArtifactResolutionOptions = {},
): ResolvedStageArtifacts {
  const producers = buildArtifactProducerIndex(graph);
  const consumes: string[] = [];
  const consumesAbsent: AbsentArtifact[] = [];

  for (const consume of applicableConsumes(projectType, stage)) {
    const producer = producers.get(consume.artifact);
    if (producer === undefined) {
      throw new Error(
        `Stage "${stage.slug}" consumes unknown artifact "${consume.artifact}"`,
      );
    }
    const producerKinds = producer.stage.produces_kinds?.[consume.artifact];
    if (
      options.unitKind !== undefined && producerKinds !== undefined &&
      !producerKinds.includes(options.unitKind)
    ) {
      continue;
    }
    const paths = consumedArtifactPaths(
      projectDir,
      producer.stage,
      consume.artifact,
      stage,
      options,
    );
    consumes.push(...paths.present);
    if (consume.required) {
      const expected = !stateRouteIsActive(stateContent, producer.stage.slug, plan);
      const present = new Set(paths.present);
      consumesAbsent.push(
        ...paths.candidates
          .filter((path) => !present.has(path))
          .map((path) => ({ path, expected })),
      );
    }
  }

  const produces = producedArtifactsForUnit(
    stage,
    stage.produces ?? [],
    options.unitKind,
  ).flatMap((artifact) =>
    artifactOutputPaths(projectDir, stage, artifact, options)
  );
  const optionalProduces = producedArtifactsForUnit(
    stage,
    stage.optional_produces ?? [],
    options.unitKind,
  ).flatMap((artifact) =>
    artifactOutputPaths(projectDir, stage, artifact, options)
  );
  return { consumes, consumesAbsent, produces, optionalProduces };
}

/** Verify required output files before a completion report is committed. */
export function verifyStageArtifactEvidence(
  projectDir: string,
  stage: CompiledStage,
  options: ArtifactResolutionOptions = {},
): ArtifactEvidence {
  if (
    stage.for_each === "unit-of-work" && options.unit === undefined &&
    !options.singlePass
  ) {
    return {
      valid: false,
      missing: [
        `${stage.slug}: per-unit artifact verification requires --unit <name>`,
      ],
    };
  }
  const required = producedArtifactsForUnit(
    stage,
    stage.produces ?? [],
    options.unitKind,
  ).flatMap((artifact) =>
    artifactOutputPaths(projectDir, stage, artifact, options)
  );
  const missing = required.filter((path) => !existsSync(resolve(projectDir, path)));
  return { valid: missing.length === 0, missing };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  try {
    const graph = loadCompiledStageGraph();
    if (command === "check") {
      validateArtifactContracts(graph);
      console.log(`Artifact contracts are valid: ${graph.length} stages`);
      return;
    }
    if (command !== "show") {
      console.error(
        "Usage: aidlc-artifacts check\n" +
          "       aidlc-artifacts show --project-dir <dir> --stage <slug> [--unit <name>] [--repo <name>]",
      );
      process.exitCode = 1;
      return;
    }
    const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
    const slug = flagValue(args, "--stage");
    if (slug === undefined) throw new Error("show requires --stage <slug>");
    const stage = graph.find((candidate) => candidate.slug === slug);
    if (stage === undefined) throw new Error(`Unknown stage: "${slug}"`);
    const stateContent = readFileSync(stateFilePath(projectDir), "utf8");
    const plan = JSON.parse(
      readFileSync(planFilePath(projectDir), "utf8"),
    ) as ResolvedPlanStage[];
    const projectType = /^- \*\*Project Type\*\*:\s*(.*)$/m
      .exec(stateContent)?.[1]?.trim() ?? "Unknown";
    const unit = flagValue(args, "--unit");
    const repo = flagValue(args, "--repo");
    const options: ArtifactResolutionOptions = {
      ...(unit === undefined ? {} : { unit }),
      ...(repo === undefined ? {} : { repo }),
    };
    console.log(JSON.stringify(
      resolveStageArtifacts(
        projectDir,
        stage,
        graph,
        plan,
        stateContent,
        projectType,
        options,
      ),
      null,
      2,
    ));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
