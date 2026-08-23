import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "bun:test";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import {
  checkTrackedProjectDistribution,
  GITHUB_BINARY_TARGETS,
  type GithubDistributionManifest,
} from "../scripts/package-github-release.ts";

const ROOT = resolve(import.meta.dir, "..");
const RELEASE_DIR = resolve(ROOT, "build/github-release");
const PROJECT_DIST = resolve(ROOT, "dist/project");
const INSTALLER = resolve(RELEASE_DIR, "install.mjs");
const NODE = Bun.which("node");

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string, env = process.env): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveResult({ status, stdout, stderr });
    });
  });
}

function readManifest(): GithubDistributionManifest {
  return JSON.parse(
    readFileSync(resolve(RELEASE_DIR, "aidlc-distribution.json"), "utf8"),
  ) as GithubDistributionManifest;
}

test("GitHub distribution installs without npm, Git, authentication, Bun, or Node at runtime", async () => {
  assert.notEqual(NODE, null, "Node.js is required to test the public installer");
  checkTrackedProjectDistribution();
  assert.equal(GITHUB_BINARY_TARGETS.length, 7);
  assert.equal(new Set(GITHUB_BINARY_TARGETS.map(({ asset }) => asset)).size, 7);

  const packaged = run(
    process.execPath,
    ["scripts/package-github-release.ts", "--native-only"],
    ROOT,
  );
  assert.equal(packaged.status, 0, `${packaged.stdout}\n${packaged.stderr}`);
  assert.equal(existsSync(INSTALLER), true);
  assert.equal(existsSync(resolve(RELEASE_DIR, "SHA256SUMS")), true);

  const manifest = readManifest();
  assert.equal(manifest.format, "aidlc-github-distribution");
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.version, AIDLC_VERSION);
  assert.equal(manifest.repository, "sori883/aidlc");
  assert.equal(manifest.tag, `v${AIDLC_VERSION}`);
  assert.equal(manifest.binaries.length, 1);
  assert.equal(manifest.files.length >= 10, true);
  assert.equal(manifest.files.some(({ path }) => path.endsWith(".ts")), false);
  assert.equal(
    manifest.files.some(({ path, area }) =>
      path === ".codex/aidlc-common/data/vnext-stage-graph.json" && area === "core"),
    true,
  );
  assert.equal(
    manifest.files.some(({ path, area }) => path === "AGENTS.md" && area === "harness"),
    true,
  );
  assert.equal(
    manifest.files.some(({ path, area }) =>
      path === ".codex/hooks.json" && area === "harness"),
    true,
  );
  for (const file of manifest.files) {
    const content = readFileSync(resolve(PROJECT_DIST, file.path));
    assert.equal(content.byteLength, file.bytes, file.path);
  }
  const binary = manifest.binaries[0]!;
  const binaryPath = resolve(RELEASE_DIR, binary.asset);
  assert.equal(statSync(binaryPath).size, binary.bytes);
  assert.equal(binary.bytes > 10 * 1024 * 1024, true);
  const installerText = readFileSync(INSTALLER, "utf8");
  assert.doesNotMatch(installerText, /@aidlc\//);
  assert.doesNotMatch(installerText, /runtime-core.*base64|harness-codex.*base64/i);

  let rawRequests = 0;
  let binaryRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith("/raw/")) {
        rawRequests += 1;
        const path = decodeURIComponent(pathname.slice("/raw/".length));
        const source = resolve(PROJECT_DIST, path);
        if (!source.startsWith(`${PROJECT_DIST}/`) || !existsSync(source)) {
          return new Response("not found", { status: 404 });
        }
        return new Response(readFileSync(source));
      }
      if (pathname === "/release/aidlc-distribution.json" ||
          pathname === "/tampered/aidlc-distribution.json") {
        return new Response(readFileSync(resolve(RELEASE_DIR, "aidlc-distribution.json")), {
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname === `/release/${binary.asset}` || pathname === `/tampered/${binary.asset}`) {
        binaryRequests += 1;
        const content = Buffer.from(readFileSync(binaryPath));
        if (pathname.startsWith("/tampered/")) {
          const last = content.length - 1;
          content[last] = content[last]! ^ 0xff;
        }
        return new Response(content);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const base = new URL(server.url).origin;
  const installerEnv = {
    ...process.env,
    AIDLC_RELEASE_ROOT: `${base}/release`,
    AIDLC_RAW_PROJECT_ROOT: `${base}/raw`,
  };
  try {
    const project = mkdtempSync(join(tmpdir(), "aidlc-http-project-"));
    assert.equal(existsSync(resolve(project, ".git")), false);
    const installed = await runAsync(NODE!, [
      INSTALLER,
      "install",
      "--harness",
      "codex",
      "--project",
      project,
      "--json",
    ], ROOT, installerEnv);
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
    const result = JSON.parse(installed.stdout) as {
      version: string;
      executable: string;
      distribution_target: string;
      conflicts: string[];
    };
    assert.equal(result.version, AIDLC_VERSION);
    assert.equal(result.executable, ".codex/tools/aidlc");
    assert.equal(result.distribution_target, binary.target);
    assert.deepEqual(result.conflicts, []);
    assert.equal(rawRequests, manifest.files.length);
    assert.equal(binaryRequests, 1);

    const executable = resolve(
      project,
      ".codex/tools",
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    assert.equal(existsSync(resolve(project, "AGENTS.md")), true);
    assert.equal(existsSync(resolve(project, ".codex/hooks.json")), true);
    assert.equal(
      existsSync(resolve(project, ".codex/aidlc-common/data/vnext-stage-graph.json")),
      true,
    );
    const installedManifest = JSON.parse(
      readFileSync(resolve(project, ".codex/aidlc-installation.json"), "utf8"),
    ) as {
      schema_version: number;
      distribution: { type: string; repository: string; tag: string; target: string };
    };
    assert.equal(installedManifest.schema_version, 2);
    assert.deepEqual(installedManifest.distribution, {
      type: "github-release",
      repository: "sori883/aidlc",
      tag: `v${AIDLC_VERSION}`,
      target: binary.target,
    });

    const pathless = { ...process.env, PATH: "" };
    const version = run(executable, ["--version"], project, pathless);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), `aidlc ${AIDLC_VERSION}`);
    const graph = run(executable, ["graph", "validate"], project, pathless);
    assert.equal(graph.status, 0, `${graph.stdout}\n${graph.stderr}`);
    assert.equal((JSON.parse(graph.stdout) as { workflow: string }).workflow, "vnext");
    const workspace = run(executable, ["workspace", "init", "."], project, pathless);
    assert.equal(workspace.status, 0, `${workspace.stdout}\n${workspace.stderr}`);
    const intent = run(
      executable,
      ["intent", "birth", ".", "HTTP Installer"],
      project,
      pathless,
    );
    assert.equal(intent.status, 0, `${intent.stdout}\n${intent.stderr}`);
    const doctor = run(
      executable,
      ["doctor", "check", "."],
      project,
      pathless,
    );
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);

    const idempotent = await runAsync(NODE!, [
      INSTALLER,
      "update",
      "--project",
      project,
      "--json",
    ], ROOT, installerEnv);
    assert.equal(idempotent.status, 0, idempotent.stderr);
    const idempotentResult = JSON.parse(idempotent.stdout) as {
      written: string[];
      conflicts: string[];
    };
    assert.deepEqual(idempotentResult.written, []);
    assert.deepEqual(idempotentResult.conflicts, []);

    const manifestPath = resolve(project, ".codex/aidlc-installation.json");
    const manifestBefore = readFileSync(manifestPath);
    writeFileSync(resolve(project, "AGENTS.md"), "user-owned AGENTS\n", "utf8");
    const conflicted = await runAsync(NODE!, [
      INSTALLER,
      "update",
      "--project",
      project,
      "--json",
    ], ROOT, installerEnv);
    assert.equal(conflicted.status, 1, conflicted.stderr);
    const conflictResult = JSON.parse(conflicted.stdout) as { conflicts: string[] };
    assert.deepEqual(conflictResult.conflicts, ["AGENTS.md"]);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
    assert.equal(readFileSync(resolve(project, "AGENTS.md"), "utf8"), "user-owned AGENTS\n");

    const dryRunProject = mkdtempSync(join(tmpdir(), "aidlc-http-dry-run-"));
    const dryRun = await runAsync(NODE!, [
      INSTALLER,
      "install",
      "--project",
      dryRunProject,
      "--dry-run",
      "--json",
    ], ROOT, installerEnv);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal((JSON.parse(dryRun.stdout) as { dry_run: boolean }).dry_run, true);
    assert.equal(existsSync(resolve(dryRunProject, ".codex")), false);

    const tamperedProject = mkdtempSync(join(tmpdir(), "aidlc-http-tampered-"));
    const tampered = await runAsync(NODE!, [
      INSTALLER,
      "install",
      "--project",
      tamperedProject,
      "--json",
    ], ROOT, {
      ...installerEnv,
      AIDLC_RELEASE_ROOT: `${base}/tampered`,
    });
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /SHA-256 mismatch/);
    assert.equal(existsSync(resolve(tamperedProject, ".codex")), false);

    const unavailableProject = mkdtempSync(join(tmpdir(), "aidlc-http-unavailable-"));
    const unavailable = await runAsync(NODE!, [
      INSTALLER,
      "install",
      "--project",
      unavailableProject,
    ], ROOT, {
      ...installerEnv,
      AIDLC_RELEASE_ROOT: `${base}/missing`,
    });
    assert.equal(unavailable.status, 1);
    assert.match(unavailable.stderr, /Download failed \(404\)/);
    assert.equal(existsSync(resolve(unavailableProject, ".codex")), false);
  } finally {
    server.stop(true);
  }

  const checksums = readFileSync(resolve(RELEASE_DIR, "SHA256SUMS"), "utf8");
  for (const asset of ["install.mjs", "aidlc-distribution.json", basename(binaryPath)]) {
    assert.match(checksums, new RegExp(`^[a-f0-9]{64}  ${asset}$`, "m"));
  }
}, 120_000);
