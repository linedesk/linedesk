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

Three tables, not synced to browsers (`packages/db/src/schema.ts`, migrations `0166_number_requests` and
`0167_regulatory_register_court`):

- `regulatory_profiles`: one per workspace. Legal name, type (`business`, `sole_trader`, `individual`), registration
  number, register court (optional, `register_court`: "Amtsgericht Mannheim"), website, use case, address and contact.
  A German registration number is only unique with its court: when the carrier has no requirement of its own for the
  court (none of Telnyx's known German requirements is one), the court is sent with the number ("HRB 123456 B,
  Amtsgericht Mannheim"); a requirement named like a court (`register court`, `Registergericht`, `Amtsgericht`) gets
  the court alone.
- `regulatory_documents`: ID or registration certificate (`id_or_registration`), proof of address
  (`proof_of_address`), the German BNetzA form (`bnetza_form`). PDF, PNG or JPEG, at most 2.5 MB, at most 10 per
  workspace; the first bytes must match the type. The file is encrypted with `SECRETS_KEY` (AES-256-GCM, slot
  `regulatory_document:<id>`) and is moved by `rotate-secrets-key.ts`. The app lists documents by name only; the
  content never goes back to a browser, only to the carrier. Upload input is redacted in the command log.
  The blank BNetzA form is Telnyx's "German Registration Form Template" (help article 1311450, Germany DID
  Requirements), shipped in apps/web/src/numbers/assets/. Settings and the onboarding phone step offer it filled in
  with the business's details (pdf-lib, in the browser: apps/web/src/numbers/bnetzaForm.ts) to sign and upload.
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
| `numberRequest.requirements` | Fields, documents, popular cities, `anyArea`, `monthlyFeeWaived` and what is still missing for a country. |
| `numberRequest.areas` | `{ country, query?, address?: { city?, postal_code? }, limit? }`: the areas a query finds (a place, a municipality or an area code) and the areas the address suggests (see Area codes), each with `available`; `carrierBlocksOnly` says the carrier blocks rule applies. |
| `numberBlocks.get` / `set` | Instance admin: `{ on }`, the carrier blocks rule (see "Only where the carrier holds number blocks"); answers `{ on, byDefault, portingId, areas }`. Audited. |
| `numberRequest.getProfile` / `saveProfile` | The regulatory profile and the document list. |
| `numberRequest.uploadDocument` / `deleteDocument` | Documents (base64, redacted in the log). |
| `numberRequest.create` | `{ country, prefix }`: submits everything, orders a number. Same bill and purchase limits as a bought number; at most 2 open requests per workspace. Refused with `number_request_unknown_area` for an area code the country does not have, `number_request_no_local_numbers` for an area without the carrier's own number blocks (carrier blocks rule), and `number_request_no_numbers` when the carrier has no free number there right now (under the rule: none inside its blocks). |
| `numberRequest.list` / `refresh` / `cancel` | Where requests stand; ask the carrier now; cancel an open one. |

## Countries

Data only, in `NUMBER_COUNTRIES` (`packages/actions/src/number-countries.ts`); more cities need no migration.

- Germany (DE, +49), local numbers in **any** Ortsnetz (see Area codes). Telnyx asks for a contact (name, business,
  phone), the company registration number, an address in the number's area-code region, proof of address that shows
  local activity, a German ID or passport or the company's registration certificate, and the BNetzA form. Popular
  cities (the suggestions before a search): Berlin 030, Hamburg 040, München 089, Köln 0221, Frankfurt 069, Stuttgart
  0711, Düsseldorf 0211.
- United Kingdom (GB, +44), local numbers. Company website, ID or business registration, contact, proof of address
  (a recent bill), a use case that says the number is sub-allocated to the business; the address can be anywhere.
  Cities: London 020, Manchester 0161, Birmingham 0121, Glasgow 0141, Edinburgh 0131.
- Ireland (IE, +353), local numbers. End user's name and type, usage, ID or registration, an address in the area-code
  region, proof of address, contact email. Cities: Dublin 01, Cork 021, Galway 091, Limerick 061.

Germany and Ireland want the address in the number's area. Linedesk only flags an address that does not look like it
is in the area (`addressOutsideArea` in the answer of `numberRequest.create`); Telnyx decides.

## Area codes

The business always keeps the choice: Linedesk suggests an area, it never locks one.

