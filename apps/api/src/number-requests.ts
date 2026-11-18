// Numbers in countries whose carrier asks for documents first (KYC; docs/numbers-kyc.md). The workspace keeps a
// regulatory profile and documents (encrypted, never handed back); a number request hands both to the carrier as a
// requirement group, orders a number with it and waits for the carrier's review:
//   requested → submitted → pending_review → approved → active   (or rejected, with the carrier's reason; or cancelled)
// An approved number that cannot be set up (in use elsewhere, the workspace or its bill stopped, routing failed, not
// on the account) is parked as `needs_operator` with an ALERT: not open, so it does not hold the workspace up.
// The carrier tells the result by webhook (registerNumberRequestWebhookRoute, install account) or when asked
// (numberRequest.refresh); either way the order is read again from the carrier, never taken from a webhook body. An
// approved order puts the number on the account (paid from then on) and it is set up like a bought number.
//
// Off by default: NUMBER_KYC_COUNTRIES (comma-separated, `DE,GB,IE`) opens countries one by one; empty or unset, every
// action but numberRequest.countries refuses and nothing changes for anyone.
import { createHash } from 'node:crypto'
import {
  cityMatches,
  isKycCountry,
  type KycCountry,
  NUMBER_COUNTRIES,
  type NumberRequestStatus,
  type NumberRequestSummary,
  type NumberRequirementsData,
  numberCity,
  OPEN_NUMBER_REQUEST_STATUSES,
  parseKycCountries,
  REGULATORY_DOCUMENT_MAX_BYTES,
  REGULATORY_DOCUMENTS_PER_WORKSPACE,
  type RegulatoryDocumentKind,
  type RegulatoryDocumentSummary,
  type RegulatoryField,
  type RegulatoryProfileData,
  type RegulatoryProfileInput,
  requirementSource,
} from '@linedesk/actions'
import {
  number_requests,
  organization,
  phone_numbers,
  regulatory_documents,
  regulatory_profiles,
  type Tx,
} from '@linedesk/db'
import { type NumberOrder, type OwnedNumber, TelephonyError, type TelephonyProvider } from '@linedesk/telephony'
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { assistantIn } from './assistants.ts'
import { billingNumberRefusal, billOfWorkspaceForNumbers } from './billing-checkout.ts'
import { payBoughtNumberMonth } from './billing-periods.ts'
import { applyCountryDefaults } from './country-defaults.ts'
import { db } from './db.ts'
import { type Handler, Reject } from './handler-context.ts'
import {
  INSTALL_NUMBERS_PER_WORKSPACE,
  installPurchaseRefusal,
  logPurchase,
  purchaseIdOfRequest,
} from './number-purchases.ts'
import { requestInboundTrunkSync } from './inbound-trunk.ts'
import { notifyNumberRequestChange } from './number-request-notices.ts'
import { syncInstallDestinations } from './outbound-policy.ts'
import { telephonyProvider } from './provider-settings.ts'
import { decryptSecret, encryptSecret } from './secrets.ts'
import { refusePendingPayment } from './self-serve.ts'
import { recordSetupEvent } from './setup-events.ts'
import { switchOffLoopingTransfers } from './transfer-loops.ts'
import { type CarrierAccount, telephonyForWorkspace, tryLockWorkspaceCarrier } from './workspace-carrier.ts'

type Env = Record<string, string | undefined>

/** The countries open for number requests on this server (NUMBER_KYC_COUNTRIES); none by default. */
export const kycCountries = (env: Env = process.env): KycCountry[] => parseKycCountries(env.NUMBER_KYC_COUNTRIES)

/** Open requests one workspace may have at once (a request ends in a number on the operator's account). */
export const OPEN_REQUESTS_PER_WORKSPACE = INSTALL_NUMBERS_PER_WORKSPACE

