// The `dev` carrier's numbers that need documents: an in-memory stand-in for Telnyx's requirement groups and number
// orders, so the whole number request flow runs in tests and local development without a carrier or money.
// Nothing leaves the process. The carrier's review is decided by `decideDevReview` (tests) or by
// LINEDESK_DEV_KYC_OUTCOME (`approved` or `declined`; unset: stays under review), read when a group or order is read.
import type {
  NumberOrder,
  NumberRequirement,
  RegulatedNumberType,
  RegulatoryEvent,
  RegulatoryNumbers,
  RequirementGroup,
} from './provider.ts'

/** What Telnyx asks for local numbers in these countries (its names, shortened); other countries ask for nothing. */
const REQUIREMENTS: Record<string, readonly Omit<NumberRequirement, 'id'>[]> = {
  DE: [
    { name: 'Contact name', kind: 'textual' },
    { name: 'Business name', kind: 'textual' },
    { name: 'Contact phone number', kind: 'textual' },
    { name: 'Company registration number', kind: 'textual' },
    { name: 'Address in the area code region', kind: 'address' },
    { name: 'Proof of address with evidence of local activity', kind: 'document' },
    { name: 'German ID, passport or company registration certificate', kind: 'document' },
    { name: 'BNetzA registration form', kind: 'document' },
  ],
  GB: [
    { name: 'Company website', kind: 'textual' },
    { name: 'Contact name', kind: 'textual' },
    { name: 'Contact email', kind: 'textual' },
    { name: 'Use case description (disclose sub-allocation)', kind: 'textual' },
    { name: 'Address', kind: 'address' },
    { name: 'ID or business registration', kind: 'document' },
    { name: 'Proof of address (recent utility bill)', kind: 'document' },
  ],
  IE: [
    { name: 'End user name', kind: 'textual' },
    { name: 'End user type', kind: 'textual' },
    { name: 'Usage description', kind: 'textual' },
    { name: 'Contact email', kind: 'textual' },
    { name: 'Address in the area code region', kind: 'address' },
    { name: 'ID or business registration', kind: 'document' },
    { name: 'Proof of address', kind: 'document' },
  ],
}

type Review = { status: 'pending' | 'approved' | 'declined'; reason?: string }
type Order = { e164: string; groupRef: string; cancelled: boolean; customerReference: string }

const groups = new Map<string, { review: Review; customerReference: string; values: number }>()
const orders = new Map<string, Order>()
const uploads = new Map<string, number>()
let next = 0
const newRef = (prefix: string) => `${prefix}_${++next}`

/** The review as decided by a test, else LINEDESK_DEV_KYC_OUTCOME, else still pending. */
function reviewOf(groupRef: string): Review {
  const stored = groups.get(groupRef)?.review
  if (stored && stored.status !== 'pending') return stored
  const outcome = process.env.LINEDESK_DEV_KYC_OUTCOME
  if (outcome === 'approved') return { status: 'approved' }
  if (outcome === 'declined') return { status: 'declined', reason: 'Declined by LINEDESK_DEV_KYC_OUTCOME' }
  return { status: 'pending' }
}

/** Decides the carrier's review of a requirement group (by its ref or by the order that uses it). Tests only. */
export function decideDevReview(ref: string, decision: 'approved' | 'declined', reason?: string) {
  const groupRef = orders.get(ref)?.groupRef ?? ref
  const group = groups.get(groupRef)
  if (!group) throw new Error(`dev: no requirement group or order ${ref}`)
  group.review = { status: decision, ...(reason ? { reason } : {}) }
}

/** How many documents were "uploaded" to the dev carrier (tests check nothing else leaves the database). */
export const devUploadCount = () => uploads.size

function group(ref: string): RequirementGroup {
  const review = reviewOf(ref)
  if (review.status === 'approved') return { ref, status: 'approved' }
  if (review.status === 'declined')
    return { ref, status: 'declined', ...(review.reason ? { reason: review.reason } : {}) }
  return { ref, status: 'pending_approval' }
}

function order(ref: string): NumberOrder {
  const o = orders.get(ref)
  if (!o) throw new Error(`dev: no number order ${ref}`)
  if (o.cancelled) return { ref, status: 'cancelled', e164: o.e164, requirementsMet: false }
  const review = reviewOf(o.groupRef)
  if (review.status === 'approved')
    return {
      ref,
      status: 'success',
      e164: o.e164,
      requirementsMet: true,
      number: { e164: o.e164, providerRef: `dev_${o.e164}` },
    }
  if (review.status === 'declined')
    return {
      ref,
      status: 'failure',
      e164: o.e164,
      requirementsMet: false,
      ...(review.reason ? { reason: review.reason } : {}),
    }
  return { ref, status: 'pending', e164: o.e164, requirementsMet: false }
}

export const devRegulatory: RegulatoryNumbers = {
  async numberRequirements(country: string, type: RegulatedNumberType) {
    if (type !== 'local') return []
    return (REQUIREMENTS[country] ?? []).map((r, i) => ({ id: `dev_req_${country}_${i}`, ...r }))
  },
  async createAddress() {
    return newRef('dev_address')
  },
  async uploadDocument(file) {
    const ref = newRef('dev_document')
    uploads.set(ref, file.content.byteLength)
    return ref
  },
  async submitRequirementGroup({ customerReference, values }) {
    const ref = newRef('dev_group')
    groups.set(ref, { review: { status: 'pending' }, customerReference, values: values.length })
    return group(ref)
  },
  async getRequirementGroup(ref) {
    if (!groups.has(ref)) throw new Error(`dev: no requirement group ${ref}`)
    return group(ref)
  },
  async orderNumber({ e164, requirementGroupRef, customerReference }) {
    const ref = newRef('dev_order')
    orders.set(ref, { e164, groupRef: requirementGroupRef, cancelled: false, customerReference })
    return order(ref)
  },
  async getNumberOrder(ref) {
    return order(ref)
  },
  async cancelNumberOrder(ref) {
    const o = orders.get(ref)
    if (!o) throw new Error(`dev: no number order ${ref}`)
    if (order(ref).status === 'pending') o.cancelled = true
    return order(ref)
  },
  // `dev` signs nothing: the API reads the order or group again and never trusts the body.
  parseRegulatoryWebhook({ rawBody }): RegulatoryEvent | null {
    const event = JSON.parse(rawBody) as Partial<RegulatoryEvent>
    if (event.kind !== 'number_order' && event.kind !== 'requirement_group') return null
    return {
      id: String(event.id ?? 'dev_event'),
      kind: event.kind,
      providerEventType: String(event.providerEventType ?? `dev.${event.kind}`),
      ...(event.ref ? { ref: String(event.ref) } : {}),
      ...(event.customerReference ? { customerReference: String(event.customerReference) } : {}),
    }
  },
}
