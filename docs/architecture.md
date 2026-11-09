# Callfront: backend architecture (v1 = phone + calendar)

This document describes how the product shown in the mock-up would actually work. The frontend
types in `src/lib/types.ts` mirror the data model below 1:1, so every screen maps to a real
backend capability.

## 1. What v1 does

A business keeps its existing phone number and forwards calls it can't take to Callfront.
An AI receptionist answers, understands the request, books appointments into the business's
calendar, takes messages, escalates emergencies to a human, and turns every call into a card in
a keyboard-first inbox.

Out of scope for v1: WhatsApp, SMS, outbound campaigns, multi-location routing.

## 2. System overview

```
 Caller ──PSTN──▶ Business number ──(conditional forward)──▶ Callfront DID (Telnyx)
                                                                    │ SIP
                                                                    ▼
                                                        LiveKit SIP service
                                                                    │ joins room
                                                                    ▼
                                    ┌──────────── LiveKit room (one per call) ────────────┐
                                    │  caller (SIP participant)                            │
                                    │  agent worker (LiveKit Agents, Python)               │
                                    │  owner (optional: browser or SIP when taking over)   │
                                    └──────────────────────────────────────────────────────┘
                                         │ tool calls (HTTPS)        │ transcript events
                                         ▼                           ▼
                                   Callfront API  ◀────────────▶  Postgres
                                   (TypeScript)                   + object storage (recordings)
                                         │                         + job queue
                         ┌───────────────┼──────────────────┐
                         ▼               ▼                  ▼
                 Google Calendar   Microsoft Graph     Web app (Next.js)
                                                       realtime via WebSocket
```

### Components

| Component | Choice | Why | Self-host alternative |
|---|---|---|---|
| Phone numbers + PSTN | **Telnyx** (default), Twilio as second adapter | Own network, cheaper per minute than Twilio, SIP trunking, numbers in 100+ countries, number lookup and STIR/SHAKEN attestation for spam scoring | Any SIP trunk ("bring your own SIP") |
| Media server / SIP bridge | **LiveKit** server + LiveKit SIP | Open source (Apache 2.0), handles SIP ↔ WebRTC, rooms make listen-in and take-over trivial, Egress records calls | Same, self-hosted |
| Agent runtime | **LiveKit Agents (Python)** | Mature turn detection, interruption handling, tool calling, provider plugins | Pipecat as fallback adapter |
| Voice pipeline (default) | **Speech-to-speech realtime model** (e.g. OpenAI `gpt-realtime-mini`) | Lowest latency (~500–800 ms), natural barge-in, ~2–4 ¢/min | — |
| Voice pipeline (alternative) | **Cascaded**: Deepgram (STT) → LLM (Claude / GPT) → Cartesia or ElevenLabs (TTS) | More control, better tool reliability, any voice/language | Whisper + local LLM + Kokoro/Piper (quality trade-off) |
| Turn detection / VAD | Silero VAD + LiveKit turn-detector model | Avoids cutting callers off mid-sentence | Same |
| Calendar | **Google Calendar API**, **Microsoft Graph** (Outlook/365); CalDAV (iCloud, Fastmail) later | Covers the vast majority of small businesses | CalDAV |
| API | TypeScript (Hono or Next.js route handlers) | One language with the web app | Same |
| Database | **Postgres** | Relational data, `LISTEN/NOTIFY` for realtime | Same |
| Jobs | Postgres-backed queue (graphile-worker / pg-boss) | No extra infra for self-hosters | Redis + BullMQ at scale |
| Recordings | S3-compatible storage (R2 / S3) | Cheap, signed URLs | MinIO |
| Realtime to UI | WebSocket (server) fed by Postgres NOTIFY + LiveKit data messages | Live transcript, new cards appear instantly | Same |
| Post-call AI | LLM with structured output (JSON schema) | Summary, outcome, urgency, extracted fields | Local LLM |
| Billing (cloud only) | Stripe metered billing on answered minutes | Pass-through pricing with transparent markup | n/a |
| Auth | Email magic link + Google/Microsoft SSO | The same OAuth consent can grant calendar access | Same |

