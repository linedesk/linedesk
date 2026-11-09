# Callfront

The open-source AI front desk. Every call answered, every caller handled.

This repo is the **first UX mock-up** (phone + calendar only). All data is dummy data for a fictional plumbing company in Portland; nothing talks to a backend yet. Types and flows mirror the planned implementation in [docs/architecture.md](docs/architecture.md).

```bash
npm install
npm run dev
```

## Screens

| Route | What it shows |
| --- | --- |
| `/inbox` | List of calls (caller, summary, booked appointment, duration, time) triaged into Needs you / Booked / Handled / Spam / Done. `Enter` opens one call in focus ("2 of 4", J/K), `E` marks done and jumps to the next, `Esc` back to the list. Summary, extracted fields, booking, recording with synced transcript, contact panel. A live call streams in and books itself. |
| `/bookings` | Week view of the connected calendar: what Maya booked vs. events from your own calendars. |
| `/receptionist` | Name & voice, greeting (AI disclosure locked on), business knowledge, booking types, urgent & transfer rules, test call. |
| `/settings` | Phone number & forwarding codes, calendars (check conflicts / book into), team, notifications, voice & AI providers, privacy, usage. |
| `/onboarding` | 5 steps: website import → calendar → voice → phone forwarding → test call → live. |

## Keyboard

`J`/`K` move · `E` done · `Z` undo · `B` book · `H` snooze · `A` assign · `C` call back · `L`/`T` listen / take over a live call · `1`–`5` tabs · `Space` play recording · `M` menu · `⌘K` command palette · `G` then `I`/`B`/`R`/`S` navigate · `?` all shortcuts

## Docs

- [docs/research.md](docs/research.md): what an AI receptionist must do well
- [docs/design-principles.md](docs/design-principles.md): Apple HIG + clean-product rules we follow
- [docs/architecture.md](docs/architecture.md): backend design (Telnyx → LiveKit SIP → LiveKit Agents, Google/Microsoft calendars, data model)
