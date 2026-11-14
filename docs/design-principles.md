# Design principles

Linedesk should feel like a calm, native tool, not a dashboard. These rules come from Apple's Human Interface Guidelines and products that get "clean" right (Superhuman, Linear, Things 3, Stripe), applied to an inbox of phone calls. The reference implementation is [`prototypes/inbox-html`](../prototypes/inbox-html).

## What we take from Apple

- **Hierarchy.** One clear focal point per screen. Typography and spacing create order before any line, box or colour.
- **Deference.** Content leads: the call's issue, the summary, the time slot. Chrome stays quiet.
- **Clarity.** Every word, icon and control earns its place. If removing it changes nothing, remove it.
- **Consistency.** Same action, same place, same shortcut, everywhere.
- **Depth sparingly.** Elevation only for raised cards and things that float: palette, dialogs, toasts.

## What we take from clean products

- **Superhuman:** speed is the feature. Keyboard first, one decision per screen, auto-advance after every action, undo instead of confirm dialogs, a tip after every mouse action ("Next time, press E").
- **Linear:** monochrome base, dense but never cramped.
- **Things 3:** generous whitespace, typography-led hierarchy, rare but delightful motion.
- **Stripe:** precise copy, numbers that mean something, settings as quiet grouped sections.

## Rules in this codebase

1. **Black is the primary colour** (primary buttons, selection bar, focus). **Green** only for live and unread, **red** only for urgent, missed, failed and destructive, **amber** only for warnings (see Messages below). Everything else is greyscale.
2. **No decorative colour.** No avatars in lists, statuses are plain text or quiet badges, tags are grey.
3. **Shadows for raised objects, nothing for the rest.** The list, header and side panel are flat; real objects (player, summary, booking card, setting groups) are white cards lifted by a soft shadow; no borders where a shadow is used.
4. **Shortcuts are discoverable, not loud.** Hovering any control shows a dark tooltip with the action and its key after ~550 ms (neighbours appear instantly). Icon-only buttons explain themselves in the tooltip. Shortcuts also live in ⌘K and the `?` sheet; menu shortcuts appear on hover only.
5. **Never ask "are you sure?".** Act instantly and offer undo (Z), with a quiet toast and a visible Undo button.
6. **Calm by default.** Notifications only for what needs a person. The default state is "nothing needs you".
7. **No permanent sidebar.** Navigation slides in from ☰ or `M` and stays open until Esc, a click outside or a choice. Day to day you move with `G` chords, number keys and ⌘K.
8. **One call at a time; lists have column headings.** The inbox is a plain list, newest first; the time column says the day and the clock time. Enter opens one call full width with only up/down and its actions at the top; E finishes it and moves to the next; Esc goes back. Every list with more than one column has column headings, drawn with the shared `ColumnHeads` (`ui/list.tsx`): one type style, sticky, each heading over its cells, every column left-aligned (time and counts too), hidden on phone widths where rows stack. A select-all box sits in the headings only where the list has selection. One-line lists and cards need none.
9. **The issue is the title.** In a call, the big heading is what the call is about; caller and number sit below it, time · duration · who answered above it.
10. **Views follow who has to act.** Needs you / Handled by Maya / Spam (plus Reminders and Done). What the assistant did is a column, never a view.
11. **Motion under 200 ms.** Rows fade and collapse on done, ease back in on undo; respect reduced motion.
12. **Copy is short and human.** "Nothing needs you. Maya has it." beats "No items found". Use the terms Assistant (not Receptionist) and Remind (not Snooze).
13. **Show the result of an action immediately; never require a reload.** What the user just did (connected a calendar, created a key, cloned a voice, set up a number) is on screen in the next frame, also after a redirect away and back. While it cannot be known yet, show a placeholder for under a second, never the state from before. How: CLAUDE.md, core rule 3.
14. **A walkthrough never sends you out of itself.** Setup and onboarding steps don't link or jump to other pages in the same tab. What belongs elsewhere is a hint naming the place ("later, in Admin › Providers"); where a step truly needs another screen, it opens in place and returns to the same step (as Admin does from onboarding).

## Messages: one look per kind

Every message in the app is one of these four. Don't add a new style; pick the kind, then the tone.

| Kind | Use it for | How |
| --- | --- | --- |
| **Toast** | The result of what the user just did ("Key copied.", "Vacation mode is on.", an action that failed). Disappears on its own, with Undo where the action can be undone. | `toast(text)` / `toast(text, true)`; the one dark pill at the bottom (`.toast`). Never for a state that stays. |
| **Note** | A state of the page that stays until something changes: a hint, a warning, an error loading or saving. | `<Note tone=… title=… action=…>` from `ui/kit.tsx`. |
| **Field error** | One field that can't be saved as it is. | `error` on `FormField`, or `FormMessage`: one red line right under the field. |
| **Badge** | The status of one item in a list ("Failing", "Off"). | `<Badge tone=…>`. |

Note tones, from quiet to loud:

- **neutral**: grey, no icon. A plain hint or a status while something waits ("Waiting for the server to restart").
- **info**: blue-grey with the info icon. Context worth knowing that needs nothing from the user.
- **success**: grey with a check. The result of a test or a check on the page ("Connected").
- **warning**: amber with the triangle and an amber edge. It works, but something important is missing or won't work as expected ("Real phone calls can't reach this copy"). Give it a title that says the consequence, then the reason, then the fix as a link or button.
- **danger**: red with the alert circle and a red edge, announced at once. Something failed or is blocked.

Rules: red and amber appear only in these tones (and badges), never as plain coloured text. Muted grey helper text (`.help`) is for explaining a control, not for problems. The title is one short sentence; the body says why and what to do; a fix is a link or button inside the note, never a second note.
