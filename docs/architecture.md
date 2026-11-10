# Linedesk architecture

Status: decided, 2026-11-10. This is the single source of truth for how Linedesk works. Why each piece was chosen (research, spikes, costs) lives in [stack.md](stack.md); product decisions in [decisions.md](decisions.md); the plan and workstreams in [plan.md](plan.md).

## 1. What v1 does

A US service business (demo: a plumber in Portland) keeps its existing phone number and forwards calls it can't take to Linedesk. An AI assistant ("Maya" by default, renamable) answers, understands the request, books appointments into the business's calendar, takes messages, escalates emergencies to a person, and turns every call into an item in a keyboard-first inbox.

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
 Caller ──PSTN──▶ Business number ──(conditional forward)──▶ Linedesk DID (Telnyx, default)
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
| Phone numbers + PSTN | **Telnyx** (default: FQDN connection to LiveKit SIP); Twilio as second adapter (Elastic SIP Trunking); Plivo, bring-your-own SIP later; LiveKit Phone Numbers for zero-config hosted inbound | One `TelephonyProvider` interface: search/buy/port numbers, SIP trunk to LiveKit, outbound, transfer, status webhooks |
| Media / SIP bridge | **LiveKit** server + LiveKit SIP (self-hosted); LiveKit Cloud (US region) for the hosted version | Rooms make listen-in and take-over trivial |
| Voice agent | **LiveKit Agents, TypeScript** (agents-js); Python/Pipecat as fallback adapter | Imports the registry's Zod schemas; audio turn detector, tool calling, DTMF, noise cancellation |
| Voice pipeline | **Cascaded** by default, each stage chosen by config: Deepgram Flux (STT) → an OpenAI mini model through OpenRouter (LLM; OpenAI direct as alternative) → ElevenLabs (TTS; Cartesia as alternative); speech-to-speech (gpt-realtime-mini / Gemini Live) as option | All behind adapters; final defaults after a latency test on real calls |
| API | **Hono** + `@hono/zod-openapi` + Zod, own `defineAction()` | One definition → REST, OpenAPI, MCP, client command |
| MCP | Official MCP TypeScript SDK v2, Streamable HTTP, stateless | API keys first, OAuth via Better Auth later |
| Database | **Postgres** + **Drizzle** (schema + migrations) | Source of truth |
| Sync to clients | Own **outbox** for writes + `ReadSyncAdapter` for reads; **Electric** default, PowerSync tested swap, LISTEN/NOTIFY + WebSocket possible | See §6 |
| Jobs | **pg-boss** | Post-call summaries, notifications, calendar sync, reminders, webhooks |
| Auth | **Better Auth**: email sign-in code + Google/Microsoft SSO, organizations, API keys, OAuth provider for MCP | Same OAuth consent can grant calendar access |
| Calendar | Own **Google Calendar** + **Microsoft Graph** adapters; CalDAV later | See §8 |
| Recordings | LiveKit egress into a `RecordingStore`: a shared directory (default, self-hosted) or any S3-compatible bucket (AWS S3, Cloudflare R2, Hetzner, Backblaze B2, MinIO), picked under Admin > Providers > Recording storage (§12) | Played through an authenticated API route; signed URLs with S3. Each call keeps the store its recording is in (`calls.recording_store`) |
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

1. **Ring.** The caller dials the business. If nobody answers within N rings (or the line is busy), the carrier forwards to the workspace's Linedesk number.
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

- `forward_conditional` (default): unanswered/busy calls go to Linedesk. Setup = dialing a carrier code (Verizon `*71<number>`, AT&T/T-Mobile `**004*<number>#`), verified with a test call.
- `forward_all`: Linedesk answers every call.
- `new` / `ported`: a new local number, or the existing number ported in.

**Connecting a number** (`phoneNumber.setup`, owner or admin, carrier from `TELEPHONY_PROVIDER`):

- `{ e164 }` attaches a number that already exists in the carrier account and buys nothing; a number that is not there is rejected.
- `{ areaCode, purchase: true }` or `{ e164, purchase: true }` buys a number. This costs money and happens only with `purchase: true`; if a later step fails, the bought number is released.
- Either way the carrier is pointed at LiveKit SIP (`LIVEKIT_SIP_ENDPOINT`) and the `phone_numbers` row is stored. Afterwards `pnpm --filter @callfront/agent setup-sip <all numbers>` makes LiveKit accept the number.

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
     action_items[], fields[], language, answered_by[ai|human], recording_key, recording_store[file|s3],
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

## 12. Admin area and provider keys

For the operator of a multi-tenant install: a view above the workspaces, and the provider keys in the database instead of only in env.

