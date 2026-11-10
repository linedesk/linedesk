# Callfront

The open-source AI front desk. Every call answered, every caller handled.

Status: prototypes and architecture; the backend is next. Private until the first public release.

## What's here

| Path | What it is |
| --- | --- |
| [`prototypes/inbox-html/`](prototypes/inbox-html) | The chosen design: single-file clickable prototype (inbox, call view, bookings, customers, assistant settings, onboarding). Run: `cd prototypes/inbox-html && python3 -m http.server 4173` |
| `src/` (root) | Janik's Next.js UX mock-up with the same scenario. Run: `npm install && npm run dev`. Moves to `prototypes/callfront-next/` when the monorepo is created. |
| [`docs/`](docs) | Architecture, stack, plan, decisions, research, design principles |

All data is fictional (Brightwater Plumbing & Heating, Portland; assistant "Maya"). Nothing talks to a backend yet.

## Docs

- [docs/architecture.md](docs/architecture.md): how Callfront works (single source of truth)
- [docs/stack.md](docs/stack.md): why this stack: research, spikes, costs per minute
- [docs/plan.md](docs/plan.md): principles, open-source readiness, workstreams
- [docs/decisions.md](docs/decisions.md): decisions log
- [docs/research.md](docs/research.md): what an AI front desk must do well
- [docs/design-principles.md](docs/design-principles.md): UI rules

Working on the code: read [CLAUDE.md](CLAUDE.md) first.
