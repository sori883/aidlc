// Interaction-only audit helper. Approval gates are deliberately excluded:
// aidlc-orchestrate.ts owns their lifecycle events.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendAuditEntry } from "./aidlc-audit.ts";
import { activeIntentRecordDir } from "./aidlc-state.ts";
import {
  cliHasCommand,
  cliUnknownFlags,
  loadCliContract,
} from "./aidlc-cli-contract.ts";

const LOG_CLI_CONTRACT = loadCliContract("aidlc-log.ts");
const LOG_COMMANDS = ["decision", "answer"] as const;

export interface DecisionLogOptions {
  stage: string;
  decision: string;
  options?: string;
  rationale?: string;
}

export function logDecision(
  projectDir: string,
  options: DecisionLogOptions,
): void {
  const stage = options.stage.trim();
  const decision = options.decision.trim();
  if (!stage) throw new Error("--stage requires a nonblank Stage slug");
  if (!decision) throw new Error("--decision requires nonblank text");
  const projectRoot = resolve(projectDir);
  appendAuditEntry(
    projectRoot,
    activeIntentRecordDir(projectRoot),
    "DECISION_RECORDED",
    {
      Stage: stage,
      Decision: decision,
      ...(options.options?.trim() ? { Options: options.options.trim() } : {}),
      ...(options.rationale?.trim()
        ? { Rationale: options.rationale.trim() }
        : {}),
    },
  );
}

export function logAnswer(
  projectDir: string,
  stageInput: string,
  detailsInput: string,
): void {
  const stage = stageInput.trim();
  const details = detailsInput.trim();
  if (!stage) throw new Error("--stage requires a nonblank Stage slug");
  if (!details) throw new Error("--details requires nonblank text");
  const projectRoot = resolve(projectDir);
  appendAuditEntry(
    projectRoot,
    activeIntentRecordDir(projectRoot),
    "QUESTION_ANSWERED",
    { Stage: stage, Details: details },
  );
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function runCli(): void {
  const [command, ...args] = process.argv.slice(2);
  const projectDir = flagValue(args, "--project-dir") ?? process.cwd();
  if (!cliHasCommand(LOG_CLI_CONTRACT, command)) {
    console.error(
      "Usage: aidlc-log decision --stage <slug> --decision <text> " +
        "[--options <csv>] [--rationale <text>] [--project-dir <dir>]\n" +
        "       aidlc-log answer --stage <slug> --details <text> " +
        "[--project-dir <dir>]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const unknown = cliUnknownFlags(LOG_CLI_CONTRACT, command, args);
    if (unknown.length > 0) {
      throw new Error(`Unknown flag(s) for ${command}: ${unknown.join(", ")}`);
    }
    const stage = flagValue(args, "--stage") ?? "";
    if (command === "decision") {
      const options = flagValue(args, "--options");
      const rationale = flagValue(args, "--rationale");
      logDecision(projectDir, {
        stage,
        decision: flagValue(args, "--decision") ?? "",
        ...(options === undefined ? {} : { options }),
        ...(rationale === undefined ? {} : { rationale }),
      });
      console.log(JSON.stringify({ emitted: "DECISION_RECORDED", stage }));
      return;
    }
    logAnswer(projectDir, stage, flagValue(args, "--details") ?? "");
    console.log(JSON.stringify({ emitted: "QUESTION_ANSWERED", stage }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) runCli();
