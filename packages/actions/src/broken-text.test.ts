import { expect, test } from 'vitest'
import { z } from 'zod'
import { brokenTextPaths, guardedInput, REPLACEMENT_CHARACTER as R, withoutBrokenText } from './broken-text.ts'
import { actions } from './index.ts'
import { inputErrorText } from './input-errors.ts'

const WHOLE = [
  'Dieses Gespräch kann aufgezeichnet werden.',
  'Straße, Größe',
  'café, niño, Łódź',
  '日本語のテキスト',
  'Привет',
  'مرحبا',
  '👋🏽',
]

test('text in any script passes; U+FFFD anywhere is found, also deep and in a key', () => {
  for (const text of WHOLE) expect(brokenTextPaths({ text, list: [text], deep: { [text]: text } })).toEqual([])
  expect(
    brokenTextPaths({ a: 'ok', b: `Gespr${R}ch`, list: ['ok', `x${R}`], deep: { profile: { about: `${R}` } }, n: 1 }),
  ).toEqual([['b'], ['list', 1], ['deep', 'profile', 'about']])
  expect(brokenTextPaths({ [`k${R}`]: 'v' })).toEqual([[`k${R}`]])
})

test('the registry boundary refuses broken text with a clear error, and keeps umlauts', () => {
  const def = actions.get('assistant.update')!
  const schema = guardedInput(def.input)
  expect(guardedInput(def.input)).toBe(schema) // cached
  for (const text of WHOLE) expect(schema.safeParse({ assistantId: 'as_1', recording_notice: text }).success).toBe(true)
  const bad = schema.safeParse({
    assistantId: 'as_1',
    recording_notice: `Dieses Gespr${R}ch kann aufgezeichnet werden.`,
  })
  expect(bad.success).toBe(false)
  expect(inputErrorText(bad.error!, {})).toMatch(/^Recording notice: it holds "\uFFFD" \(U\+FFFD\).*right letters\.$/)
  // The plain schema stays extendable for the MCP servers.
  expect(() => (def.input as z.ZodObject).extend({ workspaceId: z.string() })).not.toThrow()
})

test('nested profile text is refused too', () => {
  const def = actions.get('assistant.update')!
  const bad = guardedInput(def.input).safeParse({
    assistantId: 'as_1',
    business_profile: { services: [`Fensterb${R}nke`] },
  })
  expect(bad.success).toBe(false)
})

test('withoutBrokenText drops only U+FFFD', () => {
  expect(withoutBrokenText({ a: `Gespr${R}ch`, b: [`日本${R}`], c: 3, d: null })).toEqual({
    a: 'Gesprch',
    b: ['日本'],
    c: 3,
    d: null,
  })
})
