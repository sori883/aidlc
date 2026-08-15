import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_REPOSITORY,
  DISTRIBUTION_MANIFEST_ASSET,
  DISTRIBUTION_PROJECT_ROOT,
  encodedDistributionPath,
  nativeCliPath,
  validateGithubDistributionManifest,
  type DistributionBinaryRecord,
  type GithubDistributionManifest,
} from "../core/tools/aidlc-distribution-contract.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import type { DownloadedDistribution, SourceFile } from "./aidlc-install-types.ts";

const RELEASE_TAG = `v${AIDLC_VERSION}`;
const RELEASE_ROOT = (
  process.env.AIDLC_RELEASE_ROOT ??
  `https://github.com/${AIDLC_REPOSITORY}/releases/download/${RELEASE_TAG}`
).replace(/\/$/, "");
const RAW_PROJECT_ROOT = (
  process.env.AIDLC_RAW_PROJECT_ROOT ??
  `https://raw.githubusercontent.com/${AIDLC_REPOSITORY}/${RELEASE_TAG}/${DISTRIBUTION_PROJECT_ROOT}`
).replace(/\/$/, "");
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_CONCURRENCY = 12;

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fetchBytes(
  url: string,
  expected?: { sha256: string; bytes: number },
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": `aidlc-installer/${AIDLC_VERSION}` },
    });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (expected !== undefined) {
      if (content.byteLength !== expected.bytes) {
        throw new Error(
          `Downloaded size mismatch for ${url}: expected ${expected.bytes}, got ${content.byteLength}`,
        );
      }
      if (digest(content) !== expected.sha256) {
        throw new Error(`Downloaded SHA-256 mismatch for ${url}`);
      }
    }
    return content;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Download timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function distributionManifest(): Promise<GithubDistributionManifest> {
  const content = await fetchBytes(`${RELEASE_ROOT}/${DISTRIBUTION_MANIFEST_ASSET}`);
  try {
    return validateGithubDistributionManifest(
      JSON.parse(content.toString("utf8")),
      AIDLC_VERSION,
    );
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Distribution manifest is not valid JSON");
    throw error;
  }
}

function linuxLibc(): "glibc" | "musl" {
  const report = process.report?.getReport() as {
    header?: { glibcVersionRuntime?: string };
  } | undefined;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function selectBinary(manifest: GithubDistributionManifest): DistributionBinaryRecord {
  const platform = process.platform;
  const arch = process.arch;
  const libc = platform === "linux" ? linuxLibc() : undefined;
  const match = manifest.binaries.find((binary) =>
    binary.platform === platform &&
    binary.arch === arch &&
    (platform !== "linux" || binary.libc === libc));
  if (match === undefined) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}${libc === undefined ? "" : `-${libc}`}`,
    );
  }
  return match;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(values.length, 1)) }, worker),
  );
  return results;
}

function smokeNativeBinary(content: Buffer): void {
  const directory = mkdtempSync(join(tmpdir(), "aidlc-installer-smoke-"));
  const executable = join(directory, process.platform === "win32" ? "aidlc.exe" : "aidlc");
  try {
    writeFileSync(executable, content);
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const smoke = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: "" },
    });
    if (smoke.status !== 0 || smoke.stdout.trim() !== `aidlc ${AIDLC_VERSION}`) {
      throw new Error(
        `Downloaded native CLI failed verification (${String(smoke.status)}): ${smoke.stderr}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function downloadDistribution(): Promise<DownloadedDistribution> {
  const manifest = await distributionManifest();
  const binary = selectBinary(manifest);
  const binaryContentPromise = fetchBytes(
    `${RELEASE_ROOT}/${encodeURIComponent(binary.asset)}`,
    binary,
  );
  const projectFilesPromise = mapConcurrent(
    manifest.files,
    DOWNLOAD_CONCURRENCY,
    async (file): Promise<SourceFile> => ({
      path: file.path,
      content: await fetchBytes(
        `${RAW_PROJECT_ROOT}/${encodedDistributionPath(file.path)}`,
        file,
      ),
      sha256: file.sha256,
      executable: false,
    }),
  );
  const [binaryContent, projectFiles] = await Promise.all([
    binaryContentPromise,
    projectFilesPromise,
  ]);
  smokeNativeBinary(binaryContent);
  return {
    manifest,
    binary,
    files: [
      {
        path: nativeCliPath(process.platform),
        content: binaryContent,
        sha256: binary.sha256,
        executable: true,
      },
      ...projectFiles,
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