## 3. Call lifecycle

1. **Ring.** Caller dials the business. If nobody answers within N rings (or the line is busy),
   the carrier forwards to the workspace's Callfront number (`PhoneNumber.e164`).
2. **Ingress.** Telnyx sends the call over SIP to LiveKit SIP. A dispatch rule maps the DID to a
   workspace and creates a room `call_<id>`. The API creates `Call { status: "live" }` and pushes
   it to the inbox (it appears at the top with a live indicator).
3. **Caller lookup.** The agent's first tool call, `lookup_caller(phone)`, returns the contact, past
   calls and upcoming bookings, so returning customers are greeted by name.
4. **Greeting.** Mandatory AI disclosure + optional recording notice (jurisdiction-dependent),
   then the configured greeting.
5. **Conversation.** The agent follows the receptionist config (business knowledge, services,
   service area, FAQs, booking rules, escalation rules). Tools available to the agent:

   | Tool | Effect |
   |---|---|
   | `lookup_caller(phone)` | Contact + history |
   | `check_availability(appointment_type, window)` | Free slots = working hours ∩ free/busy of conflict calendars − buffers − min notice |
   | `book_appointment(type, start, contact, details)` | Creates the event in the booking calendar, stores `Booking`, links the call |
   | `reschedule_appointment(booking_id, new_start)` / `cancel_appointment(booking_id)` | Updates the calendar event |
   | `take_message(subject, details, callback_requested)` | Creates an action item on the card |
   | `transfer_to_human(reason)` | Warm transfer: dials the escalation number via LiveKit SIP, whispers a summary, bridges the caller; on no answer returns to the AI, which takes a message and flags the card urgent |
   | `end_call(reason)` | Hangs up politely |

   Every tool call is also written into the transcript as an event (shown in the UI as small
   system rows such as "Checked availability · 3 slots").
