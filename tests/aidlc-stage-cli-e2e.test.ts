import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeCodexBundle } from "../core/tools/aidlc-codex-bundle.ts";
import type { Directive, RunStageDirective } from "../core/tools/aidlc-directive.ts";

const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function freshProject(): string {
  return join(mkdtempSync(join(tmpdir(), "aidlc-stage-cli-e2e-")), "project");
}

function run(
  cwd: string,
  command: string,
  args: string[],
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

function instructionCommand(source: string, expected: string): string {
  const normalize = (command: string): string =>
    command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const commands = [
    ...[...source.matchAll(/(?<!`)`(pnpm --dir \.codex run [\s\S]*?)`(?!`)/g)]
      .map((match) => normalize(match[1]!)),
    ...[...source.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)]
      .map((match) => normalize(match[1]!))
      .filter((command) => command.startsWith("pnpm --dir .codex run ")),
  ];
  assert.ok(
    commands.includes(expected),
    `Generated Stage does not contain ${expected}`,
  );
  return commands.find((command) => command === expected)!;
}

function instructionStartingWith(source: string, prefix: string): string {
  const normalize = (command: string): string =>
    command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const commands = [
    ...[...source.matchAll(/(?<!`)`(pnpm --dir \.codex run [\s\S]*?)`(?!`)/g)]
      .map((match) => normalize(match[1]!)),
    ...[...source.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)]
      .map((match) => normalize(match[1]!))
      .filter((command) => command.startsWith("pnpm --dir .codex run ")),
  ];
  const command = commands.find((candidate) => candidate.startsWith(prefix));
  assert.ok(command, `Generated instructions do not contain prefix ${prefix}`);
  return command;
}

function runInstruction(projectDir: string, command: string): string {
  const [executable, ...args] = [...command.matchAll(
    /"([^"]*)"|'([^']*)'|[^\s]+/g,
  )].map((match) => match[1] ?? match[2] ?? match[0]);
  assert.equal(executable, "pnpm");
  return run(projectDir, PNPM, args).stdout;
}

function jsonOutput<T>(stdout: string): T {
  const start = stdout.indexOf("{");
  assert.notEqual(start, -1, stdout);
  return JSON.parse(stdout.slice(start)) as T;
}

function installBundle(projectDir: string): void {
  writeCodexBundle({ outDir: projectDir });
  run(projectDir, PNPM, [
    "--dir",
    ".codex",
    "install",
    "--frozen-lockfile",
    "--offline",
  ]);
}

function nextRunStage(projectDir: string, skill: string): RunStageDirective {
  const next = instructionCommand(
    skill,
    "pnpm --dir .codex run orchestrate next --project-dir ..",
  );
  let directive = jsonOutput<Directive>(runInstruction(projectDir, next));
  for (let part = 0; directive.kind === "load-steering" && part < 32; part += 1) {
    directive = jsonOutput<Directive>(runInstruction(
      projectDir,
      `${next} --continue-token ${directive.continue_token}`,
    ));
  }
  assert.equal(
    directive.kind,
    "run-stage",
    directive.kind === "error" ? directive.message : JSON.stringify(directive),
  );
  if (directive.kind !== "run-stage") throw new Error("Expected run-stage");
  return directive;
}

