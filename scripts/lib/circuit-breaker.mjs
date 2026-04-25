// circuit-breaker.mjs -- pure-function counter logic for the auto-update
// circuit breaker (P3, 2026-04-25 handoff).
//
// The wrapper auto-pulls origin/main before every cron cycle (287f818).
// Without a brake, a buggy commit propagates across the fleet on the next
// pulls. After freezeThreshold consecutive post-pull dispatch failures, this
// breaker freezes auto-update on the affected machine and signals a one-time
// fatal ntfy. Manual reset: rm status/last-auto-pull.json.
//
// All functions are pure. I/O lives in circuit-breaker-cli.mjs.

const DEFAULT_FREEZE_THRESHOLD = 3;

export function freshState() {
  return {
    sha: null,
    pulled_at: null,
    post_pull_failures: 0,
    frozen: false,
    freeze_reason: null,
  };
}

// Read-only gate decision. Returns { shouldPull, frozen, sha, reason }.
export function evaluateGate(state) {
  if (state && state.frozen === true) {
    return {
      shouldPull: false,
      frozen: true,
      sha: state.sha ?? null,
      reason: state.freeze_reason ?? "frozen by circuit breaker",
    };
  }
  return {
    shouldPull: true,
    frozen: false,
    sha: state ? state.sha ?? null : null,
    reason: "open",
  };
}

// Called after a successful `git pull` that changed SHA. Resets the failure
// counter -- a new commit is a new chance for the cycle to succeed. Does NOT
// clear `frozen` here, because frozen state is only cleared by manual deletion
// of the state file (the `recordDispatchOutcome` path that sets frozen also
// records why; we don't auto-recover).
export function recordPullOutcome(state, newSha, now = new Date()) {
  const base = state ?? freshState();
  return {
    ...base,
    sha: newSha,
    pulled_at: now.toISOString(),
    post_pull_failures: 0,
  };
}

// Called after dispatch returns. exit 0 resets the counter; non-zero
// increments. On the transition that crosses the freezeThreshold, returns
// shouldFireFreezeNtfy: true so the caller can emit a one-time alert.
// Subsequent calls while already frozen do NOT re-signal the ntfy.
export function recordDispatchOutcome(
  state,
  exitCode,
  currentSha,
  freezeThreshold = DEFAULT_FREEZE_THRESHOLD,
  now = new Date(),
) {
  const base = state ?? freshState();
  const wasFrozen = base.frozen === true;

  if (exitCode === 0) {
    return {
      state: {
        ...base,
        post_pull_failures: 0,
      },
      shouldFireFreezeNtfy: false,
      freezeReason: null,
    };
  }

  const failures = (base.post_pull_failures ?? 0) + 1;

  if (failures >= freezeThreshold && !wasFrozen) {
    const reason = `${failures} consecutive post-pull failures at ${currentSha ?? "unknown SHA"}`;
    return {
      state: {
        ...base,
        post_pull_failures: failures,
        frozen: true,
        freeze_reason: reason,
        frozen_at: now.toISOString(),
      },
      shouldFireFreezeNtfy: true,
      freezeReason: reason,
    };
  }

  return {
    state: {
      ...base,
      post_pull_failures: failures,
    },
    shouldFireFreezeNtfy: false,
    freezeReason: null,
  };
}

export const _internals = { DEFAULT_FREEZE_THRESHOLD };
