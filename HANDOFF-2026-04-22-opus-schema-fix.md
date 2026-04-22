# Handoff — 2026-04-22 — Opus (schema fix + Phase 2 alerting enabled)

**Author:** opus-4-7 (code mode) on perrypc
**Session window:** ~15:00Z – 16:03Z (10:00 – 11:03 CT)
**Predecessor:** [`HANDOFF-2026-04-22-gemini-handoff.md`](HANDOFF-2026-04-22-gemini-handoff.md) (gemini-2.5-pro, ~14:00Z)
**Repo state at handoff:** `origin/main` @ `1d677c8` (ahead of `5c8ab80` by 2 commits)
**Fleet state at handoff:** perrypc = **healthy**, dispatching successfully. Neighbor + Optiplex will auto-recover on next pull.

---

## TL;DR

The dispatcher was hard-down overnight on perrypc. **Root cause was NOT the `task_not_allowed` cooldown loop the prior handoff warned about** — that had already been half-fixed. The real killer was a **JSON Schema validation regression**: perrypc had a local edit to [`config/shared.json`](config/shared.json) adding `"degraded"` to `alerting.on_transitions`, but [`config/budget.schema.json`](config/budget.schema.json:19)'s enum only listed `["down","idle","healthy"]`. Ajv rejected the merged config at dispatch.mjs startup with exit 2, before the selector ever ran. Every wrapper invocation from ~09:52Z onward logged `dispatch-mjs-exit-2`.

**Fix shipped:** widened the schema enum to include `"degraded"` (commit `c7d7568`), then enabled Phase 2 alerting fleet-wide (commit `1d677c8`). Perrypc has since run two successful cycles (`wilderness/typecheck` 15:32Z, `sandbox-game-adventure/research` 15:52Z real commit `501fb93`) and alerting-state flipped `down → healthy` with a recovery ntfy.

---

## Timeline (UTC)

| Time          | Event                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 04-22 ~09:52Z | First `dispatch-mjs-exit-2` — schema rejection begins. Prior sessions assumed it was the cooldown loop.                                    |
| 04-22 ~14:00Z | Gemini handoff written. Diagnosed it as `task_not_allowed` fallout; added `typecheck` to wilderness allowlist; recommended Perry hand off. |
| 04-22 15:08Z  | Opus session starts. Reads handoff.                                                                                                        |
| 04-22 15:12Z  | Confirms last logged error is still schema-exit-2, not cooldown. Diffs `shared.json` vs schema, spots `degraded` missing from enum.        |
| 04-22 15:16Z  | Widens schema enum in `config/budget.schema.json`. Dry-run succeeds (selector picks `sandbox-game-adventure/roadmap-review`).              |
| 04-22 15:20Z  | Commit `c7d7568` pushed. Postscript appended to gemini handoff.                                                                            |
| 04-22 15:32Z  | **First real success:** `wilderness/typecheck` passes, 6.4s.                                                                               |
| 04-22 15:52Z  | **Second real success:** `sandbox-game-adventure/research` via gemini-2.5-pro, 38.5s, commit `501fb93` (1 file, +52 lines).                |
| 04-22 14:57Z  | (earlier) alerting-state transitioned `down → healthy`, recovery ntfy fired.                                                               |
| 04-22 16:03Z  | Perry approves pushing `shared.json`. Commit `1d677c8` lands — Phase 2 alerting now enabled fleet-wide.                                    |

---

## What changed in the repo this session

**Pushed to `origin/main`:**

1. **`c7d7568` — fix(schema): allow `degraded` in `alerting.on_transitions` enum**
   - [`config/budget.schema.json`](config/budget.schema.json:19): enum was `["down","idle","healthy"]`, now `["down","idle","healthy","degraded"]`.
   - Postscript appended to [`HANDOFF-2026-04-22-gemini-handoff.md`](HANDOFF-2026-04-22-gemini-handoff.md) documenting real root cause.

2. **`1d677c8` — feat(alerting): enable Phase 2 alerting fleet-wide**
   - [`config/shared.json`](config/shared.json): `alerting.enabled: false → true`, `on_transitions: ["down"] → ["down","degraded"]`.
   - Safe because `c7d7568` already widened the schema — neighbor/optiplex will validate cleanly on pull.

**Local only (gitignored, perrypc-only):**

