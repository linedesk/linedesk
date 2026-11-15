// The automatic forwarding check (onboarding concept, "The phone step in depth", 6a to 6c): Linedesk looks up the
// business's line, calls the business number from a number of the install, lets it ring, and watches whether the call
// arrives on the workspace's Linedesk number. apps/api/src/forwarding-check.ts runs it.
import type { ForwardingCheckStatus } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'
import { onCallNumberProblem } from './transfer.ts'

/** How long the business phone may ring before a check gives up: carriers forward after up to 30 s. */
export const FORWARDING_RING_SECONDS = 40
/** Checks a workspace may start: each one is a real call (a few cents) to the business's own phone. */
export const FORWARDING_CHECKS_PER_HOUR = 5
export const FORWARDING_CHECKS_PER_DAY = 15
/** Different business numbers a workspace may check in a day: its own line, maybe a second one, never a list. */
export const FORWARDING_NUMBERS_PER_WORKSPACE_DAY = 2
/** Checks of one business number in a day across the whole install, whichever workspaces ask. */
export const FORWARDING_CHECKS_PER_NUMBER_DAY = 3
/** Checks on the whole install in a day, unless `FORWARDING_CHECKS_PER_DAY` says otherwise: the operator's ceiling. */
export const FORWARDING_CHECKS_PER_INSTALL_DAY = 200
/** Carrier lookups a workspace may make in ten minutes (each costs a fraction of a cent). */
export const LINE_LOOKUPS_PER_10_MIN = 10
/** Carrier lookups a workspace may make in a day; answers from the cache do not count. */
export const LINE_LOOKUPS_PER_WORKSPACE_DAY = 30
/** Carrier lookups on the whole install in a day. */
export const LINE_LOOKUPS_PER_INSTALL_DAY = 500

/**
 * US numbers only (the outbound profiles are US-only): a US landline or mobile, by the same rule as a transfer
 * contact (onCallNumberProblem). Not Canada, the Caribbean or US territories with their own region, and no toll-free,
 * premium-rate (900, 976), personal (5XX), non-geographic or N11 number.
 */
export const isCheckableBusinessNumber = (e164: string): boolean => onCallNumberProblem(e164) === null

const businessNumber = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'a number in E.164, e.g. +15035550100')
  .refine(isCheckableBusinessNumber, 'a US business number (no toll-free or premium numbers)')

/** One check as the web app shows it. `ringSeconds`: how long the business phone rang before the call arrived. */
export type ForwardingCheckView = {
  id: string
  phoneNumberId: string
  businessNumber: string
  status: ForwardingCheckStatus
  detail: string | null
  ringSeconds: number | null
  /** Run by the development carrier (`dev`): nothing was dialled, the result is made up and never verifies the line. */
  simulated: boolean
  startedAt: string
  finishedAt: string | null
}

export type LineType = 'mobile' | 'landline' | 'voip' | 'toll_free' | 'unknown'
/**
 * carrierId: the forwarding guide for the looked-up carrier (forwardingGuideForCarrier, a guide of the number's own
 * country first), or null when none matches.
 * simulated: answered by the development carrier (`dev`), the same made-up carrier for every number.
 */
export type LineLookupData = {
  lineType: LineType
  carrier: string | null
  carrierId: string | null
  simulated: boolean
}

export const phoneNumberLookupLine = defineAction({
  name: 'phoneNumber.lookupLine',
  description:
    "Look up the line type (mobile, landline, VoIP) and carrier of the business's own number, to pick the right forwarding instructions. Reads only; the carrier charges a fraction of a cent, and an answer is reused for a day.",
  input: z.object({ number: businessNumber }),
  permission: 'settings:write',
  // Runs outside a transaction: the request to the carrier holds none open.
  readOnly: true,
})

export const phoneNumberCheckForwarding = defineAction({
  name: 'phoneNumber.checkForwarding',
  description:
    "Check call forwarding of a number connected in a forwarding mode: Linedesk calls the business's own number (`businessNumber`; default: the one saved on the number, else the last one checked), lets it ring, and watches whether the call arrives on the Linedesk number. The number is saved on the Linedesk number once a check works. The result comes from phoneNumber.forwardingCheck. Limited to a few checks an hour, two business numbers a day, and three checks of one business number a day on the whole install.",
  input: z.object({ phoneNumberId: z.string().min(1), businessNumber: businessNumber.optional() }),
  permission: 'settings:write',
})

export const phoneNumberForwardingCheck = defineAction({
  name: 'phoneNumber.forwardingCheck',
  description:
    'The latest forwarding check of a phone number and what it found (`check` is null when it was never checked); `available`: whether this server can run a check now (else call the business number from another phone to test); `simulated`: checks here are simulated (development carrier) and never verify the line.',
  input: z.object({ phoneNumberId: z.string().min(1) }),
  permission: 'settings:write',
  readOnly: true,
})
