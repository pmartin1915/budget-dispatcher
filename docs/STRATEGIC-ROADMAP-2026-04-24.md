# Strategic Roadmap — Budget Dispatcher (2026-04-24)

**Supersedes:** `docs/ROADMAP-NEXT.md` (which was tactical/next-session). This is the zoom-out view, organized by horizon.

**Cadence:** Review + update every ~2 months, or whenever a horizon completes.

---

## Current State (2026-04-24)

| Dimension | State |
|---|---|
| Fleet size | 4 machines (perrypc, desktop-p7h5aj1, desktop-tojgbg2, perryslenovo-monitor) |
| Test coverage | 157/157 passing across 43 suites |
| Dispatches (all-time) | ~20 successful auto-branch commits (all on sandbox projects) |
| Real-project dispatches | **0** — no burn-wizard, wilderness, boardbound, medilex, ecg-wizard, combo work has been dispatched yet |
| PRs merged | **0 of ~20 open** — merge-rate feedback loop has no real signal yet |
| Incidents | 1 major (10h schema outage, fixed by `c7d7568`), several minor (MISTRAL_API_KEY inheritance, task-class over-cooling) |
| Currently | Fleet is **idle 22h** — cycling but every cycle skips. Diagnosis is the first action of the dispatcher chat. |

**Honest assessment:** the system is well-engineered but not yet producing much value. The sandbox-workflow-enhancement proposals are substantive, but none have been reviewed or merged. The canary-test PR #7 (Codestral cleaning dead code, 13 lines removed, 3 added, tests pass) is the clearest single proof that the pipeline *can* produce real value. Everything else so far is proposal-ware.

---

## Horizon 1 — Stabilize (next 2-4 weeks)

**Goal:** the fleet runs without human intervention for 2+ consecutive weeks, alerts when broken, and merges 3+ PRs Perry finds useful.

### Milestones

| # | Milestone | Owner | Status |
|---|---|---|---|
| 1.1 | Diagnose the 22h idle state and unblock dispatches | next dispatcher chat | **BLOCKING** |
| 1.2 | Review + merge or close the ~20 open sandbox PRs — need merge-rate signal | Perry (human) | pending |
| 1.3 | Ship Phase A: distributed gist locking (ETag + TTL + fencing) | dispatcher chat | planned |
| 1.4 | Add first real project to rotation (test/audit only, no write tasks) — candidate: burn-wizard with `test` task | dispatcher chat + Perry | planned |
| 1.5 | Verify Phase 2 degraded-state alerting fires correctly on a synthetic failure | dispatcher chat | planned |
| 1.6 | Phase 3: laptop-push → fleet auto-pull on next cycle (from existing `PLAN-smooth-error-handling-and-auto-update.md`) | dispatcher chat | planned |

### Success criteria

- Fleet uptime: 14 consecutive days without manual intervention.
- Dispatches per day: ≥3 on average.
- Merge rate: ≥30% on PRs older than 7 days.
- Alert time: structural failures page ntfy within 2 hours of occurrence.

### Risks

- If Horizon 1 never closes the merge-rate feedback loop (milestone 1.2), we spend Horizon 2 optimizing a system we can't measure.

---

## Horizon 2 — Harden (1-3 months)

**Goal:** the system can survive the classes of failures that have already happened. Phase B + C from the synthesized hardening plan.

### Milestones

| # | Milestone |
|---|---|
| 2.1 | Phase B: log rotation + streaming endpoints with `rotating-file-stream`. Prevents laptop-dashboard OOM as Veydria telemetry scales. |
| 2.2 | Phase C.1: LKG config fallback with `better-ajv-errors`. Prevents recurrence of the schema-enum incident. |
| 2.3 | Phase C.2: mocked integration tests (memfs + nock) covering the full Gates→Selector→Router→Worker→Audit→Commit pipeline. |
| 2.4 | Cross-machine merge tracker (gist follow-up noted in Phase 3 doc). Per-machine tracker + gist aggregation = selector sees cross-machine merge signal. |
| 2.5 | Archive the Cowork-bus concept if it's not actively used, or ship it. Currently it's in the plan but deferred. Make a decision. |
| 2.6 | Document the "runbook for operators" — what to do when the fleet is down, ntfy is down, or a PR is making bad changes. |

### Success criteria

- Zero silent failures in a 30-day window.
- Integration tests catch a class of regression before merge (verify by deliberately breaking schema in a test branch, confirming CI red).
- Dashboard handles a 100MB log without OOM.

### Risks

- Mocked integration tests are high-effort. If the real system is stable, the ROI drops. Budget-bound this milestone at 2 weeks; if not shipped, defer.

---

## Horizon 3 — Scale (3-6 months)

**Goal:** the dispatcher handles work on Perry's real projects, not just sandboxes. Worldbuilder enters rotation.

### Milestones

