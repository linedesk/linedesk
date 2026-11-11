// Onboarding without React: step order, the phone setup input and the carrier forwarding codes.
import {
  type BusinessHoursSpan,
  onboardingSteps,
  type OnboardingStep,
  type WorkspaceSettingsData,
} from '@linedesk/actions'
import type { Call, PhoneNumber } from '@linedesk/db/types'
import { type DayHours, dayRows } from '../settings/businessHoursModel.ts'

type PhoneNumberMode = PhoneNumber['mode']

export { onboardingSteps, type OnboardingStep }

export const stepLabels: Record<OnboardingStep, string> = {
  business: 'Business',
  phone: 'Phone',
  hours: 'Hours',
  calendar: 'Calendar',
  test_call: 'Test call',
  done: 'Done',
}

export const nextStep = (step: OnboardingStep): OnboardingStep =>
  onboardingSteps[Math.min(onboardingSteps.indexOf(step) + 1, onboardingSteps.length - 1)]!
export const previousStep = (step: OnboardingStep): OnboardingStep | null =>
  onboardingSteps[onboardingSteps.indexOf(step) - 1] ?? null

/** The usual small-business week the hours step starts from: Monday to Friday, 9 to 5. */
export const STARTER_HOURS: BusinessHoursSpan[] = [1, 2, 3, 4, 5].map(weekday => ({
  weekday,
  start: '09:00',
  end: '17:00',
}))

/**
 * What the hours step shows first. A workspace without hours gets 9 to 5 on weekdays, turned on, in the
 * browser's time zone (the owner confirms it). Coming back to the step shows what was saved.
 */
export function firstHoursDraft(
  saved: Pick<WorkspaceSettingsData, 'businessHours' | 'businessHoursOn' | 'timeZone'>,
  browserZone: string | null,
): { on: boolean; days: DayHours[]; timeZone: string } {
  if (!saved.businessHours.length)
    return { on: true, days: dayRows(STARTER_HOURS), timeZone: browserZone ?? saved.timeZone }
  return { on: saved.businessHoursOn, days: dayRows(saved.businessHours), timeZone: saved.timeZone }
}

/** Share of the bar to fill: finished steps, plus the current one once it is complete. */
export function progress(step: OnboardingStep, complete: boolean): number {
  const at = onboardingSteps.indexOf(step) + (complete ? 1 : 0)
  return Math.round((at / onboardingSteps.length) * 100)
}

/** A US number as people type it ("(503) 555-0142", "503.555.0142", "+1 503 …") in E.164, or null. */
export function toE164(typed: string): string | null {
  const digits = typed.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

/** +15035550142 → +1 503 555 0142 */
export function formatNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164
}

export type PhoneChoice = { kind: 'existing'; number: string } | { kind: 'new'; areaCode: string; confirmed: boolean }

/** A bought number is the business's new number; an attached one is where its own number forwards to. */
export type PhoneSetupInput = { e164: string; purchase: false } | { areaCode: string; purchase: true; mode: 'new' }

/**
 * The `phoneNumber.setup` input for what the user picked, or why it cannot be sent yet.
 * Buying costs money, so a new number is only requested after the user confirmed the price.
 */
export function phoneSetupInput(choice: PhoneChoice): { input: PhoneSetupInput } | { problem: string } {
  if (choice.kind === 'existing') {
    const e164 = toE164(choice.number)
    return e164
      ? { input: { e164, purchase: false } }
      : { problem: 'Enter the number with its area code, like +1 503 555 0142.' }
  }
  if (!/^\d{3}$/.test(choice.areaCode)) return { problem: 'Enter a 3-digit area code, like 503.' }
  if (!choice.confirmed) return { problem: 'Confirm the monthly cost first.' }
  return { input: { areaCode: choice.areaCode, purchase: true, mode: 'new' } }
}

/** A `phoneNumber.setup` rejection in words an owner can act on. The server's own reason stays in the command log. */
export function phoneSetupErrorText(error: string): string {
  if (/^phone setup is not configured/i.test(error))
    return "Phone numbers aren't set up on this server yet. Ask whoever runs your Linedesk to add a phone carrier."
  if (/is already set up/i.test(error)) return 'That number is already connected to Linedesk.'
  if (/is not in the .* account/i.test(error))
    return "We couldn't find that number in the carrier account. Check the number, or get a new one."
  if (/no number available in area code/i.test(error))
    return 'No number is free in that area code right now. Try a nearby one.'
  return "The number couldn't be connected. Try again in a moment."
}

/** How the business uses a connected number, in a few words. */
export const numberModeLabel: Record<PhoneNumberMode, string> = {
  forward_conditional: 'Missed calls forward here',
  forward_all: 'All calls forward here',
  new: 'Your Linedesk number',
  ported: 'Your number, moved to Linedesk',
}

/** What a new number costs, as far as we know it. Prices are the carriers' list prices for a US local number. */
export function priceNote(provider: string | null): string {
  if (provider === 'twilio') return 'About $1.15 a month plus call minutes, billed by Twilio.'
  if (provider === 'telnyx') return 'About $1 a month plus call minutes, billed by Telnyx.'
  if (provider === 'dev') return 'Development mode: nothing is bought, the number is not real.'
  return 'A monthly fee plus call minutes, billed by your carrier.'
}

export type Carrier = { id: string; name: string; on: (digits: string) => string; off: string }

/** Conditional call forwarding (no answer, busy) for a business that keeps its number. architecture.md §8. */
export const carriers: readonly Carrier[] = [
  { id: 'verizon', name: 'Verizon', on: d => `*71${d}`, off: '*73' },
  { id: 'att', name: 'AT&T', on: d => `**004*${d}#`, off: '##004#' },
  { id: 'tmobile', name: 'T-Mobile', on: d => `**004*${d}#`, off: '##004#' },
]

/** The 10 digits carriers expect in a forwarding code. */
export const forwardingDigits = (e164: string) => e164.replace(/^\+1/, '').replace(/\D/g, '')

/** The first call to one of the workspace's numbers that started after the test-call screen opened. */
export function firstTestCall(calls: readonly Call[], numbers: readonly string[], since: string): Call | undefined {
  const sinceMs = Date.parse(since)
  return calls
    .filter(c => !c.deleted_at && numbers.includes(c.to_number) && Date.parse(c.started_at) >= sinceMs)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))[0]
}

/** The simulator command that plays a scripted call to `e164` (development only, needs the agent token). */
export const simulateCommand = (e164: string) =>
  `SIM_TO_NUMBER='${e164}' pnpm --filter @linedesk/agent simulate message`

/** Keeps the greeting in step with a renamed assistant ("This is Maya" → "This is Ava"). */
export function renameInGreeting(greeting: string, oldName: string, newName: string): string {
  if (!oldName || oldName === newName) return greeting
  return greeting.replace(new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), newName)
}