- **Germany: every Ortsnetz.** The list is the Bundesnetzagentur's Vorwahlverzeichnis (5,200 Ortsnetze with their
  Ortsnetzkennzahl and name), in `apps/api/src/de-areas.data.ts`, made by `apps/api/scripts/de-areas.ts` (run it again
  with the new files when the BNetzA or Destatis publish a new edition; the script says where to get them).
  `numberRequest.areas` searches it by name ("Heidelberg"), by area code ("06221", "+49 6221") and by municipality:
  each of the 10,751 municipalities of the Destatis Gemeindeverzeichnis is mapped to the Ortsnetz its centre lies in
  (point in polygon on the BNetzA's ONB-Grenzen), so "Dossenheim" finds Heidelberg 06221 with `place: 'Dossenheim'`.
- **Suggestion from the address.** `numberRequest.areas` answers `suggested`: the areas of the address given (city,
  postal code), else of the saved profile's address. Best first: the municipality matching city and postcode, then by
  city ("Heidelberg-Handschuhsheim" matches Heidelberg), then by postcode, then an Ortsnetz named like the city.
  Limits: the postcode in the data is the one of each municipality's town hall (Destatis has one per municipality, and
  there is no open postcode → Ortsnetz list), so another postcode of a large city is matched by its city name only; a
  municipality that spans several Ortsnetze is suggested only the Ortsnetz of its centre (Germany's Ortsnetze follow
  the old exchange areas, not municipal borders). That is why it is a suggestion: any Ortsnetz can be requested, and
  an address outside the area is only flagged.
- **The UK and Ireland** keep their listed cities (`NUMBER_COUNTRIES`), searched by name or area code.
- **Who is held to the list.** A workspace on Linedesk Cloud's carrier account requests an area of the list (in
  Germany that is every Ortsnetz, narrowed by the carrier blocks rule below). A server admin and a workspace on its
  own carrier account are never held to the list: any area code goes, and the carrier's search says whether it has
  numbers there. Otherwise a request is refused only for the carrier's reasons: `number_request_no_numbers` when the
  carrier has no free number in that area right now.
- **Rules that only Linedesk Cloud needs are instance settings**, never code paths for one install: the carrier blocks
  rule below, the fee waiver (a billing rule), the countries a server opens (`NUMBER_KYC_COUNTRIES`).

### Only where the carrier holds number blocks (Germany, Linedesk Cloud)

BNetzA Mitteilung 90/2026 (17.06.2026) forbids chains of third parties in derived number assignment: a number may be
passed on to a business only by the carrier the Bundesnetzagentur assigned its number block to. Linedesk Cloud's
carrier for German numbers is Telnyx Ireland Ltd (DREG 17/109, porting ID D451). It holds blocks of its own in about a
hundred of the 5,200 Ortsnetze (103 blocks in 99 Ortsnetze in the list of 06.11.2026; Heidelberg 06221 7234000 to
7234999 is one). In the other Ortsnetze Telnyx is itself a third party of another carrier, so Linedesk passing such a
number on is likely not allowed. Research and open legal points: `reports/tkg-prep/05-telnyx-relationship-and-registration.md`
(outside this repo). Until Telnyx or the BNetzA confirms otherwise:

- **The rule.** With the instance setting on (`numberBlocks.set`, Server admin › System › German numbers; key
  `number_carrier_blocks` in `instance_settings`), a German number on the install's carrier account is offered only
  in an Ortsnetz where D451 holds a block, and only a number inside one of those blocks is ordered: the carrier's
  search (`withRequirements`, 50 results) is checked against the block list and the numbers outside it are dropped
  (logged), never trusted alone. No number inside a block: `number_request_no_numbers`.
- **Default.** On when the install's carrier is Telnyx and no admin chose (`byDefault`); off with any other carrier.
  An instance admin turns it off for an install with a number licence or carrier contract of its own (a self-hosted
  install). While it is on nobody is exempt, a server admin neither: the admin's control is the setting.
- **Never applied** to a workspace on its own carrier account (its carrier holds or contracts its numbers), nor to
  the UK and Ireland (the BNetzA list is German).
- **The full list stays.** Every Ortsnetz and municipality is still found by `numberRequest.areas` (by name, place,
  postcode or the address), marked `available: false` where there are no blocks, so the app can say calmly "there is
  no local number available for your area yet" (`number_request_no_local_numbers` from `create`). The empty search
  lists the available areas, the popular ones first; available areas come first among equal matches.
- **Data.** `DE_CARRIER_BLOCKS` in `apps/api/src/de-areas.data.ts` ("D451\t6221\t7234": the porting ID, the
  Ortsnetz and the first digits of every number of the block), made by `apps/api/scripts/de-areas.ts` from the
  BNetzA's "Verzeichnis der zugeteilten Rufnummernblöcke in Ortsnetzen" (`NVONB.INTERNET.<date>.OZRNB.csv` in
  https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/Telekommunikation/Nummerierung/ONRufnr/NVONB.INTERNET.OZRNB.zip,
  dl-de/by-2-0). Telnyx gets new blocks over time: generate the file again (the BNetzA updates the list regularly) and
  the areas open up with the next release. The porting IDs kept are `CARRIERS` in the script; the one used is
  `CLOUD_CARRIER_PORTING_ID` in `apps/api/src/number-blocks.ts`.

