# CRM sync (design note, not built)

How Linedesk should connect to a business's CRM. HubSpot first; nothing here is built yet.

## What a business wants from it

1. **Every call in the CRM**, on the right customer: who called, when, the summary, next steps, a link back to the call. This is the main ask; without it, the CRM and the inbox drift apart.
2. **The assistant knows the caller**: "existing customer, last job in March, Gate code 1234" when a known number calls.
3. Not wanted at first: editing CRM records from Linedesk, or CRM records changing Linedesk contacts behind the member's back.

For businesses that use another CRM (or a field-service tool like Jobber or Housecall Pro), webhooks (`docs/webhooks.md`) plus Zapier or Make already cover point 1 today without anything CRM-specific.

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

- On `call.completed` (the same event the webhooks use, `apps/api/src/webhooks.ts`), a pg-boss job `crm.push` per connected CRM: find the CRM contact by phone (HubSpot: search on `phone` and `mobilephone`), else by email, else create it with name, phone, email, company. Then create a Call engagement associated with the contact: title, summary, next steps, duration, direction, a link to the call in Linedesk (no recording upload, no transcript by default).
- Contact fields in the CRM are only filled when empty, never overwritten (the rule `contact.import` uses). The CRM's record id is stored per Linedesk contact (`crm_links`), so the next call goes to the same record even if numbers change.
- Test calls and spam push nothing. Retries with backoff; after repeated failures the connection shows "needs attention" (like a calendar that needs reconnecting).

**Phase 2: read-only pull for caller context.**

- At `call.start` the CRM is not asked synchronously (the greeting budget is under 1.5 s). Instead the facts are cached per contact: refreshed in the background after each call and when the connection is made (a nightly refresh for contacts called in the last 90 days), and the assistant gets the cached facts with `call.start`'s booking context. A cache miss means no context, never a delay.
- Only a short, owner-chosen set of fields (e.g. lifecycle stage, last deal, a notes field), not the whole record.

## Shape (when built)

- `packages/crm`: a `CrmProvider` interface (find contact by phone or email, create contact, fill empty fields, log call, read fields) with a HubSpot adapter; vendor SDKs only there (core rule 3), contract tests like the calendar adapters.
- OAuth per workspace (a HubSpot public app; self-hosters set `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`, like the Google calendar app). Tables like the calendar ones: `crm_connections` (synced, no secret), `crm_credentials` (encrypted with `SECRETS_KEY`, never synced), `crm_links` (contact ↔ CRM id), the push log in the job table plus a short per-call status.
- Actions through the registry: `crm.connectStart` / `crm.connectFinish` / `crm.disconnect` (owners and admins), `crm.setFields` (what the assistant may read). UI: Settings › Integrations › HubSpot: connect, what gets pushed, last pushes and failures.
- Scopes asked: contacts read/write and the engagement (calls) scope; nothing else.

## Open questions

- Is HubSpot really first for US trades, or Jobber / Housecall Pro? Ask the first ten customers before building.
- Whether the call summary may leave Linedesk by default (privacy note in the connect step), and whether the transcript is an opt-in.
- Recording links: a signed, expiring link to `GET /v1/calls/<id>/recording` vs. only a link to the call in Linedesk (needs sign-in). Default: link to the call.
