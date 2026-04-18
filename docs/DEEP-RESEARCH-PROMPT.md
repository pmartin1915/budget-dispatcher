# Deep Research: Dispatcher & Dashboard Hardening Audit

> Use this prompt with a deep research agent (Claude, Gemini, etc.) to get a comprehensive analysis of the budget dispatcher system. Copy everything below the line.

---

## Context

You are auditing a **budget-aware autonomous code dispatcher** — a Node.js system that uses unused Claude Max subscription headroom to run bounded self-improvement tasks on a portfolio of 10+ projects across 2-3 Windows machines. The system:

1. **Estimates Claude Max usage** by parsing conversation transcripts (`~/.claude/projects/**/*.jsonl`) for `usage` fields (input/output/cache tokens)
2. **Gates dispatch decisions** on dual-period budget checks (trailing-30-day + rolling-7-day), user activity (20-min idle), daily run caps, and pause/kill switches
3. **Selects a project + task** from a pre-approved rotation list using an LLM selector (Gemini native JSON mode)
4. **Routes the task to a free-tier model** (Gemini 2.5 Flash/Pro, Codestral, Mistral Large, Groq, OpenRouter, or local Ollama) based on per-project routing overrides with multi-provider fallback chains
5. **Executes the work** in a git worktree (`auto/<slug>-<task>-<date>`), runs tests, audits changes with a cross-family model, and commits if clean
6. **Never pushes or merges to main** — all work stays on local auto-branches for human review
7. **Has a web dashboard** (localhost:7380) with 8 tabs: Status, Analytics, Budget, Projects, Logs, Config, Fleet, About — plus a system tray app and CLI control tool
8. **Coordinates across machines** via a pinned GitHub Issue status board

### Architecture

```
config/budget.json          — thresholds, rotation, kill switches, model roster
scripts/
  dispatch.mjs              — main entry: gates → selector → router → worker → commit
  estimate-usage.mjs        — transcript parser, budget estimation (Node, no LLM cost)
  check-idle.mjs            — user activity detection (transcript mtime)
  dashboard.mjs             — localhost web UI (1900+ lines, zero deps, inline HTML/CSS/JS)
  control.mjs               — interactive CLI
  status.mjs                — GitHub Issue status board
  tray-app.cs               — Windows system tray (.NET)
  lib/
    worker.mjs              — LLM task execution (codegen, audit, test, commit)
    router.mjs              — per-(project, taskClass) model resolution with fallback chains
    provider.mjs            — multi-provider API caller (Gemini SDK, Mistral SDK, fetch for Groq/OpenRouter/Ollama)
    health.mjs              — 3-state health computation (healthy/idle/down)
    context.mjs             — project context assembly (STATE.md, DISPATCH.md, selector memory)
    schemas.mjs             — ajv JSON schema validation for LLM responses
    selector.mjs            — LLM-based project+task selection
    __tests__/
      router.test.mjs       — 25 unit tests (Node built-in test runner)
status/
  budget-dispatch-log.jsonl — append-only dispatch log
  usage-estimate.json       — latest budget snapshot
  health.json               — cached health state
  dispatcher-runs/          — per-run stdout/stderr logs
```

### Key Design Decisions Already Made

