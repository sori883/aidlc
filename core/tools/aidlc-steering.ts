// Runtime Rule delivery for M10. The compiled graph owns Rule selection; this
// module reads those exact paths from the active Space, drops empty templates,
// splits substantive text into bounded load-steering directives, and protects
// continuation with a machine-local HMAC token.

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  LoadSteeringDirective,
  RunStageDirective,
} from "./aidlc-directive.ts";
import {
  parseRuleFrontmatter,
  parseRuleHeadings,
} from "./aidlc-rule-loader.ts";
import { activeIntentRecordDir, stateFilePath } from "./aidlc-state.ts";
import { activeSpace } from "./aidlc-workspace.ts";
import { withWorkspaceLock } from "./aidlc-workspace-lock.ts";

export interface SteeringRuleContent {
  path: string;
  text: string;
}

export interface SteeringContext {
  stage: string;
  bundle: string;
  rules_content: SteeringRuleContent[];
}

interface SteeringBundle {
  digest: string;
  rules: SteeringRuleContent[];
  parts: SteeringRuleContent[][];
}

interface ContinuationPayload {
  version: 1;
  stage: string;
  bundle: string;
  state: string;
  route: string;
  next_part: number;
  parts: number;
}

export interface SteeringResolutionOptions {
  continueToken?: string;
  maxPartBytes?: number;
}

export const DEFAULT_MAX_STEERING_BYTES = 48 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function ruleIsSubstantive(source: string): boolean {
  return [...parseRuleHeadings(source).values()].some(
    (body) => body.trim() !== "",
  );
}

