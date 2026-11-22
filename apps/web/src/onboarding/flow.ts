// Onboarding without React: step order, the phone setup input and the carrier forwarding codes.
import {
  formatPhoneNumber,
  BASE_BUY_OFFERS,
  type BusinessHoursSpan,
  type BuyOffer,
  buyableAreaCode,
  buyingCountryOf,
  buyOfferIn,
  CARRIER_LABELS,
  completePhone,
  emergencyNumberOf,
  type ForwardingGuide,
  type ForwardingMode,
  forwardingInstructions,
  isActiveContact,
  type Language,
  localizedDefault,
  NUMBER_LIST_PRICES,
  nanpAreaCode,
  type OnboardingStep,
  type OutboundCountries,
  onboardingStepsFor,
  onCallNumberProblem,
  type PickupMode,
  type ProviderAudience,
  type ProviderName,
  phoneCountryName,
  phoneNumberProblem,
  providerFailureReasonOfText,
  providerFailureText,
  providerNames,
  providerSpec,
  RING_SECONDS_DEFAULT,
  TRANSFER_CONDITION_MAX,
  TRANSFER_CONTACTS_MAX,
  TRANSFER_NAME_MAX,
  type WorkspaceCountrySource,
  type WorkspaceSettingsData,
} from '@linedesk/actions'
import type { Assistant, PhoneNumber, TransferContact } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { brandName } from '../brand.ts'
import { i18n } from '../i18n/index.tsx'
import { providerAudience } from '../providerAudience.ts'
import { type DayHours, dayRows } from '../settings/businessHoursModel.ts'

type PhoneNumberMode = PhoneNumber['mode']

export type { OnboardingStep }

/** How a text key reads for whoever sets the workspace up (clientWords.tsx `useClientWord`); `same` keeps it. */
export type Words = (key: MessageKey) => MessageKey
const same: Words = key => key

/** The onboarding's steps once the trial runs (or off billing): every step but `activate`. */
export const onboardingSteps = onboardingStepsFor(false)

/**
 * The steps while the workspace waits for its trial (`pending_payment`): the setup, then `activate` (the card), and no
 * number before it.
 */
export const activationSteps = onboardingStepsFor(true)

/**
 * A white-label partner's draft client workspace set up by hand before White-label Cloud runs (setup before payment,
 * 2026-11-18): the free steps only; its last Continue goes back to the partner's setup, and the number follows the
 * partner's Checkout.
 */
export const partnerDraftSteps: readonly OnboardingStep[] = activationSteps.filter(s => s !== 'activate')

/**
 * The whole way of a trial sign-up as its step counter counts it: the setup, "Start your free trial",
 * then the number and Done. One count before and after the trial starts ("Step 5 of 7", then "Step 6 of 7").
 */
export const trialSteps: readonly OnboardingStep[] = [
  ...activationSteps,
  ...onboardingSteps.slice(onboardingSteps.indexOf('phone')),
]

/**
 * The steps a workspace goes through by hand (2026-11-18): a trial sign-up (its own bill: `trialSteps`, before and after
 * the card, so the count runs on and Back from the number passes "Start your free trial" as done); a partner's draft
 * client workspace (the free steps); else, off billing, the onboarding's.
 */
type StepsFor = {
  /** The steps gone through, Back and Continue. */
  steps: readonly OnboardingStep[]
  /** The steps the counter counts: a trial sign-up's whole way, also while it waits for the card. */
  counted: readonly OnboardingStep[]
  /** A white-label partner's draft client workspace. */
  draft: boolean
  /** Waiting for the trial's (or the plan's) Checkout: `activate` is the step that starts it. */
  activating: boolean
}

export function stepsFor(
  workspace:
    | { billingState?: 'pending_payment' | 'active' | 'suspended' | null; partnerManaged?: boolean }
    | null
    | undefined,
): StepsFor {
  const pending = workspace?.billingState === 'pending_payment'
  if (pending && workspace?.partnerManaged)
    return { steps: partnerDraftSteps, counted: partnerDraftSteps, draft: true, activating: false }
  if (pending) return { steps: activationSteps, counted: trialSteps, draft: false, activating: true }
  if (workspace?.billingState && !workspace.partnerManaged)
    return { steps: trialSteps, counted: trialSteps, draft: false, activating: false }
  return { steps: onboardingSteps, counted: onboardingSteps, draft: false, activating: false }
}

const DRAFT_FROM = 'linedesk.draftFrom.'

/**
 * Where a partner's client draft was opened (the partner's setup, the partner area, the partner's agent page), kept in
 * this tab across the reload the switch makes: its last step goes back there. Called by whatever opens the draft.
 */
