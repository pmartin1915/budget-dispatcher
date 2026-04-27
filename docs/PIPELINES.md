# Pipelines (multi-step dispatcher initiatives)

**Status:** Phase A — operator-authored pipelines. Phase B (`plan-feature`
task type that proposes pipelines) and Phase C (greenfield bootstrapping)
are tracked in `docs/PLAN-pipelines.md`.

## What is a pipeline?

A pipeline is an ordered sequence of leaf tasks (audit, refactor,
tests-gen, docs-gen, etc) the dispatcher executes step-by-step across cron
cycles. Each step lands its own `auto/<slug>-<task>-<date>` branch through
the existing seven-gate auto-push stack and gets reviewed by the Overseer
on the same terms as any other auto-task.

Pipelines exist for work that's too big for a single leaf task — refactors
spanning multiple files, multi-step research-then-implement initiatives,
audit-then-fix-then-retest cycles. The pipeline layer just sequences leaf
tasks; it doesn't change how any individual step runs.

## When to write a pipeline vs a leaf task

| Scenario | Use |
|---|---|
| One audit, one refactor, one test pass — independent | Leaf tasks (DISPATCH.md) |
| Survey → plan → execute → verify a non-trivial change | Pipeline |
| Each step's input depends on the previous step's output | Pipeline |
| Operator wants every step PR reviewed before next step starts | Pipeline (built-in via merged_ts gating) |
| Cosmetic cleanup on a single file | Leaf task |

## File locations

- **Definition:** `<project>/ai/pipelines.json` — operator-authored, **committed to repo**.
- **State:** `<project>/ai/pipeline-state.json` — dispatcher-mutated, **gitignored** (machine-local).

## Definition schema

`ai/pipelines.json`:

```json
{
  "schema_version": 1,
  "pipelines": [
    {
      "name": "refactor-auth-middleware",
      "description": "Replace cookie-based auth with JWT validation",
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
          "description": "Identify migration risk areas. Output goes to ai/audit-auth.md",
          "depends_on": [1]
        },
        {
          "id": 3,
          "task": "tests-gen",
          "target": "src/middleware/__tests__/auth.test.ts",
          "description": "Add characterization tests covering current cookie-based flow",
          "depends_on": [2]
        },
        {
          "id": 4,
          "task": "refactor",
          "target": "src/middleware/auth.ts",
          "description": "Add JWT validator alongside cookie read; both work in parallel",
          "depends_on": [3]
        }
      ],
      "abort_on": {
        "audit_critical": true,
        "consecutive_step_failures": 2
      }
    }
  ]
}
```

Top-level fields:
- `schema_version` (required, integer = 1)
- `pipelines[]` (required) — array of pipeline definitions

Per-pipeline fields:
- `name` (required) — lowercase + dashes/underscores; must be unique within the project
- `description` — human-readable
- `goal_signal` — informal description of what "done" looks like
- `active` — set to `false` to disable a pipeline without deleting it
- `steps[]` (required) — ordered list, each with:
  - `id` (required, integer ≥ 1) — unique within the pipeline
  - `task` (required, string) — must match a key in `TASK_TO_CLASS` (`audit`, `refactor`, `tests-gen`, `docs-gen`, `research`, etc; see `scripts/lib/router.mjs`)
  - `target` — informational; where the step's primary output goes
  - `description` — human-readable; the dispatcher does NOT pass this to the LLM yet (Phase A treats it as documentation only; Phase B will route it as worker context)
  - `model` — informational override (Phase A uses the project's normal task→model routing; this field is reserved for future per-step overrides)
  - `depends_on[]` — list of step ids that must be `success` AND `merged_ts` set before this step is runnable
- `abort_on`:
  - `audit_critical` (boolean) — if true, a step's audit returning critical findings aborts the pipeline
  - `consecutive_step_failures` (integer ≥ 1) — abort after N consecutive failures

## Step lifecycle

```
queued (no entry in step_states)
   ↓ selector pre-pass picks step → dispatcher logs "in-progress"
in-progress (started_ts stamped)
   ↓ worker + tests + audit + commit
success (completed_ts stamped, branch recorded, merged_ts NULL)
   ↓ auto-push gate stack: gate 1 firewall → gate 4 canary → gate 5 Overseer review → gate 6 cooling-off + merge
merged (merged_ts stamped by post-merge-monitor.mjs ~15 min after merge)
   ↓ next step's depends_on now satisfied
queued (next step)
```

## Why depends_on requires merged_ts (not just success)

Each step's worktree is created from the project's main branch. If step N-1
hasn't merged yet, step N's worktree won't see N-1's changes. The
`depends_on` check waits for `merged_ts` to ensure step N starts from a
codebase that includes step N-1's output.

**Cost:** with cooling-off at 45 min default, a 4-step pipeline takes
~4×45 min = 3 hours minimum end-to-end. Acceptable for non-trivial work
that a human would have planned over multiple days anyway.

**Workaround for parallel steps:** any step with no `depends_on` (or with
the same predecessor) can run in parallel on different cron ticks. So a
fan-out like steps 3a + 3b both depending on step 2 will both queue once
step 2 merges; the dispatcher will pick one on the next tick and the other
on the tick after.

## How a pipeline gets dispatched (selector pre-pass)

On every cron tick, before the LLM selector runs:

1. Selector loads each project's `pipelines.json` (already cached in
   `buildProjectContext`).
