// pipelines.mjs — Multi-step pipeline support for the dispatcher.
//
// A pipeline is an ordered sequence of leaf tasks (audit, refactor, etc)
// the dispatcher executes step-by-step across cron cycles. Each step lands
// its own auto/<slug>-<task>-<date> branch through the existing seven-gate
// auto-push stack; the pipeline layer just sequences them.
//
// Two files per project:
//   ai/pipelines.json       -- operator-authored pipeline definitions (committed)
//   ai/pipeline-state.json  -- dispatcher-mutated execution state (gitignored)
//
// Phase A scope (PLAN-pipelines.md):
//   - Operator-authored pipelines (no proposal layer yet — that's Phase B)
//   - depends_on requires the dependency's PR to have MERGED, not just
//     committed locally. This ensures step N's worktree (created from main)
//     sees step N-1's changes. Tradeoff: a 4-step pipeline needs 4*~45min
//     of cooling-off + execution, but the work is reliable.
//   - Audit-critical findings + N consecutive failures abort the pipeline.
//   - Project-local state file (no gist sync in Phase A).

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { TASK_TO_CLASS } from "./router.mjs";
import { validatePipelineDef, validatePipelineState } from "./schemas.mjs";

const PIPELINES_FILENAME = "pipelines.json";
const PIPELINE_STATE_FILENAME = "pipeline-state.json";
// In-progress steps older than this are treated as orphaned (the worker
// crashed mid-cycle; resume on next tick). 30 min is well past any
// reasonable single-cycle duration.
const ORPHAN_TIMEOUT_MS = 30 * 60_000;
const SCHEMA_VERSION = 1;

// ===========================================================================
// Pure helpers (no I/O; easy to test)
// ===========================================================================

/**
 * Validate a pipeline definition against the schema and structural rules
 * (depends_on graph is acyclic, all referenced tasks exist in TASK_TO_CLASS).
 * Returns {ok: true, def} on success or {ok: false, errors} on failure.
 *
 * @param {unknown} raw - Parsed pipelines.json
 * @returns {{ok: true, def: object} | {ok: false, errors: string[]}}
 */
