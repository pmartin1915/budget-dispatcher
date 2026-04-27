// pipelines.test.mjs — Phase A multi-step pipeline support
//
// Pure-function tests use plain objects; impure helpers use mkdtempSync
// fixtures (mirrors health.test.mjs / fleet.test.mjs convention).
// No network, no real LLMs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePipelineDef,
  hasDependencyCycle,
  findRunnableStep,
  applyStepOutcome,
  evaluateAbortRules,
  stampMergedTs,
  pickActivePipelineStep,
  loadPipelineState,
  loadPipelineDef,
  advancePipelineState,
  recordPipelineMerges,
  writeFileAtomic,
  FILENAME,
} from "../pipelines.mjs";
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const TMP = mkdtempSync(resolve(tmpdir(), "pipelines-test-"));

function freshProjectDir() {
  const dir = mkdtempSync(resolve(TMP, "proj-"));
  mkdirSync(resolve(dir, "ai"), { recursive: true });
  return dir;
}

function validPipelineDef() {
  return {
    schema_version: 1,
    pipelines: [
      {
        name: "refactor-auth",
        description: "Replace cookie auth with JWT",
        active: true,
        steps: [
          { id: 1, task: "research", description: "Survey current auth flow" },
          { id: 2, task: "audit", depends_on: [1] },
          { id: 3, task: "tests-gen", depends_on: [2] },
          { id: 4, task: "refactor", depends_on: [3] },
        ],
        abort_on: { audit_critical: true, consecutive_step_failures: 2 },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// parsePipelineDef — schema + structural validation
// ---------------------------------------------------------------------------

describe("parsePipelineDef()", () => {
  it("accepts a valid pipeline definition", () => {
    const result = parsePipelineDef(validPipelineDef());
    assert.equal(result.ok, true);
    assert.equal(result.def.pipelines.length, 1);
  });

  it("rejects missing required fields (schema_version)", () => {
    const bad = { pipelines: [] };
    const result = parsePipelineDef(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /schema_version/.test(e)));
  });

  it("rejects unknown task type (not in TASK_TO_CLASS)", () => {
    const def = validPipelineDef();
    def.pipelines[0].steps.push({ id: 5, task: "make-coffee", depends_on: [4] });
    const result = parsePipelineDef(def);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /unknown task "make-coffee"/.test(e)));
  });

  it("rejects depends_on referencing nonexistent step id", () => {
    const def = validPipelineDef();
    def.pipelines[0].steps[1].depends_on = [99];
    const result = parsePipelineDef(def);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /depends_on missing step 99/.test(e)));
  });

  it("rejects self-dependency (step depends on itself)", () => {
    const def = validPipelineDef();
    def.pipelines[0].steps[0].depends_on = [1];
    const result = parsePipelineDef(def);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /self-dependency/.test(e)));
  });

  it("rejects depends_on cycle (step1 -> step2 -> step1)", () => {
    const def = {
      schema_version: 1,
      pipelines: [{
        name: "cycle",
        steps: [
          { id: 1, task: "audit", depends_on: [2] },
          { id: 2, task: "audit", depends_on: [1] },
        ],
      }],
    };
    const result = parsePipelineDef(def);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /cycle/.test(e)));
  });

  it("rejects duplicate step ids", () => {
    const def = validPipelineDef();
    def.pipelines[0].steps.push({ id: 1, task: "audit" }); // duplicate id 1
    const result = parsePipelineDef(def);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /duplicate step ids/.test(e)));
  });

  it("rejects pipeline name with bad characters", () => {
    const def = validPipelineDef();
    def.pipelines[0].name = "Bad Name!"; // schema requires lowercase + dash/underscore
    const result = parsePipelineDef(def);
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// hasDependencyCycle — pure DFS
// ---------------------------------------------------------------------------

describe("hasDependencyCycle()", () => {
  it("returns false for linear chain", () => {
    const steps = [
      { id: 1 },
      { id: 2, depends_on: [1] },
      { id: 3, depends_on: [2] },
    ];
    assert.equal(hasDependencyCycle(steps), false);
  });

  it("returns false for branching DAG (no cycle)", () => {
    const steps = [
      { id: 1 },
      { id: 2, depends_on: [1] },
      { id: 3, depends_on: [1] },
      { id: 4, depends_on: [2, 3] },
    ];
    assert.equal(hasDependencyCycle(steps), false);
  });

  it("detects 2-node cycle", () => {
    const steps = [
      { id: 1, depends_on: [2] },
      { id: 2, depends_on: [1] },
    ];
    assert.equal(hasDependencyCycle(steps), true);
  });

  it("detects 3-node cycle", () => {
    const steps = [
      { id: 1, depends_on: [3] },
      { id: 2, depends_on: [1] },
      { id: 3, depends_on: [2] },
    ];
    assert.equal(hasDependencyCycle(steps), true);
  });
});

// ---------------------------------------------------------------------------
// findRunnableStep — selector decides which step to fire next
// ---------------------------------------------------------------------------

describe("findRunnableStep()", () => {
  const def = validPipelineDef().pipelines[0];

  it("returns step 1 when state is empty", () => {
    const step = findRunnableStep(def, { step_states: {} });
    assert.equal(step?.id, 1);
  });

  it("returns step 2 only when step 1 is success AND merged", () => {
    const state = {
      step_states: {
        "1": { outcome: "success", merged_ts: "2026-04-26T18:00:00.000Z" },
      },
    };
    const step = findRunnableStep(def, state);
    assert.equal(step?.id, 2);
  });

  it("blocks step 2 when step 1 is success but NOT merged yet (cooling-off in flight)", () => {
    const state = {
      step_states: {
        "1": { outcome: "success", merged_ts: null },
      },
    };
    const step = findRunnableStep(def, state);
    assert.equal(step, null);
  });

  it("returns null when pipeline is aborted", () => {
    const state = {
      step_states: {},
      aborted: { reason: "consecutive-step-failures:2", ts: "..." },
    };
    const step = findRunnableStep(def, state);
    assert.equal(step, null);
  });

  it("skips failed steps (advancement halts at failure)", () => {
    const state = {
      step_states: {
        "1": { outcome: "success", merged_ts: "2026-04-26T18:00:00.000Z" },
        "2": { outcome: "failed", reason: "error" },
      },
    };
    const step = findRunnableStep(def, state);
    // Step 3 is blocked because its dep (step 2) is failed not success.
    // Step 2 itself is failed so it's skipped. No runnable step.
    assert.equal(step, null);
  });

  it("treats fresh in-progress step as still running (don't pick it)", () => {
    const now = Date.now();
    const state = {
      step_states: {
        "1": { outcome: "in-progress", started_ts: new Date(now - 60_000).toISOString() }, // 1 min ago
      },
    };
    const step = findRunnableStep(def, state, now);
    // No runnable step — step 1 is in flight, can't pick it; step 2 is blocked by step 1.
    assert.equal(step, null);
  });

  it("recovers orphaned in-progress step (>30 min old)", () => {
    const now = Date.now();
    const state = {
      step_states: {
        "1": { outcome: "in-progress", started_ts: new Date(now - 45 * 60_000).toISOString() }, // 45 min ago
      },
    };
    const step = findRunnableStep(def, state, now);
    assert.equal(step?.id, 1, "orphan recovery: step 1 should be runnable again");
  });
});

// ---------------------------------------------------------------------------
// applyStepOutcome — pure state transitions
// ---------------------------------------------------------------------------

describe("applyStepOutcome()", () => {
  const baseArgs = { pipelineName: "demo", branch: "auto/foo" };

  it("success advances current_step_id and resets consecutive_failures", () => {
    const prev = { step_states: { "1": { outcome: "in-progress" } }, consecutive_failures: 1 };
    const next = applyStepOutcome(prev, { ...baseArgs, stepId: 1, outcome: "success" });
    assert.equal(next.step_states["1"].outcome, "success");
    assert.equal(next.consecutive_failures, 0);
    assert.equal(next.current_step_id, 1);
    assert.equal(next.history.length, 1);
    assert.equal(next.history[0].outcome, "success");
  });

  it("error increments consecutive_failures + appends history", () => {
    const prev = { step_states: {}, consecutive_failures: 0 };
    const next = applyStepOutcome(prev, { ...baseArgs, stepId: 1, outcome: "error" });
    assert.equal(next.step_states["1"].outcome, "failed");
    assert.equal(next.consecutive_failures, 1);
    assert.equal(next.history[0].outcome, "error");
  });

  it("reverted is treated like error", () => {
    const prev = { step_states: {}, consecutive_failures: 0 };
    const next = applyStepOutcome(prev, { ...baseArgs, stepId: 1, outcome: "reverted" });
    assert.equal(next.step_states["1"].outcome, "failed");
    assert.equal(next.consecutive_failures, 1);
  });

  it("skipped is a no-op on step state (next tick re-tries)", () => {
    const prev = { step_states: { "1": { outcome: "pending" } }, consecutive_failures: 0 };
    const next = applyStepOutcome(prev, { ...baseArgs, stepId: 1, outcome: "skipped" });
    assert.deepEqual(next.step_states["1"], prev.step_states["1"]);
    assert.equal(next.consecutive_failures, 0);
  });

  it("in-progress stamps started_ts", () => {
    const prev = { step_states: {}, consecutive_failures: 0 };
    const next = applyStepOutcome(prev, { ...baseArgs, stepId: 1, outcome: "in-progress" });
    assert.equal(next.step_states["1"].outcome, "in-progress");
    assert.ok(next.step_states["1"].started_ts, "started_ts should be stamped");
  });

  it("preserves existing branch + merged_ts on subsequent state updates when no branch override is provided", () => {
    const prev = {
      step_states: {
        "1": { outcome: "success", branch: "auto/foo-1", merged_ts: "2026-04-26T19:00:00.000Z" },
      },
    };
    // Simulate a redundant success update (e.g. retry path with no fresh
    // branch). Pass branch:null explicitly so the helper falls through to
    // the previous step's branch — matches the dispatch.mjs hook's behavior
    // when worktree.branch is unavailable.
    const next = applyStepOutcome(prev, { pipelineName: "demo", stepId: 1, outcome: "success", branch: null });
    assert.equal(next.step_states["1"].merged_ts, "2026-04-26T19:00:00.000Z");
    assert.equal(next.step_states["1"].branch, "auto/foo-1");
  });
});

// ---------------------------------------------------------------------------
// evaluateAbortRules
// ---------------------------------------------------------------------------

describe("evaluateAbortRules()", () => {
  const def = { abort_on: { audit_critical: true, consecutive_step_failures: 2 } };

  it("does not abort under normal conditions", () => {
    const r = evaluateAbortRules({ consecutive_failures: 0 }, def);
    assert.equal(r.abort, false);
  });

  it("aborts on consecutive_failures >= threshold", () => {
    const r = evaluateAbortRules({ consecutive_failures: 2 }, def);
    assert.equal(r.abort, true);
    assert.match(r.reason, /consecutive-step-failures/);
  });

  it("aborts on audit_critical when flag is set", () => {
    const r = evaluateAbortRules({ consecutive_failures: 0 }, def, { lastStepAuditCritical: true });
    assert.equal(r.abort, true);
    assert.equal(r.reason, "audit-critical");
  });

  it("ignores audit_critical when abort_on.audit_critical is false", () => {
    const def2 = { abort_on: { audit_critical: false, consecutive_step_failures: 5 } };
    const r = evaluateAbortRules({ consecutive_failures: 0 }, def2, { lastStepAuditCritical: true });
    assert.equal(r.abort, false);
  });

  it("respects pre-existing aborted state (returns abort:true)", () => {
    const r = evaluateAbortRules({ aborted: { reason: "operator-halted" }, consecutive_failures: 0 }, def);
    assert.equal(r.abort, true);
    assert.equal(r.reason, "operator-halted");
  });
});

// ---------------------------------------------------------------------------
// stampMergedTs — pipeline merged_ts correlation
// ---------------------------------------------------------------------------

describe("stampMergedTs()", () => {
  it("stamps merged_ts on a matching step", () => {
    const state = {
      step_states: {
        "1": { outcome: "success", branch: "auto/foo-1", merged_ts: null },
      },
    };
    const did = stampMergedTs(state, "auto/foo-1", "2026-04-26T19:00:00.000Z");
    assert.equal(did, true);
    assert.equal(state.step_states["1"].merged_ts, "2026-04-26T19:00:00.000Z");
  });

  it("is idempotent — does not re-stamp an already-stamped step", () => {
    const state = {
      step_states: {
        "1": { outcome: "success", branch: "auto/foo-1", merged_ts: "2026-04-26T19:00:00.000Z" },
      },
    };
    const did = stampMergedTs(state, "auto/foo-1", "2026-04-26T20:00:00.000Z");
    assert.equal(did, false, "no stamp because merged_ts was already set");
    assert.equal(state.step_states["1"].merged_ts, "2026-04-26T19:00:00.000Z");
  });

  it("only stamps steps in success state", () => {
    const state = {
      step_states: {
        "1": { outcome: "failed", branch: "auto/foo-1" },
      },
    };
    const did = stampMergedTs(state, "auto/foo-1", "2026-04-26T19:00:00.000Z");
    assert.equal(did, false);
  });

  it("ignores branch mismatches", () => {
    const state = {
      step_states: {
        "1": { outcome: "success", branch: "auto/foo-1", merged_ts: null },
      },
    };
    const did = stampMergedTs(state, "auto/different-branch", "2026-04-26T19:00:00.000Z");
    assert.equal(did, false);
    assert.equal(state.step_states["1"].merged_ts, null);
  });
});

// ---------------------------------------------------------------------------
// pickActivePipelineStep — selector pre-pass
// ---------------------------------------------------------------------------

describe("pickActivePipelineStep()", () => {
  it("returns the next runnable step when one project has an active pipeline", () => {
    const ctx = {
      slug: "burn-wizard",
      config: { slug: "burn-wizard", path: "/fake/path" },
      pipelines: validPipelineDef(),
      pipelineStatePath: "/fake/state.json",
    };
    const pick = pickActivePipelineStep([ctx], { loadState: () => null });
    assert.equal(pick?.projectSlug, "burn-wizard");
    assert.equal(pick?.step.id, 1);
    assert.equal(pick?.pipelineName, "refactor-auth");
  });

  it("returns null when no project has pipelines", () => {
    const ctx = { slug: "x", config: { slug: "x" }, pipelines: null };
    const pick = pickActivePipelineStep([ctx], { loadState: () => null });
    assert.equal(pick, null);
  });

  it("skips pipelines with active:false", () => {
    const def = validPipelineDef();
    def.pipelines[0].active = false;
    const ctx = { slug: "x", config: { slug: "x" }, pipelines: def, pipelineStatePath: "/fake" };
    const pick = pickActivePipelineStep([ctx], { loadState: () => null });
    assert.equal(pick, null);
  });

  it("skips aborted pipelines", () => {
    const ctx = {
      slug: "x", config: { slug: "x" },
      pipelines: validPipelineDef(),
      pipelineStatePath: "/fake",
    };
    const abortedState = {
      schema_version: 1,
      // active_pipeline must match the pipeline name in the def; otherwise
      // pickActivePipelineStep treats this as a stale state from a swapped
      // pipeline and starts fresh.
      active_pipeline: "refactor-auth",
      step_states: {},
      aborted: { reason: "consecutive-step-failures:2", ts: "..." },
    };
    const pick = pickActivePipelineStep([ctx], { loadState: () => abortedState });
    assert.equal(pick, null);
  });

  it("round-robins: picks the project whose pipeline advanced LEAST recently", () => {
    const ctxA = {
      slug: "alpha", config: { slug: "alpha" },
      pipelines: validPipelineDef(),
      pipelineStatePath: "/fake/a",
    };
    const ctxB = {
      slug: "bravo", config: { slug: "bravo" },
      pipelines: validPipelineDef(),
      pipelineStatePath: "/fake/b",
    };
    const stateRecent = {
      schema_version: 1,
      active_pipeline: "refactor-auth",
      step_states: {
        "1": { outcome: "success", merged_ts: "2026-04-26T19:00:00.000Z", completed_ts: "2026-04-26T18:30:00.000Z" },
      },
    };
    const stateOld = {
      schema_version: 1,
      active_pipeline: "refactor-auth",
      step_states: {
        "1": { outcome: "success", merged_ts: "2026-04-25T19:00:00.000Z", completed_ts: "2026-04-25T18:30:00.000Z" },
      },
    };
    const loadState = (path) => (path === "/fake/a" ? stateRecent : stateOld);
    const pick = pickActivePipelineStep([ctxA, ctxB], { loadState });
    assert.equal(pick?.projectSlug, "bravo", "project bravo (older completion) wins round-robin");
  });
});

// ---------------------------------------------------------------------------
// loadPipelineState / loadPipelineDef — fs-touching helpers
// ---------------------------------------------------------------------------

describe("loadPipelineState() / loadPipelineDef() filesystem helpers", () => {
  it("loadPipelineState returns null on missing path", () => {
    assert.equal(loadPipelineState("/nonexistent/state.json"), null);
  });

  it("loadPipelineState returns null on malformed JSON", () => {
    const dir = freshProjectDir();
    const statePath = resolve(dir, "ai", "pipeline-state.json");
    writeFileSync(statePath, "{ not valid json");
    assert.equal(loadPipelineState(statePath), null);
  });

  it("loadPipelineDef returns null on schema violation", () => {
    const dir = freshProjectDir();
    const pipelinesPath = resolve(dir, "ai", "pipelines.json");
    writeFileSync(pipelinesPath, JSON.stringify({ schema_version: 1, pipelines: [{ name: "ok", steps: [{ id: 1, task: "BOGUS" }] }] }));
    assert.equal(loadPipelineDef(pipelinesPath), null);
  });

  it("loadPipelineDef parses and validates a real file", () => {
    const dir = freshProjectDir();
    const pipelinesPath = resolve(dir, "ai", "pipelines.json");
    writeFileSync(pipelinesPath, JSON.stringify(validPipelineDef()));
    const def = loadPipelineDef(pipelinesPath);
    assert.ok(def);
    assert.equal(def.pipelines.length, 1);
  });
});

// ---------------------------------------------------------------------------
// advancePipelineState — end-to-end read/mutate/write
// ---------------------------------------------------------------------------

describe("advancePipelineState() integration", () => {
  it("writes a fresh state file when one didn't exist before", () => {
    const dir = freshProjectDir();
    const statePath = resolve(dir, "ai", "pipeline-state.json");
    assert.equal(existsSync(statePath), false);
    const result = advancePipelineState({
      statePath,
      pipelineName: "demo",
      stepId: 1,
      outcome: "success",
      branch: "auto/demo-1",
    });
    assert.equal(result.written, true);
    assert.equal(existsSync(statePath), true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(persisted.step_states["1"].outcome, "success");
    assert.equal(persisted.step_states["1"].branch, "auto/demo-1");
  });

  it("aborts pipeline when consecutive_failures threshold is reached", () => {
    const dir = freshProjectDir();
    const statePath = resolve(dir, "ai", "pipeline-state.json");
    const def = validPipelineDef().pipelines[0]; // abort_on: consecutive_step_failures: 2
    advancePipelineState({ statePath, pipelineName: "refactor-auth", stepId: 1, outcome: "error", pipelineDef: def });
    const result = advancePipelineState({ statePath, pipelineName: "refactor-auth", stepId: 1, outcome: "error", pipelineDef: def });
    assert.equal(result.aborted, true);
    assert.match(result.abortReason, /consecutive-step-failures/);
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(persisted.aborted);
  });

  it("refuses to write when pipelineDef is provided but pipelineName is missing from it (PAL MEDIUM fix)", () => {
    const dir = freshProjectDir();
    const statePath = resolve(dir, "ai", "pipeline-state.json");
    // Provide a single-pipeline def whose name doesn't match what we're trying to write.
    const def = validPipelineDef().pipelines[0]; // name: "refactor-auth"
    const result = advancePipelineState({
      statePath,
      pipelineName: "completely-different-name",
      stepId: 1,
      outcome: "success",
      pipelineDef: def,
    });
    assert.equal(result.written, false);
    assert.equal(existsSync(statePath), false, "state file should not have been created");
  });

  it("accepts the full {schema_version, pipelines:[...]} wrapper as pipelineDef", () => {
    const dir = freshProjectDir();
    const statePath = resolve(dir, "ai", "pipeline-state.json");
    const result = advancePipelineState({
      statePath,
      pipelineName: "refactor-auth",
      stepId: 1,
      outcome: "success",
      pipelineDef: validPipelineDef(),
    });
    assert.equal(result.written, true);
  });

  it("does not write when state file write would fail (returns written:false)", () => {
    // Deliberately use an invalid path (under a non-writable parent that doesn't exist
    // in a way mkdir can't help — point at a file as a directory).
    const dir = freshProjectDir();
    const blockerFile = resolve(dir, "blocker");
    writeFileSync(blockerFile, "");
    const statePath = resolve(blockerFile, "should-fail.json"); // can't mkdir under a file
    const result = advancePipelineState({
      statePath,
      pipelineName: "demo",
      stepId: 1,
      outcome: "success",
    });
    assert.equal(result.written, false);
  });
});

// ---------------------------------------------------------------------------
// recordPipelineMerges — post-merge-monitor hook
// ---------------------------------------------------------------------------

describe("recordPipelineMerges()", () => {
  it("stamps merged_ts on matching step in a project's pipeline-state.json", () => {
    const dir = freshProjectDir();
    const statePath = resolve(dir, "ai", "pipeline-state.json");
    writeFileSync(statePath, JSON.stringify({
      schema_version: 1,
      active_pipeline: "demo",
      step_states: {
        "1": { outcome: "success", branch: "auto/demo-research-20260426", merged_ts: null },
      },
    }));
    const result = recordPipelineMerges({
      entries: [{ branch: "auto/demo-research-20260426", merged_at_ms: Date.parse("2026-04-26T19:00:00.000Z") }],
      projects: [{ slug: "demo", path: dir }],
    });
    assert.equal(result.updates, 1);
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(persisted.step_states["1"].merged_ts, "2026-04-26T19:00:00.000Z");
  });

  it("is a no-op on projects with no pipeline-state.json", () => {
    const dir = freshProjectDir();
    const result = recordPipelineMerges({
      entries: [{ branch: "auto/whatever", merged_at_ms: Date.now() }],
      projects: [{ slug: "no-pipeline", path: dir }],
    });
    assert.equal(result.updates, 0);
  });

  it("is idempotent across multiple calls (returns 0 updates the second time)", () => {
    const dir = freshProjectDir();
    const statePath = resolve(dir, "ai", "pipeline-state.json");
    writeFileSync(statePath, JSON.stringify({
      schema_version: 1,
      step_states: {
        "1": { outcome: "success", branch: "auto/foo", merged_ts: null },
      },
    }));
    const entries = [{ branch: "auto/foo", merged_at_ms: Date.parse("2026-04-26T19:00:00.000Z") }];
    const projects = [{ slug: "x", path: dir }];
    const r1 = recordPipelineMerges({ entries, projects });
    const r2 = recordPipelineMerges({ entries, projects });
    assert.equal(r1.updates, 1);
    assert.equal(r2.updates, 0);
  });
});

// ---------------------------------------------------------------------------
// writeFileAtomic — extracted helper
// ---------------------------------------------------------------------------

describe("writeFileAtomic()", () => {
  it("writes content to the destination file", () => {
    const dir = freshProjectDir();
    const target = resolve(dir, "out.json");
    writeFileAtomic(target, JSON.stringify({ ok: true }));
    assert.equal(JSON.parse(readFileSync(target, "utf8")).ok, true);
  });

  it("creates parent directory if missing", () => {
    const dir = freshProjectDir();
    const target = resolve(dir, "deeper", "still-deeper", "out.json");
    writeFileAtomic(target, "{}");
    assert.equal(existsSync(target), true);
  });

  it("cleans up tmp file when rename fails", () => {
    const dir = freshProjectDir();
    const blocker = resolve(dir, "blocker");
    writeFileSync(blocker, "x");
    // Try to write into a "directory" that's actually a file — mkdirSync inside
    // writeFileAtomic should accept the existing path (it's a file with same name as needed dir).
    // This test confirms that on failure, no `.tmp.*` file is left behind.
    const target = resolve(blocker, "child", "out.json");
    assert.throws(() => writeFileAtomic(target, "{}"));
    // No leftover tmp files in dir
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp."));
    assert.equal(leftover.length, 0, "no .tmp files should remain after a failed write");
  });
});

describe("FILENAME constants", () => {
  it("exposes pipelines + state filenames", () => {
    assert.equal(FILENAME.pipelines, "pipelines.json");
    assert.equal(FILENAME.state, "pipeline-state.json");
  });
});
