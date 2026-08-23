#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadVNextDefinitions } from "./aidlc-core-route.ts";
import { verifyBootstrapReceiptAt } from "./aidlc-vnext-bootstrap.ts";
import {
  activeVNextIntentRecordDir,
  readVNextPlanAt,
  readVNextStateAt,
  validateVNextIntentAt,
  vNextStateSummaryPath,
  writeVNextStateAt,
} from "./aidlc-vnext-state.ts";

export type VNextDoctorSeverity = "error" | "warning" | "info";

export interface VNextDoctorFinding {
  severity: VNextDoctorSeverity;
  code: string;
  message: string;
  repairable: boolean;
}

export interface VNextDoctorReport {
  healthy: boolean;
  workflow: "vnext";
  findings: VNextDoctorFinding[];
}

function finding(
  severity: VNextDoctorSeverity,
  code: string,
  message: string,
  repairable = false,
): VNextDoctorFinding {
  return { severity, code, message, repairable };
}

export function checkVNextDoctor(projectDir: string): VNextDoctorReport {
  const projectRoot = resolve(projectDir);
  const findings: VNextDoctorFinding[] = [];
  let recordDir: string;
  try {
    const definitions = loadVNextDefinitions();
    findings.push(finding(
      "info",
      "VNEXT_DEFINITIONS_VALID",
      `Fixed Catalog ${definitions.catalog.catalog_version} and Graph ` +
        `${definitions.graph.graph_version} are valid.`,
    ));
  } catch (error) {
    findings.push(finding(
      "error",
      "VNEXT_DEFINITIONS_INVALID",
      error instanceof Error ? error.message : String(error),
    ));
  }
  try {
    recordDir = activeVNextIntentRecordDir(projectRoot);
  } catch (error) {
    findings.push(finding(
      "error",
      "VNEXT_ACTIVE_INTENT_INVALID",
      error instanceof Error ? error.message : String(error),
    ));
    return { healthy: false, workflow: "vnext", findings };
  }
  try {
    validateVNextIntentAt(projectRoot, recordDir);
    findings.push(finding(
      "info",
      "VNEXT_CORE_STATE_VALID",
      "Core State, Stage Execution Plan, and Effective Policy agree.",
    ));
  } catch (error) {
    findings.push(finding(
      "error",
      "VNEXT_CORE_STATE_INVALID",
      error instanceof Error ? error.message : String(error),
    ));
  }
  try {
    const state = readVNextStateAt(recordDir);
    if (state.current_stage !== "ST-00") {
      const verified = verifyBootstrapReceiptAt(projectRoot, recordDir);
      findings.push(finding(
        "info",
        "VNEXT_ST00_RECEIPT_VALID",
        `ST-00 Bootstrap Receipt ${verified.reference.sha256} is valid.`,
      ));
    }
  } catch (error) {
    findings.push(finding(
      "error",
      "VNEXT_ST00_RECEIPT_INVALID",
      error instanceof Error ? error.message : String(error),
    ));
  }
  const summaryPath = vNextStateSummaryPath(recordDir);
  try {
    const state = readVNextStateAt(recordDir);
    const summary = readFileSync(summaryPath, "utf8");
    if (!summary.includes(`- Current Stage: ${state.current_stage}`)) {
      findings.push(finding(
        "warning",
        "VNEXT_STATE_SUMMARY_STALE",
        "The human-readable State summary does not match Core State.",
        true,
      ));
    }
  } catch {
    findings.push(finding(
      "warning",
      "VNEXT_STATE_SUMMARY_MISSING",
      "The human-readable State summary is missing or unreadable.",
      true,
    ));
  }
  const auditDir = join(recordDir, "audit");
  const hasAudit = existsSync(auditDir) && statSync(auditDir).isDirectory() &&
    readdirSync(auditDir).some((name) => name.endsWith(".md"));
  if (!hasAudit) {
    findings.push(finding(
      "error",
      "VNEXT_AUDIT_MISSING",
      "The Core Audit log is missing.",
    ));
  }
  return {
    healthy: !findings.some((entry) => entry.severity === "error"),
    workflow: "vnext",
    findings,
  };
}

export function repairVNextDoctor(projectDir: string): VNextDoctorReport {
  const projectRoot = resolve(projectDir);
  const recordDir = activeVNextIntentRecordDir(projectRoot);
  const state = readVNextStateAt(recordDir);
  const plan = readVNextPlanAt(recordDir);
  writeVNextStateAt(recordDir, state, plan);
  return checkVNextDoctor(projectRoot);
}

export function main(argv: string[]): void {
  const [command, projectDir, ...rest] = argv;
  if (
    (command !== "check" && command !== "repair") || projectDir === undefined ||
    rest.length !== 0
  ) {
    console.error("Usage: aidlc doctor <check|repair> <project-dir>");
    process.exitCode = 1;
    return;
  }
  try {
    const report = command === "repair"
      ? repairVNextDoctor(projectDir)
      : checkVNextDoctor(projectDir);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.healthy) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
