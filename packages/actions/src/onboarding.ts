import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * The onboarding screens in order. `done` is the last one: reaching it finishes onboarding.
 * A new step goes in here at its place (e.g. who hears about calls, between `pickup` and `phone`); the web app
 * follows this list for order, progress and the step count.
 */
export const onboardingSteps = ['business', 'assistant', 'pickup', 'phone', 'done'] as const
export type OnboardingStep = (typeof onboardingSteps)[number]
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