export function rememberDraftOpenedFrom(workspaceId: string, hash: string, storage?: Storage) {
  try {
    ;(storage ?? sessionStorage).setItem(DRAFT_FROM + workspaceId, hash)
  } catch {
    // Storage off (a private window): the role decides, as before.
  }
}

/** Where the client draft `workspaceId` was opened in this tab, or null (then the partner role decides). */
export function draftOpenedFrom(workspaceId: string, storage?: Storage): string | null {
  try {
    const hash = (storage ?? sessionStorage).getItem(DRAFT_FROM + workspaceId)
    return hash?.startsWith('#partner') ? hash : null
  } catch {
    return null
  }
}

/** The steps' names (keys: a partner's team reads the client's words for some, clientWords.tsx). */
export const stepLabelKeys = {
  business: msg('onboarding.steps.business'),
  assistant: msg('onboarding.steps.assistant'),
  pickup: msg('onboarding.steps.pickup'),
  notify: msg('onboarding.steps.notify'),
  activate: msg('onboarding.steps.activate'),
  phone: msg('onboarding.steps.phone'),
  done: msg('onboarding.steps.done'),
} satisfies Record<OnboardingStep, MessageKey>

/** The step after `step` in `steps` (the onboarding's, or the ones step by step goes through again); the last stays. */
export const nextStep = (step: OnboardingStep, steps: readonly OnboardingStep[] = onboardingSteps): OnboardingStep =>
  steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)]!
/** The step before `step` in `steps`, or null on the first. */
export const previousStep = (
  step: OnboardingStep,
  steps: readonly OnboardingStep[] = onboardingSteps,
): OnboardingStep | null => steps[steps.indexOf(step) - 1] ?? null

/**
 * The steps "Step by step" (Workspace or Assistant settings › General) goes through again, with what is saved. The
 * workspace: everything the onboarding asks, the number too while it is not live yet (`numberOpen`: none connected,
 * or forwarding not verified; Janik, 2026-11-22), or when the pick-up choice just changed how a connected number
 * forwards (`forwardingChanged`: the new code must be dialled). One assistant: what is about it (the business it
 * answers for, its name, greeting and voice, what happens with its urgent calls), not the workspace's pick-up choice
 * or number. Never the end screen.
 */
export function stepByStepSteps(
  target: 'workspace' | 'assistant',
  forwardingChanged: boolean,
  numberOpen = false,
): OnboardingStep[] {
  if (target === 'assistant') return ['business', 'assistant', 'notify']
  return ['business', 'assistant', 'pickup', 'notify', ...(forwardingChanged || numberOpen ? (['phone'] as const) : [])]
}

/** What is not set up yet, per step: `true` where the step still needs the owner (unknown counts as done). */
export type OpenSteps = Partial<Record<OnboardingStep, boolean>>

/** Where "Step by step" opens: the first step that still needs the owner, else the first one. */
export const firstOpenStep = (steps: readonly OnboardingStep[], open: OpenSteps): OnboardingStep =>
  steps.find(step => open[step]) ?? steps[0]!

/**
 * One line of the activation step's timeline. `day` counts today as day 1, as the website's "No charge until day 15"
 * does: a 14-day trial's first charge is on day 15. The reminder emails are one line (`before`: the days before the
 * first charge each goes out, latest first, with their dates).
 */
export type TimelineEntry =
  | { kind: 'start'; day: number; at: Date }
  | { kind: 'reminders'; before: number[]; at: Date[] }
  | { kind: 'charge'; day: number; at: Date }

/**
 * The activation step's timeline: today the trial starts, the reminder emails `reminderDays`
 * before its end (one line), the first charge when it ends. Without a trial (a refused one): the charge today, nothing
 * else. The dates count from the first charge the server named, so they match what Checkout and the emails say.
 */
export function activationTimeline(
  a: { trialDays: number | null; firstChargeAt: string | null; reminderDays: readonly number[] },
  now: Date,
): TimelineEntry[] {
  if (!a.trialDays || !a.firstChargeAt) return [{ kind: 'charge', day: 1, at: now }]
  const end = Date.parse(a.firstChargeAt)
  const before = [...a.reminderDays].filter(d => d >= 1 && d < a.trialDays!).sort((x, y) => y - x)
  return [
    { kind: 'start', day: 1, at: now },
    ...(before.length
      ? [{ kind: 'reminders' as const, before, at: before.map(d => new Date(end - d * 86_400_000)) }]
      : []),
    { kind: 'charge', day: a.trialDays + 1, at: new Date(end) },
  ]
}

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

/**
 * Where Continue (`next`) or Back leads when the steps are gone through again from the settings: the next or previous
 * step, or `close` (back to the settings page) after the last step and before the first.
 */
