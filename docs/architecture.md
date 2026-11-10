# Callfront architecture

Status: decided, 2026-11-10. This is the single source of truth for how Callfront works. Why each piece was chosen (research, spikes, costs) lives in [stack.md](stack.md); product decisions in [decisions.md](decisions.md); the plan and workstreams in [plan.md](plan.md).

## 1. What v1 does

A US service business (demo: a plumber in Portland) keeps its existing phone number and forwards calls it can't take to Callfront. An AI assistant ("Maya" by default, renamable) answers, understands the request, books appointments into the business's calendar, takes messages, escalates emergencies to a person, and turns every call into an item in a keyboard-first inbox.

v1 = phone + calendar. It is built on the platform foundation (action registry, local-first sync, provider adapters) so WhatsApp, SMS and email can follow without rework.

Out of scope for v1: messaging channels, outbound campaigns, multi-location routing, enforced compliance guardrails (kept configurable, see §10).

## 2. Principles that shape the architecture

1. **One action, every surface.** Every user or agent action is defined once and exposed as UI command, REST endpoint, MCP tool, ⌘K entry and voice-agent tool.
2. **Instant and offline.** The UI applies every action locally at once and syncs in the background; it keeps working offline.
3. **Adapters with a recommended default.** Telephony, speech, LLM, calendar and sync providers are swappable behind interfaces; setup always suggests one.
4. **Easy to self-host, able to scale.** `docker compose up` gives a working install; the same images scale horizontally.
5. **Open-source ready.** No secrets or customer data in the repo; paid-only code lives in `ee/`.

## 3. System overview

```
 Caller ──PSTN──▶ Business number ──(conditional forward)──▶ Callfront DID (Telnyx, default)
                                                                   │ SIP
                                                                   ▼
                                                       LiveKit SIP service
                                                                   │ joins room
                                                                   ▼
                                ┌─────────── LiveKit room (one per call) ───────────┐
                                │  caller (SIP participant)                          │
                                │  voice agent (LiveKit Agents, TypeScript)          │
                                │  owner (optional: browser or phone when taking over)│
                                └────────────────────────────────────────────────────┘
                                        │ agent tools = registry actions
                                        ▼
  Web app (Vite SPA) ─commands─▶  API (Hono): action registry ──▶ Postgres ◀── worker (pg-boss jobs)
   local store + outbox  ◀─reads──  read-sync adapter (Electric)       │
                                        │                              └── object storage (recordings)
                     REST + OpenAPI · MCP server · webhooks
                                        │
                         Google Calendar · Microsoft Graph
```

## 4. Components

| Component | Choice | Notes |
|---|---|---|
| Phone numbers + PSTN | **Twilio** (default, Elastic SIP Trunking); Telnyx as second adapter; Plivo, bring-your-own SIP later; LiveKit Phone Numbers for zero-config hosted inbound | One `TelephonyProvider` interface: search/buy/port numbers, SIP trunk to LiveKit, outbound, transfer, status webhooks |
| Media / SIP bridge | **LiveKit** server + LiveKit SIP (self-hosted); LiveKit Cloud (US region) for the hosted version | Rooms make listen-in and take-over trivial |
| Voice agent | **LiveKit Agents, TypeScript** (agents-js); Python/Pipecat as fallback adapter | Imports the registry's Zod schemas; audio turn detector, tool calling, DTMF, noise cancellation |
| Voice pipeline | **Cascaded** by default, each stage chosen by config: Deepgram Flux (STT) → an OpenAI mini model through OpenRouter (LLM; OpenAI direct as alternative) → ElevenLabs (TTS; Cartesia as alternative); speech-to-speech (gpt-realtime-mini / Gemini Live) as option | All behind adapters; final defaults after a latency test on real calls |
| API | **Hono** + `@hono/zod-openapi` + Zod, own `defineAction()` | One definition → REST, OpenAPI, MCP, client command |
| MCP | Official MCP TypeScript SDK v2, Streamable HTTP, stateless | API keys first, OAuth via Better Auth later |
| Database | **Postgres** + **Drizzle** (schema + migrations) | Source of truth |
| Sync to clients | Own **outbox** for writes + `ReadSyncAdapter` for reads; **Electric** default, PowerSync tested swap, LISTEN/NOTIFY + WebSocket possible | See §6 |
| Jobs | **pg-boss** | Post-call summaries, notifications, calendar sync, reminders, webhooks |
| Auth | **Better Auth**: email magic link + Google/Microsoft SSO, organizations, API keys, OAuth provider for MCP | Same OAuth consent can grant calendar access |
| Calendar | Own **Google Calendar** + **Microsoft Graph** adapters; CalDAV later | See §8 |
| Recordings | LiveKit egress into a `RecordingStore`: a shared directory (default, self-hosted) or any S3-compatible bucket (R2/S3 hosted) | Played through an authenticated API route; signed URLs with S3 |
| Web app | **React SPA (Vite)** with local store, outbox, service worker | Built from the merged prototype (`prototypes/inbox-html`, Relay design) |
| Monorepo | **pnpm + Turborepo** | Layout in §11 |
| Billing (hosted only) | Stripe metered billing on answered minutes | Lives in `ee/` |

