// Deterministic implementations for the five framework Sensors. Each checker
// returns structured JSON; the dispatcher owns audit correlation and outcome
// classification.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadCompiledStageGraph } from "./aidlc-graph.ts";
import { parseUnitDag } from "./aidlc-unit-graph.ts";
import { activeSpace, workspaceRoot } from "./aidlc-workspace.ts";
import { stateFilePath } from "./aidlc-state.ts";
import { applicableStageConsumes } from "./aidlc-artifacts.ts";

export type SensorCheckerId =
  | "claim-sources"
  | "required-sections"
  | "upstream-coverage"
  | "linter"
  | "type-check";

export interface SensorCheckerResult {
  pass: boolean;
  budget_override?: boolean;
  [key: string]: unknown;
}

export interface SensorCheckerInput {
  projectDir: string;
  stage: string;
  filePath: string;
}

const DOCUMENT_SENSORS = new Set<SensorCheckerId>([
  "claim-sources",
  "required-sections",
  "upstream-coverage",
]);

function readText(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Sensor input is not a file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function h2Headings(source: string): string[] {
  return [...source.matchAll(/^##\s+(.+?)\s*$/gm)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function stateField(source: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^- \\*\\*${escaped}\\*\\*:[ \\t]*(.*)$`, "m")
    .exec(source)?.[1]?.trim() ?? null;
}

function markdownFiles(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .filter((name) =>
      name !== "memory.md" &&
      !name.endsWith("-questions.md") &&
      !name.endsWith("-timestamp.md")
    )
    .sort()
    .map((name) => join(directory, name));
}

function requiredSections(input: SensorCheckerInput): SensorCheckerResult {
  const source = readText(input.filePath);
  const headings = h2Headings(source);
  const findings: string[] = [];
  let expected: string[] = [];
  let edgeBlock = "not-applicable";

  const templatePath = join(
    workspaceRoot(input.projectDir),
    "spaces",
    activeSpace(input.projectDir),
    "memory",
    "templates",
    basename(input.filePath),
  );
  if (existsSync(templatePath)) {
    expected = h2Headings(readFileSync(templatePath, "utf8"));
    for (const heading of expected) {
      if (!headings.includes(heading)) findings.push(`Missing H2 heading: ${heading}`);
    }
  } else if (headings.length < 2) {
    findings.push(`Expected at least 2 H2 headings; found ${headings.length}`);
  }

  if (basename(input.filePath) === "unit-of-work-dependency.md") {
    try {
      const dag = parseUnitDag(source, input.filePath);
      edgeBlock = dag === null ? "absent" : "ok";
      if (dag === null) findings.push("Missing fenced YAML units block");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      edgeBlock = /cyclic/.test(message) ? "cyclic" : "malformed";
      findings.push(message);
    }
  }

  return {
    pass: findings.length === 0,
    h2_count: headings.length,
    headings,
    findings,
    findings_count: findings.length,
    edge_block: edgeBlock,
    template: existsSync(templatePath) ? templatePath : "none",
    template_expected: expected,
    template_missing: expected.filter((heading) => !headings.includes(heading)),
    config_warning: "",
  };
}

function tokenPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`, "i");
}

function upstreamCoverage(input: SensorCheckerInput): SensorCheckerResult {
  const graph = loadCompiledStageGraph();
  const stage = graph.find((candidate) => candidate.slug === input.stage);
  if (stage === undefined) throw new Error(`Unknown stage: ${input.stage}`);
  const deliverables = markdownFiles(dirname(input.filePath));
  const combined = deliverables.map(readText).join("\n");
  const state = readFileSync(stateFilePath(input.projectDir), "utf8");
  const projectType = stateField(state, "Project Type") ?? "unknown";
  const producers = new Map<string, string>();
  for (const candidate of graph) {
    for (const artifact of [
      ...(candidate.produces ?? []),
      ...(candidate.optional_produces ?? []),
    ]) {
      producers.set(artifact, candidate.slug);
    }
  }
  const applicable = applicableStageConsumes(projectType, stage);
  const unreferenced = applicable
    .map((consume) => consume.artifact)
    .filter((artifact) => {
      const producer = producers.get(artifact);
      return !tokenPattern(artifact).test(combined) &&
        !combined.includes(`[[${artifact}]]`) &&
        !combined.includes(`\`${artifact}.md\``) &&
        (producer === undefined || !combined.includes(`${producer}/`));
    });
  return {
    pass: unreferenced.length === 0,
    unreferenced_artifacts: unreferenced,
    applicable_artifacts: applicable.map((consume) => consume.artifact),
    project_type: projectType.toLowerCase(),
    deliverables,
  };
}

