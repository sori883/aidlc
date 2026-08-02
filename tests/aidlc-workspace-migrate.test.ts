import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activeIntent,
  readIntentRegistry,
} from "../core/tools/aidlc-intent.ts";
import {
  migrateFlatLayout,
  migratedMarkerPath,
  needsFlatMigration,
} from "../core/tools/aidlc-workspace-migrate.ts";

test("migrates the legacy flat workspace into a default-space intent", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-migrate-"));
  const legacyDir = join(projectDir, "aidlc-docs");
  mkdirSync(join(legacyDir, "knowledge"), { recursive: true });
  writeFileSync(
    join(legacyDir, "aidlc-state.md"),
    "# State\n- **Workflow**: Legacy Payment\n",
    "utf8",
  );
  writeFileSync(join(legacyDir, "artifact.md"), "legacy artifact\n", "utf8");
  writeFileSync(join(legacyDir, "audit.md"), "legacy audit\n", "utf8");
  writeFileSync(join(legacyDir, "knowledge", "domain.md"), "domain\n", "utf8");

  assert.equal(needsFlatMigration(projectDir), true);
  const result = migrateFlatLayout(projectDir);
  assert.ok(result);
  assert.equal(result.slug, "legacy-payment");
  assert.match(result.intentDirName, /^\d{6}-legacy-payment$/);
  assert.equal(result.sourceRemoved, false);
  assert.equal(existsSync(legacyDir), true);

  const recordDir = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "intents",
    result.intentDirName,
  );
  assert.equal(readFileSync(join(recordDir, "artifact.md"), "utf8"), "legacy artifact\n");
  assert.equal(existsSync(join(recordDir, "knowledge")), false);
  const auditFiles = readdirSync(join(recordDir, "audit"));
  assert.equal(auditFiles.length, 1);
  assert.equal(readFileSync(join(recordDir, "audit", auditFiles[0]!), "utf8"), "legacy audit\n");
  assert.equal(
    readFileSync(
      join(projectDir, "aidlc", "spaces", "default", "knowledge", "domain.md"),
      "utf8",
    ),
    "domain\n",
  );
  assert.equal(activeIntent(projectDir), result.intentDirName);
  assert.deepEqual(readIntentRegistry(projectDir), [
    {
      uuid: result.uuid,
      slug: "legacy-payment",
      dirName: result.intentDirName,
      status: "in-flight",
    },
  ]);
  assert.equal(existsSync(migratedMarkerPath(projectDir)), true);
  assert.equal(needsFlatMigration(projectDir), false);
  assert.equal(migrateFlatLayout(projectDir), null);
});

test("migration can remove the legacy source after committing the new record", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-migrate-"));
  const legacyDir = join(projectDir, "aidlc-docs");
  mkdirSync(legacyDir);
  writeFileSync(join(legacyDir, "aidlc-state.md"), "# State\n", "utf8");

  const result = migrateFlatLayout(projectDir, { removeSource: true });

  assert.ok(result);
  assert.equal(result.sourceRemoved, true);
  assert.equal(existsSync(legacyDir), false);
});

test("migration does not run without a legacy state file", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-migrate-"));
  assert.equal(needsFlatMigration(projectDir), false);
  assert.equal(migrateFlatLayout(projectDir), null);
});