## 5. Action registry

Every action is defined once:

```ts
defineAction({
  name: 'call.markDone',
  input: z.object({ callId: z.string() }),
  permission: 'call:write',
  apply: (store, input) => { /* optimistic local change, runs in the browser */ },
  handler: async (ctx, input) => { /* authoritative, runs on the server, writes Postgres */ },
  event: 'call.done',
})
```

From that definition we generate:

| Surface | Generated |
|---|---|
| Web app | instant local mutation (`apply`) + outbox command, ⌘K entry |
| REST | `POST /v1/actions/<name>` + OpenAPI spec |
| MCP | one tool per action, same schema and permission |
| Voice agent | tool with the same schema (e.g. `appointment.book`) |
| Events | webhook / internal event per action |

Reads are defined once as named queries and exposed to the UI (live via sync), REST and MCP.

### v1 actions (initial set)

| Area | Actions |
|---|---|
| Calls | `call.markDone`, `call.markNotDone`, `call.remind`, `call.clearReminder`, `call.markRead`, `call.markUnread`, `call.assign`, `call.callBack`, `call.delete` |
| Live call | `call.listen`, `call.takeOver`, `call.hangUp` |
| Bookings | `calendar.findSlots`, `appointment.book`, `appointment.reschedule`, `appointment.cancel` |
| Contacts | `contact.lookup`, `contact.update` |
| Agent-only | `call.takeMessage`, `call.transfer`, `call.end`, `call.flagUrgent` |
| Settings | `assistant.update`, `appointmentType.upsert`, `calendar.connect`, `calendar.setFlags`, `phoneNumber.setup`, `phoneNumber.verifyForwarding` |

## 6. Sync: "commands up, data down"

- **Writes:** every registry call from the web app is a command. The client applies it to its local store immediately, persists it in an IndexedDB outbox and replays it in order to `POST /v1/actions/<name>` (idempotent per command id). The server is authoritative; a rejection rolls the local change back and shows a toast.
- **Reads:** Postgres → local store through our `ReadSyncAdapter` interface, scoped per workspace and permission. Default adapter: Electric. Swapping the provider touches only the adapter file, not the UI.
- **Offline:** reads and queued writes survive a reload; a service worker serves the app shell.
- **Live calls:** transcript segments are rows like any other, so they arrive through the same read sync (target < 1 s).

## 7. Call lifecycle

