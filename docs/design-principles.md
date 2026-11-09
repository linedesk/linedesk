# Design principles

Callfront should feel like a calm, native tool, not a dashboard. These rules are distilled from Apple's Human Interface Guidelines and from products that get "clean" right (Linear, Things 3, Superhuman, Stripe, Vercel), and applied to an inbox of phone calls.

## What we take from Apple

- **Hierarchy.** One clear focal point per screen. Typography and spacing create order before any line, box or colour does.
- **Deference.** The UI steps back so content leads: the call summary, the caller, the time slot. Chrome stays quiet.
- **Clarity.** Every word, icon and control earns its place. If removing it changes nothing, remove it.
- **Consistency.** Same action, same place, same shortcut, everywhere.
- **Depth sparingly.** Elevation (shadow, blur) only for things that float above the page: palette, dialogs, toasts.

## What we take from clean products

- **Linear:** monochrome base, one accent, hairline borders, dense but never cramped.
- **Things 3:** generous whitespace, typography-led hierarchy, delightful but rare motion.
- **Superhuman:** speed is the feature. Keyboard first, one decision per screen, auto-advance after every action, undo instead of confirm dialogs.
- **Stripe / Vercel:** precise copy, numbers that mean something, settings as quiet grouped rows.

## Rules in this codebase

1. **One accent (blue)** for the primary action and the current selection only. **Red** only for urgent, **green** only for live. Everything else is greyscale.
2. **No decorative colour.** Avatars are neutral initials, statuses are plain text, tags are grey.
3. **Borders before shadows, whitespace before borders.** Content sections (summary, fields, transcript) are separated by space, not cards. Cards exist only for real objects (a booking, a setting group).
4. **Shortcuts are discoverable, not loud.** Like Superhuman, hovering any control shows a dark tooltip with the action and its key (`data-tip` / `data-kbd`, one global `TooltipLayer`). Every tooltip waits 600 ms; moving on to the next one takes only 120 ms. Shortcuts also live in ⌘K and the `?` sheet. Only the primary action shows its key inline.
5. **Never ask "are you sure?".** Act instantly and offer undo (Z).
6. **Calm by default.** Notifications only for what needs a human. The default state of the inbox is "nothing needs you".
7. **No permanent sidebar.** Navigation hides behind ☰ (or `M`) and slides in over the page. Day to day you move with `G` chords and ⌘K, so the screen belongs to the calls.
8. **One call at a time.** The inbox opens as a plain list. `Enter` or a click puts one call in focus, full width, with only "2 of 4" and up/down at the top. `E` finishes it and moves straight to the next one; when the list is empty you land back on it. `Esc` always goes back to the list. Calls are not emails, so each row carries what a phone call adds: caller (with a quiet "New" for first-time callers), title only (the summary lives in the call itself), assignee, one context element (the booked appointment, or what's left to do), duration and time. Appointment times live in that column, never repeated in titles.
9. **Tabs follow the work, not the data.** To do / Updates / All calls / Spam answer "do I still have to act?". What Maya did is a column, never a tab, and only To do gets a coloured count.
10. **Our own language: a phone, not a mail client.** We borrow Superhuman's speed (keyboard, focus, undo), not its look. Callfront's signatures: views are a native segmented control, not headlines; Maya's presence sits in the header ("Maya is answering", or "on a call with Emily" with the live timer); time comes first and every view is grouped by day (Today, Yesterday, Earlier) like a phone's recents; To do keeps its priority order inside each day; rows lead with the caller's avatar.
11. **Copy is short and human.** "Nothing needs you. Maya has it." beats "No items found".
