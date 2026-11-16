import { expect, test } from 'vitest'
import { withDisclosure } from './assistant-prompt.ts'
import { fluxRecognizes, languageCodes } from './languages.ts'
import {
  businessOfGreeting,
  DEMO_LANGUAGES,
  defaultGreetingWithAi,
  demoLines,
  isDemoLanguage,
  type SpokenLines,
  spokenLines,
  swapDefault,
} from './spoken-lines.ts'

const textLines = [
  'fallbackGreeting',
  'consentQuestion',
  'goodbye',
  'stillThere',
  'stillChecking',
  'callLimit',
  'testCallLimit',
  'silenceClosing',
  'busy',
  'overCap',
  'blocked',
  'urgentFlagged',
  'recordingNotice',
] as const satisfies readonly (keyof SpokenLines)[]

test('every language an assistant can speak has every fixed line, in its own words', () => {
  const english = spokenLines('en')
  for (const code of languageCodes) {
    const lines = spokenLines(code)
    for (const key of textLines) {
      expect(lines[key], `${code}.${key}`).toEqual(expect.any(String))
      expect(lines[key].trim().length, `${code}.${key}`).toBeGreaterThan(0)
      if (code !== 'en') expect(lines[key], `${code}.${key} is still English`).not.toBe(english[key])
    }
    // The greeting names the business and the assistant; with the AI note its own aiNote finds it, without it not.
    expect(lines.greeting('Brightwater Plumbing', 'Maya', false)).toContain('Brightwater Plumbing')
    expect(lines.greeting('Brightwater Plumbing', 'Maya', false)).toContain('Maya')
    expect(lines.greeting('Brightwater Plumbing', 'Maya', true), code).toMatch(lines.aiNote)
    expect(lines.greeting('Brightwater Plumbing', 'Maya', false), code).not.toMatch(lines.aiNote)
    expect(lines.aiSentence('Maya'), code).toMatch(lines.aiNote)
    expect(lines.aiSentence('Maya')).toContain('Maya')
  }
})

test('a default greeting or line switches to the new main language and back', () => {
  for (const code of languageCodes) {
    const english = spokenLines('en').greeting('Brightwater Plumbing', 'Maya', true)
    const there = swapDefault(english, 'en', code)
    expect(there).toBe(spokenLines(code).greeting('Brightwater Plumbing', 'Maya', true))
    expect(swapDefault(there, code, 'en')).toBe(english)
    expect(swapDefault(spokenLines('en').silenceClosing, 'en', code)).toBe(spokenLines(code).silenceClosing)
  }
})

test('the business of an English default greeting, with or without the AI note; null for any other text', () => {
  expect(businessOfGreeting('Thanks for calling Ridgeline Auto Care. This is Maya. How can I help?')).toBe(
    'Ridgeline Auto Care',
  )
  expect(businessOfGreeting(spokenLines('en').greeting('Hale & Ortiz Law', 'Maya', true))).toBe('Hale & Ortiz Law')
  expect(businessOfGreeting('Hello, you reached the front desk.')).toBeNull()
})

test("a public demo call's languages are Flux's 10, each with its own opening and limit line", () => {
  expect(DEMO_LANGUAGES).toEqual(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
  for (const code of DEMO_LANGUAGES) {
    expect(fluxRecognizes(code), code).toBe(true)
    const { opening, limit } = demoLines(code)
    expect(opening.trim().length, code).toBeGreaterThan(0)
    expect(limit.trim().length, code).toBeGreaterThan(0)
    if (code !== 'en') {
      expect(opening, `${code} opening is still English`).not.toBe(demoLines('en').opening)
      expect(limit, `${code} limit is still English`).not.toBe(demoLines('en').limit)
    }
  }
  expect(demoLines('en')).toEqual({
    opening: 'This is a two-minute demo.',
    limit: "That's the two minutes for this demo. Thanks for trying it out. Goodbye!",
  })
  // Anything else is English; only the exact codes count.
  expect(demoLines('ko')).toEqual(demoLines('en'))
  expect(demoLines(null)).toEqual(demoLines('en'))
  expect(isDemoLanguage('de')).toBe(true)
  for (const value of ['DE', 'ko', '', null, undefined, 7]) expect(isDemoLanguage(value)).toBe(false)
})

test('the AI note in a default greeting of another language names the assistant once', () => {
  for (const code of languageCodes.filter(c => c !== 'en')) {
    const lines = spokenLines(code)
    const plain = lines.greeting('Ridgeline Auto Care', 'Maya', false)
    expect(defaultGreetingWithAi(plain, code)).toBe(lines.greeting('Ridgeline Auto Care', 'Maya', true))
    expect(withDisclosure(plain, 'Maya', code), code).toBe(lines.greeting('Ridgeline Auto Care', 'Maya', true))
    // Already with the note, or not the default greeting: not this.
    expect(defaultGreetingWithAi(lines.greeting('Ridgeline Auto Care', 'Maya', true), code)).toBeNull()
    expect(defaultGreetingWithAi('Hello there.', code)).toBeNull()
  }
})
