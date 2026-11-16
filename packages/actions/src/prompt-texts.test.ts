import { expect, test } from 'vitest'
import {
  overrideFits,
  placeholdersOf,
  PROMPT_CONDITIONS,
  PROMPT_SECTIONS,
  PROMPT_TEXTS,
  PROMPT_TEXT_KEYS,
  promptTexts,
} from './prompt-texts.ts'
import { cleanPromptText, systemPromptGet, systemPromptResetPart, systemPromptSetPart } from './system-prompt.ts'

test('every part has a known section and condition, and its default fits itself', () => {
  for (const key of PROMPT_TEXT_KEYS) {
    const def: { section: string; text: string; when?: string } = PROMPT_TEXTS[key]
    expect(PROMPT_SECTIONS).toContain(def.section)
    if (def.when) expect(PROMPT_CONDITIONS).toContain(def.when)
    expect(overrideFits(key, def.text)).toBe(true)
  }
})

test('the variables of a text, in order', () => {
  expect(placeholdersOf('Speak {main} only, in {main}; {x}')).toEqual(['main', 'main', 'x'])
  expect(placeholdersOf('no variables')).toEqual([])
})

test('an override fits only with the same variables in the same order', () => {
  expect(overrideFits('role.intro', 'Hi, I am {name}.')).toBe(true)
  expect(overrideFits('role.intro', 'Hi, I am the assistant.')).toBe(false)
  expect(overrideFits('role.intro', 'Hi, {name} and {name}.')).toBe(false)
  expect(overrideFits('role.intro', 'Hi, {business}.')).toBe(false)
  expect(overrideFits('language.other', 'Reply in {all} or {main}.')).toBe(false)
  expect(overrideFits('rules.spam', 'Be short with spam.')).toBe(true)
})

test('the texts: an override that fits wins, the default otherwise; values are filled in once', () => {
  const t = promptTexts({ 'rules.spam': 'Spam: hang up politely.', 'role.intro': 'I am Maya.', unknown: 'x' })
  expect(t('rules.spam')).toBe('Spam: hang up politely.')
  // Leaves out {name}: does not fit, so the default.
  expect(t('role.intro', { name: 'Maya' })).toBe(PROMPT_TEXTS['role.intro'].text.replace('{name}', 'Maya'))
  expect(promptTexts()('role.intro', { name: '{name} $& $1' })).toContain('You are {name} $& $1, the AI assistant')
  expect(promptTexts(null)('cannot.sentence', { list: 'transfer calls' })).toBe(
    'You cannot transfer calls; for those, take a message.',
  )
})

test('systemPrompt.setPart: instance admins only; the text is cleaned and must keep the variables', () => {
  for (const def of [systemPromptGet, systemPromptSetPart, systemPromptResetPart])
    expect(def.permission).toBe('instance:admin')
  expect(systemPromptGet.readOnly).toBe(true)
  expect(systemPromptSetPart.input.parse({ key: 'role.intro', text: ' I am {name}.\r\nHi\u0007\t! ' })).toEqual({
    key: 'role.intro',
    text: 'I am {name}.\nHi\t!',
  })
  expect(systemPromptSetPart.input.safeParse({ key: 'role.intro', text: 'I am Maya.' }).success).toBe(false)
  expect(systemPromptSetPart.input.safeParse({ key: 'rules.spam', text: '  ' }).success).toBe(false)
  expect(systemPromptSetPart.input.safeParse({ key: 'nope', text: 'x' }).success).toBe(false)
  expect(cleanPromptText('a\r\nb\rc')).toBe('a\nb\nc')
})