- Transcript-based estimation (no API endpoint for Claude Max quota)
- Dual-period gate with weekly as the floor (prevents easy-week quota burn)
- Cross-family audit (generation and audit use different model families)
- Clinical gate on burn-wizard (Gemini codereview on any `domain/` touch)
- Local-only auto-branches (never push, never merge)
- Engine-aware budget bypass (Node engine doesn't consume Claude Max)
- Flash truncation guard (balanced delimiters check before writing code)
- Schema validation on LLM audit responses (ajv)
- Selector outcome memory (deprioritize recently-failed tasks)
- Process-tree-safe test timeout (kills entire child tree, not just parent)

### Current State

- 42/42 security audit findings resolved
- 13 log entries, all skips (7 user-active, 5 reserve-floor, 1 parse-error)
- Zero actual dispatches have occurred yet
- Dashboard has 8 tabs including new Analytics with skip reason breakdown, 14-day activity chart, hourly heatmap, per-project and per-model stats
- 25 unit tests for router, zero tests for worker/provider/selector/health/context/schemas
- 10 projects in rotation across 2 machines (laptop + PC), 3rd machine (Optiplex) planned

---

## What I Want You To Research

Provide a comprehensive analysis covering ALL of these areas. For each finding, specify: severity (CRITICAL/HIGH/MEDIUM/LOW), the specific file and function affected, what the risk is, and a concrete fix. Organize findings into sections.

### A. Security & Trust Boundaries

1. **Prompt injection surface area**: The selector and worker prompts include file contents from project repos (STATE.md, DISPATCH.md, ROADMAP.md). An attacker who controls a project file could manipulate task selection or code generation. Map every path where untrusted file content enters an LLM prompt. What sanitization exists? What's missing?

2. **Credential exposure**: API keys are in environment variables. The dispatch process spawns subprocesses. Do any of those subprocesses inherit credentials they don't need? Could a malicious LLM response exfiltrate credentials via generated code?

3. **Path traversal**: S-3 was marked resolved. Verify the fix is complete — can the worker be tricked into reading or writing files outside the project worktree? Check `parseFileOutput()`, `writeFiles()`, and any path construction from LLM responses.

4. **Supply chain**: `package.json` has 3 direct dependencies (@google/genai, @mistralai/mistralai, ajv). What's the transitive dependency count? Are there known CVEs? Is `package-lock.json` present and integrity-checked?

5. **Network exposure**: The dashboard binds to `127.0.0.1:7380`. Is this truly localhost-only? Could DNS rebinding or CORS misconfiguration allow remote access? Are there any endpoints that accept mutation (POST) without authentication?

6. **Git safety**: The dispatcher creates worktrees and commits. Can it be tricked into committing sensitive files (`.env`, credentials)? Does `git add` ever use `-A` or `.`? What prevents the auto-branch from being pushed?

### B. Reliability & Error Handling

7. **Estimator accuracy**: The budget estimator parses transcript JSONL for usage fields. What happens with malformed transcripts? Partial writes? Files being actively written to during parsing? Race conditions between the estimator and active Claude sessions?

8. **Gate ordering and atomicity**: The gate chain is: paused → daily quota → activity → budget. If a gate check takes time (e.g., estimator runs for 10 seconds), could the system state change between checks? Is there a TOCTOU issue?

9. **Worker crash recovery**: If the worker crashes mid-codegen (e.g., OOM, network timeout), what state is left behind? Orphaned worktrees? Stale lock files? Partially written files? How does the next run detect and recover?

10. **JSONL log corruption**: The log file is append-only. What if two dispatchers write simultaneously (laptop + PC both dispatching)? Is there file locking? What if the write is interrupted mid-line?

11. **Model fallback chain exhaustion**: If all models in a fallback chain fail (rate limited, auth error, timeout), what happens? Does the system fail gracefully or enter a retry loop? What's the maximum number of API calls per dispatch?

12. **Dashboard resilience**: The dashboard reads config and log files on every API call. What if budget.json is malformed (mid-edit)? What if the JSONL log grows to 100MB? Are there any memory leaks in the long-running Node process?

### C. Performance & Scalability

13. **Log scanning efficiency**: Several API endpoints (`getAnalytics`, `getBudgetDetail`, `getLogs`, `predict`, `getProjects`) all call `readLogLines()` which reads the entire JSONL file. As the log grows, this becomes O(n) per request. What's the projected log size after 6 months of operation? When does this become a problem?

14. **Dashboard memory**: The dashboard loads the full HTML page (1900+ lines) as a template string. How large is the response? Is there gzip compression? Could the dashboard serve static files from disk instead?

15. **Estimator startup cost**: The estimator scans `~/.claude/projects/**/*.jsonl` — potentially hundreds of transcript files. What's the projected scan time as transcripts accumulate? Is there a cache or incremental scan?

16. **Provider timeout handling**: Each provider call has a timeout. What are the actual timeout values? Are they appropriate for each provider (Ollama local is fast, OpenRouter may be slow)? What happens during timeout — does the AbortController properly clean up the TCP connection?

### D. Dashboard UX & Feature Gaps

17. **Missing analytics**: The Analytics tab shows skip reasons, 14-day activity, hourly heatmap, and project/model stats. What additional visualizations would be most valuable? Consider: success rate trends, model latency percentiles, cost tracking (free-tier token usage), task duration distribution, error categorization, worktree cleanup status.

18. **Real-time updates**: The Status tab auto-refreshes every 30 seconds, Budget every 60 seconds. Other tabs don't auto-refresh. Should the dashboard use Server-Sent Events (SSE) or WebSocket for push updates? What's the trade-off?

19. **Mobile responsiveness**: The dashboard has one `@media` breakpoint at 700px. Is it usable on a phone? What breaks on small screens?

20. **Accessibility**: Does the dashboard meet WCAG 2.1 AA? Keyboard navigation? Screen reader support? Color contrast ratios for the Tokyonight theme?

### E. Operational Improvements

21. **Alerting**: When the dispatcher enters "down" state, how does Perry know? The tray app shows a red icon, but what if he's away? Should there be email/SMS/push notification? GitHub Issue comment?

22. **Log retention**: The JSONL log grows forever. Should there be rotation (e.g., keep 30 days, archive older)? What about the `dispatcher-runs/` directory of per-run logs?

23. **Configuration validation**: `budget.json` is hand-edited. What if someone sets `max_runs_per_day: -1` or `reserve_floor_pct: 200`? Is there schema validation on config load?

24. **Test coverage**: Only `router.mjs` has tests (25). What are the highest-value test targets for the remaining modules? Which functions have the most complex logic or the highest blast radius if they break?

25. **Observability**: Beyond the JSONL log, what telemetry would help debug issues? Structured logging with levels? Request tracing across dispatcher → selector → router → provider → worker? Health check endpoint for external monitoring?

### F. Multi-Machine Coordination

26. **Conflict avoidance**: Two machines could try to dispatch on the same project simultaneously. The status board is advisory (comment-based), not a lock. What's the actual collision risk? Should there be a distributed lock (e.g., GitHub Issue lock, filesystem advisory lock)?

27. **Config drift**: Each machine has its own `budget.json`. Changes on one machine don't propagate. Should config be in git? What about machine-specific overrides (paths, providers)?

28. **Gist sync reliability**: The fleet view uses a GitHub Gist for cross-machine status. What if the gist API is rate-limited? What if one machine's status is stale? How does the dashboard handle partial data?

---

## Output Format

For each finding, provide:

```
### [SEVERITY] ID: Title
**File:** path/to/file.mjs:lineNumber
**Risk:** What could go wrong
**Fix:** Specific code change or architectural recommendation
**Priority:** Do now / Next sprint / Backlog
```

Group findings by section (A-F). End with a prioritized top-10 action list.

If you need to see specific code, ask — I can provide any file from the repository.