**Instance admin** is a property of the user (`user.instance_admin`), separate from the workspace roles. It adds the permission `instance:admin`, which no role has, in whatever workspace the user is active (and without a workspace). Who gets it:

- the first user of an install (existing installs: the migration marks their oldest user);
- anyone an instance admin grants it to (`instanceAdmin.grant` / `instanceAdmin.revoke`; the last enabled instance admin cannot be revoked or disabled);
- addresses in `INSTANCE_ADMIN_EMAILS`, evaluated on every request, so it applies to accounts that already exist, but only once the address is verified (an email-link sign-in or a sign-in provider verifies it). An unverified address grants nothing, and a password sign-up for a listed address is refused: otherwise someone could register the operator's address first and gain admin when the operator later verifies it.

Better Auth's admin plugin was not used: it adds impersonation, user creation, password reset and its own role system as HTTP endpoints outside the action registry. Impersonation is built on the registry instead (below), with Better Auth's own sessions and cookies.

**Impersonation.** An instance admin can sign in as a user (Admin, Users, the user, "Sign in as …") to see Linedesk as they do. Two registry actions, both in the command log: `user.impersonate` { userId } (`instance:admin`; the actor is the admin) and `impersonation.stop` (permission `impersonation:stop`, which only an impersonated session has; the actor is the user, `commands.impersonated_by` the admin). An action cannot set cookies, so both run only through `POST /v1/impersonation/start` and `/stop` (`apps/api/src/impersonation-routes.ts`); `POST /v1/actions/<name>` refuses them.

- `user.impersonate` refuses yourself, a disabled user, another instance admin (also one by `INSTANCE_ADMIN_EMAILS`) and a session that is itself an impersonation. It creates a Better Auth session for the user with its internal adapter: `session.impersonated_by` = the admin, expiry one hour, active workspace = the user's first. The route sets Better Auth's session cookie to it, signed as Better Auth signs it, and keeps the admin's own session token in a separate signed, httpOnly, SameSite=Lax cookie (`better-auth.admin_session`, Secure on https) for the same hour. The user's last sign-in is not touched.
- The hour is fixed: the session is marked "not remembered" and a `session.update` hook keeps its expiry when Better Auth would extend it; `resolveActor` also refuses it one hour after it started, and as soon as the admin is disabled or no longer an instance admin.
- While impersonating, the actor has the user's workspace permissions plus `impersonation:stop`, never `instance:admin`, so `/v1/admin/*` and admin actions are refused and no second impersonation starts. Everything else runs as the user would; commands record `impersonated_by`. Refused: Better Auth's endpoints that change credentials or the account's security or hand out tokens (change password or email, delete the user, list or revoke sessions, link or unlink accounts, account tokens; `apps/api/src/impersonation-guard.ts`) and `POST /v1/account/password`.
- `impersonation.stop` deletes the impersonation session. The route then restores the admin's session from the admin cookie only if that cookie's signature is valid and its session exists, has not expired, is no impersonation and belongs to the admin who started it, who is still an enabled instance admin; otherwise the browser is just signed out. The admin cookie is cleared either way.
- `/v1/me` returns `impersonation: { by, user, expiresAt } | null`. The web app shows a dark bar under every page with whose session it is, who is in it, the minutes left and "Return to admin", which returns to the user's page in Admin. Before starting and stopping, the outbox is sent and the local data of the ending session deleted.

**Disabling.** `user.disable` sets `user.disabled_at`, deletes the user's sessions and blocks new ones (a Better Auth `session.create` hook; the API also refuses a disabled user on every request). `workspace.disable` sets `organization.disabled_at`; `call.start` then rejects calls to its numbers, and its members keep only their read permissions (`*:read`): they can sign in and read, but no registry action that writes (triage, settings, phone numbers) runs for them. `/v1/me` reports `workspace.disabled`. Better Auth's own organization endpoints (invitations, roles) do not check it yet.

**Providers.** The registry in `packages/actions/src/admin.ts` describes each provider: label, category (telephony, speech to text, language model, voice, recording storage), its fields and which are secret or optional; `apps/api/src/provider-test.ts` holds how to test its connection. Shipped: Telnyx (API key, webhook public key; the default carrier), Twilio (account SID, auth token), Deepgram (API key, model), OpenRouter (API key, model, summary model), OpenAI (API key, model, summary model), ElevenLabs and Cartesia (API key, model, default voice), and for recording storage Local disk (`file`, no fields) and S3-compatible (`s3`, see below). Each field falls back to the variable the voice agent reads (`apps/agent/src/config.ts`): `DEEPGRAM_API_KEY`, `STT_MODEL`, `LLM_MODEL`, `SUMMARY_MODEL`, `TTS_MODEL`, `TTS_VOICE_ID`, `S3_ENDPOINT` and so on. The database stores provider id and field name as text (`provider_settings`, one row per field), so a new provider is an entry in the registry and no migration. `workspace_id` is null: the keys are for the whole install; a per-workspace override would be a row with the workspace id (not built). Sign-in providers and SMTP stay in env.

