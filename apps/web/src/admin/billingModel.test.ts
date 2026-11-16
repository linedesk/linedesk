// Server admin › Billing: dollars typed by the admin, the reason rule and the rules editor's form.
import { expect, test } from 'vitest'
import { BILLING_DEFAULTS } from '@linedesk/db/types'
import { parseCount, parseDollars, reasonProblem, rulesForm, rulesFromForm } from './billingModel.ts'

test('dollars become whole cents; a typo, zero or a negative where none is allowed is refused', () => {
  expect(parseDollars('20')).toEqual({ cents: 2000 })
  expect(parseDollars(' $1,250.5 ')).toEqual({ cents: 125050 })
  expect(parseDollars('0.07')).toEqual({ cents: 7 })
  expect(parseDollars('-3', { negative: true })).toEqual({ cents: -300 })
  expect(parseDollars('-$3', { negative: true })).toEqual({ cents: -300 })
  expect(parseDollars('0', { zero: true })).toEqual({ cents: 0 })
  expect(parseDollars('-3')).toHaveProperty('problem')
  expect(parseDollars('0')).toHaveProperty('problem')
  expect(parseDollars('1.234')).toHaveProperty('problem')
  expect(parseDollars('abc')).toHaveProperty('problem')
  expect(parseDollars('')).toHaveProperty('problem')
  expect(parseDollars('100000.01')).toHaveProperty('problem')
  expect(parseDollars('100000')).toEqual({ cents: 10_000_000 })
})

test('a count is a whole number in range; empty only where it means "the rules"', () => {
  expect(parseCount('5', 1, 1000)).toEqual({ value: 5 })
  expect(parseCount('', 1, 1000, { empty: true })).toEqual({ value: null })
  expect(parseCount('', 1, 1000)).toHaveProperty('problem')
  expect(parseCount('0', 1, 1000)).toHaveProperty('problem')
  expect(parseCount('2.5', 1, 1000)).toHaveProperty('problem')
  expect(parseCount('1001', 1, 1000)).toHaveProperty('problem')
})

test('a reason is 3 to 500 characters once trimmed', () => {
  expect(reasonProblem('  ab ')).not.toBeNull()
  expect(reasonProblem('Goodwill for an outage')).toBeNull()
  expect(reasonProblem('x'.repeat(501))).not.toBeNull()
})

test('the rules form round-trips the defaults to nothing stored', () => {
  const form = rulesForm(BILLING_DEFAULTS)
  expect(form['levels.standard.price']).toBe('0.05')
  expect(form['levels.ultra.factor']).toBe('')
  expect(form.balanceBufferMicros).toBe('5')
  expect(form.extraNumberCents).toBe('3')
  expect(rulesFromForm(form, BILLING_DEFAULTS)).toEqual({ rules: {}, problems: [] })
})

test('only what differs from the defaults is stored, in the units the server takes; a changed level whole', () => {
  const form = {
    ...rulesForm(BILLING_DEFAULTS),
    'levels.premium.price': '0.12',
    trialConcurrentCalls: '3',
    balanceBufferMicros: '2.5',
    extraNumberCents: '4.50',
  }
  expect(rulesFromForm(form, BILLING_DEFAULTS)).toEqual({
    rules: {
      trialConcurrentCalls: 3,
      balanceBufferMicros: 2_500_000,
      extraNumberCents: 450,
      levels: { premium: { microsPerMinute: 120_000, allowanceFactor: 2 } },
    },
    problems: [],
  })
})

test('a field that is not a number in its unit is named, and nothing is sent', () => {
  const form = { ...rulesForm(BILLING_DEFAULTS), trialConcurrentCalls: '2.5', 'levels.standard.price': 'cheap' }
  expect(rulesFromForm(form, BILLING_DEFAULTS)).toEqual({
    problems: ['trialConcurrentCalls', 'levels.standard.price'],
  })
})
