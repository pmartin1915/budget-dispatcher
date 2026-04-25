// overseer.test.mjs -- unit tests for the gate-5 read-only Overseer.
//
// Pure-function + dependency-injection style. No network, no filesystem.
// Mirrors watchdog.test.mjs / auto-push.test.mjs conventions: node:test,
// node:assert/strict, all I/O via injected fetcher/palCallFn/appender/now.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideAuditModel,
  evaluateRunDecision,
  parseGenerationModelFromPr,
  parseTaskFromPr,
  buildReviewPrompt,
  parseReviewResponse,
  isQuotaExhausted,
  mapPalErrorToVerdict,
  findLatestOverseerLabel,
  providerFamily,
  reviewOnePr,
  runOverseer,
  _trail,
} from "../../overseer.mjs";

const NOW = new Date("2026-04-27T12:00:00.000Z").getTime();

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockAppender() {
  const calls = [];
  return {
    fn: (entry) => calls.push(entry),
    calls,
  };
}

function mockGh({
  prs = [],
  diff = "",
  events = [],
  commit = { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } },
  listThrows = null,
  diffThrows = null,
  eventsThrows = null,
  commitThrows = null,
  addThrows = null,
  removeThrows = null,
} = {}) {
  const calls = { list: 0, diff: 0, events: 0, commit: 0, add: [], remove: [] };
  return {
    calls,
    async listOpenDispatcherDraftPrs(repo) {
      calls.list++;
      if (listThrows) throw listThrows;
      return prs;
    },
    async getPrDiff(repo, n) {
      calls.diff++;
      if (diffThrows) throw diffThrows;
      return diff;
    },
    async getIssueEvents(repo, n) {
      calls.events++;
      if (eventsThrows) throw eventsThrows;
      return events;
    },
    async getHeadCommit(repo, sha) {
      calls.commit++;
      if (commitThrows) throw commitThrows;
      return commit;
    },
    async addLabel(repo, n, label) {
      calls.add.push({ repo, n, label });
      if (addThrows) throw addThrows;
    },
    async removeLabel(repo, n, label) {
      calls.remove.push({ repo, n, label });
      if (removeThrows) throw removeThrows;
    },
  };
}

function makePr({ number = 1, sha = "abcd1234", labels = [], body = "", html_url = "https://github.com/test/repo/pull/1" } = {}) {
  return {
    number,
    html_url,
    body,
    draft: true,
    head: { sha },
    labels: labels.map((name) => ({ name })),
  };
}

// ---------------------------------------------------------------------------
// providerFamily() + decideAuditModel() -- C-1 cross-family logic
// ---------------------------------------------------------------------------

describe("providerFamily()", () => {
  it("classifies common model strings correctly", () => {
    assert.equal(providerFamily("gemini-2.5-pro"), "gemini");
    assert.equal(providerFamily("gemini-2.5-flash"), "gemini");
    assert.equal(providerFamily("mistral-large-latest"), "mistral");
    assert.equal(providerFamily("codestral-latest"), "mistral");
    assert.equal(providerFamily("devstral-small-2"), "mistral");
    assert.equal(providerFamily("groq/gpt-oss-120b"), "groq");
    assert.equal(providerFamily("openrouter/minimax-m2.5"), "openrouter");
    assert.equal(providerFamily("local/qwen2.5-coder:14b"), "ollama");
    assert.equal(providerFamily(""), "unknown");
    assert.equal(providerFamily(null), "unknown");
    assert.equal(providerFamily("claude-opus-4-7"), "unknown"); // not in map; abstain territory
  });
});

