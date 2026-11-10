# Inbox HTML prototype (from Relay)

Single-file React prototype of the call inbox, imported from the archived `relay-cx/relay` repo. Fictional data (working name "Kontor", insurance-broker examples). Nothing talks to a backend.

Shows: split inbox with Done and Reminders, inline search over callers and transcripts, call view with player, summary and transcript, customer side panel, Customers page, Assistant Settings with capability tiles, ⌘K with fuzzy search, undo stack, Superhuman-style keys and tooltips, onboarding key drill.

## Run

```bash
cd prototypes/inbox-html && python3 -m http.server 4173
```

Then open http://localhost:4173.
