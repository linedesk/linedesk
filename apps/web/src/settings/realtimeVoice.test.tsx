// Settings › Assistant › Voice while the realtime model answers: the model's own voices with the same rows as the voice
// providers' picker, the server's default voice as "Default voice", OpenAI's recommended ones suggested, every one in
// More voices (whatever the assistant's languages), and samples asked for with ?provider=openai_realtime.
import type { VoiceOptionsData } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NO_PRICES } from './voiceSwitch.fixture.ts'

const OPTIONS: VoiceOptionsData = {
  provider: 'elevenlabs',
  callQuality: NO_PRICES,
  realtime: true,
  voices: [],
  clones: [],
  canClone: false,
  defaultVoice: null,
  realtimeDefaultVoice: 'cedar',
}
vi.mock('../cachedQuery.ts', () => ({
  useQuery: (key: string | null) => ({
    data: key === 'voice.options' ? OPTIONS : undefined,
    error: null,
    reload: () => {},
  }),
  refreshQuery: () => {},
}))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), useWriteAction: () => vi.fn() }))

const { MoreVoices, RealtimeVoiceSettings } = await import('./VoiceSettings.tsx')
const { previewUrl, realtimePickerVoices } = await import('./voiceModel.ts')

const rowsOf = (html: string) =>
  [
    ...html.matchAll(
      /<div class="vp-row( on)?">.*?<span class="vp-name">(.*?)<\/span>.*?(?:<span class="vp-facts">(.*?)<\/span>)?<\/label>/g,
    ),
  ].map(m => ({ name: m[2] ?? '', facts: m[3] ?? '', checked: !!m[1] }))

function picker(voice: string, language = 'en') {
  return renderToStaticMarkup(
    <RealtimeVoiceSettings
      voice={voice}
      onPick={() => {}}
      canEdit
      language={language}
      otherLanguages={[]}
      assistantName="Maya"
    />,
  )
}

describe('the realtime voice picker', () => {
  it("lists the server's default voice first, checked while the assistant picked none, then OpenAI's recommended ones", () => {
    expect(rowsOf(picker(''))).toEqual([
      { name: 'Cedar (default)', facts: 'Native English', checked: true },
      { name: 'Marin', facts: 'Native English', checked: false },
    ])
  })

  it('shows the picked voice as checked, also one that is not suggested', () => {
    expect(rowsOf(picker('marin')).find(r => r.checked)?.name).toBe('Marin')
    const ash = rowsOf(picker('ash'))
    expect(ash.find(r => r.checked)).toEqual({ name: 'Ash', facts: 'Native English', checked: true })
    expect(ash[0]).toMatchObject({ name: 'Cedar (default)', checked: false })
    // The default voice picked by name: its own row is the checked one, next to the default row.
    expect(
      rowsOf(picker('cedar'))
        .filter(r => r.name.startsWith('Cedar'))
        .map(r => r.checked),
    ).toEqual([false, true])
  })

  it('says the voices speak another main language with the accent of their own, English (no gender claimed)', () => {
    expect(rowsOf(picker('', 'de'))[0]).toEqual({
      name: 'Cedar (default)',
      facts: 'German with an English accent',
      checked: true,
    })
  })

  it('says Ultra speaks with its own voices and points to the server default', () => {
    expect(picker('')).toContain('Ultra speaks with its own voices.')
    expect(picker('')).toContain('The default voice is set by an instance admin under')
  })

  it("More voices lists all ten, also for an assistant whose main language isn't English", () => {
    const voices = realtimePickerVoices('Recommended')
    const html = renderToStaticMarkup(
      <MoreVoices
        catalog={{
          providers: [
            { provider: 'openai_realtime', label: 'OpenAI Realtime', active: true, configured: true, error: null },
          ],
          voices: voices.map(v => ({ ...v, language: 'en', gender: null, accent: null })),
        }}
        voices={voices}
        main="de"
        others={[]}
        assistantName="Maya"
        error={null}
        onRetry={() => {}}
        selected=""
        onPick={() => {}}
        disabled={false}
        preview={{ playing: null, loading: null, progress: 0, failed: null, toggle: async () => {} }}
        openOn=""
      />,
    )
    expect(rowsOf(html).map(r => r.name)).toEqual([
      'Alloy',
      'Ash',
      'Ballad',
      'Cedar',
      'Coral',
      'Echo',
      'Marin',
      'Sage',
      'Shimmer',
      'Verse',
    ])
  })

  it('asks for samples of the realtime model by name, in the main language', () => {
    expect(previewUrl('cedar', 'openai_realtime', 'de')).toBe(
      '/v1/voices/preview/cedar?provider=openai_realtime&language=de',
    )
    expect(
      realtimePickerVoices('Recommended')
        .filter(v => v.description)
        .map(v => v.id),
    ).toEqual(['marin', 'cedar'])
  })
})
