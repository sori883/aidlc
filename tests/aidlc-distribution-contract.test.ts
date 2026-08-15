import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  AIDLC_REPOSITORY,
  assertSafeDistributionPath,
  DISTRIBUTION_PROJECT_ROOT,
  distributionArea,
  GITHUB_DISTRIBUTION_FORMAT,
  GITHUB_DISTRIBUTION_SCHEMA,
  INSTALLATION_MANIFEST,
  isRuntimeDistributionPath,
  LEGACY_INSTALLATION_MANIFEST,
  nativeCliCommand,
  nativeCliPath,
  PROJECT_INSTALLATION_FORMAT,
  PROJECT_INSTALLATION_SCHEMA,
  validateGithubDistributionManifest,
  validateInstallationManifest,
  type GithubDistributionManifest,
  type InstallationManifest,
} from "../core/tools/aidlc-distribution-contract.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

const SHA = "a".repeat(64);

function distributionManifest(): GithubDistributionManifest {
  return {
    format: GITHUB_DISTRIBUTION_FORMAT,
    schema_version: GITHUB_DISTRIBUTION_SCHEMA,
    version: AIDLC_VERSION,
    repository: AIDLC_REPOSITORY,
    tag: `v${AIDLC_VERSION}`,
    project_root: DISTRIBUTION_PROJECT_ROOT,
    files: [{
      path: ".codex/aidlc-common/data/stage-graph.json",
      sha256: SHA,
      bytes: 10,
      executable: false,
      area: "core",
    }],
    binaries: [{
      target: "darwin-arm64",
      asset: "aidlc-darwin-arm64",
      sha256: SHA,
      bytes: 11 * 1024 * 1024,
      platform: "darwin",
      arch: "arm64",
    }],
  };
}

test("distribution contract owns native paths and Core/Harness classification", () => {
  assert.equal(nativeCliCommand(), "./.codex/tools/aidlc");
  assert.equal(nativeCliPath("darwin"), ".codex/tools/aidlc");
  assert.equal(nativeCliPath("win32"), ".codex/tools/aidlc.exe");
  assert.equal(INSTALLATION_MANIFEST, ".codex/aidlc-installation.json");
  assert.equal(LEGACY_INSTALLATION_MANIFEST, ".aidlc/installation.json");
  assert.equal(distributionArea(".codex/tools/contracts/aidlc-state.json"), "core");
  assert.equal(distributionArea(".codex/agents/aidlc-developer-agent.md"), "core");
  assert.equal(distributionArea(".codex/agents/aidlc-developer-agent.toml"), "harness");
  assert.equal(distributionArea(".codex/hooks.json"), "harness");
  assert.equal(distributionArea("AGENTS.md"), "harness");
  assert.equal(isRuntimeDistributionPath(".codex/agents/aidlc-developer-agent.toml"), true);
  assert.equal(isRuntimeDistributionPath(".codex/tools/aidlc.ts"), false);
  assert.equal(isRuntimeDistributionPath(".codex/hooks.json"), false);
});

test("distribution contract rejects unsafe paths and malformed Release manifests", () => {
  assert.equal(assertSafeDistributionPath(".codex/tools/contracts/a.json"), ".codex/tools/contracts/a.json");
  for (const path of ["", "../AGENTS.md", ".codex/../AGENTS.md", ".codex//hooks.json", "C:\\tmp\\x"]) {
    assert.throws(() => assertSafeDistributionPath(path), /Unsafe distribution path/);
  }

  const valid = distributionManifest();
  assert.deepEqual(validateGithubDistributionManifest(valid, AIDLC_VERSION), valid);
  assert.throws(
    () => validateGithubDistributionManifest({ ...valid, tag: "v9.9.9" }, AIDLC_VERSION),
    /identity is invalid/,
  );
  assert.throws(
    () => validateGithubDistributionManifest({
      ...valid,
      files: [...valid.files, valid.files[0]!],
    }, AIDLC_VERSION),
    /Invalid project file record/,
  );
});

test("distribution contract validates current and legacy Installation manifests", () => {
  const manifest: InstallationManifest = {
    format: PROJECT_INSTALLATION_FORMAT,
    schema_version: PROJECT_INSTALLATION_SCHEMA,
    version: AIDLC_VERSION,
    harness: "codex",
    installed_at: "2026-08-16T00:00:00.000Z",
    distribution: {
      type: "github-release",
      repository: AIDLC_REPOSITORY,
      tag: `v${AIDLC_VERSION}`,
      target: "darwin-arm64",
    },
    files: [{ path: "AGENTS.md", sha256: SHA, bytes: 10, executable: false }],
  };
  assert.deepEqual(validateInstallationManifest(manifest), manifest);
  assert.equal(validateInstallationManifest({ ...manifest, schema_version: 1 }).schema_version, 1);
  assert.throws(
    () => validateInstallationManifest({ ...manifest, files: [{ ...manifest.files[0], sha256: "bad" }] }),
    /Invalid managed file record/,
  );
});
