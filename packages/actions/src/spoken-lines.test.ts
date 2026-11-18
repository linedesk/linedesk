import { expect, test } from 'vitest'
import { withDisclosure } from './assistant-prompt.ts'
import { fluxRecognizes, languageCodes } from './languages.ts'
import {
  businessOfGreeting,
  DEMO_LANGUAGES,
  DEMO_LINE_LANGUAGES,
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
  'anythingElse',
  'callLimit',
  'testCallLimit',
  'silenceClosing',
  'busy',
  'overCap',
  'blocked',
  'urgentFlagged',
  'urgentFlaggedNoCallerId',
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
    // The hand-over lines name the people, in the language's own words.
    expect(lines.transferConnecting('Mike'), code).toContain('Mike')
    expect(lines.transferNext('Mike', 'Sarah'), code).toMatch(/Mike.*Sarah/)
    expect(lines.takeOver('Mike'), code).toContain('Mike')
    if (code !== 'en') {
      expect(lines.transferConnecting('Mike'), `${code}.transferConnecting`).not.toBe(english.transferConnecting('Mike'))
      expect(lines.transferNext('Mike', 'Sarah'), `${code}.transferNext`).not.toBe(english.transferNext('Mike', 'Sarah'))
      expect(lines.takeOver('Mike'), `${code}.takeOver`).not.toBe(english.takeOver('Mike'))
    }
  }
})

test('every language has the lines the on-call person hears in a transfer, naming the caller, in its own words', () => {
  const english = spokenLines('en')
  for (const code of languageCodes) {
    const lines = spokenLines(code)
    const briefing = lines.onCallBriefing('503 555 0142', 'Dana Ruiz', 'a burst pipe')
    expect(briefing, code).toMatch(/503 555 0142.*Dana Ruiz.*a burst pipe/)
    // The keys to press are said in every language.
    expect(briefing, code).toMatch(/1.*2/)
    expect(lines.onCallBriefing('Dana Ruiz', null, null), code).toContain('Dana Ruiz')
    expect(lines.onCallBriefing('Dana Ruiz', null, null), code).not.toMatch(/undefined|null/)
    for (const key of ['aCaller', 'onCallConnecting', 'onCallDeclined', 'onCallFailed'] as const) {
      expect(lines[key].trim().length, `${code}.${key}`).toBeGreaterThan(0)
      if (code !== 'en') expect(lines[key], `${code}.${key} is still English`).not.toBe(english[key])
    }
    if (code !== 'en') {
      expect(briefing, `${code}.onCallBriefing is still English`).not.toMatch(/Call from|Press 1|say yes/)
    }
  }
})

test('the English briefing reads as before', () => {
  const { onCallBriefing } = spokenLines('en')
  expect(onCallBriefing('Dana Ruiz', null, 'a burst pipe')).toBe(
    'Call from Dana Ruiz about a burst pipe. Press 1 or say yes to take it, or press 2 or say no.',
  )
  expect(onCallBriefing('503 555 0142', 'Dana Ruiz', 'no heat')).toBe(
    'Call from 503 555 0142, who says they are Dana Ruiz, about no heat. Press 1 or say yes to take it, or press 2 or say no.',
  )
  expect(onCallBriefing('a caller', 'Dana Ruiz', null)).toBe(
    'Call from a caller, who says they are Dana Ruiz. Press 1 or say yes to take it, or press 2 or say no.',
  )
})

test('a default greeting or line switches to the new main language and back', () => {
  for (const code of languageCodes) {
    const english = spokenLines('en').greeting('Brightwater Plumbing', 'Maya', true)
    const there = swapDefault(english, 'en', code)
    expect(there).toBe(spokenLines(code).greeting('Brightwater Plumbing', 'Maya', true))
    expect(swapDefault(there, code, 'en')).toBe(english)
    expect(swapDefault(spokenLines('en').silenceClosing, 'en', code)).toBe(spokenLines(code).silenceClosing)
    expect(swapDefault(spokenLines('en').goodbye, 'en', code)).toBe(spokenLines(code).goodbye)
  }
})

test('the default closing line after silence follows the language spoken, also from a main language other than English', () => {
  for (const main of languageCodes) {
    for (const spoken of ['zh', 'ko', 'pl', 'en', 'de'] as const) {
      expect(swapDefault(spokenLines(main).silenceClosing, main, spoken), `${main} → ${spoken}`).toBe(
        spokenLines(spoken).silenceClosing,
      )
    }
  }
  // An owner's own closing line stays as written.
  expect(swapDefault('Bye for now.', 'en', 'ko')).toBe('Bye for now.')
})

test('the business of an English default greeting, with or without the AI note; null for any other text', () => {
  expect(businessOfGreeting('Thanks for calling Ridgeline Auto Care. This is Maya. How can I help?')).toBe(
    'Ridgeline Auto Care',
  )
  expect(businessOfGreeting(spokenLines('en').greeting('Hale & Ortiz Law', 'Maya', true))).toBe('Hale & Ortiz Law')
  expect(businessOfGreeting('Hello, you reached the front desk.')).toBeNull()
})

test("a public demo call's lines are in Flux's 10, each with its own opening and limit line", () => {
  expect(DEMO_LINE_LANGUAGES).toEqual(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
  for (const code of DEMO_LINE_LANGUAGES) {
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
})

test('a visitor may pick only the demo languages that passed the language retest: English, with lines in each', () => {
  // The others keep their lines (above) and stay off until a retest passes (2026-11-16).
  expect(DEMO_LANGUAGES).toEqual(['en'])
  for (const code of DEMO_LANGUAGES) expect(DEMO_LINE_LANGUAGES).toContain(code)
  expect(isDemoLanguage('en')).toBe(true)
  for (const value of ['es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja', 'EN', 'ko', '', null, undefined, 7])
    expect(isDemoLanguage(value), String(value)).toBe(false)
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
