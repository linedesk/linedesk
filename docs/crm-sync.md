# CRM sync

How Linedesk connects to a business's CRM. HubSpot first. Phase 1 (push) is built (see "Built in phase 1" below); phase 2 (pull) is not.

## What a business wants from it

1. **Every call in the CRM**, on the right customer: who called, when, the summary, next steps, a link back to the call. This is the main ask; without it, the CRM and the inbox drift apart.
2. **The assistant knows the caller**: "existing customer, last job in March, Gate code 1234" when a known number calls.
3. Not wanted at first: editing CRM records from Linedesk, or CRM records changing Linedesk contacts behind the member's back.

For businesses that use another CRM (or a field-service tool like Jobber or Housecall Pro), the assistant's webhooks (`docs/webhooks.md`) plus Zapier, Make or n8n already cover both points today without anything CRM-specific: the after-call webhook sends the whole call (point 1), the call-start webhook asks the business's system about the caller (point 2).

## Push or pull

| | Push (Linedesk → CRM) | Pull (CRM → Linedesk) |
| --- | --- | --- |
| What | After a call: find or create the contact by number, log a Call activity on it with the summary and a link | At call start: look up the number, give the assistant a few facts |
| Value | High: the ask in point 1 | Medium: point 2, a better first sentence |
| Risk | Duplicates in the CRM if matching is loose; must never overwrite CRM fields | Latency on the greeting path; stale data if cached; PII in the prompt |
| Failure | Retry later (job), nothing visible to the caller | Must fall back to "no context" within the greeting budget |

Two-way contact sync (both sides edit the same fields) is left out: it needs conflict rules, field mapping per account and a sync log, for little gain in a small business.

## Proposal

**Phase 1: push call activity, fill-only contacts.**

- When a call is finished (where the after-call webhook is queued, `apps/api/src/webhooks.ts`), a pg-boss job `crm.push` per connected CRM: find the CRM contact by phone (HubSpot: search on `phone` and `mobilephone`), else by email, else create it with name, phone, email, company. Then create a Call engagement associated with the contact: title, summary, next steps, duration, direction, a link to the call in Linedesk (no recording upload, no transcript by default).
- Contact fields in the CRM are only filled when empty, never overwritten (the rule `contact.import` uses). The CRM's record id is stored per Linedesk contact (`crm_links`), so the next call goes to the same record even if numbers change.
- Test calls and spam push nothing. Retries with backoff; after repeated failures the connection shows "needs attention" (like a calendar that needs reconnecting).

**Phase 2: read-only pull for caller context.**

- At `call.start` the CRM is not asked synchronously (the greeting budget is under 1.5 s; the call-start webhook may delay a greeting that uses caller details by up to 1.3 s, which the owner chooses by writing `{{name}}` into it, docs/webhooks.md). Instead the facts are cached per contact: refreshed in the background after each call and when the connection is made (a nightly refresh for contacts called in the last 90 days), and the assistant gets the cached facts with `call.start`'s booking context. A cache miss means no context, never a delay.
- Only a short, owner-chosen set of fields (e.g. lifecycle stage, last deal, a notes field), not the whole record.

## Built in phase 1

A generic base for **connected apps** (business tools a workspace connects by OAuth), so Slack and Jobber reuse it; HubSpot is the first app.