describe("decideAuditModel() -- C-1 cross-family", () => {
  it("Gemini-generated PR -> Mistral audit", () => {
    const r = decideAuditModel({ generationModel: "gemini-2.5-pro" });
    assert.equal(r.abstain, false);
    assert.equal(r.model, "mistral-large-latest");
    assert.equal(r.family, "mistral");
  });

  it("Mistral/Codestral-generated PR -> Gemini audit", () => {
    const r1 = decideAuditModel({ generationModel: "mistral-large-latest" });
    assert.equal(r1.abstain, false);
    assert.equal(r1.model, "gemini-2.5-pro");
    assert.equal(r1.family, "gemini");

    const r2 = decideAuditModel({ generationModel: "codestral-latest" });
    assert.equal(r2.abstain, false);
    assert.equal(r2.model, "gemini-2.5-pro");
  });

  it("missing generation model -> abstain (no silent default)", () => {
    const r = decideAuditModel({ generationModel: null });
    assert.equal(r.abstain, true);
    assert.match(r.reason, /no-generation-model/);
  });

  it("unknown / routed family (groq/openrouter/local) -> abstain", () => {
    // A C-1 violation would be picking gemini or mistral silently for these.
    // The spec says: abstain if family is ambiguous.
    for (const m of ["groq/gpt-oss-120b", "openrouter/minimax-m2.5", "local/qwen2.5-coder:14b", "claude-opus-4-7"]) {
      const r = decideAuditModel({ generationModel: m });
      assert.equal(r.abstain, true, `expected abstain for ${m}`);
      assert.match(r.reason, /unknown-or-routed-family/);
    }
  });
});

// ---------------------------------------------------------------------------
// parseGenerationModelFromPr / parseTaskFromPr -- prefer labels, fall back to body
// ---------------------------------------------------------------------------

describe("parseGenerationModelFromPr()", () => {
  it("reads from labels when present", () => {
    const m = parseGenerationModelFromPr({
      labels: [{ name: "dispatcher:auto" }, { name: "model:gemini-2.5-pro" }, { name: "task:audit" }],
      body: "ignored",
    });
    assert.equal(m, "gemini-2.5-pro");
  });

  it("falls back to body when no model label", () => {
    const body = "## Dispatcher auto-PR\n- **Model:** `mistral-large-latest`\n- **Task:** `refactor`";
    const m = parseGenerationModelFromPr({ labels: [{ name: "dispatcher:auto" }], body });
    assert.equal(m, "mistral-large-latest");
  });

  it("returns null when neither label nor body has a model", () => {
    assert.equal(parseGenerationModelFromPr({ labels: [], body: "" }), null);
    assert.equal(parseGenerationModelFromPr({ labels: undefined, body: undefined }), null);
  });
});

describe("parseTaskFromPr()", () => {
  it("reads task from labels", () => {
    assert.equal(parseTaskFromPr({ labels: [{ name: "task:audit" }] }), "audit");
    assert.equal(parseTaskFromPr({ labels: [{ name: "task:tests_gen" }] }), "tests_gen");
    assert.equal(parseTaskFromPr({ labels: [] }), null);
  });
});

// ---------------------------------------------------------------------------
// evaluateRunDecision() -- idempotency
// ---------------------------------------------------------------------------

