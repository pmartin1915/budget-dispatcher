# Vision — Budget Dispatcher

## What this is for

Budget Dispatcher is **opportunistic infrastructure** for turning Perry's unused AI subscription quota into reviewable code work on his own projects while he is sleeping, studying, clinical, or away from the keyboard. It is not a CI/CD system, not a replacement for human coding, and not a product.

Everything the dispatcher touches is:

- **Bounded** — pre-approved task types on pre-approved projects.
- **Reversible** — work happens on `auto/*` branches, never on `main`.
- **Reviewable** — every commit opens a PR Perry merges or closes by hand.
- **Observable** — every decision, every skip, every dispatch is logged and visible from his phone.

## What success looks like

A successful dispatcher, 12 months from now, is one Perry does not think about. It:

- Runs on 3+ machines without manual intervention for weeks at a time.
- Produces PRs with a merge rate above 30%. (The number is less important than the direction — if it trends up over time, the system is learning. If it trends down, something is wrong.)
- Scales to work Perry cares about — clinical code, worldbuilder content, game code — without him writing new code paths each time.
- Costs $0/month in API calls. Free-tier is not a temporary stage; it is load-bearing.
- Alerts him on his phone within ~1 hour when something breaks, with enough detail to diagnose from the alert alone.
- Improves itself — the sandbox-workflow-enhancement project exists precisely so the dispatcher can dispatch against its own code.

## What this is explicitly not

- **Not a replacement for Perry.** The dispatcher does not make architectural decisions, does not introduce new dependencies, does not touch domain logic on clinical projects, and does not push to `main`. Ever.
- **Not a production service.** There is no SLA, no PagerDuty, no on-call rotation. It is a personal tool that fails closed.
- **Not multi-tenant.** This is Perry's toolchain, not a product for others. Design decisions that would be wrong for a product (gitignored keys in `local.json`, per-machine state in `status/`, hardcoded paths in scheduled tasks) are right for this.
- **Not a replacement for human review.** Auto-PR exists to make review easier, not to remove it. No auto-merge. No auto-accept of proposals.

## The dependency chain this enables

The dispatcher is the foundation of a longer chain:

```
budget-dispatcher  →  worldbuilder  →  physics engine  →  Frontier (Irrāḥ game)
(this project)       (Veydria data)   (Frontier 2.0)     (the eventual game)
```

The dispatcher's role in this chain is to handle the mechanical work at each layer — schema validation, phoneme expansion, GeoJSON generation, sprite-sheet QA, lore audits — so Perry can focus on creative decisions and clinical work. Every feature added to the dispatcher should be weighed against whether it moves this chain forward or just moves the dispatcher forward.

## Design principles (carried forward from the original plan)

1. **User comes first.** Reserve floors protect Perry's interactive sessions.
2. **Bounded tasks only.** Pre-approved, idempotent, allowlisted.
3. **Never touch main.** `auto/*` branches, never pushes, never merges.
4. **Fail closed.** Every ambiguity resolves to "skip."
5. **Observable.** Every decision logged. Every alert actionable from a phone.
6. **Free-tier is load-bearing.** Costs stay at $0. Gemini + Mistral + Codestral, no fallback to paid tiers.

These have held up through every incident so far. They stay.
