# HANDOFF — claude-budget-dispatcher — 2026-04-14 (Part 3)

> **Purpose:** Self-contained briefing for a fresh Claude session on the laptop. Read this file, then execute.

---

## Required Reading (before doing anything)

Read these files in order — they contain the full context:

1. `docs/HANDOFF-2026-04-11.md` — original cross-model audit findings (C1-C4, H1-H3, M1-M5). All critical/high items are now FIXED.
2. `scripts/estimate-usage.mjs` — the zero-token gate engine (usage snapshot builder)
3. `scripts/check-idle.mjs` — portable activity detector (replaced GNU-only `find -newermt`)
4. `scripts/dispatch.mjs` — the main orchestrator (Proposal 008, Claude-free)
5. `config/budget.example.json` — full config reference (dry_run: true is the shipped default)
6. `tasks/budget-dispatch.md` — legacy Claude-prompt dispatcher (still valid as alt engine)
7. `status/usage-estimate.json` — current gate state (regenerated every run)

---

## Current State

| Metric | Value |
|--------|-------|
| Branch | main |
| Latest commit | `30268a7` fix: use direct .NET Process in run-dispatcher.ps1 node path |
| Tag | `v0.1.0-pre-live` |
| Audit fixes | All C1-C4, H1-H3 DONE |
| Proposals | 001-008 all shipped |
| Engine | `dispatch.mjs` (Node CLI, ~1-2K tokens/run) |
| dry_run | `true` (no real work runs) |
| Cron | Windows Task Scheduler, every 20 min |
| Monthly burn | ~37% (under pace, +6.58% headroom) |
| Weekly burn | ~103% (over pace, -2.81% headroom, BLOCKING) |
| Weekly reset | ~2026-04-21 02:08 UTC |

The dispatcher is running every 20 minutes but all recent runs are **skipped** — either `user-active` (Perry using Claude Code) or `weekly-reserve-floor-threatened` (weekend usage spike).

---

## R-2: Flip dry_run to false (recommended next item)

### Prerequisites

1. **Wait for weekly reset** (~2026-04-21). After reset, weekly budget replenishes and the weekly gate should open.
2. **Verify gates open** for 2-3 consecutive cycles in the dispatch log (`status/budget-dispatch-log.jsonl`). Look for runs where status would be `dispatched` instead of `skipped`.
3. **Confirm Perry's `budget.json`** has `projects_in_rotation` populated with real project paths (the example config has a placeholder).

### Execution

1. Open Perry's local `config/budget.json` (gitignored, not in repo).
2. Set `"dry_run": false`.
3. Ensure `projects_in_rotation` contains at least one project with low-risk `opportunistic_tasks` like `["test", "typecheck", "audit"]`. Avoid `refactor` or `docs_gen` for the first live run.
4. Monitor the next 2-3 dispatch cycles:
   - Check `status/budget-dispatch-last-run.json` after each run
   - Check `status/budget-dispatch-log.jsonl` for the full history
   - Verify: tests pass, commits land on `auto/*` branches cleanly, no unexpected side effects
5. If anything goes wrong: set `"paused": true` in budget.json OR create an empty file at `config/PAUSED` — either kill switch halts the dispatcher immediately.

### What "success" looks like

- A dispatch log entry with `"status": "completed"`, showing a real task was picked, executed, tested, and committed to a local auto-branch
- The auto-branch exists in the target project's git history
- No pushes to origin (H1 technical enforcement prevents this)
- Perry reviews and decides whether to merge the auto-branch

---

## Codereview Mandate

Before any significant code changes to this repo, run a cross-model audit:

```bash
# Via PAL MCP tools — use these 3 models:
mcp__pal__codereview  model: "pro"              # Gemini 2.5 Pro
mcp__pal__codereview  model: "codestral"        # Codestral (code specialist)
mcp__pal__codereview  model: "mistral-large"    # Mistral Large 2
```

All three must return no critical/high issues before merging. This is the same roster that validated the C1-C4/H1-H3 fixes.

**Model restrictions:**
- NEVER use `gemini-3-pro-preview` or `gemini3` — incurs separate Google Cloud billing
- Prefer `codestral` or `mistral-large` for bulk review (1B free tokens/month on Mistral)
- OpenRouter `:free` tier models are unreliable — use sparingly, serially

---

## Architecture (for reference)

```
Windows Task Scheduler (every 20 min)
  |
  dispatch.mjs (Node, ~1-2K tokens orchestration)
  |-- [GATE 1] estimate-usage.mjs -> usage-estimate.json (0 tokens)
  |-- [GATE 2] check-idle.mjs -> exit code 0=idle, 1=active (0 tokens)
  |-- [GATE 3] claude.exe process check (0 tokens)
  |-- [GATE 4] daily run count < max_runs_per_day (0 tokens)
  |
  IF ALL PASS:
  |-- [SELECTOR] Gemini API -> pick project + task (2-5K free tokens)
  |-- [ROUTER]   resolveModel -> Claude vs free-model delegate
  |-- [WORKER]   spawn subagent OR call mcp__pal__<tool> directly
  |-- [VERIFY]   run tests, git worktree ceremony (H1: origin removed)
  |-- [LOG]      append JSONL + write last-run marker
```

---

## Things NOT to Change (deliberate design decisions)

These were explicitly locked in by Perry. Do not modify without discussion:

1. **`dry_run: true` as default** — repo ships safe; first-run users can't hurt themselves
2. **Trailing-30-day anchoring** — no Anthropic quota API exists; this is the best estimator
3. **Local-auto-branch-only commit policy** — no auto-push, ever
4. **No fixed-hours allow-list** — activity-gated only, no hours window
5. **Two-layer architecture** (Node estimator + dispatcher) — Node layer is zero-cost no-op; don't fold into one Claude prompt
6. **Free-model roster `allow_only_listed_models: true`** — defense against accidental paid-model usage

---

## Known Issues (non-blocking)

- **Weekly reserve currently blocking** — Perry had a usage spike; will self-resolve at weekly reset
- **OpenRouter free-tier unreliable** — 429 rate limits, 404 endpoints, broken providers. Use Mistral direct + Google direct instead.
- **AWS Bedrock credentials expired** — Llama via Bedrock is dead until Perry refreshes creds (unlikely)
- **One parse error in logs** (2026-04-13 23:09:50) — transient snapshot read during regeneration, harmless

---

## Quick Commands

```bash
# Check current gate state
node scripts/estimate-usage.mjs

# Check if user is idle (20 min threshold)
node scripts/check-idle.mjs 20

# Dry-run dispatch (selector only, no work)
node scripts/dispatch.mjs --dry-run

# View last run
cat status/budget-dispatch-last-run.json

# View dispatch history
cat status/budget-dispatch-log.jsonl
```

---

## After R-2: What's Next

- **R-3:** Scale to multiple projects in rotation (add burn-wizard, wilderness)
- **R-4:** Tune `max_opportunistic_pct_per_run` based on observed per-task cost
- **R-5:** Add Slack/email notification on dispatch completion (optional)
- **Deep research questions Q1-Q5** from HANDOFF-2026-04-11 remain open for future refinement (baseline alternatives, dual-period design review, Anthropic quota API check)
