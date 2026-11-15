// The assistant's languages decide the voice: switching the main language and the other languages several times in a
// row, the voice follows only when it can't perform them all (and stays when it still can), Undo brings the one before
// back, and Suggested, More voices, their labels and the note always speak of the languages now, nothing from before.
import type { PickerVoice } from './voiceModel.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SWITCH_CATALOG, SWITCH_OPTIONS } from './voiceSwitch.fixture.ts'

vi.mock('../cachedQuery.ts', () => ({
  useQuery: (key: string | null) => ({
    data: key === 'voice.options' ? SWITCH_OPTIONS : key === 'voice.catalog' ? SWITCH_CATALOG : undefined,
    error: null,
    reload: () => {},
  }),
  refreshQuery: () => {},
}))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), useWriteAction: () => vi.fn() }))

const { MoreVoices, VoiceSettings } = await import('./VoiceSettings.tsx')
const { coverageNote, followedNotice, followLanguages, languageLabel, oncePerVoice, voiceFacts } = await import(
  './voiceModel.ts'
)

type Choice = { provider: string; voice_id: string }
const voices = oncePerVoice(SWITCH_CATALOG.voices)
const byId = (id: string) => voices.find(v => v.id === id)!
const curated = SWITCH_OPTIONS.voices.map(v => byId(v.id))
const defaultVoice = byId(SWITCH_OPTIONS.defaultVoice!.id)

/** What the picker does when the languages change from what they were: the voice after it, and the notice. */
function change(current: Choice, main: string, others: string[] = []) {
  const followed = followLanguages({ voices: SWITCH_CATALOG.voices, curated, defaultVoice, current, main, others })
  return { voice: followed?.voice ?? current, notice: followed ? followedNotice(followed) : null }
}

/** Settings › Assistant › Voice as it shows for these languages and this voice: Suggested's rows and the notes. */
function suggested(voice: Choice, main: string, others: string[] = []) {
  const html = renderToStaticMarkup(
    <VoiceSettings
      assistantId="a1"
      voice={voice}
      onPick={() => {}}
      canEdit
      toast={() => {}}
      language={main}
      otherLanguages={others}
      assistantName="Mia"
    />,
  )
  const rows = [
    ...html.matchAll(
      /<div class="vp-row( on)?">.*?<span class="vp-name">(.*?)<\/span>.*?(?:<span class="vp-facts">(.*?)<\/span>)?<\/label>/g,
    ),
  ].map(m => ({ name: m[2], facts: m[3] ?? '', checked: !!m[1] }))
  const note = /<p class="help vp-native-note">(.*?)<\/p>/.exec(html)?.[1] ?? null
  return { rows, note }
}

/** More voices for these languages, as it opens: the language filter's label and the rows it lists. */
function more(main: string, others: string[] = []) {
  const html = renderToStaticMarkup(
    <MoreVoices
      catalog={SWITCH_CATALOG}
      voices={voices}
      main={main}
      others={others}
      assistantName="Mia"
      error={null}
      onRetry={() => {}}
      selected=""
      onPick={() => {}}
      disabled={false}
      preview={{ playing: null, loading: null, progress: 0, failed: null, toggle: async () => {} }}
    />,
  )
  const names = [...html.matchAll(/<span class="vp-name">(.*?)<\/span>/g)].map(m => m[1])
  const facts = [...html.matchAll(/<span class="vp-facts">(.*?)<\/span>/g)].map(m => m[1])
  return { names, facts, html }
}

