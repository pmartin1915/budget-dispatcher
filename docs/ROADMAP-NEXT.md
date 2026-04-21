# Dispatcher Roadmap: Good → Great → Professional

> Written 2026-04-21 after reviewing fleet data. PC dispatched 5 times in 2 hours
> (proposal, roadmap-review, self-audit cycles on sandbox-workflow-enhancement).
> Neighbor blocked on GEMINI_API_KEY env issue. Laptop always skips (user-active).

## Current State (honest assessment)

**What works:**
- Multi-machine fleet coordination via gist (PC active, Neighbor partially)
- Free-model routing with fallback chains (Gemini → Flash → Mistral)
- Activity gate, budget gate, daily quota — layered safety
- Cross-family auditing (C-1: generation and audit use different model families)
- Clinical gates on healthcare projects
- Config layering just shipped (shared.json + local.json)
- Dashboard with 8 tabs, real-time monitoring

**What doesn't work yet:**
- Neighbor blocked on env issue (fix ready, needs Perry to run it)
- Optiplex not onboarded
- Laptop never dispatches (always user-active — by design, but wastes a node)
- Zero dispatches on real projects (burn-wizard, wilderness, boardbound) — only sandbox work
- No measurement of whether dispatched work was *useful*

**The core tension:** The system is optimized for safety (fail-closed everywhere)
at the expense of output. Every gate is tuned to say "no." This was correct for
launch, but the fleet has been running for 10 days with zero incidents. Time to
carefully open the throttle.

---

## Phase 1: Close the Feedback Loop (highest impact)

### 1A. Value Ledger

**Problem:** We can't answer "what has the dispatcher done for me this week?"

**Solution:** After each successful dispatch, capture value metrics in the JSONL log:

```json
{
  "value": {
    "files_changed": 3,
    "lines_added": 45,
    "lines_removed": 12,
    "branch": "auto/burn-wizard-audit-20260421",
    "commit_sha": "abc1234"
  }
}
```

**Implementation:** In `worker.mjs`, after `verifyAndCommit()` succeeds, run
`git diff --stat HEAD~1` on the worktree and parse the output. Add the `value`
object to the log entry. ~30 lines of code.

**Dashboard:** New "Value" card on Status tab showing this week's totals.
New "Value Over Time" chart on Analytics tab.

### 1B. Merge Tracker

**Problem:** Auto branches are created but there's no feedback on whether
Perry found them useful (merged, ignored, deleted).

**Solution:** New script `scripts/track-merges.mjs` that:
1. Lists all `auto/*` branches across rotation projects
2. Checks if a PR exists (via `gh pr list --head <branch>`)
3. Records state: `open`, `merged`, `closed`, `no-pr`, `stale` (>7 days, no PR)
4. Writes to `status/merge-tracker.json`
5. Feeds merge-rate per (project, taskClass) back into selector prompt

**Selector improvement:** "audit tasks on burn-wizard have 60% merge rate.
refactor tasks on sandbox have 10% merge rate. Prefer high-merge-rate tasks."

**Dashboard:** Merge funnel on Analytics tab: Created → PR opened → Merged.
Success rate by project and task type.

### 1C. Stale Branch Cleanup

Auto branches that sit for 14+ days with no PR should be auto-deleted
from the remote. Log the cleanup. This keeps the branch list actionable
rather than growing unbounded.

---

## Phase 2: Remote Visibility

### 2A. GitHub Pages Fleet Dashboard

**Problem:** Can only view dashboard from the machine running it.

**Solution:** Static HTML page hosted on GitHub Pages that reads from the fleet gist.
Same Tokyonight palette. Shows:
- Machine status cards (green/yellow/red beacons)
- Last dispatch info per machine
- Weekly value metrics (from gist)
- Fleet health summary

**Why gist-based:** Zero infrastructure. The gist is already being updated
by every machine every 20 minutes. The Pages site just renders it.

**Implementation:** Single `docs/fleet-dashboard.html` file. GitHub Pages
serves from `/docs`. ~200 lines of HTML/CSS/JS. Fetch the gist via
`https://api.github.com/gists/<id>` (no auth needed for public gists).

Perry can check fleet health from his phone between patients.

### 2B. ntfy Notifications

Already wired (`alerting` config block). Needs:
- Turn on for PC (primary alerting node)
- Add positive notifications: "First successful dispatch today" 
- Add weekly summary push: "This week: 12 dispatches, 3 merged, 156 lines changed"