### The business's seat in the number's Ortsnetz

A German local number is for a business with a seat (Sitz or Niederlassung) in that Ortsnetz, and the proof of
address handed to the carrier must show it. So:

- The area suggested from the profile's address is the default (`suggested` of `numberRequest.areas`): the app
  preselects it.
- Linedesk Cloud must not offer other areas without proof of a seat there. The business may still pick another area
  when it has a branch there (the user keeps control), and then the proof of address it uploads must be for that
  branch, in that Ortsnetz. `create` answers `addressOutsideArea: true` when the profile's address does not look like
  it is in the area: the app then asks the business to confirm a branch there and to upload the branch's proof of
  address. The carrier checks the documents and decides; Linedesk never refuses on its own guess (a municipality can
  span several Ortsnetze).

Sources and licences (named in the generated file):

- Bundesnetzagentur, Vorwahlverzeichnis (CSV in the zip on the BNetzA page "Ortsnetzbereiche, -kennzahlen und
  -bereichsgrenzen"): Datenlizenz Deutschland – Namensnennung – Version 2.0 (the BNetzA's copyright note puts its
  `.csv` data under it unless marked otherwise).
- Statistisches Bundesamt (Destatis), Gemeindeverzeichnis (`AuszugGV…QAktuell.xlsx`): municipality names, town hall
  postcodes and centre coordinates; "Vervielfältigung und Verbreitung, auch auszugsweise, mit Quellenangabe gestattet."
- Bundesnetzagentur, ONB-Grenzen (shapefile, same page): "kostenlos zur Nutzung" for the providers of local numbers
  (who must use it to place their customers in an Ortsnetz). Only the Ortsnetz of each municipality's centre is kept,
  no geometry. The BNetzA's general copyright note puts non-CSV content under CC BY-ND 4.0: before the public export
  (open source), confirm with the BNetzA that the derived municipality → Ortsnetz list may be published, or leave that
  list (`DE_GEMEINDEN`) out of the export and generate it at install time.

## Price

A German (UK, Irish) number is priced like a US one (Janik, 2026-11-18: no beta, Germany goes live directly): the
first number of a workspace is the one its plan includes, more numbers are extra numbers (`extraNumberCents`). The
billing rule `regulatedNumberFeeWaived` (Server admin › Billing › rules, "Numbers with documents are free") is off by
default. Turned on, numbers in the KYC countries (by calling code: +49, +44, +353) cost the workspace nothing a month:
they are left out of the extra numbers (`feeNumbers` in `apps/api/src/ledger.ts`), never count as the number a
workspace includes, add nothing to the recharge cap, and a request needs no balance for a first month
(`billingNumberRefusal` with `feeWaived`; the bill must still be active, and the trial's number limit applies); the
operator pays the carrier. `numberRequest.requirements` says `monthlyFeeWaived`, so the app says "included in your
plan" or "no monthly fee". On a workspace's own carrier account Linedesk never charges for the number.

## Before a country goes live

- UI: a "Phone numbers" request form in settings and the onboarding phone step (profile, documents, area search,
  request status), with the texts in every locale.
- A real test purchase in Germany with real documents on the install's Telnyx account, and the Telnyx notification
  set (see Webhook).
- The privacy page (linedesk.ai/privacy): the documents, their purpose, Telnyx as the processor that receives them.
- Billing stays in USD (decision of 2026-11-18); the price of a German number at Telnyx differs from a US one. Priced
  like a US number (the included number, then `extraNumberCents`); `regulatedNumberFeeWaived` is off by default.

Open legal and tax points (a telecom lawyer and a tax advisor before go-live):

- Germany: whether Linedesk has to notify the Bundesnetzagentur as a telecom service provider (TKG §5), the rules for
  passing numbers on to end users (Nummernzuteilung, local presence for geographic numbers), the BNetzA form.
- UK: Ofcom's General Conditions for sub-allocated numbers (B1), the Telnyx use-case disclosure.
- Ireland: ComReg's numbering conditions for geographic numbers (local presence).
- VAT: electronic and telecom services to EU businesses and consumers (reverse charge, OSS for consumers), UK VAT.
- GDPR: storing ID documents (data minimisation, how long they are kept, deleting them once a request is decided).
