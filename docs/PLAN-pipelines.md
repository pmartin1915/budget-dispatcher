# PLAN — Multi-step pipelines (Phase A) + plan-feature task type sketch (Phase B)

**Status:** Design — pending operator approval
**Author:** Claude Opus 4.7 (1M), 2026-04-26 session
**Estimated scope:** Phase A ~700 LOC + ~250 LOC tests in a single PR; Phase B sketched only (separate session)
**Dormant on ship:** yes — no project carries `ai/pipelines.json` until the operator authors one

---

## Context

The dispatcher today ships single bounded tasks per cron tick on existing rotation projects. Each cycle: gates → selector picks one `(project, task)` from the project's DISPATCH.md leaf-list → worker executes → tests + audit → auto-push gate stack lands a PR. Cycles are independent; the selector has no concept of a multi-step initiative in progress.

Operator vision: "build on its own work" — research a problem, plan the change, execute, test, audit, fix, retest as a coherent thread spanning multiple cycles. Not just leaf-level audits of existing code.

This plan adds **pipeline awareness** to the dispatcher. Operator-authored YAML-style JSON files define ordered steps; the dispatcher executes them step-by-step across cycles, with each step's PR landing through the existing seven-gate auto-push stack. The single-task selector path stays as the fallback when no pipeline is active.

---

## Phase A: Pipeline awareness (this PR)

### 1. Data model