describe("evaluateRunDecision() -- idempotency", () => {
  it("no prior overseer label -> review", () => {
    const r = evaluateRunDecision({ latestOverseerLabel: null, headCommittedAt: new Date(NOW).toISOString() });
    assert.equal(r.skip, false);
    assert.equal(r.reason, "no-prior-label");
  });

  it("label newer than head commit -> SKIP (already reviewed this sha)", () => {
    const r = evaluateRunDecision({
      latestOverseerLabel: { name: "overseer:approved", createdAt: new Date(NOW - 5 * 60_000).toISOString() },
      headCommittedAt: new Date(NOW - 60 * 60_000).toISOString(),
    });
    assert.equal(r.skip, true);
    assert.match(r.reason, /already-reviewed:overseer:approved/);
  });

  it("label older than head commit -> review (re-review fires on new push)", () => {
    const r = evaluateRunDecision({
      latestOverseerLabel: { name: "overseer:abstain", createdAt: new Date(NOW - 60 * 60_000).toISOString() },
      headCommittedAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    assert.equal(r.skip, false);
    assert.match(r.reason, /head-advanced/);
  });

  it("missing head commit date -> SKIP (don't double-spend on transient hiccup)", () => {
    const r = evaluateRunDecision({
      latestOverseerLabel: { name: "overseer:approved", createdAt: new Date(NOW).toISOString() },
      headCommittedAt: null,
    });
    assert.equal(r.skip, true);
    assert.equal(r.reason, "head-commit-date-unknown");
  });
});

// ---------------------------------------------------------------------------
// findLatestOverseerLabel -- only events for overseer:* labels count, only most-recent
// ---------------------------------------------------------------------------

describe("findLatestOverseerLabel()", () => {
  it("ignores non-overseer label events and unlabeled events", () => {
    const events = [
      { event: "labeled", label: { name: "dispatcher:auto" }, created_at: "2026-04-27T11:00:00Z" },
      { event: "labeled", label: { name: "overseer:abstain" }, created_at: "2026-04-27T11:30:00Z" },
      { event: "unlabeled", label: { name: "overseer:abstain" }, created_at: "2026-04-27T11:45:00Z" },
      { event: "labeled", label: { name: "overseer:approved" }, created_at: "2026-04-27T11:50:00Z" },
      { event: "labeled", label: { name: "task:audit" }, created_at: "2026-04-27T11:55:00Z" },
    ];
    const r = findLatestOverseerLabel(events);
    assert.equal(r.name, "overseer:approved");
    assert.equal(r.createdAt, "2026-04-27T11:50:00Z");
  });

  it("returns null when no overseer events exist", () => {
    assert.equal(findLatestOverseerLabel([{ event: "labeled", label: { name: "dispatcher:auto" }, created_at: "2026-04-27T11:00:00Z" }]), null);
    assert.equal(findLatestOverseerLabel([]), null);
    assert.equal(findLatestOverseerLabel(null), null);
  });
});

// ---------------------------------------------------------------------------
// parseReviewResponse + buildReviewPrompt
// ---------------------------------------------------------------------------

describe("parseReviewResponse()", () => {
  it("parses well-formed JSON with verdict + issues", () => {
    const r = parseReviewResponse(JSON.stringify({
      verdict: "approved",
      confidence: "high",
      summary: "Diff matches the body claim and has no semantic regressions.",
      issues: [
        { severity: "low", note: "minor: stylistic" },
        { severity: "medium", note: "consider extracting helper" },
        { severity: "medium", note: "another medium" },
      ],
    }));
    assert.equal(r.verdict, "approved");
    assert.equal(r.confidence, "high");
    assert.deepEqual(r.issueCounts, { critical: 0, high: 0, medium: 2, low: 1 });
    assert.match(r.summary, /matches the body claim/);
  });

  it("strips ```json fence and tolerates surrounding prose", () => {
    const r = parseReviewResponse("Here is my review:\n```json\n{\"verdict\":\"rejected\",\"confidence\":\"medium\",\"summary\":\"diff doesn't match claim\",\"issues\":[]}\n```\nHope that helps.");
    assert.equal(r.verdict, "rejected");
    assert.equal(r.confidence, "medium");
  });

  it("non-JSON or unknown verdict -> abstain", () => {
    assert.equal(parseReviewResponse("absolute garbage").verdict, "abstain");
    assert.equal(parseReviewResponse(JSON.stringify({ verdict: "wat" })).verdict, "abstain");
    assert.equal(parseReviewResponse("").verdict, "abstain");
    assert.equal(parseReviewResponse(null).verdict, "abstain");
  });

  it("trail-limits long summaries to <=500 chars", () => {
    const big = "x".repeat(2000);
    const r = parseReviewResponse(JSON.stringify({ verdict: "approved", confidence: "high", summary: big, issues: [] }));
    assert.ok(r.summary.length <= 500, `summary length ${r.summary.length} should be <=500`);
  });
});

describe("buildReviewPrompt()", () => {
  it("truncates oversized diffs to maxDiffChars", () => {
    const big = "+".repeat(60_000);
    const out = buildReviewPrompt({ prBody: "did stuff", diff: big, maxDiffChars: 1000 });
    assert.ok(out.length < 60_000, "prompt should not contain the full untruncated diff");
    assert.match(out, /truncated 59000 chars/);
  });
});

// ---------------------------------------------------------------------------
// isQuotaExhausted + mapPalErrorToVerdict
// ---------------------------------------------------------------------------

describe("isQuotaExhausted() and mapPalErrorToVerdict()", () => {
  it("HTTP 429 -> quota-exhausted", () => {
    assert.equal(isQuotaExhausted({ status: 429, message: "Too Many Requests" }), true);
  });

  it("Gemini-style 'daily quota exceeded' message -> quota-exhausted", () => {
    assert.equal(isQuotaExhausted(new Error("Resource has been exhausted: daily quota exceeded")), true);
  });

  it("generic non-quota error -> not quota", () => {
    assert.equal(isQuotaExhausted(new Error("Internal server error")), false);
    assert.equal(isQuotaExhausted({ status: 500 }), false);
  });

  it("quota error maps to abstain (NOT rejected)", () => {
    const v = mapPalErrorToVerdict({ status: 429, message: "daily quota exceeded" });
    assert.equal(v.verdict, "abstain");
    assert.equal(v.reason, "quota-exhausted");
  });

  it("non-quota error also maps to abstain (fail-soft)", () => {
    const v = mapPalErrorToVerdict(new Error("DNS lookup failed"));
    assert.equal(v.verdict, "abstain");
    assert.equal(v.reason, "pal-error");
  });
});

// ---------------------------------------------------------------------------
// reviewOnePr() -- end-to-end integration with injected gh + palCallFn
// ---------------------------------------------------------------------------

describe("reviewOnePr() integration", () => {
  it("happy path: Gemini-generated PR, Mistral audit returns approved -> applies overseer:approved label", async () => {
    const pr = makePr({
      number: 42,
      sha: "deadbeef",
      labels: ["dispatcher:auto", "model:gemini-2.5-pro", "task:audit"],
      body: "## Dispatcher auto-PR\n- **Model:** `gemini-2.5-pro`",
    });
    const gh = mockGh({
      events: [], // no prior overseer label
      commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } },
      diff: "+++ b/src/foo.js\n@@\n+const x = 1;",
    });
    const palCalls = [];
    const palCallFn = async ({ model, prompt }) => {
      palCalls.push({ model, prompt });
      return JSON.stringify({ verdict: "approved", confidence: "high", summary: "matches claim", issues: [] });
    };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "approved");
    assert.equal(r.audit_model, "mistral-large-latest"); // C-1 opposite family
    assert.equal(palCalls.length, 1);
    assert.equal(palCalls[0].model, "mistral-large-latest");
    assert.equal(gh.calls.add.length, 1);
    assert.equal(gh.calls.add[0].label, "overseer:approved");
    assert.equal(gh.calls.remove.length, 0); // no prior label to remove
    assert.equal(ap.calls.length, 1);
    assert.equal(ap.calls[0].outcome, "approved");
    assert.equal(ap.calls[0].head_sha, "deadbeef");
  });

  it("idempotency: prior overseer:approved newer than head commit -> SKIP (no PAL call)", async () => {
    const pr = makePr({ number: 7, sha: "old", labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });
    const gh = mockGh({
      events: [{ event: "labeled", label: { name: "overseer:approved" }, created_at: new Date(NOW - 5 * 60_000).toISOString() }],
      commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } },
    });
    let palCalled = 0;
    const palCallFn = async () => { palCalled++; return ""; };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "skipped");
    assert.match(r.reason, /already-reviewed/);
    assert.equal(palCalled, 0);
    assert.equal(gh.calls.add.length, 0);
    assert.equal(gh.calls.remove.length, 0);
  });

  it("unknown family in PR -> abstain label, no PAL call", async () => {
    // Claude-generated PR (not in cross-family map). Must abstain, not silently
    // pick gemini or mistral.
    const pr = makePr({
      number: 99,
      sha: "abc",
      labels: ["dispatcher:auto", "model:claude-opus-4-7"],
      body: "",
    });
    const gh = mockGh({ events: [], commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } } });
    let palCalled = 0;
    const palCallFn = async () => { palCalled++; return ""; };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "abstain");
    assert.match(r.reason, /unknown-or-routed-family/);
    assert.equal(palCalled, 0);
    assert.equal(gh.calls.add[0].label, "overseer:abstain");
  });

  it("PAL quota-exhausted -> abstain, NOT rejected", async () => {
    const pr = makePr({ number: 11, sha: "qq", labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });
    const gh = mockGh({ events: [], commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } }, diff: "+x" });
    const palCallFn = async () => {
      const e = new Error("Resource exhausted: daily quota exceeded");
      e.status = 429;
      throw e;
    };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "abstain");
    assert.equal(gh.calls.add[0].label, "overseer:abstain");
    assert.match(ap.calls[0].summary ?? "", /quota/i);
  });

  it("GitHub events fetch 403 -> log-and-skip, never crashes (fail-soft)", async () => {
    const pr = makePr({ number: 12, labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });
    const err = new Error("rate limited");
    err.status = 403;
    const gh = mockGh({ eventsThrows: err });
    let palCalled = 0;
    const palCallFn = async () => { palCalled++; return ""; };
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "skipped");
    assert.match(r.reason, /events-fetch-failed:403/);
    assert.equal(palCalled, 0);
    assert.equal(gh.calls.add.length, 0);
  });

  it("removes prior overseer:abstain before adding overseer:approved (re-review on new push)", async () => {
    const pr = makePr({ number: 5, sha: "newer", labels: ["dispatcher:auto", "model:codestral-latest"] });
    const gh = mockGh({
      events: [{ event: "labeled", label: { name: "overseer:abstain" }, created_at: new Date(NOW - 90 * 60_000).toISOString() }],
      commit: { commit: { committer: { date: new Date(NOW - 5 * 60_000).toISOString() } } },
      diff: "+x",
    });
    const palCallFn = async () => JSON.stringify({ verdict: "approved", confidence: "medium", summary: "looks good", issues: [] });
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });

    assert.equal(r.outcome, "approved");
    assert.equal(gh.calls.remove.length, 1);
    assert.equal(gh.calls.remove[0].label, "overseer:abstain");
    assert.equal(gh.calls.add.length, 1);
    assert.equal(gh.calls.add[0].label, "overseer:approved");
  });

  it("422 on label add (already applied) is treated as success", async () => {
    const pr = makePr({ number: 13, labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });
    const err = new Error("label conflict");
    err.status = 422;
    const gh = mockGh({ events: [], commit: { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } }, diff: "+x", addThrows: err });
    const palCallFn = async () => JSON.stringify({ verdict: "approved", confidence: "high", summary: "ok", issues: [] });
    const ap = mockAppender();
    const r = await reviewOnePr({ repo: "p/r", pr, gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });
    assert.equal(r.outcome, "approved");
    assert.equal(r.label_outcome.added, true);
    assert.equal(r.label_outcome.note, "already-applied");
  });
});

