import {
  type AppId,
  AppError,
  type FinishedCall,
  type PushProgress,
  type PushResult,
  type TokenSource,
} from './types.ts'

/** The caller fields Linedesk keeps in a CRM. null = empty in the CRM. */
export type CrmFields = {
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  company: string | null
}

export type CrmContact = { id: string } & CrmFields

/**
 * A CRM as the push sees it. An adapter maps these calls to its API; the flow (find, fill, log)
 * is the same for every CRM (pushCallToCrm).
 */
export interface CrmProvider {
  readonly app: AppId
  /** null when the record is gone (deleted or merged away). */
  getContact(token: TokenSource, id: string): Promise<CrmContact | null>
  findContactByPhone(token: TokenSource, e164: string): Promise<CrmContact | null>
  findContactByEmail(token: TokenSource, email: string): Promise<CrmContact | null>
  createContact(token: TokenSource, fields: Partial<CrmFields>): Promise<CrmContact>
  fillContact(token: TokenSource, id: string, fields: Partial<CrmFields>): Promise<void>
  logCall(token: TokenSource, contactId: string, call: FinishedCall): Promise<string>
}

/** "Mike Brennan" → Mike / Brennan; one word is a first name. */
export function splitName(name: string | null): { firstName: string | null; lastName: string | null } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: null, lastName: null }
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1)! }
}

const blank = (value: string | null | undefined) => !value || !value.trim()

/** A number a CRM can match: withheld or unknown caller IDs ("anonymous") are not. */
export const isE164 = (value: string | null | undefined): value is string => !!value && /^\+[1-9]\d{6,14}$/.test(value)

/** What Linedesk knows about the caller, as CRM fields. */
export function callerFields(call: FinishedCall): Partial<CrmFields> {
  const fields: Partial<CrmFields> = {
    phone: isE164(call.caller.phone) ? call.caller.phone : null,
    ...splitName(call.caller.name),
  }
  if (!blank(call.caller.email)) fields.email = call.caller.email!.trim()
  if (!blank(call.caller.company)) fields.company = call.caller.company!.trim()
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => !blank(v))) as Partial<CrmFields>
}

/**
 * The fields to write: only those empty in the CRM, never an overwrite. The name counts as one
 * field, so a CRM "Mike" never becomes "Mike Brennan" by a last name from a different spelling.
 */
export function fillOnly(existing: CrmFields, known: Partial<CrmFields>): Partial<CrmFields> {
  const patch: Partial<CrmFields> = {}
  if (blank(existing.firstName) && blank(existing.lastName)) {
    if (known.firstName) patch.firstName = known.firstName
    if (known.lastName) patch.lastName = known.lastName
  }
  if (blank(existing.email) && known.email) patch.email = known.email
  if (blank(existing.phone) && known.phone) patch.phone = known.phone
  if (blank(existing.company) && known.company) patch.company = known.company
  return patch
}

/**
 * The phase-1 push: find the caller's record (the stored link, then phone, then email), else create it;
 * fill empty fields; log the call on it. Returns the record id to store as the link. `progress` hears of the
 * record as soon as it is known, and of the logged call, so a retry neither creates nor logs twice.
 */
export async function pushCallToCrm(
  crm: CrmProvider,
  token: TokenSource,
  call: FinishedCall,
  progress: PushProgress = {},
): Promise<PushResult> {
  const known = callerFields(call)
  let contact = call.linkedRecordId ? await crm.getContact(token, call.linkedRecordId) : null
  if (!contact && isE164(call.callerNumber)) contact = await crm.findContactByPhone(token, call.callerNumber)
  if (!contact && known.email) contact = await crm.findContactByEmail(token, known.email)
  if (!contact) {
    if (!known.phone && !known.email)
      throw new AppError(crm.app, 'invalid', 'the caller has no number or email to find or create a contact')
    contact = await crm.createContact(token, known)
    await progress.onRecord?.(contact.id)
  } else {
    await progress.onRecord?.(contact.id)
    const patch = fillOnly(contact, known)
    if (Object.keys(patch).length > 0) await crm.fillContact(token, contact.id, patch)
  }
  const activityId = await crm.logCall(token, contact.id, call)
  await progress.onLogged?.(activityId)
  return { recordId: contact.id, activityId }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The call note as simple HTML: summary, next steps, link to the call in Linedesk. */
export function callNoteHtml(call: FinishedCall): string {
  const parts: string[] = []
  if (call.summary.trim()) parts.push(`<p>${escapeHtml(call.summary.trim()).replace(/\n/g, '<br>')}</p>`)
  const steps = call.nextSteps.map(s => s.trim()).filter(Boolean)
  if (steps.length > 0) {
    parts.push(`<p><strong>${escapeHtml(call.labels.nextSteps)}</strong></p>`)
    parts.push(`<ul>${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`)
  }
  parts.push(`<p><a href="${escapeHtml(call.callUrl)}">${escapeHtml(call.labels.openCall)}</a></p>`)
  return parts.join('')
}
