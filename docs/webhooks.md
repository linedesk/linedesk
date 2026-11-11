# Webhooks

Owners and admins add endpoints under Settings, Webhooks: a URL, the events it receives, and a signing secret that is shown once (`apps/api/src/webhooks.ts`, actions in `packages/actions/src/webhooks.ts`).

## Events

| Event | When | `data` |
| --- | --- | --- |
| `call.completed` | the first `call.finish` of a call | `call`: id, numbers, times, outcome, urgency, title, summary, next steps, fields, contact and assistant id. Schema: `webhooks` in `GET /v1/openapi.json` |
| `call.summary_ready` | the same moment, when the call has a summary | as `call.completed` |
| `booking.created` | `appointment.book` | `booking`: id, start and end, status, title, calendar name, appointment type, call and contact id |
| `message.taken` | `call.takeMessage` | `call_id`, `message`, `from_number`, `contact_id` |

Test calls (`calls.source = 'test'`) send no events. Settings, Webhooks, Send test sends `webhook.test`.

## Requests

`POST` with a JSON body `{ id, type, created_at, workspace_id, data }` (`id` is the event's; the same event to two endpoints has the same id) and these headers:

- `Linedesk-Event`: the type; `Linedesk-Delivery`: the delivery id, the same on every retry.
- `Linedesk-Signature: t=<unix seconds>,v1=<hex>`: `v1` is HMAC-SHA256 with the endpoint's secret over `<t>.<raw body>`. Compare it in constant time and refuse a `t` older than a few minutes.

```js
const [, t, v1] = /t=(\d+),v1=(\w+)/.exec(req.headers['linedesk-signature'])
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Date.now() / 1000 - t < 300
```

## Delivery

- Every event is a row in `webhook_deliveries` and a pg-boss job (`webhook.deliver`), written in the transaction of the write that caused it.
- A 2xx answer within 10 seconds is delivered. Anything else (redirects are not followed) is tried again after 1, 2, 4, 8, 16 and 32 minutes: 7 attempts, about an hour.
- After 5 deliveries in a row that failed every attempt, the endpoint is switched off (`disabled_reason` says why). Switching it on again resets the count. Test sends never count.
- The delivery log (Settings, Webhooks, Deliveries; `webhook.deliveries`) shows each delivery's result, attempts and time.
- Only public `https` addresses. The name is resolved once per attempt, by the connection itself, and refused when any address is private, loopback, link-local or otherwise not public, including IPv4 written inside IPv6 (mapped, compatible, NAT64, 6to4, SIIT) and site-local `fec0::/10` (`apps/api/src/ip-address.ts`); the request goes to the address that was checked. Port 443 or 8443 only, so a URL cannot aim at another service on a public host. `WEBHOOK_ALLOW_PRIVATE_URLS=true` allows `http`, other ports and private addresses (development, closed networks).
- At most 10 endpoints per workspace, and each API process sends 5 deliveries at once (`WEBHOOK_WORKERS` in `apps/api/src/jobs.ts`), so a few slow endpoints (each up to the 10 s timeout) do not hold up everyone else's.
- A failed connection is logged as "could not connect", whatever the reason (the detail goes to the server log), so the log and test sends cannot probe ports.
- Test sends run outside a database transaction, are not commands (only the delivery log has them) and are limited to 10 a minute per workspace.
- Payloads hold callers' details: they are cleared after 30 days (daily job `webhooks.cleanup`) and when their call is deleted; status, attempts and times stay. A pending delivery of a deleted call is not sent.
- The secret is generated in the browser, sent once (`sensitive`: the command log stores it redacted) and stored encrypted with `SECRETS_KEY`. Endpoints sync to owners and admins only (their URLs can carry a token).
