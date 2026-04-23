// estimate-usage.test.mjs — Unit tests for estimate-usage.mjs.
// Covers: collectJsonlFiles, weightedCost.
// Uses Node built-in test runner. Zero deps.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { collectJsonlFiles, weightedCost } from "../../estimate-usage.mjs";

// ---------------------------------------------------------------------------
// collectJsonlFiles
// ---------------------------------------------------------------------------

describe("collectJsonlFiles", () => {
  const base = mkdtempSync(resolve(tmpdir(), "est-usage-test-"));

  it("collects .jsonl files recursively", () => {
    mkdirSync(resolve(base, "a", "b"), { recursive: true });
    writeFileSync(resolve(base, "a", "file1.jsonl"), "{}\n");
    writeFileSync(resolve(base, "a", "b", "file2.jsonl"), "{}\n");
    writeFileSync(resolve(base, "root.jsonl"), "{}\n");
    writeFileSync(resolve(base, "ignore.txt"), "text");

    const files = collectJsonlFiles(base);
    assert.equal(files.length, 3);
    assert.ok(files.some((f) => f.endsWith("root.jsonl")));
    assert.ok(files.some((f) => f.endsWith("file1.jsonl")));
    assert.ok(files.some((f) => f.endsWith("file2.jsonl")));
  });

  it("returns empty array for missing directory", () => {
    const files = collectJsonlFiles("/nonexistent/path/12345");
    assert.deepEqual(files, []);
  });

  it("returns empty array when no .jsonl files exist", () => {
    const emptyDir = mkdtempSync(resolve(tmpdir(), "est-empty-"));
    writeFileSync(resolve(emptyDir, "readme.txt"), "hello");
    const files = collectJsonlFiles(emptyDir);
    assert.deepEqual(files, []);
  });

  // Cleanup
  afterEach(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  });
});

// ---------------------------------------------------------------------------
// weightedCost
// ---------------------------------------------------------------------------

describe("weightedCost", () => {
  const weights = {
    input_tokens: 1.0,
    output_tokens: 5.0,
    cache_creation_input_tokens: 1.25,
    cache_read_input_tokens: 0.1,
  };

  it("computes zero for null/undefined usage", () => {
    assert.equal(weightedCost(null, weights), 0);
    assert.equal(weightedCost(undefined, weights), 0);
  });

  it("computes zero for empty usage object", () => {
    assert.equal(weightedCost({}, weights), 0);
  });

  it("applies correct weights to each token type", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 200,
    };
    const expected = 100 * 1.0 + 20 * 5.0 + 40 * 1.25 + 200 * 0.1;
    assert.equal(weightedCost(usage, weights), expected);
  });

  it("tolerates missing individual fields", () => {
    const usage = { input_tokens: 50 };
    assert.equal(weightedCost(usage, weights), 50);
  });

  it("handles non-object input gracefully", () => {
    assert.equal(weightedCost("string", weights), 0);
    assert.equal(weightedCost(123, weights), 0);
  });
});