/** The slot a document is encrypted under: a ciphertext moved to another row does not decrypt. */
export const documentSlot = (documentId: string) => `regulatory_document:${documentId}`

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** Rejection codes the app words itself (with the key's text as the fallback). */
export const NUMBER_REQUEST_CODES = {
  countryClosed: 'number_request_country_closed',
  incomplete: 'number_request_incomplete',
  unsupported: 'number_request_unsupported',
} as const

function openCountry(country: string, env: Env = process.env): KycCountry {
  if (!isKycCountry(country) || !kycCountries(env).includes(country))
    throw Reject.t('server.api.numberRequest.countryClosed', { country }, NUMBER_REQUEST_CODES.countryClosed)
  return country
}

function workspaceOf(actor: { workspaceId?: string | null }): string {
  if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
  return actor.workspaceId
}

/**
 * A carrier request of the number request flow: a refusal is logged with the carrier's words (never the key) and told
 * in the app's own words, so the operator's account details stay in the log.
 */
async function atCarrier<T>(what: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (e) {
    if (!(e instanceof TelephonyError)) throw e
    console.error(`number request: carrier refused step ${what}: ${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`)
    throw Reject.t('server.api.numberRequest.carrierRefused')
  }
}

// --- Profile and documents --------------------------------------------------------------------------------------

async function profileOf(tx: Tx, workspaceId: string): Promise<RegulatoryProfileInput | null> {
  const [row] = await tx.select().from(regulatory_profiles).where(eq(regulatory_profiles.workspace_id, workspaceId))
  if (!row) return null
  return {
    legal_name: row.legal_name,
    entity_type: row.entity_type,
    ...(row.registration_number ? { registration_number: row.registration_number } : {}),
    ...(row.website ? { website: row.website } : {}),
    ...(row.use_case ? { use_case: row.use_case } : {}),
    address: row.address,
    contact: row.contact,
  }
}

/** The workspace's documents by name, newest first; never their contents. */
async function documentsOf(tx: Tx, workspaceId: string): Promise<RegulatoryDocumentSummary[]> {
  const rows = await tx
    .select({
      id: regulatory_documents.id,
      kind: regulatory_documents.kind,
      filename: regulatory_documents.filename,
      contentType: regulatory_documents.content_type,
      size: regulatory_documents.size,
      createdAt: regulatory_documents.created_at,
    })
    .from(regulatory_documents)
    .where(eq(regulatory_documents.workspace_id, workspaceId))
    .orderBy(desc(regulatory_documents.created_at), desc(regulatory_documents.id))
  return rows
}

/** What the country needs that the profile and documents do not have yet. */
export function missingFor(
  country: KycCountry,
  profile: RegulatoryProfileInput | null,
  documents: { kind: RegulatoryDocumentKind }[],
): NumberRequirementsData['missing'] {
  const config = NUMBER_COUNTRIES[country]
  const fields = config.fields.filter((field: RegulatoryField) => {
    if (!profile) return true
    if (field === 'address' || field === 'contact' || field === 'legal_name' || field === 'entity_type') return false
    return !profile[field]
  })
  const documentKinds = config.documents.filter(kind => !documents.some(d => d.kind === kind))
  return { fields: [...fields], documents: [...documentKinds] }
}

/** The file's first bytes say what it is: a file named .pdf that is not a PDF is refused. */
function looksLike(contentType: string, bytes: Buffer): boolean {
  if (contentType === 'application/pdf') return bytes.subarray(0, 5).toString('latin1') === '%PDF-'
  if (contentType === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return false
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// --- Requests ---------------------------------------------------------------------------------------------------

type NumberRequestRow = typeof number_requests.$inferSelect

export const summaryOf = (row: NumberRequestRow): NumberRequestSummary => ({
  id: row.id,
  country: row.country as KycCountry,
  prefix: row.prefix,
  city: row.city,
  status: row.status,
  reason: row.reason,
  e164: row.e164,
  phoneNumberId: row.phone_number_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const isOpen = (status: NumberRequestStatus) => OPEN_NUMBER_REQUEST_STATUSES.includes(status)

/**
 * Statuses read again from the carrier: the open ones, and `needs_operator` (the number is on the account; a refresh
 * sets it up once what stopped it is fixed). Their numbers are taken: no other request is given them.
 */
const REFRESHABLE_STATUSES: readonly NumberRequestStatus[] = [...OPEN_NUMBER_REQUEST_STATUSES, 'needs_operator']
const isRefreshable = (status: NumberRequestStatus) => REFRESHABLE_STATUSES.includes(status)

/** The values of the carrier's requirements, from the profile and documents; uploads documents and the address. */
async function requirementValues(
  provider: TelephonyProvider,
  country: KycCountry,
  requestId: string,
  profile: RegulatoryProfileInput,
  documents: (typeof regulatory_documents.$inferSelect)[],
) {
  const regulatory = provider.regulatory!
  const requirements = await atCarrier('requirements', () => regulatory.numberRequirements(country, 'local'))
  const sources = requirements.map(requirement => ({ requirement, source: requirementSource(requirement) }))
  const unknown = sources.filter(s => !s.source).map(s => s.requirement.name)
  if (unknown.length) {
    // The carrier asks for something no field or document kind stands for: the operator extends the mapping.
    console.error(
      `ALERT number request ${requestId}: the carrier's requirements for ${country} local numbers include ${unknown.join('; ')}, which Linedesk has no value for (packages/actions/src/number-countries.ts requirementSource)`,
    )
    throw Reject.t('server.api.numberRequest.unsupportedRequirement', undefined, NUMBER_REQUEST_CODES.unsupported)
  }
  const missing: string[] = []
  const values: { requirementId: string; value: string }[] = []
  let addressRef: string | undefined
  const uploaded = new Map<string, string>()
  for (const { requirement, source } of sources) {
    if (!source) continue
    let value: string | undefined
    if ('address' in source) {
      addressRef ??= await atCarrier('address', () =>
        regulatory.createAddress({
          businessName: profile.legal_name,
          firstName: profile.contact.first_name,
          lastName: profile.contact.last_name,
          street: profile.address.street,
          extendedAddress: profile.address.extended,
          locality: profile.address.city,
          administrativeArea: profile.address.region,
          postalCode: profile.address.postal_code,
          countryCode: profile.address.country,
          phoneNumber: profile.contact.phone,
          customerReference: requestId,
        }),
      )
      value = addressRef
    } else if ('document' in source) {
      // The newest document of the kind (documents are sorted newest first).
      const document = documents.find(d => d.kind === source.document)
      if (document) {
        let ref = uploaded.get(document.id)
        if (!ref) {
          const content = Buffer.from(decryptSecret(document.content_encrypted, documentSlot(document.id)), 'base64')
          ref = await atCarrier('document', () =>
            regulatory.uploadDocument({
              filename: document.filename,
              contentType: document.content_type,
              content,
              customerReference: requestId,
            }),
          )
          uploaded.set(document.id, ref)
        }
        value = ref
      }
    } else if (source.field === 'contact') {
      const c = profile.contact
      value = source.part === 'email' ? c.email : source.part === 'phone' ? c.phone : `${c.first_name} ${c.last_name}`
    } else {
      value = profile[source.field]
    }
    if (value) values.push({ requirementId: requirement.id, value })
    else missing.push('document' in source ? source.document : 'field' in source ? source.field : 'address')
  }
  if (missing.length)
    throw Reject.t(
      'server.api.numberRequest.incomplete',
      { missing: [...new Set(missing)].join(', ') },
      NUMBER_REQUEST_CODES.incomplete,
    )
  return values
}

/** A free number in the city: one no workspace has set up and no open request is waiting for. */
async function freeNumber(tx: Tx, provider: TelephonyProvider, country: KycCountry, prefix: string) {
  const found = await atCarrier('searching numbers', () =>
    provider.searchNumbers({ country, areaCode: prefix, limit: 5, withRequirements: true }),
  )
  if (!found.length) return undefined
  const candidates = found.map(n => n.e164)
  const taken = await tx
    .select({ e164: phone_numbers.e164 })
    .from(phone_numbers)
    .where(inArray(phone_numbers.e164, candidates))
  const waiting = await tx
    .select({ e164: number_requests.e164 })
    .from(number_requests)
    .where(and(inArray(number_requests.e164, candidates), inArray(number_requests.status, [...REFRESHABLE_STATUSES])))
  const used = new Set([...taken, ...waiting].map(r => r.e164))
  return candidates.find(e164 => !used.has(e164))
}

/** The carrier a request's number is in: the account it was made in, never another. */
async function carrierOf(
  tx: Tx,
  request: NumberRequestRow,
  override?: TelephonyProvider,
): Promise<TelephonyProvider | null> {
  if (override) return override
  if (request.carrier_account === 'install') return telephonyProvider(tx)
  const resolved = await telephonyForWorkspace(tx, request.workspace_id)
  return resolved.account === 'workspace' ? resolved.provider : null
}

/** `activated`: the number was set up just now, in this carrier account (work to do once it commits: afterActivation). */
type Refreshed = { row: NumberRequestRow; activated: CarrierAccount | null }

/**
 * After a number was set up and that committed: LiveKit's inbound trunk takes calls to it (inbound-trunk.ts), and an
 * install-account number may widen the install's carrier profiles (outbound-policy.ts). Both log and never throw.
 */
async function afterActivation(account: CarrierAccount | null) {
  if (!account) return
  if (account === 'install') await syncInstallDestinations().catch(() => {})
  await requestInboundTrunkSync()
}

/**
 * Parks an approved request the app cannot set up: the number is on the carrier account (paid) but routed nowhere.
 * Not open any more (the workspace is not held up by it); the ALERT tells the operator to set it up or release it. A
 * refresh tries again (numberRequest.refresh), so a workspace whose bill was only late gets its number then.
 */
async function park(
  tx: Tx,
  request: NumberRequestRow,
  now: string,
  /** Why, as a code (docs/numbers-kyc.md, `needs_operator`). */
  reason: string,
  e164: string,
  /** The carrier's or the router's words, for the log. */
  error?: string,
): Promise<Refreshed> {
  console.error(
    `ALERT number request ${request.id} (workspace ${request.workspace_id}, ${request.carrier_account} carrier account): ${e164} was approved but is not set up (${reason}${error ? `: ${error}` : ''}); set it up or release it at the carrier`,
  )
  const [row] = await tx
    .update(number_requests)
    .set({
      status: 'needs_operator',
      reason,
      ...(e164 ? { e164 } : {}),
      decided_at: request.decided_at ?? now,
      updated_at: now,
      checked_at: now,
    })
    .where(eq(number_requests.id, request.id))
    .returning()
  return { row: row!, activated: null }
}

/**
 * Sets an approved number up: routed to the assistant and stored like a bought number. What stops it parks the request
 * (`needs_operator`, ALERT): the number is set up in another workspace, the workspace was disabled or its bill stopped
 * while the carrier decided (days), or routing failed.
 */
async function activate(
  tx: Tx,
  request: NumberRequestRow,
  provider: TelephonyProvider,
  number: OwnedNumber,
  now: string,
): Promise<Refreshed> {
  const [existing] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, number.e164))
  if (existing) {
    if (existing.workspace_id !== request.workspace_id) return park(tx, request, now, 'number_in_use', number.e164)
    const [row] = await tx
      .update(number_requests)
      .set({ status: 'active', phone_number_id: existing.id, reason: null, updated_at: now, checked_at: now })
      .where(eq(number_requests.id, request.id))
      .returning()
    return { row: row!, activated: null }
  }
  // Asked again: days may have passed since the request.
  const [workspace] = await tx
    .select({ disabledAt: organization.disabledAt })
    .from(organization)
    .where(eq(organization.id, request.workspace_id))
  if (!workspace || workspace.disabledAt) return park(tx, request, now, 'workspace_disabled', number.e164)
  if (request.carrier_account === 'install' && (await billOfWorkspaceForNumbers(tx, request.workspace_id))?.blocked)
    return park(tx, request, now, 'bill_inactive', number.e164)
  const sipEndpoint = process.env.LIVEKIT_SIP_ENDPOINT ?? ''
  if (provider.name !== 'dev' && !sipEndpoint) return park(tx, request, now, 'setup_not_configured', number.e164)
  try {
    await provider.routeToSip(number, sipEndpoint)
  } catch (e) {
    return park(tx, request, now, 'routing_failed', number.e164, e instanceof Error ? e.message : String(e))
  }
  const assistant = await assistantIn(tx, request.workspace_id, request.assistant_id).catch(() => null)
  const [phone] = await tx
    .insert(phone_numbers)
    .values({
      id: newId('pn'),
      workspace_id: request.workspace_id,
      e164: number.e164,
      provider: provider.name,
      provider_ref: number.providerRef,
      carrier_account: request.carrier_account,
      assistant_id: assistant?.id ?? null,
      mode: 'new',
      purchased: true,
      verified_at: now,
      created_at: now,
    })
    .returning()
  if (request.carrier_account === 'install') await payBoughtNumberMonth(tx, request.workspace_id, phone!.id, now)
  await recordSetupEvent(tx, request.workspace_id, 'number_connected', now)
  await applyCountryDefaults(tx, request.workspace_id)
  await switchOffLoopingTransfers(tx, request.workspace_id, [number.e164])
  const [row] = await tx
    .update(number_requests)
    .set({
      status: 'active',
      reason: null,
      e164: number.e164,
      phone_number_id: phone!.id,
      decided_at: request.decided_at ?? now,
      updated_at: now,
      checked_at: now,
    })
    .where(eq(number_requests.id, request.id))
    .returning()
  return { row: row!, activated: request.carrier_account }
}

/**
 * Where a request stands, given its order as the carrier has it now, written to the request: the order first (it
 * completes only when the requirement group is approved), then the group (a declined group fails the order).
 * Completed: set up.
 */
async function settle(
  tx: Tx,
  request: NumberRequestRow,
  provider: TelephonyProvider,
  order: NumberOrder,
  now: string,
): Promise<Refreshed> {
  const regulatory = provider.regulatory!
  const reject = async (reason: string) => {
    const [row] = await tx
      .update(number_requests)
      .set({ status: 'rejected', reason, decided_at: now, updated_at: now, checked_at: now })
      .where(eq(number_requests.id, request.id))
      .returning()
    return { row: row!, activated: null }
  }
  if (order.status === 'success') {
    const e164 = order.e164 || request.e164 || ''
    const number = order.number ?? (await provider.findNumber(e164))
    if (!number) return park(tx, request, now, 'not_on_account', e164, `order ${order.ref}`)
    return activate(tx, { ...request, decided_at: request.decided_at ?? now }, provider, number, now)
  }
  if (order.status === 'failure' || order.status === 'cancelled') {
    let reason = order.reason
    if (!reason && request.requirement_group_ref)
      reason = (await regulatory.getRequirementGroup(request.requirement_group_ref).catch(() => null))?.reason
    return reject(reason ?? `order_${order.status}`)
  }
  if (request.requirement_group_ref && request.order_ref) {
    const group = await regulatory.getRequirementGroup(request.requirement_group_ref)
    if (group.status === 'declined' || group.status === 'expired' || group.status === 'no_longer_eligible') {
      // The order would wait for ever: cancelled, so no number lands on the account later.
      const after = await regulatory.cancelNumberOrder(request.order_ref).catch(e => {
        console.error(
          `ALERT number request ${request.id}: cancelling order ${request.order_ref} failed: ${e instanceof Error ? e.message : e}`,
        )
        return null
      })
      // Completed before the cancel reached it: set up after all.
      if (after?.status === 'success') return settle(tx, request, provider, after, now)
      // Not cancelled: stays open, so the next refresh tries again rather than leaving an order nobody watches.
      if (after) return reject(group.reason ?? `requirements_${group.status}`)
    }
  }
  const [row] = await tx
    .update(number_requests)
    .set({ status: 'pending_review', updated_at: now, checked_at: now })
    .where(eq(number_requests.id, request.id))
    .returning()
  return { row: row!, activated: null }
}

/** Where a request stands at the carrier now (open or parked), written to the request; set up once approved. */
export async function refreshRequest(
  tx: Tx,
  request: NumberRequestRow,
  provider: TelephonyProvider,
  now: string,
): Promise<Refreshed> {
  if (!isRefreshable(request.status) || !request.order_ref || !provider.regulatory)
    return { row: request, activated: null }
  const result = await settle(tx, request, provider, await provider.regulatory.getNumberOrder(request.order_ref), now)
  // Live, not approved or parked: the email (or the operator's alert) is queued with this transaction.
  await notifyNumberRequestChange(tx, result.row, request.status)
  return result
}

/** The workspace's request, locked for this transaction (a webhook or a second tab waits for it). */
async function requestIn(tx: Tx, workspaceId: string, requestId: string) {
  const [row] = await tx
    .select()
    .from(number_requests)
    .where(and(eq(number_requests.id, requestId), eq(number_requests.workspace_id, workspaceId)))
    .for('update')
  if (!row) throw Reject.t('server.api.numberRequest.notFound')
  return row
}

// --- Handlers ---------------------------------------------------------------------------------------------------

export const numberRequestHandlers: Record<string, Handler> = {
  'numberRequest.countries': async () => ({ rows: {}, data: { countries: kycCountries() } }),

  'numberRequest.requirements': async ({ tx, actor }, input: { country: string }) => {
    const workspaceId = workspaceOf(actor)
    const country = openCountry(input.country)
    const config = NUMBER_COUNTRIES[country]
    const missing = missingFor(country, await profileOf(tx, workspaceId), await documentsOf(tx, workspaceId))
    const data: NumberRequirementsData = {
      country,
      numberType: 'local',
      fields: config.fields,
      documents: config.documents,
      addressInArea: config.addressInArea,
      cities: config.cities,
      missing,
    }
    return { rows: {}, data }
  },

  'numberRequest.getProfile': async ({ tx, actor }) => {
    const workspaceId = workspaceOf(actor)
    const data: RegulatoryProfileData = {
      profile: await profileOf(tx, workspaceId),
      documents: await documentsOf(tx, workspaceId),
    }
    return { rows: {}, data }
  },

  'numberRequest.saveProfile': async ({ tx, actor, now }, input: RegulatoryProfileInput) => {
    const workspaceId = workspaceOf(actor)
    const set = {
      legal_name: input.legal_name,
      entity_type: input.entity_type,
      registration_number: input.registration_number ?? null,
      website: input.website ?? null,
      use_case: input.use_case ?? null,
      address: input.address,
      contact: input.contact,
      updated_at: now,
      updated_by: actor.actorId,
    }
    await tx
      .insert(regulatory_profiles)
      .values({ workspace_id: workspaceId, ...set })
      .onConflictDoUpdate({ target: regulatory_profiles.workspace_id, set })
    return { rows: {}, data: { profile: await profileOf(tx, workspaceId) } }
  },

  'numberRequest.uploadDocument': async (
    { tx, actor, now },
    input: { kind: RegulatoryDocumentKind; filename: string; contentType: string; content: string },
  ) => {
    const workspaceId = workspaceOf(actor)
    const bytes = Buffer.from(input.content, 'base64')
    if (bytes.byteLength > REGULATORY_DOCUMENT_MAX_BYTES) throw Reject.t('server.api.numberRequest.document.tooLarge')
    if (!looksLike(input.contentType, bytes)) throw Reject.t('server.api.numberRequest.document.wrongType')
    const hash = sha256(bytes)
    // One upload at a time per workspace, so parallel ones cannot all pass the count below.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`regulatory_documents:${workspaceId}`}))`)
    const existing = await tx
      .select({ id: regulatory_documents.id, kind: regulatory_documents.kind, sha256: regulatory_documents.sha256 })
      .from(regulatory_documents)
      .where(eq(regulatory_documents.workspace_id, workspaceId))
    const same = existing.find(d => d.sha256 === hash && d.kind === input.kind)
    if (same) return { rows: {}, data: { documentId: same.id } }
    if (existing.length >= REGULATORY_DOCUMENTS_PER_WORKSPACE)
      throw Reject.t('server.api.numberRequest.document.tooMany', { count: REGULATORY_DOCUMENTS_PER_WORKSPACE })
    const id = newId('rdoc')
    await tx.insert(regulatory_documents).values({
      id,
      workspace_id: workspaceId,
      kind: input.kind,
      filename: input.filename,
      content_type: input.contentType,
      size: bytes.byteLength,
      sha256: hash,
      content_encrypted: encryptSecret(bytes.toString('base64'), documentSlot(id)),
      created_at: now,
      created_by: actor.actorId,
    })
    return { rows: {}, data: { documentId: id } }
  },

  'numberRequest.deleteDocument': async ({ tx, actor }, input: { documentId: string }) => {
    const workspaceId = workspaceOf(actor)
    const deleted = await tx
      .delete(regulatory_documents)
      .where(and(eq(regulatory_documents.id, input.documentId), eq(regulatory_documents.workspace_id, workspaceId)))
      .returning({ id: regulatory_documents.id })
    if (!deleted.length) throw Reject.t('server.api.numberRequest.document.notFound')
    return { rows: {}, data: { documentId: input.documentId } }
  },

  'numberRequest.create': async (
    { tx, actor, now, telephony, onRollback, onCommit },
    input: { country: string; prefix: string; assistantId?: string },
  ) => {
    const workspaceId = workspaceOf(actor)
    const country = openCountry(input.country)
    const city = numberCity(country, input.prefix)
    if (!city) throw Reject.t('server.api.numberRequest.unknownCity', { prefix: input.prefix, country })
    if (actor.workspaceDisabled) throw Reject.t('server.api.workspaceDisabled')
    // No number before Checkout (docs/billing.md §3.1).
    await refusePendingPayment(tx, workspaceId)
    if (!(await tryLockWorkspaceCarrier(tx, workspaceId))) throw Reject.t('server.api.numberRequest.busy')
    let resolved: { provider: TelephonyProvider; account: CarrierAccount }
    try {
      const found = await telephonyForWorkspace(tx, workspaceId)
      resolved = telephony ? { provider: telephony, account: found.account } : found
    } catch (e) {
      console.error(`number request: no carrier for workspace ${workspaceId}: ${e instanceof Error ? e.message : e}`)
      throw Reject.t('server.api.numberRequest.carrierNoDocuments')
    }
    const { provider, account } = resolved
    if (!provider.regulatory) throw Reject.t('server.api.numberRequest.carrierNoDocuments')
    const assistant = await assistantIn(tx, workspaceId, input.assistantId)
    const open = await tx
      .select({ id: number_requests.id })
      .from(number_requests)
      .where(
        and(
          eq(number_requests.workspace_id, workspaceId),
          inArray(number_requests.status, [...OPEN_NUMBER_REQUEST_STATUSES]),
        ),
      )
    if (open.length >= OPEN_REQUESTS_PER_WORKSPACE)
      throw Reject.t('server.api.numberRequest.tooManyOpen', { count: OPEN_REQUESTS_PER_WORKSPACE })
    // On the install's account the operator pays: the same bill and purchase limits as a number bought at once.
    if (account === 'install') {
      const billRefusal = await billingNumberRefusal(tx, actor, workspaceId)
      if (billRefusal) throw new Reject(billRefusal)
      if (provider.name !== 'dev') {
        const refusal = await installPurchaseRefusal(tx, actor, workspaceId, { byNumber: false, now })
        if (refusal) throw new Reject(refusal)
      }
    }
    const profile = await profileOf(tx, workspaceId)
    const documents = await tx
      .select()
      .from(regulatory_documents)
      .where(eq(regulatory_documents.workspace_id, workspaceId))
      .orderBy(desc(regulatory_documents.created_at), desc(regulatory_documents.id))
    const missing = missingFor(country, profile, documents)
    if (!profile || missing.fields.length || missing.documents.length)
      throw Reject.t(
        'server.api.numberRequest.incomplete',
        { missing: [...missing.fields, ...missing.documents].join(', ') },
        NUMBER_REQUEST_CODES.incomplete,
      )

    // Germany and Ireland want the address in the number's area-code region: the carrier decides, a city that does
    // not match is only told (a suburb can be in the region under another name).
    const addressOutsideArea = NUMBER_COUNTRIES[country].addressInArea && !cityMatches(city, profile.address.city)

    const id = newId('nr')
    const e164 = await freeNumber(tx, provider, country, city.prefix)
    if (!e164) throw Reject.t('server.api.numberRequest.noNumber')
    await tx.insert(number_requests).values({
      id,
      workspace_id: workspaceId,
      country,
      number_type: 'local',
      prefix: city.prefix,
      city: city.id,
      assistant_id: assistant?.id ?? null,
      status: 'requested',
      provider: provider.name,
      carrier_account: account,
      e164,
      requested_by: actor.actorId,
      created_at: now,
      updated_at: now,
    })
    const values = await requirementValues(provider, country, id, profile, documents)
    const regulatory = provider.regulatory
    const group = await atCarrier('requirement_group', () =>
      regulatory.submitRequirementGroup({ country, type: 'local', customerReference: id, values }),
    )
    await tx
      .update(number_requests)
      .set({ status: 'submitted', requirement_group_ref: group.ref, submitted_at: now, updated_at: now })
      .where(eq(number_requests.id, id))
    // Counted against the purchase limits before the order, committed on its own (as phoneNumber.setup does).
    // Logged under the request's purchase id: once the request is rejected or cancelled it no longer counts.
    await logPurchase(actor, {
      workspaceId,
      e164,
      provider: provider.name,
      carrierAccount: account,
      id: purchaseIdOfRequest(id),
    })
    const order = await atCarrier('number_order', () =>
      regulatory.orderNumber({ e164, requirementGroupRef: group.ref, customerReference: id }),
    )
    // Not committed: the order is cancelled, so no number lands on the account without a request; one the carrier
    // completed meanwhile is released (unless a workspace has it set up).
    onRollback?.(async () => {
      const after = await regulatory.cancelNumberOrder(order.ref)
      if (after.status !== 'success') return `cancelled number order ${order.ref}`
      const released = await releaseUnclaimed(db, provider, after, `number order ${order.ref} (request ${id})`)
      return `number order ${order.ref}: completed, ${released.e164} ${released.carrier}`
    })
    const [pending] = await tx
      .update(number_requests)
      .set({
        status: 'pending_review',
        order_ref: order.ref,
        e164: order.e164 || e164,
        updated_at: now,
        checked_at: now,
      })
      .where(eq(number_requests.id, id))
      .returning()
    // Approved at once (a group the carrier approved before): set up now.
    const { row, activated } =
      order.status === 'pending'
        ? { row: pending!, activated: null }
        : await refreshRequest(tx, pending!, provider, now)
    if (activated) onCommit?.(() => afterActivation(activated))
    return { rows: {}, data: { request: summaryOf(row), addressOutsideArea } }
  },

  'numberRequest.list': async ({ tx, actor }) => {
    const workspaceId = workspaceOf(actor)
    const rows = await tx
      .select()
      .from(number_requests)
      .where(eq(number_requests.workspace_id, workspaceId))
      .orderBy(desc(number_requests.created_at), desc(number_requests.id))
    return { rows: {}, data: { requests: rows.map(summaryOf) } }
  },

  'numberRequest.refresh': async ({ tx, actor, now, telephony, onCommit }, input: { requestId: string }) => {
    const workspaceId = workspaceOf(actor)
    // A number may be set up: not while another is set up or released for the workspace.
    if (!(await tryLockWorkspaceCarrier(tx, workspaceId))) throw Reject.t('server.api.numberRequest.busy')
    const request = await requestIn(tx, workspaceId, input.requestId)
    if (!isRefreshable(request.status)) return { rows: {}, data: { request: summaryOf(request) } }
    const provider = await carrierOf(tx, request, telephony)
    if (!provider?.regulatory || provider.name !== request.provider)
      throw Reject.t('server.api.numberRequest.carrierNoDocuments')
    const { row, activated } = await atCarrier('refresh', () => refreshRequest(tx, request, provider, now))
    if (activated) onCommit?.(() => afterActivation(activated))
    return { rows: {}, data: { request: summaryOf(row) } }
  },

  'numberRequest.cancel': async ({ tx, actor, now, telephony, onCommit }, input: { requestId: string }) => {
    const workspaceId = workspaceOf(actor)
    if (!(await tryLockWorkspaceCarrier(tx, workspaceId))) throw Reject.t('server.api.numberRequest.busy')
    const request = await requestIn(tx, workspaceId, input.requestId)
    // Approved: the number is on the account already; it is released like any other once it is set up.
    if (!isOpen(request.status) || request.status === 'approved') throw Reject.t('server.api.numberRequest.notOpen')
    if (request.order_ref) {
      const provider = await carrierOf(tx, request, telephony)
      if (!provider?.regulatory || provider.name !== request.provider)
        throw Reject.t('server.api.numberRequest.carrierNoDocuments')
      const regulatory = provider.regulatory
      const after = await atCarrier('cancel', () => regulatory.cancelNumberOrder(request.order_ref!))
      if (after.status === 'success' || after.status === 'failure') {
        // The carrier decided before the cancel reached it: a completed order is on the account (paid), so the number
        // is set up rather than left behind unrouted; a failed one rejects the request. Either way: not cancelled.
        const { row, activated } = await atCarrier('cancel', () => settle(tx, request, provider, after, now))
        await notifyNumberRequestChange(tx, row, request.status)
        if (activated) onCommit?.(() => afterActivation(activated))
        return { rows: {}, data: { request: summaryOf(row), cancelled: false } }
      }
    }
    const [row] = await tx
      .update(number_requests)
      .set({ status: 'cancelled', decided_at: now, updated_at: now })
      .where(eq(number_requests.id, request.id))
      .returning()
    return { rows: {}, data: { request: summaryOf(row!), cancelled: true } }
  },
}

type Released = { carrier: 'released' | 'kept' | 'left'; e164: string; note?: string }

/**
 * Releases a number the carrier put on the account for an order Linedesk no longer has a request for (its action
 * rolled back, its workspace was deleted), unless a workspace has it set up (`kept`). Never throws: what it could not
 * do is an ALERT (`left`).
 */
async function releaseUnclaimed(
  tx: Tx | typeof db,
  provider: TelephonyProvider,
  order: NumberOrder,
  what: string,
): Promise<Released> {
  const e164 = order.e164 || '(unknown number)'
  try {
    const number = order.number ?? (order.e164 ? await provider.findNumber(order.e164) : null)
    if (!number) {
      console.error(`ALERT ${what}: completed, but ${e164} was not found to release; release it at the carrier`)
      return { carrier: 'left', e164, note: 'completed, but not found to release: release it at the carrier' }
    }
    const [inUse] = await tx
      .select({ id: phone_numbers.id })
      .from(phone_numbers)
      .where(eq(phone_numbers.e164, number.e164))
    if (inUse) return { carrier: 'kept', e164: number.e164 }
    await provider.releaseNumber(number)
    return { carrier: 'released', e164: number.e164 }
  } catch (e) {
    console.error(
      `ALERT ${what}: completed, releasing ${e164} failed (${e instanceof Error ? e.message : String(e)}); release it at the carrier`,
    )
    return { carrier: 'left', e164, note: 'completed, releasing failed: release it at the carrier' }
  }
}

// --- Workspace delete -------------------------------------------------------------------------------------------

/** A request of a workspace being deleted whose order may still put a number on an account, with that account. */
export type OrderOfDeletedWorkspace = { request: NumberRequestRow; provider: TelephonyProvider | null }

/**
 * The workspace's requests whose order is still open at the carrier or completed without being set up, with their
 * carrier account: resolved before the workspace's carrier credentials are deleted (workspace-delete.ts).
 */
export async function ordersOfDeletedWorkspace(
  tx: Tx,
  workspaceId: string,
  telephony?: TelephonyProvider,
): Promise<OrderOfDeletedWorkspace[]> {
  const requests = await tx
    .select()
    .from(number_requests)
    .where(
      and(
        eq(number_requests.workspace_id, workspaceId),
        inArray(number_requests.status, [...REFRESHABLE_STATUSES]),
        isNotNull(number_requests.order_ref),
      ),
    )
  const found: OrderOfDeletedWorkspace[] = []
  for (const request of requests)
    found.push({ request, provider: await carrierOf(tx, request, telephony).catch(() => null) })
  return found
}

/**
 * After a workspace's rows are deleted: each open order is cancelled, so no number lands on an account for nobody. A
 * number the carrier already put on the install's account is released (the operator would pay for it); one on the
 * workspace's own account stays the business's. Never throws: what is left at the carrier is listed and alerted.
 */
export async function cancelOrdersOfDeletedWorkspace(
  tx: Tx,
  orders: OrderOfDeletedWorkspace[],
): Promise<{ e164: string; carrier: 'released' | 'left'; note?: string }[]> {
  const results: { e164: string; carrier: 'released' | 'left'; note?: string }[] = []
  for (const { request, provider } of orders) {
    const e164 = request.e164 ?? request.order_ref!
    const what = `number request ${request.id} of deleted workspace ${request.workspace_id} (order ${request.order_ref})`
    if (!provider?.regulatory || provider.name !== request.provider) {
      console.error(
        `ALERT ${what}: its carrier account cannot be reached; cancel the order or release the number there`,
      )
      results.push({
        e164,
        carrier: 'left',
        note: 'number order: the carrier account cannot be reached, cancel it there',
      })
      continue
    }
    let after: NumberOrder
    try {
      after = await provider.regulatory.cancelNumberOrder(request.order_ref!)
    } catch (e) {
      console.error(
        `ALERT ${what}: cancelling failed (${e instanceof Error ? e.message : String(e)}); cancel it at the carrier`,
      )
      results.push({ e164, carrier: 'left', note: 'number order: cancelling failed, cancel it at the carrier' })
      continue
    }
    if (after.status !== 'success') continue
    if (request.carrier_account !== 'install') {
      // i18n-ignore: an instance admin's delete report, English like releaseAtCarrier's notes (workspace-delete.ts)
      results.push({ e164, carrier: 'left', note: "approved number in the workspace's own carrier account" })
      continue
    }
    const released = await releaseUnclaimed(tx, provider, after, what)
    // Kept: set up in another workspace (number_in_use), not this one's to release.
    if (released.carrier !== 'kept')
      results.push({
        e164: released.e164,
        carrier: released.carrier,
        ...(released.note ? { note: released.note } : {}),
      })
  }
  return results
}

// --- Webhook ----------------------------------------------------------------------------------------------------

export const NUMBER_REQUEST_WEBHOOK_PATH = '/v1/telephony/number-requests/webhook'
/** Number order and requirement group events are a few KB. */
const WEBHOOK_MAX_BYTES = 64 * 1024

/**
 * POST NUMBER_REQUEST_WEBHOOK_PATH: Telnyx's number order and requirement group events for the install's account
 * (set it as the webhook URL of the requirement group status notifications and of number orders in the Telnyx
 * portal). Verified with the install's Telnyx public key; the event only says which order or group changed, the
 * request is then read again from the carrier. Answers 200 for any verified event (also one about nothing Linedesk
 * asked for), so the carrier does not retry it; 400 for a bad signature. No session, no cookie.
 */
// biome-ignore lint/suspicious/noExplicitAny: the app's variables are not this route's concern
export function registerNumberRequestWebhookRoute(app: Hono<any>) {
  app.post(
    NUMBER_REQUEST_WEBHOOK_PATH,
    bodyLimit({ maxSize: WEBHOOK_MAX_BYTES, onError: c => c.json({ ok: false, error: 'request too large' }, 413) }),
    async c => {
      // Off: the route does not exist.
      if (!kycCountries().length) return c.json({ ok: false, error: 'not_found' }, 404)
      const provider = await telephonyProvider(db).catch(() => null)
      if (!provider?.regulatory) return c.json({ ok: false, error: 'not_found' }, 404)
      const rawBody = await c.req.text()
      const headers = Object.fromEntries(Object.entries(c.req.header()).map(([k, v]) => [k.toLowerCase(), v]))
      let event: ReturnType<NonNullable<TelephonyProvider['regulatory']>['parseRegulatoryWebhook']>
      try {
        event = provider.regulatory.parseRegulatoryWebhook({ headers, rawBody })
      } catch (e) {
        console.warn(`number request webhook refused: ${e instanceof Error ? e.message : String(e)}`)
        return c.json({ ok: false, error: 'bad signature' }, 400)
      }
      if (!event) return c.json({ ok: true })
      const match = [
        ...(event.customerReference ? [eq(number_requests.id, event.customerReference)] : []),
        ...(event.ref
          ? [
              event.kind === 'number_order'
                ? eq(number_requests.order_ref, event.ref)
                : eq(number_requests.requirement_group_ref, event.ref),
            ]
          : []),
      ]
      if (!match.length) return c.json({ ok: true })
      const now = new Date().toISOString()
      let activated: CarrierAccount | null = null
      try {
        await db.transaction(async tx => {
          const requests = await tx
            .select()
            .from(number_requests)
            .where(
              and(
                or(...match),
                eq(number_requests.carrier_account, 'install'),
                eq(number_requests.provider, provider.name),
                inArray(number_requests.status, [...REFRESHABLE_STATUSES]),
              ),
            )
            .for('update')
          for (const request of requests)
            activated = (await refreshRequest(tx, request, provider, now)).activated ?? activated
        })
      } catch (e) {
        // The carrier retries a delivery that was not answered 2xx.
        console.error(
          `number request webhook ${event.id} (${event.providerEventType}) failed: ${e instanceof Error ? e.message : String(e)}`,
        )
        return c.json({ ok: false, error: 'try again' }, 500)
      }
      await afterActivation(activated)
      return c.json({ ok: true })
    },
  )
}
