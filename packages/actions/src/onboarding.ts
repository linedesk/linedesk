import { z } from 'zod'
import { defineAction } from './define.ts'

/** The onboarding screens in order. `done` is the last one: reaching it finishes onboarding. */
export const onboardingSteps = ['business', 'phone', 'hours', 'calendar', 'test_call', 'done'] as const
export type OnboardingStep = (typeof onboardingSteps)[number]
/** What a workspace stores: a step, or `skipped` when the owner left onboarding early. */
export type OnboardingProgress = OnboardingStep | 'skipped'

export const onboardingSetStep = defineAction({
  name: 'onboarding.setStep',
  description:
    'Remember where the workspace is in onboarding, so a reload resumes there. `done` or `skipped` ends onboarding.',
  input: z.object({ step: z.enum([...onboardingSteps, 'skipped']) }),
  permission: 'settings:write',
})

/** The setup milestones only the web app sees; the API records the others itself (setup_events). */
export const clientSetupEvents = ['forwarding_instructions_shown'] as const

export const onboardingRecordEvent = defineAction({
  name: 'onboarding.recordEvent',
  description: 'Record a setup milestone only the web app sees (the forwarding code was shown). Only the first time counts.',
  input: z.object({ event: z.enum(clientSetupEvents) }),
  permission: 'settings:write',
})
