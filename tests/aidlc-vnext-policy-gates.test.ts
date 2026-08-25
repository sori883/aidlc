import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, test } from "bun:test";
import {
  buildEffectivePolicySnapshot,
  parseHumanGatePolicySource,
  writeEffectivePolicySnapshot,
} from "../core/tools/aidlc-effective-policy.ts";
import {
  parseIntentRiskDecision,
  parseIntentRiskProposal,
} from "../core/tools/aidlc-vnext-risk-contract.ts";
import {
  decideIntentRiskAt,
  initializeIntentRiskRegisterAt,
  proposeIntentRisksAt,
  readCurrentIntentRiskRegisterAt,
} from "../core/tools/aidlc-vnext-risk.ts";
import {
  renderHumanGateReviewHtml,
  resolveHumanGateRequirementsAt,
  validatePolicyAcknowledgements,
} from "../core/tools/aidlc-vnext-policy-gates.ts";
import { initializeWorkspace } from "../core/tools/aidlc-workspace.ts";

const fixtures: string[] = [];

function fixture(): { projectDir: string; recordDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-vnext-policy-gates-"));
  fixtures.push(projectDir);
  initializeWorkspace(projectDir);
  const recordDir = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "intents",
    "intent-1",
  );
  return { projectDir, recordDir };
}

function policyPath(projectDir: string, layer: "org" | "team" | "project"): string {
  return join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "memory",
    `${layer}-policy.json`,
  );
}

function writePolicy(
  projectDir: string,
  layer: "org" | "team" | "project",
  rules: unknown[],
): void {
  writeFileSync(
    policyPath(projectDir, layer),
    `${JSON.stringify({
      schema_version: 1,
      artifact: "human-gate-policy-source",
      layer,
      rules,
    }, null, 2)}\n`,
  );
}

