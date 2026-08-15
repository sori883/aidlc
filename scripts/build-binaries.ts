#!/usr/bin/env bun

// Release-oriented executable builder. The compiled entry is the Harness-
// neutral integrated CLI. Runtime and Harness files remain external.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DistributionPlatform,
  writeProjectLayout,
} from "../core/tools/aidlc-project-layout.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

export type BinaryTargetName =
  | "native"
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "linux-x64-baseline"
  | "windows-x64";

export type BinaryFormat = "mach-o" | "elf" | "pe";

export interface BinaryTargetConfig {
  name: BinaryTargetName;
  bunTarget?: string;
  format: BinaryFormat;
  executableName: "aidlc" | "aidlc.exe";
}

export interface BinaryBuildReport {
  target: BinaryTargetName;
  bun_target: string;
  version: string;
  executable: string;
  runtime: string;
  bytes: number;
  runtime_smoke: boolean;
  gates: Array<{ name: string; ok: boolean; detail: string }>;
}

export const BINARY_TARGETS: readonly BinaryTargetConfig[] = [
  { name: "native", format: nativeFormat(), executableName: process.platform === "win32" ? "aidlc.exe" : "aidlc" },
  { name: "darwin-x64", bunTarget: "bun-darwin-x64", format: "mach-o", executableName: "aidlc" },
  { name: "darwin-arm64", bunTarget: "bun-darwin-arm64", format: "mach-o", executableName: "aidlc" },
  { name: "linux-x64", bunTarget: "bun-linux-x64", format: "elf", executableName: "aidlc" },
  { name: "linux-arm64", bunTarget: "bun-linux-arm64", format: "elf", executableName: "aidlc" },
  { name: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", format: "elf", executableName: "aidlc" },
  { name: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", format: "elf", executableName: "aidlc" },
  { name: "linux-x64-baseline", bunTarget: "bun-linux-x64-baseline", format: "elf", executableName: "aidlc" },
  { name: "windows-x64", bunTarget: "bun-windows-x64", format: "pe", executableName: "aidlc.exe" },
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES_DIR = join(REPO_ROOT, "build", "binaries");

function nativeFormat(): BinaryFormat {
  if (process.platform === "darwin") return "mach-o";
  if (process.platform === "win32") return "pe";
  return "elf";
}

export function nativeTargetName(): Exclude<BinaryTargetName, "native"> {
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  throw new Error(`Unsupported native target: ${process.platform}-${process.arch}`);
}

export function getBinaryTarget(name: string): BinaryTargetConfig {
  const target = BINARY_TARGETS.find(
    (candidate) => candidate.name === name || candidate.bunTarget === name,
  );
  if (target === undefined) throw new Error(`Unknown binary target '${name}'`);
  return target;
}

function command(
  executable: string,
  args: string[],
  options: { cwd?: string; input?: string; pathless?: boolean; timeoutMs?: number } = {},
) {
  return spawnSync(executable, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    input: options.input,
    env: options.pathless ? { ...process.env, PATH: "" } : process.env,
    timeout: options.timeoutMs ?? 60_000,
  });
}

function gate(name: string, detail: string): BinaryBuildReport["gates"][number] {
  return { name, ok: true, detail };
}

function assertCommand(
  name: string,
  executable: string,
  args: string[],
  options: { cwd?: string; input?: string; pathless?: boolean; timeoutMs?: number } = {},
): { name: string; ok: true; detail: string; stdout: string } {
  const result = command(executable, args, options);
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${name} failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    name,
    ok: true,
    detail: `${executable} ${args.join(" ")}`,
    stdout: result.stdout,
  };
}

function distributionPlatform(target: BinaryTargetName): DistributionPlatform {
  if (target.startsWith("windows")) return "win32";
  if (target.startsWith("darwin")) return "darwin";
  if (target === "native") return process.platform as DistributionPlatform;
  return "linux";
}

export function inspectBinaryFormat(path: string): BinaryFormat | "unknown" {
  const bytes = readFileSync(path);
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes.subarray(1, 4).toString("ascii") === "ELF") {
    return "elf";
  }
  if (bytes.length >= 4) {
    const signature = bytes.subarray(0, 4).toString("hex");
    if (new Set(["cffaedfe", "feedfacf", "cafebabe", "bebafeca"]).has(signature)) {
      return "mach-o";
    }
  }
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 4 <= bytes.length && bytes.subarray(peOffset, peOffset + 4).toString("hex") === "50450000") {
      return "pe";
    }
  }
  return "unknown";
}

