# Part 20 alert audit + feat/slot-fill-task-class merge checklist

**Author:** PC Claude Code (Opus 4.7), 2026-04-20
**For:** PC Cowork hardening-pass session (slot_fill)
**Status:** Reference artifact. Not load-bearing — delete after merge if unwanted.

---

## Part 1 — Part 20 alert trigger audit (context for P4)

**Question:** Does the dispatcher trigger a "needs attention" state when `consecutive_errors >= 3`?

### Finding: ntfy channel is FULLY WIRED.

Trace:

1. **[scripts/lib/health.mjs:70](scripts/lib/health.mjs#L70)** — `if (consecutiveErrors >= DOWN_ERROR_STREAK) { state = "down"; }` where `DOWN_ERROR_STREAK = 3`. So `consecutive_errors >= 3 → state="down"` deterministically.
2. **[scripts/lib/alerting.mjs:72-99](scripts/lib/alerting.mjs#L72-L99)** — `checkAndAlert()` is called at the end of each dispatch cycle. Reads `computeHealth()`, compares to `prevState`, fires ntfy with priority 4 (warning) on transition INTO a state listed in `on_transitions` (default `["down"]`).
3. **[scripts/lib/alerting.mjs:89-99](scripts/lib/alerting.mjs#L89-L99)** — Transition alert path. `prevState && prevState !== health.state && onTransitions.includes(health.state)`. So the FIRST transition into "down" fires; subsequent dispatches with `state="down"` do not re-alert (correct — avoids spam).

**Operational status:** `config/budget.json` alerting block exists but `enabled: false` (I disabled it before Perry left on 2026-04-19 to avoid leaking the placeholder topic `REPLACE_ME_BEFORE_DEPARTURE` publicly). Re-enabling requires Perry to (a) replace topic with private string, (b) install ntfy on phone, (c) set `enabled: true`. Not a cowork concern — user-setup step.

### Finding: Dashboard UI renders NONE of the Part 20 fields.

[scripts/dashboard.mjs](scripts/dashboard.mjs) is 2019 lines. grep over `consecutive_errors`, `last_error_reason`, `last_error_phase`, `last_error_ts`, `needs.attention`, `toast`, `alert` → **zero matches**. Fleet JSON has these fields (per `fleet.mjs` Part 20 work) but the UI ignores them.

**Where cowork needs to add rendering (P4):**

- **Local fleet row** — [scripts/dashboard.mjs:1590-1649](scripts/dashboard.mjs#L1590-L1649) (`renderFleet()`). Currently shows `fleet-slug` + `fleet-meta` with last-dispatch + last-task. Add a red "NEEDS ATTENTION" badge when the machine's fleet file reports `consecutive_errors >= 3`, and a yellow badge for `>= 1`.
- **Remote fleet view** — [scripts/dashboard.mjs:533-559](scripts/dashboard.mjs#L533-L559) (`getGistFleetData()`) + whatever renders the remote machines. Same treatment.
- **Reading source** — the fleet data already has `consecutive_errors`, `last_error_reason`, `last_error_phase`, `last_error_ts` on each fleet-*.json (verified in `status/fleet-perrypc.json`). No backend change needed, just surface in UI.

**Suggested minimum-viable UI change:**

```js
// In renderFleet(), per-machine row:
const errCount = machine.consecutive_errors ?? 0;
if (errCount >= 3) {
  html += '<span class="fleet-badge attn">NEEDS ATTENTION — ' + errCount + ' errs</span>';
  html += '<div class="fleet-meta err">' + esc(machine.last_error_reason ?? 'unknown') +
          ' (' + esc(machine.last_error_phase ?? '?') + ')</div>';
} else if (errCount >= 1) {
  html += '<span class="fleet-badge warn">' + errCount + ' err' + (errCount > 1 ? 's' : '') + '</span>';
}
```

Paired CSS next to existing `.fleet-legend-swatch.*` rules around line 975.

---

## Part 2 — feat/slot-fill-task-class merge-to-main checklist

**Do NOT merge during the hardening session** — merge is a separate step after P1/P2/P3 findings land and Perry approves. This doc is the runbook for that step.

### Preconditions (verify all green)

1. All P1 findings landed as commits on `feat/slot-fill-task-class`:
   - [ ] Finding 1: SIGKILL→retry backoff
   - [ ] Finding 2: writeDiagnostic atomic append
   - [ ] Finding 3: EACCES retry with 3-attempt cap
2. P2 synthetic test harness present + passing: `node --test scripts/lib/__tests__/worker-slot-fill.test.mjs`
3. All existing tests green on branch: `node --test scripts/lib/__tests__/`
4. `node --check` passes on every .mjs under `scripts/`
5. JSONL pollution canary: `grep -c '^\[' status/budget-dispatch-log.jsonl` = **10** (must stay)
6. Pre-commit hook parity: `diff scripts/hooks/pre-commit .git/hooks/pre-commit` empty
7. Health: `node scripts/lib/health.mjs status/budget-dispatch-log.jsonl status/health.json` → healthy or idle/ok
8. Fleet sanity: `cat status/fleet-perrypc.json | jq '.consecutive_errors, .last_error_reason'` → `0, null` (or prior benign error)

### Final pre-merge review gate

9. Re-run `mcp__pal__codereview` with model `gemini-2.5-pro` on the **full feature-branch diff** (`git diff main..feat/slot-fill-task-class`) — not just the P1 delta. Prompt focus:
   - path escape in prompt_file/lane_files/state/notes diagnostic writes
   - unbounded retry loops (verify 3-attempt cap from Finding 3)
   - LLM output parse exploits (prompt injection via prompt body)
   - validator spawn env leak (must use `getSafeTestEnv()` per [worker.mjs:33](scripts/lib/worker.mjs#L33))
   - worker.mjs exit-code propagation consistency
   - Part 20 "verify empirically" — don't accept HIGH flags without runtime repro
10. Address every CRITICAL and HIGH finding. Document MEDIUM/LOW in the merge commit body.

### Merge

11. `git checkout main && git fetch origin && git log --oneline main..origin/main` (inspect any new commits on origin/main; if any, `git pull --ff-only origin main`; do not pin to a specific hash — main advances).
12. `git merge --no-ff feat/slot-fill-task-class -m "merge: slot_fill task class + hardening pass [opus-4-7]"` — preserves branch history.
13. `git log --oneline main~1..main` — confirm merge commit exists.
14. **Do NOT push immediately.** Run post-merge smoke tests:
    - `node --test scripts/lib/__tests__/` (all green)
    - `grep -c '^\[' status/budget-dispatch-log.jsonl` (still 10)
    - `node --check scripts/**/*.mjs`
    - Optional: one `-ForceBudget` dispatch cycle on a low-risk project (sandbox-canary-test) to confirm no regression.
15. Perry: `git push origin main`.

### Post-merge activation (separate turn, Perry-gated)

16. Add worldbuilder to `config/budget.json` `projects_in_rotation` with `slot_fill_config` — path, lane_files, prompt_file, prompt_section, validators.
    - lane_files (PC): `linguistics/cultures/{oravan,ndjadi,qollari}.yaml`
    - validators: `[{cmd: "node", args: ["src/validate.js", "{file}", "schemas/culture.schema.json"]}, {cmd: "node", args: ["src/phoneme-check.js", "{file}"]}]`
    - Note: phoneme-check currently soft-skips (prose palette). Will exit 0 until re-migration produces structured IPA arrays.
17. `opportunistic_tasks: ["slot_fill"]` in worldbuilder's project entry.
18. **ATTENDED activation only.** First 3 dispatch cycles MUST have a human watching [status/budget-dispatch-log.jsonl](status/budget-dispatch-log.jsonl) live. Do NOT leave the dispatcher unattended for first-run slot_fill. Expected outcome per cycle: slot_fill picks a `[!]`-flagged subsection (likely sacred_register_phonology or morphology), expands via Gemini, validators pass or fail with clean retry, commits on auto/* branch. Revert-or-success in <2 minutes.
19. After 3 attended cycles with canary=10 and consecutive_errors=0: unattended operation permitted.

### Phase 2 backlog (tracked, not blocking this merge)

Explicit follow-up items to preserve quality when slot_fill activates with current content:

- **Structured phoneme palette re-migration.** Current 6 civs have prose-described palettes (`vowels: "Five pure vowels: a, e, i, o, u..."`). `phoneme-check.js` correctly soft-skips; slot_fill will thus activate with only JSON Schema validation enforcing content quality. Re-migration to structured arrays (`consonants: [p, t, k, ...]`, `vowels: [a, e, i, o, u]`) is needed to restore phoneme-legality enforcement on generated terms. **Tier:** Opus re-migration pass, ~30 min per civ. **Trigger:** before slot_fill's generated auto/* branches get merged to master in bulk.
- **Unit tests for `worldbuilder/src/phoneme-check.js`.** No test convention in worldbuilder yet. Follow-up: `tests/phoneme-check.test.mjs` covering all 4 palette modes + the structured-mode type-hint gate. **Trigger:** if prose-vs-structured classification regresses.
- **Recursion depth limit in `phoneme-check.js`.** Defensive hardening against deeply-nested YAML. Low practical risk (trusted content). **Trigger:** if input YAMLs grow beyond hand-authored scale.

### Rollback (if needed)

20. If slot_fill's first live run produces unexpected state:
    - Dispatcher: `git revert <merge-commit>` on main, push. Reverts to pre-slot_fill behavior.
    - Worldbuilder: inspect `auto/*` branches from the failed run; `git branch -D` any that are garbage; don't touch master until triage done.
    - File the incident in `HANDOFF.md` Part 22.

---

## Part 3 — Worldbuilder state (PC view, as of 2026-04-20)

For cowork's context. Not actionable — just FYI.

- Local master = `3711c6b` (my phoneme-check prose fix) + `8fdbef7` (my validators), both local-only (not pushed).
- All 5 region YAMLs PASS `node src/validate.js ... schemas/region.schema.json`.
- All 5 civ YAMLs (oravan/ndjadi/qollari/ngaru-bon/kheshkai) FAIL with only 3-4 `[!]`/`[?]` subsections missing each — that's what slot_fill will fill.
- Irrāḥ (6th civ) present as `linguistics/cultures/irrah.yaml`.
- phoneme_palette across all 6 civs is prose-described. `phoneme-check.js` exits 0 (skip) on all — will become useful once re-migration lands structured IPA arrays. Not blocking slot_fill.
- `state/` is gitignored; `state/notes/<machine>.md` is therefore NOT distributed via git. Only Syncthing (not bootstrapped on PC) or manual paste. Coordination channel gap — to be addressed separately.