export function stepByStepMove(
  steps: readonly OnboardingStep[],
  step: OnboardingStep,
  way: 'next' | 'back',
): OnboardingStep | 'close' {
  const at = steps.indexOf(step) + (way === 'next' ? 1 : -1)
  return steps[at] ?? 'close'
}

/** A US number as people type it ("(503) 555-0142", "503.555.0142", "+1 503 …") in E.164, or null. */
export function toE164(typed: string): string | null {
  const digits = typed.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

/**
 * A number typed in the phone field (E.164 as far as typed) in E.164 once it is whole, any country; or, from older
 * settings, a US number written without its country code ("(503) 555-0142"). Null while it is not a whole number.
 */
export function outboundE164(typed: string): string | null {
  const text = typed.trim()
  if (text.startsWith('+')) return completePhone(`+${text.replace(/\D/g, '')}`)
  return toE164(text)
}

/** +15035550142 → +1 503 555 0142, +493023125678 → +49 30 23125678 (formatPhoneNumber). */
export const formatNumber = (e164: string): string => formatPhoneNumber(e164)

/** A new number: by area code, or (`noAreaCode`: a national number) the first free one of the country. */
export type PhoneChoice =
  | { kind: 'existing'; number: string }
  | { kind: 'new'; areaCode: string; confirmed: boolean; noAreaCode?: boolean; offered?: readonly string[] }

type Forwarding = 'forward_conditional' | 'forward_all'

/**
 * An attached number is where the business's own number forwards to. A bought one is too when `forwarding` is given
 * (the business keeps its number and forwards to it); without, it is the business's new number to give out.
 */
export type PhoneSetupInput =
  | { e164: string; purchase: false; mode?: Forwarding }
  | { areaCode?: string; purchase: true; mode: 'new' | Forwarding }

/**
 * The `phoneNumber.setup` input for what the user picked, or why it cannot be sent yet.
 * Buying costs money, so a new number is only requested after the user confirmed the price.
 */
export function phoneSetupInput(
  choice: PhoneChoice,
  forwarding?: Forwarding,
): { input: PhoneSetupInput } | { problem: string } {
  if (choice.kind === 'existing') {
    // The phone field's value is E.164 in any country (phoneNumber.setup takes any); a number typed without its
    // country code is a US one.
    const typed = choice.number.trim()
    const international = typed.startsWith('+')
    const e164 = international ? completePhone(typed) : toE164(typed)
    if (e164) return { input: { e164, purchase: false, ...(forwarding ? { mode: forwarding } : {}) } }
    return {
      problem: (international && phoneNumberProblem(typed, i18n())) || i18n().t('onboarding.flow.problem.enterNumber'),
    }
  }
  // The area code is one of the picker's: the offer's listed codes (Germany: 6221), else AREA_CODES of the US, Canada
  // and Puerto Rico. The server checks it again.
  const picked = choice.offered ? choice.offered.includes(choice.areaCode) : !!buyableAreaCode(choice.areaCode)
  if (!choice.noAreaCode && !picked) return { problem: i18n().t('onboarding.flow.problem.pickAreaCode') }
  if (!choice.confirmed) return { problem: i18n().t('onboarding.flow.problem.confirmCost') }
  const area = choice.noAreaCode ? {} : { areaCode: choice.areaCode }
  return { input: { ...area, purchase: true, mode: forwarding ?? 'new' } }
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

/** The buy offers of the phone setup status (numberBuyOffers on the server); the base ones from an older server. */
export const buyOffersOf = (status: { buy?: readonly BuyOffer[] } | null | undefined): readonly BuyOffer[] =>
  status?.buy ?? BASE_BUY_OFFERS

/**
 * Whether the phone step and Settings › Phone numbers offer buying a number: only in a country of the install's buy
 * offers that is ready (the server refuses the rest). While the workspace country loads (null): yes, as before.
 */
export const offersBuying = (country: string | null, offers: readonly BuyOffer[] = BASE_BUY_OFFERS): boolean =>
  country === null || buyOfferIn(offers, country)?.ready === true

/**
 * Whether numbers in the workspace's country are turned on on this server but not set up at the carrier yet: the
 * phone step says so calmly instead of offering to buy (the server alerts its operator).
 */
export const numbersBeingSetUp = (country: string | null, offers: readonly BuyOffer[] = BASE_BUY_OFFERS): boolean =>
  buyOfferIn(offers, country)?.ready === false

/** The line shown while numbers in the country are being set up (numbersBeingSetUp). */
export const beingSetUpText = (): string => i18n().t('onboarding.flow.numbersBeingSetUp')

/**
 * The country the number picker buys in: the country the owner was shown (buyingCountryOf, the same rule as the
 * server's purchaseCountry, LIN-645): the workspace's once something names it (country, a number, the business phone,
 * holidays), or the hint it was made with when the install has a buy offer there (a German business left on its hint
 * sees 06221 or that numbers are being set up, never US area codes). Else null: every buyable area code is offered and
 * the one picked names the country; the bought number then sets the workspace's country. Not the US by default, so a
 * business in Puerto Rico or Canada with nothing set yet still finds its own codes.
 */
export const buyingCountry = (
  place: { country: string; source: WorkspaceCountrySource } | null,
  offers: readonly BuyOffer[] = BASE_BUY_OFFERS,
): string | null => buyingCountryOf(place, offers)

/** The country whose price the note shows: that of the picked (North American) area code, else the workspace's. */
export const priceCountry = (areaCode: string, country: string | null): string | null =>
  buyableAreaCode(areaCode)?.country ?? country

/**
 * The countries numbers can be bought in now (the ready buy offers), named in the reader's language as a list
 * ("the United States, Canada and Puerto Rico" reads "United States, Canada, and Puerto Rico").
 */
export function buyCountriesText(offers: readonly BuyOffer[] = BASE_BUY_OFFERS): string {
  const words = i18n()
  return words.format.list(offers.filter(o => o.ready).map(o => phoneCountryName(o.country, words)))
}

/**
 * The line shown instead of buying outside those countries. `canAttach` false: the install's carrier account is for
 * instance admins only, so a number the business has needs its own carrier account first.
 */
export function buyUnavailableText(
  carrier: string | null,
  canAttach: boolean,
  offers: readonly BuyOffer[] = BASE_BUY_OFFERS,
): string {
  const { t } = i18n()
  const countries = buyCountriesText(offers)
  if (!canAttach) return t('onboarding.flow.buyOnlyIn.ownCarrier', { countries })
  return carrier
    ? t('onboarding.flow.buyOnlyIn.inCarrier', { carrier, countries })
    : t('onboarding.flow.buyOnlyIn.withCarrier', { countries })
}

/** The link under the cards to the `existing` option, naming the install's carrier when it has one. */
export const existingLinkText = (carrier: string | null): string =>
  carrier ? i18n().t('onboarding.flow.existingLinkIn', { carrier }) : i18n().t('onboarding.flow.existingLink')

/** The `phoneNumber.setup` choice and forwarding for a phone step option. */
export function phoneOptionSetup(
  option: PhoneOption,
  fields: { number: string; areaCode: string; confirmed: boolean; noAreaCode?: boolean; offered?: readonly string[] },
  forwarding: Forwarding,
): { input: PhoneSetupInput } | { problem: string } {
  if (option === 'existing') return phoneSetupInput({ kind: 'existing', number: fields.number }, forwarding)
  const choice = {
    kind: 'new' as const,
    areaCode: fields.areaCode,
    confirmed: fields.confirmed,
    ...(fields.noAreaCode ? { noAreaCode: true } : {}),
    ...(fields.offered ? { offered: fields.offered } : {}),
  }
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
  /** A partner setting up a client's workspace reads the client's words (clientWords.tsx); else the keys as they are. */
  word: Words = same,
): { title: string; description: string } {
  const { t } = i18n()
  if (option === 'forward')
    return {
      title: t(word(msg('onboarding.flow.option.forward.title')), { brand: brandName() }),
      description: t(word(msg('onboarding.flow.option.forward.description')), { name, brand: brandName() }),
    }
  if (option === 'existing')
    return {
      title: carrier
        ? t('onboarding.flow.option.existing.titleIn', { carrier })
        : t('onboarding.flow.option.existing.title'),
      description: t(word(msg('onboarding.flow.option.existing.description')), { name }),
    }
  return {
    title: t(word(msg('onboarding.flow.option.new.title')), { brand: brandName() }),
    description: t(word(msg('onboarding.flow.option.new.description')), { name }),
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
  const { t } = i18n()
  if (/^phone setup is not configured/i.test(error))
    return audience === 'admin'
      ? t('onboarding.flow.setupError.notConfiguredAdmin')
      : t('onboarding.flow.setupError.notConfigured')
  if (/is already set up/i.test(error)) return t('onboarding.flow.setupError.alreadyConnected', { brand: brandName() })
  // Outside the countries numbers can be bought in (apps/api/src/number-purchases.ts, buyCountryRefusal).
  if (/^Buying numbers is not available in this country/i.test(error)) return buyUnavailableText(null, true)
  // Turned on but not set up at the carrier yet, or none in stock (apps/api/src/number-buy.ts).
  if (/^Numbers in this country are being set up/i.test(error)) return beingSetUpText()
  // An area code of another country than the workspace's, or not offered there (areaCodeCountryRefusal).
  if (
    /^Area code \d+ (is in .*, but this workspace is in |is not offered in |is not one a number can be bought in)/i.test(
      error,
    )
  )
    return t('onboarding.flow.setupError.areaCodeCountry')
  // A typed number of another country (numberCountryRefusal).
  if (/^Number \+\d+ (is in .*|has no country), but this workspace is in /i.test(error))
    return t('onboarding.flow.setupError.numberCountry')
  // The carrier needs documents for the country, or an order did not complete (NUMBERS_NEED_DOCUMENTS,
  // NUMBER_NOT_ACTIVATED): trying again does not help, so neither says to.
  if (/^Numbers in this country can't be bought here yet/i.test(error))
    return t('onboarding.flow.setupError.countryRequirements')
  if (/^This number could not be activated/i.test(error)) return t('onboarding.flow.setupError.notActivated')
  if (/is not in the .* account/i.test(error)) return t('onboarding.flow.setupError.notInAccount')
  // A number already in the server's carrier account, for someone who is not an instance admin (attachRefused).
  if (/can only be connected by whoever runs this server/i.test(error))
    return t('onboarding.flow.setupError.attachBilled')
  if (/no number available in area code/i.test(error)) return t('onboarding.flow.setupError.noneFree')
  // The limits on buying through the install's carrier account (apps/api/src/number-purchases.ts) are written for people: shown as they are.
  if (/(on|through) this server|this server has given|numbers today/i.test(error)) return error
  const reason = providerFailureReasonOfText(error)
  // A refused setting, an unknown number and anything else are about this request: the cases above and the default.
  // The provider-failure sentences are the shared package's (@linedesk/actions), English for now, so is their label.
  if (reason !== 'config' && reason !== 'not_found' && reason !== 'unknown')
    return providerFailureText(reason, t('onboarding.flow.phoneCarrier'), audience, i18n())
  return t('onboarding.flow.setupError.failed')
}

/** Whether a text from phoneSetupErrorText says the area code has no free number: the nearby codes are offered then. */
export const isNoneFreeText = (text: string | null): boolean =>
  text !== null && text === i18n().t('onboarding.flow.setupError.noneFree')

/** How calls reach a connected number's assistant, in a few words: what the mode does, not its name. */
export const numberModeLabel: Record<PhoneNumberMode, string> = {
  get forward_conditional() {
    return i18n().t('onboarding.flow.callsReach.forwardConditional')
  },
  get forward_all() {
    return i18n().t('onboarding.flow.callsReach.forwardAll')
  },
  get new() {
    return i18n().t('onboarding.flow.callsReach.new')
  },
  get ported() {
    return i18n().t('onboarding.flow.callsReach.ported', { brand: brandName() })
  },
}

/** What a new number costs, as far as we know it: the carrier's list price for a local number in `country` (default the US). */
export function priceNote(provider: string | null, country: string | null = null): string {
  const { t, format } = i18n()
  if (provider === 'dev') return t('onboarding.flow.price.dev')
  const carrier = provider ? CARRIER_LABELS[provider] : undefined
  const amount = provider ? NUMBER_LIST_PRICES[provider]?.[(country ?? 'US').toUpperCase()] : undefined
  if (!carrier) return t('onboarding.flow.price.unknown')
  if (amount === undefined) return t('onboarding.flow.price.carrierUnknown', { carrier })
  return t('onboarding.flow.price.carrier', {
    price: format.currency(amount, 'USD', { minimumFractionDigits: amount % 1 ? 2 : 0 }),
    carrier,
  })
}

/**
 * The price line under the area code on a workspace that is on a bill (Linedesk Cloud) and buys on the install's
 * carrier account: the first number of the workspace is included in the plan, each
 * further one costs `extraNumberCents` a month from the balance. Null where the carrier's list price applies instead
 * (off billing, a comped bill, the workspace's own carrier account: the caller passes null; development mode).
 * `numbersBought`: the workspace's numbers bought on the install's carrier account.
 */
export function billedNumberNote(
  extraNumberCents: number | null,
  provider: string | null,
  numbersBought: number,
): string | null {
  if (extraNumberCents === null || provider === 'dev') return null
  const price = billedNumberPrice(extraNumberCents, provider, numbersBought)
  if (!price) return i18n().t('onboarding.flow.price.included')
  return i18n().t('onboarding.flow.price.extra', { price })
}

/**
 * What the next number costs a month from the bill's balance, formatted ("$3"), for Settings › Phone numbers to show
 * large: `extraNumberCents` from the install's billing rules. Null where billedNumberNote says something else (no bill,
 * comped, own carrier account, development mode) or the number is the included first one.
 */
export function billedNumberPrice(
  extraNumberCents: number | null,
  provider: string | null,
  numbersBought: number,
): string | null {
  if (extraNumberCents === null || provider === 'dev' || numbersBought < 1) return null
  return i18n().format.currency(extraNumberCents / 100, 'USD', {
    minimumFractionDigits: extraNumberCents % 100 ? 2 : 0,
  })
}

/**
 * What the number about to be bought costs, for the question before buying: `included` (the first number on a bill),
 * the extra number's monthly price from the bill's balance ("$3"), or null where the carrier bills it (no bill, a
 * comped bill, the workspace's own carrier account) or nothing is billed (development mode). The same inputs as
 * billedNumberNote, so the note and the question never disagree.
 */
export function numberCharge(
  extraNumberCents: number | null,
  provider: string | null,
  numbersBought: number,
): 'included' | string | null {
  if (extraNumberCents === null || provider === 'dev') return null
  return billedNumberPrice(extraNumberCents, provider, numbersBought) ?? 'included'
}

/**
 * The question before buying. In development mode nothing is bought or billed; the note under the field says so once
 * (priceNote), so the question doesn't repeat it. `charge` (numberCharge): the included first number says so instead
 * of a monthly charge; an extra one names its price from the balance; null keeps the carrier's monthly charge.
 */
export function buyQuestion(
  provider: string | null,
  areaCode: string,
  charge: 'included' | string | null = null,
): string {
  const { t } = i18n()
  // A national number has no area code (noAreaCode): the question names none.
  if (!areaCode)
    return provider === 'dev'
      ? t('onboarding.flow.buyQuestionDevNoArea')
      : charge === 'included'
        ? t('onboarding.flow.buyQuestionIncludedNoArea')
        : charge
          ? t('onboarding.flow.buyQuestionExtraNoArea', { price: charge })
          : t('onboarding.flow.buyQuestionNoArea')
  if (provider === 'dev') return t('onboarding.flow.buyQuestionDev', { areaCode })
  if (charge === 'included') return t('onboarding.flow.buyQuestionIncluded', { areaCode })
  if (charge) return t('onboarding.flow.buyQuestionExtra', { areaCode, price: charge })
  return t('onboarding.flow.buyQuestion', { areaCode })
}

/**
 * The bill's extra-number price applies only to numbers bought on the install's carrier account: a workspace on its
 * own carrier account pays its carrier (the carrier's price shows instead), in onboarding as in Settings › Phone
 * numbers. `status.account` from the phone setup status; absent (an older server) counts as the install's.
 */
export const billedExtraNumberCents = (
  extraNumberCents: number | null | undefined,
  status: { account?: 'install' | 'workspace' } | null | undefined,
): number | null => (status?.account === 'workspace' ? null : (extraNumberCents ?? null))

/**
 * The line that asks to turn an earlier forwarding off before the new one (the pick-up choice changed after the code
 * was shown), with that forwarding's off codes or where to change it.
 */
export function turnOffFirst(guide: ForwardingGuide, earlier: ForwardingMode, e164: string, country?: string): string {
  const steps = forwardingInstructions(guide, earlier, e164, country)
  const { t, format } = i18n()
  if (!steps) return t('onboarding.flow.turnOff.unknown')
  if (steps.how === 'dial') {
    const codes = format.list(
      steps.off.map(c => c.code),
      { type: 'unit', style: 'short' },
    )
    return t('onboarding.flow.turnOff.dial', { codes })
  }
  return t('onboarding.flow.turnOff.where', { where: steps.where })
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

/**
 * The greeting the assistant step shows when the language it greets in changes while the step is open (the workspace
 * settings arrive, or their country changed): the saved greeting's default in the new language, while what is shown is
 * still the default in the old one. A greeting the owner changed stays.
 */
export function greetingInLanguage(shown: string, saved: string, from: Language, to: Language): string {
  return from !== to && shown === localizedDefault(saved, from) ? localizedDefault(saved, to) : shown
}

/** What the assistant step edits. */
export type AssistantDraft = {
  name: string
  greeting: string
  voice: { provider: string; voice_id: string }
  /** The voice while the realtime model answers (REALTIME_VOICE_IDS); '': the server's default. Missing: not edited. */
  realtime_voice?: string
}

/**
 * The `assistant.update` fields that differ from the saved assistant, or null when nothing changed. Names and
 * greetings are trimmed; an empty name or greeting is not saved (the step asks for both). A rename also renames the
 * saved name in the greeting, once, on save ("This is Maya" → "This is Ava").
 */
export function assistantChanges(
  saved: Pick<Assistant, 'name' | 'greeting' | 'voice'> & { realtime_voice?: string },
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
  if (draft.realtime_voice !== undefined && draft.realtime_voice !== (saved.realtime_voice ?? ''))
    changes.realtime_voice = draft.realtime_voice
  return Object.keys(changes).length ? changes : null
}

/** The transfer contact the "Urgent calls" step owns: the owner's mobile for urgent calls. */
export const URGENT_CONTACT_ID = 'urgent'
/** The contact every new assistant has for callers who ask for a person (DEFAULT_TRANSFERS). */
const PERSON_CONTACT_ID = 'person'
/** What counts as urgent until the owner says otherwise. */
// i18n-ignore: stored on the contact for the assistant, like DEFAULT_TRANSFERS (server-side text)
export const DEFAULT_URGENT_CONDITION = 'An urgent problem that cannot wait until we call back'
/**
 * The second line of the step's contact when it took over the "asks for a person" contact (one without a number):
 * the owner's mobile serves both, one contact. The step shows and edits only the line before it.
 */
// i18n-ignore: stored on the contact and matched again later (server-side text)
export const ALSO_PERSON = 'Also: the caller asks to speak to a person.'
const withoutPerson = (condition: string) =>
  condition.endsWith(ALSO_PERSON) ? condition.slice(0, -ALSO_PERSON.length).trim() : condition
/** The contact's name while the member's own name is not known (yet); replaced once it is. */
// i18n-ignore: stored as the contact's name until the member's own is known (server-side text)
export const FALLBACK_OWNER_NAME = 'the owner'

/**
 * What happens when a caller has an urgent matter: put through to the owner's mobile (the step's contact, on), or a
 * message the owner is alerted to right away (the contact off, or none). A first visit starts at "Take a message and
 * alert me" (decision of 2026-11-17): it needs no number, so Continue works at once; null only in a draft built by hand.
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
    urgent: 'message',
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

/**
 * The fixed line under "Urgent means": emergencies are not the business's to handle (EMERGENCY_RULE in the prompt), with
 * the emergency number of the workspace country (911 in the US).
 */
export const EMERGENCY_NOTE = (name: string, country = 'US') =>
  i18n().t('onboarding.flow.emergencyNote', { name, emergency: emergencyNumberOf(country) })

/** What is wrong, and where: no choice made, the mobile field, the condition, or the contact list itself. */
export type WhoHearsProblem = { field: 'choice' | 'mobile' | 'condition' | 'list'; message: string }

/**
 * Why the step cannot be saved as it is, in words for the owner; null when it can. Only "put through" asks for a
 * number; "take a message" needs nothing more (a number typed before switching to it is not shown, so not checked).
 */
export function whoHearsProblem(
  draft: WhoHearsDraft,
  transfers: readonly TransferContact[] = [],
  /** The countries the workspace may call (outbound.countries); `any` until it has a number. */
  countries: OutboundCountries = 'any',
): WhoHearsProblem | null {
  const { t } = i18n()
  if (!draft.urgent) return { field: 'choice', message: t('onboarding.flow.whoHears.choose') }
  if (draft.urgent === 'message') return null
  const typed = draft.mobile.trim()
  if (!typed) return { field: 'mobile', message: t('onboarding.flow.whoHears.enterMobile') }
  const e164 = outboundE164(typed)
  if (!e164)
    return {
      field: 'mobile',
      message:
        (typed.startsWith('+') && phoneNumberProblem(typed, i18n())) || t('onboarding.flow.whoHears.mobileAreaCode'),
    }
  const problem = onCallNumberProblem(e164, countries, 'transfer', i18n())
  if (problem) return { field: 'mobile', message: problem }
  if (!transfers.some(c => c.id === URGENT_CONTACT_ID) && transfers.length >= TRANSFER_CONTACTS_MAX)
    return {
      field: 'list',
      message: t('onboarding.flow.whoHears.listFull', { max: TRANSFER_CONTACTS_MAX }),
    }
  if (!draft.condition.trim()) return { field: 'condition', message: t('onboarding.flow.whoHears.sayWhich') }
  // Room for the "asks for a person" line the contact may carry too.
  const max = TRANSFER_CONDITION_MAX - ALSO_PERSON.length - 1
  if (draft.condition.trim().length > max)
    return { field: 'condition', message: t('onboarding.flow.whoHears.tooLong', { max }) }
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
  const number = putThrough ? outboundE164(draft.mobile) : (own?.number ?? null)
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
        briefing: true,
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
  const { t } = i18n()
  if (/confirm your email/i.test(error)) return t('onboarding.flow.mobileError.confirmEmail')
  if (error.includes(`${name}'s number is a `))
    return t('onboarding.flow.mobileError.ownNumber', { brand: brandName() })
  if (error.includes(`${name}'s number forwards its calls to`))
    return t('onboarding.flow.mobileError.forwards', { brand: brandName() })
  return error
}

/**
 * The area code for a new number: from the first of the numbers the owner already gave (the business phone, their
 * mobile) that is a valid North American number with an area code a number can be bought in (not toll-free) in the
 * workspace's `country` (null while it loads: any of them); empty without one, never a made-up example. Another
 * country's number gives none (+4930123456 is not area code 493).
 */
export function areaCodeOf(country: string | null, ...numbers: (string | null | undefined)[]): string {
  for (const n of numbers) {
    const code = nanpAreaCode(n)
    if (code && areaCodeIn(code, country)) return code
  }
  return ''
}

/**
 * Whether a number can be bought in `code` by a workspace in `country` (null while it loads: any buyable North
 * American code): one of the country's offered codes (Germany), else of AREA_CODES in that country.
 */
export function areaCodeIn(
  code: string,
  country: string | null,
  offers: readonly BuyOffer[] = BASE_BUY_OFFERS,
): boolean {
  const listed = buyOfferIn(offers, country)?.areaCodes
  if (listed) return listed.includes(code)
  const area = buyableAreaCode(code)
  return !!area && (country === null || area.country === country.toUpperCase())
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

/**
 * What is left before calls are really answered, in the go-live checklist's words, and where it is done without
 * leaving the walkthrough (design-principles.md rule 14): `phone`, back to the phone step (the number, the forwarding
 * codes); `admin`, Server admin in place (an instance admin, InstanceSetup.tsx), which returns to this step; null,
 * nowhere this member can go (ask whoever runs the server).
 */
export type DoneLeft = { label: string; to: { step: 'phone' } | { admin: string } | null; action: string | null }

/**
 * The last step, honest: "You're live" only when a number is connected, the voice service answers and, for a number
 * the business forwards to, forwarding is verified. Otherwise what is left, each with the way to it. `voiceMissing`:
 * the server says the voice service is not set up or is failing (presence), only an instance admin can change that.
 * LIN-85 (#488): `forwardingVerified` and the items should come from the go-live checklist's state (inbox/goLive.ts)
 * once it is on main; until then nothing on the client knows forwarding is verified, so a forwarded number is never
 * called live here.
 */
export function doneState(
  facts: {
    number: Pick<PhoneNumber, 'e164' | 'mode'> | null
    voiceMissing: boolean
    forwardingVerified: boolean
    admin: boolean
    assistant: string
  },
  word: Words = same,
): { live: boolean; title: string; lede: string; left: DoneLeft[] } {
  const { number, voiceMissing, forwardingVerified, admin, assistant } = facts
  const { t } = i18n()
  const voice: DoneLeft = admin
    ? {
        label: t('onboarding.flow.done.voiceAdmin'),
        to: { admin: '#admin/providers/answering' },
        action: t('onboarding.flow.done.open'),
      }
    : { label: t('onboarding.flow.done.voiceMember'), to: null, action: null }
  if (!number)
    return {
      live: false,
      title: t('onboarding.flow.done.almost'),
      lede: t(word(msg('onboarding.flow.done.answersOnceConnected')), { assistant }),
      left: [
        {
          label: t(word(msg('onboarding.flow.done.connectNumber'))),
          to: { step: 'phone' },
          action: t('onboarding.flow.done.connect'),
        },
        ...(voiceMissing ? [voice] : []),
      ],
    }
  const shown = formatNumber(number.e164)
  const forwarding = (number.mode === 'forward_conditional' || number.mode === 'forward_all') && !forwardingVerified
  const left: DoneLeft[] = [
    ...(forwarding
      ? [
          {
            label: t('onboarding.flow.done.turnOnForwarding'),
            to: { step: 'phone' as const },
            action: t('onboarding.flow.done.showHow'),
          },
        ]
      : []),
    ...(voiceMissing ? [voice] : []),
  ]
  const values = { assistant, number: shown }
  if (!left.length)
    return { live: true, title: t('onboarding.flow.done.live'), lede: t('onboarding.flow.done.liveLede', values), left }
  const lede =
    forwarding && voiceMissing
      ? t('onboarding.flow.done.onceBoth', values)
      : forwarding
        ? t('onboarding.flow.done.onceForwarding', values)
        : t('onboarding.flow.done.onceVoice', values)
  return { live: false, title: t('onboarding.flow.done.almost'), lede, left }
}
