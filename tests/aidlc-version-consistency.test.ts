import assert from "node:assert/strict";
import { test } from "bun:test";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import {
  assertVersionedArtifacts,
  checkVersionConsistency,
} from "../scripts/check-version.ts";

test("release version sources and current Installer URLs stay synchronized", () => {
  assert.equal(checkVersionConsistency(), AIDLC_VERSION);
});

test("generated artifact version checks identify the drift source", () => {
  assert.doesNotThrow(() => assertVersionedArtifacts(AIDLC_VERSION, [
    { label: "manifest", version: AIDLC_VERSION },
    { label: "build report", version: AIDLC_VERSION },
  ]));
  assert.throws(
    () => assertVersionedArtifacts(AIDLC_VERSION, [
      { label: "manifest", version: "9.9.9" },
    ]),
    /manifest=9\.9\.9/,
  );
});