3. [`config/local.json`](config/local.json): added `test` and `typecheck` to `combo` and `boardbound` `opportunistic_tasks`. Safety net to prevent future `task_not_allowed` cooldown loops on real projects. Does not propagate.

---

## Current fleet status

| Machine                        | State                  | Notes                                                                                                                                                                 |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **perrypc**                    | ✅ healthy, dispatching | Two successful runs post-fix. Schedule continues via [`scripts/run-dispatcher.ps1`](scripts/run-dispatcher.ps1).                                                      |
| **neighbor (desktop-tojgbg2)** | ⚠️ will recover on pull | Was unaffected by the schema bug (their `shared.json` from origin didn't have `"degraded"`). After `git pull` they get the widened schema + Phase 2 alerting enabled. |
| **Optiplex (desktop-p7h5aj1)** | ⚠️ will recover on pull | Same as neighbor.                                                                                                                                                     |
| **laptop**                     | n/a                    | Dev-only, not dispatching.                                                                                                                                            |

---

## What to watch next

1. **Neighbor + Optiplex pull cadence.** They need to `git pull` to pick up `c7d7568` and `1d677c8`. If their schedulers are still running (which they are), they'll pull on their next wrapper cycle via [`scripts/run-dispatcher.ps1`](scripts/run-dispatcher.ps1)'s pre-dispatch `git fetch/pull`. Monitor ntfy — if either goes quiet for >2h, check their logs.

2. **`degraded` alerting semantics.** Phase 2 is now live. Per [`scripts/lib/health.mjs`](scripts/lib/health.mjs), `degraded` fires when some but not all machines report recent runs. This is **more sensitive** than the old `down` gate. Expect some initial noise as the fleet normalizes; if it's too chatty, consider adding a `min_consecutive_cycles` debounce or narrowing `on_transitions` back to `["down"]`.

3. **`status/alerting-state.json`** is now tracking state normally (`prev_state: "healthy"`, `last_alert_ts: 2026-04-22T14:57:20.668Z`). Don't manually edit unless you're intentionally suppressing a transition.

4. **The `task_not_allowed` cooldown issue** from the prior handoff is no longer acute, but it's a latent footgun. [`config/local.json`](config/local.json) has the perrypc-only fix. Consider whether `test`/`typecheck` should be allowlisted in `shared.json` for `combo`/`boardbound` globally — that's a design call, not a blocker.

---

## Open threads / known gotchas

- **`ntfy.sh` "idle" alert you received** was correct — perrypc genuinely was idle from ~09:52Z to 15:32Z (~5.5h). The alerting system worked; the dispatcher just had nothing to report because it was crashing at startup.
- **No `status/alerting-state.json` edit needed** — it self-corrected when the first successful cycle ran. Originally I planned to leave `prev_state: "down"` to force a recovery notification, but the first healthy cycle handled it automatically.
- **`config/budget.example.json`** was not updated in this session. If someone bootstraps a new machine from the example, they'll get `["down"]` only. Not urgent — the schema accepts either value — but worth updating next pass for consistency.

---

## What the next agent should NOT do

Same rules as the gemini handoff carry forward:

1. **Don't force-push or rewrite history.** `1d677c8` and `c7d7568` are now canonical.
2. **Don't disable alerting** in `shared.json` without checking in with Perry — it was deliberately turned on this session.
3. **Don't manually edit `status/*.json`** on perrypc. The dispatcher owns those files.
4. **Don't re-run the 15:52Z `sandbox-game-adventure/research` commit.** It's real work product on branch `auto/sandbox-game-adventure-research-20260422155218` — review and merge or discard per normal workflow.

---

## Quick verification commands

```powershell
# Confirm dispatcher is green
node scripts/dispatch.mjs --force --dry-run

# Check last real run outcome
type status\budget-dispatch-last-run.json

# Tail the dispatch log
powershell -NoProfile -Command "Get-Content status/budget-dispatch-log.jsonl -Tail 10"

# Confirm alerting state
type status\alerting-state.json

# Confirm both fix commits are on origin
git log --oneline origin/main -5
```

Expected: last run `status: "success"`, alerting `prev_state: "healthy"`, git log shows `1d677c8` then `c7d7568` on top.

---

*End of handoff. Dispatcher is green. Phase 2 alerting is live. Neighbor + Optiplex self-heal on pull.*
