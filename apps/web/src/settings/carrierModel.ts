// The Carrier form without React: what it sends to carrier.set and what it says is missing.
import type { CarrierStatusData, WorkspaceCarrier } from '@linedesk/actions'

export type TwilioAuth = 'api_key' | 'auth_token'
export type CarrierDraft = {
  carrier: WorkspaceCarrier
  twilioAuth: TwilioAuth
  values: Record<string, string>
}

export const carrierLabel: Record<WorkspaceCarrier, string> = {
  default: 'Linedesk default',
  twilio: 'Your own Twilio',
  telnyx: 'Your own Telnyx',
}

/** The form as it opens: the saved carrier, the account SID filled in, secrets empty (they never come back). */
export function initialDraft(status: CarrierStatusData): CarrierDraft {
  const savedValue = (field: string) => status.fields.find(f => f.field === field)?.value ?? ''
  const usesToken = status.fields.some(f => f.field === 'auth_token' && f.set)
  return {
    carrier: status.carrier,
    twilioAuth: usesToken ? 'auth_token' : 'api_key',
    values: { account_sid: savedValue('account_sid'), api_key_sid: savedValue('api_key_sid') },
  }
}

/** The fields the form shows for a draft, in order. */
export function visibleFields(draft: CarrierDraft): string[] {
  if (draft.carrier === 'telnyx') return ['api_key']
  if (draft.carrier === 'twilio')
    return draft.twilioAuth === 'api_key'
      ? ['account_sid', 'api_key_sid', 'api_key_secret']
      : ['account_sid', 'auth_token']
  return []
}

/** Whether the draft says something other than what is saved: then Save, else Test connection. */
export function isChanged(draft: CarrierDraft, status: CarrierStatusData): boolean {
  if (draft.carrier !== status.carrier) return true
  const initial = initialDraft(status)
  return (
    draft.twilioAuth !== initial.twilioAuth ||
    visibleFields(draft).some(field => (draft.values[field] ?? '').trim() !== (initial.values[field] ?? ''))
  )
}

const SID = { account_sid: /^AC[0-9a-fA-F]{32}$/, api_key_sid: /^SK[0-9a-fA-F]{32}$/ } as Record<string, RegExp>

/** Per field what is wrong with it, before anything is sent. Credentials are always given as a whole. */
export function draftErrors(draft: CarrierDraft): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of visibleFields(draft)) {
    const value = (draft.values[field] ?? '').trim()
    if (!value) errors[field] = 'Required'
    else if (SID[field] && !SID[field]!.test(value))
      errors[field] = `Starts with ${field === 'account_sid' ? 'AC' : 'SK'} and 32 letters and digits`
  }
  return errors
}

/** The input of carrier.set for a draft. */
export function carrierInput(draft: CarrierDraft) {
  if (draft.carrier === 'default') return { carrier: 'default' as const }
  const values = Object.fromEntries(visibleFields(draft).map(field => [field, (draft.values[field] ?? '').trim()]))
  return { carrier: draft.carrier, values }
}

/** One line for the Phone numbers section: which account the numbers use. */
export function carrierSummary(status: CarrierStatusData): string {
  if (status.carrier === 'default') return carrierLabel.default
  const sid = status.fields.find(f => f.field === 'account_sid')?.value
  return sid ? `${carrierLabel[status.carrier]} · ${sid.slice(0, 6)}…${sid.slice(-4)}` : carrierLabel[status.carrier]
}
