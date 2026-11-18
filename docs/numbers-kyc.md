# Numbers that need documents (KYC)

In some countries the carrier activates a local number only after it has checked who the number is for. Telnyx calls
this regulatory requirements: an address, documents, sometimes a form. Linedesk hands these to Telnyx as a
*requirement group*, orders the number with that group, and waits for Telnyx's review. Germany comes first, then the
UK, then Ireland (LIN-608, LIN-301).

The US, Canada and Puerto Rico are not affected. Numbers there are bought at once (`phoneNumber.setup`,
`NUMBER_BUY_COUNTRIES`). The KYC countries are never in that list: a number there is only *requested*.

## The flag

`NUMBER_KYC_COUNTRIES` (API environment, comma-separated: `DE`, `GB`, `IE`) opens countries one by one. It is empty
by default. While it is empty:

- `numberRequest.countries` answers an empty list, and every other `numberRequest.*` action refuses with
  `number_request_country_closed`;
- the webhook route answers 404;
- nothing else changes: plain purchases stay limited to `NUMBER_BUY_COUNTRIES`, and sign-up countries are untouched.

## Data

Three tables, not synced to browsers (`packages/db/src/schema.ts`, migration `0166_number_requests`):

- `regulatory_profiles`: one per workspace. Legal name, type (`business`, `sole_trader`, `individual`), registration
  number, website, use case, address and contact.
- `regulatory_documents`: ID or registration certificate (`id_or_registration`), proof of address
  (`proof_of_address`), the German BNetzA form (`bnetza_form`). PDF, PNG or JPEG, at most 2.5 MB, at most 10 per
  workspace; the first bytes must match the type. The file is encrypted with `SECRETS_KEY` (AES-256-GCM, slot
  `regulatory_document:<id>`) and is moved by `rotate-secrets-key.ts`. The app lists documents by name only; the
  content never goes back to a browser, only to the carrier. Upload input is redacted in the command log.
- `number_requests`: one per requested number, with its state, the carrier's refs and the reason of a rejection.

Access: owners and admins (`settings:write`). Members, the voice agent and API keys get nothing (the actions are not
public). While an instance admin is signed in as a user, the profile and the document list are refused
(`numberRequest.getProfile`); the requests' state stays visible for support.

Command log: `saveProfile` and `uploadDocument` are logged with ids only (`logged: 'ids'`): no names, address,
contact or filenames; the document's content is never logged.

Retention: everything goes with the workspace (`workspace-delete.ts` deletes every table with a `workspace_id`). A
document can be deleted at any time (`numberRequest.deleteDocument`).

At the carrier: each request leaves, in the install's (or the workspace's own) Telnyx account, an address
(`POST /addresses`), the uploaded documents (`POST /documents`) and the requirement group, all tagged with the request
id as `customer_reference`. Linedesk does not delete them: not when a request is rejected or cancelled, not when a
document is deleted in the app, not when the workspace is deleted. They stay under Telnyx's own retention; the
operator deletes them in the Telnyx portal (or with `DELETE /v2/documents/{id}`, `/addresses/{id}`,
`/requirement_groups/{id}`) when a business asks for erasure. A document Telnyx never linked to a requirement is
deleted by Telnyx after 30 minutes.

## States

```
requested ─▶ submitted ─▶ pending_review ─▶ approved ─▶ active
                               │                │
                               ├─▶ rejected     └─▶ needs_operator (could not be set up; ALERT; a refresh tries again)
                               └─▶ cancelled (by the owner)
```

- `requested`: stored; the profile and documents are complete for the country.
- `submitted`: the address and documents are uploaded, the requirement group is submitted for approval.
- `pending_review`: the number is ordered with the group. The order stays pending at Telnyx until the group is approved.
- `approved`: the order completed, the number is on the carrier account (paid from now on).
- `active`: the number is routed to the assistant and stored in `phone_numbers` (`mode: new`, `purchased: true`), like a
  bought number: the first month is posted, the setup milestone is recorded, the country defaults follow.