describe('labels: which of the assistant’s languages a voice performs', () => {
  const alexandra = byId('alexandra')
  it('the voice’s own language is "Native", the others it is verified in are named, the main language first', () => {
    expect(languageLabel(alexandra, 'de')).toBe('Native German')
    expect(languageLabel(alexandra, 'nl')).toBe('Dutch')
    expect(languageLabel(alexandra, 'pt')).toBe('Portuguese')
    expect(languageLabel(alexandra, 'de', ['nl', 'pt', 'en'])).toBe('Native German · Dutch · Portuguese')
    expect(languageLabel(alexandra, 'nl', ['de'])).toBe('Dutch · Native German')
    expect(languageLabel(byId('lena'), 'de', ['en'])).toBe('Native German · English')
    expect(languageLabel(byId('beatriz'), 'en', ['pt'])).toBe('English · Native Portuguese')
  })
  it('a main language it can’t perform says how it speaks it; a non-native Cartesia accent does not count', () => {
    expect(languageLabel(alexandra, 'en', ['nl'])).toBe('English with an Austrian accent · Dutch')
    expect(languageLabel(byId('klaus'), 'en')).toBe('English with a German accent')
    expect(languageLabel(byId('klaus'), 'de', ['en'])).toBe('Native German')
  })
  it('facts: gender, the accent of the main language where it performs it, the languages, the provider', () => {
    expect(voiceFacts(alexandra, 'de', ['nl'], 'ElevenLabs')).toBe(
      'Female · Austrian · Native German · Dutch · ElevenLabs',
    )
    expect(voiceFacts(alexandra, 'nl')).toBe('Female · Dutch')
  })
  it('a voice listed once per language (an older catalog) is one voice with every language', () => {
    expect(SWITCH_CATALOG.voices.filter(v => v.id === 'alexandra')).toHaveLength(2)
    expect(voices.filter(v => v.id === 'alexandra')).toHaveLength(1)
    expect(alexandra.languages?.map(l => l.code)).toEqual(['de', 'nl', 'pt'])
  })
  it('the note names the languages the closest voice lacks, only when no voice performs them all', () => {
    const pool: PickerVoice[] = voices
    expect(coverageNote(pool, 'de', ['en'], null)).toBeNull()
    expect(coverageNote(pool, 'de', ['en', 'nl'], null)).toBe(
      'No voice is verified in all of German, English, and Dutch; the closest are shown.',
    )
    expect(coverageNote(pool, 'de', ['ja'], 'ElevenLabs')).toBe(
      'No voice from ElevenLabs is verified in Japanese; the closest are shown.',
    )
    // None performs the main language: missingNativeNote says why instead.
    expect(coverageNote(pool, 'ja', ['de'], null)).toBeNull()
  })
})

