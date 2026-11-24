import { z } from 'zod'
import { defineAction } from './define.ts'
import { type BusinessKind, type BusinessTrait, traitsOf } from './business-kind.ts'

/**
 * The onboarding screens in order. `done` is the last one: reaching it finishes onboarding.
 * A new step goes in here at its place; the web app follows this list for order, progress and the step count.
 * `notify` is "Who hears about calls?": the owner's mobile for urgent calls and where call summaries go.
 * `activate` is only for a self-serve sign-up that has not started its trial (`pending_payment`): everything is set up before, the card is added there, and the number comes after it. Every other workspace
 * goes from `notify` straight to `phone` (stepsFor).
 */
export const onboardingSteps = ['business', 'assistant', 'pickup', 'notify', 'activate', 'phone', 'done'] as const
export type OnboardingStep = (typeof onboardingSteps)[number]

/**
 * The steps a workspace goes through: while it waits for its trial (`activating`), up to `activate` and no further
 * (no number before the card); otherwise every step but `activate`.
 */
export function onboardingStepsFor(activating: boolean): readonly OnboardingStep[] {
  const end = onboardingSteps.indexOf('activate')
  return activating ? onboardingSteps.slice(0, end + 1) : onboardingSteps.filter(s => s !== 'activate')
}

/**
 * The step a workspace opens at: the stored one, moved to where it can be. A stored `activate` after the trial started
 * opens the number; a step past `activate` (or none to resume) while the trial has not started opens `activate`.
 */
export function stepFor(stored: OnboardingStep, activating: boolean): OnboardingStep {
  const steps = onboardingStepsFor(activating)
  if (steps.includes(stored)) return stored
  return activating ? 'activate' : 'phone'
}
/** What a workspace stores: a step, or `skipped` when the owner left onboarding early. */
export type OnboardingProgress = OnboardingStep | 'skipped'

/** Steps of the earlier flow (business, phone, hours, calendar, test call), still stored by workspaces that stopped there. */
export const legacyOnboardingSteps = ['hours', 'calendar', 'test_call'] as const
export type LegacyOnboardingStep = (typeof legacyOnboardingSteps)[number]

/**
 * Where a workspace resumes: a current step as it is; an earlier flow's step at the step that took its place.
 * Hours became "When should Maya pick up?". The calendar left onboarding (it stays in Settings); that owner still
 * had the test call ahead, which moved into "Meet your assistant", so the calendar and the test call resume there.
 */
export function resumeStep(stored: OnboardingStep | LegacyOnboardingStep): OnboardingStep {
  if (stored === 'hours') return 'pickup'
  if (stored === 'calendar' || stored === 'test_call') return 'assistant'
  return stored
}

export const onboardingSetStep = defineAction({
  name: 'onboarding.setStep',
  description:
    'Remember where the workspace is in onboarding, so a reload resumes there. `done` or `skipped` ends onboarding. The steps of the earlier flow (hours, calendar, test_call) are still taken from a web app of the release before.',
  input: z.object({ step: z.enum([...onboardingSteps, ...legacyOnboardingSteps, 'skipped']) }),
  permission: 'settings:write',
})

/** The setup milestones only the web app sees; the API records the others itself (setup_events). */
export const clientSetupEvents = ['forwarding_instructions_shown'] as const

export const onboardingRecordEvent = defineAction({
  name: 'onboarding.recordEvent',
  description:
    'Record a setup milestone only the web app sees (the forwarding code was shown). Only the first time counts.',
  input: z.object({ event: z.enum(clientSetupEvents) }),
  permission: 'settings:write',
})

/**
 * The go-live checklist's steps (apps/web/src/inbox/goLive.ts). Not every workspace sees all of them: `voice` (the
 * server can answer calls: speech, language model and voice, or a realtime model, under Server admin › Providers) only
 * on an install where that is not set up.
 */
export const goLiveSteps = [
  'voice',
  'number',
  'forwarding',
  'first_call',
  'calendar',
  'shopify',
  'jobber',
  'support_email',
  'faq',
  'push',
  'team',
] as const
export type GoLiveStep = (typeof goLiveSteps)[number]
/**
 * Steps that can be marked "Not needed": all but the voice service and the number (without either nothing answers)
 * and the first real call (the point of going live). Those can only be put off ("Remind me") and tick themselves once true.
 */
export const skippableGoLiveSteps = [
  'forwarding',
  'calendar',
  'shopify',
  'jobber',
  'support_email',
  'faq',
  'push',
  'team',
] as const
/**
 * Whose each step is, the one place that says so. `workspace`: the business's setup, done once for everyone, and
 * "Not needed" hides it for every owner and admin. `person`: about the viewer's own devices (push on their phone);
 * done and "Not needed" are each person's own. "Remind me" is always the caller's own, whatever the scope.
 */
export const goLiveStepScope = {
  voice: 'workspace',
  number: 'workspace',
  forwarding: 'workspace',
  first_call: 'workspace',
  calendar: 'workspace',
  shopify: 'workspace',
  jobber: 'workspace',
  support_email: 'workspace',
  faq: 'workspace',
  push: 'person',
  team: 'workspace',
} as const satisfies Record<GoLiveStep, 'workspace' | 'person'>
export type GoLiveStepScope = (typeof goLiveStepScope)[GoLiveStep]

