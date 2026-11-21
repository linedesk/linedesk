# Put a live demo on your website

Public demo calls let a visitor of your website talk to one of your assistants in the browser, without an account, for at most two minutes. Any install can turn them on: Linedesk's own website uses the same feature as a partner's would. Off by default: until `DEMO_CALLS=on`, `POST /v1/demo/call` answers 404.

Code: `apps/api/src/demo-call.ts` (the endpoint and its limits), `DEMO_LANGUAGES` and the demo's fixed lines in `packages/actions/src/spoken-lines.ts`, `apps/api/src/demo-rooms.ts` (the time-limit sweep and the transcript cleanup), `apps/api/src/demo-workspace.ts` (the setup script) with the example data `apps/api/src/demo-businesses.example.ts`. The agent side is the demo flag and the main language in the test-room metadata (`apps/agent/src/call-session.ts`).

## How it fits together

```
Browser on your website
  │ 1. click → microphone permission → your bot check (for example Cloudflare Turnstile)
  │ 2. POST /api/demo/start {industry, language, botToken} (your site, same origin)
  ▼
Your gateway (a serverless function next to the site)
  │ checks: its own kill switch, the bot check, the country, its own per-address limit
  │ ipHash = HMAC-SHA256(pepper, visitor address)          (the address never leaves the gateway)
  │ 3. POST https://<your install>/v1/demo/call
  │    Authorization: Bearer <DEMO_GATEWAY_SECRET>   {industry, ipHash, country, language}
  ▼
Linedesk API
  │ under one lock: limits per ipHash, calls per day, daily budget, the demo workspace's spending cap, calls at once,
  │ the demo workspace still safe (no number, calendar, webhook, recording or transfer), agent reachable
  │ logs a `demo.callToken` command; signs a LiveKit token: 60 s, one new room `demo-…`, microphone only,
  │ dispatching the agent with {source: 'test', demo: true, workspaceId, assistantId, simulateTransfer: true}
  │ (+ mainLanguage when the visitor picked a language other than English)
  ▼
The browser joins LiveKit (LIVEKIT_PUBLIC_URL) with the token, the agent picks up, the call ends after 120 s
```

Why a gateway: the LiveKit key must never leave the server (any LiveKit key can sign any grant, SIP included), and the bot check, the visitor's real address and the country are best known at the edge of your website. The API never sees a raw address, sends no CORS headers and is never called by a browser.

## Set it up

1. Make the demo workspace and its assistants, one per industry your website offers:

   ```sh
   pnpm --filter @linedesk/api demo:workspace --owner you@example.com --as admin@example.com [--data my-businesses.json] [--name "Website Demo"]
   # in the api container: node apps/api/src/demo-workspace.ts --owner … --as … [--data …]
   ```

   Without `--data` it uses the example data (eight made-up businesses). Your own file has the same shape (`DemoWorkspaceData` in `demo-workspace.ts`; `.json`, `.ts` or `.js`). Every assistant is set to take messages only: not recorded, no recording notice, recordings not kept, at most 2 minutes, English as their language (a visitor may still pick another one per call, below), saying at the start that it is an AI, nobody to put through. The workspace gets the monthly spending cap from the data file and no notification emails by default. Safe to run again: assistants are found again by their business's phone number. It prints the `DEMO_WORKSPACE_ID` and `DEMO_ASSISTANTS` lines last.
2. Set the API's env (below) and restart the API.
3. Deploy your gateway with the same secret and test it against a staging install first.

## API env

| Variable | Default | What it does |
|---|---|---|
| `DEMO_CALLS` | off | `on` turns the endpoint on; anything else: 404. The kill switch on the API. |
| `DEMO_GATEWAY_SECRET` | none | The gateway's Bearer secret, at least 32 characters (`openssl rand -hex 32`). Missing or shorter: 404. |
| `DEMO_WORKSPACE_ID` | none | The demo workspace, as the setup script prints it. Missing: 503 `off`. An assistant in `DEMO_ASSISTANTS` outside it: 503 `off`. |
| `DEMO_ASSISTANTS` | none | `industry=assistantId,…` as the setup script prints it. An industry not listed: 400. |
| `DEMO_DAILY_USD` | none | The budget per UTC day. Each token counts as 210 s of call (the stale-call sweep's backstop: the agent's goodbye at 120 s may not come) at the install's rates (Server admin › Overview), plus $0.01 for the summary. Missing: 503 `off`. `0`: no demo calls. When the rates come to $0 a call (no priced provider active), demo calls are refused (503 `off`): the budget would stop nothing. |
| `DEMO_DAILY_CALLS` | 300 | Demo tokens per UTC day on the install, whatever the rates say. |
| `DEMO_MAX_CONCURRENT` | 3 | Demo calls at once on the install: live demo calls plus tokens of the last 60 s not joined yet. They share the voice agent with real calls: raise it only after a load test. |
| `DEMO_CALLS_PER_IP_HOUR` | 3 | Per `ipHash`, a rolling hour. |
| `DEMO_CALLS_PER_IP_DAY` | 6 | Per `ipHash`, a rolling 24 hours. |
| `DEMO_TRANSCRIPT_DAYS` | 7 | Days a demo call's transcript and summary are kept; then the cleanup job (every hour at :27) clears them. `0`: at the next run. |

