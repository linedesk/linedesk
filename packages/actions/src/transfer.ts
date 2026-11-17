// Warm transfer: the assistant puts a caller through to one of the assistant's transfer contacts
// (a name, a number and a plain-language condition, in order; assistant.update `transfers`). The voice
// agent dials the contact that fits and reports how it went with call.transfer.
import { type TransferContact, transferFallbacks } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'
import { onCallNumberProblem } from './outbound.ts'

/**
 * A number calls may be put through to, by its kind only (outboundNumberProblem with any country): which countries a
 * workspace may call depends on its numbers and the install, so assistant.update and call.transfer check that too.
 */
export const onCallNumber = z.string().superRefine((value, ctx) => {
  const problem = onCallNumberProblem(value, 'any')
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
  // "message_urgent" (removed) from an older web app or a saved version is a plain message now.
  if_no_answer: z.enum([...transferFallbacks, 'message_urgent']).transform(v => (v === 'message_urgent' ? 'message' : v)),
  enabled: z.boolean(),
  /** false: put straight through when the phone is answered, no AI-voice briefing; missing: on (isBriefed). */
  briefing: z.boolean().optional(),
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

/** Whether the person hears the AI-voice briefing (and can decline) before the caller is put through; missing: yes. */
export const isBriefed = (c: Pick<TransferContact, 'briefing'>) => c.briefing !== false

/** Whether a contact can be dialled at all: switched on and has a number. */
export const isActiveContact = (c: Pick<TransferContact, 'enabled' | 'number'>) => c.enabled && !!c.number

/** Whether saving this assistant.update input would let calls be put through to a number. */
export const setsTransferNumber = (input: unknown) => {
  const list = (input as { transfers?: unknown } | null)?.transfers
  return Array.isArray(list) && list.some(c => isActiveContact((c ?? {}) as TransferContact))
}

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
  description: `Record a warm transfer of a live call to a transfer contact. \`dialing\` first (refused above ${TRANSFERS_PER_HOUR} transfers an hour or while another transfer of the workspace is ringing or connected), then how it went (connected, not_answered, declined, failed). \`name\`: the contact's name. Leaves the call's urgency as it is.`,
  input: z.object({
    callId: z.string().min(1),
    to: onCallNumber,
    result: z.enum(transferResults),
    name: z.string().trim().min(1).max(TRANSFER_NAME_MAX).optional(),
    /** No longer used (a transfer never changes the urgency); an older agent still sends it. */
    urgent: z.boolean().optional(),
  }),
  permission: 'agent',
  logged: 'ids',
})
/**
 * `data` of call.transfer `dialing`: the caller ID to show (a number of the workspace in the destination's country, in
 * the same carrier account as the called number; null: the called number as before) and how long the on-call leg may
 * last at most (the day's minutes left, at most TRANSFER_MAX_MINUTES).
 */
export type CallTransferData = { callerId: string | null; maxMinutes: number }
