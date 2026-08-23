import {
  parseArtifactReference,
  VNEXT_STAGE_IDS,
  type ArtifactReference,
  type VNextStageId,
} from "./aidlc-stage-contract.ts";

export const VNEXT_DIRECTIVE_SCHEMA_VERSION = 1 as const;

export interface VNextParkedDirective {
  schema_version: typeof VNEXT_DIRECTIVE_SCHEMA_VERSION;
  kind: "parked";
  workflow: "vnext";
  stage: VNextStageId;
  reason: string;
  graph_version: string;
  plan_revision: number;
  decision_authority: "core";
}

export interface VNextDoneDirective {
  schema_version: typeof VNEXT_DIRECTIVE_SCHEMA_VERSION;
  kind: "done";
  workflow: "vnext";
  reason: string;
  graph_version: string;
  plan_revision: number;
  decision_authority: "core";
}

export interface VNextAdvancedDirective {
  schema_version: typeof VNEXT_DIRECTIVE_SCHEMA_VERSION;
  kind: "advanced";
  workflow: "vnext";
  completed_stage: VNextStageId;
  stage: VNextStageId;
  reason: string;
  evidence: ArtifactReference[];
  graph_version: string;
  plan_revision: number;
  decision_authority: "core";
}

export type VNextCoreDirective =
  | VNextParkedDirective
  | VNextAdvancedDirective
  | VNextDoneDirective;

const COMMON_KEYS = [
  "schema_version",
  "kind",
  "workflow",
  "reason",
  "graph_version",
  "plan_revision",
  "decision_authority",
] as const;

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function asOneLine(value: unknown, context: string): string {
  if (
    typeof value !== "string" || value.trim() === "" || value !== value.trim() ||
    /[\r\n\0]/.test(value)
  ) fail(context, "must be a non-empty single-line string");
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(context, `unknown field(s): ${unknown.join(", ")}`);
}

export function parseVNextCoreDirective(
  value: unknown,
  context = "vNext Core Directive",
): VNextCoreDirective {
  const record = asRecord(value, context);
  if (record.schema_version !== VNEXT_DIRECTIVE_SCHEMA_VERSION) {
    fail(`${context}.schema_version`, `must equal ${VNEXT_DIRECTIVE_SCHEMA_VERSION}`);
  }
  if (record.workflow !== "vnext") fail(`${context}.workflow`, "must equal vnext");
  if (record.decision_authority !== "core") {
    fail(`${context}.decision_authority`, "must equal core");
  }
  if (!Number.isSafeInteger(record.plan_revision) || (record.plan_revision as number) < 1) {
    fail(`${context}.plan_revision`, "must be a positive integer");
  }
  const common = {
    schema_version: VNEXT_DIRECTIVE_SCHEMA_VERSION,
    workflow: "vnext" as const,
    reason: asOneLine(record.reason, `${context}.reason`),
    graph_version: asOneLine(record.graph_version, `${context}.graph_version`),
    plan_revision: record.plan_revision as number,
    decision_authority: "core" as const,
  };
  if (record.kind === "done") {
    rejectUnknownKeys(record, COMMON_KEYS, context);
    return { ...common, kind: "done" };
  }
  if (record.kind === "advanced") {
    rejectUnknownKeys(
      record,
      [...COMMON_KEYS, "completed_stage", "stage", "evidence"],
      context,
    );
    const completedStage = asOneLine(
      record.completed_stage,
      `${context}.completed_stage`,
    );
    const stage = asOneLine(record.stage, `${context}.stage`);
    for (const [value, field] of [
      [completedStage, "completed_stage"],
      [stage, "stage"],
    ] as const) {
      if (!(VNEXT_STAGE_IDS as readonly string[]).includes(value)) {
        fail(`${context}.${field}`, `must be one of: ${VNEXT_STAGE_IDS.join(", ")}`);
      }
    }
    if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
      fail(`${context}.evidence`, "must contain at least one Artifact reference");
    }
    return {
      ...common,
      kind: "advanced",
      completed_stage: completedStage as VNextStageId,
      stage: stage as VNextStageId,
      evidence: record.evidence.map((entry, index) =>
        parseArtifactReference(entry, `${context}.evidence[${index}]`)
      ),
    };
  }
  if (record.kind !== "parked") {
    fail(`${context}.kind`, "must be parked, advanced, or done");
  }
  rejectUnknownKeys(record, [...COMMON_KEYS, "stage"], context);
  const stage = asOneLine(record.stage, `${context}.stage`);
  if (!(VNEXT_STAGE_IDS as readonly string[]).includes(stage)) {
    fail(`${context}.stage`, `must be one of: ${VNEXT_STAGE_IDS.join(", ")}`);
  }
  return { ...common, kind: "parked", stage: stage as VNextStageId };
}
