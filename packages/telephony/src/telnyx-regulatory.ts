// Telnyx numbers that need documents (KYC): regulatory requirements, addresses, documents, requirement groups and
// number orders that wait for the group's approval. https://developers.telnyx.com/docs/numbers/phone-numbers/number-orders
// The API (apps/api/src/number-requests.ts) is the only caller; docs/numbers-kyc.md has the flow.
import {
  type NumberOrder,
  type NumberOrderStatus,
  type NumberRequirement,
  type OwnedNumber,
  type RegulatoryEvent,
  type RegulatoryNumbers,
  type RequirementGroup,
  type RequirementGroupStatus,
  type RequirementKind,
  TelephonyError,
  type WebhookRequest,
} from './provider.ts'

// biome-ignore lint/suspicious/noExplicitAny: Telnyx JSON, read field by field
type Json = Record<string, any>

export interface TelnyxRegulatoryDeps {
  request: (method: string, path: string, body?: Json) => Promise<Json>
  /** The id of a number on the account (exact match), else undefined. */
  findNumberId: (e164: string) => Promise<string | undefined>
  /** Throws TelephonyError when the webhook is not signed by Telnyx. */
  verifySignature: (headers: WebhookRequest['headers'], rawBody: string) => void
}

const GROUP_STATUSES: readonly RequirementGroupStatus[] = [
  'unapproved',
  'pending_approval',
  'approved',
  'declined',
  'expired',
  'no_longer_eligible',
]
/** Telnyx writes `pending-approval`, `no-longer-eligible`. Anything unknown counts as still under review. */
export function telnyxGroupStatus(status: unknown): RequirementGroupStatus {
  const s = String(status ?? '')
    .toLowerCase()
    .replaceAll('-', '_') as RequirementGroupStatus
  return GROUP_STATUSES.includes(s) ? s : 'pending_approval'
}

/** Telnyx order statuses; `canceled` and `cancelled` both occur. Anything unknown counts as pending. */
export function telnyxOrderStatus(status: unknown): NumberOrderStatus {
  const s = String(status ?? '').toLowerCase()
  if (s === 'success' || s === 'failure') return s
  if (s === 'canceled' || s === 'cancelled') return 'cancelled'
  return 'pending'
}

const KINDS: readonly RequirementKind[] = ['textual', 'address', 'document', 'action']
const kindOf = (fieldType: unknown): RequirementKind => {
  const t = String(fieldType ?? '').toLowerCase()
  if ((KINDS as readonly string[]).includes(t)) return t as RequirementKind
  // Older answers say `string` or `text` for a textual value.
  return 'textual'
}

/** The first reason Telnyx gives for a declined requirement, if any. */
function declineReason(group: Json): string | undefined {
  const rows = (group.regulatory_requirements ?? []) as Json[]
  for (const r of rows) {
    const reason = r.reason ?? r.comments ?? r.status_reason ?? r.rejection_reason
    if (typeof reason === 'string' && reason.trim()) return reason.trim()
  }
  return undefined
}

