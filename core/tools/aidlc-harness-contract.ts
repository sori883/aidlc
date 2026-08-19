// Harness-neutral execution and layout contract. Domain tools depend only on
// this module; concrete Harness descriptors live under harness/<id>/.

import type { Directive } from "./aidlc-directive.ts";

export interface HarnessCapabilities {
  structuredQuestions: boolean;
  agentDelegation: boolean;
  parallelAgentDelegation: boolean;
  postWriteHook: boolean;
  reviewerScopeEnforcement: boolean;
  stopWaitNotification: boolean;
}

export interface HarnessLayout {
  runtimeRoot: string;
  executablePath: string;
  projectInstructions: string[];
  skillRoot: string;
  agentRoot: string;
  hookConfigPath: string;
  installationManifestPath: string;
  projectLayoutManifestPath: string;
}

export interface HarnessDescriptor {
  id: string;
  displayName: string;
  capabilities: HarnessCapabilities;
  layout: HarnessLayout;
}

export type HarnessExecutionStrategy =
  | "direct"
  | "structured-question"
  | "text-question"
  | "delegated-agent"
  | "parallel-agents"
  | "sequential-agents"
  | "inline-sequential";

export interface ResolvedDirectiveExecution<T extends Directive = Directive> {
  directive: T;
  strategy: HarnessExecutionStrategy;
}

const CAPABILITY_KEYS = [
  "structuredQuestions",
  "agentDelegation",
  "parallelAgentDelegation",
  "postWriteHook",
  "reviewerScopeEnforcement",
  "stopWaitNotification",
] as const satisfies readonly (keyof HarnessCapabilities)[];

const LAYOUT_KEYS = [
  "runtimeRoot",
  "executablePath",
  "skillRoot",
  "agentRoot",
  "hookConfigPath",
  "installationManifestPath",
  "projectLayoutManifestPath",
] as const satisfies readonly Exclude<keyof HarnessLayout, "projectInstructions">[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeProjectPath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") &&
    !value.includes("\\") && !value.includes(":") &&
    !value.split("/").some((part) => part.length === 0 || part === ".." || part === ".");
}

/** Validate the stable cross-Harness contract at configuration boundaries. */
export function validateHarnessDescriptor(value: unknown): HarnessDescriptor {
  if (!isRecord(value)) throw new Error("Harness descriptor must be an object");
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.id)) {
    throw new Error("Harness descriptor id must be a lowercase slug");
  }
  if (typeof value.displayName !== "string" || value.displayName.trim() === "") {
    throw new Error("Harness descriptor displayName must be non-empty");
  }
  if (!isRecord(value.capabilities)) {
    throw new Error("Harness descriptor capabilities must be an object");
  }
  for (const key of CAPABILITY_KEYS) {
    if (typeof value.capabilities[key] !== "boolean") {
      throw new Error(`Harness capability ${key} must be boolean`);
    }
  }
  const capabilities = value.capabilities as unknown as HarnessCapabilities;
  if (capabilities.parallelAgentDelegation && !capabilities.agentDelegation) {
    throw new Error(
      "Harness capability parallelAgentDelegation requires agentDelegation",
    );
  }
  if (!isRecord(value.layout)) {
    throw new Error("Harness descriptor layout must be an object");
  }
  for (const key of LAYOUT_KEYS) {
    const path = value.layout[key];
    if (typeof path !== "string" || !isSafeProjectPath(path)) {
      throw new Error(`Harness layout ${key} must be a safe project-relative path`);
    }
  }
  const projectInstructions = value.layout.projectInstructions;
  if (
    !Array.isArray(projectInstructions) || projectInstructions.length === 0 ||
    projectInstructions.some((path) =>
      typeof path !== "string" || !isSafeProjectPath(path)
    )
  ) {
    throw new Error(
      "Harness layout projectInstructions must contain safe project-relative paths",
    );
  }
  const layout = value.layout as unknown as HarnessLayout;
  if (
    layout.executablePath !== `${layout.runtimeRoot}/tools/aidlc` &&
    layout.executablePath !== `${layout.runtimeRoot}/tools/aidlc.exe`
  ) {
    throw new Error("Harness layout executablePath must be under runtimeRoot/tools");
  }
  return value as unknown as HarnessDescriptor;
}

/** Resolve only registered, implemented Harnesses; never guess from an id. */
export function resolveHarnessDescriptor(
  id: string,
  available: readonly HarnessDescriptor[],
): HarnessDescriptor {
  const descriptor = available.find((candidate) => candidate.id === id);
  if (descriptor === undefined) throw new Error(`Unsupported Harness: ${id}`);
  return validateHarnessDescriptor(descriptor);
}

/**
 * Choose a Harness execution mechanism while preserving the original
 * Directive as the logical trace item.
 */
export function resolveDirectiveExecution<T extends Directive>(
  directive: T,
  capabilities: HarnessCapabilities,
): ResolvedDirectiveExecution<T> {
  if (directive.kind === "ask") {
    return {
      directive,
      strategy: capabilities.structuredQuestions
        ? "structured-question"
        : "text-question",
    };
  }
  if (directive.kind === "invoke-swarm") {
    const strategy = capabilities.parallelAgentDelegation
      ? "parallel-agents"
      : capabilities.agentDelegation ? "sequential-agents" : "inline-sequential";
    return { directive, strategy };
  }
  if (directive.kind === "dispatch-subagent") {
    return {
      directive,
      strategy: capabilities.agentDelegation ? "delegated-agent" : "inline-sequential",
    };
  }
  if (directive.kind === "run-stage" && directive.mode !== "inline") {
    const parallel = directive.mode === "mob" || directive.mode === "agent-team";
    const strategy = parallel && capabilities.parallelAgentDelegation
      ? "parallel-agents"
      : capabilities.agentDelegation ? "delegated-agent" : "inline-sequential";
    return { directive, strategy };
  }
  return { directive, strategy: "direct" };
}