function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function evidence(projectDir: string, name: string) {
  const path = join(projectDir, name);
  writeFileSync(path, `${name}\n`);
  return {
    artifact: "risk-evidence",
    version: 1,
    source_of_truth: relative(projectDir, path),
    sha256: sha256(readFileSync(path)),
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("workspace seeds strict machine Policy beside Markdown Memory", () => {
  const { projectDir } = fixture();
  for (const layer of ["org", "team", "project"] as const) {
    const parsed = parseHumanGatePolicySource(
      JSON.parse(readFileSync(policyPath(projectDir, layer), "utf8")),
    );
    assert.equal(parsed.layer, layer);
    assert.deepEqual(parsed.rules, []);
  }
});

test("Effective Policy resolves Org, Team, and Project rules by additive union", () => {
  const { projectDir } = fixture();
  writePolicy(projectDir, "org", [{
    rule_id: "org-high-risk-release",
    minimum_severity: "high",
    stage_ids: ["ST-08"],
    acknowledgement: "Review the remaining high risk before Release.",
  }]);
  writePolicy(projectDir, "project", [{
    rule_id: "project-medium-candidate",
    minimum_severity: "medium",
    stage_ids: ["ST-07"],
    acknowledgement: "Review the project risk against the Candidate.",
  }]);

  const snapshot = buildEffectivePolicySnapshot(projectDir, "intent-1", {
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  assert.deepEqual(snapshot.source_priority, ["org", "team", "project"]);
  assert.deepEqual(
    snapshot.control_sources.map((source) => source.layer),
    ["org", "team", "project"],
  );
  assert.deepEqual(
    snapshot.human_gate_rules.map((rule) => rule.rule_id),
    ["org-high-risk-release", "project-medium-candidate"],
  );

  writePolicy(projectDir, "team", [{
    rule_id: "org-high-risk-release",
    minimum_severity: "critical",
    stage_ids: ["ST-08"],
    acknowledgement: "Attempt to replace the Org rule.",
  }]);
  assert.throws(
    () => buildEffectivePolicySnapshot(projectDir, "intent-1"),
    /duplicate rule_id: org-high-risk-release/,
  );
});

test("Policy source rejects profiles, routes, unknown Stages, and unknown fields", () => {
  const base = {
    schema_version: 1,
    artifact: "human-gate-policy-source",
    layer: "project",
    rules: [],
  };
  assert.throws(
    () => parseHumanGatePolicySource({ ...base, profile: "enterprise" }),
    /unknown field\(s\): profile/,
  );
  assert.throws(
    () => parseHumanGatePolicySource({
      ...base,
      rules: [{
        rule_id: "invent-route",
        minimum_severity: "high",
        stage_ids: ["ST-10"],
        acknowledgement: "Invent a Stage.",
      }],
    }),
    /stage_ids.*ST-04, ST-05, ST-07, ST-08, ST-09/,
  );
  assert.throws(
    () => parseHumanGatePolicySource({
      ...base,
      rules: [{
        rule_id: "route-choice",
        minimum_severity: "high",
        stage_ids: ["ST-08"],
        acknowledgement: "Choose another route.",
        next_stage: "ST-09",
      }],
    }),
    /unknown field\(s\): next_stage/,
  );
});

test("AI can add or increase an Intent risk but cannot reduce or resolve it", () => {
  const { projectDir, recordDir } = fixture();
  initializeIntentRiskRegisterAt(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  const proof = evidence(projectDir, "risk-proof.txt");
  const added = proposeIntentRisksAt(
    projectDir,
    recordDir,
    parseIntentRiskProposal({
      schema_version: 1,
      artifact: "intent-risk-proposal",
      version: 1,
      proposal_id: "risk-proposal-1",
      intent_id: "intent-1",
      base_revision: 1,
      risks: [{
        risk_id: "account-lockout",
        severity: "medium",
        statement: "A user could be locked out.",
        evidence_refs: [proof],
      }],
      reason: "The authentication path changes.",
      proposed_by: "ai",
      proposed_at: "2026-08-25T00:01:00.000Z",
    }),
    { createdAt: "2026-08-25T00:01:00.000Z" },
  );
  assert.equal(added.revision, 2);
  assert.equal(added.risks[0]?.severity, "medium");

  const increased = proposeIntentRisksAt(
    projectDir,
    recordDir,
    parseIntentRiskProposal({
      schema_version: 1,
      artifact: "intent-risk-proposal",
      version: 1,
      proposal_id: "risk-proposal-2",
      intent_id: "intent-1",
      base_revision: 2,
      risks: [{
        risk_id: "account-lockout",
        severity: "high",
        statement: "A user could be locked out.",
        evidence_refs: [proof],
      }],
      reason: "The impact includes every customer.",
      proposed_by: "ai",
      proposed_at: "2026-08-25T00:02:00.000Z",
    }),
  );
  assert.equal(increased.risks[0]?.severity, "high");

  assert.throws(
    () => proposeIntentRisksAt(
      projectDir,
      recordDir,
      parseIntentRiskProposal({
        schema_version: 1,
        artifact: "intent-risk-proposal",
        version: 1,
        proposal_id: "risk-proposal-3",
        intent_id: "intent-1",
        base_revision: 3,
        risks: [{
          risk_id: "account-lockout",
          severity: "low",
          statement: "A user could be locked out.",
          evidence_refs: [proof],
        }],
        reason: "AI attempts to reduce the Gate.",
        proposed_by: "ai",
        proposed_at: "2026-08-25T00:03:00.000Z",
      }),
    ),
    /cannot reduce severity/,
  );
});

test("only a human decision can dismiss, resolve, or reduce an Intent risk", () => {
  const { projectDir, recordDir } = fixture();
  initializeIntentRiskRegisterAt(projectDir, recordDir, "intent-1", {
    risks: [{
      risk_id: "account-lockout",
      severity: "high",
      statement: "A user could be locked out.",
      evidence_refs: [],
    }],
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  assert.throws(
    () => parseIntentRiskDecision({
      schema_version: 1,
      artifact: "intent-risk-decision",
      version: 1,
      decision_id: "risk-decision-1",
      intent_id: "intent-1",
      risk_id: "account-lockout",
      action: "dismiss",
      severity: null,
      evidence_refs: [],
      reason: "AI says it is not relevant.",
      decided_by: "ai",
      decided_at: "2026-08-25T00:01:00.000Z",
    }),
    /decided_by.*must equal human/,
  );

  const decided = decideIntentRiskAt(
    projectDir,
    recordDir,
    parseIntentRiskDecision({
      schema_version: 1,
      artifact: "intent-risk-decision",
      version: 1,
      decision_id: "risk-decision-2",
      intent_id: "intent-1",
      risk_id: "account-lockout",
      action: "set-severity",
      severity: "medium",
      evidence_refs: [],
      reason: "The affected path is limited by the accepted architecture.",
      decided_by: "human",
      decided_at: "2026-08-25T00:02:00.000Z",
    }),
  );
  assert.equal(decided.revision, 2);
  assert.equal(decided.risks[0]?.severity, "medium");
  assert.equal(decided.risks[0]?.status, "active");
  assert.equal(readCurrentIntentRiskRegisterAt(projectDir, recordDir).revision, 2);
});

test("Core resolves an exact Gate Requirement Set from pinned Policy and active risks", () => {
  const { projectDir, recordDir } = fixture();
  writePolicy(projectDir, "project", [{
    rule_id: "project-high-risk-release",
    minimum_severity: "high",
    stage_ids: ["ST-08"],
    acknowledgement: "Review residual high risk before Release.",
  }]);
  const policy = writeEffectivePolicySnapshot(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  initializeIntentRiskRegisterAt(projectDir, recordDir, "intent-1", {
    risks: [
      {
        risk_id: "account-lockout",
        severity: "high",
        statement: "A user could be locked out.",
        evidence_refs: [],
      },
      {
        risk_id: "copy-regression",
        severity: "low",
        statement: "A label could be unclear.",
        evidence_refs: [],
      },
    ],
    createdAt: "2026-08-25T00:00:00.000Z",
  });

  const gate = resolveHumanGateRequirementsAt(
    projectDir,
    recordDir,
    "ST-08",
    policy.reference,
    { createdAt: "2026-08-25T00:01:00.000Z" },
  );
  assert.equal(gate.requirements.length, 1);
  assert.equal(
    gate.requirements[0]?.requirement_id,
    "project-high-risk-release:account-lockout",
  );
  assert.equal(gate.risk_register_ref.artifact, "intent-risk-register");
  assert.match(renderHumanGateReviewHtml(gate, "<unsafe>"), /&lt;unsafe&gt;/);
  assert.doesNotMatch(renderHumanGateReviewHtml(gate, "<unsafe>"), /<unsafe>/);

  assert.throws(
    () => validatePolicyAcknowledgements(gate, []),
    /missing acknowledgement.*project-high-risk-release:account-lockout/,
  );
  assert.deepEqual(
    validatePolicyAcknowledgements(gate, [{
      requirement_id: "project-high-risk-release:account-lockout",
      acknowledged: true,
      reason: "The rollback and support response were reviewed.",
    }]),
    [{
      requirement_id: "project-high-risk-release:account-lockout",
      acknowledged: true,
      reason: "The rollback and support response were reviewed.",
    }],
  );
});

test("a Risk revision makes an older Gate Requirement Set stale", () => {
  const { projectDir, recordDir } = fixture();
  writePolicy(projectDir, "project", [{
    rule_id: "project-medium-candidate",
    minimum_severity: "medium",
    stage_ids: ["ST-07"],
    acknowledgement: "Review active risks against the Candidate.",
  }]);
  const policy = writeEffectivePolicySnapshot(projectDir, recordDir, "intent-1");
  initializeIntentRiskRegisterAt(projectDir, recordDir, "intent-1", {
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  const oldGate = resolveHumanGateRequirementsAt(
    projectDir,
    recordDir,
    "ST-07",
    policy.reference,
  );
  proposeIntentRisksAt(projectDir, recordDir, parseIntentRiskProposal({
    schema_version: 1,
    artifact: "intent-risk-proposal",
    version: 1,
    proposal_id: "risk-proposal-new",
    intent_id: "intent-1",
    base_revision: 1,
    risks: [{
      risk_id: "candidate-regression",
      severity: "medium",
      statement: "The integrated Candidate could regress login.",
      evidence_refs: [],
    }],
    reason: "Integration changed the login path.",
    proposed_by: "ai",
    proposed_at: "2026-08-25T00:02:00.000Z",
  }));

  assert.throws(
    () => validatePolicyAcknowledgements(oldGate, [], {
      projectDir,
      recordDir,
      requireCurrentRiskRegister: true,
    }),
    /Risk Register changed after the Gate Requirement Set was created/,
  );
});
