import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  LoadSteeringDirective,
  RunStageDirective,
} from "../core/tools/aidlc-directive.ts";
import { birthIntentWithState } from "../core/tools/aidlc-intent.ts";
import { resolveNextDirective } from "../core/tools/aidlc-orchestrate.ts";
import { createSpace, switchSpace } from "../core/tools/aidlc-space.ts";
import {
  assembleSteeringContext,
  assertSteeringContext,
} from "../core/tools/aidlc-steering.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

function freshProject(space = "default"): {
  projectDir: string;
  statePath: string;
} {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-steering-"));
  initializeWorkspace(projectDir);
  const born = birthIntentWithState(
    projectDir,
    "Payment API",
    space,
    "mvp",
  );
  return { projectDir, statePath: born.state.statePath };
}

function resolveAll(projectDir: string): {
  loads: LoadSteeringDirective[];
  directive: RunStageDirective;
} {
  const loads: LoadSteeringDirective[] = [];
  let directive = resolveNextDirective(projectDir);
  while (directive.kind === "load-steering") {
    loads.push(directive);
    directive = resolveNextDirective(projectDir, {
      continueToken: directive.continue_token,
    });
  }
  assert.equal(directive.kind, "run-stage");
  if (directive.kind !== "run-stage") {
    throw new Error("Expected run-stage Directive.");
  }
  return { loads, directive };
}

test("steering preserves graph order and drops empty Rule templates", () => {
  const { projectDir } = freshProject();
  const { loads, directive } = resolveAll(projectDir);
  const context = assembleSteeringContext(directive, loads);

  assert.deepEqual(
    directive.rules_in_context.map((path) => path.split("/").at(-1)),
    ["org.md", "team.md", "project.md", "ideation.md"],
  );
  assert.deepEqual(
    context.rules_content.map((rule) => rule.path.split("/").at(-1)),
    ["org.md", "ideation.md"],
  );
  assert.match(context.rules_content[0]?.text ?? "", /trunk-based development/);
  assert.match(context.rules_content[1]?.text ?? "", /Ideation Phase Guardrails/);
  assert.doesNotThrow(() => assertSteeringContext(directive, context));
});

test("steering continuation rejects tampering and changed State", () => {
  const tamperedProject = freshProject();
  const first = resolveNextDirective(tamperedProject.projectDir);
  assert.equal(first.kind, "load-steering");
  if (first.kind !== "load-steering") return;
  const final = first.continue_token.at(-1) === "a" ? "b" : "a";
  const tampered = resolveNextDirective(tamperedProject.projectDir, {
    continueToken: `${first.continue_token.slice(0, -1)}${final}`,
  });
  assert.equal(tampered.kind, "error");
  if (tampered.kind === "error") assert.match(tampered.message, /signature/);

  const changedProject = freshProject();
  const load = resolveNextDirective(changedProject.projectDir);
  assert.equal(load.kind, "load-steering");
  if (load.kind !== "load-steering") return;
  writeFileSync(
    changedProject.statePath,
    `${readFileSync(changedProject.statePath, "utf8")}\n`,
    "utf8",
  );
  const changed = resolveNextDirective(changedProject.projectDir, {
    continueToken: load.continue_token,
  });
  assert.equal(changed.kind, "error");
  if (changed.kind === "error") assert.match(changed.message, /no longer matches/);
});

test("large Rules are bounded, reassembled, and delivered without fallback", () => {
  const { projectDir } = freshProject();
  const teamPath = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "memory",
    "team.md",
  );
  const largeRule = `# Team Rules\n\n## Mandated\n\n${"- Preserve this team rule.\n".repeat(5_000)}`;
  writeFileSync(teamPath, largeRule, "utf8");

  const { loads, directive } = resolveAll(projectDir);
  assert.ok(loads.length >= 3);
  assert.ok(loads.every((load) => load.rules_content.length >= 1));
  const context = assembleSteeringContext(directive, loads);
  const team = context.rules_content.find((rule) => rule.path ===
    "aidlc/spaces/default/memory/team.md"
  );
  assert.equal(team?.text, largeRule);
  assert.doesNotThrow(() => assertSteeringContext(directive, context));
});

test("active Space Rule content is used after a Space switch", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-steering-space-"));
  initializeWorkspace(projectDir);
  const created = createSpace(projectDir, "Platform Team");
  const teamRule = "# Team Rules\n\n## Mandated\n\nUse the platform contract.\n";
  writeFileSync(join(created.spaceDir, "memory", "team.md"), teamRule, "utf8");
  switchSpace(projectDir, created.name);
  birthIntentWithState(projectDir, "Payment API", created.name, "mvp");

  const { loads, directive } = resolveAll(projectDir);
  const context = assembleSteeringContext(directive, loads);
  assert.ok(directive.rules_in_context.every((path) =>
    path.startsWith("aidlc/spaces/platform-team/memory/")
  ));
  assert.equal(
    context.rules_content.find((rule) => rule.path.endsWith("/team.md"))?.text,
    teamRule,
  );
  assert.ok(context.rules_content.some((rule) =>
    rule.path.endsWith("/phases/ideation.md")
  ));
});
