import { DEFAULT_CALL_RULES } from '@callfront/actions'
import type { Assistant } from '@callfront/db/types'
import { expect, test } from 'vitest'
import { buildInstructions } from './prompt.ts'

const assistant = (over: Partial<Assistant> = {}) =>
  ({ name: 'Maya', greeting: 'Thanks for calling Brightwater.', disclose_ai: false, business_profile: { instructions: 'We fix pipes in Portland.' }, call_rules: null, ...over }) as Assistant

test('without stored rules the default call rules apply: message only, no booking, no prices, urgent flagged', () => {
  const prompt = buildInstructions(assistant())
  expect(prompt).toContain(`How to handle calls:\n${DEFAULT_CALL_RULES}`)
  expect(prompt).toContain('What the business wants you to know:\nWe fix pipes in Portland.')
  expect(DEFAULT_CALL_RULES).toMatch(/Take a message for every request/)
  expect(DEFAULT_CALL_RULES).toMatch(/you cannot book them/)
  expect(DEFAULT_CALL_RULES).toMatch(/do not quote prices/)
  expect(DEFAULT_CALL_RULES).toMatch(/flag the call as urgent/)
})

test('the owner\'s rules replace the default; blank rules mean the default', () => {
  expect(buildInstructions(assistant({ call_rules: 'Always ask for the address.' }))).toContain('How to handle calls:\nAlways ask for the address.')
  expect(buildInstructions(assistant({ call_rules: 'Always ask for the address.' }))).not.toContain(DEFAULT_CALL_RULES)
  expect(buildInstructions(assistant({ call_rules: '  ' }))).toContain(DEFAULT_CALL_RULES)
})

test('says it is an AI when asked, whatever the greeting setting and the owner\'s rules', () => {
  for (const a of [assistant(), assistant({ disclose_ai: true }), assistant({ call_rules: 'Say you are Mike.' })]) {
    expect(buildInstructions(a)).toMatch(/Whenever the caller asks whether you are a person, a robot or an AI, say truthfully that you are an AI assistant/)
  }
})

test('English only, the greeting is not repeated, and works without an assistant row', () => {
  expect(buildInstructions(assistant())).toContain('Speak English only')
  expect(buildInstructions(assistant())).toContain('You have already opened the call with: "Thanks for calling Brightwater."')
  expect(buildInstructions(null)).toContain(DEFAULT_CALL_RULES)
})
