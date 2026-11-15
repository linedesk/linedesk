// Onboarding without React: step order, the phone setup input and the carrier forwarding codes.
import {
  type BusinessHoursSpan,
  type ForwardingGuide,
  type ForwardingMode,
  forwardingInstructions,
  isActiveContact,
  type OnboardingStep,
  onboardingSteps,
  onCallNumberProblem,
  type PickupMode,
  type ProviderName,
  providerNames,
  providerSpec,
  RING_SECONDS_DEFAULT,
  TRANSFER_CONDITION_MAX,
  TRANSFER_CONTACTS_MAX,
  TRANSFER_NAME_MAX,
  type ProviderAudience,
  usAreaCode,
  providerFailureReasonOfText,
  providerFailureText,
  type WorkspaceSettingsData,
} from '@linedesk/actions'
import type { Assistant, PhoneNumber, TransferContact } from '@linedesk/db/types'
import { brandName } from '../brand.ts'
import { providerAudience } from '../providerAudience.ts'
import { type DayHours, dayRows } from '../settings/businessHoursModel.ts'

type PhoneNumberMode = PhoneNumber['mode']

export { type OnboardingStep, onboardingSteps }

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
  if (!usAreaCode(choice.areaCode)) return { problem: 'Pick an area code for the new number from the list.' }
  if (!choice.confirmed) return { problem: 'Confirm the monthly cost first.' }
  return { input: { areaCode: choice.areaCode, purchase: true, mode: forwarding ?? 'new' } }
}

/**
 * The phone step's options. Every pick-up choice means calls to the business's own number reach the assistant, so
 * the step leads with keeping that number and forwarding it to a number we get for the assistant (`forward`). A new
 * number to give out (`new`) comes second: only calls to it reach the assistant. Forwarding to a number already in
 * the install's carrier account (`existing`) is no card: instance admins reach it through a quiet link under the
 * cards (`existingLinkText`).
 */
export type PhoneOption = 'forward' | 'existing' | 'new'
/** The cards everyone sees, in order; the first is recommended and preselected. */
export const phoneOptions: readonly PhoneOption[] = ['forward', 'new']

/** The link under the cards to the `existing` option, naming the install's carrier when it has one. */
export const existingLinkText = (carrier: string | null): string =>
  carrier ? `Already have a number in ${carrier}? Use it` : 'Already have a number? Use it'

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
 * sent to Server admin › Providers, everyone else to whoever runs the server.
 */
export function phoneSetupErrorText(error: string, audience: ProviderAudience = providerAudience()): string {
  if (/^phone setup is not configured/i.test(error))
    return audience === 'admin'
      ? "Phone numbers aren't set up on this server yet. Add a phone carrier under Server admin › Providers."
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

/**
 * The question before buying. In development mode nothing is bought or billed; the note under the field says so once
 * (priceNote), so the question doesn't repeat it.
 */
export function buyQuestion(provider: string | null, areaCode: string): string {
  if (provider === 'dev') return `Add a test number in area code ${areaCode}?`
  return `Buy a number in area code ${areaCode}? It is billed every month until you release it.`
}

/**
 * The line that asks to turn an earlier forwarding off before the new one (the pick-up choice changed after the code
 * was shown), with that forwarding's off codes or where to change it.
 */
export function turnOffFirst(guide: ForwardingGuide, earlier: ForwardingMode, e164: string, country?: string): string {
  const steps = forwardingInstructions(guide, earlier, e164, country)
  if (!steps) return 'Turned on forwarding earlier? Turn it off first.'
  if (steps.how === 'dial')
    return `Dialled the earlier code already? Turn that forwarding off first with ${steps.off.map(c => c.code).join(', ')}.`
  return `Set up the earlier forwarding already? Turn it off first in ${steps.where}.`
}

/** iPhone or iPad (iPadOS reports itself as a Mac, with touch). */
export const isAppleMobile = (userAgent: string, touchPoints: number) =>
  /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)

