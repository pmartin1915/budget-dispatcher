// watchdog.test.mjs -- unit tests for the P7 out-of-band fleet watchdog.
//
// Pure-function + dependency-injection style. No network, no filesystem.
// Mirrors circuit-breaker.test.mjs conventions: node:test, node:assert/strict,
// and inject fetcher/poster/now via parameters (not module mocks).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateFleetSilence, runWatchdog } from "../../watchdog.mjs";

const NOW = new Date("2026-04-25T12:00:00.000Z").getTime();
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// Helper: build a gist payload with arbitrary fleet snapshots. Each entry's
// value is either a fully-formed snap object (will be JSON.stringified) OR a
// raw string (already-malformed content for negative tests).
function makeGist(snaps) {
  const files = {};
  for (const [name, value] of Object.entries(snaps)) {
    files[name] = {
      content: typeof value === "string" ? value : JSON.stringify(value),
    };
  }
  return { files };
}

function snapAt(machine, lastRunOffsetMs) {
  return {
    machine,
    last_run_ts: new Date(NOW - lastRunOffsetMs).toISOString(),
    last_run_outcome: "wrapper-success",
    computed_at: new Date(NOW).toISOString(),
  };
}

describe("evaluateFleetSilence()", () => {
  it("fresh fleet (all heartbeats < threshold) returns alert: false", () => {
    const gist = makeGist({
      "fleet-perryslenovo.json": snapAt("perryslenovo", 30 * 60 * 1000), // 30 min ago
      "fleet-perrysoptiplex.json": snapAt("perrysoptiplex", 45 * 60 * 1000), // 45 min ago
    });
    const decision = evaluateFleetSilence({ files: gist.files, now: NOW });
    assert.equal(decision.alert, false);
    assert.equal(decision.machines.length, 2);
    assert.equal(decision.machines.every((m) => m.valid), true);
  });

  it("all stale (every heartbeat past threshold) returns alert: true with all machine names", () => {
    const gist = makeGist({
      "fleet-perryslenovo.json": snapAt("perryslenovo", 3 * 60 * 60 * 1000), // 3h ago
      "fleet-perrysoptiplex.json": snapAt("perrysoptiplex", 4 * 60 * 60 * 1000), // 4h ago
      "fleet-perrysneighbor.json": snapAt("perrysneighbor", 5 * 60 * 60 * 1000), // 5h ago
    });
    const decision = evaluateFleetSilence({ files: gist.files, now: NOW });
    assert.equal(decision.alert, true);
    assert.match(decision.reason, /3 fleet machines silent/);
    assert.equal(decision.machines.length, 3);
    const names = decision.machines.map((m) => m.name).sort();
    assert.deepEqual(names, [
      "fleet-perryslenovo.json",
      "fleet-perrysneighbor.json",
      "fleet-perrysoptiplex.json",
    ]);
  });

  it("one stale + two fresh returns alert: false (per-fleet max-freshness, not min)", () => {
    const gist = makeGist({
      "fleet-perryslenovo.json": snapAt("perryslenovo", 5 * 60 * 60 * 1000), // 5h ago (stale)
      "fleet-perrysoptiplex.json": snapAt("perrysoptiplex", 30 * 60 * 1000), // 30 min ago (fresh)
      "fleet-perrysneighbor.json": snapAt("perrysneighbor", 4 * 60 * 60 * 1000), // 4h ago (stale)
    });
    const decision = evaluateFleetSilence({ files: gist.files, now: NOW });
    assert.equal(decision.alert, false);
  });

  it("ignores non-fleet files in the gist", () => {
    const gist = makeGist({
      "dispatch-lock.json": { locked: false },
      "health.json": { state: "healthy" },
      "fleet-perryslenovo.json": snapAt("perryslenovo", 30 * 60 * 1000),
    });
    const decision = evaluateFleetSilence({ files: gist.files, now: NOW });
    assert.equal(decision.alert, false);
    assert.equal(decision.machines.length, 1);
    assert.equal(decision.machines[0].name, "fleet-perryslenovo.json");
  });

  it("treats malformed JSON in one snapshot as silence for that machine; others still count", () => {
    const gist = makeGist({
      "fleet-perryslenovo.json": "{not valid json", // raw malformed string
      "fleet-perrysoptiplex.json": snapAt("perrysoptiplex", 30 * 60 * 1000),
    });
    const decision = evaluateFleetSilence({ files: gist.files, now: NOW });
    assert.equal(decision.alert, false); // optiplex is still fresh
    const lenovo = decision.machines.find((m) => m.name === "fleet-perryslenovo.json");
    assert.equal(lenovo.valid, false);
  });

  it("no fleet files at all returns alert: true (suspicious gist state)", () => {
    const gist = makeGist({
      "dispatch-lock.json": { locked: false },
    });
    const decision = evaluateFleetSilence({ files: gist.files, now: NOW });
    assert.equal(decision.alert, true);
    assert.match(decision.reason, /no fleet snapshots found/);
  });
});

