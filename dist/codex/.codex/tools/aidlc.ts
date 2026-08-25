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
  { noun: "architecture", tool: "aidlc-vnext-architecture.ts", commands: ["prepare", "complete", "policy-review", "policy-approve"], summary: "prepare, review, and validate ST-04 Architecture work" },
  { noun: "build-contract", tool: "aidlc-vnext-build-contract.ts", commands: ["prepare", "review", "approve"], summary: "prepare, review, and approve ST-05 Build Contract work" },
  { noun: "build", tool: "aidlc-vnext-build-converge.ts", commands: ["prepare", "verify", "reuse"], summary: "prepare, verify, or reuse validated ST-06 build work" },
  { noun: "doctor", tool: "aidlc-vnext-doctor.ts", commands: ["check", "repair"], summary: "diagnose and repair vNext Core state" },
  { noun: "define-intent", tool: "aidlc-vnext-define-intent.ts", commands: ["prepare", "complete"], summary: "prepare and validate ST-02 Define Intent work" },
  { noun: "graph", tool: "aidlc-core-route.ts", commands: ["show", "catalog", "validate"], summary: "inspect the fixed vNext Catalog and Graph" },
  { noun: "intent", tool: "aidlc-intent.ts", commands: ["birth", "list", "switch", "risk"], summary: "create and select Intents or manage the active Intent Risk Register" },
  { noun: "orchestrate", tool: "aidlc-vnext-orchestrate.ts", commands: ["next"], summary: "resolve the next Core-owned vNext action" },
  { noun: "orient", tool: "aidlc-vnext-orient.ts", commands: ["prepare", "complete"], summary: "prepare and validate ST-01 Orient work" },
  { noun: "outcome", tool: "aidlc-vnext-outcome.ts", commands: ["prepare", "evaluate", "decide", "reuse"], summary: "observe, evaluate, and complete terminal ST-09 Outcome work" },
  { noun: "plan", tool: "aidlc-vnext-plan.ts", commands: ["show", "revise"], summary: "inspect or revise the Core-owned Stage Execution Plan" },
  { noun: "requirements", tool: "aidlc-vnext-requirements.ts", commands: ["prepare", "complete"], summary: "prepare and validate ST-03 Requirements work" },
  { noun: "release", tool: "aidlc-vnext-release.ts", commands: ["prepare", "review", "authorize", "execute", "reuse"], summary: "plan, authorize, execute, or verify reuse of ST-08 Release results" },
  { noun: "review", tool: "aidlc-vnext-review.ts", commands: ["prepare", "approve", "feedback"], summary: "prepare and decide ST-07 Candidate review work" },
  { noun: "space", tool: "aidlc-space.ts", commands: ["create", "list", "switch"], summary: "create and select Spaces" },
  { noun: "state", tool: "aidlc-vnext-state.ts", commands: ["show", "resume", "check"], summary: "inspect the Core-owned vNext State" },
  { noun: "workspace", tool: "aidlc-workspace.ts", commands: ["init"], summary: "initialize an AI-DLC Workspace" },
];

const TOP_LEVEL: Readonly<Record<string, readonly [string, string]>> = {
  next: ["aidlc-vnext-orchestrate.ts", "next"],
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
    case "aidlc-vnext-architecture.ts": return import("./aidlc-vnext-architecture.ts");
    case "aidlc-vnext-build-contract.ts": return import("./aidlc-vnext-build-contract.ts");
    case "aidlc-vnext-build-converge.ts": return import("./aidlc-vnext-build-converge.ts");
    case "aidlc-vnext-doctor.ts": return import("./aidlc-vnext-doctor.ts");
    case "aidlc-vnext-define-intent.ts": return import("./aidlc-vnext-define-intent.ts");
    case "aidlc-core-route.ts": return import("./aidlc-core-route.ts");
    case "aidlc-intent.ts": return import("./aidlc-intent.ts");
    case "aidlc-vnext-orchestrate.ts": return import("./aidlc-vnext-orchestrate.ts");
    case "aidlc-vnext-orient.ts": return import("./aidlc-vnext-orient.ts");
    case "aidlc-vnext-outcome.ts": return import("./aidlc-vnext-outcome.ts");
    case "aidlc-vnext-plan.ts": return import("./aidlc-vnext-plan.ts");
    case "aidlc-vnext-requirements.ts": return import("./aidlc-vnext-requirements.ts");
    case "aidlc-vnext-release.ts": return import("./aidlc-vnext-release.ts");
    case "aidlc-vnext-review.ts": return import("./aidlc-vnext-review.ts");
    case "aidlc-space.ts": return import("./aidlc-space.ts");
    case "aidlc-vnext-state.ts": return import("./aidlc-vnext-state.ts");
    case "aidlc-workspace.ts": return import("./aidlc-workspace.ts");
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