export function parsePipelineDef(raw) {
  const schemaCheck = validatePipelineDef(raw);
  if (!schemaCheck.ok) return { ok: false, errors: schemaCheck.errors };
  const errors = [];
  for (const pipeline of raw.pipelines) {
    const stepIds = new Set(pipeline.steps.map((s) => s.id));
    if (stepIds.size !== pipeline.steps.length) {
      errors.push(`pipeline "${pipeline.name}": duplicate step ids`);
    }
    // Validate task taxonomy.
    for (const step of pipeline.steps) {
      if (!Object.prototype.hasOwnProperty.call(TASK_TO_CLASS, step.task)) {
        errors.push(`pipeline "${pipeline.name}" step ${step.id}: unknown task "${step.task}"`);
      }
    }
    // depends_on references must point at existing step ids in the same
    // pipeline, and the dependency graph must be acyclic. A self-reference
    // (id N depends on id N) is also a cycle.
    for (const step of pipeline.steps) {
      const deps = step.depends_on ?? [];
      for (const dep of deps) {
        if (dep === step.id) {
          errors.push(`pipeline "${pipeline.name}" step ${step.id}: self-dependency`);
        }
        if (!stepIds.has(dep)) {
          errors.push(`pipeline "${pipeline.name}" step ${step.id}: depends_on missing step ${dep}`);
        }
      }
    }
    if (hasDependencyCycle(pipeline.steps)) {
      errors.push(`pipeline "${pipeline.name}": depends_on graph has a cycle`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, def: raw };
}

/**
 * Detect a cycle in the depends_on graph. Returns true if any cycle exists.
 * Iterative DFS with three-color marking (WHITE=unvisited, GRAY=on-stack,
 * BLACK=finished). A back-edge to a GRAY node is a cycle.
 *
 * @param {Array<{id: number, depends_on?: number[]}>} steps
 * @returns {boolean}
 */
export function hasDependencyCycle(steps) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const adj = new Map();
  for (const s of steps) {
    color.set(s.id, WHITE);
    adj.set(s.id, s.depends_on ?? []);
  }
  for (const s of steps) {
    if (color.get(s.id) !== WHITE) continue;
    const stack = [{ id: s.id, idx: 0 }];
    color.set(s.id, GRAY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const deps = adj.get(top.id) ?? [];
      if (top.idx >= deps.length) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const next = deps[top.idx];
      top.idx++;
      const c = color.get(next);
      if (c === GRAY) return true;          // back-edge -> cycle
      if (c === WHITE) {
        color.set(next, GRAY);
        stack.push({ id: next, idx: 0 });
      }
      // BLACK -> already finished, no cycle through here
    }
  }
  return false;
}

/**
 * Decide which step (if any) of a pipeline is currently runnable. A step
 * is runnable when:
 *   - Its outcome is missing, "pending", or "in-progress" with started_ts
 *     older than ORPHAN_TIMEOUT_MS (orphan recovery).
 *   - All its depends_on dependencies have outcome "success" AND merged_ts set
 *     (we can't start step N's worktree off main until step N-1 is merged
 *     into main).
 *   - The pipeline is not aborted.
 *
 * Returns the step object or null. Pure; takes both pipeline definition
 * and current state as plain objects.
 *
 * @param {object} pipelineDef - One entry from pipelines.json:pipelines[]
 * @param {object} state - Pipeline state file contents
 * @param {number} [now=Date.now()] - Clock injection for tests
 * @returns {object|null}
 */
export function findRunnableStep(pipelineDef, state, now = Date.now()) {
  if (state?.aborted) return null;
  const stepStates = state?.step_states ?? {};
  // Sort by id so we always try lower-id steps first when both are
  // runnable. Operator-authored pipelines tend to put logical-order
  // steps in id order; this matches expectation.
  const sortedSteps = [...pipelineDef.steps].sort((a, b) => a.id - b.id);
  for (const step of sortedSteps) {
    const ss = stepStates[String(step.id)];
    if (ss?.outcome === "success") continue;       // already done
    if (ss?.outcome === "failed") continue;        // failed; advancement halted (abort_on rules govern resumption)
    if (ss?.outcome === "in-progress") {
      const startedMs = ss.started_ts ? new Date(ss.started_ts).getTime() : 0;
      // Resume orphaned steps; otherwise leave for the in-flight cycle to finish.
      if (Number.isFinite(startedMs) && now - startedMs < ORPHAN_TIMEOUT_MS) {
        continue;
      }
    }
    // Check depends_on: every dep must be in success state with merged_ts.
    const deps = step.depends_on ?? [];
    let blocked = false;
    for (const dep of deps) {
      const depState = stepStates[String(dep)];
      if (!depState || depState.outcome !== "success" || !depState.merged_ts) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    return step;
  }
  return null;
}

/**
 * Apply a step outcome to pipeline state. Pure: takes old state + outcome
 * info, returns new state. Caller is responsible for atomic file writes.
 *
 * Outcome handling:
 *   - "success": mark step success, reset consecutive_failures.
 *   - "error" / "reverted": mark failed, increment consecutive_failures.
 *   - "skipped": no state mutation (the worker chose not to run this tick;
 *     leave the step in its prior status so a future tick re-tries).
 *   - "in-progress": stamp started_ts (called BEFORE worker runs).
 *
 * History entries are appended for terminal outcomes (success, error,
 * reverted) to give the operator a chronological audit trail.
 *
 * @param {object} prevState - Current pipeline state (may be empty {})
 * @param {object} args
 * @param {string} args.pipelineName
 * @param {number} args.stepId
 * @param {string} args.outcome - success | error | reverted | skipped | in-progress
 * @param {string|null} [args.branch]
 * @param {Date} [args.now=new Date()]
 * @returns {object} new state
 */
export function applyStepOutcome(prevState, { pipelineName, stepId, outcome, branch = null, now = new Date() }) {
  const nowIso = now.toISOString();
  const next = {
    schema_version: SCHEMA_VERSION,
    active_pipeline: pipelineName,
    current_step_id: stepId,
    step_states: { ...(prevState?.step_states ?? {}) },
    consecutive_failures: prevState?.consecutive_failures ?? 0,
    aborted: prevState?.aborted ?? null,
    history: [...(prevState?.history ?? [])],
  };
  const key = String(stepId);
  const prevStep = next.step_states[key] ?? {};

  if (outcome === "in-progress") {
    next.step_states[key] = {
      ...prevStep,
      outcome: "in-progress",
      started_ts: nowIso,
    };
    return next;
  }
  if (outcome === "skipped") {
    // No-op on the step's recorded state — the worker chose not to run.
    // The next pickActivePipelineStep call will try again.
    return next;
  }
  if (outcome === "success") {
    next.step_states[key] = {
      ...prevStep,
      outcome: "success",
      completed_ts: nowIso,
      // Preserve started_ts if it existed; stamp it now if "in-progress" was skipped.
      started_ts: prevStep.started_ts ?? nowIso,
      branch: branch ?? prevStep.branch ?? null,
      merged_ts: prevStep.merged_ts ?? null,
    };
    next.consecutive_failures = 0;
    next.history.push({ step: stepId, outcome: "success", ts: nowIso });
    return next;
  }
  // Treat error and reverted as failures.
  if (outcome === "error" || outcome === "reverted") {
    next.step_states[key] = {
      ...prevStep,
      outcome: "failed",
      completed_ts: nowIso,
      started_ts: prevStep.started_ts ?? nowIso,
      branch: branch ?? prevStep.branch ?? null,
      reason: outcome,
    };
    next.consecutive_failures = (prevState?.consecutive_failures ?? 0) + 1;
    next.history.push({ step: stepId, outcome, ts: nowIso });
    return next;
  }
  // Unknown outcome: leave state unchanged. Defensive — never throw on a
  // novel outcome string from a future dispatcher revision.
  return next;
}

/**
 * Decide whether a pipeline should be aborted given current state and
 * pipeline-level abort_on rules. Pure.
 *
 * @param {object} state - Pipeline state
 * @param {object} pipelineDef - Pipeline definition (reads abort_on)
 * @param {object} [opts]
 * @param {boolean} [opts.lastStepAuditCritical=false] - Whether the most
 *   recent step's audit returned critical findings.
 * @returns {{abort: boolean, reason: string|null}}
 */
export function evaluateAbortRules(state, pipelineDef, { lastStepAuditCritical = false } = {}) {
  if (state?.aborted) return { abort: true, reason: state.aborted.reason ?? "previously-aborted" };
  const rules = pipelineDef?.abort_on ?? {};
  if (rules.audit_critical === true && lastStepAuditCritical) {
    return { abort: true, reason: "audit-critical" };
  }
  const failureLimit = rules.consecutive_step_failures;
  if (Number.isFinite(failureLimit) && (state?.consecutive_failures ?? 0) >= failureLimit) {
    return { abort: true, reason: `consecutive-step-failures:${failureLimit}` };
  }
  return { abort: false, reason: null };
}

/**
 * Stamp merged_ts on a pipeline step whose branch matches a freshly-merged
 * PR. Pure mutation of state object.
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @param {string} branch - Branch name from the merged PR
 * @param {string} mergedAtIso - ISO timestamp from the merge event
 * @returns {boolean} true if any step was updated
 */
export function stampMergedTs(state, branch, mergedAtIso) {
  if (!state?.step_states) return false;
  let mutated = false;
  for (const stepKey of Object.keys(state.step_states)) {
    const ss = state.step_states[stepKey];
    if (ss?.outcome !== "success") continue;
    if (ss.merged_ts) continue;       // already stamped
    if (ss.branch !== branch) continue;
    ss.merged_ts = mergedAtIso;
    mutated = true;
  }
  return mutated;
}

/**
 * Pick the next runnable step across all projects with active pipelines.
 * Round-robin'd over projects so a long pipeline on one project doesn't
 * starve another.
 *
 * @param {Array<{slug: string, config: object, pipelines?: object, pipelineStatePath?: string}>} contexts
 *   Per-project context objects (already filtered to those with DISPATCH.md).
 * @param {object} [opts]
 * @param {(path: string) => object|null} [opts.loadState] - Injectable state loader (defaults to loadPipelineState).
 * @param {number} [opts.now=Date.now()]
 * @returns {{projectSlug: string, projectConfig: object, pipelineName: string, step: object} | null}
 */
export function pickActivePipelineStep(contexts, { loadState = loadPipelineState, now = Date.now() } = {}) {
  // Build candidate list: (context, pipelineDef, runnableStep) tuples for
  // every project-with-active-pipeline-with-runnable-step.
  const candidates = [];
  for (const ctx of contexts) {
    if (!ctx?.pipelines?.pipelines) continue;
    const state = loadState(ctx.pipelineStatePath) ?? emptyState();
    for (const pipeline of ctx.pipelines.pipelines) {
      if (pipeline.active === false) continue;
      // If state is for a different pipeline, treat as fresh start for this
      // pipeline (operator may have swapped the active pipeline).
      const effectiveState = state.active_pipeline === pipeline.name ? state : emptyState();
      if (effectiveState.aborted) continue;
      const step = findRunnableStep(pipeline, effectiveState, now);
      if (step) {
        candidates.push({
          projectSlug: ctx.slug,
          projectConfig: ctx.config,
          pipelineName: pipeline.name,
          pipelineDef: pipeline,
          step,
          statePath: ctx.pipelineStatePath ?? null,
          activeContextLastTs: lastStepCompletionTs(effectiveState),
        });
      }
    }
  }
  if (candidates.length === 0) return null;
  // Round-robin: pick the candidate whose pipeline most-recently advanced
  // the LEAST (oldest last completion). Prevents one pipeline from
  // monopolizing dispatch when multiple are eligible.
  candidates.sort((a, b) => (a.activeContextLastTs ?? 0) - (b.activeContextLastTs ?? 0));
  const chosen = candidates[0];
  return {
    projectSlug: chosen.projectSlug,
    projectConfig: chosen.projectConfig,
    pipelineName: chosen.pipelineName,
    pipelineDef: chosen.pipelineDef,
    statePath: chosen.statePath,
    step: chosen.step,
  };
}

function lastStepCompletionTs(state) {
  let max = 0;
  for (const ss of Object.values(state?.step_states ?? {})) {
    const t = ss?.completed_ts ? new Date(ss.completed_ts).getTime() : 0;
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

function emptyState() {
  return {
    schema_version: SCHEMA_VERSION,
    active_pipeline: null,
    current_step_id: null,
    step_states: {},
    consecutive_failures: 0,
    aborted: null,
    history: [],
  };
}

// ===========================================================================
// Atomic write helper (extracted from circuit-breaker-cli.mjs pattern)
// ===========================================================================

/**
 * Atomic file write via write-temp-then-rename. Same-volume rename is
 * atomic on NTFS and POSIX; tmp lives in the same dir to keep that
 * assumption.
 *
 * @param {string} filePath - Destination
 * @param {string} content - Stringified content
 * @param {object} [fs] - Injectable fs for tests
 */
export function writeFileAtomic(filePath, content, fs = null) {
  const realFs = fs ?? { writeFileSync, renameSync, existsSync, rmSync, mkdirSync };
  const dir = dirname(filePath);
  if (!realFs.existsSync(dir)) realFs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    realFs.writeFileSync(tmpPath, content, "utf8");
    realFs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { if (realFs.existsSync(tmpPath)) realFs.rmSync(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

// ===========================================================================
// Impure helpers (read/write filesystem)
// ===========================================================================

/**
 * Load a pipeline state file. Returns null on missing/malformed file —
 * callers treat that as "no state, start fresh." Schema violations are
 * logged and treated as missing (defensive: don't crash on a hand-edited
 * state file that operator messed up; operator can delete it to reset).
 *
 * @param {string|null|undefined} statePath
 * @returns {object|null}
 */
export function loadPipelineState(statePath) {
  if (!statePath || !existsSync(statePath)) return null;
  let raw;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const check = validatePipelineState(parsed);
  if (!check.ok) {
    console.warn(`[pipelines] state file ${statePath} failed schema: ${check.errors.join("; ")}`);
    return null;
  }
  return parsed;
}

/**
 * Load + validate a pipelines.json file. Returns the parsed-and-validated
 * definitions object on success, null on missing/malformed (caller falls
 * through to leaf-task selector when null).
 *
 * @param {string} pipelinesPath
 * @returns {object|null}
 */
export function loadPipelineDef(pipelinesPath) {
  if (!pipelinesPath || !existsSync(pipelinesPath)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(pipelinesPath, "utf8"));
  } catch (e) {
    console.warn(`[pipelines] ${pipelinesPath} parse error: ${e.message}`);
    return null;
  }
  const parsed = parsePipelineDef(raw);
  if (!parsed.ok) {
    console.warn(`[pipelines] ${pipelinesPath} validation failed: ${parsed.errors.join("; ")}`);
    return null;
  }
  return parsed.def;
}

/**
 * Read state, apply outcome, write back atomically. End-to-end advance for
 * dispatch.mjs to call after verifyAndCommit.
 *
 * @param {object} args
 * @param {string} args.statePath - Absolute path to ai/pipeline-state.json
 * @param {string} args.pipelineName
 * @param {number} args.stepId
 * @param {string} args.outcome
 * @param {string|null} [args.branch]
 * @param {object|null} [args.pipelineDef] - For evaluating abort rules. If
 *   omitted, abort rules are not evaluated this tick.
 * @param {boolean} [args.lastStepAuditCritical=false]
 * @param {Date} [args.now=new Date()]
 * @returns {{written: boolean, aborted: boolean, abortReason: string|null}}
 */
export function advancePipelineState({ statePath, pipelineName, stepId, outcome, branch = null, pipelineDef = null, lastStepAuditCritical = false, now = new Date() }) {
  const prev = loadPipelineState(statePath) ?? emptyState();
  // PAL MEDIUM (2026-04-26 audit, continuation 973c6827): if a pipelineDef
  // is provided, ensure the pipelineName actually exists in it. Prevents
  // mid-flight rename / typo from writing state that references a
  // nonexistent pipeline (which pickActivePipelineStep would silently
  // discard as "stale state").
  if (pipelineDef) {
    const defShape = Array.isArray(pipelineDef?.pipelines)
      ? pipelineDef.pipelines    // full pipelines.json wrapper
      : [pipelineDef];           // single pipeline object (selector pre-pass passes this shape)
    const found = defShape.some((p) => p?.name === pipelineName);
    if (!found) {
      console.warn(
        `[pipelines] advancePipelineState: pipeline "${pipelineName}" not in provided definition; refusing state update`
      );
      return { written: false, aborted: !!prev.aborted, abortReason: prev.aborted?.reason ?? null };
    }
  }
  const next = applyStepOutcome(prev, { pipelineName, stepId, outcome, branch, now });
  let abortInfo = { abort: false, reason: null };
  if (pipelineDef) {
    abortInfo = evaluateAbortRules(next, pipelineDef, { lastStepAuditCritical });
    if (abortInfo.abort && !next.aborted) {
      next.aborted = { reason: abortInfo.reason, ts: now.toISOString() };
      next.history.push({ step: stepId, outcome: "pipeline-aborted", reason: abortInfo.reason, ts: now.toISOString() });
    }
  }
  try {
    writeFileAtomic(statePath, JSON.stringify(next, null, 2) + "\n");
    return { written: true, aborted: !!next.aborted, abortReason: next.aborted?.reason ?? null };
  } catch (e) {
    console.warn(`[pipelines] failed to write state ${statePath}: ${e.message}`);
    return { written: false, aborted: false, abortReason: null };
  }
}

/**
 * Walk pending-merges entries; for any entry whose `branch` matches a step
 * in any project's pipeline state where outcome=success and merged_ts is
 * unset, stamp merged_ts. Idempotent: re-runs are no-ops once the field
 * is filled in.
 *
 * Called from post-merge-monitor.mjs at the start of each tick so that
 * pipeline progression unblocks within ~15 min of the actual GitHub merge
 * (driven by post-merge-monitor's first replay deadline).
 *
 * @param {object} args
 * @param {Array<object>} args.entries - pending-merges entries
 * @param {Array<{slug: string, path: string}>} args.projects - rotation projects
 * @returns {{updates: number}}
 */
export function recordPipelineMerges({ entries, projects }) {
  let updates = 0;
  for (const project of projects ?? []) {
    if (!project?.path) continue;
    const statePath = resolve(project.path, "ai", PIPELINE_STATE_FILENAME);
    const state = loadPipelineState(statePath);
    if (!state) continue;
    let mutated = false;
    for (const entry of entries ?? []) {
      if (!entry?.branch) continue;
      const mergedAtIso = entry.merged_at_ms
        ? new Date(entry.merged_at_ms).toISOString()
        : (entry.merged_at_iso ?? new Date().toISOString());
      const did = stampMergedTs(state, entry.branch, mergedAtIso);
      if (did) {
        mutated = true;
        updates++;
      }
    }
    if (mutated) {
      try {
        writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
      } catch (e) {
        console.warn(`[pipelines] failed to write merged_ts to ${statePath}: ${e.message}`);
      }
    }
  }
  return { updates };
}

// Filename constants exported for callers that need to construct paths
// without duplicating string literals.
export const FILENAME = {
  pipelines: PIPELINES_FILENAME,
  state: PIPELINE_STATE_FILENAME,
};