describe("runWatchdog()", () => {
  it("calls poster when evaluate says alert", async () => {
    const gist = makeGist({
      "fleet-a.json": snapAt("a", 3 * 60 * 60 * 1000),
      "fleet-b.json": snapAt("b", 4 * 60 * 60 * 1000),
    });
    let posterCalled = 0;
    let posterArgs = null;
    const result = await runWatchdog({
      gistId: "test-gist",
      ntfyTopic: "test-topic",
      now: NOW,
      fetcher: async () => gist,
      poster: async (...args) => {
        posterCalled++;
        posterArgs = args;
        return true;
      },
    });
    assert.equal(posterCalled, 1);
    assert.equal(result.alerted, true);
    assert.equal(posterArgs[0], "test-topic");
    assert.match(posterArgs[1], /fleet silent/);
    assert.match(posterArgs[2], /fleet-a\.json/);
    assert.match(posterArgs[2], /fleet-b\.json/);
    // Priority is intentionally omitted at the call site -- postNtfy defaults
    // priority=4 (warning) internally, so the 4th positional arg is undefined.
    assert.equal(posterArgs[3], undefined);
  });

  it("does NOT call poster when evaluate says no alert", async () => {
    const gist = makeGist({
      "fleet-a.json": snapAt("a", 30 * 60 * 1000),
    });
    let posterCalled = 0;
    const result = await runWatchdog({
      gistId: "test-gist",
      ntfyTopic: "test-topic",
      now: NOW,
      fetcher: async () => gist,
      poster: async () => {
        posterCalled++;
        return true;
      },
    });
    assert.equal(posterCalled, 0);
    assert.equal(result.alerted, false);
  });

  it("returns no-alert when fetcher throws (transient gist hiccups don't double-alarm)", async () => {
    let posterCalled = 0;
    const result = await runWatchdog({
      gistId: "test-gist",
      ntfyTopic: "test-topic",
      now: NOW,
      fetcher: async () => {
        throw new Error("simulated network error");
      },
      poster: async () => {
        posterCalled++;
        return true;
      },
    });
    assert.equal(posterCalled, 0);
    assert.equal(result.alerted, false);
    assert.match(result.reason, /gist-fetch-failed/);
  });

  it("returns no-alert when gist payload missing files map", async () => {
    let posterCalled = 0;
    const result = await runWatchdog({
      gistId: "test-gist",
      ntfyTopic: "test-topic",
      now: NOW,
      fetcher: async () => ({ description: "no files here" }),
      poster: async () => {
        posterCalled++;
        return true;
      },
    });
    assert.equal(posterCalled, 0);
    assert.equal(result.alerted, false);
    assert.equal(result.reason, "gist-payload-malformed");
  });

  it("skips when no gistId provided (env not configured)", async () => {
    let posterCalled = 0;
    const result = await runWatchdog({
      gistId: undefined,
      ntfyTopic: "test-topic",
      poster: async () => {
        posterCalled++;
        return true;
      },
    });
    assert.equal(posterCalled, 0);
    assert.equal(result.alerted, false);
    assert.equal(result.reason, "no gistId");
  });

  it("skips when no ntfyTopic provided (env not configured)", async () => {
    let posterCalled = 0;
    const result = await runWatchdog({
      gistId: "test-gist",
      ntfyTopic: "",
      poster: async () => {
        posterCalled++;
        return true;
      },
    });
    assert.equal(posterCalled, 0);
    assert.equal(result.alerted, false);
    assert.equal(result.reason, "no ntfyTopic");
  });
});
