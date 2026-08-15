import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeCoreDir } from "./aidlc-runtime-paths.ts";

export interface CliCommandContract {
  flags: string[];
  results: string[];
}

export interface CliContract {
  tool: string;
  commands: Record<string, CliCommandContract>;
}

const DEFAULT_CONTRACTS_DIR = join(runtimeCoreDir(), "tools", "contracts");
const TOOL_PATTERN = /^aidlc-[a-z0-9-]+\.ts$/;
const TOKEN_PATTERN = /^--[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALUE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(path: string, detail: string): never {
  throw new Error(`${path}: ${detail}`);
}

function stringArray(
  value: unknown,
  path: string,
  pattern: RegExp,
): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value.map((item, index) => {
    if (typeof item !== "string" || !pattern.test(item)) {
      fail(`${path}[${index}]`, "has an invalid value");
    }
    return item;
  });
}

export function parseCliContract(value: unknown, path: string): CliContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must contain an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.tool !== "string" || !TOOL_PATTERN.test(record.tool)) {
    fail(`${path}.tool`, "must be an aidlc-*.ts filename");
  }
  if (
    typeof record.commands !== "object" || record.commands === null ||
    Array.isArray(record.commands)
  ) fail(`${path}.commands`, "must be an object");
  const commands: Record<string, CliCommandContract> = {};
  for (const [command, raw] of Object.entries(
    record.commands as Record<string, unknown>,
  )) {
    if (!VALUE_PATTERN.test(command)) {
      fail(`${path}.commands.${command}`, "has an invalid command name");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${path}.commands.${command}`, "must be an object");
    }
    const commandRecord = raw as Record<string, unknown>;
    const unknown = Object.keys(commandRecord).filter((key) =>
      key !== "flags" && key !== "results"
    );
    if (unknown.length > 0) {
      fail(`${path}.commands.${command}`, `unknown fields: ${unknown.join(", ")}`);
    }
    commands[command] = {
      flags: stringArray(
        commandRecord.flags ?? [],
        `${path}.commands.${command}.flags`,
        TOKEN_PATTERN,
      ),
      results: stringArray(
        commandRecord.results ?? [],
        `${path}.commands.${command}.results`,
        VALUE_PATTERN,
      ),
    };
  }
  return { tool: record.tool, commands };
}

/** Load every per-tool CLI definition without a central registration list. */
export function loadCliContracts(
  contractsDir = DEFAULT_CONTRACTS_DIR,
): Map<string, CliContract> {
  const directory = resolve(contractsDir);
  if (!existsSync(directory)) return new Map();
  const contracts = new Map<string, CliContract>();
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(path, `invalid JSON: ${detail}`);
    }
    const contract = parseCliContract(value, path);
    const expectedName = contract.tool.replace(/\.ts$/, ".json");
    if (entry.name !== expectedName) {
      fail(path, `filename must be ${expectedName}`);
    }
    if (contracts.has(contract.tool)) fail(path, `duplicate tool ${contract.tool}`);
    contracts.set(contract.tool, contract);
  }
  return contracts;
}

export function loadCliContract(
  tool: string,
  contractsDir = DEFAULT_CONTRACTS_DIR,
): CliContract {
  const contract = loadCliContracts(contractsDir).get(tool);
  if (contract === undefined) {
    throw new Error(`Missing CLI contract for ${tool}`);
  }
  return contract;
}

export function cliHasCommand(
  contract: CliContract,
  command: string | undefined,
): command is string {
  return command !== undefined && contract.commands[command] !== undefined;
}

export function cliAcceptsResult(
  contract: CliContract,
  command: string,
  result: string,
): boolean {
  return contract.commands[command]?.results.includes(result) ?? false;
}

export function cliUnknownFlags(
  contract: CliContract,
  command: string,
  args: readonly string[],
): string[] {
  const allowed = new Set(contract.commands[command]?.flags ?? []);
  return [...new Set(args.filter((arg) => arg.startsWith("--") && !allowed.has(arg)))];
}
