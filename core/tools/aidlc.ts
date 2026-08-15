#!/usr/bin/env bun

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIDLC_VERSION } from "./aidlc-version.ts";

export type Route = {
  noun: string;
  tool: string;
  commands: readonly string[];
  summary: string;
};

export type Action =
  | { type: "delegate"; tool: string; args: string[] }
  | { type: "help"; all: boolean }
  | { type: "version" }
  | { type: "error"; message: string; code: number };

export const ROUTES: readonly Route[] = [
  { noun: "artifact", tool: "aidlc-artifacts.ts", commands: ["check", "show"], summary: "validate and resolve Stage artifacts" },
  { noun: "contract", tool: "aidlc-runtime-contract.ts", commands: ["check"], summary: "validate the installed runtime contract" },
  { noun: "doctor", tool: "aidlc-doctor.ts", commands: ["check", "repair"], summary: "diagnose and repair AI-DLC state" },
  { noun: "graph", tool: "aidlc-graph.ts", commands: ["compile", "resolve", "ars", "validate-grid"], summary: "compile and query the Stage Graph" },
  { noun: "intent", tool: "aidlc-intent.ts", commands: ["birth", "list", "switch"], summary: "create and select Intents" },
  { noun: "learnings", tool: "aidlc-learnings.ts", commands: ["surface", "persist"], summary: "surface and persist learned Rules" },
  { noun: "log", tool: "aidlc-log.ts", commands: ["decision", "answer"], summary: "append decision and answer events" },
  { noun: "memory", tool: "aidlc-memory.ts", commands: ["init"], summary: "initialize Stage Memory" },
  { noun: "orchestrate", tool: "aidlc-orchestrate.ts", commands: ["next", "report"], summary: "resolve and report Workflow actions" },
  { noun: "sensor", tool: "aidlc-sensor.ts", commands: ["list", "describe", "fire"], summary: "inspect and fire Sensors" },
  { noun: "space", tool: "aidlc-space.ts", commands: ["create", "list", "switch"], summary: "create and select Spaces" },
  { noun: "state", tool: "aidlc-state.ts", commands: ["init", "show", "advance", "skip", "resume", "check", "practices-event", "practices-promote", "set-construction-iteration"], summary: "inspect and mutate Workflow State" },
  { noun: "unit", tool: "aidlc-unit-graph.ts", commands: ["check", "show"], summary: "inspect the active Unit DAG" },
  { noun: "utility", tool: "aidlc-utility.ts", commands: ["detect", "scope-table", "stage-table", "codekb-path", "recompose"], summary: "run shared AI-DLC utilities" },
  { noun: "workspace", tool: "aidlc-workspace.ts", commands: ["init"], summary: "initialize an AI-DLC Workspace" },
  { noun: "workspace-detect", tool: "aidlc-workspace-detect.ts", commands: ["detect"], summary: "detect project characteristics" },
  { noun: "workspace-migrate", tool: "aidlc-workspace-migrate.ts", commands: ["migrate"], summary: "migrate a legacy Workspace" },
  { noun: "worktree", tool: "aidlc-worktree.ts", commands: ["create", "merge", "discard", "verify", "validate", "list", "info"], summary: "manage AI-DLC Worktrees" },
];

const TOP_LEVEL: Readonly<Record<string, readonly [string, string]>> = {
  next: ["aidlc-orchestrate.ts", "next"],
  report: ["aidlc-orchestrate.ts", "report"],
};

const SENSOR_WORKERS: Readonly<Record<string, string>> = {
  "claim-sources": "aidlc-sensor-claim-sources.ts",
  linter: "aidlc-sensor-linter.ts",
  "required-sections": "aidlc-sensor-required-sections.ts",
  "type-check": "aidlc-sensor-type-check.ts",
  "upstream-coverage": "aidlc-sensor-upstream-coverage.ts",
};

function error(message: string): Action {
  return { type: "error", message: `${message}\n`, code: 1 };
}

export function resolveAction(argv: string[]): Action {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { type: "help", all: false };
  }
  if (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "version") {
    return argv.length === 1
      ? { type: "version" }
      : error("aidlc: version does not accept arguments");
  }
  if (argv[0] === "help") return { type: "help", all: argv[1] === "--all" };

  const top = TOP_LEVEL[argv[0] ?? ""];
  if (top !== undefined) {
    return { type: "delegate", tool: top[0], args: [top[1], ...argv.slice(1)] };
  }

  if (argv[0] === "__sensor-script") {
    const tool = SENSOR_WORKERS[argv[1] ?? ""];
    return tool === undefined
      ? error(`aidlc: unknown Sensor worker '${argv[1] ?? ""}'`)
      : { type: "delegate", tool, args: argv.slice(2) };
  }

  if (argv[0] === "hook") {
    return argv[1] === "sensor-fire"
      ? { type: "delegate", tool: "aidlc-codex-hook.ts", args: argv.slice(2) }
      : error(`aidlc: unknown hook '${argv[1] ?? ""}'`);
  }

  const route = ROUTES.find((candidate) => candidate.noun === argv[0]);
  if (route === undefined) {
    return error(`aidlc: unknown command or noun '${argv[0]}'`);
  }
  const command = argv[1];
  if (command === undefined || !route.commands.includes(command)) {
    return error(
      `aidlc: ${command === undefined ? "missing command" : `unknown command '${command}'`} ` +
        `for '${route.noun}'`,
    );
  }
  return { type: "delegate", tool: route.tool, args: argv.slice(1) };
}

