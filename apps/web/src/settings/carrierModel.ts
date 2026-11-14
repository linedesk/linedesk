// The Carrier form without React: what it sends to carrier.set and what it says is missing.
import type { CarrierStatusData, WorkspaceCarrier } from '@linedesk/actions'
import { brandName } from '../brand.ts'
import { carrierName } from '../onboarding/flow.ts'

export type TwilioAuth = 'api_key' | 'auth_token'
export type CarrierDraft = {
  carrier: WorkspaceCarrier
  twilioAuth: TwilioAuth
  values: Record<string, string>
}

export const carrierLabel: Record<WorkspaceCarrier, string> = {
  get default() {
    return `${brandName()} default`
  },
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
    values: {
      account_sid: savedValue('account_sid'),
      api_key_sid: savedValue('api_key_sid'),
      public_key: savedValue('public_key'),
    },
  }
}

/** The fields the form shows for a draft, in order. */
export function visibleFields(draft: CarrierDraft): string[] {
  if (draft.carrier === 'telnyx') return ['api_key', 'public_key']
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
    if (!value) {
      if (field !== 'public_key') errors[field] = 'Required'
    } else if (SID[field] && !SID[field]!.test(value))
      errors[field] = `Starts with ${field === 'account_sid' ? 'AC' : 'SK'} and 32 letters and digits`
  }
  return errors
}

/** The input of carrier.set for a draft. */
export function carrierInput(draft: CarrierDraft) {
  if (draft.carrier === 'default') return { carrier: 'default' as const }
  const values = Object.fromEntries(
    visibleFields(draft)
      .map(field => [field, (draft.values[field] ?? '').trim()])
      .filter(([, value]) => value),
  )
  return { carrier: draft.carrier, values }
}

/** One line for the Phone numbers section: which account the numbers use. */
export function carrierSummary(status: CarrierStatusData): string {
  if (status.carrier === 'default') return carrierLabel.default
  const sid = status.fields.find(f => f.field === 'account_sid')?.value
  return sid ? `${carrierLabel[status.carrier]} · ${sid.slice(0, 6)}…${sid.slice(-4)}` : carrierLabel[status.carrier]
}

/** What the Carrier setting decides, under its title. */
export const CARRIER_PURPOSE = 'Where new phone numbers are bought, and who bills for them and for call minutes.'

/**
 * When to pick each carrier, in one line. `serverProvider` is the carrier this server is set up with (`dev` in
 * development mode), when known: it is named for the default.
 */
export function carrierChoiceText(carrier: WorkspaceCarrier, serverProvider: string | null): string {
  if (carrier === 'twilio' || carrier === 'telnyx') {
    const name = carrierName(carrier) ?? carrier
    return `You have a ${name} account already. New numbers are bought there, and ${name} bills you. Needs your ${name} API key, entered here.`
  }
  if (serverProvider === 'dev') return 'Simplest, nothing to set up. Development mode: test numbers, nothing is bought.'
  const server = carrierName(serverProvider)
  return server
    ? `Simplest, nothing to set up. Numbers come from ${server}, set up by whoever runs this server.`
    : 'Simplest, nothing to set up. Numbers come from the carrier whoever runs this server set up.'
}

/**
 * What a change of carrier does to the numbers the workspace already has (carrier.set): numbers in the workspace's
 * own account keep it, so switching is refused until they are disconnected; the others stay as they are.
 */
export function existingNumbersText(current: WorkspaceCarrier, ownAccountNumbers: number): string {
  if (current !== 'default' && ownAccountNumbers > 0) {
    const name = carrierName(current) ?? current
    return ownAccountNumbers === 1
      ? `Your number stays in your ${name} account. To switch, disconnect it first.`
      : `Your ${ownAccountNumbers} numbers stay in your ${name} account. To switch, disconnect them first.`
  }
  return 'Numbers you already have stay connected as they are. The choice only applies to new numbers.'
}
