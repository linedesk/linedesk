import { expect, test } from 'vitest'
import { nextLanguage, wordsIn } from './caller-language.ts'
import type { CallLanguages } from './pipeline.ts'

const germanWithOthers: CallLanguages = { main: 'de', others: ['zh', 'ja', 'ko', 'pl'] }

test('words are counted in the script the caller speaks, not by spaces', () => {
  expect(wordsIn('I need a plumber')).toBe(4)
  expect(wordsIn('Dzień dobry, mam problem z kranem')).toBe(6)
  expect(wordsIn('안녕하세요 예약하고 싶어요')).toBe(3)
  // Chinese and Japanese write a sentence without a space.
  expect(wordsIn('我叫卫生间的马桶一直漏欸')).toBeGreaterThanOrEqual(3)
  expect(wordsIn('予約したいです')).toBeGreaterThanOrEqual(3)
  // Punctuation is no word.
  expect(wordsIn('好的，谢谢。')).toBe(2)
  expect(wordsIn(' … ')).toBe(0)
})

test('a full Chinese or Japanese sentence switches the voice', () => {
  expect(nextLanguage('de', 'zh', '我叫卫生间的马桶一直漏欸', germanWithOthers)).toBe('zh')
  expect(nextLanguage('de', 'zh-CN', '给我回电话安排维修', germanWithOthers)).toBe('zh')
  expect(nextLanguage('de', 'ja', '予約したいです', germanWithOthers)).toBe('ja')
})

test('a short turn never switches the voice, in any script', () => {
  for (const [detected, transcript] of [
    ['en', 'okay'],
    ['en', 'yes thanks'],
    ['zh', '好的'],
    ['zh', '还在'],
    ['ja', 'はい'],
    ['ko', '네, 감사합니다'],
    ['pl', 'tak'],
  ] as const)
    expect(nextLanguage('de', detected, transcript, germanWithOthers)).toBeNull()
})

test('the caller switching to another allowed language and back to the main one moves the voice along', () => {
  expect(nextLanguage('de', 'pl', 'Dzień dobry, mam problem z kranem', germanWithOthers)).toBe('pl')
  expect(nextLanguage('pl', 'de', 'Können wir bitte Deutsch sprechen', germanWithOthers)).toBe('de')
  expect(nextLanguage('pl', 'pl', 'Dzień dobry, mam problem z kranem', germanWithOthers)).toBeNull()
})

test('a turn in a language the call does not allow keeps the current language', () => {
  // Nova-3 heard Persian in a Polish caller's turn: the voice stays Polish instead of going back to German.
  expect(nextLanguage('pl', 'fa', 'mam na imię Jan Kowalski', germanWithOthers)).toBeNull()
  expect(nextLanguage('zh', 'ar', '我叫王毅 我叫王毅', germanWithOthers)).toBeNull()
  // Before the caller switched, that is the main language, as before.
  expect(nextLanguage('de', 'fr', 'Bonjour, je voudrais un rendez-vous', germanWithOthers)).toBeNull()
  // A call with the main language only never switches.
  expect(nextLanguage('en', 'es', 'Hola, necesito un fontanero', { main: 'en', others: [] })).toBeNull()
})

test('no detected language keeps the current one', () => {
  expect(nextLanguage('de', null, 'Dzień dobry, mam problem z kranem', germanWithOthers)).toBeNull()
})
