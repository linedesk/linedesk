import { expect, test } from 'vitest'
import { languageCodes } from './languages.ts'
import { businessOfGreeting, type SpokenLines, spokenLines, swapDefault } from './spoken-lines.ts'

const textLines = [
  'fallbackGreeting',
  'consentQuestion',
  'goodbye',
  'stillThere',
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