1. **Ring.** The caller dials the business. If nobody answers within N rings (or the line is busy), the carrier forwards to the workspace's Callfront number.
2. **Ingress.** The provider sends the call over SIP to LiveKit SIP. A dispatch rule maps the DID to a workspace and creates room `call_<id>`. The API creates `Call { status: live }`; it appears at the top of Needs you with a live indicator.
3. **Caller lookup.** First tool: `contact.lookup(phone)` → contact, past calls, upcoming bookings, so returning customers are greeted by name.
4. **Greeting.** Configurable greeting; AI disclosure on by default (configurable, §10).
5. **Conversation.** The agent follows the assistant config (business knowledge, services, service area, FAQs, booking types, urgent and transfer rules). Its tools are registry actions:

   | Tool | Effect |
   |---|---|
   | `contact.lookup` | Contact + history |
   | `calendar.findSlots(type, window)` | Free slots = working hours ∩ free/busy of conflict calendars − buffers − min notice |
   | `appointment.book` / `.reschedule` / `.cancel` | Writes the calendar event, stores `Booking`, links the call |
   | `call.takeMessage` | Adds an action item to the call |
   | `call.flagUrgent` | Marks urgent (e.g. "leak", "gas smell"), triggers notification |
   | `call.transfer(reason)` | Warm transfer via LiveKit SIP; on no answer the agent takes a message and flags urgent |
   | `call.end` | Hangs up politely |

   Every tool call is also written to the transcript as a system event ("Checked availability · 3 slots").