| # | Milestone |
|---|---|
| 3.1 | All 5 clinical projects (burn-wizard, medilex, ecg-wizard, wilderness, boardbound) in rotation with `test`, `typecheck`, `audit`. No write tasks yet. Clinical gate enforced. |
| 3.2 | Add `lore-audit` and `consistency-check` read-only task types for worldbuilder. Creative gate designed (parallel to clinical gate). |
| 3.3 | Add `slot-fill` task type for worldbuilder — populate mechanical details from templates. Write tasks allowed only through creative gate + PAL canon-consistency audit. |
| 3.4 | Optiplex graduates from sandbox-only to clinical test runner. PC graduates from sandbox-only to clinical + creative. |
| 3.5 | Selector prompt evolution: the proposals sandbox-workflow-enhancement produces about the selector itself start getting merged. This is the self-improvement loop actually closing. |
| 3.6 | Fleet dashboard PWA shows per-project merge rates, not just per-machine status. Perry can answer "which projects is the dispatcher actually helping me on?" from his phone in 30 seconds. |

### Success criteria

- Dispatches per day: ≥8 on average (up from 3 in Horizon 1).
- Clinical PR merge rate: ≥50% (higher than sandbox because clinical test/audit work has clearer correctness criteria).
- Worldbuilder read-only audits produce at least 1 accepted fix per week.
- Zero clinical-gate violations (no PR ever modifies `domain/` without gate approval).

### Risks

- Clinical projects are sensitive. A single false-positive audit report that looks plausible but is wrong could waste Perry's time. Tune audit prompts carefully; maintain the revert-on-critical safety net.
- Worldbuilder creative gate design is unsolved. Current canon is hand-authored by Perry and Opus 4.7 in Cowork; introducing autonomous write tasks requires a trust model Perry hasn't designed yet.

---

## Horizon 4 — Self-Improve (6-12 months)

**Goal:** the dispatcher meaningfully improves itself. Perry's role shifts from engineer to reviewer/curator.

### Milestones

| # | Milestone |
|---|---|
| 4.1 | Automated prompt A/B testing: the selector can run two prompt variants in parallel, compare merge rates, and propose the winner for Perry to accept. |
| 4.2 | Value ledger + merge tracker feed into a monthly "what did the fleet do for me?" digest pushed via ntfy. |
| 4.3 | Onboarding a new machine is a 10-minute process: clone repo, set 2 env vars, run `setup-newmachine.ps1`, fleet gist picks it up automatically. |
| 4.4 | Dispatcher suggests new task types to add to DISPATCH.md based on patterns it sees in Perry's own commit history. Perry accepts/rejects. |
| 4.5 | The dispatcher survives 60 days with zero manual intervention. |

### Success criteria

- Self-improvement rate measurable: at least one accepted selector prompt improvement per month that demonstrably raises merge rate.
- Perry's direct engagement with dispatcher code: ≤2 hours/month (down from the current ~10 hours/week).

### Risks

- The temptation to add features the dispatcher "could" do but Perry doesn't need. Every new feature is new surface area for silent failure. Be ruthless about declining.

---

## Cross-Horizon Concerns (ongoing throughout)

### Security

- No API key ever enters a git-tracked path.
- Scan sweep in `verify-commit.mjs` continues to block critical findings from committing.
- PAL codereview mandatory on hot-path changes (already enforced).

### Privacy / HIPAA

- Clinical gate blocks `domain/` writes on clinical projects without human override.
- No PHI in logs, commits, or gist state. Use synthetic test data (faker.js, pattern TESTMRN-XXXXX) for any generated test fixtures.

### Cost

- Free-tier only. If a provider moves to paid, remove it from the fallback chain. Do not silently fall back to Claude Max for work the free tier should handle.

### Operator fatigue

- No new docs, no new dashboards, no new concepts unless they replace something else. The system must get simpler over time, not more complex.

---

## Open Questions for Perry

These block forward motion if not answered:

1. **Which real project enters rotation first?** (Horizon 1.4) My vote: burn-wizard with `test` task only. Reason: it's your highest-care project, a regression there matters most, catching it via the dispatcher is the single most valuable thing the fleet could do. Alternative: boardbound (already has 741 tests, less scary if a false-positive audit happens).

2. **Worldbuilder write tasks — acceptable or permanently read-only?** (Horizon 3) The current design assumes eventually you'll trust the dispatcher with creative write work. If you don't — if worldbuilder should be permanently read-only to the dispatcher — drop milestone 3.3 and simplify the creative gate.

3. **What counts as "merge-worthy" on a sandbox PR?** (Horizon 1.2) The ~20 open sandbox PRs need dispositions. Do you want a batch-review session, or a passive close-if-not-reviewed-in-14-days policy?

4. **Should the dispatcher be extracted as an open-source project?** (meta-question) It's currently a personal tool. ROADMAP-NEXT mentioned a "Phase 5 portfolio/showcase." Is that still the vision? If yes, it changes Horizon 2-3 priorities (more docs, clearer abstractions, less Perry-specific).

---

## What I'd ship next if it were my call

If you gave me one week and said "pick the highest-leverage thing," it would not be hardening. It would be **milestone 1.2 — review and merge/close the ~20 open sandbox PRs**. Without that, the merge-rate feedback loop I built two sessions ago is still reading zeros for every (project, taskClass) combination. That loop is the cornerstone of self-improvement. Making it work is worth more than any one code fix.

Second highest: **milestone 1.4 — add burn-wizard with `test` task**. Proves the system can produce value on real work, not just sandbox games. De-risks everything in Horizon 3.

Everything else — hardening, locking, log rotation, auto-pull — is defensive. Defense is important, but not before you've proven the system is worth defending.
