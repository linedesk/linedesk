# CRM sync

How Linedesk connects to a business's CRM. HubSpot first. Phase 1 (push) is built (LIN-303, see "Built in phase 1" below); phase 2 (pull) is not.

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

## Built in phase 1 (LIN-303)

A generic base for **connected apps** (business tools a workspace connects by OAuth), so Slack (LIN-351) and Jobber (LIN-304) reuse it; HubSpot is the first app.

- `packages/connectors`: the app interface (`AppConnector`: OAuth, token refresh, revoke, `pushCall`), `CrmProvider` with the phase-1 push (`pushCallToCrm`: stored link, then phone in E.164, then email, else create; fill only empty fields; log the call) and the HubSpot adapter. Vendor HTTP only there (core rule 4). Contract test with HubSpot's HTTP mocked: `src/hubspot.test.ts`.
- The HubSpot app's client id and secret are an instance provider (Server admin › Providers › Connected apps, `provider_settings`, the secret encrypted and marked sensitive), not `.env`. Redirect URL: `<origin>/v1/apps/callback/hubspot`. Scopes: `oauth crm.objects.contacts.read crm.objects.contacts.write`. No PKCE: HubSpot's OAuth documentation (2026-11) names no `code_challenge`; the code exchange is server-side with the client secret, and the `state` is single use and bound to the member.
- Tables: `app_connections` (synced, no secret; `needs_attention` with an `error_code`), `app_credentials` (access and refresh token, AES-256-GCM with `SECRETS_KEY`, bound to their slot, never synced), `app_oauth_states` (one use, 10 minutes, bound to member and workspace), `crm_links` (Linedesk contact ↔ CRM record), `app_pushes` (one row per call and connection: state, tries, the caller's record and the logged call as soon as each exists, the failure as an `error_code`). Failures are codes the page words (i18n); the app's own message goes to the server log only.
- Actions through the registry (owners and admins, `settings:write`): `app.connectStart`, `app.connectFinish` (run by `GET /v1/apps/callback/:app`; `code` and `state` are sensitive; the callback sends back only a reason code, `appConnectErrors`, never text), `app.disconnect` (removes tokens and links, withdraws the grant at the app once that has committed), `app.pushes` (read-only: the last calls sent). Not during support access (impersonation), except reading `app.pushes`.
- After a finished phone call (`call.finish` and the stale-call sweep; no test calls, no spam) a pg-boss job `app.push` per connection. No transaction stays open while HubSpot is asked: a try claims the push (`sending`, the try counted) in a short transaction under the connection's advisory lock (`app:<id>`), one push per connection at a time (so one new caller never becomes two records), then saves each step in its own short transaction: the caller's record when found or created, the logged call when it exists, so a retry neither creates nor logs twice. A failure is saved in its own transaction too. A token refresh asks HubSpot first, then saves under the same lock only if the stored grant did not change; connecting again and disconnecting take that lock as well. Token refresh once on 401; retries with backoff (8 tries); a refused grant, or 3 failures in a row, sets `needs_attention`. A claim whose worker died is taken over after 10 minutes; a sweep every 15 minutes queues stuck pushes again and gives up those open for a day.
- UI: Integrations › HubSpot (`#integrations/hubspot`): connect, the account and its state, connect again, disconnect, recent calls with their failures. The card shows Connected, Needs attention or Not connected.

Not built yet: `crm.setFields` and phase 2 (pull), a privacy note in the connect step.

## Open questions

- Is HubSpot really first for US trades, or Jobber / Housecall Pro? Ask the first ten customers before building.
- Whether the call summary may leave Linedesk by default (privacy note in the connect step), and whether the transcript is an opt-in.
- Recording links: a signed, expiring link to `GET /v1/calls/<id>/recording` vs. only a link to the call in Linedesk (needs sign-in). Default: link to the call.