/**
 * How a forwarding code is best dialled on this device: `dial` (a tel: link opens the dialer, Android), `copy`
 * (iOS often refuses tel: links with * or # since iOS 15.4, so copy and paste into the keypad), `qr` (a laptop: a QR
 * code that opens the code on the phone).
 */
export function dialPath(userAgent: string, touchPoints: number, coarsePointer: boolean): 'dial' | 'copy' | 'qr' {
  if (isAppleMobile(userAgent, touchPoints)) return 'copy'
  return coarsePointer ? 'dial' : 'qr'
}

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
export const DEFAULT_URGENT_CONDITION = 'An urgent problem that cannot wait until we call back'
/**
 * The second line of the step's contact when it took over the "asks for a person" contact (one without a number):
 * the owner's mobile serves both, one contact. The step shows and edits only the line before it.
 */
export const ALSO_PERSON = 'Also: the caller asks to speak to a person.'
const withoutPerson = (condition: string) =>
  condition.endsWith(ALSO_PERSON) ? condition.slice(0, -ALSO_PERSON.length).trim() : condition
/** The contact's name while the member's own name is not known (yet); replaced once it is. */
export const FALLBACK_OWNER_NAME = 'the owner'

/**
 * What happens when a caller has an urgent matter: put through to the owner's mobile (the step's contact, on), or a
 * message the owner is alerted to right away (the contact off, or none). Null until the owner picks one: nothing
 * is preselected, so nobody continues past a choice they didn't see.
 */
export type UrgentChoice = 'transfer' | 'message'

/** What the step edits: the urgent choice, and for "put through" the mobile as typed and what counts as urgent. */
export type WhoHearsDraft = { urgent: UrgentChoice | null; mobile: string; condition: string }

/**
 * What the step shows first. Its own contact when it saved one before (also after Back): its choice, number and
 * condition. Else no choice yet, the number of the contact for callers who ask for a person, the owner's phone
 * (another contact's number, like a billing colleague's, is never offered as the owner's mobile), and the default
 * condition.
 */
export function firstWhoHears(transfers: readonly TransferContact[], urgentCases: string | null = null): WhoHearsDraft {
  const own = transfers.find(c => c.id === URGENT_CONTACT_ID)
  if (own)
    return {
      urgent: own.enabled ? 'transfer' : 'message',
      mobile: own.number ? formatNumber(own.number) : '',
      condition: withoutPerson(own.condition),
    }
  const person = transfers.find(c => c.id === PERSON_CONTACT_ID)
  return {
    urgent: null,
    mobile: person?.number ? formatNumber(person.number) : '',
    condition: urgentCases ?? DEFAULT_URGENT_CONDITION,
  }
}

/**
 * The urgent cases the business step's common calls already name ("When a caller has a leak, flooding or no heat,
 * treat it as urgent: …" → "A leak, flooding or no heat"), so "Urgent means" starts from what the owner saw there;
 * null when the instructions name none.
 */