- `rejected`: the group was declined or expired, or the order failed. `reason` holds the carrier's words. A waiting
  order is cancelled, so no number lands on the account later (if cancelling fails, the request stays
  `pending_review` and the next refresh tries again).
- `cancelled`: the owner cancelled it before the carrier decided. If the carrier completed the order meanwhile, the
  cancel does not cancel: the number is set up (`cancelled: false` in the answer), so a paid number is never left
  unrouted. A failed order rejects the request instead.
- `needs_operator`: the carrier approved and the number is on the account (paid), but it could not be set up: it is
  set up in another workspace (`number_in_use`), the workspace was disabled (`workspace_disabled`) or its bill stopped
  (`bill_inactive`) while the carrier decided, `LIVEKIT_SIP_ENDPOINT` is missing (`setup_not_configured`), routing
  failed (`routing_failed`), or the number is not on the account (`not_on_account`). An `ALERT` names it: the operator
  sets it up or releases it. Not open: it does not count against the 2 open requests and cannot be cancelled; a
  refresh (or the next webhook) tries the set-up again.

Purchase limits: a request logs its purchase (`number_purchases`, id `np_<request id>`) before the order, like a
bought number. A request that ends `rejected` or `cancelled` brought no number and no longer counts against the
install's limits (`installPurchaseRefusal`); the row stays for the record.

If the action that made the order fails afterwards, its order is cancelled; one the carrier completed meanwhile is
released. Deleting a workspace cancels its open orders at the carrier and releases a number the carrier already put
on the install's account for one of its requests (`ALERT` if either fails); one on the workspace's own account stays
the business's and is listed as left.

A webhook body never sets a state. The webhook only says which order or group changed; the API then reads the order
(and the group) from the carrier again.

## Carrier interface

`TelephonyProvider.regulatory` (`packages/telephony/src/provider.ts`), optional per carrier:

- `numberRequirements(country, type)`: what Telnyx needs (reads only).
- `createAddress`, `uploadDocument`, `submitRequirementGroup`, `getRequirementGroup`.
- `orderNumber({ e164, requirementGroupRef, customerReference })`, `getNumberOrder`, `cancelNumberOrder`.
- `parseRegulatoryWebhook`: verifies the Telnyx signature (the install's Telnyx public key).

`searchNumbers({ withRequirements: true })` searches a country with requirements instead of refusing it.

Telnyx: `createTelnyxRegulatory` (`telnyx-regulatory.ts`). The dev carrier has an in-memory stand-in
(`dev-regulatory.ts`): Telnyx's requirements for DE, GB and IE, groups and orders that stay pending until
`decideDevReview` (tests) or `LINEDESK_DEV_KYC_OUTCOME=approved|declined` (local development) decides them. Twilio has
no `regulatory` yet; a workspace on Twilio gets `carrierNoDocuments`.

Each Telnyx requirement is matched to a value by its name (`requirementSource` in
`packages/actions/src/number-countries.ts`): a profile field, the address or a document kind. A requirement nothing
matches refuses the request (`number_request_unsupported`) and logs an `ALERT` for the operator, who then extends the
matching.

## Webhook

Telnyx takes no webhook URL per number order or requirement group (`POST /v2/number_orders` and
`POST /v2/requirement_groups` have no such field; checked 2026-11-18), and Linedesk never changes the carrier account's
settings itself. So the URL is set once by hand, after the release that turns a country on:

1. Telnyx Mission Control → **Account Settings** → **Advanced Settings** → **Notifications** (organization owners only).
2. **Notification Profiles** → **New Profile**: `Linedesk number requests`.
3. **Notification Channels** → **New Channel**: that profile, type **Webhook**, URL
   `<LINEDESK_API_URL>/v1/telephony/number-requests/webhook` (the API's public HTTPS base URL of that install,
   e.g. staging and production each get their own channel in their own Telnyx account).
4. **Notification Settings** → **New Settings**: event **Number Order Notifications** ("When a Number Order Completes",
   `number_order.complete`), that profile.

Telnyx has no notification for a requirement group's status: a declined group shows when the order is read again (a
refresh, or the order's own completion event). The event is signed like call webhooks (`telnyx-signature-ed25519`,
`telnyx-timestamp`); the route answers 400 to anything that does not verify with the install's Telnyx public key.
Check the payload shape on the first real order (`data.event_type`, `data.payload.id` or `customer_reference`): the
public reference does not spell it out. Only requests on the
install's carrier account are refreshed by the webhook; a request on a workspace's own Telnyx account is refreshed
with `numberRequest.refresh`.