function smoke(executable: string): BinaryBuildReport["gates"] {
  const gates: BinaryBuildReport["gates"] = [];
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-binary-project-"));
  writeProjectLayout({ outDir: projectDir, platform: process.platform as DistributionPlatform });
  const installedExecutable = join(
    projectDir,
    ".aidlc",
    "bin",
    process.platform === "win32" ? "aidlc.exe" : "aidlc",
  );
  mkdirSync(dirname(installedExecutable), { recursive: true });
  cpSync(executable, installedExecutable);
  const pathless = { cwd: projectDir, pathless: true } as const;

  const version = assertCommand("version", installedExecutable, ["--version"], pathless);
  if (version.stdout.trim() !== `aidlc ${AIDLC_VERSION}`) {
    throw new Error(`version smoke returned ${version.stdout.trim()}`);
  }
  gates.push(version);

  const help = assertCommand("help", installedExecutable, ["help"], pathless);
  if (!help.stdout.includes("aidlc <noun> <command>")) {
    throw new Error("help smoke did not render integrated CLI usage");
  }
  gates.push(help);

  const graph = assertCommand("graph", installedExecutable, ["graph", "compile", "--check"], pathless);
  if (!graph.stdout.includes("32 stages")) throw new Error("graph smoke missed Stage count");
  gates.push(graph);

  const sensors = assertCommand("sensor", installedExecutable, ["sensor", "list"], pathless);
  const sensorList = JSON.parse(sensors.stdout) as unknown[];
  if (sensorList.length === 0) throw new Error("sensor smoke returned no Sensors");
  gates.push(sensors);

  gates.push(assertCommand(
    "workspace",
    installedExecutable,
    ["workspace", "init", projectDir],
    { cwd: projectDir, pathless: true },
  ));
  gates.push(assertCommand(
    "doctor",
    installedExecutable,
    ["doctor", "check", "--project-dir", projectDir],
    { cwd: projectDir, pathless: true },
  ));
  gates.push(assertCommand(
    "intent",
    installedExecutable,
    ["intent", "birth", projectDir, "Binary Smoke", "--scope", "poc"],
    { cwd: projectDir, pathless: true },
  ));
  const next = assertCommand(
    "orchestrate",
    installedExecutable,
    ["orchestrate", "next", "--project-dir", projectDir],
    { cwd: projectDir, pathless: true },
  );
  const directive = JSON.parse(next.stdout) as { kind?: string };
  if (directive.kind !== "load-steering") {
    throw new Error(`orchestrate smoke returned ${String(directive.kind)}`);
  }
  gates.push(next);

  const sensorOutput = join(projectDir, "aidlc-docs", "binary-sensor-smoke.md");
  mkdirSync(dirname(sensorOutput), { recursive: true });
  writeFileSync(sensorOutput, "# Binary Sensor Smoke\n", "utf8");
  const sensorFire = assertCommand(
    "sensor-fire",
    installedExecutable,
    [
      "sensor", "fire", "claim-sources", "--stage", "intent-capture",
      "--output-path", sensorOutput, "--project-dir", projectDir,
    ],
    { cwd: projectDir, pathless: true },
  );
  const fireResult = JSON.parse(sensorFire.stdout) as { outcome?: string };
  if (!new Set(["passed", "failed", "budget-override"]).has(fireResult.outcome ?? "")) {
    throw new Error(`sensor-fire smoke returned ${String(fireResult.outcome)}`);
  }
  gates.push(sensorFire);

  gates.push(assertCommand(
    "hook",
    installedExecutable,
    ["hook", "sensor-fire"],
    {
      cwd: projectDir,
      pathless: true,
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Update File: README.md\n*** End Patch" },
      }),
    },
  ));
  return gates;
}

function shouldRun(target: BinaryTargetName): boolean {
  return target === "native" || target === nativeTargetName();
}

export function buildBinary(targetName: BinaryTargetName): BinaryBuildReport {
  const target = getBinaryTarget(targetName);
  const outputDir = join(BINARIES_DIR, target.name);
  const executable = join(outputDir, target.executableName);

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const args = [
    "build",
    join(REPO_ROOT, "core", "tools", "aidlc.ts"),
    "--compile",
    "--outfile",
    executable,
  ];
  if (target.bunTarget !== undefined) args.push(`--target=${target.bunTarget}`);
  const build = assertCommand("build", process.execPath, args, { timeoutMs: 300_000 });
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`Bun did not emit ${executable}`);
  }

  const bytes = statSync(executable).size;
  if (bytes <= 10 * 1024 * 1024) throw new Error(`${target.name} executable is unexpectedly small`);
  const format = inspectBinaryFormat(executable);
  if (format !== target.format) {
    throw new Error(`${target.name} format is ${format}; expected ${target.format}`);
  }
  const layout = writeProjectLayout({
    outDir: join(outputDir, "project-layout"),
    platform: distributionPlatform(target.name),
  });
  const runtime = join(layout.outDir, ".aidlc", "runtime", "core");
  const requiredAsset = join(runtime, "aidlc-common", "data", "stage-graph.json");
  if (!existsSync(requiredAsset)) throw new Error(`Runtime asset is missing: ${requiredAsset}`);

  const runtimeSmoke = shouldRun(target.name);
  const gates: BinaryBuildReport["gates"] = [
    build,
    gate("artifact", executable),
    gate("size", `${bytes} bytes`),
    gate("format", format),
    gate("runtime", requiredAsset),
  ].map(({ name, ok, detail }) => ({ name, ok, detail }));
  if (runtimeSmoke) gates.push(...smoke(executable));

  const report: BinaryBuildReport = {
    target: target.name,
    bun_target: target.bunTarget ?? "native",
    version: AIDLC_VERSION,
    executable,
    runtime,
    bytes,
    runtime_smoke: runtimeSmoke,
    gates,
  };
  writeFileSync(
    join(outputDir, "build-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}

export function buildNativeBinary(): BinaryBuildReport {
  return buildBinary("native");
}

export function buildAllTargets(): BinaryBuildReport[] {
  return BINARY_TARGETS.map((target) => buildBinary(target.name));
}

function usage(): string {
  return "Usage: bun scripts/build-binaries.ts [--target <target> | --all-targets]";
}

export function main(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`${usage()}\n\nTargets: ${BINARY_TARGETS.map(({ name }) => name).join(", ")}`);
    return;
  }
  let reports: BinaryBuildReport[];
  if (argv.length === 0) reports = [buildNativeBinary()];
  else if (argv.length === 1 && argv[0] === "--all-targets") reports = buildAllTargets();
  else if (argv.length === 2 && argv[0] === "--target") {
    reports = [buildBinary(getBinaryTarget(argv[1] ?? "").name)];
  } else throw new Error(usage());

  for (const report of reports) {
    console.log(
      `Built ${report.target}: ${report.executable} ` +
      `(${report.bytes} bytes; ${report.gates.length} gates passed).`,
    );
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