export function urgentCasesFrom(instructions: string | undefined): string | null {
  for (const raw of (instructions ?? '').split('\n')) {
    const line = raw.replace(/^\s*[-•*]\s*/, '').trim()
    const m =
      /^when (?:a )?caller (?:has|reports|describes|mentions) (.+?),\s*(?:treat it as urgent|mark the message urgent|it is urgent)/i.exec(
        line,
      )
    if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}`
  }
  return null
}

/** The fixed line under "Urgent means": emergencies are not the business's to handle (EMERGENCY_RULE in the prompt). */
export const EMERGENCY_NOTE = (name: string) =>
  `Emergencies (danger to people, fire, a gas smell): ${name} tells the caller to hang up and call 911.`

/** What is wrong, and where: no choice made, the mobile field, the condition, or the contact list itself. */
export type WhoHearsProblem = { field: 'choice' | 'mobile' | 'condition' | 'list'; message: string }

/**
 * Why the step cannot be saved as it is, in words for the owner; null when it can. Only "put through" asks for a
 * number; "take a message" needs nothing more (a number typed before switching to it is not shown, so not checked).
 */
export function whoHearsProblem(
  draft: WhoHearsDraft,
  transfers: readonly TransferContact[] = [],
): WhoHearsProblem | null {
  if (!draft.urgent) return { field: 'choice', message: 'Choose what happens when a caller has an urgent matter.' }
  if (draft.urgent === 'message') return null
  const typed = draft.mobile.trim()
  if (!typed) return { field: 'mobile', message: 'Enter your mobile number, so urgent calls can ring it.' }
  const e164 = toE164(typed)
  if (!e164) return { field: 'mobile', message: 'Enter your mobile number with its area code.' }
  const problem = onCallNumberProblem(e164)
  if (problem) return { field: 'mobile', message: problem }
  if (!transfers.some(c => c.id === URGENT_CONTACT_ID) && transfers.length >= TRANSFER_CONTACTS_MAX)
    return {
      field: 'list',
      message: `${TRANSFER_CONTACTS_MAX} transfer contacts is the most an assistant can have. Remove one in Settings, or choose "Take a message".`,
    }
  if (!draft.condition.trim()) return { field: 'condition', message: 'Say which calls are urgent.' }
  // Room for the "asks for a person" line the contact may carry too.
  const max = TRANSFER_CONDITION_MAX - ALSO_PERSON.length - 1
  if (draft.condition.trim().length > max) return { field: 'condition', message: `At most ${max} characters.` }
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
 * The assistant's transfer list after the step, or null when it stays as it is. "Put through": the step's contact
 * rings the mobile for urgent calls at any hour; when nobody picks up, the assistant takes a message. A new one goes
 * first when no other contact can be dialled yet (a new workspace), else last, so contacts the owner set up and
 * ordered in Settings keep their place. "Take a message": a contact saved before is switched off and keeps its
 * number and condition (turning it on later in Settings needs no retyping; the hidden field is not saved); without
 * one nothing is added. Other contacts are left alone. `name` is how the assistant names the person to the caller
 * ("I'm trying to reach Mike Brennan now"); a contact saved before the name was known gets it now.
 */
export function whoHearsTransfers(
  transfers: readonly TransferContact[],
  draft: WhoHearsDraft,
  name: string,
): TransferContact[] | null {
  if (!draft.urgent) return null
  const own = transfers.find(c => c.id === URGENT_CONTACT_ID)
  const putThrough = draft.urgent === 'transfer'
  const number = putThrough ? toE164(draft.mobile) : (own?.number ?? null)
  if (!own && !(putThrough && number)) return null
  // A new workspace's "asks for a person" contact has no number yet: the owner's mobile serves it too. The step's
  // contact takes it over (its condition gets ALSO_PERSON), so the owner is one contact, not two.
  const unusedPerson = putThrough && !own ? transfers.find(c => c.id === PERSON_CONTACT_ID && !c.number) : undefined
  const others = unusedPerson ? transfers.filter(c => c !== unusedPerson) : transfers
  const alsoPerson = !!unusedPerson || !!own?.condition.endsWith(ALSO_PERSON)
  const typedCondition = putThrough ? draft.condition.trim() : ''
  const urgentCondition = typedCondition || (own ? withoutPerson(own.condition) : '') || DEFAULT_URGENT_CONDITION
  const condition = alsoPerson ? `${urgentCondition}\n${ALSO_PERSON}` : urgentCondition
  const renamed = own?.name === FALLBACK_OWNER_NAME && name.trim() ? freeName(transfers, name) : own?.name
  const contact: TransferContact = own
    ? { ...own, name: renamed!, number, condition, enabled: putThrough }
    : {
        id: URGENT_CONTACT_ID,
        name: freeName(others, name),
        number,
        condition,
        hours_only: false,
        ring_seconds: RING_SECONDS_DEFAULT,
        if_no_answer: 'message',
        enabled: true,
      }
  if (own) {
    const same =
      own.name === contact.name &&
      own.number === contact.number &&
      own.condition === contact.condition &&
      own.enabled === contact.enabled
    return same ? null : transfers.map(c => (c.id === URGENT_CONTACT_ID ? contact : c))
  }
  return others.some(isActiveContact) ? [...others, contact] : [contact, ...others]
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

/**
 * The area code for a new number: from the first of the numbers the owner already gave (the business phone, their
 * mobile) that is a US number with an area code a number can be bought in (not toll-free); empty without one, never a
 * made-up example.
 */
export function areaCodeOf(...numbers: (string | null | undefined)[]): string {
  for (const n of numbers) {
    const code = n ? toE164(n)?.slice(2, 5) : undefined
    if (code && usAreaCode(code)) return code
  }
  return ''
}

/**
 * Which step a refused save came from, so the error can name it and lead back there. Steps queue their saves and
 * move on, so a refusal arrives on a later step: the action and its input say where it came from when they can;
 * else the step the owner just left (`left`), where it was queued.
 */
export function rejectionStep(action: string, input: unknown, left: OnboardingStep | null): OnboardingStep | null {
  const has = (key: string) => typeof input === 'object' && input !== null && key in input
  if (action === 'assistant.update')
    return has('transfers') ? 'notify' : has('business_profile') ? 'business' : 'assistant'
  if (action === 'workspace.updateSettings' && has('pickupMode')) return 'pickup'
  if (action === 'workspace.rename' || action.startsWith('appointmentType.')) return 'business'
  if (action === 'notifications.update' || action.startsWith('push.')) return 'notify'
  if (action === 'phoneNumber.setup') return 'phone'
  if (action === 'sample.add') return 'done'
  if (action.startsWith('onboarding.')) return null
  return left
}

/** What a step saves, for "Couldn't save …: reason". */
export const stepSaves: Record<OnboardingStep, string> = {
  business: 'your business details',
  assistant: 'your assistant',
  pickup: 'when your assistant picks up',
  notify: 'who hears about calls',
  phone: 'the phone number',
  done: 'the sample calls',
}

/** What is left before calls are really answered, in the go-live checklist's words, with where it is done (null: nowhere this member can open). */
export type DoneLeft = { label: string; href: string | null }

/**
 * The last step, honest: "You're live" only when a number is connected, the voice service answers and, for a number
 * the business forwards to, forwarding is verified. Otherwise what is left, the next open item first; its link is
 * where the Done button leads. `voiceMissing`: the server says the voice service is not set up or is failing
 * (presence), only an instance admin can change that.
 * LIN-85 (#488): `forwardingVerified` and the items should come from the go-live checklist's state (inbox/goLive.ts)
 * once it is on main; until then nothing on the client knows forwarding is verified, so a forwarded number is never
 * called live here.
 */
export function doneState(facts: {
  number: Pick<PhoneNumber, 'e164' | 'mode'> | null
  voiceMissing: boolean
  forwardingVerified: boolean
  admin: boolean
  assistant: string
}): { live: boolean; title: string; lede: string; left: DoneLeft[] } {
  const { number, voiceMissing, forwardingVerified, admin, assistant } = facts
  const voice: DoneLeft = admin
    ? { label: 'Get the voice service working in Server admin › Providers', href: '#admin/providers/answering' }
    : { label: "The voice service isn't working yet: ask whoever runs this server", href: null }
  if (!number)
    return {
      live: false,
      title: 'Almost there.',
      lede: `${assistant} answers once your number is connected.`,
      left: [{ label: 'Connect your number', href: '#workspace/phone' }, ...(voiceMissing ? [voice] : [])],
    }
  const shown = formatNumber(number.e164)
  const forwarding = (number.mode === 'forward_conditional' || number.mode === 'forward_all') && !forwardingVerified
  const left: DoneLeft[] = [
    ...(forwarding ? [{ label: 'Turn on call forwarding', href: '#workspace/phone' }] : []),
    ...(voiceMissing ? [voice] : []),
  ]
  if (!left.length)
    return { live: true, title: "You're live.", lede: `${assistant} answers ${shown}. Calls land in your inbox.`, left }
  const once = [forwarding && 'forwarding is on', voiceMissing && 'the voice service works']
    .filter(Boolean)
    .join(' and ')
  return { live: false, title: 'Almost there.', lede: `${assistant} answers ${shown} once ${once}.`, left }
}