2. For each project with at least one `active: true` pipeline, the
   selector calls `pickActivePipelineStep`:
   - Filter to steps whose deps are satisfied (every dep is `success` +
     has `merged_ts`).
   - Skip steps with `outcome: "in-progress"` started <30 min ago (still
     in flight). Resume orphans (in-progress >30 min — the previous
     attempt likely crashed).
   - Round-robin across projects so one long pipeline doesn't starve
     others.
3. If a step is queued, the LLM selector is **skipped entirely**. Saves
   one Gemini Pro RPD per pipeline tick.
4. If no step is queued, the existing leaf-task selector runs as normal.

A pipeline pre-pass error (malformed `pipelines.json`, parse error, etc)
is logged and does **not** block the leaf-task fallback. Only the affected
project's pipeline is paused until the file is fixed.

## How a step records its outcome

After `verifyAndCommit` returns:

- `success` → step marked `success`, branch recorded, history appended,
  `consecutive_failures` reset. `merged_ts` stays null until the
  post-merge-monitor stamps it.
- `error` / `reverted` → step marked `failed`, history appended,
  `consecutive_failures` incremented. If `abort_on.audit_critical` and
  the audit returned critical findings, pipeline is aborted. If
  `consecutive_failures >= abort_on.consecutive_step_failures`,
  pipeline is aborted.
- `skipped` → no state mutation. The next tick will retry.

A pipeline-aborted JSONL entry is emitted alongside the step's regular
log entry, so `fleet.mjs` and the dashboard surface the abort.

## How merged_ts gets stamped

The Overseer's gate-6 merge step writes a `pending-merges.json` entry to
the status gist (this is also how gate 7's post-merge canary replay
works). Each entry includes the source `branch` field (added 2026-04-26
specifically for pipeline correlation).

The post-merge-monitor runs every cron tick on the dispatcher host. At
the start of each tick it scans every rotation project's
`ai/pipeline-state.json` for steps whose branch matches a pending-merges
entry. When it finds a match with `merged_ts: null`, it stamps the entry's
`merged_at_ms` as the step's `merged_ts`.

This means: a successfully-merged step's `merged_ts` is stamped within
~15 min of the actual GitHub merge (the post-merge-monitor's first
replay deadline drives the cadence). The next pipeline step becomes
runnable at that point.

## Operator workflows

### Activate a pipeline
1. Write `<project>/ai/pipelines.json` with `active: true`.
2. Commit and push (the file is in the repo, so all machines see it on
   next git pull).
3. Dispatcher picks up the next runnable step on its next cron tick.

### Pause a pipeline
1. Edit `<project>/ai/pipelines.json` and set `"active": false`.
2. Commit and push.
3. The current in-progress step (if any) finishes, but no further steps
   are queued.

### Resume an aborted pipeline
1. Read `<project>/ai/pipeline-state.json` — note the `aborted` reason.
2. Investigate the failing step's PR / log entries.
3. Either:
   - **Reset:** delete `pipeline-state.json` (the next cron tick starts
     the pipeline from step 1).
   - **Selective resume:** edit `pipeline-state.json` to remove the
     `aborted` field and set the failed step's `outcome: "pending"`.
     The dispatcher will retry from that step.

### Mark a step manually complete
Edit `pipeline-state.json` and set the step's `outcome: "success"`,
`merged_ts`: a recent ISO timestamp. The next tick will see the step as
done and advance.

### Inspect what's running
- JSONL log: `status/budget-dispatch-log.jsonl` — entries with
  `phase: "pipeline"` show step transitions.
- Fleet dashboard: each machine card shows `last_run_reason` like
  `pipeline:refactor-auth:step-3` when a pipeline step is queued.
- State file: `<project>/ai/pipeline-state.json` — the source of truth
  for pipeline progress.

## Failure modes and recovery

| Failure | Detection | Recovery |
|---|---|---|
| Malformed `pipelines.json` | Schema validator in `loadPipelineDef` | Logged warning; dispatcher falls through to leaf-task selector. Operator fixes file and commits. |
| `depends_on` cycle | Cycle check in `parsePipelineDef` | Pipeline rejected at load time; whole project's pipelines disabled until file is fixed. |
| Step references unknown task | `TASK_TO_CLASS` lookup in `parsePipelineDef` | Pipeline rejected at load time. |
| Step crashes mid-execution | `started_ts` >30 min stale | Step is treated as orphaned and re-tried on next tick. |
| `pipeline-state.json` corrupted | JSON parse error in `loadPipelineState` | State treated as missing; pipeline restarts from step 1. Operator should investigate. |
| Step's PR rejected by Overseer | `merged_ts` never stamped | Pipeline blocks at the next dependent step. Operator inspects the rejected PR, decides to fix or set `active: false`. |
| Codebase drift between steps | Per-step audit catches it | If `abort_on.audit_critical: true`, pipeline aborts. Otherwise step is marked `failed` and may eventually trigger `consecutive_step_failures` abort. |

## Limitations / future phases

**Phase A (this release):**
- Operator authors all pipelines manually.
- No dashboard panel yet — pipeline state visible via JSONL log + the
  per-machine card's `last_run_reason` chip.
- Step `description` is informational only; not yet routed as worker
  context.

**Phase B (planned, separate session):**
- New `plan-feature` task type that proposes pipelines based on a goal
  description. Output goes to `ai/pipelines.proposed.json`; operator
  manually promotes via label or merge.
- Dashboard panel showing all active/recently-completed/aborted pipelines
  fleet-wide.

**Phase C (deferred):**
- Greenfield project scaffolding from blueprints.
- Sandbox-only auto-enrollment in rotation.

See `docs/PLAN-pipelines.md` for the full design.