/**
 * Which businesses each step is for (LIN-680), the one place that says so: `all`, or the traits (business-kind.ts) of
 * which the business needs one. A step for an integration names the traits it serves, never kinds: a new kind gets
 * the right steps from its traits, and a new integration's step is one entry here (the Record makes it required).
 */
export const goLiveStepTraits = {
  voice: 'all',
  number: 'all',
  forwarding: 'all',
  first_call: 'all',
  calendar: ['appointments'],
  shopify: ['online_orders'],
  jobber: ['site_visits'],
  support_email: ['email_support'],
  faq: ['email_support'],
  push: 'all',
  team: 'all',
} as const satisfies Record<GoLiveStep, 'all' | readonly BusinessTrait[]>

/** Whether a step is for this kind of business (a workspace without a kind: as `other`, the steps it always had). */
export function goLiveStepFor(step: GoLiveStep, kind: BusinessKind | null | undefined): boolean {
  const wanted: 'all' | readonly BusinessTrait[] = goLiveStepTraits[step]
  if (wanted === 'all') return true
  const traits = traitsOf(kind)
  return wanted.some(t => traits.has(t))
}
/** "Remind me" brings a step back after this many days. */
export const goLiveRemindDays = [3, 7, 30] as const

/**
 * A step set aside. `skipped`: "Not needed", for the whole workspace or, for a person-scoped step (goLiveStepScope),
 * for the caller only. `later`: the caller's reminder ("Remind me"), put off until `until` (an ISO time; once passed the step is open again).
 */
export type GoLiveStepState = { step: GoLiveStep; state: 'skipped' | 'later'; until: string | null }

/**
 * `data` of `onboarding.goLiveChecklist`, for the go-live checklist in the inbox: what the browser cannot see in its
 * own store. `shown`: the workspace finished or left onboarding (older workspaces never get the checklist);
 * `forwardingVerified`: the forwarding check passed, or a real caller reached a number in a forwarding mode
 * (a forwarded call proves it works); `firstRealCall` from the setup milestones; `dismissed`: the caller closed it; `steps`: the steps marked not needed
 * (by the workspace, or by the caller for their own steps) and the ones the caller put off (missing from an API of the release before: then none).
 */
export type GoLiveChecklistData = {
  shown: boolean
  forwardingVerified: boolean
  firstRealCall: boolean
  dismissed: boolean
  steps?: GoLiveStepState[]
  /** The kind of business (goLiveStepFor picks the steps from it); null: never picked. Missing from an older API. */
  businessKind?: BusinessKind | null
  /**
   * The support mail's FAQ is reviewed: an analysis of the connected mailboxes finished and none of its topics is
   * still open (each accepted or dropped). Missing from an older API.
   */
  faqReviewed?: boolean
}

export const onboardingGoLiveChecklist = defineAction({
  name: 'onboarding.goLiveChecklist',
  description:
    'Read what the go-live checklist needs that is not synced: whether forwarding was verified, whether the first real call came in, whether you closed the checklist, and which steps are not needed or put off.',
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})

export const onboardingReopenGoLiveChecklist = defineAction({
  name: 'onboarding.reopenGoLiveChecklist',
  description: 'Show the go-live checklist in the inbox again after you closed it.',
  input: z.object({}),
  permission: 'settings:write',
})

export const onboardingDismissGoLiveChecklist = defineAction({
  name: 'onboarding.dismissGoLiveChecklist',
  description:
    'Close the go-live checklist in the inbox for yourself in this workspace. Reopen it from the command menu.',
  input: z.object({}),
  permission: 'settings:write',
})

export const onboardingSkipGoLiveStep = defineAction({
  name: 'onboarding.skipGoLiveStep',
  description:
    'Mark a go-live checklist step as not needed: for every owner and admin of the workspace, or only for you when the step is about your own devices (push). The voice service, connecting a number and the first real call cannot be skipped. Undo with onboarding.restoreGoLiveStep.',
  input: z.object({ step: z.enum(skippableGoLiveSteps) }),
  permission: 'settings:write',
})

export const onboardingRemindGoLiveStep = defineAction({
  name: 'onboarding.remindGoLiveStep',
  description:
    'Put a go-live checklist step off for yourself: it leaves the open steps and comes back by itself in 3, 7 or 30 days.',
  input: z.object({
    step: z.enum(goLiveSteps),
    days: z.union([z.literal(3), z.literal(7), z.literal(30)]),
  }),
  permission: 'settings:write',
})

export const onboardingRestoreGoLiveStep = defineAction({
  name: 'onboarding.restoreGoLiveStep',
  description:
    'Bring a go-live checklist step back into the open steps: clears its "Not needed" (the workspace\'s, or your own for a step about your own devices) and your own reminder.',
  input: z.object({ step: z.enum(goLiveSteps) }),
  permission: 'settings:write',
})
