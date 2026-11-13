// Onboarding without React: step order, the phone setup input and the carrier forwarding codes.
import {
  type BusinessHoursSpan,
  onboardingSteps,
  type OnboardingStep,
  type PickupMode,
  type WorkspaceSettingsData,
} from '@linedesk/actions'
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
import { type DayHours, dayRows } from '../settings/businessHoursModel.ts'
import { brandName } from '../brand.ts'

type PhoneNumberMode = PhoneNumber['mode']

export { onboardingSteps, type OnboardingStep }

export const stepLabels: Record<OnboardingStep, string> = {
  business: 'Business',
  assistant: 'Your assistant',
  pickup: 'When to pick up',
  phone: 'Phone',
  done: 'Done',
}

export const nextStep = (step: OnboardingStep): OnboardingStep =>
  onboardingSteps[Math.min(onboardingSteps.indexOf(step) + 1, onboardingSteps.length - 1)]!
export const previousStep = (step: OnboardingStep): OnboardingStep | null =>
  onboardingSteps[onboardingSteps.indexOf(step) - 1] ?? null

/** The pick-up choices in the order shown; the first is recommended and preselected. */
export const pickupOrder: readonly PickupMode[] = ['no_answer', 'after_hours', 'always']

/**
 * What the pick-up step shows first: what was chosen before; else what a connected number already does (forwarding
 * every call is "every call"), so continuing doesn't silently change it; else "when I can't answer".
 */
export const firstPickup = (
  saved: Pick<WorkspaceSettingsData, 'pickupMode'> | null,
  numberMode?: PhoneNumberMode | null,
): PickupMode => saved?.pickupMode ?? (numberMode === 'forward_all' ? 'always' : 'no_answer')

/**
 * What the pick-up step remembers while onboarding runs: whether the business hours were on before "only when
 * we're closed" turned them on, and how a connected number forwarded before the choice changed it (to say which
 * code turns the old forwarding off).
 */
export type PickupMemory = {
  hoursOnBefore: boolean | null
  oldForwarding: 'forward_conditional' | 'forward_all' | null
}
export const NO_PICKUP_MEMORY: PickupMemory = { hoursOnBefore: null, oldForwarding: null }

/**
 * The `workspace.updateSettings` input for a pick-up choice. "Only when we're closed" turns the business hours on
 * (remembering whether they were); leaving it for another choice turns them back to what they were, off when
 * onboarding turned them on. The other choices leave the hours alone.
 */
export function pickupSettings(
  saved: Pick<WorkspaceSettingsData, 'pickupMode' | 'businessHoursOn'>,
  mode: PickupMode,
  memory: PickupMemory,
): { input: { pickupMode: PickupMode; businessHoursOn?: boolean }; hoursOnBefore: boolean | null } {
  const wasClosedOnly = saved.pickupMode === 'after_hours'
  if (mode === 'after_hours')
    return {
      input: { pickupMode: mode, businessHoursOn: true },
      hoursOnBefore: wasClosedOnly ? memory.hoursOnBefore : saved.businessHoursOn,
    }
  if (wasClosedOnly)
    return { input: { pickupMode: mode, businessHoursOn: memory.hoursOnBefore ?? false }, hoursOnBefore: null }
  return { input: { pickupMode: mode }, hoursOnBefore: memory.hoursOnBefore }
}

/**
 * How the number forwarded before a change to `wanted`, for the "turn the old forwarding off" line: null when the
 * change goes back to what was remembered as dialled first.
 */
export function oldForwardingAfter(
  current: 'forward_conditional' | 'forward_all',
  wanted: 'forward_conditional' | 'forward_all',
  remembered: PickupMemory['oldForwarding'],
): PickupMemory['oldForwarding'] {
  if (current === wanted) return remembered
  return remembered === wanted ? null : (remembered ?? current)
}

/**
 * How the business's own number reaches the assistant for a pick-up choice. Only every call needs forwarding
 * of all calls; after hours is conditional forwarding too (nobody answers when closed) plus the business hours.
 */
