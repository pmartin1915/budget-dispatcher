# Handoff Prompt

Paste this into the next Claude Code session:

```
Resume work on claude-budget-dispatcher.

Required reading:
1. DISPATCHER-STATUS.md (dual-engine guide, scorecard, current state)
2. git log --oneline main -20
3. HANDOFF.md (Part 11 context + gotchas list at bottom)

Current state: Both engines validated and live. Auto mode (budget-adaptive
routing) active via scheduled task. System tray app shows green/yellow/red
health dot. Dashboard at localhost:7380 with 6 tabs + scheduled task health.
Desktop toast notifications on dispatch success/error. Auto-open Chrome on
dashboard start.

This session (Part 11) shipped 3 commits:
- 913464c  desktop notifications, task health dashboard, auto-open browser
- 186f0da  system tray app with health icon, context menu, auto-start
- (handoff docs commit)

Tools available:
- System tray icon (auto-starts on login, right-click for actions)
- node scripts/dashboard.mjs   # web UI at localhost:7380 (auto-opens Chrome)
- node scripts/dashboard.mjs --no-open  # suppress browser open
- node scripts/control.mjs     # interactive CLI (10 options)
- scripts/dashboard-launcher.cmd  # start dashboard + open Chrome
- -ForceBudget flag on run-dispatcher.ps1 (bypasses budget + activity gates)
- engine_override field in config/budget.json (instant engine switching)

Highest-priority next steps:
1. Add Perry's iOS apps to project rotation (repos at github.com/pmartin1915,
   clone to DevProjects, create DISPATCH.md + CLAUDE.md, add to
   projects_in_rotation in budget.json, start with audit task for baseline)
2. WebSocket for live dashboard updates (replace 30s polling)
3. Budget trend sparkline in Budget tab
4. Expand free model roster as new models become available

Manual testing:
  node scripts/dashboard.mjs                     # open localhost:7380
  node scripts/control.mjs                        # CLI menu
  node scripts/dispatch.mjs --force --dry-run     # inspect pipeline
  node scripts/dispatch.mjs --force               # real dispatch now
  cat status/budget-dispatch-last-run.json        # check results

Before any commit: run mcp__pal__codereview with model: "gemini-2.5-pro".
Fallback to review_validation_type: "internal" if Gemini is 503-ing.
Do NOT flip dry_run back to true. Do NOT re-enable ClaudeBudgetDispatcher
(auto mode replaces it). Do NOT use gemini-3-pro-preview.
Do NOT add -ForceBudget to the scheduled task.
```