**Pipeline definition (operator-authored, committed):**
[`<project.path>/ai/pipelines.json`](#) — array of pipeline definitions per project.

```json
{
  "schema_version": 1,
  "pipelines": [
    {
      "name": "refactor-auth-middleware",
      "description": "Replace legacy session-cookie auth with JWT validation",
      "goal_signal": "no session-cookie reads remain in src/middleware/",
      "active": true,
      "steps": [
        {
          "id": 1,
          "task": "research",
          "target": "docs/research/auth-middleware-state.md",
          "description": "Survey current auth flow; list every src/ file that reads session cookies",
          "model": "gemini-2.5-pro"
        },
        {
          "id": 2,
          "task": "audit",
          "target": "src/middleware/",
          "description": "Identify migration risk areas. Output goes to ai/audit-auth-middleware.md",
          "model": "gemini-2.5-pro",
          "depends_on": [1]
        },
        {
          "id": 3,
          "task": "tests-gen",
          "target": "src/middleware/__tests__/auth.test.ts",
          "description": "Add characterization tests covering current cookie-based flow",
          "model": "codestral-latest",
          "depends_on": [2]
        },
        {
          "id": 4,
          "task": "refactor",
          "target": "src/middleware/auth.ts",
          "description": "Add JWT validator alongside cookie read; both work in parallel",
          "model": "codestral-latest",
          "depends_on": [3]
        }
      ],
      "abort_on": {
        "audit_critical": true,
        "test_failure_streak": 3,
        "consecutive_step_failures": 2
      }
    }
  ]
}
```

**Why JSON not YAML:** no `js-yaml` dep currently in `package.json`. Adding one for a single feature isn't worth it. JSON keeps this aligned with `config/budget.json`, `local.json`, and the existing schema-validated config pattern. Multi-line `description` fields aren't pretty in JSON but they're acceptable.

**Pipeline state (dispatcher-mutated, gitignored):**
[`<project.path>/ai/pipeline-state.json`](#) — opaque to the operator; the dispatcher owns it.

```json
{
  "schema_version": 1,
  "active_pipeline": "refactor-auth-middleware",
  "current_step_id": 3,
  "step_states": {
    "1": {
      "outcome": "success",
      "started_ts": "2026-04-26T18:00:00.000Z",
      "completed_ts": "2026-04-26T18:08:00.000Z",
      "branch": "auto/refactor-auth-research-2026-04-26",
      "merged_ts": "2026-04-26T18:50:00.000Z"
    },
    "2": {
      "outcome": "success",
      "started_ts": "2026-04-26T19:00:00.000Z",
      "completed_ts": "2026-04-26T19:09:00.000Z",
      "branch": "auto/refactor-auth-audit-2026-04-26",
      "merged_ts": "2026-04-26T19:50:00.000Z"
    },
    "3": {
      "outcome": "in-progress",
      "started_ts": "2026-04-26T20:00:00.000Z"
    }
  },
  "consecutive_failures": 0,
  "history": [
    { "step": 1, "outcome": "success", "ts": "2026-04-26T18:08:00.000Z" },
    { "step": 2, "outcome": "success", "ts": "2026-04-26T19:09:00.000Z" }
  ],
  "aborted": null
}
```

`merged_ts` is set asynchronously when the auto-push gate stack lands the PR (gate 6 success). Until then a step in `outcome: success` is "committed locally and pushed; awaiting Overseer merge." A pipeline's next step can begin while the previous step's PR is still in cooling-off, but a step that's `failed` halts progress (no advance until operator intervenes or the abort_on rule fires).

**Files added:**
- `scripts/lib/pipelines.mjs` — pure helpers (parse, validate, advance state, evaluate abort) + impure load/save
- `scripts/lib/__tests__/pipelines.test.mjs` — ~25 tests
- `scripts/lib/schemas.mjs` extended with `pipelineDefSchema` + `pipelineStateSchema`

---

### 2. Selector pre-pass

**Insertion point:** `scripts/lib/selector.mjs:selectProjectAndTask()` — *before* the LLM call (per the explore map, before line 326).

**Behavior:**

```javascript
// New, before the existing LLM selector logic
const pipelineSelection = pickActivePipelineStep(selectorContexts);
if (pipelineSelection) {
  return {
    project: pipelineSelection.projectSlug,
    task: pipelineSelection.step.task,
    reason: `pipeline:${pipelineSelection.pipelineName}:step-${pipelineSelection.step.id}`,
    projectConfig: pipelineSelection.projectConfig,
    pipelineStep: pipelineSelection.step,    // NEW field on selection
    pipelineName: pipelineSelection.pipelineName,
  };
}
// ... existing LLM selector path unchanged
```

**`pickActivePipelineStep(contexts)`** — pure function in `pipelines.mjs`:

1. For each project context, load `ai/pipelines.json` (already done by `buildProjectContext` extension; see §3) and `ai/pipeline-state.json`.
2. Filter pipelines where `active === true`.
3. For each active pipeline, compute "next runnable step":
   - The lowest-id step whose `step_states[id].outcome` is missing OR `outcome === "in-progress"` *and* `started_ts > 30min ago` (timeout-recovery — the previous attempt likely crashed).
   - Skip if the step's `depends_on` includes any step not yet in `outcome: "success"`.
4. Round-robin across projects-with-active-pipelines if multiple have unblocked steps. (Avoids one pipeline starving others.)
5. Return `{ projectSlug, projectConfig, pipelineName, step }` or null.

**Cost savings:** when a pipeline step is queued, the selector skips the LLM call entirely. Saves one Gemini Pro RPD per pipeline tick.

**Fallback safety:** if pipeline parsing throws (malformed pipelines.json), log "pipeline-load-failed" and fall through to the existing LLM selector. The dispatcher continues; only that project's pipeline is paused until the file is fixed.

---

### 3. Project context extension

**File:** `scripts/lib/context.mjs:buildProjectContext()` — extend to load pipeline definitions alongside DISPATCH.md.

```javascript
const pipelinesPath = resolve(project.path, "ai", "pipelines.json");
let pipelinesData = null;
try {
  if (existsSync(pipelinesPath)) {
    const raw = readFileSync(pipelinesPath, "utf8");
    pipelinesData = JSON.parse(raw);
    // schema validation — invalid file -> log + treat as no pipeline
    if (!validatePipelineDef(pipelinesData)) {
      console.warn(`[context] ${project.slug} pipelines.json failed schema validation; ignoring`);
      pipelinesData = null;
    }
  }
} catch (e) {
  console.warn(`[context] ${project.slug} pipelines.json read error: ${e.message}`);
}

return {
  ...,
  pipelines: pipelinesData,           // NEW
  pipelineStatePath: resolve(project.path, "ai", "pipeline-state.json"),  // NEW
};
```

State file is loaded lazily by `pickActivePipelineStep` (only when at least one project has pipelines defined).

---

### 4. Worker integration

**Insertion point:** `scripts/dispatch.mjs` between `verifyAndCommit()` (line 337) and `appendLog()` (line 341).

```javascript
finalResult = await verifyAndCommit(workResult, selection, route, config, clients);

// NEW: pipeline state update (no-op if selection.pipelineStep is absent)
if (selection.pipelineStep) {
  try {
    advancePipelineState({
      projectPath: projectPathFor(selection.project, config),
      pipelineName: selection.pipelineName,
      stepId: selection.pipelineStep.id,
      outcome: finalResult.outcome,    // success | error | reverted | skipped
      branch: finalResult.branch ?? null,
      now: new Date(),
    });
  } catch (e) {
    console.warn(`[dispatch] pipeline state write failed: ${e.message}`);
    // non-fatal; appendLog still records the underlying outcome
  }
}

appendLog({ ...finalResult, project: selection.project, ... });
```

**`advancePipelineState()`** — impure helper in `pipelines.mjs`:

1. Read current state file (atomic; missing = empty state).
2. Pure-compute `applyStepOutcome(state, stepId, outcome, branch, now)`:
   - On `success`: mark step complete, advance `current_step_id` to next runnable step, reset `consecutive_failures`.
   - On `error` / `reverted`: increment `consecutive_failures`, mark step `failed`, append to history.
   - On `skipped`: don't change state (dispatch chose not to run this tick; retry next tick).
3. Pure-compute `evaluateAbortRules(state, pipelineDef)`:
   - `consecutive_step_failures >= N` → set `aborted: { reason, ts }`.
   - `audit_critical: true` and audit returned critical → set `aborted`.
4. Atomic write back via `writeFileAtomic` (helper extracted from circuit-breaker-cli.mjs pattern).

**`merged_ts` follow-up:** the post-merge monitor (gate 7, `scripts/post-merge-monitor.mjs`) already tracks merged auto/* PRs. Extend it to call a new `recordPipelineMerge(branch)` helper that finds the matching pipeline step and stamps `merged_ts`. This is a small additive change in post-merge-monitor.mjs.

---

### 5. Auto-push integration

**No architectural change.** Each pipeline step lands its own `auto/<slug>-<task>-<date>` branch via the existing seven-gate stack. The Overseer reviews per-step. This means:

- Step PRs are independent units — Overseer can approve step 3 and reject step 5 without rolling back step 3.
- A step whose PR is rejected pauses the pipeline at that step (state is `outcome: success` locally, but `merged_ts` never gets stamped, so the next step's `depends_on` check fails). Operator inspects the rejected PR, decides to fix or abort.
- Cooling-off delays a step's `merged_ts` by `cooling_off_minutes` (currently 45). The next step CAN start during cooling-off because the local commit is in place — the dependency check uses `outcome: "success"`, not `merged_ts`. This keeps pipelines moving.

**Drift mitigation:** by the time step N starts, step N-1's commit is on the local branch the worker checks out. If the codebase has drifted underneath (e.g. step 1 wrote a research doc, step 4 tries to refactor based on it, but step 3 changed something step 4 depended on), step N's audit is the catch — cross-family Mistral audit per C-1 will flag inconsistencies. If audit returns critical, `abort_on.audit_critical: true` halts the pipeline.

---

### 6. Failure modes + observability

**Pipeline-specific JSONL log entries** (added to existing dispatch log):

```json
{"ts":"...","phase":"pipeline","engine":"dispatch.mjs","outcome":"step-started","project":"burn-wizard","pipeline":"refactor-auth-middleware","step_id":3}
{"ts":"...","phase":"pipeline","engine":"dispatch.mjs","outcome":"step-completed","project":"burn-wizard","pipeline":"refactor-auth-middleware","step_id":3,"step_outcome":"success"}
{"ts":"...","phase":"pipeline","engine":"dispatch.mjs","outcome":"pipeline-aborted","project":"burn-wizard","pipeline":"refactor-auth-middleware","reason":"consecutive_step_failures:2"}
```

These entries flow through the existing `appendLog()` path → fleet.mjs → gist → dashboard. The fleet.mjs schema additions from this morning's commit (`066f868`) already surface `last_run_outcome` etc; pipeline outcomes naturally appear there.

**Dashboard surfacing — deferred to Phase A.1 (separate PR).** The existing per-machine card will start showing `last_task: "refactor"` and `last_run_reason: "pipeline:refactor-auth-middleware:step-3"` immediately because pipeline steps emit through the same JSONL path. A dedicated "Active pipelines" section in the dashboard is a follow-up.

**Failure modes handled:**

| Mode | Detection | Response |
|---|---|---|
| Malformed pipelines.json | Schema validation in buildProjectContext | Log warning, ignore file, fall through to LLM selector |
| Step references nonexistent task type | `validatePipelineDef` in schemas.mjs | Reject pipeline at load time |
| `depends_on` cycle | Pure-function cycle check at load | Reject pipeline at load time |
| Step crash mid-execution (no completed_ts) | 30-min staleness check in pickActivePipelineStep | Resume the step (idempotent; the worker uses the same auto/<slug>-<task>-<date> branch convention) |
| State file corruption | JSON parse error on read | Skip pipeline; operator must repair (no auto-recovery — state corruption shouldn't roll back silently) |
| Pipeline runs forever | `abort_on.consecutive_step_failures` (default 2) | Set `aborted: {reason}`, surface in JSONL |
| Codebase drift between steps | Per-step audit (C-1 cross-family) | Audit-critical → abort if `abort_on.audit_critical: true` |

---

### 7. Tests

**`scripts/lib/__tests__/pipelines.test.mjs`** — ~25 tests:

- `parsePipelineDef`: valid pipeline, missing required fields, invalid task type, depends_on cycle, depends_on reference to nonexistent step, schema_version mismatch.
- `applyStepOutcome`: success advances current_step_id, failure increments consecutive_failures, skip is no-op, reverted is treated like error.
- `evaluateAbortRules`: consecutive_failures triggers abort, audit_critical triggers abort, neither triggers no abort.
- `pickActivePipelineStep`: returns next unblocked step, skips blocked-by-depends_on, skips already-success, returns null if no active pipeline, skips pipelines with `active: false`, round-robin across multiple projects.
- `pickActivePipelineStep` timeout recovery: in-progress step older than 30min becomes runnable again.
- `advancePipelineState` integration test: write/read cycle through tmpdir, atomic write race (concurrent writes don't corrupt), corrupt state file returns null.
- `recordPipelineMerge`: finds matching step by branch, stamps merged_ts.

Test count: 392 → ~417 (matches the per-feature pattern of ~25 tests we've been hitting).

---

### 8. Documentation

**`docs/PIPELINES.md`** — new operator guide:

- What is a pipeline (when to write one vs leaf tasks)
- pipelines.json schema with annotated example
- Step lifecycle (queued → in-progress → success → merged)
- Abort rules + how to resume from a partial pipeline
- Interaction with auto-push gate stack (per-step PRs, per-step Overseer review)
- How to disable a pipeline (set `active: false` in pipelines.json)
- How to clear pipeline state (delete `ai/pipeline-state.json`)
- FAQ: "what if I want to write a pipeline that the dispatcher proposes?" → answer: see Phase B (sketched below)

---

## Phase B: `plan-feature` task type (sketch only; not in this PR)

A new task type `plan-feature` whose worker output is a pipelines.json entry written to `ai/pipelines.proposed.json` (separate file so operator review is required to promote).

**Workflow:**
1. Operator adds a wishlist entry to DISPATCH.md: `"plan-feature: refactor auth middleware"`.
2. Dispatcher selects this leaf task (existing path).
3. Worker (using gemini-2.5-pro, like the selector) reads project state, produces a pipeline definition with 4-8 steps + abort rules.
4. PR lands the new pipelines.proposed.json entry.
5. Overseer cross-family reviews the proposed pipeline (NEW: a pipeline-aware reviewer that checks for cycles, sane dependencies, reasonable scope).
6. If Overseer approves, label `pipeline:approved` lands. Operator adds a final manual gate (label `pipeline:activated`) before the entry merges into pipelines.json.
7. Once activated, Phase A's selector picks up the new pipeline on the next tick.

**Why not auto-promote on Overseer approval?** The seven-gate stack's whole architecture is "human stays in the loop on the design-level decisions." A pipeline IS a design decision. Operator activation is the final gate.

**Sketch only this session.** Phase A's foundation (schemas, state machine, selector pre-pass) makes Phase B a small additive change. Defer to a separate session after Phase A validates in a real pipeline run.

---

## Phase C: Greenfield (out of scope; future)

Acknowledged: bootstrap-project task type, blueprint templates, sandbox-prefixed auto-enrollment in rotation. Crosses the "objective-correctness vs creative-judgment" autonomy boundary from VEYDRIA-VISION.md. Should not ship until Phase A and Phase B have ~3 months of clean runs.

---

## Phase A implementation checklist

1. [ ] `scripts/lib/schemas.mjs`: add `pipelineDefSchema` + `pipelineStateSchema` + exported validators.
2. [ ] `scripts/lib/pipelines.mjs` (NEW): pure helpers (`parsePipelineDef`, `applyStepOutcome`, `evaluateAbortRules`, `pickActivePipelineStep`, `validatePipelineGraph` for cycle check) + impure (`loadPipelineState`, `advancePipelineState`, `writeFileAtomic`).
3. [ ] `scripts/lib/__tests__/pipelines.test.mjs` (NEW): ~25 tests.
4. [ ] `scripts/lib/context.mjs:buildProjectContext()`: load pipelines.json, attach to context.
5. [ ] `scripts/lib/selector.mjs:selectProjectAndTask()`: pipeline pre-pass before LLM call.
6. [ ] `scripts/dispatch.mjs`: call `advancePipelineState` after verifyAndCommit.
7. [ ] `scripts/post-merge-monitor.mjs`: extend to call `recordPipelineMerge(branch)` on successful merge.
8. [ ] `docs/PIPELINES.md`: operator guide.
9. [ ] Cross-family PAL audit (gemini-2.5-pro per C-1).
10. [ ] Address CRITICAL/HIGH pre-commit; defer MEDIUM/LOW.
11. [ ] Single commit, local only — operator approves push.

**Estimated:** 700 LOC + 250 LOC tests in scripts/. ~30 min Plan + ~3 hours implementation + audit + commit.

---

## Open design questions

1. **Should pipeline state be in the gist for cross-machine visibility?** Currently the design has pipeline-state.json in each project directory (where the worker has write access). If two machines pick up the same project's pipeline at the same tick, the dispatch lock serializes them. But a pipeline running on machine A while machine B looks at the dashboard wouldn't see in-flight state. *Tradeoff:* gist write adds latency + a network failure mode; project-local file is fast + reliable. Recommendation: **stay project-local for Phase A**; reconsider for Phase A.1 (dashboard surfacing) if cross-machine pipeline visibility becomes important.

2. **Should `depends_on` be implicit (sequential by step id) or explicit (as designed)?** Explicit allows future parallelism (steps 3a + 3b both depend on step 2; both runnable). Sequential is simpler. *Recommendation:* **keep explicit** since the cost is one field per step and the future-proofing is real.

3. **Should the operator be able to skip a step?** A "skipped" outcome could mean "operator chose to bypass." Right now the design treats skip as "dispatch chose not to run this tick" (transient). To support operator-skip, add a `skip_step: <id>` field to pipeline-state.json that the operator can manually edit. *Recommendation:* **defer; not in Phase A.**

4. **Pipeline naming collision across projects?** Two projects can both have a pipeline named "refactor-auth"; the JSONL log entries include project slug so they're disambiguated. No issue.

---

## Approval gate

Operator review: does this design hold? Specifically:
- Is the pipelines.json shape ergonomic for hand-authoring?
- Are the abort rules sufficient (anything missing — e.g. "if cooling-off-paused for >24h, abort")?
- Is the boundary between Phase A (operator-authored pipelines) and Phase B (dispatcher-proposed pipelines) the right place to draw the line?
- Should I implement Phase A now in the same session, or hand off this design and ship in a separate session?

If approved: I implement Phase A in this session, run the cross-family PAL audit, commit locally, hand back for push approval.
