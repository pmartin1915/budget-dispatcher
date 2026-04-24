// selector-fallback.test.mjs — Unit tests for deterministicFallback.
//
// The fallback fires when Gemini 2.5 Flash is genuinely unreachable
// (rate-limit, 5xx, empty response, auth error) after the 3-retry backoff
// exhausts. Without it, a Flash outage silently stops all three fleet
// machines and Perry wakes to nothing in the ntfy feed.
//
// These tests cover the pure function only. End-to-end verification that
// the fallback path is reached from selectProjectAndTask's catch block
// waits for the Phase C memfs + nock harness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deterministicFallback } from "../selector.mjs";

// Minimal context shape matching what buildProjectContext produces —
// only the fields the fallback actually reads.
function ctx(slug, opportunistic_tasks, last_dispatched = "never", extras = {}) {
  return {
    slug,
    opportunistic_tasks,
    last_dispatched,
    config: { slug, path: `/fake/${slug}`, ...extras.config },
    ...extras,
  };
}

describe("deterministicFallback", () => {
  it("returns null on empty contexts", () => {
    assert.equal(deterministicFallback([]), null);
  });

  it("returns null when every context has zero opportunistic_tasks", () => {
    const contexts = [ctx("a", []), ctx("b", [])];
    assert.equal(deterministicFallback(contexts), null);
  });

  it("prefers 'audit' when present in opportunistic_tasks", () => {
    const contexts = [ctx("alpha", ["refactor", "audit", "tests-gen"])];
    const fb = deterministicFallback(contexts);
    assert.equal(fb.project, "alpha");
    assert.equal(fb.task, "audit");
  });

  it("falls back to first task when 'audit' is absent", () => {
    const contexts = [ctx("beta", ["refactor-task", "tests-gen"])];
    const fb = deterministicFallback(contexts);
    assert.equal(fb.project, "beta");
    assert.equal(fb.task, "refactor-task");
  });

  it("picks the context with the oldest last_dispatched timestamp", () => {
    const contexts = [
      ctx("recent", ["audit"], "2026-04-24T20:00:00Z"),
      ctx("oldest", ["audit"], "2026-04-20T08:00:00Z"),
      ctx("middle", ["audit"], "2026-04-22T12:00:00Z"),
    ];
    const fb = deterministicFallback(contexts);
    assert.equal(fb.project, "oldest");
  });

  it("treats 'never' as oldest, beating any real timestamp", () => {
    const contexts = [
      ctx("has-run", ["audit"], "2026-04-20T08:00:00Z"),
      ctx("fresh", ["audit"], "never"),
    ];
    const fb = deterministicFallback(contexts);
    assert.equal(fb.project, "fresh");
  });

  it("preserves input order when multiple contexts are tied at 'never'", () => {
    const contexts = [
      ctx("first", ["audit"]),
      ctx("second", ["audit"]),
      ctx("third", ["audit"]),
    ];
    const fb = deterministicFallback(contexts);
    assert.equal(fb.project, "first");
  });

  it("returns the full success shape expected by selectProjectAndTask callers", () => {
    const contexts = [ctx("demo", ["audit", "docs-gen"])];
    const fb = deterministicFallback(contexts, "rate_limited");
    assert.deepEqual(Object.keys(fb).sort(), [
      "_fallback",
      "_fallback_reason",
      "project",
      "projectConfig",
      "reason",
      "task",
    ]);
    assert.equal(fb._fallback, true);
    assert.equal(fb._fallback_reason, "rate_limited");
    assert.equal(fb.project, "demo");
    assert.equal(fb.task, "audit");
    assert.ok(fb.reason.length > 0, "reason should be a non-empty string");
    assert.equal(fb.projectConfig.slug, "demo");
  });

  it("encodes the triggering cause into the reason string for log diagnostics", () => {
    const contexts = [ctx("demo", ["audit"])];
    for (const cause of ["rate_limited", "server_error", "empty_response", "api_error"]) {
      const fb = deterministicFallback(contexts, cause);
      assert.ok(
        fb.reason.includes(cause),
        `reason "${fb.reason}" should mention cause "${cause}"`
      );
      assert.equal(fb._fallback_reason, cause);
    }
  });

  it("defaults cause to 'unknown' when not supplied", () => {
    const contexts = [ctx("demo", ["audit"])];
    const fb = deterministicFallback(contexts);
    assert.equal(fb._fallback_reason, "unknown");
    assert.ok(fb.reason.includes("unknown"));
  });

  it("skips contexts with empty task lists while ranking by timestamp", () => {
    // Oldest context has no viable tasks — fallback must walk past it
    // to the next oldest rather than returning null.
    const contexts = [
      ctx("barren", [], "2026-04-20T00:00:00Z"),
      ctx("viable", ["audit"], "2026-04-22T00:00:00Z"),
    ];
    const fb = deterministicFallback(contexts);
    assert.equal(fb.project, "viable");
  });

  it("tolerates a garbage last_dispatched value by treating it as oldest", () => {
    // Defensive: if a future log-write produces a non-ISO string, we don't
    // want Number.isFinite(NaN) to bump the context ahead of real timestamps.
    const contexts = [
      ctx("valid", ["audit"], "2026-04-22T00:00:00Z"),
      ctx("garbage", ["audit"], "not-a-date"),
    ];
    const fb = deterministicFallback(contexts);
    assert.equal(fb.project, "garbage");
  });
});
