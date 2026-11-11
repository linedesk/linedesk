# Public API

Integrations use the same write path as the app: every change is an action, `POST /v1/actions/<name>` with a JSON body.

- **Description:** `GET /v1/openapi.json` (OpenAPI 3.1, no sign-in needed). It is generated from the action registry (`packages/actions/src/openapi.ts`): an action is listed when its definition has `public: true`, with its Zod input as the request schema. Agent, team, settings and admin actions are never public.
- **Auth:** `Authorization: Bearer ld_…`, a workspace API key (Settings, Developers). The key acts in its workspace with its role.
- **Retries:** send an `idempotency-key` header on writes; a retry with the same key returns the first result instead of acting twice.
- **Results:** `200 { ok: true, rows, data? }`; refusals are `{ ok: false, error }` with 401 (key), 403 (permission), 409 (refused, e.g. unknown call), 422 (input), 429 (rate limit, see `retry-after`).

```sh
curl -X POST "$LINEDESK_URL/v1/actions/call.markDone" \
  -H "authorization: Bearer $LINEDESK_API_KEY" -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" -d '{"callId":"call_123"}'
```

To publish another action, add `public: true` to its `defineAction` and make sure an API key's role may run it.

## MCP

`/mcp` is an MCP server (official TypeScript SDK v2, Streamable HTTP, stateless: one server per request, no sessions) for AI tools such as Claude or ChatGPT connectors (`apps/api/src/mcp.ts`).

- **Auth:** the same workspace API key, `Authorization: Bearer ld_…`. Session cookies are not accepted. Refused keys and requests per key are limited as on `/v1`.
- **Tools:** every public action the key's role may run, named with `_` for `.` (`call_markDone`, `appointment_book`), with the action's input schema; they run through the registry like `POST /v1/actions/<name>` (permissions, command log). Read tools: `calls_list` (open, done or all, newest first), `calls_get` (one call with its transcript), `contacts_search`.
- **Clients:** both the current protocol (2026-07-28) and 2025-era clients, which are served statelessly.
