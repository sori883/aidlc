// Static contract check between authored Stage/Agent instructions and the
// Codex runtime that is distributed from this repository.

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isCompiledExecutable,
  runtimeCoreDir,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";
import { codexBundleFiles } from "./aidlc-codex-bundle.ts";
import {
  type CliContract,
  loadCliContracts,
} from "./aidlc-cli-contract.ts";

export type RuntimeContractIssueCode =
  | "missing-tool"
  | "missing-command"
  | "missing-cli-contract"
  | "missing-flag"
  | "missing-result"
  | "missing-resource"
  | "capability-drift"
  | "unresolved-harness-placeholder";

export interface RuntimeContractIssue {
  code: RuntimeContractIssueCode;
  source: string;
  line: number;
  subject: string;
  detail: string;
}

export interface RuntimeContractReport {
  valid: boolean;
  documents: number;
  issues: RuntimeContractIssue[];
}

export interface RuntimeContractOptions {
  coreDir?: string;
  harnessDir?: string;
}

export interface AuthoredCliInvocation {
  tool: string;
  command: string;
  flags: string[];
  results: string[];
  line: number;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORE_DIR = runtimeCoreDir();
const DEFAULT_HARNESS_DIR = isCompiledExecutable()
  ? runtimeHarnessDir()
  : resolve(MODULE_DIR, "../../harness/codex");

function portable(path: string): string {
  return path.split(sep).join("/");
}

function markdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function generatedBundleFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...generatedBundleFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function bodyWithoutFrontmatter(content: string): string {
  return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function codeFragments(content: string): Array<{ text: string; index: number }> {
  const fragments: Array<{ text: string; index: number }> = [];
  for (const match of content.matchAll(/```(?:[a-z]+)?\r?\n([\s\S]*?)```/gi)) {
    if (match[1] !== undefined) {
      fragments.push({
        text: match[1],
        index: (match.index ?? 0) + match[0].indexOf(match[1]),
      });
    }
  }
  for (const match of content.matchAll(/(?<!`)`(?!`)([\s\S]*?)(?<!`)`(?!`)/g)) {
    if (match[1] !== undefined) {
      fragments.push({
        text: match[1],
        index: (match.index ?? 0) + 1,
      });
    }
  }
  return fragments;
}

/** Extract concrete Harness CLI calls from fenced and inline Markdown code. */
export function authoredCliInvocations(content: string): AuthoredCliInvocation[] {
  const body = bodyWithoutFrontmatter(content);
  const bodyOffset = content.length - body.length;
  const invocations: AuthoredCliInvocation[] = [];
  for (const fragment of codeFragments(body)) {
    const normalized = fragment.text
      .replace(/\\\r?\n/g, " ")
      .replace(/\s+/g, " ");
    const flags = [...new Set(
      [...normalized.matchAll(/--[a-z0-9]+(?:-[a-z0-9]+)*/g)]
        .map((match) => match[0]),
    )];
    const results = [...new Set(
      [...normalized.matchAll(/--result\s+([a-z][a-z0-9-]*)/g)]
        .map((match) => match[1]!),
    )];
    for (const match of normalized.matchAll(
      /(?:bun\s+)?\{\{HARNESS_DIR\}\}\/tools\/(aidlc-[a-z0-9-]+\.ts)\s+([a-z][a-z0-9-]*)/g,
    )) {
      invocations.push({
        tool: match[1]!,
        command: match[2]!,
        flags,
        results,
        line: lineAt(content, bodyOffset + fragment.index),
      });
    }
  }
  for (const match of body.matchAll(/\b(aidlc-log\.ts)\s+(decision|answer)\b/g)) {
    invocations.push({
      tool: match[1]!,
      command: match[2]!,
      flags: [],
      results: [],
      line: lineAt(content, bodyOffset + (match.index ?? 0)),
    });
  }
  return invocations;
}

function pushIssue(
  issues: RuntimeContractIssue[],
  issue: RuntimeContractIssue,
): void {
  if (issues.some((candidate) =>
    candidate.code === issue.code && candidate.source === issue.source &&
    candidate.subject === issue.subject
  )) return;
  issues.push(issue);
}

function expectedResourcePath(reference: string): string {
  if (reference.startsWith("knowledge/")) return reference;
  if (reference === "tools/data/scope-grid.json") {
    return "aidlc-common/data/scope-grid.json";
  }
  if (reference.startsWith("tools/")) return reference;
  throw new Error(`Unsupported Harness resource: ${reference}`);
}

function inspectGeneratedInstructions(
  generatedFiles: ReadonlyMap<string, string>,
  issues: RuntimeContractIssue[],
): void {
  const instructionFiles = [...generatedFiles].filter(([path]) =>
    path.endsWith(".md") || path.endsWith(".toml")
  );
  for (const [path, content] of instructionFiles) {
    for (const match of content.matchAll(/\{\{HARNESS_DIR\}\}/g)) {
      pushIssue(issues, {
        code: "unresolved-harness-placeholder",
        source: portable(path),
        line: lineAt(content, match.index ?? 0),
        subject: "{{HARNESS_DIR}}",
        detail: "Generated Codex bundle still contains an unresolved Harness path",
      });
    }
    for (const match of content.matchAll(
      /(?:^|[\s`("'=])(\.codex\/[A-Za-z0-9_./-]+\.(?:json|md|toml|ts|yaml))(?=$|[\s`'"),.:;])/gm,
    )) {
      const reference = match[1]!;
      if (generatedFiles.has(reference)) continue;
      pushIssue(issues, {
        code: "missing-resource",
        source: portable(path),
        line: lineAt(content, (match.index ?? 0) + match[0].indexOf(reference)),
        subject: reference,
        detail: `Referenced Codex bundle resource does not exist: ${reference}`,
      });
    }
  }
}

function loadNamedResources(coreDir: string): Record<string, string> {
  const path = join(
    coreDir,
    "aidlc-common",
    "data",
    "runtime-shared-resources.json",
  );
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: must contain an object`);
  }
  const resources: Record<string, string> = {};
  for (const [name, target] of Object.entries(value)) {
    if (!name.endsWith(".md") || typeof target !== "string" || target === "") {
      throw new Error(`${path}: invalid resource entry ${name}`);
    }
    resources[name] = target;
  }
  return resources;
}

function inspectDocument(
  coreDir: string,
  source: string,
  content: string,
  capabilities: ReadonlyMap<string, CliContract>,
  namedResources: Readonly<Record<string, string>>,
  issues: RuntimeContractIssue[],
): void {
  const body = bodyWithoutFrontmatter(content);
  const toolPattern = /\baidlc-[a-z0-9-]+\.ts\b/g;
  for (const match of body.matchAll(toolPattern)) {
    const tool = match[0];
    const toolPath = join(coreDir, "tools", tool);
    if (!existsSync(toolPath)) {
      pushIssue(issues, {
        code: "missing-tool",
        source,
        line: lineAt(content, (match.index ?? 0) + content.length - body.length),
        subject: tool,
        detail: `Referenced runtime tool does not exist: core/tools/${tool}`,
      });
    }
  }

  for (const invocation of authoredCliInvocations(content)) {
    const { tool, command } = invocation;
    if (!existsSync(join(coreDir, "tools", tool))) continue;
    const capability = capabilities.get(tool);
    if (capability === undefined) {
      pushIssue(issues, {
        code: "missing-cli-contract",
        source,
        line: invocation.line,
        subject: tool,
        detail: `Runtime tool has no auto-discovered definition in core/tools/contracts`,
      });
      continue;
    }
    if (capability.commands[command] === undefined) {
      const marker = `${tool} ${command}`;
      pushIssue(issues, {
        code: "missing-command",
        source,
        line: invocation.line,
        subject: marker,
        detail: `Runtime tool ${tool} does not implement command "${command}"`,
      });
      continue;
    }
    const commandCapability = capability.commands[command];
    for (const flag of invocation.flags) {
      if (!commandCapability.flags.includes(flag)) {
        pushIssue(issues, {
          code: "missing-flag",
          source,
          line: invocation.line,
          subject: `${tool} ${command} ${flag}`,
          detail: `${tool} ${command} does not accept ${flag}`,
        });
      }
    }
    for (const result of invocation.results) {
      if (!commandCapability.results.includes(result)) {
        pushIssue(issues, {
          code: "missing-result",
          source,
          line: invocation.line,
          subject: `${tool} ${command} --result ${result}`,
          detail: `${tool} ${command} does not accept --result "${result}"`,
        });
      }
    }
  }

  if (body.includes("aidlc-orchestrate.ts") && body.includes(" report")) {
    const report = capabilities.get("aidlc-orchestrate.ts")?.commands.report;
    if (report === undefined) return;
    for (const match of body.matchAll(/--result\s+([a-z][a-z0-9-]*)/g)) {
      const result = match[1]!;
      if (!report.results.includes(result)) {
        pushIssue(issues, {
          code: "missing-result",
          source,
          line: lineAt(content, (match.index ?? 0) + content.length - body.length),
          subject: `aidlc-orchestrate.ts report --result ${result}`,
          detail: `report does not accept --result "${result}"`,
        });
      }
    }
    for (const match of body.matchAll(/--user-input\b/g)) {
      if (!report.flags.includes("--user-input")) {
        pushIssue(issues, {
          code: "missing-flag",
          source,
          line: lineAt(content, (match.index ?? 0) + content.length - body.length),
          subject: "aidlc-orchestrate.ts report --user-input",
          detail: "report does not accept --user-input",
        });
      }
    }
  }

  for (const match of body.matchAll(
    /\{\{HARNESS_DIR\}\}\/((?:knowledge|tools)\/[A-Za-z0-9_./-]+\.(?:md|json))/g,
  )) {
    const reference = match[1]!;
    const expected = expectedResourcePath(reference);
    if (!existsSync(join(coreDir, expected))) {
      pushIssue(issues, {
        code: "missing-resource",
        source,
        line: lineAt(content, (match.index ?? 0) + content.length - body.length),
        subject: reference,
        detail: `Referenced Harness resource does not exist: ${portable(join(coreDir, expected))}`,
      });
    }
  }

  for (const [name, expected] of Object.entries(namedResources)) {
    const index = body.indexOf(name);
    if (index !== -1 && !existsSync(join(coreDir, expected))) {
      pushIssue(issues, {
        code: "missing-resource",
        source,
        line: lineAt(content, index + content.length - body.length),
        subject: name,
        detail: `Referenced shared document does not exist: ${portable(join(coreDir, expected))}`,
      });
    }
  }
}

function inspectCapabilityDrift(
  coreDir: string,
  capabilities: ReadonlyMap<string, CliContract>,
  issues: RuntimeContractIssue[],
): void {
  for (const [tool, capability] of capabilities) {
    const path = join(coreDir, "tools", tool);
    if (!existsSync(path)) {
      pushIssue(issues, {
        code: "capability-drift",
        source: portable(relative(dirname(coreDir), path)),
        line: 1,
        subject: tool,
        detail: "CLI definition exists but its runtime tool does not",
      });
      continue;
    }
    const source = readFileSync(path, "utf8");
    if (!source.includes(`loadCliContract("${tool}")`)) {
      pushIssue(issues, {
        code: "capability-drift",
        source: portable(relative(dirname(coreDir), path)),
        line: 1,
        subject: `${tool}: loadCliContract`,
        detail: "Runtime tool does not load its auto-discovered CLI definition",
      });
    }
    for (const [command, commandCapability] of Object.entries(
      capability.commands,
    )) {
      for (const literal of [
        command,
        ...commandCapability.flags,
        ...commandCapability.results,
      ]) {
        if (!source.includes(`"${literal}"`)) {
          pushIssue(issues, {
            code: "capability-drift",
            source: portable(relative(dirname(coreDir), path)),
            line: 1,
            subject: `${tool}: ${literal}`,
            detail: `Declared CLI capability is absent from ${tool} source`,
          });
        }
      }
    }
  }
}

/** Inspect authored instructions and their generated Codex bundle. */
export function inspectRuntimeContract(
  options: RuntimeContractOptions = {},
): RuntimeContractReport {
  const coreDir = resolve(options.coreDir ?? DEFAULT_CORE_DIR);
  const harnessDir = resolve(options.harnessDir ?? DEFAULT_HARNESS_DIR);
  const repositoryRoot = dirname(coreDir);
  const capabilities = loadCliContracts(join(coreDir, "tools", "contracts"));
  const namedResources = loadNamedResources(coreDir);
  const documents = [
    ...markdownFiles(join(coreDir, "aidlc-common", "stages")),
    ...markdownFiles(join(coreDir, "agents")),
  ];
  const issues: RuntimeContractIssue[] = [];
  for (const path of documents) {
    inspectDocument(
      coreDir,
      portable(relative(repositoryRoot, path)),
      readFileSync(path, "utf8"),
      capabilities,
      namedResources,
      issues,
    );
  }
  inspectCapabilityDrift(coreDir, capabilities, issues);

  const generatedFiles = existsSync(join(harnessDir, "runtime", "package.json"))
    ? codexBundleFiles({ coreDir, harnessDir })
    : new Map(
      generatedBundleFiles(coreDir).map((path) => [
        portable(relative(repositoryRoot, path)),
        readFileSync(path, "utf8"),
      ]),
    );
  inspectGeneratedInstructions(generatedFiles, issues);

  issues.sort((left, right) =>
    left.source.localeCompare(right.source) || left.line - right.line ||
    left.code.localeCompare(right.code) || left.subject.localeCompare(right.subject)
  );
  return { valid: issues.length === 0, documents: documents.length, issues };
}

function renderReport(report: RuntimeContractReport): string {
  if (report.valid) {
    return `Runtime contract is valid (${report.documents} documents checked).`;
  }
  const rows = report.issues.map((issue) =>
    `- [${issue.code}] ${issue.source}:${issue.line} ${issue.subject} — ${issue.detail}`
  );
  return [
    `Runtime contract has ${report.issues.length} issue(s) across ${report.documents} documents:`,
    ...rows,
  ].join("\n");
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;
  if (command !== "check") {
    console.error("Usage: aidlc-runtime-contract check [--json]");
    process.exitCode = 1;
    return;
  }
  const report = inspectRuntimeContract();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(renderReport(report));
  }
  if (!report.valid) process.exitCode = 1;
}

if (import.meta.main) main(process.argv.slice(2));
