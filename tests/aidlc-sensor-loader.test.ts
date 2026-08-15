import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  loadSensors,
  resolveSensorsForStage,
  validateStageSensorReferences,
} from "../core/tools/aidlc-sensor-loader.ts";
import { loadStages } from "../core/tools/aidlc-stage-loader.ts";

const SENSOR_MARKDOWN = `---
id: sample
kind: deterministic
command: bun sample.ts
default_severity: advisory
description: Sample sensor
category: test
matches: "**/*.ts"
input_schema:
  file_path: string
output_schema:
  pass: boolean
timeout_seconds: 5
---

# Sample sensor

Checks a sample file.
`;

test("loads all real sensor definitions", () => {
  const sensors = loadSensors();
  assert.equal(sensors.length, 5);
  const typeCheck = sensors.find((sensor) => sensor.id === "type-check");
  assert.ok(typeCheck);
  assert.equal(typeCheck.matches, "**/*.{ts,tsx}");
  assert.equal(typeCheck.timeout_seconds, 60);
});

test("validates every stage sensor reference", () => {
  assert.doesNotThrow(() =>
    validateStageSensorReferences(loadStages(), loadSensors())
  );
});

test("resolves sensors in the order declared by the stage", () => {
  const stage = loadStages().find((entry) => entry.slug === "build-and-test");
  assert.ok(stage);
  assert.deepEqual(resolveSensorsForStage(stage, loadSensors()), [
    {
      id: "required-sections",
      path: ".codex/sensors/aidlc-required-sections.md",
      matches: "**/{aidlc-docs,intents}/**",
    },
    {
      id: "upstream-coverage",
      path: ".codex/sensors/aidlc-upstream-coverage.md",
      matches: "**/{aidlc-docs,intents}/**",
    },
    {
      id: "type-check",
      path: ".codex/sensors/aidlc-type-check.md",
      matches: "**/*.{ts,tsx}",
    },
  ]);
});

test("rejects an unknown sensor reference", () => {
  const stages = loadStages();
  const sensors = loadSensors().filter((sensor) => sensor.id !== "claim-sources");
  assert.throws(
    () => validateStageSensorReferences(stages, sensors),
    /unknown sensors\[0\] "claim-sources"/,
  );
});

test("ignores non-prefixed files and rejects a prefixed filename/id mismatch", () => {
  const sensorsDir = mkdtempSync(join(tmpdir(), "aidlc-sensors-"));
  writeFileSync(join(sensorsDir, "wrong-name.md"), SENSOR_MARKDOWN);
  assert.deepEqual(loadSensors(sensorsDir), []);
  writeFileSync(join(sensorsDir, "aidlc-other.md"), SENSOR_MARKDOWN);
  assert.throws(
    () => loadSensors(sensorsDir),
    /filename must be "aidlc-sample.md"/,
  );
});

test("tolerates additive manifest fields but reserves blocking severity", () => {
  const sensorsDir = mkdtempSync(join(tmpdir(), "aidlc-sensors-"));
  writeFileSync(
    join(sensorsDir, "aidlc-sample.md"),
    SENSOR_MARKDOWN.replace("category: test", "category: test\ncool_new_field: value"),
  );
  assert.equal(loadSensors(sensorsDir)[0]?.id, "sample");

  writeFileSync(
    join(sensorsDir, "aidlc-sample.md"),
    SENSOR_MARKDOWN.replace("default_severity: advisory", "default_severity: blocking"),
  );
  assert.throws(() => loadSensors(sensorsDir), /blocking is reserved/);
});
