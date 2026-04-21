// Per-machine fleet snapshot. Reads the JSONL log and writes a summary of
// what this machine's dispatcher last did, for cross-machine visibility via
// the shared status gist.
//
// Two pairs of "last" fields by design:
//   last_run_*      -> most recent JSONL entry (wrapper-success, skipped,
//                      error). Shows "is this machine alive, when did it
//                      last check in."
//   last_dispatch_* -> most recent entry with outcome === "success" AND a
//                      populated project field. Shows "last time this
//                      machine actually committed code."
// Separation matters: a machine skipping user-active all day is alive, not
// dead. Keeping the two apart prevents the fleet view from looking red when
// it should look yellow-idle.

import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

function parseLines(raw) {
  // Split on LF or CRLF. PowerShell's Add-Content writes CRLF on Windows;
  // JSON.parse tolerates a trailing \r as whitespace (ECMA-404) so the old
  // `split("\n")` worked, but splitting on /\r?\n/ removes that dependency.
  return raw.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function computeFleet(logPath, machineName) {
  let entries = [];
  try {
    entries = parseLines(readFileSync(logPath, "utf8"));
  } catch {
    return {
      machine: machineName,
      last_run_ts: null,
      last_run_outcome: null,
      last_engine: null,
      wrapper_duration_sec: null,
      last_project: null,
      last_task: null,
      last_dispatch_outcome: null,
      last_dispatch_ts: null,
      last_error_reason: null,
      last_error_phase: null,
      last_error_ts: null,
      last_error_detail: null,
      last_error_model: null,
      last_error_retries: null,
      last_error_message: null,
      consecutive_errors: 0,
      computed_at: new Date().toISOString(),
    };
  }

  const lastRun = entries.length > 0 ? entries[entries.length - 1] : null;

  let lastDispatch = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.outcome === "success" && e.project) { lastDispatch = e; break; }
  }

  // Part 20: richest remote-debug signal. Most recent failure (error or
  // revert) so a laptop viewing fleet-<hostname>.json knows not just that
  // something went wrong but WHY and IN WHICH PHASE.
  //
  // Phase 1 of PLAN-smooth-error-handling-and-auto-update.md: also treat
  // selector-failed skips as "last error" material. They're outcome=skipped
  // structurally (no code ran) but represent the dispatcher trying-and-
  // breaking, which is exactly the signal a remote observer wants to see.
  let lastError = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const isStructuralSkip = e.outcome === "skipped" && e.reason === "selector-failed";
    if (e.outcome === "error" || e.outcome === "reverted" || isStructuralSkip) {
      lastError = e;
      break;
    }
  }

  // Consecutive error streak at tail. Mirrors health.mjs logic: skips and
  // dry-runs are neutral (don't break the streak); success and reverted
  // both break it. "reverted" means the dispatcher is running code, which
  // is the opposite of the "consecutive errors" failure mode we care about.
  let consecutiveErrors = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const o = entries[i].outcome;
    if (o === "error") consecutiveErrors++;
    else if (o === "skipped" || o === "dry-run" || o === "wrapper-success") continue;
    else break;
  }

  return {
    machine: machineName,
    last_run_ts: lastRun?.ts ?? null,
    last_run_outcome: lastRun?.outcome ?? null,
    last_engine: lastRun?.engine ?? null,
    wrapper_duration_sec: lastRun?.wrapper_duration_sec ?? null,
    last_project: lastDispatch?.project ?? null,
    last_task: lastDispatch?.task ?? null,
    last_dispatch_outcome: lastDispatch?.outcome ?? null,
    last_dispatch_ts: lastDispatch?.ts ?? null,
    last_error_reason: lastError?.reason ?? null,
    last_error_phase: lastError?.phase ?? null,
    last_error_ts: lastError?.ts ?? null,
    last_error_detail: lastError?.error_detail ?? null,
    last_error_model: lastError?.error_model ?? null,
    last_error_retries: lastError?.error_retries ?? null,
    last_error_message: lastError?.error_message ?? null,
    consecutive_errors: consecutiveErrors,
    computed_at: new Date().toISOString(),
  };
}

export function writeFleetFile(logPath, outPath, machineName) {
  const snap = computeFleet(logPath, machineName);
  writeFileSync(outPath, JSON.stringify(snap, null, 2));
  return snap;
}

// CLI: node scripts/lib/fleet.mjs <logPath> <outPath> [machineName]
// machineName defaults to os.hostname() lowercased. Override when hosts
// collide (e.g. two default DESKTOP-XXXX machines on different networks).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , logPath, outPath, machineArg] = process.argv;
  if (!logPath || !outPath) {
    console.error("Usage: node scripts/lib/fleet.mjs <logPath> <outPath> [machineName]");
    process.exit(1);
  }
  const machine = (machineArg || hostname()).toLowerCase();
  const snap = writeFleetFile(logPath, outPath, machine);
  console.log(`fleet: ${snap.machine} last_run=${snap.last_run_outcome ?? "none"} last_dispatch=${snap.last_project ?? "none"}`);
}
