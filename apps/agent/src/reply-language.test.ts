// The replies follow the language the caller speaks, not only the voice (LIN-268): the assistant's instructions and every
// collection step once the caller switched to another allowed language; unchanged while the main language is spoken.
import type { Assistant } from '@linedesk/db/types'
import { initializeLogger, voice } from '@livekit/agents'
import { beforeAll, describe, expect, test } from 'vitest'
import { followCallerLanguage, type LanguageVoice } from './caller-language.ts'
import { COLLECT_ENGLISH_ONLY, CollectTask } from './collect/collect-task.ts'
import { nameCollector } from './collect/collectors.ts'
import { collectLanguageRule, spokenLanguageRule } from './prompt.ts'

const germanWith = (...allowed: string[]) =>
  ({ languages: { main: 'de', mode: 'allowed', allowed } }) as unknown as Assistant
const german = germanWith('zh', 'pl')

beforeAll(() => initializeLogger({ pretty: false, level: 'fatal' }))

describe('a collection step after the caller switched language', () => {
  test('speaks only the language the caller switched to, and reads numbers and letters back in it', () => {
    const rule = collectLanguageRule(german, 'zh')!
    expect(rule).toMatch(/^The caller speaks Chinese \(Mandarin\): speak only Chinese \(Mandarin\) in this step/)
    expect(rule).toMatch(/read numbers digit by digit and spelled letters back in Chinese \(Mandarin\)/)
    expect(rule).not.toMatch(/German/)
    expect(collectLanguageRule(german, 'pl')).toMatch(/^The caller speaks Polish: speak only Polish/)
  })

  test('the main language spoken, or none known: the rule as before', () => {
    const before = collectLanguageRule(german)
    expect(before).toMatch(
      /^Speak the language the caller has been speaking in this call if it is German, Chinese \(Mandarin\) or Polish, else German;/,
    )
    expect(collectLanguageRule(german, 'de')).toBe(before)
  })

  test('a language the call does not allow never takes over', () => {
    expect(collectLanguageRule(german, 'ko')).toBe(collectLanguageRule(german))
  })

  test('an assistant with one language keeps speaking it', () => {
    const only = { languages: { main: 'de', mode: 'english', allowed: [] } } as unknown as Assistant
    expect(collectLanguageRule(only, 'zh')).toMatch(/^Speak German\./)
    const english = { languages: { main: 'en', mode: 'english', allowed: [] } } as unknown as Assistant
    expect(collectLanguageRule(english, 'zh')).toBeNull()
  })

  test('a step that is running when the caller switches speaks the new language from its next line', async () => {
    const task = new CollectTask({ collector: nameCollector, languageRule: collectLanguageRule(german, 'de')! })
    expect(task.instructions).toContain('else German')
    await task.languageChanged(collectLanguageRule(german, 'pl') ?? undefined)
    expect(task.instructions).toContain('The caller speaks Polish: speak only Polish')
    expect(task.instructions).toContain(nameCollector.instructions)
    await task.languageChanged(undefined)
    expect(task.instructions).toContain(COLLECT_ENGLISH_ONLY)
  })
})

describe("the assistant's replies after the caller switched language", () => {
  test('are told to stay in that language, also after a tool and in the goodbye', () => {
    expect(spokenLanguageRule(german, 'zh')).toBe(
      'The caller is speaking Chinese (Mandarin) now: reply only in Chinese (Mandarin), also after a tool and in your goodbye, until the caller switches language. Read numbers and spelled letters back in Chinese (Mandarin).',
    )
  })

  test('nothing is added while the main language is spoken, or for a language the call does not allow', () => {
    expect(spokenLanguageRule(german, 'de')).toBeNull()
    expect(spokenLanguageRule(german, 'ko')).toBeNull()
  })
})

test('each switch of the voice is passed on, so the instructions follow it', () => {
  const session = new voice.AgentSession({})
  const tts: LanguageVoice & { languages: string[] } = {
    languages: [],
    updateOptions: ({ language }) => void tts.languages.push(language!),
  }
  const switches: string[] = []
  const spokenNow = followCallerLanguage(session, tts, { main: 'de', others: ['zh', 'pl'] }, 'call_1', language =>
    switches.push(language),
  )
  const heard = (language: string, transcript: string) =>
    session.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      isFinal: true,
      language,
      transcript,
      speakerId: null,
      createdAt: Date.now(),
    } as never)
  heard('zh', '我家卫生间的马桶一直漏水')
  heard('zh', '我叫王丽，姓王')
  heard('de', 'Können wir bitte Deutsch sprechen')
  expect(switches).toEqual(['zh', 'de'])
  expect(tts.languages).toEqual(['zh', 'de'])
  expect(spokenNow()).toBe('de')
})