---

## Phase 3: Graduate to Real Projects

### 3A. The Sandbox → Production Pipeline

The fleet has proven reliability on sandbox projects. The next step is
carefully enabling real project work:

1. **Start with read-only tasks on real projects.** `test`, `typecheck`, `audit`
   tasks don't modify code — they just report status. These are already in
   the task lists for burn-wizard, wilderness, etc. The gate just needs to
   pass (engine=node bypasses budget gate, activity gate is the only blocker).

2. **Activity gate on non-laptop machines.** The PC and Neighbor/Optiplex
   don't have active Claude Code sessions. Their activity gate should almost
   always pass (unless Perry remotes in). This means they CAN dispatch on
   real projects — they're just pointed at sandboxes.

3. **Expand PC/Neighbor rotation to include real projects.** Add burn-wizard,
   wilderness, boardbound to their local.json project lists. Start with
   `test` and `audit` tasks only. This is the single highest-leverage change
   for making the system produce real value.

### 3B. Laptop as Monitor, Not Dispatcher

Accept that the laptop is Perry's primary work machine. It will never pass
the activity gate during waking hours. Its role should be:
- Dashboard host (already)
- Config management (already)
- Manual `--force` dispatches for testing

Remove the scheduled task from the laptop entirely. It just wastes cycles
checking idle status and logging skips.

---

## Phase 4: Operational Maturity

### 4A. Estimator Simplification

The trailing-30 math is a proxy for Claude Max weekly limits. Since the fleet
now runs on free models exclusively (`engine_override: "node"`), the Claude
budget gate is irrelevant. The real constraints are:

- **Free-tier rate limits:** Gemini 2.5 Pro = 25-50 RPD, Flash = 250-1500 RPD
- **Daily dispatch quota:** 8/day (configurable)
- **Activity gate:** 20 min idle

Simplify: remove the estimator entirely for node-engine runs. The daily quota
+ activity gate are sufficient. The estimator only matters if Perry ever
switches back to Claude engine.

### 4B. Integration Tests

The dispatch pipeline (gates → selector → router → worker → audit → commit)
has zero integration tests. Add a mock-mode flag that:
- Uses a fixture project (canary-test)
- Calls a mock provider (returns canned responses)
- Verifies the full pipeline produces a commit

Run in CI. Catches regressions before they hit the fleet.

### 4C. Capacity Planning

With 3 machines × 8 runs/day × 20min cycle = theoretical max 216 dispatches/day
(assuming perfect idle). Practical max is lower (activity gate, rate limits).

Track actual throughput vs theoretical max. Show utilization % on dashboard.
This tells Perry whether adding the Optiplex (or a 4th machine) is worth it.

---

## Phase 5: Portfolio / Showcase

### 5A. Architecture Diagram

Mermaid flowchart for the README:
```
Scheduled Task (every 20m)
  → Activity Gate (transcript mtime)
  → Budget Gate (weekly headroom) [node engine: skipped]
  → Daily Quota Gate
  → Selector (Gemini 2.5 Pro picks project + task)
  → Router (resolves model per task class)
  → Worker (calls provider, generates code)
  → Audit (cross-family model review)
  → Verify & Commit (test, typecheck, commit to auto/* branch)
  → Auto-push to origin
  → Fleet status update (gist)
```

### 5B. Metrics That Matter

For a portfolio/talk, the compelling numbers would be:
- "3-machine fleet, zero human intervention for N weeks"
- "X branches merged, Y lines of code improved autonomously"
- "100% clinical gate compliance — zero unsafe changes on healthcare projects"
- "Running on $0/month infrastructure (free-tier AI models, GitHub gist coordination)"

### 5C. Open-Source Prep

Strip machine-specific paths, add `.env.example`, write a 5-minute quickstart.
This is genuinely novel — multi-machine autonomous dev fleet on free-tier models
with clinical safety gates. Worth sharing.

---

## Recommended Next Actions (prioritized)

1. **Morning: Update PC + Neighbor + Optiplex** (migration script ready)
2. **Add real projects to PC/Neighbor rotation** (highest value unlock)
3. **Value ledger** in worker.mjs (~30 lines, immediate visibility)
4. **GitHub Pages dashboard** (~200 lines, phone visibility)
5. **Merge tracker** (closes the feedback loop)
6. **Remove scheduled task from laptop** (accept its role as monitor)
