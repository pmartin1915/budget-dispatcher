# Gemini Interim Operations — Monitoring budget-dispatcher Without Claude

**Written:** 2026-04-22 by opus-4-7
**Valid until:** Thursday 2026-04-24 (Perry's Claude subscription returns)
**Audience:** Perry, operating solo from perrypc or neighbor, driving via Gemini (CLI + Roo Code) until Claude is back.

---

## 0 · TL;DR

- **Daily driver:** Gemini CLI (`gemini` in a terminal) for quick "look at this repo and tell me X" tasks.
- **Structured work:** Roo Code in VS Code with a Gemini profile (instructions in §3).
- **Dispatcher itself:** keep hands off. It's healthy as of `34564b3` and self-heals. Just watch ntfy.
- **Model picks:**
  - **`gemini-3.0-flash-preview`** → interactive chat, status checks, quick "what's going on" questions. Fast + free.
  - **`gemini-2.5-pro`** → deeper investigations, reading code, writing docs, anything where accuracy > latency.
  - **`gemini-2.5-flash`** → middle ground; also what the dispatcher itself uses internally — don't change it.
- **Forbidden during interim:** schema changes, router rewrites, multi-file refactors. Those wait for Claude Thursday.

---

## 1 · Fix the PowerShell error on neighbor

The error `"...cannot be loaded because running scripts is disabled on this system"` means Windows is refusing to execute [`scripts/run-dispatcher.ps1`](scripts/run-dispatcher.ps1) (or the global npm shims for Gemini CLI) because your execution policy is `Restricted`.

### Fix — run once on neighbor, in an **elevated** PowerShell (Run as Administrator):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# Confirm:
Get-ExecutionPolicy -List
```

`RemoteSigned` = locally authored scripts run unsigned; anything downloaded from the internet must be signed. That's the right balance for your setup — `run-dispatcher.ps1` is local, so it runs; npm CLI shims are signed, so they run.

### If you can't elevate (e.g. corp policy locks it):

Run PS1 scripts ad-hoc by bypassing policy for a single invocation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-dispatcher.ps1
```

The scheduled task on neighbor should already use this form — check with:

```powershell
schtasks /query /tn "claude-budget-dispatcher" /v /fo LIST | findstr /I "task_to_run"
```

If it doesn't, fix the scheduled task's action to: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <path>\scripts\run-dispatcher.ps1`.

---

## 2 · Install Gemini CLI (if not already)

**On perrypc** — you said you're logged in, skip.

**On neighbor** (after §1):

```powershell
# Node should already be installed (dispatcher requires it).
npm install -g @google/gemini-cli

# First run — browser-based Google login, no API key needed for free tier:
gemini
```

On first launch it opens a browser, you sign in with your Google account, done. It stores creds in `%APPDATA%\gemini-cli\` (or similar).

**Gotcha:** if `npm install -g` errors about `EACCES` or permissions on neighbor, it's usually npm prefix pointing somewhere locked. Fix:

```powershell
npm config set prefix "$env:APPDATA\npm"
# Add %APPDATA%\npm to PATH in User environment variables if it isn't already
npm install -g @google/gemini-cli
```

---

## 3 · Add a Gemini profile to Roo Code (VS Code)

Roo Code stores provider profiles in VS Code's secret storage — there's no file I can write from here, so you click through it once:

1. Open VS Code → Roo Code panel (sidebar icon) → gear ⚙ → **"Providers"** or **"API Configuration"**.
2. **Add profile** → name it `gemini-interim`.
3. **Provider:** `Google Gemini`.
4. **API Key:** get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (sign in with same Google account as Gemini CLI).
5. **Model:** `gemini-2.5-pro` (set as default).
6. **Add a second profile** called `gemini-flash` using `gemini-3.0-flash-preview` (or `gemini-2.5-flash` if the 3.x isn't in the dropdown yet — both work, 3.x is faster).
7. Save.

**Switching:** bottom of the Roo Code chat panel, click the profile name → pick `gemini-interim` for big-brain work, `gemini-flash` for quick chat.

**Verify it works:** open a chat, ask *"summarize this workspace in one paragraph"*. If it responds and sees your files, you're set.

**Rate-limit reality:** AI Studio's free tier on `2.5-pro` is ~50 req/day; `flash` variants are far more generous. For all-day driving, default to `gemini-flash` and only flip to `gemini-interim` (pro) when you hit a wall.

---

## 4 · Daily monitoring ritual (~2 minutes)

Run this every morning and evening in a terminal at the repo root. Or paste it to Gemini CLI with *"explain what this tells me"*.

```powershell
# Last run outcome
type status\budget-dispatch-last-run.json

# Alerting state (want prev_state: "healthy")
type status\alerting-state.json

# Last 5 dispatch events
powershell -NoProfile -Command "Get-Content status/budget-dispatch-log.jsonl -Tail 5"

# Fleet health
type status\health.json
```

### What "healthy" looks like

- `budget-dispatch-last-run.json` → `"status": "success"`, timestamp within last 30 min (or last scheduled window).
- `alerting-state.json` → `"prev_state": "healthy"`.
- `budget-dispatch-log.jsonl` tail → recent `"outcome":"success"` entries, task variety (`research`, `typecheck`, `test`, etc.), no `"outcome":"error"` streak.
- `health.json` → all machines report recent `last_run` within their cadence.

### Red flags that mean "stop and read"

- `"reason":"dispatch-mjs-exit-2"` anywhere in the log → schema or config validation broke. That's the bug we just fixed; if it comes back, something regressed.
- `"reason":"task_not_allowed"` streak on the same project → cooldown loop (the issue in the gemini handoff). Widen the allowlist in [`config/local.json`](config/local.json) on the affected machine.
- `"reason":"gemini_call_failed"` multiple times in a row → likely Gemini free-tier rate limit hit. The dispatcher's [`scripts/lib/throttle.mjs`](scripts/lib/throttle.mjs) should back off automatically. If it doesn't, reduce dispatch frequency.
- ntfy silence > 24h → the heartbeat failed. Check the Windows scheduled task is still enabled.

---

## 5 · Runbook — "ntfy just told me something's wrong"

### A. "Dispatcher down" alert

1. Open a terminal at the repo root (perrypc or wherever).
2. Paste the monitoring commands in §4 and read the output.
3. Ask Gemini CLI (or Roo with the `gemini-flash` profile):
   ```
   Here's my budget-dispatch-log.jsonl tail and last-run.json. What's the
   most likely cause of the failure and what's the minimum-risk fix?
   Do NOT propose schema or router changes — those wait for Claude.
   ```
4. If Gemini's answer is "restart the scheduled task" or "clear a lock file", that's safe. If it's "edit budget.schema.json" or "change router logic", **stop** — defer to Claude Thursday unless the fleet is actually bleeding.

### B. "Degraded" alert (new post-`1d677c8`)

Means some machines are reporting but not all. Usually transient — neighbor or Optiplex offline/suspended. Confirm with:

```powershell
type status\health.json
```

Look at `last_run` per machine. If one is >2h stale, log into that PC and check the scheduled task / whether it's awake.

### C. Unknown / nothing obvious

Don't fix aggressively. Instead:

1. Run `node scripts/dispatch.mjs --force --dry-run` on perrypc — this tests config load + selector without side effects.
2. If that's green, the dispatcher core is fine. Likely transient.
3. If it errors, capture the error and save it to a scratch file — Claude can diagnose Thursday.

---

## 6 · What NOT to change until Thursday

Treat these as read-only surfaces. Gemini 3-flash is strong but doesn't have the context of how this whole system fits together that Claude has built up across dozens of sessions.

| Area                                                           | Why it's frozen                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`config/budget.schema.json`](config/budget.schema.json)       | Just widened (`c7d7568`). Further edits = regression risk.                       |
| [`scripts/lib/router.mjs`](scripts/lib/router.mjs)             | Model-routing logic with nuanced forbidden-models / fallback-chain semantics.    |
| [`scripts/lib/selector.mjs`](scripts/lib/selector.mjs)         | LLM-driven project picker; fragile prompt engineering.                           |
| [`config/shared.json`](config/shared.json) `alerting` block    | Just flipped to Phase 2 (`1d677c8`). Let it settle.                              |
| [`scripts/lib/health.mjs`](scripts/lib/health.mjs)             | `degraded`/`down` state machine; ties into alerting.                             |
| Anything in [`scripts/lib/__tests__/`](scripts/lib/__tests__/) | Don't add/remove tests interim — if they start failing, investigate with Claude. |

### What IS safe to do with Gemini

- Read code, summarize it, answer "how does X work" questions.
- Update docs in [`docs/`](docs/).
- Edit [`config/local.json`](config/local.json) per-machine allowlists (gitignored, blast radius = one PC).
- Write new non-dispatcher projects in sandboxes like `sandbox-game-adventure/`.
- Review and merge auto-branches the dispatcher creates (`auto/<project>-<task>-<ts>`).
- Triage + file issues/TODOs for Claude to tackle Thursday.

---

## 7 · Thursday handoff — coming back to Claude

When your Claude subscription returns:

1. Switch Roo Code back to your Claude profile via the bottom-panel dropdown.
2. Point the first Claude session at this doc + [`HANDOFF-2026-04-22-opus-schema-fix.md`](HANDOFF-2026-04-22-opus-schema-fix.md) so it has the full state of play.
3. Any issues Gemini deferred go into a "for-Claude-Thursday.md" note — create one if things pile up. Grep for `TODO(claude)` in the repo for breadcrumbs.
4. Gemini CLI stays installed; it's useful for free-tier background tasks even when Claude is the primary. The dispatcher itself keeps using `gemini-2.5-pro/flash` regardless of your interactive tool.

---

## 8 · Emergency brake

If something goes truly sideways and you need to stop the dispatcher fleet-wide right now:

```powershell
# On perrypc:
schtasks /change /tn "claude-budget-dispatcher" /disable
# Also do this on neighbor and optiplex via remote desktop or in person.
```

The dispatcher won't run again until you re-enable. Status files are preserved. Re-enable with `/enable` when ready.

There's also a softer kill switch in [`config/shared.json`](config/shared.json) — set some top-level `enabled: false` if we had one (we don't currently — all-or-nothing via the scheduled task).

---

## 9 · Quick cheat-sheet

```
gemini                              # interactive Gemini CLI (free, Google login)
gemini -p "prompt here" -y          # one-shot, auto-accept edits
gemini --model gemini-3.0-flash-preview    # fast/cheap
gemini --model gemini-2.5-pro              # big brain

# In VS Code Roo Code:
# Bottom of chat panel → profile picker → gemini-flash or gemini-interim
# /new to start fresh, /compact to summarize context, @file.ext to pin

# Dispatcher status one-liner:
type status\budget-dispatch-last-run.json && type status\alerting-state.json

# Safe full verification:
node scripts/dispatch.mjs --force --dry-run
```

---

*End of interim ops doc. See you Thursday.*