export function createTelnyxRegulatory({
  request,
  findNumberId,
  verifySignature,
}: TelnyxRegulatoryDeps): RegulatoryNumbers {
  const group = (data: Json): RequirementGroup => {
    const status = telnyxGroupStatus(data.status)
    const reason = status === 'declined' || status === 'expired' ? declineReason(data) : undefined
    return { ref: String(data.id), status, ...(reason ? { reason } : {}) }
  }

  async function order(data: Json): Promise<NumberOrder> {
    const e164 = String(data.phone_numbers?.[0]?.phone_number ?? '')
    const status = telnyxOrderStatus(data.status)
    let number: OwnedNumber | undefined
    if (status === 'success' && e164) {
      const id = await findNumberId(e164)
      if (id) number = { e164, providerRef: id }
    }
    return {
      ref: String(data.id),
      status,
      e164,
      requirementsMet: data.requirements_met === true,
      ...(number ? { number } : {}),
    }
  }

  return {
    async numberRequirements(country, type): Promise<NumberRequirement[]> {
      const query = new URLSearchParams({
        'filter[country_code]': country,
        'filter[phone_number_type]': type,
        'filter[action]': 'ordering',
      })
      const { data } = await request('GET', `/regulatory_requirements?${query}`)
      // Only the row for exactly this country, type and ordering (porting rules differ).
      const rows = ((data ?? []) as Json[]).filter(
        r =>
          (r.country_code ?? country) === country &&
          (r.phone_number_type ?? type) === type &&
          (r.action ?? 'ordering') === 'ordering',
      )
      return rows.flatMap(r =>
        ((r.regulatory_requirements ?? []) as Json[]).map(q => ({
          id: String(q.id),
          name: String(q.name ?? q.field_type ?? ''),
          kind: kindOf(q.field_type ?? q.record_type),
          ...(q.description ? { description: String(q.description) } : {}),
        })),
      )
    },

    async createAddress(address) {
      const { data } = await request('POST', '/addresses', {
        business_name: address.businessName,
        first_name: address.firstName,
        last_name: address.lastName,
        street_address: address.street,
        ...(address.extendedAddress ? { extended_address: address.extendedAddress } : {}),
        locality: address.locality,
        ...(address.administrativeArea ? { administrative_area: address.administrativeArea } : {}),
        postal_code: address.postalCode,
        country_code: address.countryCode,
        ...(address.phoneNumber ? { phone_number: address.phoneNumber } : {}),
        ...(address.customerReference ? { customer_reference: address.customerReference } : {}),
      })
      return String(data.id)
    },

    async uploadDocument(file) {
      // Base64 JSON (Telnyx also takes multipart). A document not linked to a requirement within 30 minutes is
      // deleted by Telnyx, so it is uploaded right before the requirement group is made.
      const { data } = await request('POST', '/documents', {
        file: Buffer.from(file.content).toString('base64'),
        filename: file.filename,
        ...(file.customerReference ? { customer_reference: file.customerReference } : {}),
      })
      return String(data.id)
    },

    async submitRequirementGroup({ country, type, customerReference, values }) {
      const { data: created } = await request('POST', '/requirement_groups', {
        country_code: country,
        phone_number_type: type,
        action: 'ordering',
        customer_reference: customerReference,
        regulatory_requirements: values.map(v => ({ requirement_id: v.requirementId, field_value: v.value })),
      })
      const { data } = await request(
        'POST',
        `/requirement_groups/${encodeURIComponent(String(created.id))}/submit_for_approval`,
      )
      return group({ ...created, ...data })
    },

    async getRequirementGroup(ref) {
      const { data } = await request('GET', `/requirement_groups/${encodeURIComponent(ref)}`)
      return group(data)
    },

    async orderNumber({ e164, requirementGroupRef, customerReference }) {
      const { data } = await request('POST', '/number_orders', {
        phone_numbers: [{ phone_number: e164, requirement_group_id: requirementGroupRef }],
        customer_reference: customerReference,
      })
      if (telnyxOrderStatus(data.status) === 'failure')
        throw new TelephonyError('telnyx', `number order ${data.id} for ${e164} failed`, undefined, 'not_activated')
      return order({ ...data, phone_numbers: data.phone_numbers ?? [{ phone_number: e164 }] })
    },

    async getNumberOrder(ref) {
      const { data } = await request('GET', `/number_orders/${encodeURIComponent(ref)}`)
      return order(data)
    },

    async cancelNumberOrder(ref) {
      const { data } = await request('GET', `/number_orders/${encodeURIComponent(ref)}`)
      // Finished (completed, failed or cancelled before): nothing to cancel, the caller learns what it is.
      if (telnyxOrderStatus(data.status) !== 'pending') return order(data)
      // A sub-order the carrier refuses to cancel throws: the caller does not take the order for cancelled.
      for (const id of ((data.sub_number_orders_ids ?? []) as unknown[]).map(String))
        await request('PATCH', `/sub_number_orders/${encodeURIComponent(id)}/cancel`)
      return { ...(await order(data)), status: 'cancelled', requirementsMet: false }
    },

    parseRegulatoryWebhook({ headers, rawBody }): RegulatoryEvent | null {
      verifySignature(headers, rawBody)
      const { data } = JSON.parse(rawBody) as Json
      const type = typeof data?.event_type === 'string' ? data.event_type : ''
      if (!data?.id || !type) throw new TelephonyError('telnyx', 'webhook body has no event')
      const payload = (data.payload ?? {}) as Json
      const customerReference = typeof payload.customer_reference === 'string' ? payload.customer_reference : undefined
      const base = { id: String(data.id), providerEventType: type, ...(customerReference ? { customerReference } : {}) }
      if (/^number_order\./.test(type))
        return { ...base, kind: 'number_order', ...(payload.id ? { ref: String(payload.id) } : {}) }
      if (/^sub_number_order\./.test(type)) {
        const ref = payload.order_request_id ?? payload.number_order_id
        return { ...base, kind: 'number_order', ...(ref ? { ref: String(ref) } : {}) }
      }
      if (/requirement_group/.test(type))
        return { ...base, kind: 'requirement_group', ...(payload.id ? { ref: String(payload.id) } : {}) }
      return null
    },
  }
}
