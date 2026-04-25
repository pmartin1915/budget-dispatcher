// watchdog.mjs -- P7 independent out-of-band fleet watchdog.
//
// Runs on infrastructure independent of the dispatcher (GitHub Actions cron
// by default). Polls the shared status gist for per-machine fleet snapshots
// and posts to a *separate* ntfy topic when no machine has heartbeat'd
// recently. Closes the last silent-failure gap: if dispatch.mjs itself
// can't run (Windows scheduler hung, Node crashed, host down, JSONL log
// corrupted), the in-fleet detectors (P3, C1, C2, C3) all share the broken
// hosting environment and silently fail to fire. This watcher does not.
//
// Hosting independence is the entire point: this file imports NOTHING from
// scripts/lib/*. Pure Node, zero deps. Helpers (asciiSafeHeader, fetch
// idiom) are duplicated inline rather than imported.
//
// Freshness signal: fleet-<hostname>.json:last_run_ts (the most recent
// JSONL entry's timestamp). Not last_dispatch_ts (null on skip cycles,
// which is most cycles) and not computed_at (set inside computeFleet,
// which has a CLI entrypoint and could be refreshed by something other
// than dispatch.mjs running).
//
// Alert rule: max-heartbeat across the fleet. If NO fleet-*.json has a
// last_run_ts within the threshold window, fire. Cleanly handles dormant
// machines without enumerating them.
//
// Idempotency: stateless. The stale check is wall-clock-based; rare cron
// double-fires send 2 alerts and that's fine.

import { pathToFileURL } from "node:url";

const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h
const GIST_TIMEOUT_MS = 10_000;
const NTFY_TIMEOUT_MS = 10_000;
const USER_AGENT = "budget-dispatcher-watchdog";
const FLEET_FILE_RE = /^fleet-.+\.json$/;

/**
 * HTTP headers must be ASCII (ByteString). Mirrors alerting.mjs:asciiSafeHeader
 * (intentionally duplicated -- this file must not import from scripts/lib/*).
 */
function asciiSafeHeader(s) {
  return String(s)
    .replace(/[\u2013\u2014]/g, "-")  // en-dash, em-dash
    .replace(/[\u2018\u2019]/g, "'")  // smart single quotes
    .replace(/[\u201C\u201D]/g, '"')  // smart double quotes
    .replace(/\u2026/g, "...")        // ellipsis
    .replace(/[\r\n]/g, " ")
    .replace(/[^\x20-\x7E]/g, "?");
}

/**
 * Pure: given the raw `files` map from a gist payload + a clock + a
 * threshold, decide whether to alert and produce the body text.
 *
 * @param {{ files: Record<string, {content?: string}>, now: number, thresholdMs?: number }} args
 * @returns {{
 *   alert: boolean,
 *   reason: string,
 *   machines: Array<{ name: string, lastRunTs: string|null, ageMs: number|null, valid: boolean }>,
 *   freshestMs: number|null
 * }}
 */
export function evaluateFleetSilence({ files, now, thresholdMs = STALE_THRESHOLD_MS }) {
  const machines = [];
  let freshestMs = null;

  for (const [name, file] of Object.entries(files ?? {})) {
    if (!FLEET_FILE_RE.test(name)) continue;

    const content = file?.content;
    let snap = null;
    try {
      snap = JSON.parse(content ?? "");
    } catch {
      machines.push({ name, lastRunTs: null, ageMs: null, valid: false });
      continue;
    }

    const lastRunTs = typeof snap?.last_run_ts === "string" ? snap.last_run_ts : null;
    if (!lastRunTs) {
      machines.push({ name, lastRunTs: null, ageMs: null, valid: false });
      continue;
    }

    const tsMs = Date.parse(lastRunTs);
    if (!Number.isFinite(tsMs)) {
      machines.push({ name, lastRunTs, ageMs: null, valid: false });
      continue;
    }

    const ageMs = now - tsMs;
    machines.push({ name, lastRunTs, ageMs, valid: true });
    if (freshestMs === null || tsMs > freshestMs) freshestMs = tsMs;
  }

  if (machines.length === 0) {
    return { alert: true, reason: "no fleet snapshots found in gist", machines, freshestMs };
  }

  if (freshestMs === null) {
    return {
      alert: true,
      reason: `all ${machines.length} fleet snapshots malformed or missing last_run_ts`,
      machines,
      freshestMs,
    };
  }

  const ageMs = now - freshestMs;
  if (ageMs >= thresholdMs) {
    const ageH = (ageMs / 3_600_000).toFixed(1);
    return {
      alert: true,
      reason: `all ${machines.length} fleet machines silent for ${ageH}h (threshold ${(thresholdMs / 3_600_000).toFixed(1)}h)`,
      machines,
      freshestMs,
    };
  }

  return { alert: false, reason: "fleet has fresh heartbeat", machines, freshestMs };
}