6. **Live view.** Transcript segments stream to the UI over WebSocket. The owner can **Listen**
   (joins the room muted via WebRTC) or **Take over** (joins with mic, or LiveKit dials the
   owner's phone; the agent drops out after a hand-off line).
7. **Hang-up.** LiveKit Egress finalises the recording → object storage.
8. **Post-call job.** An LLM pass over the full transcript returns structured JSON:
   `title`, `summary`, `outcome`, `urgency`, `intent`, `actionItems[]`, `fields[]` (template-driven,
   e.g. address, issue, access notes), `spam` score (combined with carrier attestation). The card
   moves from "live" into the right inbox tab.
9. **Notify.** Push / email to the owner for `urgency = urgent` or `outcome = callback`. Daily
   digest for the rest. (SMS/WhatsApp confirmations to the caller come with the messaging
   channels in v1.5.)

Target latencies: answer < 1 ring after forward, first agent word < 1.2 s, turn latency
< 800 ms, card ready < 10 s after hang-up.

## 4. Phone number setup

Three modes, all represented in `PhoneNumber.mode`:

- `forward_conditional` (default, recommended): the business keeps its number and only
  unanswered / busy / unreachable calls go to Callfront. Setup = dialling a carrier code, e.g.
  US mobile carriers on GSM: `**004*<callfront number>#`; Verizon: `*71<number>`. We verify by
  placing a test call to the business number and checking that it arrives on the DID.
- `forward_all`: Callfront answers every call (front desk replacement).
- `new` / `ported`: a new local number from Telnyx, or the existing number ported in.

## 5. Calendar integration

- OAuth scopes: Google `calendar.events` + `calendar.freebusy` (or `calendar.readonly` +
  `calendar.events`), Microsoft `Calendars.ReadWrite`.
- Per connected calendar two flags: **check for conflicts** (read free/busy) and **book into**
  (exactly one booking target per workspace in v1).
- **Availability engine** (in the API, not in the calendar): working hours per weekday + date
  exceptions, appointment types (duration, buffer before/after, min notice, max days ahead,
  location type), free/busy from all conflict calendars, existing Callfront bookings.
- Events are created with title `<Type> · <Caller name>`, description containing the AI summary,
  phone number, address and a deep link back to the call card.
- Sync: Google push notifications (`events.watch`) / Graph subscriptions update `Booking` when the
  owner moves or deletes an event in their own calendar.

## 6. Data model

```
Workspace(id, name, timezone, locale, avg_job_value, plan, region)
Member(id, workspace_id, name, email, role[owner|admin|member], phone)
PhoneNumber(id, workspace_id, e164, provider[telnyx|twilio|byo_sip], mode, forwarded_from,
            verified_at)
Receptionist(id, workspace_id, name, voice{provider, voice_id}, languages[], greeting,
             disclose_ai=true, recording_notice, pipeline{mode[realtime|cascaded], llm, stt, tts},
             business_profile{description, services[], service_area, address, hours, faqs[]},
             escalation{transfer_to_member_id, urgent_keywords[], when[]})
CalendarConnection(id, workspace_id, provider[google|microsoft|caldav], account_email, status)
Calendar(id, connection_id, external_id, name, color, check_conflicts, book_into)
AvailabilityRule(id, workspace_id, weekday, start, end) + AvailabilityException(date, ...)
AppointmentType(id, workspace_id, name, duration_min, buffer_min, min_notice_hours,
                max_days_ahead, location[on_site|office|phone|video], enabled)
Contact(id, workspace_id, name, phone, email, address, tags[], note)
Call(id, workspace_id, contact_id, from, to, started_at, ended_at, duration_sec,
     status[live|completed], outcome[booked|rescheduled|cancelled|callback|message|answered|
     transferred|hangup|spam], urgency[urgent|normal|low], intent, title, summary,
     action_items[], fields[], language, answered_by[ai|human], recording_key,
     inbox_state[open|done|snoozed], snoozed_until, assignee_id, billed_seconds)
TranscriptSegment(id, call_id, speaker[agent|caller|human|system], text, at_ms, tool_event?)
Booking(id, workspace_id, call_id, contact_id, appointment_type_id, start, end,
        status[confirmed|rescheduled|cancelled], calendar_id, external_event_id)
UsagePeriod(workspace_id, period, answered_seconds, cost_cents)
```

### Inbox semantics

Tabs are derived, not stored. They answer one question, "does a person still have to act?";
what Maya did (the outcome) is a column and a filter, not a tab.

- **Needs you**: open calls a person has to act on: every `status = live` call, `urgency = urgent`,
  and outcomes `callback | message | hangup` (a hang-up is often a lost lead). Sorted by priority:
  live, urgent, new-caller callbacks, other callbacks, messages, hang-ups; newest first within each.
- **Handled by Maya**: open calls Maya finished on her own (`booked | rescheduled | cancelled | answered | transferred`).
  Skim and clear with `E`.
- **All calls**: the full log except spam, newest first, including `inbox_state = done`.
  The filter also matches the outcome label ("booked", "transferred").
- **Spam**: outcome `spam`, kept out of every other view.

`E` marks done, `Z` undoes, `H` snoozes (a job re-opens the card). Later: an optional
"confirm new-customer bookings" setting would route those bookings to Needs you instead of Handled by Maya.

The value counter in the sidebar ("answered · booked · ≈ booked work") is
`count(calls)`, `count(bookings)` and `count(bookings) × avg_job_value` for the current week.

## 7. Open source and hosting

- Monorepo: `apps/web` (Next.js), `apps/api` (TypeScript), `apps/agent` (Python worker),
  `packages/schema` (shared types generated from the DB schema).
- `docker compose up` brings Postgres, MinIO, LiveKit, LiveKit SIP, API, worker and web. The
  self-hoster enters their own Telnyx/Twilio and model API keys in **Settings → Providers**.
- Callfront Cloud runs the same code with managed numbers and pass-through minute pricing.

## 8. Privacy and compliance

- AI disclosure in every greeting (cannot be turned off).
- Recording notice configurable per jurisdiction; two-party-consent US states and EU default on.
- Retention for recordings and transcripts (30 / 90 / 365 days), data region (US / EU).
- Spam scoring uses carrier attestation + number reputation; spam is never deleted silently.
