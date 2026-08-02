// Frozen engine -> conductor contract. The orchestration engine emits exactly
// one Directive as JSON; the conductor dispatches only the action named by its
// `kind`. M6 emits run-stage, done, and error. The remaining upstream v2 kinds
// are defined now so M7 can add execution topologies without changing the wire
// contract.

export const GATE_UNRESOLVED = "unresolved" as const;
export type GateValue = boolean | typeof GATE_UNRESOLVED;

export type DirectiveKind =
  | "load-steering"
  | "run-stage"
  | "dispatch-subagent"
  | "invoke-swarm"
  | "present-gate"
  | "ask"
  | "print"
  | "error"
  | "done"
  | "parked";

export interface LoadSteeringDirective {
  kind: "load-steering";
  stage: string;
  bundle: string;
  part: number;
  parts: number;
  rules_content: Array<{ path: string; text: string }>;
  continue_token: string;
}

export interface RunStageDirective {
  kind: "run-stage";
  stage: string;
  phase: string;
  lead_agent: string;
  support_agents: string[];
  mode: "inline" | "subagent" | "pipeline" | "mob" | "agent-team";
  single?: boolean;
  inline_context_paths: string[];
  context_warnings?: string[];
  gate: GateValue;
  memory_path: string;
  consumes: string[];
  produces: string[];
  rules_in_context: string[];
  sensors_applicable: string[];
  stage_file: string;
  reviewer?: string;
  reviewer_max_iterations?: number;
  conductor_persona?: string;
  next_stage?: string | null;
  unit?: string;
  consumes_absent?: Array<{ path: string; expected: boolean }>;
}

export interface DispatchSubagentDirective
  extends Omit<RunStageDirective, "kind" | "single"> {
  kind: "dispatch-subagent";
  worker: string;
}

export interface InvokeSwarmDirective {
  kind: "invoke-swarm";
  units: string[];
  stage?: string;
  stage_file?: string;
  reviewer?: string;
  reviewer_max_iterations?: number;
  repo?: string;
}

export interface PresentGateDirective {
  kind: "present-gate";
  stage: string;
  phase: string;
  memory_path: string;
}

export interface AskDirective {
  kind: "ask";
  question: string;
}

export interface PrintDirective {
  kind: "print";
  message: string;
}

export interface ErrorDirective {
  kind: "error";
  message: string;
}

export interface DoneDirective {
  kind: "done";
  reason: string;
}

export interface ParkedDirective {
  kind: "parked";
  reason: string;
  stage: string;
}

export type Directive =
  | LoadSteeringDirective
  | RunStageDirective
  | DispatchSubagentDirective
  | InvokeSwarmDirective
  | PresentGateDirective
  | AskDirective
  | PrintDirective
  | ErrorDirective
  | DoneDirective
  | ParkedDirective;

export type DirectiveValidationResult =
  | { valid: true; data: Directive }
  | { valid: false; errors: string[] };

export const VALID_DIRECTIVE_KINDS = [
  "load-steering",
  "run-stage",
  "dispatch-subagent",
  "invoke-swarm",
  "present-gate",
  "ask",
  "print",
  "error",
  "done",
  "parked",
] as const satisfies readonly DirectiveKind[];

export const VALID_DIRECTIVE_MODES = [
  "inline",
  "subagent",
  "pipeline",
  "mob",
  "agent-team",
] as const;

const RUN_STAGE_FIELDS = [
  "kind", "stage", "phase", "lead_agent", "support_agents", "mode",
  "single", "inline_context_paths", "context_warnings", "gate",
  "memory_path", "consumes", "produces", "rules_in_context",
  "sensors_applicable", "stage_file", "reviewer", "reviewer_max_iterations",
  "conductor_persona", "next_stage", "unit", "consumes_absent",
] as const;

const KNOWN_FIELDS: Readonly<Record<DirectiveKind, readonly string[]>> = {
  "load-steering": [
    "kind", "stage", "bundle", "part", "parts", "rules_content",
    "continue_token",
  ],
  "run-stage": RUN_STAGE_FIELDS,
  "dispatch-subagent": [
    ...RUN_STAGE_FIELDS.filter((field) => field !== "single"),
    "worker",
  ],
  "invoke-swarm": [
    "kind", "units", "stage", "stage_file", "reviewer",
    "reviewer_max_iterations", "repo",
  ],
  "present-gate": ["kind", "stage", "phase", "memory_path"],
  ask: ["kind", "question"],
  print: ["kind", "message"],
  error: ["kind", "message"],
  done: ["kind", "reason"],
  parked: ["kind", "reason", "stage"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  kind: string,
  errors: string[],
): void {
  if (typeof value[field] !== "string" || value[field] === "") {
    errors.push(`${kind}: missing or non-string required field: ${field}`);
  }
}

function requirePositiveInteger(
  value: Record<string, unknown>,
  field: string,
  kind: string,
  errors: string[],
): void {
  const candidate = value[field];
  if (
    typeof candidate !== "number" || !Number.isInteger(candidate) ||
    candidate < 1
  ) errors.push(`${kind}: ${field} must be a positive integer`);
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
  kind: string,
  errors: string[],
): void {
  if (field in value && typeof value[field] !== "string") {
    errors.push(`${kind}: ${field} must be string when present`);
  }
}

function optionalPositiveInteger(
  value: Record<string, unknown>,
  field: string,
  kind: string,
  errors: string[],
): void {
  if (!(field in value)) return;
  requirePositiveInteger(value, field, kind, errors);
}

function requireStringArray(
  value: Record<string, unknown>,
  field: string,
  kind: string,
  errors: string[],
): void {
  const candidate = value[field];
  if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string")) {
    errors.push(`${kind}: missing or non-string-array required field: ${field}`);
  }
}