6. **Live view.** Transcript streams to the web app. The owner can **Listen** (joins muted) or **Take over** (joins with mic, or LiveKit dials the owner's phone; the agent hands off).
7. **Hang-up.** Recording finalised to object storage.
8. **Post-call job.** An LLM pass returns structured JSON: `title`, `summary`, `outcome`, `urgency`, `intent`, `actionItems[]`, `fields[]`, spam score. The call moves to the right view.
9. **Notify.** Push / email for urgent and callback-needed calls; daily digest for the rest.

Target latencies: answer < 1 ring after forward, first agent word < 1.2 s, turn latency < 800 ms, call summary ready < 10 s after hang-up.

## 8. Phone setup and calendar

**Phone number modes** (`PhoneNumber.mode`):

- `forward_conditional` (default): unanswered/busy calls go to Callfront. Setup = dialing a carrier code (Verizon `*71<number>`, AT&T/T-Mobile `**004*<number>#`), verified with a test call.
- `forward_all`: Callfront answers every call.
- `new` / `ported`: a new local number, or the existing number ported in.

US practical notes: outbound needs a SIP trunk; Twilio needs Trust Hub + SHAKEN/STIR for A attestation; cold transfer needs SIP REFER on the trunk.

**Calendar:**

- OAuth scopes: Google `calendar.events` + `calendar.freebusy` (not restricted, no CASA audit; never Gmail/Drive), Microsoft `Calendars.ReadWrite`.
- Per calendar two flags: **check conflicts** and **book into** (exactly one booking calendar per workspace in v1).
- Availability engine in the API: working hours + exceptions, appointment types (duration, buffer, min notice, max days ahead, location), free/busy of all conflict calendars, existing bookings.
- Events: title `<Type> · <Caller>`, description with summary, phone, address and a deep link to the call.
- Sync back: Google `events.watch` / Graph subscriptions update `Booking` when the owner moves or deletes an event.

## 9. Data model

```
Workspace(id, name, locale, avg_job_value, plan, region)
Member(id, workspace_id, name, email, role[owner|admin|member], phone)
PhoneNumber(id, workspace_id, e164, provider[telnyx|twilio|plivo|byo_sip], mode, forwarded_from, verified_at)
Assistant(id, workspace_id, name, voice{provider, voice_id}, languages[], greeting,
          disclose_ai=true, recording_notice, pipeline{mode[cascaded|realtime], stt, llm, tts},
          business_profile{description, services[], service_area, address, hours, faqs[], never_say[]},
          escalation{transfer_to_member_id, urgent_keywords[], rules[]}, capabilities{...})
CalendarConnection(id, workspace_id, provider[google|microsoft|caldav], account_email, status)
Calendar(id, connection_id, external_id, name, color, check_conflicts, book_into)
WorkspaceSettings(workspace_id, timezone)   -- table workspace_settings; IANA zone, default America/New_York when missing
AvailabilityRule(id, workspace_id, weekday[0=Sunday..6], start_time, end_time)   -- wall clock, end after start, 24:00 allowed
AvailabilityException(id, workspace_id, date, start_time?, end_time?)   -- replaces the day's hours; no times = closed
AppointmentType(id, workspace_id, name, duration_min, buffer_min, min_notice_hours,
                max_days_ahead, location[on_site|office|phone|video], enabled)
Contact(id, workspace_id, name, company, phone, email, address, tags[], note)
Call(id, workspace_id, contact_id, from, to, direction[in|out], started_at, ended_at, duration_sec,
     status[live|completed], outcome[booked|rescheduled|cancelled|callback|message|answered|
     transferred|hangup|spam], urgency[urgent|normal|low], intent, title, summary,
     action_items[], fields[], language, answered_by[ai|human], recording_key,
     inbox_state[open|done], reminder_at, reminder_label, unread, assignee_id,
     deleted_at, billed_seconds)
TranscriptSegment(id, call_id, speaker[agent|caller|human|system], text, at_ms, tool_event?)
Booking(id, workspace_id, call_id, contact_id, appointment_type_id, start_at, end_at,
        status[confirmed|rescheduled|cancelled], calendar_id, external_event_id)
Command(id, workspace_id, member_id, action, input, status, created_at)   -- outbox replay log, idempotency
UsagePeriod(workspace_id, period, answered_seconds, cost_cents)
```

### Inbox semantics

Views are derived, not stored. They answer one question: does a person still have to act?

- **Needs you:** open calls a person has to act on: live calls, `urgency = urgent`, outcomes `callback | message | hangup`. Priority order inside each day: live, urgent, new-caller callbacks, other callbacks, messages, hang-ups.
- **Handled by Maya:** open calls the assistant finished (`booked | rescheduled | cancelled | answered | transferred`). Skim and clear with E.
- **Spam:** outcome `spam`, kept out of every other view, never deleted silently.
- **Reminders:** calls with `reminder_at` in the future; they return to their view when it passes.
- **Done:** `inbox_state = done`.
- **Search** (`/`) covers all calls, including transcripts.

E marks done (Z undoes), H sets a reminder. The sidebar value counter is `count(calls)`, `count(bookings)` and `count(bookings) × avg_job_value` for the current week.

## 10. Compliance (configurable, not enforced in v1)

US first. Guardrails come once we know the starting states and use cases; the design keeps them easy to add:

- AI disclosure in the greeting: on by default, configurable.
- Recording notice, outbound-call consent (TCPA), retention, data region: settings fields exist or are planned; nothing is enforced yet.
- Spam scoring uses carrier attestation + number reputation.

## 11. Repository and deployment

**Target monorepo layout** (created by the foundation workstream):

```
apps/
  web/        Vite SPA (local store, outbox, service worker)
  api/        Hono server: registry, REST, OpenAPI, MCP, webhooks
  worker/     pg-boss jobs (same image as api)
  agent/      LiveKit Agents (TypeScript)
packages/
  actions/    defineAction(), registry, shared Zod schemas
  db/         Drizzle schema + migrations
  sync/       outbox, ReadSyncAdapter, Electric/PowerSync adapters
  telephony/  TelephonyProvider + Telnyx/Twilio/Plivo/BYO-SIP adapters
  calendar/   Google / Microsoft adapters, availability engine
  ui/         shared components from the prototype
ee/           hosted-only features (billing, SSO)
prototypes/   clickable prototypes (no backend)
docs/
```

Janik's Next.js mock-up currently lives at the repo root (`src/`); it moves to `prototypes/callfront-next/` when the monorepo is created.

**Default `docker compose`:** caddy, app (web + API + MCP), worker, voice agent, postgres, electric, livekit-server, livekit-sip, redis/valkey (needed by LiveKit SIP); optional `recording` profile (livekit-egress writing to a shared directory; no storage server). App, worker and agent are stateless replicas; LiveKit scales via Redis; Postgres can be managed.

**Hosted version:** same code, LiveKit Cloud (US), managed numbers, US East region, pass-through minute pricing.