export const pickupNumberMode = (mode: PickupMode): 'forward_conditional' | 'forward_all' =>
  mode === 'always' ? 'forward_all' : 'forward_conditional'

/** Only after hours asks for the business hours. */
export const pickupNeedsHours = (mode: PickupMode) => mode === 'after_hours'

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

type Forwarding = 'forward_conditional' | 'forward_all'

/**
 * An attached number is where the business's own number forwards to. A bought one is too when `forwarding` is given
 * (the business keeps its number and forwards to it); without, it is the business's new number to give out.
 */
export type PhoneSetupInput =
  | { e164: string; purchase: false; mode?: Forwarding }
  | { areaCode: string; purchase: true; mode: 'new' | Forwarding }

/**
 * The `phoneNumber.setup` input for what the user picked, or why it cannot be sent yet.
 * Buying costs money, so a new number is only requested after the user confirmed the price.
 */
export function phoneSetupInput(
  choice: PhoneChoice,
  forwarding?: Forwarding,
): { input: PhoneSetupInput } | { problem: string } {
  if (choice.kind === 'existing') {
    const e164 = toE164(choice.number)
    return e164
      ? { input: { e164, purchase: false, ...(forwarding ? { mode: forwarding } : {}) } }
      : { problem: 'Enter the number with its area code, like +1 503 555 0100.' }
  }
  if (!/^\d{3}$/.test(choice.areaCode)) return { problem: 'Enter a 3-digit area code, like 503.' }
  if (!choice.confirmed) return { problem: 'Confirm the monthly cost first.' }
  return { input: { areaCode: choice.areaCode, purchase: true, mode: forwarding ?? 'new' } }
}

/**
 * The phone step's choices, first one preselected. Every pick-up choice means calls to the business's own number
 * reach the assistant, so the step leads with keeping that number and forwarding it: to a number we get for the
 * assistant (`forward`), or to one already in the install's carrier account (`existing`, instance admins only). A new
 * number to give out (`new`) comes last: only calls to it reach the assistant.
 */
export type PhoneOption = 'forward' | 'existing' | 'new'
export const phoneOptions = (canAttach: boolean): PhoneOption[] =>
  canAttach ? ['forward', 'existing', 'new'] : ['forward', 'new']

/** The `phoneNumber.setup` choice and forwarding for a phone step option. */
export function phoneOptionSetup(
  option: PhoneOption,
  fields: { number: string; areaCode: string; confirmed: boolean },
  forwarding: Forwarding,
): { input: PhoneSetupInput } | { problem: string } {
  if (option === 'existing') return phoneSetupInput({ kind: 'existing', number: fields.number }, forwarding)
  const choice = { kind: 'new' as const, areaCode: fields.areaCode, confirmed: fields.confirmed }
  return phoneSetupInput(choice, option === 'forward' ? forwarding : undefined)
}

/**
 * For a number given out as the business's new number: the forwarding mode that makes the calls to the business's
 * current number reach the assistant too (what the pick-up choice asks for), or null for a number that is already
 * forwarded to or was moved over (ported).
 */
export const forwardingOffer = (mode: PhoneNumberMode, pickup: PickupMode): Forwarding | null =>
  mode === 'new' ? pickupNumberMode(pickup) : null

/** A `phoneNumber.setup` rejection in words an owner can act on. The server's own reason stays in the command log. */
export function phoneSetupErrorText(error: string): string {
  if (/^phone setup is not configured/i.test(error))
    return "Phone numbers aren't set up on this server yet. Ask whoever runs it to add a phone carrier."
  if (/is already set up/i.test(error)) return `That number is already connected to ${brandName()}.`
  if (/is not in the .* account/i.test(error))
    return "We couldn't find that number in the carrier account. Check the number, or get a new one."
  if (/no number available in area code/i.test(error))
    return 'No number is free in that area code right now. Try a nearby one.'
  // The limits on buying through the install's carrier account (apps/api/src/number-purchases.ts) are written for people: shown as they are.
  if (/(on|through) this server|this server has given|numbers today/i.test(error)) return error
  return "The number couldn't be connected. Try again in a moment."
}