/** Runtime validation for the JSON boundary shared by engine and conductor. */
export function validateDirective(value: unknown): DirectiveValidationResult {
  if (!isRecord(value)) {
    const actual = value === null
      ? "null"
      : Array.isArray(value) ? "array" : typeof value;
    return { valid: false, errors: [`expected object, got ${actual}`] };
  }
  if (typeof value.kind !== "string") {
    return {
      valid: false,
      errors: ["missing or non-string required field: kind"],
    };
  }
  if (!(VALID_DIRECTIVE_KINDS as readonly string[]).includes(value.kind)) {
    return {
      valid: false,
      errors: [
        `unknown kind: "${value.kind}" (expected one of ${VALID_DIRECTIVE_KINDS.join(" | ")})`,
      ],
    };
  }

  const kind = value.kind as DirectiveKind;
  const errors: string[] = [];
  const allowed = new Set(KNOWN_FIELDS[kind]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${kind}: unknown key: ${key}`);
  }

  switch (kind) {
    case "load-steering":
      requireString(value, "stage", kind, errors);
      requireString(value, "bundle", kind, errors);
      requirePositiveInteger(value, "part", kind, errors);
      requirePositiveInteger(value, "parts", kind, errors);
      requireString(value, "continue_token", kind, errors);
      if (!Array.isArray(value.rules_content) || value.rules_content.some(
        (entry) => !isRecord(entry) || typeof entry.path !== "string" ||
          typeof entry.text !== "string",
      )) {
        errors.push(`${kind}: missing or invalid required field: rules_content`);
      }
      if (
        typeof value.part === "number" && typeof value.parts === "number" &&
        Number.isInteger(value.part) && Number.isInteger(value.parts) &&
        value.part > value.parts
      ) errors.push(`${kind}: part must be less than or equal to parts`);
      break;
    case "run-stage":
    case "dispatch-subagent": {
      for (const field of [
        "stage", "phase", "lead_agent", "memory_path", "stage_file",
      ]) requireString(value, field, kind, errors);
      for (const field of [
        "support_agents", "inline_context_paths", "consumes", "produces",
        "rules_in_context", "sensors_applicable",
      ]) requireStringArray(value, field, kind, errors);
      if (
        typeof value.mode !== "string" ||
        !(VALID_DIRECTIVE_MODES as readonly string[]).includes(value.mode)
      ) errors.push(`${kind}: invalid required field: mode`);
      if (typeof value.gate !== "boolean" && value.gate !== GATE_UNRESOLVED) {
        errors.push(`${kind}: invalid required field: gate`);
      }
      if (kind === "dispatch-subagent") {
        requireString(value, "worker", kind, errors);
      } else if (value.single !== undefined && typeof value.single !== "boolean") {
        errors.push(`${kind}: single must be boolean when present`);
      }
      if (value.context_warnings !== undefined) {
        requireStringArray(value, "context_warnings", kind, errors);
      }
      if (value.consumes_absent !== undefined && (
        !Array.isArray(value.consumes_absent) || value.consumes_absent.some(
          (entry) => !isRecord(entry) || typeof entry.path !== "string" ||
            typeof entry.expected !== "boolean",
        )
      )) errors.push(`${kind}: invalid optional field: consumes_absent`);
      optionalString(value, "reviewer", kind, errors);
      optionalPositiveInteger(
        value,
        "reviewer_max_iterations",
        kind,
        errors,
      );
      optionalString(value, "conductor_persona", kind, errors);
      optionalString(value, "unit", kind, errors);
      if (
        value.next_stage !== undefined && value.next_stage !== null &&
        typeof value.next_stage !== "string"
      ) errors.push(`${kind}: next_stage must be string or null when present`);
      break;
    }
    case "invoke-swarm":
      requireStringArray(value, "units", kind, errors);
      optionalString(value, "stage", kind, errors);
      optionalString(value, "stage_file", kind, errors);
      optionalString(value, "reviewer", kind, errors);
      optionalPositiveInteger(
        value,
        "reviewer_max_iterations",
        kind,
        errors,
      );
      optionalString(value, "repo", kind, errors);
      break;
    case "present-gate":
      requireString(value, "stage", kind, errors);
      requireString(value, "phase", kind, errors);
      requireString(value, "memory_path", kind, errors);
      break;
    case "ask":
      requireString(value, "question", kind, errors);
      break;
    case "print":
    case "error":
      requireString(value, "message", kind, errors);
      break;
    case "done":
      requireString(value, "reason", kind, errors);
      break;
    case "parked":
      requireString(value, "reason", kind, errors);
      requireString(value, "stage", kind, errors);
      break;
  }

  return errors.length === 0
    ? { valid: true, data: value as unknown as Directive }
    : { valid: false, errors };
}