## Actions

| Action | What it does |
| --- | --- |
| `numberRequest.countries` | The open countries (empty: flag off). |
| `numberRequest.requirements` | Fields, documents, cities and what is still missing for a country. |
| `numberRequest.getProfile` / `saveProfile` | The regulatory profile and the document list. |
| `numberRequest.uploadDocument` / `deleteDocument` | Documents (base64, redacted in the log). |
| `numberRequest.create` | `{ country, prefix }`: submits everything, orders a number. Same bill and purchase limits as a bought number; at most 2 open requests per workspace. |
| `numberRequest.list` / `refresh` / `cancel` | Where requests stand; ask the carrier now; cancel an open one. |

## Countries

Data only, in `NUMBER_COUNTRIES` (`packages/actions/src/number-countries.ts`); more cities need no migration.

- Germany (DE, +49), local numbers. Telnyx asks for a contact (name, business, phone), the company registration
  number, an address in the number's area-code region, proof of address that shows local activity, a German ID or
  passport or the company's registration certificate, and the BNetzA form. Cities: Berlin 030, Hamburg 040, München
  089, Köln 0221, Frankfurt 069, Stuttgart 0711, Düsseldorf 0211.
- United Kingdom (GB, +44), local numbers. Company website, ID or business registration, contact, proof of address
  (a recent bill), a use case that says the number is sub-allocated to the business; the address can be anywhere.
  Cities: London 020, Manchester 0161, Birmingham 0121, Glasgow 0141, Edinburgh 0131.
- Ireland (IE, +353), local numbers. End user's name and type, usage, ID or registration, an address in the area-code
  region, proof of address, contact email. Cities: Dublin 01, Cork 021, Galway 091, Limerick 061.

Germany and Ireland want the address in the number's area. Linedesk only flags a city that does not match
(`addressOutsideArea` in the answer of `numberRequest.create`); Telnyx decides.

## Before a country goes live

- UI: a "Phone numbers" request form in settings and the onboarding phone step (profile, documents, city picker,
  request status), with the texts in every locale.
- A real test purchase in Germany with real documents on the install's Telnyx account, and the Telnyx notification
  set (see Webhook).
- The privacy page (linedesk.ai/privacy): the documents, their purpose, Telnyx as the processor that receives them.
- Billing stays in USD (decision of 2026-11-18); the price of a German number at Telnyx differs from a US one.

Open legal and tax points (a telecom lawyer and a tax advisor before go-live):

- Germany: whether Linedesk has to notify the Bundesnetzagentur as a telecom service provider (TKG §5), the rules for
  passing numbers on to end users (Nummernzuteilung, local presence for geographic numbers), the BNetzA form.
- UK: Ofcom's General Conditions for sub-allocated numbers (B1), the Telnyx use-case disclosure.
- Ireland: ComReg's numbering conditions for geographic numbers (local presence).
- VAT: electronic and telecom services to EU businesses and consumers (reverse charge, OSS for consumers), UK VAT.
- GDPR: storing ID documents (data minimisation, how long they are kept, deleting them once a request is decided).
