// circuit-breaker.test.mjs -- unit tests for the pure-function counter logic
// added in 2026-04-25 (P3 auto-update circuit breaker handoff).
//
// Pure functions, no I/O. The CLI wrapper (circuit-breaker-cli.mjs) is
// exercised end-to-end via the wrapper PS1 script; not re-tested here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  freshState,
  evaluateGate,
  recordPullOutcome,
  recordDispatchOutcome,
} from "../circuit-breaker.mjs";

const FIXED_NOW = new Date("2026-04-25T12:00:00.000Z");

describe("freshState()", () => {
  it("returns the documented default shape", () => {
    const s = freshState();
    assert.equal(s.sha, null);
    assert.equal(s.pulled_at, null);
    assert.equal(s.post_pull_failures, 0);
    assert.equal(s.frozen, false);
    assert.equal(s.freeze_reason, null);
  });
});

describe("evaluateGate()", () => {
  it("returns shouldPull: true for fresh state", () => {
    const gate = evaluateGate(freshState());
    assert.equal(gate.shouldPull, true);
    assert.equal(gate.frozen, false);
    assert.equal(gate.reason, "open");
  });

  it("returns shouldPull: false when frozen", () => {
    const gate = evaluateGate({
      ...freshState(),
      frozen: true,
      freeze_reason: "3 consecutive post-pull failures at abc1234",
      sha: "abc1234",
    });
    assert.equal(gate.shouldPull, false);
    assert.equal(gate.frozen, true);
    assert.equal(gate.sha, "abc1234");
    assert.match(gate.reason, /post-pull failures/);
  });

  it("tolerates null/undefined input as fresh", () => {
    assert.equal(evaluateGate(null).shouldPull, true);
    assert.equal(evaluateGate(undefined).shouldPull, true);
  });
});

describe("recordPullOutcome()", () => {
  it("resets failures to 0, stamps SHA and pulled_at", () => {
    const before = { ...freshState(), post_pull_failures: 2 };
    const after = recordPullOutcome(before, "deadbee", FIXED_NOW);
    assert.equal(after.sha, "deadbee");
    assert.equal(after.pulled_at, "2026-04-25T12:00:00.000Z");
    assert.equal(after.post_pull_failures, 0);
    assert.equal(after.frozen, false);
  });
});

describe("recordDispatchOutcome()", () => {
  it("exit 0 keeps failures at 0 and does not signal ntfy", () => {
    const result = recordDispatchOutcome(freshState(), 0, "abc1234");
    assert.equal(result.state.post_pull_failures, 0);
    assert.equal(result.shouldFireFreezeNtfy, false);
  });

  it("first non-zero exit increments to failures: 1, no freeze", () => {
    const result = recordDispatchOutcome(freshState(), 1, "abc1234");
    assert.equal(result.state.post_pull_failures, 1);
    assert.equal(result.state.frozen, false);
    assert.equal(result.shouldFireFreezeNtfy, false);
  });

  it("second consecutive non-zero exit reaches failures: 2, no freeze", () => {
    const after1 = recordDispatchOutcome(freshState(), 1, "abc1234").state;
    const after2 = recordDispatchOutcome(after1, 1, "abc1234").state;
    assert.equal(after2.post_pull_failures, 2);
    assert.equal(after2.frozen, false);
  });

  it("third consecutive non-zero crosses threshold: frozen + ntfy signal", () => {
    let s = freshState();
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    const final = recordDispatchOutcome(s, 1, "abc1234", 3, FIXED_NOW);
    assert.equal(final.state.post_pull_failures, 3);
    assert.equal(final.state.frozen, true);
    assert.equal(final.state.frozen_at, "2026-04-25T12:00:00.000Z");
    assert.match(final.state.freeze_reason, /3 consecutive post-pull failures at abc1234/);
    assert.equal(final.shouldFireFreezeNtfy, true);
    assert.match(final.freezeReason, /3 consecutive/);
  });

  it("fourth non-zero while already frozen: failures keep climbing, ntfy stays silent (hygiene)", () => {
    let s = freshState();
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    assert.equal(s.frozen, true);
    const fourth = recordDispatchOutcome(s, 1, "abc1234");
    assert.equal(fourth.state.post_pull_failures, 4);
    assert.equal(fourth.state.frozen, true);
    assert.equal(fourth.shouldFireFreezeNtfy, false);
  });

  it("success after two failures resets the streak before freezing", () => {
    let s = freshState();
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    assert.equal(s.post_pull_failures, 2);
    const recovered = recordDispatchOutcome(s, 0, "abc1234");
    assert.equal(recovered.state.post_pull_failures, 0);
    assert.equal(recovered.state.frozen, false);
    assert.equal(recovered.shouldFireFreezeNtfy, false);
  });

  it("recordPullOutcome on a non-frozen state with prior failures resets the counter (new commit, new chance)", () => {
    let s = freshState();
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    s = recordDispatchOutcome(s, 1, "abc1234").state;
    assert.equal(s.post_pull_failures, 2);
    s = recordPullOutcome(s, "deadbee", FIXED_NOW);
    assert.equal(s.post_pull_failures, 0);
    assert.equal(s.sha, "deadbee");
    assert.equal(s.frozen, false);
  });

  it("custom freezeThreshold (e.g. 5) defers the transition until the fifth failure", () => {
    let s = freshState();
    for (let i = 1; i <= 4; i++) {
      const r = recordDispatchOutcome(s, 1, "abc1234", 5);
      s = r.state;
      assert.equal(s.frozen, false, `failure ${i} should not freeze yet at threshold=5`);
      assert.equal(r.shouldFireFreezeNtfy, false);
    }
    const fifth = recordDispatchOutcome(s, 1, "abc1234", 5);
    assert.equal(fifth.state.post_pull_failures, 5);
    assert.equal(fifth.state.frozen, true);
    assert.equal(fifth.shouldFireFreezeNtfy, true);
  });
});
