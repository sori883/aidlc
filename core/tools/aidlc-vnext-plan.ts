#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendAuditEntry } from "./aidlc-audit.ts";
import { reviseStageExecutionPlan } from "./aidlc-core-route.ts";
import {
  parseStageDispositionProposal,
  parseVNextStageContract,
  type StageDispositionProposal,
  type VNextStageContract,
} from "./aidlc-stage-contract.ts";
import {
  readVNextPlanAt,
  readVNextStateAt,
  resumeVNextIntent,
  writeVNextPlanAt,
  writeVNextStateAt,
} from "./aidlc-vnext-state.ts";

function readJson(path: string, context: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: cannot read ${path}: ${detail}`);
  }
}

function readProposals(path: string): StageDispositionProposal[] {
  const value = readJson(path, "Stage proposal file");
  if (!Array.isArray(value)) throw new Error("Stage proposal file: root must be an array");
  return value.map((entry, index) =>
    parseStageDispositionProposal(entry, `Stage proposal[${index}]`)
  );
}

function readContracts(directory: string | undefined): VNextStageContract[] {
  if (directory === undefined) return [];
  const root = resolve(directory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Stage Contract directory is not a directory: ${root}`);
  }
  return readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name, index) =>
      parseVNextStageContract(
        readJson(join(root, name), `Stage Contract ${name}`),
        `Stage Contract[${index}] ${name}`,
      )
    );
}

export function reviseActiveVNextPlan(
  projectDir: string,
  proposalPath: string,
  contractDir?: string,
) {
  const projectRoot = resolve(projectDir);
  const { recordDir } = resumeVNextIntent(projectRoot);
  const current = readVNextPlanAt(recordDir);
  const proposals = readProposals(proposalPath);
  const revised = reviseStageExecutionPlan(current, proposals, {
    projectDir: projectRoot,
    stageContracts: readContracts(contractDir),
  });
  const currentState = readVNextStateAt(recordDir);
  const revisedState = {
    ...currentState,
    plan_revision: revised.revision,
    updated_at: new Date().toISOString(),
  };
  writeVNextPlanAt(recordDir, revised);
  writeVNextStateAt(recordDir, revisedState, revised);
  appendAuditEntry(projectRoot, recordDir, "PLAN_REVISED", {
    "From Revision": String(current.revision),
    "To Revision": String(revised.revision),
    "Decision Authority": "core",
    "Proposal Count": String(proposals.length),
  });
  return revised;
}

export function main(argv: string[]): void {
  const [command, projectDir, proposalPath, ...rest] = argv;
  const contractsIndex = rest.indexOf("--contracts");
  const contractDir = contractsIndex === -1 ? undefined : rest[contractsIndex + 1];
  const validRest = rest.length === 0 ||
    (rest.length === 2 && contractsIndex === 0 && contractDir !== undefined);
  try {
    if (command === "show" && projectDir !== undefined && proposalPath === undefined) {
      process.stdout.write(`${JSON.stringify(resumeVNextIntent(projectDir).plan, null, 2)}\n`);
      return;
    }
    if (
      command === "revise" && projectDir !== undefined && proposalPath !== undefined &&
      validRest
    ) {
      process.stdout.write(
        `${JSON.stringify(reviseActiveVNextPlan(projectDir, proposalPath, contractDir), null, 2)}\n`,
      );
      return;
    }
    console.error(
      "Usage: aidlc plan show <project-dir>\n" +
        "       aidlc plan revise <project-dir> <proposals.json> [--contracts <dir>]",
    );
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