- `packages/connectors`: the app interface (`AppConnector`: OAuth, token refresh, revoke, `pushCall`), `CrmProvider` with the phase-1 push (`pushCallToCrm`: stored link, then phone in E.164, then email, else create; fill only empty fields; log the call) and the HubSpot adapter. Vendor HTTP only there (core rule 4). Contract test with HubSpot's HTTP mocked: `src/hubspot.test.ts`.
- The HubSpot app's client id and secret are an instance provider (Server admin › Providers › Connected apps, `provider_settings`, the secret encrypted and marked sensitive), not `.env`. Redirect URL: `<origin>/v1/apps/callback/hubspot`. Scopes: `oauth crm.objects.contacts.read crm.objects.contacts.write`. No PKCE: HubSpot's OAuth documentation (2026-11) names no `code_challenge`; the code exchange is server-side with the client secret, and the `state` is single use and bound to the member.
- Tables: `app_connections` (synced, no secret; `needs_attention` with an `error_code`), `app_credentials` (access and refresh token, AES-256-GCM with `SECRETS_KEY`, bound to their slot, never synced), `app_oauth_states` (one use, 10 minutes, bound to member and workspace), `crm_links` (Linedesk contact ↔ CRM record), `app_pushes` (one row per call and connection: state, tries, the caller's record and the logged call as soon as each exists, the failure as an `error_code`). Failures are codes the page words (i18n); the app's own message goes to the server log only.
- Actions through the registry (owners and admins, `settings:write`): `app.connectStart`, `app.connectFinish` (run by `GET /v1/apps/callback/:app`; `code` and `state` are sensitive; the callback sends back only a reason code, `appConnectErrors`, never text), `app.disconnect` (removes tokens and links, then, once that has committed, uninstalls the HubSpot app from the portal with `DELETE /appinstalls/2026-03/external-install` and revokes the refresh token; when another Linedesk connection uses the same portal, only this connection's refresh token is revoked), `app.updateSettings` (the switches above), `app.pushes` (read-only: the last calls sent). Not during support access (impersonation), except reading `app.pushes`.
- After a finished phone call (`call.finish` and the stale-call sweep; no test calls, no spam) a pg-boss job `app.push` per connection. No transaction stays open while HubSpot is asked: a try claims the push (`sending`, the try counted) in a short transaction under the connection's advisory lock (`app:<id>`), one push per connection at a time (so one new caller never becomes two records), then saves each step in its own short transaction: the caller's record when found or created, the logged call when it exists, so a retry neither creates nor logs twice. A failure is saved in its own transaction too. A token refresh asks HubSpot first, then saves under the same lock only if the stored grant did not change; connecting again and disconnecting take that lock as well. Token refresh once on 401; retries with backoff (8 tries); a refused grant, or 3 failures in a row, sets `needs_attention`. A refresh HubSpot answers with `BAD_REFRESH_TOKEN` / `invalid_grant` (the app was uninstalled in the portal) removes the connection with its tokens, links and pushes, as a disconnect does, unless the connection was connected again in between; a refused client ID or secret does not. A claim whose worker died is taken over after 10 minutes; a sweep every 15 minutes queues stuck pushes again and gives up those open for a day.
- UI: Integrations › HubSpot (`#integrations/hubspot`): connect, the account and its state, connect again, disconnect, recent calls with their failures. The card shows Connected, Needs attention or Not connected.
- What Linedesk does in the app: switches per connection in `app_connections.settings` (jsonb; only switches someone changed are stored, a missing switch is on, so a connection made before behaves as before). The switches an app has: `APP_SETTINGS` in `packages/actions/src/apps.ts`; HubSpot has `log_calls` (off: no push is queued, a queued one ends `skipped`/`calls_off`), `create_contacts` (off: a caller with no matching record is not created, the push ends `skipped`/`no_contact` and does not count as a failure; a caller with a record still gets the call), `fill_fields` (off: an existing record gets no field updates). Changed only through `app.updateSettings` (`settings:write`, merged on the server, audit-logged, not during support access); the push reads them when it claims the call. UI: the "What Linedesk does" card in Integrations › HubSpot, shown while connected.

Not built yet: `crm.setFields` and phase 2 (pull), a privacy note in the connect step.

## Slack

Slack is a connected app on the same base, but not a CRM: every finished phone call becomes one message in a channel the business picks.

- Server admin › Providers › Slack (apps group): client ID and secret, and the optional signing secret (secrets encrypted, sensitive), a key guide, and the app from `integrations/slack/manifest.json` (app "Linedesk", bot scope `incoming-webhook`, token rotation off). Redirect URL: `<origin>/v1/apps/callback/slack`.
- The provider test checks the form of both values and asks Slack (`oauth.v2.exchange`) whether it knows the client ID. Slack has no free check of the client secret (every method checks the code or token first), so a known client ID passes with a warning. A wrong secret shows when a business connects: the member reads "not set up", and Server admin sees Slack as failing (`provider_failures`, source `app`).
- Connect: OAuth v2 with the one scope `incoming-webhook`; Slack's consent page lets the member pick the channel. The token answer carries the channel's incoming webhook: its URL is stored only in `app_credentials.webhook_url_encrypted` (AES-256-GCM, slot `app.<id>.slack.webhook`), never in a synced row or a log; a URL not on `hooks.slack.com` is refused. `app_connections.channel` keeps the channel name (`#calls`) for the page, which shows "#calls in <Slack workspace>". The bot token is the lasting grant (no refresh token, does not run out) and is kept only to uninstall.
- One Slack workspace, one bot token (`grantPerAccount`): connecting again or disconnecting never uninstalls the app while another Linedesk connection uses the same Slack workspace.
- Push: the same rules as HubSpot (phone calls only, no test calls, no spam; the same job, lock and retries). One Block Kit message: title, an urgent line, caller and number, the summary, the next steps, the time (Slack's `<!date>` token, so each reader sees their own zone; the server's text in UTC as fallback), and a button to the call. All words come from `email.json` (`appPush.*`, `getT(locale)`). A call without caller ID is still posted. A webhook post has no id at Slack: the call's id marks it posted, so a retry never posts twice.
- Failures: `channel_not_found` and `channel_is_archived` (codes `channel_not_found`, `channel_archived`), `invalid_token`, `no_service`, `no_team`, `team_disabled`, 403, 404 and 410 (code `auth`) set Needs attention at once. 429 waits for `Retry-After` (a new job with that delay, the try counted); 5xx and network failures retry with backoff like HubSpot; other 400s are `invalid`.
- Switches: `log_calls` ("Post every call", on) and `only_urgent` ("Only urgent calls", off by default, `OFF_BY_DEFAULT`). Only urgent is checked when the push is sent, after the summary set the urgency; a call not sent ends `skipped`/`not_urgent`.
- Disconnect: deletes the tokens and the webhook, then `apps.uninstall` with the bot token after the commit, best effort.
- Uninstall in Slack: the app's Events API URL `<origin>/v1/apps/events/slack` (`apps/api/src/slack-events.ts`) gets `app_uninstalled`, and `tokens_revoked` when the bot token is revoked. The request is checked with the signing secret (`X-Slack-Signature`, `v0` HMAC-SHA256 of `v0:<timestamp>:<body>`, constant-time; a timestamp more than five minutes off is refused); a bad or missing signature is 401, and without a signing secret the route is 404. A signed event deletes every connection to that Slack workspace with its tokens and webhook, in every Linedesk workspace (`dropAppAccount`, like Jobber's `APP_DISCONNECT`); an organisation id counts only for an org-wide install. Grants stored after the event (minus one minute of clock skew) stay, so an install again right after is kept. Slack is not asked to uninstall again. `url_verification` answers its challenge; other events are 200 and ignored. Without the events URL an uninstall shows at the next post (`no_service`, 404).

## Jobber

Jobber is a CRM on the same base as HubSpot: every finished phone call finds or adds the caller's Jobber client and adds the call as a note on it.

- Server admin › Providers › Jobber (apps group): client ID and secret (secret encrypted, sensitive), a key guide, and `integrations/jobber/README.md` for the app in Jobber's Developer Center (scopes Clients read and write, refresh token rotation on). Redirect URL: `<origin>/v1/apps/callback/jobber`. Linedesk talks only to `api.getjobber.com`.
- The provider test is free: a refresh with a made-up token. Jobber answers a wrong client ID or secret with HTTP 401 "The provided client id and secret do not match an existing application" (checked live, 2026-11-17), so a wrong pair fails. A known client gets 400 or 401 for the made-up token and passes; any other answer is a warning.
- Connect: OAuth 2 authorization code; Jobber sets the scopes on the app, not in the consent URL. No PKCE (optional at Jobber; the code exchange is server-side with the secret, the `state` single use and bound to the member). Access tokens are JWTs that last 60 minutes; with rotation on, every refresh returns a new refresh token, which is stored in place of the old one (`app_credentials`, encrypted, slot `app.<id>.jobber.refresh`). The token answer names no scopes, so the scope check runs only if Jobber ever reports them; a missing scope then shows on the first push as `auth`. The connection's account is Jobber's `account { id name }`.
- One Jobber account, one app connection (`grantPerAccount`): `appDisconnect` removes the app from the whole account, so disconnecting or connecting another account never runs it while another Linedesk connection uses that account.
- GraphQL at `/api/graphql` with `X-JOBBER-GRAPHQL-VERSION` (`2026-09-25`). Find: `clients(searchTerm:)` with the national digits, the national form and E.164 in turn (Jobber keeps numbers as typed and its search is fuzzy), a hit counts only if one of its numbers has the caller's national number; then the email, matched exactly. Create: `clientCreate` with name, company, phone and email; a caller with no name gets the number as first name (Jobber needs a name), which counts as empty, so a later call fills it. Fill: `clientEdit` with only the empty fields (`phonesToAdd`, `emailsToAdd`). Log: `clientCreateNote` with plain text: the title (and "Urgent"), the summary, the next steps and a link to the call; words from `email.json` (`appPush.*`).
- Errors: HTTP 401 after one refresh, 403, an access or scope error, and a refused refresh (`invalid_grant`) are `auth` (Needs attention). Throttling (`THROTTLED` with HTTP 200, or HTTP 429) is `rate_limited`, retried after the wait Jobber's cost bucket needs (or `Retry-After`). 5xx and network are `unavailable`. `userErrors` and other GraphQL errors are `invalid`; a linked client that is gone is searched for again and the new one linked.
- Switches: the HubSpot three, worded for clients: `log_calls` ("Add every call as a note on the client"), `create_contacts` ("Add new callers as clients"), `fill_fields`, all on.
- Risk of rotation: if Jobber rotates the refresh token but saving the new one fails, the stored token no longer works and the connection needs to be connected again (Needs attention says so).

## Open questions

- Is HubSpot really first for US trades, or Jobber / Housecall Pro? Ask the first ten customers before building.
- Whether the call summary may leave Linedesk by default (privacy note in the connect step), and whether the transcript is an opt-in.
- Recording links: a signed, expiring link to `GET /v1/calls/<id>/recording` vs. only a link to the call in Linedesk (needs sign-in). Default: link to the call.