// ---------------------------------------------------------------------------
// runOverseer() -- top-level orchestrator
// ---------------------------------------------------------------------------

describe("runOverseer() top-level", () => {
  it("empty repos list -> log-and-skip, no work", async () => {
    const ap = mockAppender();
    const results = await runOverseer({ repos: [], appender: ap.fn, gh: mockGh(), palCallFn: async () => "" });
    assert.equal(results.length, 0);
    assert.equal(ap.calls.length, 1);
    assert.equal(ap.calls[0].outcome, "skipped");
    assert.equal(ap.calls[0].reason, "no-repos-configured");
  });

  it("list-prs failure on one repo -> sequential fail-soft, other repos still processed", async () => {
    const ap = mockAppender();
    const goodPr = makePr({ number: 1, labels: ["dispatcher:auto", "model:gemini-2.5-pro"] });

    // Simulate a multi-repo run where the first repo's listing fails.
    const calls = { listed: [] };
    const gh = {
      async listOpenDispatcherDraftPrs(repo) {
        calls.listed.push(repo);
        if (repo === "p/bad") {
          const e = new Error("forbidden");
          e.status = 403;
          throw e;
        }
        return [goodPr];
      },
      async getPrDiff() { return "+x"; },
      async getIssueEvents() { return []; },
      async getHeadCommit() { return { commit: { committer: { date: new Date(NOW - 60 * 60_000).toISOString() } } }; },
      async addLabel() {},
      async removeLabel() {},
    };
    const palCallFn = async () => JSON.stringify({ verdict: "approved", confidence: "high", summary: "ok", issues: [] });

    const results = await runOverseer({ repos: ["p/bad", "p/good"], gh, palCallFn, appender: ap.fn, maxDiffChars: 50_000 });
    assert.deepEqual(calls.listed, ["p/bad", "p/good"]);
    assert.equal(results.length, 1); // only p/good produced a result
    assert.equal(results[0].outcome, "approved");
    // ap should have one error log for p/bad and one approved for p/good
    const errors = ap.calls.filter((c) => c.outcome === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /list-failed:403/);
  });
});

// ---------------------------------------------------------------------------
// _trail
// ---------------------------------------------------------------------------

describe("_trail()", () => {
  it("preserves the tail (where errors usually land)", () => {
    const s = "head".padEnd(2000, "x") + "<<TAIL>>";
    const out = _trail(s, 500);
    assert.equal(out.length, 500);
    assert.match(out, /<<TAIL>>$/);
  });
  it("returns empty for nullish input", () => {
    assert.equal(_trail(null), "");
    assert.equal(_trail(undefined), "");
  });
});
