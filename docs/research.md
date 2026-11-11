# What makes an AI call-answering product good

Notes behind the mock-up. Sources at the end.

## Jobs the owner hires it for

1. **Never lose a caller.** Every call is answered within one ring, day and night.
2. **Turn calls into booked work** without the owner touching a calendar.
3. **Know what happened in 5 seconds**, not by listening to recordings.
4. **Stay in control**: urgent things reach a human immediately; the owner can listen in or take
   over a live call.
5. **Trust it**: callers are told it is an AI, it never invents prices or promises, and every
   decision is visible in the transcript.

## Requirements that follow

| Area | Must have in v1 | Why |
|---|---|---|
| Setup | Website import, calendar connect, forwarding codes per carrier, test call, under 10 minutes | Self-serve without sales (product strategy) |
| Calendar | Conflict calendars vs. booking calendar, working hours, appointment types with duration/buffer/min notice | Without this the agent can't book safely and double-books |
| Call handling | Returning-caller recognition, emergency escalation with warm transfer, message taking | Covers ~all inbound call types of service businesses |
| Inbox | Views by who has to act (Needs you / Handled by Maya / Spam, plus Reminders and Done), search over all calls, one-key actions, undo, reminders, command palette | Superhuman model: speed is the product |
| Call card | One-line title, summary, extracted fields, action items, booking card, recording synced to transcript, tool events inline | Understand a call without listening to it |
| Live | Live transcript, Listen, Take over | Control and trust |
| Value | Weekly counter: answered, booked, ≈ booked work | Makes the price obvious, is our marketing |
| Compliance | AI disclosure on by default; recording notice, retention, data region configurable (not enforced in v1) | Add guardrails once the starting states are known |
| Open source | Providers page for own keys (telephony, models) | Self-hosting must be first-class |

## Design principles

- **Keyboard first, mouse friendly.** Every action has a single-key shortcut that is shown next to
  the button; `⌘K` reaches everything.
- **One screen, one decision.** The detail pane leads with what to do next, then the evidence.
- **Calm by default, loud when it matters.** Neutral greys; colour only for state
  (live and unread = green, urgent = red; black is the primary colour).
- **Instant.** Optimistic updates, no spinners for local actions, motion under 200 ms.
- **Opinionated.** No flow builder, no prompt editor; settings are plain-language fields with good
  defaults.

## Sources

- Superhuman: [How to build a remarkable command palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/), [Shortcuts and Cmd+K](https://help.superhuman.com/article/478-superhuman-command)
- AI receptionist onboarding checklist (vendor): [My AI Front Desk](https://llms.myaifrontdesk.com/ai-front-desk-onboarding-setup-checklist)
- Transcripts and summaries as standard (vendor): [Picktime AI receptionist](https://picktime.com/features/ai-receptionist)
- Market context: Linedesk market matrix and one-pager (internal).
