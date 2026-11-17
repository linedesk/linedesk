// The sign-up page's plan line (signup.ts): the trial and the price at the interval picked in the address, from the
// install's prices in /v1/signup/config, never written into the page.
import { expect, test } from 'vitest'
import { planWords, signupPlanLine } from './signup.ts'

const plan = { monthlyCents: 1100, yearlyCents: 10_800, trialDays: 14 }

test('the plan in words: the price per workspace and how it is billed', () => {
  expect(planWords('year', 10_800)).toBe('$108 per workspace, billed yearly ($9 a month)')
  expect(planWords('month', 1100)).toBe('$11 per workspace, billed monthly')
  expect(planWords('month', 1250)).toBe('$12.50 per workspace, billed monthly')
})

test('the sign-up line: the trial, then the plan at the interval picked', () => {
  expect(signupPlanLine(plan, 'year')).toBe('14-day free trial, then $108 per workspace, billed yearly ($9 a month).')
  expect(signupPlanLine(plan, 'month')).toBe('14-day free trial, then $11 per workspace, billed monthly.')
  expect(signupPlanLine({ ...plan, monthlyCents: 1500, trialDays: 0 }, 'month')).toBe(
    'Plan: $15 per workspace, billed monthly.',
  )
})