describe('switching the assistant’s languages several times in a row', () => {
  it('German, Dutch, Portuguese, English, German, + English, + Dutch, − English, Undo, English', () => {
    let voice: Choice = { provider: 'elevenlabs', voice_id: '' } // the default voice, Jessica
    let step: ReturnType<typeof change>

    // German: Jessica speaks only English, so the voice follows: a female ElevenLabs voice made for calls.
    step = change(voice, 'de')
    voice = step.voice
    expect(voice).toEqual({ provider: 'elevenlabs', voice_id: 'lena' })
    expect(step.notice).toBe('Voice changed to Lena - Customer Support: speaks German natively.')
    expect(suggested(voice, 'de')).toEqual({
      rows: [
        { name: 'Lena - Customer Support', facts: 'Female · Native German', checked: true },
        { name: 'Alexandra', facts: 'Female · Austrian · Native German', checked: false },
        { name: 'Jonas', facts: 'Male · Native German', checked: false },
        { name: 'Klaus', facts: 'Male · Native German', checked: false },
      ],
      note: null,
    })
    expect(more('de').html).toContain('>German<') // the language filter: the main language
    expect(more('de').names).toEqual(['Alexandra', 'Jonas', 'Klaus', 'Lena - Customer Support'])

    // Dutch: Lena is not verified in Dutch. Alexandra is (an Austrian German voice): "Dutch", not "Native Dutch".
    step = change(voice, 'nl')
    voice = step.voice
    expect(voice).toEqual({ provider: 'elevenlabs', voice_id: 'alexandra' })
    expect(step.notice).toBe('Voice changed to Alexandra: speaks Dutch natively.')
    expect(suggested(voice, 'nl').rows).toEqual([
      { name: 'Alexandra', facts: 'Female · Dutch', checked: true },
      { name: 'Daan', facts: 'Male · Native Dutch', checked: false },
      { name: 'Sanne', facts: 'Female · Native Dutch', checked: false },
    ])
    const dutch = more('nl')
    expect(dutch.html).toContain('>Dutch<')
    expect(dutch.html).not.toContain('German')
    expect(dutch.names).toEqual(['Alexandra', 'Daan', 'Sanne'])
    expect(dutch.facts).toEqual([
      'Female · Dutch · ElevenLabs',
      'Male · Native Dutch · ElevenLabs',
      'Female · Native Dutch · ElevenLabs',
    ])

    // Portuguese: Alexandra is verified in it too, so she stays; no notice.
    step = change(voice, 'pt')
    expect(step).toEqual({ voice, notice: null })
    expect(suggested(voice, 'pt').rows).toEqual([
      { name: 'Alexandra', facts: 'Female · Portuguese', checked: true },
      { name: 'Beatriz', facts: 'Female · Brazilian · Native Portuguese', checked: false },
    ])
    expect(more('pt').html).not.toMatch(/Dutch|German/)

    // English: Alexandra is not verified in English: back to the default voice (Jessica, female like her).
    step = change(voice, 'en')
    voice = step.voice
    expect(voice).toEqual({ provider: 'elevenlabs', voice_id: '' })
    expect(step.notice).toBe('Voice changed to Jessica: speaks English natively.')
    expect(suggested(voice, 'en').rows[0]).toEqual({
      name: 'Jessica (default)',
      facts: 'Native English',
      checked: true,
    })
    expect(suggested(voice, 'en').rows.some(r => /Dutch|Portuguese|German/.test(r.facts))).toBe(false)

    // German again: the same pick as the first time.
    step = change(voice, 'de')
    voice = step.voice
    expect(voice).toEqual({ provider: 'elevenlabs', voice_id: 'lena' })

    // German and English: Lena performs both, so she stays; she is listed first, with both languages.
    step = change(voice, 'de', ['en'])
    expect(step).toEqual({ voice, notice: null })
    expect(suggested(voice, 'de', ['en']).rows[0]).toEqual({
      name: 'Lena - Customer Support',
      facts: 'Female · Native German · English',
      checked: true,
    })
    expect(more('de', ['en']).names).toEqual(['Lena - Customer Support'])
    expect(more('de', ['en']).html).toContain('>Mia&#x27;s languages<')

    // German, English and Dutch: no voice performs all three. Lena is as close as any: she stays, and a note says so.
    step = change(voice, 'de', ['en', 'nl'])
    expect(step).toEqual({ voice, notice: null })
    const three = suggested(voice, 'de', ['en', 'nl'])
    expect(three.note).toBe('No voice is verified in all of German, English, and Dutch; the closest are shown.')
    expect(three.rows.slice(0, 2)).toEqual([
      { name: 'Lena - Customer Support', facts: 'Female · Native German · English', checked: true },
      { name: 'Alexandra', facts: 'Female · Austrian · Native German · Dutch', checked: false },
    ])
    // More voices: the closest, the ones that perform German.
    expect(more('de', ['en', 'nl']).names).toEqual(['Alexandra', 'Lena - Customer Support', 'Jonas', 'Klaus'])

    // English taken out (German and Dutch): Alexandra performs both, Lena not Dutch: the voice follows.
    const before = voice
    step = change(voice, 'de', ['nl'])
    voice = step.voice
    expect(voice).toEqual({ provider: 'elevenlabs', voice_id: 'alexandra' })
    expect(step.notice).toBe('Voice changed to Alexandra: speaks German and Dutch natively.')
    const two = suggested(voice, 'de', ['nl'])
    expect(two.note).toBeNull()
    expect(two.rows[0]).toEqual({
      name: 'Alexandra',
      facts: 'Female · Austrian · Native German · Dutch',
      checked: true,
    })

    // Undo puts the voice before back (the picker calls onPick with it); the languages did not change, so it stays.
    voice = before
    expect(suggested(voice, 'de', ['nl']).rows.find(r => r.checked)).toEqual({
      name: 'Lena - Customer Support',
      facts: 'Female · Native German',
      checked: true,
    })

    // English alone: Lena performs English, so she stays (listed above the curated voices, as a voice of the catalog).
    expect(change(voice, 'en')).toEqual({ voice, notice: null })
    expect(suggested(voice, 'en').rows[0]).toEqual({
      name: 'Lena - Customer Support',
      facts: 'Female · British · English · ElevenLabs',
      checked: true,
    })
  })

  it('a voice whose languages are unknown (a cloned voice) is never switched', () => {
    const clone = { provider: 'elevenlabs', voice_id: 'my-clone' }
    expect(change(clone, 'nl', ['de'])).toEqual({ voice: clone, notice: null })
  })
})