function stripHtmlComments(
  line: string,
  insideComment: boolean,
): { text: string; insideComment: boolean } {
  let cursor = 0;
  let text = "";
  let comment = insideComment;
  while (cursor < line.length) {
    if (comment) {
      const end = line.indexOf("-->", cursor);
      if (end === -1) return { text, insideComment: true };
      cursor = end + 3;
      comment = false;
      continue;
    }
    const start = line.indexOf("<!--", cursor);
    if (start === -1) {
      text += line.slice(cursor);
      break;
    }
    text += line.slice(cursor, start);
    cursor = start + 4;
    comment = true;
  }
  return { text, insideComment: comment };
}

/** Remove non-claim regions while preserving the original line numbering. */
export function stripIgnoredMarkdown(source: string): string {
  const rows = source.split(/\r?\n/);
  let comment = false;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let review = false;
  return rows.map((line) => {
    const withoutComments = stripHtmlComments(line, comment);
    comment = withoutComments.insideComment;
    const text = withoutComments.text;
    if (fence !== null) {
      const close = new RegExp(
        `^ {0,3}${fence.marker === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
      );
      if (close.test(text)) fence = null;
      return "";
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (opening !== null) {
      const sequence = opening[1]!;
      fence = {
        marker: sequence[0] as "`" | "~",
        length: sequence.length,
      };
      return "";
    }
    if (review) {
      if (!/^##\s+/.test(text)) return "";
      review = false;
    }
    if (/^##\s+Review\s*$/i.test(text)) {
      review = true;
      return "";
    }
    return text;
  }).join("\n");
}

function substantiveLines(source: string): Array<{ line: number; text: string }> {
  const cleaned = stripIgnoredMarkdown(source);
  const rows = cleaned.split(/\r?\n/);
  return rows.flatMap((text, index) => {
    const trimmed = text.trim();
    if (
      trimmed === "" || /^#{1,6}\s/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed) ||
      /^\|?\s*:?-+:?\s*(\||$)/.test(trimmed)
    ) return [];
    const substantive = /^[-*+]\s+\S/.test(trimmed) ||
      /^\d+[.)]\s+\S/.test(trimmed) ||
      trimmed.includes("|") ||
      /^[A-Za-z0-9`*_[]/.test(trimmed);
    return substantive ? [{ line: index + 1, text: trimmed }] : [];
  });
}

function claimSources(input: SensorCheckerInput): SensorCheckerResult {
  const directory = dirname(input.filePath);
  const deliverables = markdownFiles(directory);
  const questionsPath = join(directory, "intent-capture-questions.md");
  const questions = existsSync(questionsPath) ? readFileSync(questionsPath, "utf8") : "";
  const findings: string[] = [];
  const allowedTag = /\[(?:desc|scope|Q\d+|memory:[^\]]+|assumption)\]/i;
  const state = readFileSync(stateFilePath(input.projectDir), "utf8");

  if (stateField(state, "Project") === null) findings.push("State has no Project source");
  if (stateField(state, "Scope") === null) findings.push("State has no Scope source");
  for (const path of deliverables) {
    const source = readText(path);
    if (!h2Headings(source).includes("Assumptions & Open Questions")) {
      findings.push(`${basename(path)}: missing ## Assumptions & Open Questions`);
    }
    for (const row of substantiveLines(source)) {
      if (!allowedTag.test(row.text)) {
        findings.push(`${basename(path)}:${row.line}: claim has no source tag`);
      }
      for (const match of row.text.matchAll(/\[Q(\d+)\]/gi)) {
        const question = match[1] ?? "";
        if (!new RegExp(`(?:\\[Q${question}\\]|\\bQ${question}\\b)`, "i").test(questions)) {
          findings.push(`${basename(path)}:${row.line}: unresolved [Q${question}]`);
        }
      }
      if (/\[assumption\]/i.test(row.text)) {
        const before = source.slice(0, source.indexOf(row.text));
        const lastH2 = h2Headings(before).at(-1);
        if (lastH2 !== "Assumptions & Open Questions") {
          findings.push(`${basename(path)}:${row.line}: [assumption] outside assumptions section`);
        }
      }
    }
  }
  if (
    deliverables.some((path) => /\[assumption\]/i.test(readText(path))) &&
    !/A\.\s*Accept assumptions/i.test(questions)
  ) {
    findings.push("Retained assumptions have no explicit acceptance answer");
  }
  return {
    pass: findings.length === 0,
    findings,
    scanned_files: deliverables,
    questions_file: questionsPath,
    findings_count: findings.length,
  };
}

function toolPath(projectDir: string, name: string): string | null {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const local = join(projectDir, "node_modules", ".bin", `${name}${suffix}`);
  return existsSync(local) ? local : null;
}

function linter(input: SensorCheckerInput): SensorCheckerResult {
  const executable = toolPath(input.projectDir, "eslint");
  if (executable === null) {
    return {
      pass: false,
      budget_override: true,
      reason: "eslint is not installed in the project",
      violations: [],
    };
  }
  const target = relative(input.projectDir, input.filePath);
  const result = spawnSync(executable, [target, "--format", "json"], {
    cwd: input.projectDir,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status === null || result.status > 1) {
    return {
      pass: false,
      budget_override: true,
      reason: result.error?.message || result.stderr || "eslint execution failed",
      violations: [],
    };
  }
  let reports: Array<{
    filePath?: string;
    messages?: Array<{
      line?: number;
      ruleId?: string | null;
      message?: string;
    }>;
  }> = [];
  try {
    reports = JSON.parse(result.stdout || "[]") as typeof reports;
  } catch {
    return {
      pass: false,
      budget_override: true,
      reason: "eslint returned invalid JSON",
      violations: [],
    };
  }
  const violations = reports.flatMap((report) =>
    (report.messages ?? []).map((message) => ({
      file: report.filePath ?? input.filePath,
      line: message.line ?? 0,
      rule: message.ruleId ?? "unknown",
      message: message.message ?? "eslint violation",
    }))
  );
  return { pass: violations.length === 0, violations };
}

function typeCheck(input: SensorCheckerInput): SensorCheckerResult {
  const executable = toolPath(input.projectDir, "tsc");
  const configPath = join(input.projectDir, "tsconfig.json");
  if (executable === null || !existsSync(configPath)) {
    return {
      pass: false,
      budget_override: true,
      reason: executable === null
        ? "typescript is not installed in the project"
        : "tsconfig.json is not present",
      errors: [],
    };
  }
  const result = spawnSync(executable, ["--noEmit", "--pretty", "false"], {
    cwd: input.projectDir,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error !== undefined || result.status === null) {
    return {
      pass: false,
      budget_override: true,
      reason: result.error?.message ?? "type-check execution failed",
      errors: [],
    };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const errors = output.split(/\r?\n/).flatMap((line) => {
    const match = /^(.*)\((\d+),(\d+)\): error TS\d+: (.*)$/.exec(line.trim());
    return match === null ? [] : [{
      file: match[1] ?? "",
      line: Number(match[2]),
      column: Number(match[3]),
      message: match[4] ?? "TypeScript error",
    }];
  });
  if (result.status !== 0 && errors.length === 0) {
    return {
      pass: false,
      budget_override: true,
      reason: output.trim() || `type-check exited ${result.status}`,
      errors,
    };
  }
  return { pass: result.status === 0, errors, output: output.trim() };
}

export function runSensorChecker(
  id: SensorCheckerId,
  input: SensorCheckerInput,
): SensorCheckerResult {
  const projectDir = resolve(input.projectDir);
  const filePath = resolve(projectDir, input.filePath);
  const normalized = { ...input, projectDir, filePath };
  if (DOCUMENT_SENSORS.has(id) && !filePath.endsWith(".md")) {
    throw new Error(`${id} requires a Markdown output file`);
  }
  switch (id) {
    case "claim-sources":
      return claimSources(normalized);
    case "required-sections":
      return requiredSections(normalized);
    case "upstream-coverage":
      return upstreamCoverage(normalized);
    case "linter":
      return linter(normalized);
    case "type-check":
      return typeCheck(normalized);
  }
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function runSensorCheckerCli(
  id: SensorCheckerId,
  args = process.argv.slice(2),
): void {
  const stage = flagValue(args, "--stage");
  const filePath = flagValue(args, "--output-path") ??
    flagValue(args, "--file-path");
  const projectDir = flagValue(args, "--project-dir") ??
    process.env.AIDLC_PROJECT_DIR ?? process.cwd();
  if (stage === undefined || filePath === undefined) {
    console.error(`${id} requires --stage <slug> and a file path flag`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = runSensorChecker(id, { projectDir, stage, filePath });
    console.log(JSON.stringify(result));
    // A valid structured checker result is a successful protocol exchange.
    // The dispatcher classifies result.pass; exit status is reserved for an
    // invocation or protocol failure.
    process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  console.error("Run a specific aidlc-sensor-<id>.ts entry point.");
  process.exitCode = 2;
}
