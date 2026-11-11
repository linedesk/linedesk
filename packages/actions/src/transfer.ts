// Warm transfer: the assistant puts a caller through to one of the assistant's transfer contacts
// (a name, a number and a plain-language condition, in order; assistant.update `transfers`). The voice
// agent dials the contact that fits and reports how it went with call.transfer.
import { type TransferContact, transferFallbacks } from '@linedesk/db/types'
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { z } from 'zod'
import { defineAction } from './define.ts'

const NANP = /^\+1([2-9]\d{2})([2-9]\d{2})\d{4}$/
/** Area codes that are no place for a transferred call: premium rate, personal and carrier services. */
const BLOCKED_AREA_CODES = new Set(['900', '976', '500', '533', '544', '566', '577', '588', '700'])
/** What libphonenumber may call a number calls can be put through to. */
const CALLABLE_TYPES = new Set(['FIXED_LINE', 'MOBILE', 'FIXED_LINE_OR_MOBILE'])

/**
 * Why the number cannot take transferred calls, in words for the owner; null when it can. Only US
 * landlines and mobiles (libphonenumber's US region: not Canada, the Caribbean or US territories with
 * their own region). Never premium rate (900, 976 anywhere), personal or 700 numbers, toll-free or N11
 * numbers, so a typo or a hostile setting cannot run up a phone bill.
 */
export function onCallNumberProblem(e164: string): string | null {
  const m = NANP.exec(e164)
  if (!m) return 'Enter a US phone number with its area code, like +1 503 555 0100.'
  const [, area, exchange] = m as unknown as [string, string, string]
  if (/^[2-9]11$/.test(area) || /^[2-9]11$/.test(exchange))
    return 'Service numbers (like 411) cannot take transferred calls.'
  // 976 is premium rate behind any area code (212-976-…)
  if (BLOCKED_AREA_CODES.has(area) || exchange === '976')
    return 'Premium-rate and personal numbers (900, 976, 500, 700) cannot take transferred calls.'
  const parsed = parsePhoneNumberFromString(e164)
  if (!parsed?.isValid() || parsed.country !== 'US')
    return 'Only US phone numbers can take transferred calls (not Canada or the Caribbean).'
  const type = parsed.getType()
  if (type === 'TOLL_FREE') return 'Toll-free numbers cannot take transferred calls. Enter a mobile or landline.'
  if (!type || !CALLABLE_TYPES.has(type)) return 'Enter a US mobile or landline number.'
  return null
}

export const onCallNumber = z.string().superRefine((value, ctx) => {
  const problem = onCallNumberProblem(value)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

/** How many transfer contacts an assistant can have. */
export const TRANSFER_CONTACTS_MAX = 10
export const TRANSFER_NAME_MAX = 60
export const TRANSFER_CONDITION_MAX = 300
/** How long a contact's phone may ring (seconds); 25 by default. */
export const RING_SECONDS_MIN = 10
export const RING_SECONDS_MAX = 60
export const RING_SECONDS_DEFAULT = 25

export const transferContact = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(TRANSFER_NAME_MAX),
  /** null: no number yet; the contact stays inactive. */
  number: onCallNumber.nullable(),
  condition: z.string().trim().min(1).max(TRANSFER_CONDITION_MAX),
  hours_only: z.boolean(),
  ring_seconds: z.number().int().min(RING_SECONDS_MIN).max(RING_SECONDS_MAX),
  if_no_answer: z.enum(transferFallbacks),
  enabled: z.boolean(),
}) satisfies z.ZodType<TransferContact>

/** The whole ordered list; ids and names (which the assistant picks by) are unique. */
export const transferContacts = z
  .array(transferContact)
  .max(TRANSFER_CONTACTS_MAX)
  .superRefine((list, ctx) => {
    const seen = { id: new Set<string>(), name: new Set<string>() }
    list.forEach((c, i) => {
      if (seen.id.has(c.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'Two transfer contacts have the same id.' })
      const name = c.name.toLowerCase()
      if (seen.name.has(name))
        ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Two transfer contacts are called "${c.name}".` })
      seen.id.add(c.id)
      seen.name.add(name)
    })
  })

/** Whether a contact can be dialled at all: switched on and has a number. */
export const isActiveContact = (c: Pick<TransferContact, 'enabled' | 'number'>) => c.enabled && !!c.number

/** Whether saving this assistant.update input would let calls be put through to a number. */
export const setsTransferNumber = (input: unknown) => {
  const list = (input as { transfers?: unknown } | null)?.transfers
  return Array.isArray(list) && list.some(c => isActiveContact((c ?? {}) as TransferContact))
}

/** The Emergency preset's condition (settings, the call test): trade examples help the assistant tell what counts. */
export const EMERGENCY_CONDITION =
  'Urgent: an emergency that needs a person right now, like a burst pipe, flooding, a gas smell or no heat in freezing weather'

/**
 * How a transfer went: `dialing` while the on-call phone rings or the person is briefed, then put
 * through, nobody answered (or no decision), the person said no, or it could not be placed.
 */
export const transferResults = ['dialing', 'connected', 'not_answered', 'declined', 'failed'] as const
export type TransferResult = (typeof transferResults)[number]

/** Per workspace: transfers started in the last hour, and on-call legs at the same time. */
export const TRANSFERS_PER_HOUR = 6
export const CONCURRENT_TRANSFERS = 1

/**
 * `dialing` asks for a transfer: refused when the workspace started TRANSFERS_PER_HOUR in the last hour
 * or has another one ringing or connected. The other results record how it ended.
 */
export const callTransfer = defineAction({
  name: 'call.transfer',
  description: `Record a warm transfer of a live call to a transfer contact. \`dialing\` first (refused above ${TRANSFERS_PER_HOUR} transfers an hour or while another transfer of the workspace is ringing or connected), then how it went (connected, not_answered, declined, failed). \`name\`: the contact's name. Marks the call urgent unless \`urgent\` is false.`,
  input: z.object({
    callId: z.string().min(1),
    to: onCallNumber,
    result: z.enum(transferResults),
    name: z.string().trim().min(1).max(TRANSFER_NAME_MAX).optional(),
    /** false: a transfer that is not about an emergency (billing, asks for a person) leaves the urgency as is. */
    urgent: z.boolean().optional(),
  }),
  permission: 'agent',
  logged: 'ids',
})
