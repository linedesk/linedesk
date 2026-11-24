# Inbox prototype (chosen design)

Single-file React prototype of Linedesk: the reference for the real web app. Relay design (black primary, Superhuman-style), with Linedesk's features rebuilt in it. Fictional data: Brightwater Plumbing & Heating (Portland), assistant "Maya", owner Mike Brennan. Nothing talks to a backend.

Shows: inbox (Needs you / Handled by Maya / Spam, Reminders, Done, day groups, unread dot, search over transcripts), call view (issue as title, player, summary, booking card, live call card, transcript with tool events, customer panel), bookings week view, customers, assistant settings (greeting, voice, knowledge, booking types, hours, rules, capabilities), onboarding, ⌘K, `?` shortcut sheet, undo, tooltips, key tips after mouse use.

## Run

```bash
cd prototypes/inbox-html && python3 -m http.server 4173
```

Then open http://localhost:4173.
