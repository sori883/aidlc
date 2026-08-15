import assert from "node:assert/strict";
import { test } from "bun:test";
import { parseUnitDag } from "../core/tools/aidlc-unit-graph.ts";

const DAG = `# Unit dependencies

\`\`\`yaml
units:
  - name: api
    kind: service
    depends_on: [database]
  - name: monitoring
    depends_on: [database]
  - name: database
    kind: library
    depends_on: []
  - name: frontend
    kind: ui
    depends_on: [api]
\`\`\`
`;

test("parses Unit definitions and derives deterministic topological batches", () => {
  const dag = parseUnitDag(DAG, "fixture.md");
  assert.deepEqual(dag, {
    units: [
      { name: "api", kind: "service", depends_on: ["database"] },
      { name: "monitoring", depends_on: ["database"] },
      { name: "database", kind: "library", depends_on: [] },
      { name: "frontend", kind: "ui", depends_on: ["api"] },
    ],
    batches: [["database"], ["api", "monitoring"], ["frontend"]],
  });
});

test("returns null when no fenced units block exists", () => {
  assert.equal(parseUnitDag("# No unit graph\n", "fixture.md"), null);
  assert.equal(
    parseUnitDag("```yaml\nother: value\n```\n", "fixture.md"),
    null,
  );
});

test("rejects duplicate, dangling, self, cyclic, and malformed Unit definitions", () => {
  const invalid = [
    {
      source:
        "```yaml\nunits:\n  - {name: api, depends_on: []}\n  - {name: api, depends_on: []}\n```",
      pattern: /duplicate unit name/,
    },
    {
      source:
        "```yaml\nunits:\n  - {name: api, depends_on: [missing]}\n```",
      pattern: /unknown dependency/,
    },
    {
      source:
        "```yaml\nunits:\n  - {name: api, depends_on: [api]}\n```",
      pattern: /cannot depend on itself/,
    },
    {
      source:
        "```yaml\nunits:\n  - {name: api, depends_on: [database]}\n  - {name: database, depends_on: [api]}\n```",
      pattern: /cyclic/,
    },
    {
      source:
        "```yaml\nunits:\n  - {name: API, depends_on: []}\n```",
      pattern: /lowercase kebab-case/,
    },
    {
      source:
        "```yaml\nunits:\n  - {name: api, kind: batch, depends_on: []}\n```",
      pattern: /kind must be one of/,
    },
  ];
  for (const fixture of invalid) {
    assert.throws(
      () => parseUnitDag(fixture.source, "fixture.md"),
      fixture.pattern,
    );
  }
});
