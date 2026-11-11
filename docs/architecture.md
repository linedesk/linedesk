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
| Auth | **Better Auth**: email sign-in code + Google/Microsoft/GitHub sign-in, organizations, API keys, OAuth provider for MCP | Same OAuth consent can grant calendar access |
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
- **Action answers** (`apps/api/src/run-action.ts`): 200 `{ ok: true, rows, data? }`; 403 `{ ok: false, error, code: "forbidden" }` when this caller may not do it (a missing permission, an owner-only rule, not while signed in as another user or with an API key; handlers throw `Forbidden`); 409 `{ ok: false, error }` when the data's state does not allow it (`Reject`: not found, the last owner); 422 for invalid input, said as plain sentences that name fields as people say them ("Account SID", not `values.account_sid`). A replayed command answers with the status of its first answer. Input fields an action does not take: 422 for API keys and other callers; dropped with a warning in the API log for the web app's sessions and the voice agent, because the outbox replays commands stored by an older release after a deploy and the agent can run one release behind the API.
- **Cross-site writes:** every non-GET request under `/v1` signed in by the session cookie (no `Authorization: Bearer`) must come from the web app's origin (`Origin` equal to `WEB_ORIGIN`) and be `application/json`, else 403 `cross_site_refused` (`apps/api/src/csrf.ts`, before every `/v1` route). The cookie is SameSite=Lax, so a page on another subdomain of the same site would still send it, and a `text/plain` POST needs no preflight. API keys and the agent (Bearer) are not affected; Better Auth checks the Origin of `/api/auth/*` itself.
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
   | `transfer_call` → `call.transfer(to, result)` | Warm transfer to the assistant's on-call number (see below); on no answer the agent takes a message, the call is urgent |
   | `call.end` | Hangs up politely |

   Every tool call is also written to the transcript as a system event ("Checked availability · 3 slots").

   **Warm transfer** (per assistant: `transfer_urgent`, `transfer_number`, checked by `onCallNumberProblem`: US landlines and mobiles only (libphonenumber's US region, so not Canada, the Caribbean or territories), never premium rate (900, 976 behind any area code), 500/700, toll-free or N11; `transfer_hours_only`: not while the business is closed). The agent offers `transfer_call` only when transfer applies on this call and someone can be dialled (`apps/agent/src/transfer-tool.ts`). The agent first asks the API with `call.transfer` `dialing`, which keeps the workspace's limits (6 transfers started an hour, one on-call leg ringing or connected at a time, under a per-workspace advisory lock); a refusal means a message. The caller hears a fixed "I'm connecting you…" line, then a ringback tone; the agent joins a consult room `<room>-oncall` and dials the on-call number into it with `CreateSIPParticipant` through the LiveKit outbound trunk `linedesk-outbound` (`setup-sip --outbound`; Telnyx credential connection of the same name, caller ID = the business's Linedesk number), ringing at most 25 s. A small voice session there (speech recognition and voice, no LLM) says "Urgent call from <name or number> about <topic>. Press 1 or say yes…" (not interruptible), twice at most, and only after it has played counts key 1/2 or a short clear yes/no (at most six words, nothing that sounds like a voicemail greeting), so a voicemail is never put through. On yes the call's recording is stopped (the conversation with the on-call person is not recorded; if it cannot be stopped, nobody is put through and the assistant takes a message) and the agent bridges the audio of both rooms itself (`audio-bridge.ts`) and stays silent; the call ends when either side hangs up, outcome `transferred`. On no, no decision (voicemail) or no answer the consult room is deleted, which hangs up the on-call phone, and the assistant takes a message. `call.transfer` stores `transfer_to` and `transfer_result` (`connected | not_answered | declined | failed`) and marks the call urgent; the call view shows "Transferred to …" or "Transfer not answered". Why the agent bridges instead of LiveKit's `MoveParticipant` (Cloud only: "not implemented" on self-hosted LiveKit 1.13) or SIP REFER (cold, carrier-dependent, the call leaves LiveKit): decisions.md. Closing the consult room is registered as a shutdown callback before anything is dialled, and a dial stops waiting as soon as the caller hangs up. Test calls never dial an on-call phone: browser test calls are not offered the transfer, phone call tests (from `CALL_TEST_FROM`) neither, and the `transfer-*` call-test scenarios refuse `--phone` and use a simulated on-call person (the one exception is the live transfer test below, an explicit opt-in). The `linedesk-outbound` Telnyx voice profile is US-only (allowed destinations `US` only; created on the global plan, the only one Telnyx accepts for new profiles), set again on every `setup-sip --outbound`, and setup fails if Telnyx does not keep the list at `US`; Linedesk only manages Telnyx objects named `linedesk-*`.

   **Live transfer test** (operators, over real phone lines; a few cents per call). It needs one more number in the install's Telnyx account (not connected to any workspace), the test on-call number, answered by the on-call responder (`apps/agent/src/oncall-responder.ts`): the worker plays the on-call person, waits for the briefing, says "Yes, put them through." and presses 1, then says to the caller "Hi, this is Mike, the on-call plumber…" and hangs up, so the test caller's transcript proves the bridge. Setup, once: buy the number and point it at LiveKit SIP like any other (Telnyx connection `linedesk-livekit`), then `setup-oncall-test <on-call number> [--answer accept|decline|no-answer]` (its own inbound trunk and dispatch rule `linedesk-oncall-test`, same carrier address list; never pass this number to `setup-sip`), and `setup-sip --outbound <every business number>` once for the `linedesk-outbound` trunk. Per run: turn transfer on for the test workspace's assistant with the on-call number as `transfer_number`; set `CALL_TEST_ONCALL=<on-call number>` in the agent's env and recreate the agent container; `call-test transfer-accepted --phone` (from `CALL_TEST_FROM` to `CALL_TEST_TO`). With `CALL_TEST_ONCALL` set, a phone call test may be put through to exactly that number and no other (`liveTransferTestAllows`), and call-test allows `--phone` for the `transfer-*` scenarios; without it both stay refused. Check: the test caller's lines in the agent log ("business: Hi, this is Mike, the on-call plumber…"), the call shows "Transferred to …", the recording ends at the bridge, and no `call-*`, `*-oncall` or `oncall-test-*` room is left after hang-up (`lk room list`). Afterwards: transfer off again (keep the number), unset `CALL_TEST_ONCALL` and recreate the agent container (`docker compose up -d agent`; wait until the new worker is registered before the next call). The trunk, rule and number can stay for the next run; to tear the test down, `setup-oncall-test --remove` deletes the trunk and dispatch rule (calls to the number then reach no agent), and the number is released in the Telnyx portal. The on-call number may not be a Linedesk number or a line that forwards to one: `assistant.update` refuses both.
6. **Live view.** Transcript streams to the web app. The owner can **Listen** (joins muted) or **Take over** (joins with mic, or LiveKit dials the owner's phone; the agent hands off).
7. **Hang-up.** Recording finalised to object storage.
8. **Post-call job.** An LLM pass returns structured JSON: `title`, `summary`, `outcome`, `urgency`, `intent`, `actionItems[]`, `fields[]`, spam score. The call moves to the right view.
9. **Notify.** Email per finished call and Web Push (opt-in per member and browser; VAPID keys from env; one notification per call that a flagged-urgent, message-taken or finished push updates; payload is who called plus, if opted in, one line); daily digest for the rest later. See README, Push notifications.

Target latencies: answer < 1 ring after forward, first agent word < 1.2 s, turn latency < 800 ms, call summary ready < 10 s after hang-up.

## 8. Phone setup and calendar

**Phone number modes** (`PhoneNumber.mode`):

- `forward_conditional` (default): unanswered/busy calls go to Linedesk. Setup = dialing a carrier code (Verizon `*71<number>`, AT&T/T-Mobile `**004*<number>#`), verified with a test call.
- `forward_all`: Linedesk answers every call.
- `new` / `ported`: a new local number, or the existing number ported in.

**Connecting a number** (`phoneNumber.setup`, owner or admin, carrier from `TELEPHONY_PROVIDER`):

- `{ e164 }` attaches a number that already exists in the carrier account and buys nothing; a number that is not there is rejected.
- `{ areaCode, purchase: true }` or `{ e164, purchase: true }` buys a number. This costs money and happens only with `purchase: true`; if a later step fails, the bought number is released.
- Either way the carrier is pointed at LiveKit SIP (`LIVEKIT_SIP_ENDPOINT`) and the `phone_numbers` row is stored. Afterwards `pnpm --filter @linedesk/agent setup-sip <all numbers>` makes LiveKit accept the number (from the carriers' signaling addresses only, see below).

**Own carrier account** (Settings › Phone numbers › Carrier; owners and admins, `settings:write`). By default a workspace uses the install's carrier (Admin › Providers). It can bring its own Twilio or Telnyx account instead:

- `workspace_settings.carrier`: `default`, `twilio` or `telnyx`. The credentials are `provider_settings` rows with the workspace's id: Twilio Account SID plus either an API key (SID and secret, recommended) or the auth token; Telnyx an API key. AES-256-GCM with `SECRETS_KEY`, each ciphertext bound to `workspace:<id>:<carrier>.<field>`, so a value copied into another workspace's row does not decrypt. Without `SECRETS_KEY` saving is refused.
- `carrier.set` replaces the credentials as a whole (switching carrier or back to `default` deletes the old ones); its `values` are `sensitive`, so the command log keeps them as `[redacted]`. The browser calls it directly, not through the outbox, so credentials are never kept in IndexedDB. `carrier.get` returns the carrier, which fields are set, the Account SID and API key SID (not secret) and the last four characters of a stored secret of 12 characters or more; never a secret. Members and the agent token get 403.
- `carrier.test` ("Test connection", run after every save) only reads: it lists up to 20 numbers of the account (`TelephonyProvider.listNumbers`) with an 8 second timeout, at most 10 per workspace in 10 minutes. 401/403 answer with a fixed text; other errors carry the carrier's text with every credential removed. Stored values that cannot be decrypted (another `SECRETS_KEY`) are reported as "enter them again", never with the operator's detail.

- Concurrency: `carrier.set`, `phoneNumber.setup` and `phoneNumber.release` first take a per-workspace transaction lock (`pg_advisory_xact_lock(hashtext('carrier:<workspace id>'))`, `lockWorkspaceCarrier`), so the carrier cannot be switched while a number is being set up or released with it (setup holds its transaction across the carrier requests).
- Numbers already in the install's account: only an instance admin may attach one to a workspace (`phoneNumber.setup` without buying, or with `purchase` for a number the account already has); other members buy a new number or bring their own account. `/v1/me` `phoneSetup.canAttach` tells the web app, which then offers only "Get a new number". The `workspace:create` CLI runs as the operator. Without a carrier (`dev`) and in the workspace's own account attaching is open to owners and admins.
- Numbers: `phoneNumber.setup` resolves the carrier per workspace (`telephonyForWorkspace`, `apps/api/src/workspace-carrier.ts`): the workspace's own account when it has one, else the install's. The number row stores which (`phone_numbers.carrier_account`: `workspace` | `install`), and `phoneNumber.release` releases or un-routes it only in that account: a `workspace` number with the workspace's own credentials (read by the number's own workspace id), an `install` number with the install's carrier. Numbers that were connected before a workspace brought its own account stay `install`. Attaching looks the number up in the workspace's account, so a number can only be added by the workspace whose account has it (and `e164` is unique across the install).
- While numbers are in the workspace's own account, `carrier.set` refuses another carrier or `default` ("Disconnect it first"), and new credentials for the same carrier must find every one of those numbers with the same carrier id (read-only look-ups), so a number is never managed with credentials of an account it is not in.
- `/v1/me` `phoneSetup` reports the workspace's carrier (own account, else the install's); Settings › Phone numbers lets owners add numbers with their own account even when the install has no carrier.
- Webhooks of a workspace's account verify with that account's own key: the adapter built from the workspace's credentials (`ownCarrierProvider`) checks Twilio signatures with the workspace's auth token (refused with only an API key: Twilio signs with the auth token) and Telnyx signatures with the workspace's optional webhook public key, never the install's. No API route receives carrier webhooks yet; a future one must pick the verifier by the number's `carrier_account` and workspace.
- Inbound calls still go through Linedesk's LiveKit SIP; the voice agent and the dispatch do not change (DID → `phone_numbers` row → workspace).
- Warm transfers dial out through the account the called number is in. An `install` number uses the install's `linedesk-outbound` trunk as before. For a `workspace` number the API (never the agent) sets up the outbound side, `apps/api/src/transfer-trunk.ts`: in the workspace's account an object named `linedesk-outbound-<workspace id>` (Twilio: Elastic SIP trunk with a termination domain `linedesk-outbound-<random>.pstn.twilio.com` and a credential list, `createTwilioOutbound`; Telnyx: credential connection and US-only voice profile, `createTelnyxOutbound`), so two workspaces sharing one account never rotate each other's SIP password; and in LiveKit the trunk `linedesk-outbound-<workspace id>-<account fingerprint>` (a hash of the Twilio Account SID or the Telnyx key) with the workspace's own-account numbers as caller IDs. It is set up when a number is connected or released and when the carrier is set (`carrier.set` first deletes the workspace's LiveKit outbound trunks, so a trunk of an old account is never dialled through); carrier and LiveKit requests each give up after 8 s, and a failure is logged without undoing the change. The agent asks `carrier.transferTrunk { from }` (agent token, `x-workspace-id`; the number must be that workspace's) for the carrier and the trunk's exact name and finds it only when the transfer dials; when it is missing, lacks the caller ID, or the carrier refuses its credentials (SIP 401/407, once; not 403, which Twilio also sends for a destination the account may not call), it calls `carrier.provisionTransferTrunk` (under the workspace carrier lock, at most 3 per workspace in 10 minutes), which is logged in the command log and the audit log (kind `keys`, like `carrier.set`). A set-up caused by `phoneNumber.setup`, `phoneNumber.release` or `carrier.set` writes the same audit entry with its trigger. A new set-up creates the new LiveKit trunk before it deletes the old one. No carrier credential ever goes to the agent. A workspace cannot bring the install's own account (same Twilio Account SID or Telnyx key: refused; Telnyx names no account id without a request per key, so another key of the install's Telnyx account is not recognised); when the install's keys cannot be read the check cannot run and saving is refused. A number in a workspace's own account whose account is gone gets no transfer, never the install's trunk. Allowed destinations are the carrier's account setting (Twilio Voice Geographic Permissions); Linedesk checks the on-call number before dialling (US only).

**What the business configures for its own account.** Nothing on the SIP side: Linedesk provisions it through the carrier's API with the credentials.

- Twilio: in the Twilio Console, Account › API keys & tokens, create a Standard API key; enter the Account SID, the key SID and secret (or the auth token instead). Elastic SIP Trunking must be available on the account (it is by default). On "Add number", Linedesk creates (once) an Elastic SIP trunk named `linedesk-livekit` whose origination URI is `sip:<LIVEKIT_SIP_ENDPOINT>;transport=tcp`, and attaches the number to it (a number belongs to one trunk, so a number on another trunk moves to this one). Disconnecting takes the number off that trunk (it then has no voice routing and stops answering until the business routes it again); nothing else in the account is changed. A number bought through Linedesk is bought in, and billed by, the business's account, and released there.
- Telnyx: create an API key (Auth › API keys) and enter it. Linedesk creates (once) an FQDN connection `linedesk-livekit` to `<LIVEKIT_SIP_ENDPOINT>` port 5060 over TCP and assigns the number to it; disconnecting un-assigns it (`connection_id` null) only if it is still on that connection, so it stops answering until the business routes it again; Settings says so before disconnecting. Objects not named `linedesk-*` are never changed.
- Calls and numbers are billed by the carrier to the business; Linedesk does not see the carrier's invoice.

**What the operator does.** `LIVEKIT_SIP_ENDPOINT` must be reachable from the business's carrier (the same public address the install's carrier uses). Like every number today, a newly connected number still has to be added to LiveKit's inbound trunk (`pnpm --filter @linedesk/agent setup-sip <all numbers>`) before calls are accepted. Open point: LiveKit's inbound trunk has no allowed-address or credential list yet, so any SIP source that reaches the endpoint could present any connected number as the dialled number; with several carrier accounts the fix is per-trunk authentication or the carriers' signalling ranges (not built).

**Who may call in (inbound SIP).** LiveKit SIP listens on 5060 for the whole internet, and an INVITE carries whatever caller ID and called number the sender likes. So the inbound trunk `linedesk-inbound` only takes calls whose source IP is one of the carriers' published signaling addresses (`allowedAddresses`); any other INVITE matches no trunk, and since the dispatch rule is bound to that trunk, LiveKit answers 404 and no room, agent or call row is created. The addresses are in one file, `packages/telephony/src/signaling-addresses.ts`, with the source and the date each list was checked: Telnyx's primary and secondary signaling IP of every SIP region (sip.telnyx.com/voice.json), Twilio's Elastic SIP Trunking signaling gateways of every edge (/30 each). LiveKit compares IP entries only with the packet's source address (a hostname entry would be compared with the From host, which the caller sets), so only IPs and CIDR ranges are accepted.

- `setup-sip` applies it on every run: it updates the trunk in place (same id, no gap), creates it if missing, and warns about other LiveKit objects that would still let calls in from anywhere (inbound trunks with neither addresses nor credentials, dispatch rules bound to no trunk). It does not change them.
- `LIVEKIT_SIP_ALLOWED_ADDRESSES` (default `telnyx twilio`) lists carrier names and/or IPs and CIDR ranges, for BYO SIP or a self-hoster's own PBX; `any` alone turns the restriction off and `setup-sip` warns. Anything else is refused, so a typo never leaves the trunk open (LiveKit itself silently drops entries it cannot parse, and an empty list means open). `setup-sip --print-allowed-addresses` prints the list for a firewall.
- Why IP allowlists and not SIP digest (`authUsername`/`authPassword`) for both carriers: Twilio's trunk origination does not answer a digest challenge. Telnyx delivers to our FQDN connection, and neither the FQDN connection API nor Telnyx's LiveKit guide offers credentials for calls Telnyx sends out (its user name and password are for calls into Telnyx); a Telnyx credential connection only delivers calls to a registered SIP client, and LiveKit SIP does not register. A digest challenge would refuse every real call. The cost of the allowlist: when a carrier adds signaling addresses, calls from them are refused until the file is updated; the carriers announce such changes, and the `checked` dates say when the list was last compared.
- Per-workspace carrier accounts (Twilio or Telnyx) send from the same published addresses as the install's account, so one list covers every workspace; a workspace on another carrier or its own SIP gear needs its addresses added.

US practical notes: outbound needs a SIP trunk; Twilio needs Trust Hub + SHAKEN/STIR for A attestation; warm transfer needs the `linedesk-outbound` trunk (`setup-sip --outbound`, Telnyx for now); a cold transfer would need SIP REFER on the trunk (not used).

**Calendar:**

- Connecting: an owner or admin clicks Connect Google / Connect Microsoft (`calendar.connectStart`, returns the consent URL). The OAuth apps are the sign-in apps (`GOOGLE_*`, `MICROSOFT_*`), but the flow is Linedesk's own, not a Better Auth account link: a linked account would also become a way to sign in. State (32 random bytes, the row id of `calendar_oauth_states`) is bound to the member and workspace, single use, 10 minutes; PKCE S256. The provider returns to `GET /v1/calendar/callback/<provider>` (redirect URI `<BETTER_AUTH_URL>/v1/calendar/callback/google|microsoft`), which runs `calendar.connectFinish` as the signed-in member (the code is redacted in the command log) and redirects to `#assistant/calendar`. Not while impersonating. Sign-in asks for no calendar scope.
- OAuth scopes (asked only when connecting): Google `calendar.events` + `calendar.freebusy` + `calendar.calendarlist.readonly` (not restricted, no CASA audit; never Gmail/Drive), Microsoft `Calendars.ReadWrite` + `offline_access` + `User.Read`. A Google grant without the calendar scopes is refused and revoked.
- A connection (`calendar_connections`: provider, account email, status, who connected it) belongs to the workspace and is synced; its tokens are in `calendar_credentials` (never synced), AES-256-GCM with `SECRETS_KEY`, each ciphertext bound to its connection and kind. An access token with less than a minute left is refreshed on use; Microsoft's new refresh token replaces the old. A refused refresh marks the connection `needs_reconnect`. `calendar.disconnect` deletes the connection, its tokens and its assistant calendars, then revokes the grant at Google (Microsoft has no per-app revoke; the result tells the member where to remove it).
- An assistant books into one or more calendars (`assistant_calendars`: calendar, the owner's instruction for when to use it, enabled, one default). Only calendars the account can write to can be added; the name comes from the provider.
- Availability engine in the API (`apps/api/src/bookings.ts`): working hours + exceptions when business hours are switched on (else Monday to Friday 9 to 5 in the workspace time zone), appointment types (duration, buffer, min notice, max days ahead, location), the chosen calendar's busy times at the provider (one request, 4 s timeout), existing bookings of that calendar. `calendar.findSlots` takes `calendarId` and local `fromDate`/`toDate`; each slot has a spoken `label`.
- Booking on a call: `call.start` returns `booking` (appointment types with their required details, the answering assistant's enabled calendars of connected accounts with their instructions, today in the business time zone, and `canChangeBookings`) or null; then the assistant only takes messages. The agent's tools `find_slots` and `book_appointment` (and `cancel_appointment`/`reschedule_appointment` when `canChangeBookings`) run `calendar.findSlots`, `appointment.book`, `appointment.cancel`, `appointment.reschedule` (permission `calendar:write`: every role and the agent). The model picks the calendar from the instructions; the API checks it belongs to the assistant that answered the call, re-checks the slot under a per-calendar advisory lock, writes the event (title `<Type> · <Caller>`, reason, phone, address, link to the call) and stores the booking; if the transaction fails the event is deleted. Caller ID is a hint, never identity (it is cheap to fake): the agent is never told a caller's bookings (`upcoming` is always empty, kept for older agents). To cancel or move one the caller says its day and the name it is booked under; the agent passes both (`bookingDate`, `bookedName`, never a booking id) and the API finds the one upcoming booking of the call's contact on that day in the business time zone whose name matches (the booked name's last word must be among the words said, and nothing said may be missing from it), or refuses with the same answer whatever was wrong; the agent stops after two descriptions that match nothing and takes a message. By id the agent can only change a booking made on the same call (the call test cleans up that way). A withheld or malformed caller ID (not E.164: "anonymous", "restricted", no caller ID at all) gets no contact (such callers would all share one), so no booking changes, no blocking by number, and it is never put on a booking as the phone number. Only bookings made through Linedesk exist. Each appointment type can require phone, email or address on top of name and reason. A booking with an email address queues a confirmation email (pg-boss `booking.confirm`); no SMS yet. The call's outcome is `booked`.
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
- Recording notice: a workspace setting, off by default, with no per-state logic (Settings, Recordings: "Say that the call may be recorded" and the sentence, default "This call may be recorded."; `workspace_settings.recording_notice_on` / `recording_notice`). `call.start` returns it as `recordingNotice` (null when off or for a blocked caller), and the agent says it right after the greeting, also the outside-hours greeting (`withRecordingNotice` in `apps/agent/src/call-session.ts`); greeting and notice are cached as one audio.
- Outbound-call consent (TCPA), data region: planned; nothing is enforced yet.
- Data retention: recordings (the audio) are kept 90 days by default, per workspace (`workspace_settings.recording_retention_days`, Settings, Recordings; empty keeps them); a daily job (`apps/api/src/recording-retention.ts`) deletes older audio from its store and clears the call's `recording_key`, nothing else. Calls, their summaries and transcripts (`transcript_segments`) are never deleted by any job: the only code that deletes calls or transcripts is `pnpm db:seed -- --reset` for the demo workspace, and a transcript goes only with its call (foreign key, `on delete cascade`). `apps/api/test/recording-retention.test.ts` checks that the cleanup leaves the call, summary and transcript.
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

Janik's earlier Next.js mock-up is archived in `prototypes/linedesk-next/`.

**Default `docker compose`:** caddy, app (web + API + MCP), worker, voice agent, postgres, electric, livekit-server, livekit-sip, redis/valkey (needed by LiveKit SIP); optional `recording` profile (livekit-egress writing to a shared directory; no storage server). App, worker and agent are stateless replicas; LiveKit scales via Redis; Postgres can be managed.

**Updates without downtime** (`scripts/deploy.sh`, also what the test server runs after every green main): Caddy (`proxy`, the only published web port) stays up and reaches the API and the web app's files (`web`) by service name, retrying a request on another container for up to 30 s when one cannot be reached. The script builds while the old version serves, then replaces only services whose image or settings changed, start-first: a second `api` (or `web`) container starts next to the old one, and the old one is stopped once the new one is healthy. The voice agent goes the same way: the new worker registers with LiveKit (its health check), then the old one gets SIGTERM, reports itself full, finishes its calls (`stop_grace_period`, 15 minutes) and exits, so there is never a moment without a registered worker and no call is cut off. The agent reaches the API through Caddy too (`http://proxy:3100`). A new Caddyfile is loaded into the running Caddy (`caddy reload`); only a change to its compose settings recreates it (a few seconds without the site).

Migrations run once, when the new API container starts, while the old API still serves; the old agent may keep running for up to 15 minutes. So every migration is **expand/contract**: it must work with the code of the previous release. Add (a nullable column or one with a default, a new table, a new index) in one release and start using it; drop or rename (a column, a table, a NOT NULL without a default, a changed type) only in a later release, once no running code reads or writes the old shape. A rename is add-copy-switch-drop across releases.

**Hosted version:** same code, LiveKit Cloud (US), managed numbers, US East region, pass-through minute pricing.

## 12. Admin area and provider keys

For the operator of a multi-tenant install: a view above the workspaces, and the provider keys in the database instead of only in env.

**Instance admin** is a property of the user (`user.instance_admin`), separate from the workspace roles. It adds the permission `instance:admin`, which no role has, in whatever workspace the user is active (and without a workspace). Who gets it:

- the first user of an install (existing installs: the migration marks their oldest user);
- anyone an instance admin grants it to (`instanceAdmin.grant` / `instanceAdmin.revoke`; the last enabled instance admin cannot be revoked or disabled);
- addresses in `INSTANCE_ADMIN_EMAILS`, evaluated on every request, so it applies to accounts that already exist, but only once the address is verified (an email-link sign-in or a sign-in provider verifies it). An unverified address grants nothing, and a password sign-up for a listed address is refused: otherwise someone could register the operator's address first and gain admin when the operator later verifies it.

**Second factor for instance admins.** `instance:admin` is granted only in a session started by a passkey sign-in in the last 12 hours (`apps/api/src/admin-second-factor.ts`). Better Auth's `session.create` hook sets `session.passkey_verified_at` when the session comes from `/passkey/verify-authentication`; clients cannot set it (`input: false`), and impersonation sessions are never marked and never carry `instance:admin` anyway. An email code, password or provider sign-in alone does not open the admin area. Without it, `GET /v1/admin/*`, the admin actions and `POST /v1/impersonation/start` answer 403 `{ code: "SECOND_FACTOR_REQUIRED", secondFactor: "setup" | "confirm" }` (`setup`: the admin has no passkey yet; `confirm`: sign in with it again), and `/v1/me` reports `adminSecondFactor`. The web app then shows, in place of the admin area, "Set up a passkey" (to Account, Sign-in & security) or "Confirm with passkey" (a passkey sign-in, which starts a new session). Self-hosters who cannot use passkeys (no https) turn the rule off with `ADMIN_SECOND_FACTOR=off`. The CLI (`user:create`, `user:passkeys`) runs as the operator without a session and is not affected. A new instance admin adds their first passkey with a one-time enrolment code (see Passkeys below); the first admin of an install gets theirs from `pnpm --filter @linedesk/api user:passkeys --enrol --email …`. TOTP is not offered.

Better Auth's admin plugin was not used: it adds impersonation, user creation, password reset and its own role system as HTTP endpoints outside the action registry. Impersonation is built on the registry instead (below), with Better Auth's own sessions and cookies.

**Impersonation.** An instance admin can sign in as a user (Admin, Users, the user, "Sign in as …") to see Linedesk as they do. Two registry actions, both in the command log: `user.impersonate` { userId } (`instance:admin`; the actor is the admin) and `impersonation.stop` (permission `impersonation:stop`, which only an impersonated session has; the actor is the user, `commands.impersonated_by` the admin). An action cannot set cookies, so both run only through `POST /v1/impersonation/start` and `/stop` (`apps/api/src/impersonation-routes.ts`); `POST /v1/actions/<name>` refuses them.

- `user.impersonate` refuses yourself, a disabled user, another instance admin (also one by `INSTANCE_ADMIN_EMAILS`) and a session that is itself an impersonation. It creates a Better Auth session for the user with its internal adapter: `session.impersonated_by` = the admin, expiry one hour, active workspace = the user's first. The route sets Better Auth's session cookie to it, signed as Better Auth signs it, and keeps the admin's own session token in a separate signed, httpOnly, SameSite=Lax cookie (`better-auth.admin_session`, Secure on https) for the same hour. The user's last sign-in is not touched.
- The hour is fixed: the session is marked "not remembered" and a `session.update` hook keeps its expiry when Better Auth would extend it; `resolveActor` also refuses it one hour after it started, and as soon as the admin is disabled or no longer an instance admin.
- While impersonating, the actor has the user's workspace permissions plus `impersonation:stop`, never `instance:admin`, so `/v1/admin/*` and admin actions are refused and no second impersonation starts. Registry actions are an allow-list (`IMPERSONATION_ALLOWED_WRITES` in `apps/api/src/impersonation-guard.ts`, checked centrally in `run-action.ts`): read-only actions (except `webhook.test`, `carrier.test` and `assistant.startTestCall`, which reach outside), inbox triage (`call.markRead/markUnread/markDone/markNotDone/remind/clearReminder`) and `impersonation.stop`; every other write answers 403 "Not possible while signed in as another user.", so nothing done as the user can outlast the hour (no invitations, members, API keys, webhooks, carrier, numbers, assistant or transfer settings). Commands record `impersonated_by`. Refused: Better Auth's endpoints that change credentials or the account's security or hand out tokens (change password or email, delete the user, list or revoke sessions, link or unlink accounts, account tokens; `apps/api/src/impersonation-guard.ts`) and `POST /v1/account/password`.
- `impersonation.stop` deletes the impersonation session. The route then restores the admin's session from the admin cookie only if that cookie's signature is valid and its session exists, has not expired, is no impersonation and belongs to the admin who started it, who is still an enabled instance admin; otherwise the browser is just signed out. The admin cookie is cleared either way.
- `/v1/me` returns `impersonation: { by, user, expiresAt } | null`. The web app shows a dark bar under every page with whose session it is, who is in it, the minutes left and "Return to admin", which returns to the user's page in Admin. Before starting and stopping, the outbox is sent and the local data of the ending session deleted.

**Audit log.** Admin, Audit log (`GET /v1/admin/audit`, `instance:admin`; `apps/api/src/audit.ts`): who did what, newest first, filtered by kind (sign-ins, sign-in methods, admin actions, team changes, provider keys, signed in as a user), person (email or name), workspace and dates, paged with a cursor. Two sources, merged: the command log (`commands`) for admin actions (`user.*`, `workspace.disable/enable`, `instanceAdmin.*`), team and role changes (`team.*`), provider keys (`provider.setKeys/clearKeys/setActive`; inputs already redacted) and impersonation (`user.impersonate`, `impersonation.stop`, and every action done while signed in as a user), refused attempts included; and `auth_events` for what happens in Better Auth's endpoints: sign-ins and sign-ups with their method (password, email code, passkey, Google, Microsoft, GitHub, OIDC; from the endpoint that created the session, in the `session.create` hook), a provider or password added to an account (`account.create`), passkeys added or removed, password changes and accepted invitations (after-hooks on those endpoints, only when they succeed). Impersonation sessions are not sign-ins. Everyday actions (calls, contacts, settings) are not audit entries. Nothing in either table is ever deleted, and `auth_events` has no foreign keys, so entries outlive the user or workspace they name (the email at the time is kept). When a user is deleted, a database trigger anonymises their `auth_events` (email becomes `deleted`, IP address and user agent are cleared) and keeps the events; the command log and transcripts stay as they are. Answering a workspace invitation is refused while impersonating, so every accepted invitation is the user's own. A failed audit write is logged and never blocks the sign-in it describes.

**Disabling.** `user.disable` sets `user.disabled_at`, deletes the user's sessions and blocks new ones (a Better Auth `session.create` hook; the API also refuses a disabled user on every request). `workspace.disable` sets `organization.disabled_at`; `call.start` then rejects calls to its numbers, and its members keep only their read permissions (`*:read`): they can sign in and read, but no registry action that writes (triage, settings, phone numbers) runs for them. `/v1/me` reports `workspace.disabled`. Better Auth's own organization endpoints (invitations, roles) do not check it yet.

**Providers.** The registry in `packages/actions/src/admin.ts` describes each provider: label, category (telephony, speech to text, language model, voice, recording storage), its fields and which are secret or optional; `apps/api/src/provider-test.ts` holds how to test its connection. Shipped: Telnyx (API key, webhook public key; the default carrier), Twilio (account SID, auth token), Deepgram (API key, model), OpenRouter (API key, model, summary model), OpenAI (API key, model, summary model), ElevenLabs and Cartesia (API key, model, default voice), and for recording storage Local disk (`file`, no fields) and S3-compatible (`s3`, see below). Each field falls back to the variable the voice agent reads (`apps/agent/src/config.ts`): `DEEPGRAM_API_KEY`, `STT_MODEL`, `LLM_MODEL`, `SUMMARY_MODEL`, `TTS_MODEL`, `TTS_VOICE_ID`, `S3_ENDPOINT` and so on. The database stores provider id and field name as text (`provider_settings`, one row per field), so a new provider is an entry in the registry and no migration. `workspace_id` is null: the keys are for the whole install. Rows with a workspace id are a workspace's own carrier credentials (§8, Own carrier account); they never count for the install, the admin area does not list them, and only `apps/api/src/workspace-carrier.ts` reads them. Sign-in providers and SMTP stay in env.

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

**Who is asking.** Rate limits key on the client address, which the API resolves itself (`apps/api/src/client-ip.ts`): the connection's address, or, when the connection comes from a proxy listed in `TRUSTED_PROXIES`, the last `X-Forwarded-For` hop before the trusted proxies. It hands that to Better Auth in its own header, replacing any value a client sent; a client cannot pick its own bucket. Behind another reverse proxy (host Caddy → compose Caddy → API), the compose Caddy keeps the forwarded address only from the ranges in `LINEDESK_TRUSTED_PROXY_RANGES` (`docker/Caddyfile`, `trusted_proxies`); empty by default, so then every client shares the outer proxy's address. Per address, a before-hook allows 5 codes in 10 minutes and 10 sign-in tries an hour across codes; a refused request creates no code and leaves the current one and its tries alone. The plugin's password-reset, email-change and plain-verification endpoints are disabled (`disabledPaths`), and only `sign-in` codes can be requested.

**Closed sign-up.** `AUTH_SIGNUP_ENABLED=false` (`apps/api/src/signup-gate.ts`) refuses every new user in Better Auth's `user.create` hook, which password sign-up, a first code sign-in and a first SSO sign-in all go through. Allowed anyway: the first user of an install, and an address with a pending, unexpired workspace invitation once the address is proven (a code or a sign-in provider; a password sign-up cannot use an invitation). No code is sent to an address that cannot sign in; the answer is the same. Existing users sign in as before. Accounts are made by an instance admin with `user.invite` (Invite user in the admin area, or `pnpm --filter @linedesk/api user:create --email … --name … [--admin]`, which runs the same action as the operator): the account is created unverified and the person gets an email saying how to sign in (with their address and a code from the sign-in page; no code in the invite, since codes expire). Without email delivery the action is refused; if the email cannot be sent, the account is removed again. While sign-up is closed, workspace owners can still invite people into their own workspace (Better Auth organization invitations); that is intended. A provider sign-in refused by the gate goes back to the sign-in page with `?error=SIGNUP_CLOSED` (the hook's error code), not to a bare 403.

**Sign-in providers and account linking.** Google, Microsoft, GitHub and one OpenID Connect provider, each on when its keys are set (`apps/api/src/auth-methods.ts`; `GET /v1/auth-methods` lists them for the sign-in page). The email address is the account: a provider sign-in lands in the account with the same email, however that account was made (email code, password, an invitation or `user.invite` that never signed in, another provider), and every method attaches to that one account. Condition: the provider proves the address (`apps/api/src/account-linking.ts`). Google: `email_verified`. Microsoft: a personal account (tenant `9188040d-6c67-4c5b-b112-36a304b66dad`: Outlook.com, Hotmail, Live), or a work account whose ID token carries `xms_edov` (the tenant owns the email's domain; an optional claim the app registration must add) or lists the address in `verified_primary_email`; a work account's plain `email` claim is not proof, any tenant can set it. GitHub (`apps/api/src/github-sign-in.ts`, scopes `read:user` and `user:email`): the account's primary address from `GET /user/emails`, only when GitHub verified it; the public profile address and other addresses are never used. OIDC: `email_verified`. A sign-in that does not prove its address has no email: Better Auth stops with `email_not_found` before it looks up or creates a user, and the sign-in page says the provider didn't confirm the address. No provider is trusted by name (`trustedProviders` is empty) and `requireLocalEmailVerified` is off, so a proven provider email also joins an account whose own address was never verified; Better Auth then marks it verified, and an `account.create` hook removes what got in without proof: the account's password and its sessions (otherwise someone who signed up with another person's address and a password would keep a way in). Pending workspace invitations stay pending and can be accepted afterwards. With sign-up closed, a provider sign-in for an address with an account or a pending invitation works; any other is refused with `SIGNUP_CLOSED`. Provider accounts are keyed on the provider's stable id (Google `sub`, Microsoft `oid`, GitHub's numeric id).

**Passkeys.** Better Auth's passkey plugin (`@better-auth/passkey`, `apps/api/src/passkeys.ts`, table `passkey`), on unless `AUTH_PASSKEY_ENABLED=false`; the sign-in page offers "Continue with Passkey" when the server has it on and the browser supports WebAuthn (https or localhost). The relying party is the address people open: its host name is the `rpID` and its origin the only accepted origin, from `PUBLIC_URL`, else `WEB_ORIGIN` (with docker compose both are `PUBLIC_URL`). Changing that address makes existing passkeys unusable (people sign in another way and add a new one). A passkey signs in an existing account only: it is added under Account, Sign-in & security, by a signed-in member whose session is less than a day old (the plugin's fresh-session check), to that member's own account; there is no passkey-first sign-up (`registration.requireSession`, no `resolveUser`), so closed sign-up cannot be bypassed with one. Removing a passkey also needs a session less than a day old (a before-hook; the plugin itself only asks for a session) and works only on the member's own passkeys. Once an account has a passkey, or belongs to an instance admin, passkeys are its second factor (`guardPasskeyChanges`, a before-hook): adding, renaming or removing one then needs a session started by a passkey sign-in in the last 12 hours (`passkeyVerifiedAt`, as for the admin area), else 403 `PASSKEY_CONFIRMATION_REQUIRED`, so someone with only the mailbox, the password or the Google account can neither add their own passkey nor remove the real ones. An instance admin's first passkey needs a one-time enrolment code (`apps/api/src/passkey-enrolment.ts`, else 403 `PASSKEY_ENROLMENT_REQUIRED`): `instanceAdmin.grant`, `user.invite` with admin and `user.resetPasskeys` return it once to the admin who ran them (shown in a dialog, `secretResult`, never in the command log), and `pnpm --filter @linedesk/api user:passkeys --enrol --email …` prints it for the first admin of an install or one set by `INSTANCE_ADMIN_EMAILS`. Only its SHA-256 is stored (`user.passkey_enrolment_hash`), it lasts 24 hours and is used up by the first passkey; the browser sends it as `x-passkey-enrolment` with `verify-registration` (asking for options only needs one to be pending), and Account shows an Enrolment code field while `/v1/me` says `passkeyEnrolment`. Non-admins without a passkey keep Better Auth's fresh-session rule. The account is emailed whenever a passkey is added or removed, and both are in the audit log. **Recovery** that needs none of the user's passkeys (a lost device, or a passkey someone else added with the first factor): an instance admin runs Reset passkeys on the user's page (`user.resetPasskeys`, audited; needs the admin's own passkey second factor, so never while impersonating): every passkey of the user is removed and all their sessions end in the same transaction (an admin resetting their own keeps the session they are in), they are emailed (an instance admin always, also with no passkey to remove), and an instance admin gets a new enrolment code. Granting instance admin to someone who already has passkeys lists them with their dates in the dialog, since they become the admin's second factor, and offers "Reset passkeys and make admin" instead. The last admin, or one without a working passkey, does the same on the server: `pnpm --filter @linedesk/api user:passkeys --remove --email …` (runs the same action as the operator). `ADMIN_SECOND_FACTOR=off` is not needed for any of this. A disabled user's passkey creates no session (the `session.create` hook). While impersonating, passkeys cannot be added, renamed, removed or listed (`impersonation-guard.ts`).

**Assistant voices.** Settings › Assistant › Voice picks `assistants.voice` (`{ provider, voice_id }`; empty id: the install's default voice, `TTS_VOICE_ID` or the provider's). An assistant may only get the default, a curated voice (`curatedVoices` in `packages/actions/src/voices.ts`: six American English ElevenLabs default voices; none for Cartesia yet) or a voice its own workspace cloned: `assistant.update` checks it on the server (`checkAssistantVoice`). `voice.options` lists them and whether the workspace can clone. Previews: `GET /v1/voices/preview/<voiceId>` (`apps/api/src/voices.ts`) says a fixed sentence in that voice, only for those voices; synthesized once per provider, model, voice and sentence and kept on disk (`VOICE_PREVIEW_DIR`, default the system temp dir; the newest 300 kept), browser-cached for a week; at most 20 new samples per workspace an hour (per API process). **Cloning** is off until an instance admin turns it on (Admin › System, `voiceCloning.set`, `instance_settings.voice_cloning`), and only for providers in `cloningProviders` (ElevenLabs instant voice cloning). `voice.clone` (`settings:write`) takes a recording (≤ 10 MB; the request body is capped before it is read, every other action at 4 MB), checks its first bytes against the claimed type, and calls the provider before the transaction (a `Preparer`, `handler-context.ts`; the clone is deleted again if the command does not commit). It stores a consent record in `voice_clones` (who confirmed, when, the exact statement `CLONE_CONSENT_TEXT`) and makes the voice the assistant's; the recording is not stored (`sensitive`, not in the command log either). A clone no assistant of its workspace uses any more (voice changed, assistant deleted, workspace deleted) is deleted at the provider by the `voice.delete` job and marked `deleted_at` here; the row stays as the consent record and the voice can no longer be picked. Vendor HTTP is in `apps/api/src/voice-provider.ts`.

## 13. Integrations: API keys

A workspace's own integrations (REST, later MCP and webhooks) authenticate with a workspace API key (`apps/api/src/api-keys.ts`).

- Owners and admins create (`apiKey.create { name, role }`), list (`apiKey.list`) and revoke (`apiKey.revoke`) keys under Settings, Developers. A key is `ld_` + 32 random bytes (base64url), shown once in the result of `apiKey.create`; the command log stores that result without it (`secretResult`). Only its SHA-256 hash and its first 11 characters (to tell keys apart) are stored, in `api_keys`, which is never synced.
- `Authorization: Bearer ld_…` on `/v1/actions/<name>` and every other `/v1` read. The actor is `apikey:<id>` in the key's workspace with the key's role (`member` or `admin`, never owner), without `team:write`; keys never manage keys. The agent's `x-workspace-id` header does not apply. A revoked key, or one of a deleted or disabled workspace, is refused (401). A key is checked against its creator on every request: once they are removed from the workspace, disabled by an instance admin, or hold a lower role than the key (an admin key of someone demoted to member), the key is refused; it works again if that is undone, until it is revoked. `last_used_at` is written at most once a minute.
- 300 requests a minute per key (in-memory sliding window per API process), then 429 with `retry-after: 60`.
- Refused `ld_` keys count per client address (`client-ip.ts`): from the 20th in 10 minutes, keys from that address are not looked up and get 429 with `retry-after: 600`, so guessing costs no database queries.

## 14. Call evaluations

After a phone call is finished (`call.finish`), a job (`call.evaluate` in pg-boss, `apps/api/src/evaluations.ts`) asks the language model in effect (Admin, Providers) how the assistant handled it: one short request (`max_tokens` 300, the provider's cheap default model unless one is set) with the business instructions, call rules, transcript and summary. The answer is a score from 1 to 5 and at most three issues, stored in `call_evaluations` (not synced; one row per call, replaced on a new evaluation). Test calls are evaluated only when asked (`call.evaluate` from the call view). Owners and admins (`settings:write`) read them with `call.getEvaluation` and `call.listEvaluations`: a card under the summary, and the Needs review mode of the inbox (G R) lists calls scored 3 or lower. Without a language model nothing is evaluated.