function materializeDirective(
  projectDir: string,
  directive: RunStageDirective,
): void {
  for (const output of directive.produces) {
    const path = resolve(projectDir, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# ${directive.stage}\n`, "utf8");
  }
  const stageDir = dirname(resolve(projectDir, directive.memory_path));
  for (const agent of directive.support_agents) {
    const contribution = join(stageDir, "contributions", `${agent}.md`);
    mkdirSync(dirname(contribution), { recursive: true });
    writeFileSync(
      contribution,
      `**Collaborator:** ${agent}\n\n## Contribution\n\nVerified.\n`,
      "utf8",
    );
  }
}

function confirmLearnings(
  projectDir: string,
  recordDir: string,
  skill: string,
  directive: RunStageDirective,
): void {
  const memory = instructionCommand(
    skill,
    'pnpm --dir .codex run memory init --project-dir .. --memory-path "<memory_path>"',
  ).replace('"<memory_path>"', `"${directive.memory_path}"`);
  runInstruction(projectDir, memory);
  const surface = instructionCommand(
    skill,
    "pnpm --dir .codex run learnings surface --project-dir .. --slug <stage> [--unit <unit>]",
  ).replace("<stage>", directive.stage).replace(" [--unit <unit>]", "");
  runInstruction(projectDir, surface);

  const selectionDir = join(recordDir, ".aidlc-learnings");
  mkdirSync(selectionDir, { recursive: true });
  const selectionPath = join(selectionDir, `${directive.stage}-selections.json`);
  writeFileSync(selectionPath, `${JSON.stringify({
    version: 1,
    stage: directive.stage,
    anything_to_add_answered: true,
    selections: [],
  }, null, 2)}\n`, "utf8");
  const persist = instructionCommand(
    skill,
    "pnpm --dir .codex run learnings persist --project-dir .. --slug <stage> --selections-json <path> [--unit <unit>]",
  )
    .replace("<stage>", directive.stage)
    .replace("<path>", `"${selectionPath}"`)
    .replace(" [--unit <unit>]", "");
  runInstruction(projectDir, persist);
}

function approveDirective(
  projectDir: string,
  skill: string,
  directive: RunStageDirective,
): void {
  const report = instructionCommand(
    skill,
    "pnpm --dir .codex run orchestrate report --project-dir .. --stage <stage> --result approved [--unit <unit>]",
  )
    .replace("<stage>", directive.stage)
    .replace(" [--unit <unit>]", "") + ' --user-input "Approve"';
  runInstruction(projectDir, report);
}

test(
  "executes real Codex runtime commands extracted from a generated Stage",
  { timeout: 30_000 },
  () => {
    const projectDir = freshProject();
    writeCodexBundle({ outDir: projectDir });
    run(projectDir, PNPM, [
      "--dir",
      ".codex",
      "install",
      "--frozen-lockfile",
      "--offline",
    ]);

    const stateInit = readFileSync(
      join(
        projectDir,
        ".codex",
        "aidlc-common",
        "stages",
        "initialization",
        "state-init.md",
      ),
      "utf8",
    );
    const scopeTable = runInstruction(
      projectDir,
      instructionCommand(
        stateInit,
        "pnpm --dir .codex run utility scope-table",
      ),
    );
    const stageTable = runInstruction(
      projectDir,
      instructionCommand(
        stateInit,
        "pnpm --dir .codex run utility stage-table",
      ),
    );

    assert.match(scopeTable, /\| mvp\s+\| Standard\s+\| \(default\)\s+\| 22 \/ 32/);
    assert.match(stageTable, /\| state-init \| 0\.3 \| State Initialization \|/);
    assert.doesNotMatch(scopeTable, /\bbun\b/);
    assert.doesNotMatch(stageTable, /\bbun\b/);
  },
);

test(
  "starts an MVP from generated Codex Skill commands and reaches run-stage",
  { timeout: 30_000 },
  () => {
    const projectDir = freshProject();
    writeCodexBundle({ outDir: projectDir });
    run(projectDir, PNPM, [
      "--dir",
      ".codex",
      "install",
      "--frozen-lockfile",
      "--offline",
    ]);
    const skill = readFileSync(
      join(projectDir, ".agents", "skills", "aidlc", "SKILL.md"),
      "utf8",
    );

    runInstruction(
      projectDir,
      instructionCommand(
        skill,
        "pnpm --dir .codex run workspace init ..",
      ),
    );
    const birthTemplate = instructionCommand(
      skill,
      'pnpm --dir .codex run intent birth .. "<label>" --scope <scope>',
    );
    const birth = jsonOutput<{
      auditPath: string;
      state: { scope: string; statePath: string };
    }>(
      runInstruction(
        projectDir,
        birthTemplate
          .replace('"<label>"', '"Payment API"')
          .replace("<scope>", "mvp"),
      ),
    );
    assert.equal(birth.state.scope, "mvp");

    const next = instructionCommand(
      skill,
      "pnpm --dir .codex run orchestrate next --project-dir ..",
    );
    let directive = jsonOutput<{
      kind: string;
      continue_token?: string;
      stage?: string;
      stage_file?: string;
    }>(runInstruction(projectDir, next));
    for (let part = 0; directive.kind === "load-steering" && part < 32; part += 1) {
      assert.ok(directive.continue_token);
      directive = jsonOutput(runInstruction(
        projectDir,
        `${next} --continue-token ${directive.continue_token}`,
      ));
    }

    assert.equal(directive.kind, "run-stage");
    assert.equal(directive.stage, "intent-capture");
    assert.ok(directive.stage_file);
    assert.equal(existsSync(directive.stage_file), true);
    assert.equal(existsSync(birth.state.statePath), true);
    assert.equal(existsSync(join(projectDir, "aidlc", "active-space")), true);
    const audit = readFileSync(birth.auditPath, "utf8");
    assert.match(audit, /\*\*Event\*\*: WORKFLOW_STARTED/);
    assert.match(audit, /\*\*Event\*\*: WORKSPACE_INITIALISED/);
    assert.match(audit, /\*\*Stage\*\*: intent-capture/);
  },
);

test(
  "runs practices discovery rejection, revision, promotion, and approval through packaged CLI",
  { timeout: 60_000 },
  () => {
    const projectDir = freshProject();
    installBundle(projectDir);
    const skill = readFileSync(
      join(projectDir, ".agents", "skills", "aidlc", "SKILL.md"),
      "utf8",
    );
    runInstruction(
      projectDir,
      instructionCommand(skill, "pnpm --dir .codex run workspace init .."),
    );
    const birth = jsonOutput<{
      auditPath: string;
      state: { recordDir: string; statePath: string; scope: string };
    }>(runInstruction(
      projectDir,
      instructionCommand(
        skill,
        'pnpm --dir .codex run intent birth .. "<label>" --scope <scope>',
      )
        .replace('"<label>"', '"Practices E2E"')
        .replace("<scope>", "mvp"),
    ));
    assert.equal(birth.state.scope, "mvp");

    let directive = nextRunStage(projectDir, skill);
    for (let completed = 0; directive.stage !== "practices-discovery"; completed += 1) {
      assert.ok(completed < 16, "practices-discovery was not reached");
      materializeDirective(projectDir, directive);
      confirmLearnings(projectDir, birth.state.recordDir, skill, directive);
      approveDirective(projectDir, skill, directive);
      directive = nextRunStage(projectDir, skill);
    }

    materializeDirective(projectDir, directive);
    const stageDir = dirname(resolve(projectDir, directive.memory_path));
    const teamPractices = join(stageDir, "team-practices.md");
    const discoveredRules = join(stageDir, "discovered-rules.md");
    writeFileSync(
      teamPractices,
      "# Team Practices\n\n## Way of Working\n\nUse short-lived branches.\n\n" +
        "## Walking Skeleton\n\nBuild one thin slice first.\n\n" +
        "## Testing Posture\n\nTest behavior at boundaries.\n\n" +
        "## Deployment\n\nPromote after checks pass.\n\n" +
        "## Code Style\n\nUse the repository formatter.\n",
      "utf8",
    );
    writeFileSync(
      discoveredRules,
      "# Discovered Rules\n\n## Mandated\n\nALWAYS run tests before merge\n\n" +
        "## Forbidden\n\nNEVER commit secrets\n",
      "utf8",
    );
    confirmLearnings(projectDir, birth.state.recordDir, skill, directive);

    const stage = readFileSync(directive.stage_file, "utf8");
    const discovered = instructionStartingWith(
      stage,
      "pnpm --dir .codex run state practices-event --project-dir ..",
    )
      .replace('"Sources Scanned: <list>"', '"Sources Scanned: package.json"');
    runInstruction(projectDir, discovered);

    const awaiting = instructionStartingWith(
      stage,
      "pnpm --dir .codex run orchestrate report --project-dir .. --stage practices-discovery --result awaiting-approval",
    );
    runInstruction(projectDir, awaiting);
    assert.equal(
      jsonOutput<{ checkboxState: string }>(runInstruction(
        projectDir,
        "pnpm --dir .codex run state resume ..",
      )).checkboxState,
      "awaiting-approval",
    );
    runInstruction(
      projectDir,
      awaiting.replace(
        "--result awaiting-approval",
        '--result rejected --user-input "Change branch lifetime"',
      ),
    );
    const rejectedState = jsonOutput<{
      checkboxState: string;
    }>(runInstruction(
      projectDir,
      "pnpm --dir .codex run state resume ..",
    ));
    assert.equal(rejectedState.checkboxState, "revising");
    assert.match(
      readFileSync(birth.state.statePath, "utf8"),
      /- \*\*Revision Count\*\*: 1/,
    );
    writeFileSync(
      teamPractices,
      readFileSync(teamPractices, "utf8").replace(
        "Use short-lived branches.",
        "Use branches that live for at most one day.",
      ),
      "utf8",
    );
    runInstruction(
      projectDir,
      awaiting.replace("--result awaiting-approval", "--result revised"),
    );
    assert.equal(
      jsonOutput<{ checkboxState: string }>(runInstruction(
        projectDir,
        "pnpm --dir .codex run state resume ..",
      )).checkboxState,
      "awaiting-approval",
    );

    const promote = instructionStartingWith(
      stage,
      "pnpm --dir .codex run state practices-promote --project-dir ..",
    )
      .replaceAll("<record>", birth.state.recordDir)
      .replace('"<user>"', '"E2E tester"');
    const promoted = jsonOutput<{
      emitted: string;
      teamPath: string;
      projectPath: string;
    }>(
      runInstruction(projectDir, promote),
    );
    assert.equal(promoted.emitted, "PRACTICES_AFFIRMED");
    assert.match(readFileSync(promoted.teamPath, "utf8"), /at most one day/);
    assert.match(
      readFileSync(promoted.projectPath, "utf8"),
      /ALWAYS run tests before merge \(affirmed \d{4}-\d{2}-\d{2}\)/,
    );

    const approved = instructionStartingWith(
      stage,
      "pnpm --dir .codex run orchestrate report --project-dir .. --stage practices-discovery --result approved",
    );
    runInstruction(projectDir, approved);

    for (const output of directive.produces) {
      assert.equal(existsSync(resolve(projectDir, output)), true, output);
    }
    for (const agent of directive.support_agents) {
      assert.equal(
        existsSync(join(stageDir, "contributions", `${agent}.md`)),
        true,
        agent,
      );
    }
    assert.equal(nextRunStage(projectDir, skill).stage, "requirements-analysis");

    const audit = readFileSync(birth.auditPath, "utf8");
    for (const event of [
      "PRACTICES_DISCOVERED",
      "STAGE_AWAITING_APPROVAL",
      "GATE_REJECTED",
      "STAGE_REVISING",
      "PRACTICES_AFFIRMED",
      "GATE_APPROVED",
      "STAGE_COMPLETED",
    ]) {
      assert.match(audit, new RegExp(`\\*\\*Event\\*\\*: ${event}`));
    }
    assert.ok(
      audit.indexOf("**Event**: PRACTICES_AFFIRMED") <
        audit.lastIndexOf("**Event**: GATE_APPROVED"),
    );
    assert.doesNotMatch(
      readFileSync(birth.state.statePath, "utf8"),
      /^- \[-\] 2\.2 Practices Discovery/m,
    );
  },
);

test(
  "recomposes a plan, persists Unit order, and resumes through packaged CLI",
  { timeout: 60_000 },
  () => {
    const bugfixProject = freshProject();
    installBundle(bugfixProject);
    const bugfixSkill = readFileSync(
      join(bugfixProject, ".agents", "skills", "aidlc", "SKILL.md"),
      "utf8",
    );
    runInstruction(
      bugfixProject,
      instructionCommand(
        bugfixSkill,
        "pnpm --dir .codex run workspace init ..",
      ),
    );
    const bugfixBirth = jsonOutput<{
      auditPath: string;
      state: { planPath: string; recordDir: string; statePath: string };
    }>(runInstruction(
      bugfixProject,
      instructionCommand(
        bugfixSkill,
        'pnpm --dir .codex run intent birth .. "<label>" --scope <scope>',
      )
        .replace('"<label>"', '"Recompose E2E"')
        .replace("<scope>", "bugfix"),
    ));
    const requirements = readFileSync(
      join(
        bugfixProject,
        ".codex",
        "aidlc-common",
        "stages",
        "inception",
        "requirements-analysis.md",
      ),
      "utf8",
    );
    const recomposed = jsonOutput<{ added: string[]; nextStage: string }>(
      runInstruction(
        bugfixProject,
        instructionStartingWith(
          requirements,
          "pnpm --dir .codex run utility recompose --project-dir .. --add user-stories",
        ) + " --json",
      ),
    );
    assert.deepEqual(recomposed.added, ["user-stories"]);
    assert.equal(recomposed.nextStage, "user-stories");
    const recomposedPlan = JSON.parse(
      readFileSync(bugfixBirth.state.planPath, "utf8"),
    ) as Array<{ slug: string; action: string }>;
    assert.equal(
      recomposedPlan.find((stage) => stage.slug === "user-stories")?.action,
      "EXECUTE",
    );
    assert.match(
      readFileSync(bugfixBirth.auditPath, "utf8"),
      /\*\*Event\*\*: RECOMPOSED/,
    );
    assert.equal(
      jsonOutput<{ currentStage: string; nextStage: string }>(runInstruction(
        bugfixProject,
        "pnpm --dir .codex run state resume ..",
      )).nextStage,
      "user-stories",
    );

    const requirementsDirective = nextRunStage(bugfixProject, bugfixSkill);
    assert.equal(requirementsDirective.stage, "requirements-analysis");
    materializeDirective(bugfixProject, requirementsDirective);
    confirmLearnings(
      bugfixProject,
      bugfixBirth.state.recordDir,
      bugfixSkill,
      requirementsDirective,
    );
    approveDirective(bugfixProject, bugfixSkill, requirementsDirective);
    const resumedBugfix = jsonOutput<{ currentStage: string; nextStage: string }>(
      runInstruction(
        bugfixProject,
        "pnpm --dir .codex run state resume ..",
      ),
    );
    assert.equal(resumedBugfix.currentStage, "user-stories");
    for (const output of requirementsDirective.produces) {
      assert.equal(existsSync(resolve(bugfixProject, output)), true, output);
    }
    assert.match(
      readFileSync(bugfixBirth.auditPath, "utf8"),
      /\*\*Event\*\*: STAGE_COMPLETED[\s\S]*?\*\*Stage\*\*: requirements-analysis/,
    );
    assert.equal(nextRunStage(bugfixProject, bugfixSkill).stage, "user-stories");

    const mvpProject = freshProject();
    installBundle(mvpProject);
    const mvpSkill = readFileSync(
      join(mvpProject, ".agents", "skills", "aidlc", "SKILL.md"),
      "utf8",
    );
    runInstruction(
      mvpProject,
      instructionCommand(mvpSkill, "pnpm --dir .codex run workspace init .."),
    );
    const mvpBirth = jsonOutput<{
      state: { statePath: string };
    }>(runInstruction(
      mvpProject,
      instructionCommand(
        mvpSkill,
        'pnpm --dir .codex run intent birth .. "<label>" --scope <scope>',
      )
        .replace('"<label>"', '"Unit Order E2E"')
        .replace("<scope>", "mvp"),
    ));
    const deliveryPlanning = readFileSync(
      join(
        mvpProject,
        ".codex",
        "aidlc-common",
        "stages",
        "inception",
        "delivery-planning.md",
      ),
      "utf8",
    );
    const iteration = jsonOutput<{
      updated: boolean;
      construction_iteration: string;
    }>(runInstruction(
      mvpProject,
      instructionStartingWith(
        deliveryPlanning,
        "pnpm --dir .codex run state set-construction-iteration --project-dir .. unit-major",
      ),
    ));
    assert.deepEqual(iteration, {
      updated: true,
      construction_iteration: "unit-major",
    });
    const resumedMvp = jsonOutput<{ currentStage: string }>(runInstruction(
      mvpProject,
      "pnpm --dir .codex run state resume ..",
    ));
    assert.equal(resumedMvp.currentStage, "intent-capture");
    assert.match(
      readFileSync(mvpBirth.state.statePath, "utf8"),
      /- \*\*Construction Iteration\*\*: unit-major/,
    );
  },
);