/** Read exactly the graph-resolved Rule paths from the active Space. */
export function loadSteeringRules(
  projectDir: string,
  declaredPaths: readonly string[],
): SteeringRuleContent[] {
  const projectRoot = resolve(projectDir);
  const memoryRoot = resolve(
    projectRoot,
    "aidlc",
    "spaces",
    activeSpace(projectRoot),
    "memory",
  );
  const seen = new Set<string>();
  const rules: SteeringRuleContent[] = [];

  for (const path of declaredPaths) {
    if (seen.has(path)) throw new Error(`Duplicate Rule path in graph: ${path}`);
    seen.add(path);
    const absolutePath = resolve(projectRoot, path);
    if (!isWithin(memoryRoot, absolutePath)) {
      throw new Error(
        `Rule path escapes active Space memory: ${path} (expected under ${memoryRoot})`,
      );
    }
    let text: string;
    try {
      text = readFileSync(absolutePath, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to load required Rule "${path}": ${detail}. ` +
          "Restore the active Space memory files before continuing.",
      );
    }
    // Parsing validates known frontmatter while deliberately tolerating
    // additive unknown keys, matching the Rule schema's forward compatibility.
    parseRuleFrontmatter(text, absolutePath);
    if (ruleIsSubstantive(text)) rules.push({ path, text });
  }
  return rules;
}

export function steeringBundleDigest(
  declaredPaths: readonly string[],
  rules: readonly SteeringRuleContent[],
): string {
  return `sha256:${sha256(JSON.stringify({ declaredPaths, rules }))}`;
}

function splitRule(
  rule: SteeringRuleContent,
  maxPartBytes: number,
): SteeringRuleContent[] {
  const allowance = maxPartBytes - Buffer.byteLength(rule.path, "utf8") - 64;
  if (allowance < 1) {
    throw new Error(
      `Rule path is too large for a steering part of ${maxPartBytes} bytes: ${rule.path}`,
    );
  }
  if (Buffer.byteLength(rule.text, "utf8") <= allowance) return [{ ...rule }];

  const fragments: SteeringRuleContent[] = [];
  let text = "";
  let bytes = 0;
  for (const character of rule.text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > allowance && text !== "") {
      fragments.push({ path: rule.path, text });
      text = "";
      bytes = 0;
    }
    text += character;
    bytes += characterBytes;
  }
  if (text !== "") fragments.push({ path: rule.path, text });
  return fragments;
}

function chunkRules(
  rules: readonly SteeringRuleContent[],
  maxPartBytes: number,
): SteeringRuleContent[][] {
  if (!Number.isInteger(maxPartBytes) || maxPartBytes < 256) {
    throw new Error("maxPartBytes must be an integer of at least 256 bytes");
  }
  const parts: SteeringRuleContent[][] = [];
  let part: SteeringRuleContent[] = [];
  let partBytes = 0;

  for (const rule of rules) {
    for (const fragment of splitRule(rule, maxPartBytes)) {
      const bytes = Buffer.byteLength(fragment.path, "utf8") +
        Buffer.byteLength(fragment.text, "utf8") + 64;
      if (part.length > 0 && partBytes + bytes > maxPartBytes) {
        parts.push(part);
        part = [];
        partBytes = 0;
      }
      part.push(fragment);
      partBytes += bytes;
    }
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

function buildBundle(
  projectDir: string,
  directive: RunStageDirective,
  maxPartBytes: number,
): SteeringBundle {
  const rules = loadSteeringRules(projectDir, directive.rules_in_context);
  return {
    digest: steeringBundleDigest(directive.rules_in_context, rules),
    rules,
    parts: chunkRules(rules, maxPartBytes),
  };
}

function secretPath(projectDir: string): string {
  return join(activeIntentRecordDir(projectDir), ".aidlc-steering", "secret");
}

function readOrCreateSecret(projectDir: string): Buffer {
  return withWorkspaceLock(projectDir, () => {
    const path = secretPath(projectDir);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    const value = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`Invalid steering secret at ${path}; remove it and retry.`);
    }
    return Buffer.from(value, "hex");
  });
}

function routeDigest(directive: RunStageDirective): string {
  return sha256(JSON.stringify({
    stage: directive.stage,
    phase: directive.phase,
    mode: directive.mode,
    unit: directive.unit ?? null,
    lead_agent: directive.lead_agent,
    support_agents: directive.support_agents,
    stage_file: directive.stage_file,
    consumes: directive.consumes,
    produces: directive.produces,
    rules_in_context: directive.rules_in_context,
  }));
}

function signPayload(payload: ContinuationPayload, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function readPayload(token: string, secret: Buffer): ContinuationPayload {
  const pieces = token.split(".");
  if (pieces.length !== 2 || pieces[0] === undefined || pieces[1] === undefined) {
    throw new Error("Invalid steering continuation token format.");
  }
  const expected = createHmac("sha256", secret)
    .update(pieces[0])
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(pieces[1], "base64url");
  } catch {
    throw new Error("Invalid steering continuation token signature.");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid steering continuation token signature.");
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid steering continuation token payload.");
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    typeof (value as Record<string, unknown>).stage !== "string" ||
    typeof (value as Record<string, unknown>).bundle !== "string" ||
    typeof (value as Record<string, unknown>).state !== "string" ||
    typeof (value as Record<string, unknown>).route !== "string" ||
    !Number.isInteger((value as Record<string, unknown>).next_part) ||
    !Number.isInteger((value as Record<string, unknown>).parts)
  ) throw new Error("Invalid steering continuation token payload.");
  return value as ContinuationPayload;
}

function assertContinuation(
  payload: ContinuationPayload,
  directive: RunStageDirective,
  bundle: SteeringBundle,
  stateDigest: string,
): void {
  if (
    payload.stage !== directive.stage ||
    payload.bundle !== bundle.digest ||
    payload.state !== stateDigest ||
    payload.route !== routeDigest(directive) ||
    payload.parts !== bundle.parts.length ||
    payload.next_part < 2 || payload.next_part > bundle.parts.length + 1
  ) {
    throw new Error(
      "Steering continuation token no longer matches the active Stage, State, route, or Rule bundle.",
    );
  }
}

/** Resolve the next Rule-loading beat, or release the run-stage Directive. */
export function resolveSteeringDirective(
  projectDir: string,
  directive: RunStageDirective,
  options: SteeringResolutionOptions = {},
): LoadSteeringDirective | RunStageDirective {
  const maxPartBytes = options.maxPartBytes ?? DEFAULT_MAX_STEERING_BYTES;
  const bundle = buildBundle(projectDir, directive, maxPartBytes);
  if (bundle.parts.length === 0) return directive;

  const secret = readOrCreateSecret(projectDir);
  const stateDigest = sha256(readFileSync(stateFilePath(projectDir), "utf8"));
  let part = 1;
  if (options.continueToken !== undefined) {
    const payload = readPayload(options.continueToken, secret);
    assertContinuation(payload, directive, bundle, stateDigest);
    part = payload.next_part;
  }
  if (part === bundle.parts.length + 1) return directive;

  const rulesContent = bundle.parts[part - 1];
  if (rulesContent === undefined) {
    throw new Error(`Internal: missing steering part ${part}.`);
  }
  const nextPayload: ContinuationPayload = {
    version: 1,
    stage: directive.stage,
    bundle: bundle.digest,
    state: stateDigest,
    route: routeDigest(directive),
    next_part: part + 1,
    parts: bundle.parts.length,
  };
  return {
    kind: "load-steering",
    stage: directive.stage,
    bundle: bundle.digest,
    part,
    parts: bundle.parts.length,
    rules_content: rulesContent.map((rule) => ({ ...rule })),
    continue_token: signPayload(nextPayload, secret),
  };
}

/** Reassemble all load-steering parts for the executor/Agent boundary. */
export function assembleSteeringContext(
  directive: RunStageDirective,
  loads: readonly LoadSteeringDirective[],
): SteeringContext {
  if (loads.length === 0) {
    return {
      stage: directive.stage,
      bundle: steeringBundleDigest(directive.rules_in_context, []),
      rules_content: [],
    };
  }
  const ordered = [...loads].sort((a, b) => a.part - b.part);
  const parts = ordered[0]?.parts;
  const bundle = ordered[0]?.bundle;
  if (parts === undefined || bundle === undefined || ordered.length !== parts) {
    throw new Error("Incomplete steering directive sequence.");
  }
  for (const [index, load] of ordered.entries()) {
    if (
      load.stage !== directive.stage || load.bundle !== bundle ||
      load.parts !== parts || load.part !== index + 1
    ) throw new Error("Inconsistent steering directive sequence.");
  }

  const rules: SteeringRuleContent[] = [];
  for (const fragment of ordered.flatMap((load) => load.rules_content)) {
    const previous = rules.at(-1);
    if (previous?.path === fragment.path) previous.text += fragment.text;
    else rules.push({ ...fragment });
  }
  const expected = steeringBundleDigest(directive.rules_in_context, rules);
  if (bundle !== expected) throw new Error("Steering bundle digest mismatch.");
  return { stage: directive.stage, bundle, rules_content: rules };
}

/** Validate the context supplied by the future harness runner. */
export function assertSteeringContext(
  directive: RunStageDirective,
  context: SteeringContext,
): void {
  if (context.stage !== directive.stage) {
    throw new Error(
      `Steering context is for "${context.stage}", expected "${directive.stage}".`,
    );
  }
  const expected = steeringBundleDigest(
    directive.rules_in_context,
    context.rules_content,
  );
  if (context.bundle !== expected) throw new Error("Steering context bundle mismatch.");

  let previousIndex = -1;
  for (const rule of context.rules_content) {
    const index = directive.rules_in_context.indexOf(rule.path);
    if (index < 0 || index <= previousIndex || rule.text === "") {
      throw new Error("Steering context Rule paths do not match rules_in_context order.");
    }
    previousIndex = index;
  }
}