/**
 * Default gist fetcher. GET https://api.github.com/gists/<id>. Returns the
 * parsed JSON body (which has a `files` map). Throws on non-2xx or timeout.
 *
 * @param {string} gistId
 * @param {{ token?: string }} [opts]
 * @returns {Promise<{ files: Record<string, {content?: string}> }>}
 */
export async function fetchGist(gistId, opts = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers,
    signal: AbortSignal.timeout(GIST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`gist fetch failed: HTTP ${resp.status} - ${body.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Default ntfy poster. Mirrors alerting.mjs:sendNtfy() exactly.
 *
 * @param {string} topic
 * @param {string} title
 * @param {string} body
 * @param {number} [priority=4]  -- 4 = "warning" tag (significant, not emergency)
 * @returns {Promise<boolean>} true if sent successfully
 */
export async function postNtfy(topic, title, body, priority = 4) {
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: asciiSafeHeader(title),
        Priority: String(priority),
        Tags: priority >= 4 ? "warning" : "white_check_mark",
      },
      body,
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[watchdog] ntfy.sh returned ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[watchdog] ntfy.sh send failed: ${e.message}`);
    return false;
  }
}

/**
 * Format the body of an alert ntfy. One line per machine showing age.
 */
function formatAlertBody({ reason, machines }) {
  const lines = [reason, ""];
  for (const m of machines) {
    if (!m.valid) {
      lines.push(`- ${m.name}: malformed snapshot`);
      continue;
    }
    const ageH = m.ageMs !== null ? (m.ageMs / 3_600_000).toFixed(1) : "?";
    lines.push(`- ${m.name}: last_run_ts=${m.lastRunTs} (${ageH}h ago)`);
  }
  return lines.join("\n");
}

/**
 * Orchestrator. Composes fetcher -> evaluate -> conditional poster.
 *
 * On unfetchable gist or unparseable top-level payload, logs a warning to
 * stderr and returns without alerting (per handoff: "don't double-alarm on
 * transient gist hiccups"). Per-file parse failures still count as silence
 * (handled inside evaluateFleetSilence).
 *
 * @param {{
 *   gistId: string,
 *   ntfyTopic: string,
 *   gistToken?: string,
 *   thresholdMs?: number,
 *   fetcher?: typeof fetchGist,
 *   poster?: typeof postNtfy,
 *   now?: number,
 * }} args
 * @returns {Promise<{ alerted: boolean, reason: string }>}
 */
export async function runWatchdog({
  gistId,
  ntfyTopic,
  gistToken,
  thresholdMs = STALE_THRESHOLD_MS,
  fetcher = fetchGist,
  poster = postNtfy,
  now = Date.now(),
}) {
  if (!gistId) {
    console.warn("[watchdog] no gistId provided; skipping");
    return { alerted: false, reason: "no gistId" };
  }
  if (!ntfyTopic) {
    console.warn("[watchdog] no ntfyTopic provided; skipping");
    return { alerted: false, reason: "no ntfyTopic" };
  }

  let gist;
  try {
    gist = await fetcher(gistId, { token: gistToken });
  } catch (e) {
    console.warn(`[watchdog] gist fetch failed: ${e.message}`);
    return { alerted: false, reason: `gist-fetch-failed: ${e.message}` };
  }

  const files = gist?.files;
  if (!files || typeof files !== "object") {
    console.warn("[watchdog] gist payload missing files map");
    return { alerted: false, reason: "gist-payload-malformed" };
  }

  const decision = evaluateFleetSilence({ files, now, thresholdMs });

  if (!decision.alert) {
    return { alerted: false, reason: decision.reason };
  }

  const body = formatAlertBody(decision);
  const sent = await poster(ntfyTopic, "Dispatcher fleet silent >2h", body);
  return { alerted: sent, reason: decision.reason };
}

// CLI entrypoint when invoked as `node scripts/watchdog.mjs`.
// Reads STATUS_GIST_ID, WATCHDOG_NTFY_TOPIC, GIST_AUTH_TOKEN from env only.
// Never logs the topic or token. Exits 0 always (Actions step is informational;
// non-zero would obscure the actual alert path, which is ntfy).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gistId = process.env.STATUS_GIST_ID;
  const ntfyTopic = process.env.WATCHDOG_NTFY_TOPIC;
  const gistToken = process.env.GIST_AUTH_TOKEN || undefined;

  const result = await runWatchdog({ gistId, ntfyTopic, gistToken });

  if (result.alerted) {
    console.log(`[watchdog] ALERTED: ${result.reason}`);
  } else {
    console.log(`[watchdog] ok: ${result.reason}`);
  }
  process.exit(0);
}