- Values are encrypted with AES-256-GCM (`apps/api/src/secrets.ts`); the key is `SECRETS_KEY` (32 bytes, base64). Without it, saving is refused with the reason. Losing or changing the key makes the stored values unreadable (the admin area still lists them as set; using them reports the problem): set the keys again.
- Resolution on every use (`apps/api/src/provider-settings.ts`): the stored value wins, the environment variable is the fallback. No restart needed after a change.
- **One provider per category is active.** An instance admin picks it (`provider.setActive`, stored in `instance_settings` as `active_provider.<category>`). Without a pick, the category's variable names it (`TELEPHONY_PROVIDER`, `STT_PROVIDER`, `LLM_PROVIDER`, `TTS_PROVIDER`, `RECORDING_STORE`, as for the agent); without that, each category uses the first provider in the registry with every needed field (telephony: Telnyx before Twilio, and `dev`, no carrier, when none is set up; `TELEPHONY_PROVIDER=dev` keeps it at `dev`). Recording storage has no such fallback: the local disk needs no fields and would always count as set up, so calls are recorded only once a store is picked or `RECORDING_STORE` names one. A picked or named provider that is not set up is not replaced by another one.
- A secret never goes back to the browser. `GET /v1/admin/providers` returns per field the source in effect (`app`, `env` or none), the last four characters of a stored secret (none for values shorter than 12 characters or from env), and who changed it when; and per category the active provider. Fields that are not secret (account SID, model, Telnyx public key) are returned in full.
- `provider.setKeys` marks its `values` as `sensitive` in `defineAction`; `run-action.ts` stores sensitive input fields in `commands` as `[redacted]` (keys kept, values dropped). Any new action that takes a secret must do the same.
- `provider.test` makes one authenticated request with an 8 second timeout. On 401/403 the provider's text is not passed on, because providers echo parts of the key; other errors carry the provider's message with every key value removed.

**Recording storage.** Where LiveKit egress writes call audio and the API reads it (`apps/api/src/recording-store.ts`).

- `file`, Local disk: a directory egress and the API share (`RECORDINGS_DIR`; the `recordings` volume with docker compose, `data/recordings` in development). No fields; it stays in env because it is a path on the server. Needs the `recording` compose profile (`pnpm recording:up`).
- `s3`, S3-compatible: endpoint URL, region (default `us-east-1`; `auto` for R2), bucket, access key ID, secret access key (the only secret), optional path prefix and the switch "force path style" (`endpoint/bucket/key`; on by default, off gives `bucket.endpoint/key`). Env fallbacks `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PREFIX`, `S3_FORCE_PATH_STYLE`. The edit form fills in endpoint, region and path style for AWS S3 (`https://s3.<region>.amazonaws.com`), Cloudflare R2 (`https://<account-id>.r2.cloudflarestorage.com`, region `auto`), Hetzner Object Storage (`https://<location>.your-objectstorage.com`), Backblaze B2 and MinIO. The key needs read, write and delete on the bucket.
- The voice agent gets the active store with `GET /v1/agent/provider-config` (`recording`, below) and starts each egress with it: a file path in the shared directory, or an S3 upload with the keys in the request (egress needs no storage settings of its own). It reports the store with the recording (`call.setRecording { store }`), and the API keeps it in `calls.recording_store`.
- Each recording is served, signed and deleted (retention job) from the store it is in, resolved on every use, so switching from the local disk to S3 (or back) needs no restart and older recordings keep playing from where they are. A call recorded before this column existed has `recording_store` null: `RECORDING_STORE` names its store, the local disk without it. S3 settings are not kept per recording: a recording in a bucket plays with the S3 settings in effect, so moving to another bucket means copying the objects (or keeping the old settings).
- `provider.test` for a store writes a small object (`.linedesk-probe-<uuid>.txt`, under the prefix), reads it back and deletes it, with the same 8 second timeout. Errors name the step and S3's status and error code (`NoSuchBucket`, `SignatureDoesNotMatch`); S3's error text is never passed on, because it quotes the key ID, and other text has the key ID and secret removed.
- `workspace.getSettings` reports `recordingOn` from the same setting; the minute sweep that links unreported recordings looks in the active store.

**LiveKit is part of the install, not a provider.** Its URL, key and secret stay in env. `GET /v1/admin/system` reports, read-only, whether the server answers (`ListRooms`) and whether an inbound SIP trunk is configured (`ListSIPInboundTrunk`). The server answers the SIP API without the SIP bridge running, so this shows the SIP setup, not that the bridge is up; the bridge has no API of its own to ask. LiveKit's API does not report a version, so none is shown.

