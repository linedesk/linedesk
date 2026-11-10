import { z } from 'zod'
import { defineAction } from './define.ts'

/** The onboarding screens in order. `done` is the last one: reaching it finishes onboarding. */
export const onboardingSteps = ['business', 'phone', 'test_call', 'done'] as const
export type OnboardingStep = (typeof onboardingSteps)[number]
/** What a workspace stores: a step, or `skipped` when the owner left onboarding early. */
export type OnboardingProgress = OnboardingStep | 'skipped'

export const onboardingSetStep = defineAction({
  name: 'onboarding.setStep',
  description: 'Remember where the workspace is in onboarding, so a reload resumes there. `done` or `skipped` ends onboarding.',
  input: z.object({ step: z.enum([...onboardingSteps, 'skipped']) }),
  permission: 'settings:write',
})
