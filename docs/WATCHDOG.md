# Dispatcher watchdog (P7)

Independent out-of-band fleet watchdog. Closes the last silent-failure gap.

## Why this exists

The dispatcher has four in-fleet detectors that fire when something breaks:

| Detector | What it catches |
|---|---|
| P3 wrapper auto-update breaker | Bad auto-pulls (3 consecutive post-pull dispatch failures) |
| C1 quota detection | Daily-quota 429s on free-tier model APIs |
| C2 fallback-rate degraded | Sustained deterministic-fallback usage |
| C3 per-project cooldown | Repeated failures on the same project |

But all four share the dispatcher's hosting environment: same `dispatch.mjs`,
same Windows scheduler, same JSONL log on the same disk, same ntfy topic. If
the dispatcher itself can't run -- scheduler hangs, Node crashes, the box
loses power, the JSONL log corrupts and can't be parsed -- **none** of those
detectors fire and you hear nothing. Silence is indistinguishable from
"fleet healthy" because the fleet's normal heartbeat IS quiet.

The watchdog runs **outside** that failure domain (GitHub Actions cron) and
alerts when no machine in the fleet has heartbeat'd recently.

## How it works

1. GitHub Actions runs `node scripts/watchdog.mjs` every 30 minutes.
2. The script fetches the status gist via the GitHub Gists API.
3. It enumerates every `fleet-<hostname>.json` file and reads `last_run_ts`
   (the timestamp of each machine's most recent JSONL entry, set by
   `scripts/lib/fleet.mjs`).
4. If the **freshest** `last_run_ts` across the entire fleet is older than
   2 hours, it posts to a dedicated ntfy topic.
5. Otherwise it exits silently.

The 2h threshold is hardcoded. Cron cadence is 30 min; 2h = 4 missed cycles
worth of silence before alerting.

## Why a separate ntfy topic

A watchdog ntfy is a different signal from a dispatcher ntfy. If they shared
a topic, watchdog firings would be lost in dispatcher noise. They are
deliberately on different topics so the watchdog signal is visually distinct
on your phone.

## Setup (one-time)

Add three secrets at
<https://github.com/pmartin1915/budget-dispatcher/settings/secrets/actions>:

| Secret | Value |
|---|---|
| `STATUS_GIST_ID` | The gist ID from `config/budget.json:status_gist_id`. |
| `WATCHDOG_NTFY_TOPIC` | A NEW ntfy topic name, distinct from `alerting.topic`. Suggested format: `perry-dispatcher-watchdog-<6 random chars>`. |
| `GIST_AUTH_TOKEN` | **Optional.** A GitHub PAT with `gist` read scope. Only needed if the status gist is secret. Skip if public. |

Then subscribe your ntfy phone app to the new topic.

## Verifying it works

After the secrets are set, trigger the workflow manually:

1. Go to <https://github.com/pmartin1915/budget-dispatcher/actions>.
2. Pick "Dispatcher watchdog" in the left sidebar.
3. Click "Run workflow" -> "Run workflow."
4. Wait ~30 seconds and refresh.

The run should be green. The "Run watchdog" step will print one of:

- `[watchdog] ok: fleet has fresh heartbeat` -- normal case, no alert sent.
- `[watchdog] ALERTED: ...` -- alert was posted. Check your phone.

To smoke-test the alert path itself, temporarily point `STATUS_GIST_ID` at a
gist with stale fleet files (or rename your real gist's `fleet-*.json` files
so the watchdog finds none) and re-run. You should get a notification.

## Disabling

To pause the watchdog without deleting it:

- Empty the `WATCHDOG_NTFY_TOPIC` secret. The workflow will still run, but
  `runWatchdog` skips with `reason: "no ntfyTopic"` and posts nothing.

To remove it entirely:

- Delete `.github/workflows/watchdog.yml` and re-deploy.

## Failure modes

The watchdog itself is hosted on GitHub Actions. If GitHub Actions is down,
the watchdog is silent. This is acceptable: the watchdog is the second tier
of detection, and a global GitHub outage is something you'll hear about
through other channels.

Per-fleet alert logic means dormant machines (laptop on monitor-only,
Neighbor env-blocked) never trigger false alerts on their own. As long as
ANY fleet machine heartbeats within the threshold window, the watchdog
stays quiet.

## Architecture notes

- `scripts/watchdog.mjs` is **pure Node, zero npm deps, zero imports from
  `scripts/lib/*`.** Hosting independence is the entire point: the watchdog
  must run even if the rest of the dispatcher source is broken. The
  `asciiSafeHeader` helper and ntfy POST idiom are duplicated inline rather
  than imported.
- Stateless. The stale check is wall-clock-based; rare cron double-fires
  send 2 alerts and that's fine.
- The freshness field is `last_run_ts`, not `last_dispatch_ts` (which is
  null on skip cycles, so most cycles) and not `computed_at` (which can be
  refreshed by the `fleet.mjs` CLI even when `dispatch.mjs` is broken).
- Tests live at `scripts/lib/__tests__/watchdog.test.mjs`. They inject
  `fetcher`, `poster`, and `now` via parameters -- no network, no FS.