**Admin reads** cross workspaces, so they are plain routes instead of read sync, all behind `instance:admin`: `GET /v1/admin/workspaces`, `/v1/admin/users`, `/v1/admin/usage?months=6` (calls and minutes from `calls.duration_sec` per workspace and UTC calendar month) and `/v1/admin/providers`.

**Voice agent config.** `GET /v1/agent/provider-config` with the agent token (`Authorization: Bearer $AGENT_API_TOKEN`) returns, per speech and LLM category and for recording storage, the active provider and its values in clear (the S3 secret access key included). The agent asks at the start of each call (`apps/agent/src/config.ts`, cached for 30 s per worker process), so an install can come up without keys and start answering once the operator has entered them. For a category that is `null`, or when the API cannot be reached, the agent uses its own env variables; a failure to reach the API is logged once, never with values. Members, instance admins included, get 403. A category is `null` when no provider is set up for it (or the picked one is not); optional fields such as `model` are `null` when unset. 409 `{ ok: false, error }` when stored keys cannot be decrypted. The keys inside a category are the provider's field names from the registry.

```json
{
  "stt": { "provider": "deepgram", "api_key": "…" },
  "llm": { "provider": "openrouter", "api_key": "…", "model": "…" },
  "tts": { "provider": "elevenlabs", "api_key": "…", "model": null, "voice_id": null },
  "recording": { "provider": "s3", "endpoint": "https://….r2.cloudflarestorage.com", "region": "auto", "bucket": "…",
                 "access_key_id": "…", "secret_access_key": "…", "prefix": null, "force_path_style": null }
}
```

`recording` is `{ "provider": "file" }` for the local disk, and `null` when calls are not recorded; then the agent's own `RECORDING_STORE` and `S3_*` apply, as for the other categories (`apps/agent/src/recording.ts`). An agent talking to an API without `recording` does the same.

For `apps/agent/src/config.ts`: `stt.model`, `llm.model`, `tts.model` and `tts.voice_id` are the stored values or the API's environment variables; when `null`, the agent keeps its own defaults (model ids, `baseUrl` per LLM provider). `llm.model` (live turns) and `llm.summary_model` (the summary after the call) are lists, "model, fallback, ..."; with OpenRouter the agent sends the list as `models`, so a rate limit or outage of one model falls through to the next. Defaults: live `google/gemini-2.5-flash-lite, openai/gpt-4.1-mini`, summary `google/gemini-2.5-flash, openai/gpt-5.4-mini`.

**Email sign-in by code.** Better Auth's email OTP plugin (`apps/api/src/auth.ts`): a 6-digit code by email, valid 10 minutes, 3 tries per code (then a new one is needed), stored hashed; at most 3 requests a minute per client address (Better Auth's limit), 5 codes in 10 minutes and 10 tries an hour per email address. The email has the code in its subject and body and no link. A code sign-in marks the address verified. The same flow signs up a new address where sign-up is allowed. Only sign-in codes are sent; the plugin's password-reset and email-change codes are not offered.

**Who is asking.** Rate limits key on the client address, which the API resolves itself (`apps/api/src/client-ip.ts`): the connection's address, or, when the connection comes from a proxy listed in `TRUSTED_PROXIES`, the last `X-Forwarded-For` hop before the trusted proxies. It hands that to Better Auth in its own header, replacing any value a client sent; a client cannot pick its own bucket. Per address, a before-hook allows 5 codes in 10 minutes and 10 sign-in tries an hour across codes; a refused request creates no code and leaves the current one and its tries alone. The plugin's password-reset, email-change and plain-verification endpoints are disabled (`disabledPaths`), and only `sign-in` codes can be requested.

**Closed sign-up.** `AUTH_SIGNUP_ENABLED=false` (`apps/api/src/signup-gate.ts`) refuses every new user in Better Auth's `user.create` hook, which password sign-up, a first code sign-in and a first SSO sign-in all go through. Allowed anyway: the first user of an install, and an address with a pending, unexpired workspace invitation once the address is proven (a code or a sign-in provider; a password sign-up cannot use an invitation). No code is sent to an address that cannot sign in; the answer is the same. Existing users sign in as before. Accounts are made by an instance admin with `user.invite` (Invite user in the admin area, or `pnpm --filter @callfront/api user:create --email … --name … [--admin]`, which runs the same action as the operator): the account is created unverified and the person gets an email saying how to sign in (with their address and a code from the sign-in page; no code in the invite, since codes expire). Without email delivery the action is refused; if the email cannot be sent, the account is removed again. While sign-up is closed, workspace owners can still invite people into their own workspace (Better Auth organization invitations); that is intended.