export function renderHelp(all = false): string {
  const lines = [
    "aidlc <noun> <command> [args]",
    "",
    "Common commands:",
    "  aidlc next [args]       resolve the next Workflow action",
    "  aidlc report [args]     report a Stage result",
    "  aidlc doctor check      diagnose the active Workspace",
    "  aidlc state resume      show the persisted resume point",
    "  aidlc --help            show this help",
    "  aidlc --version         show the AI-DLC version",
  ];
  if (all) {
    lines.push("", "All command groups:");
    for (const route of ROUTES) {
      lines.push(
        `  ${route.noun.padEnd(18)} ${route.commands.join(", ")} — ${route.summary}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function toolsDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function bunExecutable(): string {
  return basename(process.execPath).startsWith("bun") ? process.execPath : "bun";
}

function runDelegateDev(tool: string, args: string[]): number {
  const child = Bun.spawnSync(
    [bunExecutable(), join(toolsDir(), tool), ...args],
    { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  return child.exitCode ?? 1;
}

type DelegateModule = {
  main(argv: string[]): void | Promise<void>;
};

async function loadDelegate(tool: string): Promise<DelegateModule | null> {
  switch (tool) {
    case "aidlc-artifacts.ts": return import("./aidlc-artifacts.ts");
    case "aidlc-codex-hook.ts": return import("./aidlc-codex-hook.ts");
    case "aidlc-runtime-contract.ts": return import("./aidlc-runtime-contract.ts");
    case "aidlc-doctor.ts": return import("./aidlc-doctor.ts");
    case "aidlc-graph.ts": return import("./aidlc-graph.ts");
    case "aidlc-intent.ts": return import("./aidlc-intent.ts");
    case "aidlc-learnings.ts": return import("./aidlc-learnings.ts");
    case "aidlc-log.ts": return import("./aidlc-log.ts");
    case "aidlc-memory.ts": return import("./aidlc-memory.ts");
    case "aidlc-orchestrate.ts": return import("./aidlc-orchestrate.ts");
    case "aidlc-sensor.ts": return import("./aidlc-sensor.ts");
    case "aidlc-sensor-claim-sources.ts": return import("./aidlc-sensor-claim-sources.ts");
    case "aidlc-sensor-linter.ts": return import("./aidlc-sensor-linter.ts");
    case "aidlc-sensor-required-sections.ts": return import("./aidlc-sensor-required-sections.ts");
    case "aidlc-sensor-type-check.ts": return import("./aidlc-sensor-type-check.ts");
    case "aidlc-sensor-upstream-coverage.ts": return import("./aidlc-sensor-upstream-coverage.ts");
    case "aidlc-space.ts": return import("./aidlc-space.ts");
    case "aidlc-state.ts": return import("./aidlc-state.ts");
    case "aidlc-unit-graph.ts": return import("./aidlc-unit-graph.ts");
    case "aidlc-utility.ts": return import("./aidlc-utility.ts");
    case "aidlc-workspace.ts": return import("./aidlc-workspace.ts");
    case "aidlc-workspace-detect.ts": return import("./aidlc-workspace-detect.ts");
    case "aidlc-workspace-migrate.ts": return import("./aidlc-workspace-migrate.ts");
    case "aidlc-worktree.ts": return import("./aidlc-worktree.ts");
    default: return null;
  }
}

async function runDelegateInProcess(tool: string, args: string[]): Promise<number> {
  const delegate = await loadDelegate(tool);
  if (delegate === null || typeof delegate.main !== "function") {
    process.stderr.write(`aidlc: ${tool} does not export main(argv)\n`);
    return 1;
  }
  process.exitCode = 0;
  await delegate.main(args);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function execute(action: Action): Promise<number> {
  if (action.type === "help") {
    process.stdout.write(renderHelp(action.all));
    return 0;
  }
  if (action.type === "version") {
    process.stdout.write(`aidlc ${AIDLC_VERSION}\n`);
    return 0;
  }
  if (action.type === "error") {
    process.stderr.write(action.message);
    return action.code;
  }
  return import.meta.url.includes("/$bunfs/")
    ? await runDelegateInProcess(action.tool, action.args)
    : runDelegateDev(action.tool, action.args);
}

export async function main(argv: string[]): Promise<void> {
  process.exitCode = await execute(resolveAction(argv));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((failure) => {
    process.stderr.write(
      `aidlc: ${failure instanceof Error ? failure.message : String(failure)}\n`,
    );
    process.exitCode = 1;
  });
}