/** How the business uses a connected number, in a few words. */
export const numberModeLabel: Record<PhoneNumberMode, string> = {
  forward_conditional: 'Missed calls forward here',
  forward_all: 'All calls forward here',
  get new() {
    return `Your ${brandName()} number`
  },
  get ported() {
    return `Your number, moved to ${brandName()}`
  },
}

/** What a new number costs, as far as we know it. Prices are the carriers' list prices for a US local number. */
export function priceNote(provider: string | null): string {
  if (provider === 'twilio') return 'About $1.15 a month plus call minutes, billed by Twilio.'
  if (provider === 'telnyx') return 'About $1 a month plus call minutes, billed by Telnyx.'
  if (provider === 'dev') return 'Development mode: nothing is bought, the number is not real.'
  return 'A monthly fee plus call minutes, billed by your carrier.'
}

/** The question before buying: in development mode nothing is bought, so nothing is billed either. */
export function buyQuestion(provider: string | null, areaCode: string): string {
  if (provider === 'dev')
    return `Add a test number in area code ${areaCode}? Development mode: nothing is bought or billed.`
  return `Buy a number in area code ${areaCode}? It is billed every month until you release it.`
}

/** `on`/`off`: conditional forwarding (no answer, busy); `allOn`/`allOff`: forwarding every call. */
export type Carrier = {
  id: string
  name: string
  on: (digits: string) => string
  off: string
  allOn: (digits: string) => string
  allOff: string
}

/** Call forwarding codes for a business that keeps its number. architecture.md §8. */
export const carriers: readonly Carrier[] = [
  { id: 'verizon', name: 'Verizon', on: d => `*71${d}`, off: '*73', allOn: d => `*72${d}`, allOff: '*73' },
  { id: 'att', name: 'AT&T', on: d => `**004*${d}#`, off: '##004#', allOn: d => `**21*${d}#`, allOff: '##21#' },
  { id: 'tmobile', name: 'T-Mobile', on: d => `**004*${d}#`, off: '##004#', allOn: d => `**21*${d}#`, allOff: '##21#' },
]

/** The code to dial for a number's forwarding mode, and the one that turns it off again. */
export function forwardingCode(carrier: Carrier, mode: PhoneNumberMode, e164: string): { on: string; off: string } {
  const digits = forwardingDigits(e164)
  return mode === 'forward_all'
    ? { on: carrier.allOn(digits), off: carrier.allOff }
    : { on: carrier.on(digits), off: carrier.off }
}

/** The 10 digits carriers expect in a forwarding code. */
export const forwardingDigits = (e164: string) => e164.replace(/^\+1/, '').replace(/\D/g, '')

/** Keeps the greeting in step with a renamed assistant ("This is Maya" → "This is Ava"). */
export function renameInGreeting(greeting: string, oldName: string, newName: string): string {
  if (!oldName || oldName === newName) return greeting
  return greeting.replace(new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), newName)
}

/** What the assistant step edits. */
export type AssistantDraft = { name: string; greeting: string; voice: { provider: string; voice_id: string } }

/**
 * The `assistant.update` fields that differ from the saved assistant, or null when nothing changed. Names and
 * greetings are trimmed; an empty name or greeting is not saved (the step asks for both). A rename also renames the
 * saved name in the greeting, once, on save ("This is Maya" → "This is Ava").
 */
export function assistantChanges(
  saved: Pick<Assistant, 'name' | 'greeting' | 'voice'>,
  draft: AssistantDraft,
): Partial<AssistantDraft> | null {
  const changes: Partial<AssistantDraft> = {}
  const name = draft.name.trim()
  const renamed = !!name && name !== saved.name
  const greeting = renamed ? renameInGreeting(draft.greeting.trim(), saved.name, name) : draft.greeting.trim()
  if (renamed) changes.name = name
  if (greeting && greeting !== saved.greeting) changes.greeting = greeting
  if (draft.voice.provider !== saved.voice.provider || draft.voice.voice_id !== saved.voice.voice_id)
    changes.voice = draft.voice
  return Object.keys(changes).length ? changes : null
}
