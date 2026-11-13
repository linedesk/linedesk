// Onboarding without React: step order, the phone setup input and the carrier forwarding codes.
import {
  type BusinessHoursSpan,
  isActiveContact,
  onCallNumberProblem,
  onboardingSteps,
  type ProviderName,
  providerNames,
  providerSpec,
  RING_SECONDS_DEFAULT,
  TRANSFER_CONDITION_MAX,
  TRANSFER_CONTACTS_MAX,
  TRANSFER_NAME_MAX,
  type OnboardingStep,
  type PickupMode,
  type ProviderAudience,
  providerFailureReasonOfText,
  providerFailureText,
  type WorkspaceSettingsData,
} from '@linedesk/actions'
import type { Assistant, PhoneNumber, TransferContact } from '@linedesk/db/types'
import { type DayHours, dayRows } from '../settings/businessHoursModel.ts'
import { brandName } from '../brand.ts'
import { providerAudience } from '../providerAudience.ts'

type PhoneNumberMode = PhoneNumber['mode']

export { onboardingSteps, type OnboardingStep }

export const stepLabels: Record<OnboardingStep, string> = {
  business: 'Business',
  assistant: 'Your assistant',
  pickup: 'When to pick up',
  notify: 'Who hears about calls',
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
 * The phone options in words, the same in onboarding and Settings › Phone numbers: keeping the business's number
 * (forwarding) first, a new number to give out second; `existing` (no card: reached through the quiet link under
 * the cards, existingLinkText) as the heading above its number field.
 */
export function phoneOptionText(
  option: PhoneOption,
  name: string,
  carrier: string | null,
): { title: string; description: string } {
  if (option === 'forward')
    return {
      title: 'Keep my number',
      description: `We get ${name} a number, and you dial a short code once on your business phone to forward to it.`,
    }
  if (option === 'existing')
    return {
      title: carrier ? `Use a number you have in ${carrier}` : 'Use a number you have',
      description: `${name} answers that number; your business phone forwards to it.`,
    }
  return {
    title: 'Give callers a new number',
    description: `Only calls to the new number reach ${name}. Your current number rings as it does today.`,
  }
}

/** The quiet link under the cards to the `existing` option (instance admins), naming the carrier when there is one. */
export const existingLinkText = (carrier: string | null): string =>
  carrier ? `Already have a number in ${carrier}? Use it` : 'Already have a number? Use it'

/** A phone carrier's name ("Twilio", "Telnyx") from the provider registry; null for none or the development carrier. */
export function carrierName(provider: string | null | undefined): string | null {
  if (!provider || provider === 'dev' || !(providerNames as string[]).includes(provider)) return null
  const spec = providerSpec(provider as ProviderName)
  return spec.category === 'telephony' ? spec.label : null
}

/**
 * For a number given out as the business's new number: the forwarding mode that makes the calls to the business's
 * current number reach the assistant too (what the pick-up choice asks for), or null for a number that is already
 * forwarded to or was moved over (ported).
 */
export const forwardingOffer = (mode: PhoneNumberMode, pickup: PickupMode): Forwarding | null =>
  mode === 'new' ? pickupNumberMode(pickup) : null

/**
 * A `phoneNumber.setup` rejection in words an owner can act on. The server's own reason stays in the command log. A
 * carrier failure (key rejected, credit used up) says so in the shared provider-failure words (LIN-111): admins are
 * sent to Admin › Providers, everyone else to whoever runs the server.
 */
export function phoneSetupErrorText(error: string, audience: ProviderAudience = providerAudience()): string {
  if (/^phone setup is not configured/i.test(error))
    return audience === 'admin'
      ? "Phone numbers aren't set up on this server yet. Add a phone carrier under Admin › Providers."
      : "Phone numbers aren't set up on this server yet. Ask whoever runs it to add a phone carrier."
  if (/is already set up/i.test(error)) return `That number is already connected to ${brandName()}.`
  if (/is not in the .* account/i.test(error))
    return "We couldn't find that number in the carrier account. Check the number, or get a new one."
  if (/no number available in area code/i.test(error))
    return 'No number is free in that area code right now. Try a nearby one.'
  // The limits on buying through the install's carrier account (apps/api/src/number-purchases.ts) are written for people: shown as they are.
  if (/(on|through) this server|this server has given|numbers today/i.test(error)) return error
  const reason = providerFailureReasonOfText(error)
  // A refused setting, an unknown number and anything else are about this request: the cases above and the default.
  if (reason !== 'config' && reason !== 'not_found' && reason !== 'unknown')
    return providerFailureText(reason, 'The phone carrier', audience)
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

/** The transfer contact the "Who hears about calls?" step owns: the owner's mobile for urgent calls. */
export const URGENT_CONTACT_ID = 'urgent'
/** The contact every new assistant has for callers who ask for a person (DEFAULT_TRANSFERS). */
const PERSON_CONTACT_ID = 'person'
/** What counts as urgent until the owner says otherwise. */
export const DEFAULT_URGENT_CONDITION = 'An urgent problem or emergency that cannot wait until we call back'
/** The contact's name while the member's own name is not known (yet); replaced once it is. */
export const FALLBACK_OWNER_NAME = 'the owner'

/** What the step edits: the mobile as typed, whether urgent calls ring it, and what counts as urgent. */
export type WhoHearsDraft = { mobile: string; urgentOn: boolean; condition: string }

/**
 * What the step shows first. Its own contact when it saved one before (also after Back); else the number of the
 * contact for callers who ask for a person, the owner's phone (another contact's number, like a billing
 * colleague's, is never offered as the owner's mobile), urgent calls on, and the default condition.
 */
export function firstWhoHears(transfers: readonly TransferContact[]): WhoHearsDraft {
  const own = transfers.find(c => c.id === URGENT_CONTACT_ID)
  if (own)
    return { mobile: own.number ? formatNumber(own.number) : '', urgentOn: own.enabled, condition: own.condition }
  const person = transfers.find(c => c.id === PERSON_CONTACT_ID)
  return {
    mobile: person?.number ? formatNumber(person.number) : '',
    urgentOn: true,
    condition: DEFAULT_URGENT_CONDITION,
  }
}

/** What is wrong, and where: the mobile field, the condition, or the contact list itself. */
export type WhoHearsProblem = { field: 'mobile' | 'condition' | 'list'; message: string }

/** Why the step cannot be saved as it is, in words for the owner; null when it can. */
export function whoHearsProblem(
  draft: WhoHearsDraft,
  transfers: readonly TransferContact[] = [],
): WhoHearsProblem | null {
  const typed = draft.mobile.trim()
  if (typed) {
    const e164 = toE164(typed)
    if (!e164) return { field: 'mobile', message: 'Enter your mobile number with its area code, like (503) 555-0142.' }
    const problem = onCallNumberProblem(e164)
    if (problem) return { field: 'mobile', message: problem }
    if (!transfers.some(c => c.id === URGENT_CONTACT_ID) && transfers.length >= TRANSFER_CONTACTS_MAX)
      return {
        field: 'list',
        message: `${TRANSFER_CONTACTS_MAX} transfer contacts is the most an assistant can have. Remove one in Settings, or skip this step.`,
      }
  }
  if (!draft.urgentOn) return null
  if (!typed) return { field: 'mobile', message: 'Enter your mobile number, or turn urgent calls off.' }
  if (!draft.condition.trim()) return { field: 'condition', message: 'Say which calls are urgent.' }
  if (draft.condition.trim().length > TRANSFER_CONDITION_MAX)
    return { field: 'condition', message: `At most ${TRANSFER_CONDITION_MAX} characters.` }
  return null
}

/**
 * A contact name no other contact of the list has (names are what the assistant picks by, and says), within
 * TRANSFER_NAME_MAX.
 */
function freeName(transfers: readonly TransferContact[], wanted: string): string {
  const base = (wanted.trim() || FALLBACK_OWNER_NAME).slice(0, TRANSFER_NAME_MAX).trim()
  const taken = new Set(transfers.filter(c => c.id !== URGENT_CONTACT_ID).map(c => c.name.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`
    const name = `${base.slice(0, TRANSFER_NAME_MAX - suffix.length).trim()}${suffix}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

/**
 * The assistant's transfer list after the step, or null when it stays as it is. The step's contact rings the
 * mobile for urgent calls at any hour; when nobody picks up, the assistant takes a message. A new one goes first
 * when no other contact can be dialled yet (a new workspace), else last, so contacts the owner set up and ordered
 * in Settings keep their place. Urgent calls off keeps the number on a switched-off contact, so turning it on
 * later in Settings needs no retyping. Other contacts are left alone. `name` is how the assistant names the person
 * to the caller ("I'm trying to reach Mike Brennan now"); a contact saved before the name was known gets it now.
 */
export function whoHearsTransfers(
  transfers: readonly TransferContact[],
  draft: WhoHearsDraft,
  name: string,
): TransferContact[] | null {
  const number = toE164(draft.mobile)
  const own = transfers.find(c => c.id === URGENT_CONTACT_ID)
  if (!own && !number) return null
  const condition = draft.condition.trim() || own?.condition || DEFAULT_URGENT_CONDITION
  const renamed = own?.name === FALLBACK_OWNER_NAME && name.trim() ? freeName(transfers, name) : own?.name
  const contact: TransferContact = own
    ? { ...own, name: renamed!, number, condition, enabled: draft.urgentOn }
    : {
        id: URGENT_CONTACT_ID,
        name: freeName(transfers, name),
        number,
        condition,
        hours_only: false,
        ring_seconds: RING_SECONDS_DEFAULT,
        if_no_answer: 'message',
        enabled: draft.urgentOn,
      }
  if (own) {
    const same =
      own.name === contact.name &&
      own.number === contact.number &&
      own.condition === contact.condition &&
      own.enabled === contact.enabled
    return same ? null : transfers.map(c => (c.id === URGENT_CONTACT_ID ? contact : c))
  }
  return transfers.some(isActiveContact) ? [...transfers, contact] : [contact, ...transfers]
}

/**
 * An assistant.update refusal in words for this step. Refusals about the step's own contact (named `name`) are
 * about the mobile; anything else (another contact, the list) is said as the server says it.
 */
export function mobileErrorText(error: string, name: string): string {
  if (/confirm your email/i.test(error))
    return 'Confirm your email address above first: then urgent calls can ring your mobile.'
  if (error.includes(`${name}'s number is a `)) return `That is a ${brandName()} number. Enter your own mobile.`
  if (error.includes(`${name}'s number forwards its calls to`))
    return `That number forwards its calls to ${brandName()}. Enter your own mobile.`
  return error
}