LiveKit must be configured (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_PUBLIC_URL` where browsers reach it).

## The contract

`POST /v1/demo/call`, `Authorization: Bearer <DEMO_GATEWAY_SECRET>`, `Content-Type: application/json`, a body of at most 4 KB:

```json
{ "industry": "auto", "ipHash": "3f1c…", "country": "US", "language": "en" }
```

- `industry`: a key of `DEMO_ASSISTANTS`.
- `ipHash`: 16 to 128 characters of hex or base64url, the gateway's peppered hash of the visitor's address. Stored with the token in the command log for the per-visitor limits, and removed from it after 24 hours (the hourly cleanup job: at most 25 hours in all). The rest of the row (industry, country, room) is cut down to ids after 90 days like every command.
- `country`: optional, ISO 3166-1 alpha-2 in upper case, stored with the token for statistics.
- `language`: optional, the language the visitor picked: one of `DEMO_LANGUAGES`, today only `en`. The demo has its lines in Deepgram Flux's 10 (`DEMO_LINE_LANGUAGES`: `en`, `es`, `fr`, `de`, `it`, `pt`, `nl`, `ru`, `hi`, `ja`), but the others stay off until their demo calls pass the language retest (none did on 2026-11-16: names and callback numbers were read back wrong or skipped); turning one on is adding it to `DEMO_LANGUAGES` and to the website's list. Missing: `en`. Any other value (also `null` or another case): 400 `language`, checked first after the secret and the content type. Stored with the token for statistics. `en` is the call exactly as without the field. Any other: the call speaks only that language (see "On the call").

Answers (the gateway may pass them on as they are; 503 and 429 also set `Retry-After` when there is a time):

| Status | Body | When |
|---|---|---|
| 200 | `{ok: true, url, token, room, maxSeconds: 120, business, assistant}` | Join `url` with `token` within 60 s. `business` and `assistant` name who answers. |
| 400 | `{ok: false, error: 'industry'}` | The industry is not in `DEMO_ASSISTANTS`. |
| 400 | `{ok: false, error: 'language'}` | `language` is not one of `DEMO_LANGUAGES`. |
| 400 | `{ok: false, error: 'input'}` | The body is not the contract. |
| 401 | `{ok: false, error: 'unauthorized'}` | Wrong or missing secret. |
| 429 | `{ok: false, error: 'unauthorized', retryAfterSec: 600}` | More than 20 wrong secrets from this address in 10 minutes (an `ALERT` line). The right secret is never held back, so whoever shares the gateway's address cannot lock it out. |
| 404 | `{ok: false, error: 'not found'}` | Demo calls are off on this install. |
| 415 | `{ok: false, error: 'json'}` | Not `application/json`. |
| 429 | `{ok: false, error: 'rate', retryAfterSec}` | This visitor reached the hourly or daily limit. |
| 503 | `{ok: false, error: 'busy', retryAfterSec}` | All demo lines are busy (30 s), or the voice agent has not checked in lately (60 s). |
| 503 | `{ok: false, error: 'budget', retryAfterSec}` | The calls of the day or the daily budget (until UTC midnight), or the demo workspace's monthly spending cap (until next month), are used up. |
| 503 | `{ok: false, error: 'off', retryAfterSec: null}` | The install is not set up for demo calls (LiveKit, `DEMO_DAILY_USD`, `DEMO_WORKSPACE_ID`, `DEMO_ASSISTANTS`, an assistant that is gone or outside the demo workspace or whose voice model can't speak the picked language, nothing to answer with, a call estimated at $0), or the demo workspace is no longer safe for anonymous callers (below). |

Each refusal of the install's own (budget, cap, busy, agent, setup, safety) logs one `ALERT demo calls: …` line at most every 10 minutes.

Checked on every request, because anyone may change the demo workspace after the setup script: demo calls are refused while the demo workspace has a phone number (real callers, an outbound caller ID), a calendar connection (real bookings, confirmation emails to any address a visitor says) or a switched-on webhook (what visitors say sent out, lookups during the call), or while the chosen assistant records its calls or has anyone to put callers through to (a transfer contact or the old transfer number). Remove it, and demo calls work again at the next request.

On the call: the assistant greets as usual and adds "This is a two-minute demo." At 120 s it says "That's the two minutes for this demo. Thanks for trying it out. Goodbye!" and hangs up. Both lines exist in each of `DEMO_LINE_LANGUAGES` (`demoLines`).

The language: English calls use the install's speech recognition as it is (Deepgram `flux-general-en`) and the assistant's English setting, exactly as before the language choice. With another language the API puts `mainLanguage` into the room metadata and the agent uses the same per-call override as the call tests: the assistant's main language becomes that one, with no other language allowed. So the default greeting is said in it (with the AI note and the demo line in it too, cached per text and voice), the instructions tell the assistant to speak only that language, speech recognition is `flux-general-multi` with `languageHint` that one language only (no `en` hint: it cannot switch), and the voice is told the language (ElevenLabs Flash v2.5, the default model, speaks all ten; a demo assistant whose voice model can't speak it is refused, 503 `off` with an `ALERT` line). A demo assistant on a realtime model hears and speaks the language itself. Why no automatic detection: on `flux-general-multi` with all ten as hints, English with a foreign accent was often heard, and answered, as another language (test of 2026-11-16). A demo room still open 150 s after the call started is deleted by the stale-call sweep (it runs every minute), and only then is the call filed as ended: while LiveKit cannot delete the room, the call stays live, and counted, until a later sweep can. A transfer reaches a simulated person, never a phone. Demo calls are test calls (`source: 'test'`, room `demo-…`): no push, no evaluation, no call-start webhook, a shared "Test call" contact.

## A minimal gateway

A Cloudflare Pages Function (`functions/api/demo/start.js`); any serverless platform works the same way. Secrets: `DEMO_GATEWAY_SECRET`, `DEMO_IP_PEPPER` (random, only here), `TURNSTILE_SECRET`; `LINEDESK_URL` is your install. It leaves out what your site may want on top (a KV kill switch, its own per-address limit, an event beacon).

```js
const ALLOWED_ORIGINS = ['https://www.example.com', 'https://example.com']
const COUNTRIES = ['US', 'CA']

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function onRequestPost({ request, env }) {
  if (!ALLOWED_ORIGINS.includes(request.headers.get('origin'))) return json({ ok: false, error: 'origin' }, 403)
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ ok: false, error: 'json' }, 415)
  const country = request.cf?.country ?? null
  if (!COUNTRIES.includes(country)) return json({ ok: false, error: 'country' }, 403)
  const { industry, botToken } = await request.json().catch(() => ({}))
  const ip = request.headers.get('cf-connecting-ip') ?? ''

  // The bot check: one use, for this site and action.
  const check = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(botToken ?? ''), remoteip: ip }),
  }).then(r => r.json())
  if (!check.success || check.action !== 'live-demo' || !ALLOWED_ORIGINS.includes(`https://${check.hostname}`))
    return json({ ok: false, error: 'bot' }, 400)

  const res = await fetch(`${env.LINEDESK_URL}/v1/demo/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.DEMO_GATEWAY_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ industry, ipHash: await hmacHex(env.DEMO_IP_PEPPER, ip), country }),
  })
  // The install's answer as it is; a 404 means demo calls are off there.
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } })
}
```

In the browser: ask for the microphone inside the click, then call your gateway, then `new LivekitClient.Room()` and `room.connect(url, token)`, publish the microphone track, play the agent's audio track, and show live captions from the `lk.transcription` text stream. Hang up at `maxSeconds + 5` at the latest. The website needs `Permissions-Policy: microphone=(self)`; networks that allow only port 443 cannot reach LiveKit's media ports unless the install runs TURN.

## Running it

- Kill switch: unset `DEMO_CALLS` (or set it to anything but `on`) and restart the API; the endpoint answers 404 at once. Your gateway may have its own switch that needs no API restart.
- Raise a cap: change the env variable (`DEMO_DAILY_CALLS`, `DEMO_DAILY_USD`, `DEMO_MAX_CONCURRENT`, the per-visitor ones) and restart the API. Raise `DEMO_MAX_CONCURRENT` only after a load test on the production hardware (`apps/agent/src/load-test`) or with a second agent worker.
- The day so far (psql on the install):

  ```sql
  select count(*) as tokens,
         count(c.id) as connected,
         round(avg(c.duration_sec)) as avg_sec,
         round(sum(c.duration_sec) / 60.0, 1) as minutes,
         count(*) filter (where cmd.input->>'country' is not null) as with_country
  from commands cmd
  left join calls c on c.workspace_id = cmd.workspace_id and c.room = cmd.result->'data'->>'room'
  where cmd.action = 'demo.callToken' and cmd.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  ```

  Refusals are not stored; count the `ALERT demo calls` lines in the API log.
