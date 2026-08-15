import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import {
  AIDLC_REPOSITORY,
  PROJECT_INSTALLATION_FORMAT,
  PROJECT_INSTALLATION_SCHEMA,
  type InstallationManifest,
  type ManagedFile,
} from "../core/tools/aidlc-distribution-contract.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import { planInstallation } from "../installer/aidlc-install-plan.ts";
import type {
  PreviousInstallation,
  ProjectPathState,
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

function previous(files: ManagedFile[], legacyLayout = false): PreviousInstallation {
  const manifest: InstallationManifest = {
    format: PROJECT_INSTALLATION_FORMAT,
    schema_version: PROJECT_INSTALLATION_SCHEMA,
    version: legacyLayout ? "0.6.0" : AIDLC_VERSION,
    harness: "codex",
    installed_at: "2026-08-16T00:00:00.000Z",
    distribution: {
      type: "github-release",
      repository: AIDLC_REPOSITORY,
      tag: legacyLayout ? "v0.6.0" : `v${AIDLC_VERSION}`,
      target: "darwin-arm64",
    },
    files,
  };
  return {
    manifest,
    path: legacyLayout ? ".aidlc/installation.json" : ".codex/aidlc-installation.json",
    legacyLayout,
  };
}

function inspector(states: ReadonlyMap<string, ProjectPathState>) {
  return (path: string): ProjectPathState => states.get(path) ?? { kind: "missing" };
}

test("installation planner handles fresh and idempotent installs without filesystem writes", () => {
  const sources = [
    source(".codex/tools/aidlc", "binary", true),
    source("AGENTS.md", "agents"),
  ];
  const fresh = planInstallation({ sources, previous: null, inspect: inspector(new Map()) });
  assert.deepEqual(fresh.written, [".codex/tools/aidlc", "AGENTS.md"]);
  assert.deepEqual(fresh.unchanged, []);
  assert.deepEqual(fresh.conflicts, []);
  assert.deepEqual(fresh.nextFiles.map(({ path }) => path), [".codex/tools/aidlc", "AGENTS.md"]);

  const states = new Map<string, ProjectPathState>(sources.map((item) => [
    item.path,
    { kind: "file", sha256: item.sha256 },
  ]));
  const idempotent = planInstallation({
    sources,
    previous: previous(fresh.nextFiles),
    inspect: inspector(states),
  });
  assert.deepEqual(idempotent.written, []);
  assert.deepEqual(idempotent.unchanged, [".codex/tools/aidlc", "AGENTS.md"]);
  assert.deepEqual(idempotent.conflicts, []);
});

test("installation planner updates owned files and rejects user-owned or unsafe paths", () => {
  const sources = [source("AGENTS.md", "next"), source(".codex/hooks.json", "next hooks")];
  const prior = previous([
    managed("AGENTS.md", "old"),
    managed(".codex/hooks.json", "old hooks"),
    managed(".codex/obsolete.json", "obsolete"),
  ]);
  const states = new Map<string, ProjectPathState>([
    ["AGENTS.md", { kind: "file", sha256: sha("old") }],
    [".codex/hooks.json", { kind: "file", sha256: sha("user change") }],
  ]);
  const plan = planInstallation({ sources, previous: prior, inspect: inspector(states) });
  assert.deepEqual(plan.written, ["AGENTS.md"]);
  assert.deepEqual(plan.conflicts, [".codex/hooks.json"]);
  assert.equal(plan.nextFiles.some(({ path }) => path === ".codex/obsolete.json"), true);

  const unsafe = planInstallation({
    sources: [source("AGENTS.md", "next")],
    previous: null,
    inspect: () => ({ kind: "unsafe" }),
  });
  assert.deepEqual(unsafe.conflicts, ["AGENTS.md"]);
});

test("installation planner retires only unchanged v0.6.0 managed files", () => {
  const sources = [source("AGENTS.md", "next"), source(".codex/tools/aidlc", "binary", true)];
  const prior = previous([
    managed("AGENTS.md", "old"),
    managed(".aidlc/bin/aidlc", "legacy binary", true),
    managed(".aidlc/runtime/core/data.json", "legacy data"),
    managed(".aidlc/runtime/core/missing.json", "missing"),
  ], true);
  const states = new Map<string, ProjectPathState>([
    ["AGENTS.md", { kind: "file", sha256: sha("old") }],
    [".aidlc/bin/aidlc", { kind: "file", sha256: sha("legacy binary") }],
    [".aidlc/runtime/core/data.json", { kind: "file", sha256: sha("user change") }],
  ]);
  const plan = planInstallation({ sources, previous: prior, inspect: inspector(states) });
  assert.deepEqual(plan.written, [".codex/tools/aidlc", "AGENTS.md"]);
  assert.deepEqual(plan.removed, [".aidlc/bin/aidlc"]);
  assert.deepEqual(plan.conflicts, [".aidlc/runtime/core/data.json"]);
  assert.equal(plan.nextFiles.some(({ path }) => path.startsWith(".aidlc/")), false);
});
