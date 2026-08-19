import {
  validateHarnessDescriptor,
  type HarnessDescriptor,
} from "../../core/tools/aidlc-harness-contract.ts";

/** First supported Harness Adapter. Core behavior does not depend on this id. */
export const CODEX_HARNESS: HarnessDescriptor = validateHarnessDescriptor({
  id: "codex",
  displayName: "Codex",
  capabilities: {
    structuredQuestions: true,
    agentDelegation: true,
    parallelAgentDelegation: true,
    postWriteHook: true,
    reviewerScopeEnforcement: false,
    stopWaitNotification: true,
  },
  layout: {
    runtimeRoot: ".codex",
    executablePath: ".codex/tools/aidlc",
    projectInstructions: ["AGENTS.md"],
    skillRoot: ".agents/skills",
    agentRoot: ".codex/agents",
    hookConfigPath: ".codex/hooks.json",
    installationManifestPath: ".codex/aidlc-installation.json",
    projectLayoutManifestPath: ".codex/distribution-manifest.json",
  },
});
