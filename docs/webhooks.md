# Webhooks

Each assistant has one webhook: one address, set by owners and admins in the assistant's settings under Webhook, with a switch per hook it gets (`hooks`; `apps/web/src/settings/Webhooks.tsx`; actions in `packages/actions/src/webhooks.ts`, server in `apps/api/src/webhooks.ts`). Each request says its hook in the `hook` field of the body and the `Linedesk-Hook` header:

| Hook | When | Linedesk sends | It answers |
| --- | --- | --- | --- |
| `call_start` | as a call comes in | the caller: number, the number called, the saved contact if any | caller details, within 1 s |
| `call_end` | about 20 s after the call ends | the whole call | any 2xx |

A third hook, during the call (a request the assistant makes when it needs something, like an order status), is planned. There are no other event types: each hook sends one thing. A webhook with no hook on gets nothing; switching it off stops all of them. Test calls (`calls.source = 'test'`) send nothing. Both requests are in the OpenAPI document (`GET /v1/openapi.json`, `webhooks`).

## Requests

`POST` with a JSON body and these headers:

- `Linedesk-Hook`: `call_start`, `call_end`, or `webhook.test` for a test send (its body's `hook` says which).
- `Linedesk-Delivery`: the delivery id, the same on every retry.
- `Linedesk-Signature: t=<unix seconds>,v1=<hex>`: `v1` is HMAC-SHA256 with the webhook's secret over `<t>.<raw body>`. Compare it in constant time and refuse a `t` older than a few minutes.

```js
const [, t, v1] = /t=(\d+),v1=(\w+)/.exec(req.headers['linedesk-signature'])
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Date.now() / 1000 - t < 300
```

## When a call starts

The voice agent asks as soon as the call is registered (`call.lookUpCaller`, agent only, refused while impersonating); the API posts:

```json
{ "hook": "call_start", "call_id": "call_…", "workspace_id": "…", "assistant_id": "…", "assistant_name": "Maya",
  "from_number": "+15035550123", "to_number": "+15035550100", "started_at": "…",
  "caller": { "contact_id": "ct_…", "name": "Sam Taylor", "company": null, "email": null } }
```

`from_number` is not a number when the caller withheld it ("anonymous"); `caller` is null without a saved contact. Times are ISO 8601 in UTC.

Answer with a JSON object of caller details, e.g. `{"name": "Sam", "plan": "Premium"}`, or `{}` for an unknown caller. Kept: top-level names of letters, digits and `_` (a letter first, at most 40 characters) with a text, number or true/false value; at most 20 of them, texts on one line and cut to 200 characters (`callerDetailsFrom`). Nested objects, lists and null are left out.

- **The greeting** can use them: `{{name}}`, or `{{name|there}}` with a fallback. A greeting with such a placeholder waits for the answer at most 1.3 s (the webhook's 1 s and the trip to the API, `GREETING_WAIT_MS` in `apps/agent/src/caller-lookup.ts`) and is spoken live, not from the greeting audio cache. A missing value without a fallback is left out and the spaces around it tidied ("Hi {{name}}, …" becomes "Hi, …"). A greeting without placeholders does not wait.
- **The assistant** gets all of them in its instructions as data, between `<caller_details>` tags (`callerDetailsInstructions`, `apps/agent/src/prompt.ts`): not instructions, nothing private told before the caller says who they are (caller ID can be faked). They arrive while the greeting plays, before the caller's first answer in practice.
- They are kept on the call (`calls.caller_details`) and sent again in the after-call request.

No answer within 1 s, an error, or no JSON: the call goes on without details. Failures count like failed deliveries, so a webhook that keeps failing is switched off instead of slowing every call.

## After the call

`call.finish` writes a delivery row and a pg-boss job (`webhook.deliver`) in its transaction, to run 20 s later (`CALL_END_DELAY_SEC`), so the recording is saved by then. The first attempt builds the payload from the call as it is then (`callEndPayload`) and stores it; retries send the same one.

```json
{ "hook": "call_end", "call_id": "call_…", "workspace_id": "…", "assistant_id": "…", "assistant_name": "Maya",
  "direction": "in", "from_number": "+15035550123", "to_number": "+15035550100",
  "started_at": "…", "ended_at": "…", "duration_sec": 95, "outcome": "message", "urgency": "normal",
  "title": "Water heater leaking", "summary": "…",
  "next_steps": [{ "text": "Call Sam back", "kind": "message" }],
  "fields": [{ "label": "Issue", "value": "Leaking water heater" }],
  "caller": { "contact_id": "ct_…", "name": "Sam Taylor", "company": null, "email": null },
  "caller_details": { "name": "Sam", "plan": "Premium" },
  "transcript": [{ "speaker": "agent", "text": "…", "at_ms": 0 }], "transcript_text": "Maya: …\nCaller: …",
  "bookings": [{ "id": "bk_…", "start_at": "…", "end_at": "…", "status": "confirmed", "title": "…", "calendar_name": "Office", "appointment_type_id": "…" }],
  "transfer": null, "call_url": "https://app.example.com/#call/call_…",
  "recording_url": "https://app.example.com/v1/calls/call_…/recording?expires=…&signature=…", "recording_expires_at": "…" }
```

**The recording link** opens the audio without signing in for 7 days (`RECORDING_LINK_DAYS`): the signature is an HMAC with a key derived from `SECRETS_KEY` over the call id and the expiry (`recordingLink`, `apps/api/src/recording-route.ts`), checked before the sign-in check and again by the route. After that, or for any call, `GET /v1/calls/<id>/recording` with a workspace API key (`Authorization: Bearer ld_…`) or a member's session. Null when the call has no recording. The link points at `PUBLIC_URL` (else `WEB_ORIGIN`); `call_url` at `WEB_ORIGIN`.

## Delivery

- A 2xx answer within 10 seconds is delivered. Anything else (redirects are not followed) is tried again after 1, 2, 4, 8, 16 and 32 minutes: 7 attempts, about an hour. The call-start request is never retried (the call cannot wait).
- After 5 failures in a row (after-call deliveries that failed every attempt, or call-start requests), the webhook is switched off (`disabled_reason` says why). Switching it on again resets the count. Test sends never count.
- The log (Webhook, the row's menu, Log; `webhook.deliveries`) shows each request's result, attempts and time.
- Only public `https` addresses. The name is resolved once per attempt, by the connection itself, and refused when any address is private, loopback, link-local or otherwise not public, including IPv4 written inside IPv6 (mapped, compatible, NAT64, 6to4, SIIT) and site-local `fec0::/10` (`apps/api/src/ip-address.ts`); the request goes to the address that was checked. Port 443 or 8443 only, so a URL cannot aim at another service on a public host. `WEBHOOK_ALLOW_PRIVATE_URLS=true` allows `http`, other ports and private addresses (development, closed networks).
- One webhook per assistant, at most 10 per workspace; each API process sends 5 after-call deliveries at once (`WEBHOOK_WORKERS` in `apps/api/src/jobs.ts`), so a few slow webhooks (each up to the 10 s timeout) do not hold up everyone else's. A call-start answer is read up to 32 KB.
- A failed connection is logged as "could not connect", whatever the reason (the detail goes to the server log), so the log and test sends cannot probe ports.
- Test sends (the row's menu, one per hook; `webhook.test` with `hook`) post a made-up call (for call start, the toast shows the caller details the answer gave). Test sends run outside a database transaction, are not commands (only the log has them) and are limited to 10 a minute per workspace.
- Payloads hold callers' details: they are cleared after 30 days (daily job `webhooks.cleanup`) and when their call is deleted; status, attempts and times stay. A pending delivery of a deleted call is not sent.
- The secret is generated in the browser, sent once (`sensitive`: the command log stores it redacted) and stored encrypted with `SECRETS_KEY`. Webhooks sync to owners and admins only (their URLs can carry a token).
- Webhooks from before they were per assistant (no `assistant_id`): migration 0067 made the oldest one of each workspace that got finished calls the webhook of the workspace's first assistant, with only the after-call hook on; any others get nothing and are not shown (dropped with the `events` column in a later release).
