import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "bun:test";
import {
  AIDLC_REPOSITORY,
  DISTRIBUTION_PROJECT_ROOT,
  GITHUB_DISTRIBUTION_FORMAT,
  GITHUB_DISTRIBUTION_SCHEMA,
  PROJECT_INSTALLATION_FORMAT,
  PROJECT_INSTALLATION_SCHEMA,
  type InstallationManifest,
  type ManagedFile,
} from "../core/tools/aidlc-distribution-contract.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import { applyInstallation } from "../installer/aidlc-install-apply.ts";
import { inspectProjectPath } from "../installer/aidlc-install-fs.ts";
import { planInstallation } from "../installer/aidlc-install-plan.ts";
import type {
  DownloadedDistribution,
  PreviousInstallation,
  SourceFile,
} from "../installer/aidlc-install-types.ts";

function sha(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function source(path: string, content: string, executable = false): SourceFile {
  const bytes = Buffer.from(content);
  return { path, content: bytes, sha256: sha(bytes), executable };
}

function managed(path: string, content: string, executable = false): ManagedFile {
  return { path, sha256: sha(content), bytes: Buffer.byteLength(content), executable };
}

function write(project: string, path: string, content: string): void {
  const destination = resolve(project, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

test("installation applier commits a v0.6.0 migration without touching Workspace data", () => {
  const project = mkdtempSync(join(tmpdir(), "aidlc-apply-migration-"));
  try {
    write(project, "AGENTS.md", "legacy agents");
    write(project, ".aidlc/bin/aidlc", "legacy binary");
    write(project, ".aidlc/runtime/core/data.json", "legacy data");
    write(project, "aidlc/workspace-marker", "keep");
    const oldFiles = [
      managed("AGENTS.md", "legacy agents"),
      managed(".aidlc/bin/aidlc", "legacy binary", true),
      managed(".aidlc/runtime/core/data.json", "legacy data"),
    ];
    const oldManifest: InstallationManifest = {
      format: PROJECT_INSTALLATION_FORMAT,
      schema_version: PROJECT_INSTALLATION_SCHEMA,
      version: "0.6.0",
      harness: "codex",
      installed_at: "2026-08-15T00:00:00.000Z",
      distribution: {
        type: "github-release",
        repository: AIDLC_REPOSITORY,
        tag: "v0.6.0",
        target: "darwin-arm64",
      },
      files: oldFiles,
    };
    write(
      project,
      ".aidlc/installation.json",
      `${JSON.stringify(oldManifest, null, 2)}\n`,
    );
    const previous: PreviousInstallation = {
      manifest: oldManifest,
      path: ".aidlc/installation.json",
      legacyLayout: true,
    };
    const sources = [
      source("AGENTS.md", "current agents"),
      source(".codex/tools/aidlc", "current binary", true),
    ];
    const distribution: DownloadedDistribution = {
      manifest: {
        format: GITHUB_DISTRIBUTION_FORMAT,
        schema_version: GITHUB_DISTRIBUTION_SCHEMA,
        version: AIDLC_VERSION,
        repository: AIDLC_REPOSITORY,
        tag: `v${AIDLC_VERSION}`,
        project_root: DISTRIBUTION_PROJECT_ROOT,
        files: [],
        binaries: [],
      },
      binary: {
        target: "darwin-arm64",
        asset: "aidlc-darwin-arm64",
        sha256: sources[1]!.sha256,
        bytes: sources[1]!.content.byteLength,
        platform: "darwin",
        arch: "arm64",
      },
      files: sources,
    };
    const plan = planInstallation({
      sources,
      previous,
      inspect: (path) => inspectProjectPath(project, path),
    });
    assert.deepEqual(plan.conflicts, []);
    applyInstallation({
      projectDir: project,
      harness: "codex",
      distribution,
      previous,
      plan,
      installedAt: "2026-08-16T00:00:00.000Z",
    });

    assert.equal(readFileSync(resolve(project, "AGENTS.md"), "utf8"), "current agents");
    assert.equal(readFileSync(resolve(project, ".codex/tools/aidlc"), "utf8"), "current binary");
    assert.equal(existsSync(resolve(project, ".aidlc")), false);
    assert.equal(readFileSync(resolve(project, "aidlc/workspace-marker"), "utf8"), "keep");
    const installed = JSON.parse(
      readFileSync(resolve(project, ".codex/aidlc-installation.json"), "utf8"),
    ) as InstallationManifest;
    assert.equal(installed.version, AIDLC_VERSION);
    assert.deepEqual(installed.files.map(({ path }) => path), [
      ".codex/tools/aidlc",
      "AGENTS.md",
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
