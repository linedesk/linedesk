// A German assistant's Voice card (onboarding's assistant step and Settings › Assistant, the same VoiceSettings): the
// voices native in German come first, from the providers' list. While that list is read, grey rows, never the English
// voices labelled "German with an American accent" that turn into the native ones when it comes (staging test of the
// German launch, 2026-11-18). When the list can't be read, the curated voices stay, each saying how it speaks German.
import type { VoiceCatalogData } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SWITCH_CATALOG, SWITCH_OPTIONS } from './voiceSwitch.fixture.ts'

const catalog: { data: VoiceCatalogData | undefined; error: string | null } = { data: undefined, error: null }
const fetched: string[] = []
vi.mock('../cachedQuery.ts', () => ({
  useQuery: (key: string | null) =>
    key === 'voice.catalog'
      ? { ...catalog, reload: () => {} }
      : { data: key === 'voice.options' ? SWITCH_OPTIONS : undefined, error: null, reload: () => {} },
  refreshQuery: () => {},
  fetchQuery: async (key: string) => void fetched.push(key),
}))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), useWriteAction: () => vi.fn() }))

const { preloadVoiceCatalog, VoiceSettings } = await import('./VoiceSettings.tsx')

function card(language: string) {
  const html = renderToStaticMarkup(
    <VoiceSettings
      assistantId="a1"
      voice={{ provider: 'elevenlabs', voice_id: '' }}
      onPick={() => {}}
      canEdit
      toast={() => {}}
      language={language}
      otherLanguages={[]}
      assistantName="Maya"
    />,
  )
  const names = [...html.matchAll(/<span class="vp-name">(.*?)<\/span>/g)].map(m => m[1])
  return { html, names }
}

describe('Suggested voices for a German assistant', () => {
  beforeEach(() => {
    catalog.data = undefined
    catalog.error = null
  })

  it('while the voice list is read: grey rows, not the English voices with an American accent', () => {
    const { html } = card('de')
    expect(html).toContain('id="as-voice"')
    expect(html.match(/class="vp-row"/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).not.toContain('Jessica')
    expect(html).not.toContain('Eric')
    expect(html).not.toContain('American accent')
  })

  it('once it is read: the native German voices first', () => {
    catalog.data = SWITCH_CATALOG
    const { html, names } = card('de')
    // The language's default voice (languageDefaultVoices) on top, then the voices recorded in German.
    expect(names[0]).toBe('Susi')
    expect(names.slice(1, 4).sort()).toEqual(['Alexandra', 'Jonas', 'Lena - Customer Support'])
    expect(html).toContain('Native German')
    expect(html).not.toContain('American accent')
  })

  const germanJessica = (freePlan: boolean): VoiceCatalogData => ({
    providers: SWITCH_CATALOG.providers.map(p => (p.active && freePlan ? { ...p, freePlan } : p)),
    voices: SWITCH_CATALOG.voices.map(v =>
      v.name === 'Jessica'
        ? { ...v, languages: [...(v.languages ?? []), { code: 'de', accent: null, native: true }] }
        : v,
    ),
  })
  const checkedOf = (html: string) =>
    [...html.matchAll(/<div class="vp-row on">.*?<span class="vp-name">(.*?)<\/span>/g)].map(m => m[1])

  it("the language's default voice is the checked one of an assistant without its own: the voice its calls speak with", () => {
    catalog.data = germanJessica(false)
    expect(checkedOf(card('de').html)).toEqual(['Susi'])
  })

  it("on a free plan (no Voice Library voices) the install's default voice, when it speaks German too, is the checked one", () => {
    catalog.data = germanJessica(true)
    const { html, names } = card('de')
    expect(names).not.toContain('Susi')
    expect(checkedOf(html)).toEqual(['Jessica'])
  })

  it('when it could not be read: the curated voices, each saying how it speaks German', () => {
    catalog.error = 'The server did not answer'
    const { html, names } = card('de')
    expect(names).toContain('Eric')
    expect(html).toContain('German with an American accent')
  })

  it('an English assistant never waits for the list: the curated voices at once', () => {
    const { html, names } = card('en')
    expect(names).toEqual(['Jessica (default)', 'Eric'])
    expect(html).toContain('Native English')
  })

  it('the Business step can read the list ahead, for the assistant step after it', async () => {
    await preloadVoiceCatalog()
    expect(fetched).toEqual(['voice.catalog'])
  })
})
