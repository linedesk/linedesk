// Settings › Assistant › General › Call quality (CallQuality.tsx, decisions.md 2026-11-17): the three levels with their
// line and price, the server's default level marked; Premium and Ultra locked for someone who may not pay (with one
// line why), for a partner's client without prices; the models of the level behind "Choose specific models".
import type { CallQualityLevelOption, CallQualityOptions } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Draft } from './assistantDraft.ts'

const options = vi.hoisted(() => ({ callQuality: undefined as unknown }))
vi.mock('./VoiceSettings.tsx', () => ({ useVoiceOptions: () => ({ data: { callQuality: options.callQuality } }) }))

const { CallQualitySettings, levelSavedNote, withLevel } = await import('./CallQuality.tsx')

const mini = { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' }
const full = { id: 'gpt-4.1', name: 'GPT-4.1' }
const flash = { id: 'eleven_flash_v2_5', name: 'ElevenLabs Flash v2.5' }
const multi = { id: 'eleven_multilingual_v2', name: 'ElevenLabs Multilingual v2' }
const realtime = { id: 'gpt-realtime', name: 'GPT Realtime' }

const LEVELS: CallQualityLevelOption[] = [
  {
    level: 'standard',
    centsPerMinute: 5,
    models: [mini],
    voiceModels: { elevenlabs: [flash] },
    realtimeModels: [],
    defaults: { llm: 'gpt-4.1-mini', voice: { elevenlabs: 'eleven_flash_v2_5' }, realtime: null },
  },
  {
    level: 'premium',
    centsPerMinute: 10,
    models: [full, mini],
    voiceModels: { elevenlabs: [multi, flash] },
    realtimeModels: [],
    defaults: { llm: 'gpt-4.1', voice: { elevenlabs: 'eleven_multilingual_v2' }, realtime: null },
  },
  {
    level: 'ultra',
    centsPerMinute: 20,
    models: [],
    voiceModels: {},
    realtimeModels: [realtime],
    defaults: { llm: null, voice: {}, realtime: 'gpt-realtime' },
  },
]
const payer: CallQualityOptions = {
  levels: LEVELS,
  defaultLevel: 'standard',
  mayRaise: true,
  partnerManaged: false,
  llmProvider: 'openai',
}
const noPrices = (o: CallQualityOptions): CallQualityOptions => ({
  ...o,
  levels: o.levels.map(l => ({ ...l, centsPerMinute: null })),
})

type Picks = Pick<Draft, 'call_quality' | 'voice' | 'llm_model' | 'realtime_model'>
const picks = (over: Partial<Picks> = {}): Picks => ({
  call_quality: 'standard',
  voice: { provider: 'elevenlabs', voice_id: '', model: '' } as Draft['voice'],
  llm_model: '',
  realtime_model: '',
  ...over,
})

const render = (o: CallQualityOptions, p: Picks = picks(), savedLevel = p.call_quality) => {
  options.callQuality = o
  return renderToStaticMarkup(<CallQualitySettings picks={p} onChange={() => {}} name="Maya" savedLevel={savedLevel} />)
}
/** Each level card: its name, whether it is picked and whether it can be picked. */
const cards = (html: string) =>
  [...html.matchAll(/<label class="k-radio( on)?( k-radio-off)?"[^>]*>.*?<b>(.*?)<\/b>/g)].map(m => ({
    title: (m[3] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    checked: !!m[1],
    disabled: !!m[2],
  }))

describe('the Call quality card', () => {
  it('shows the three levels with their price, the default marked, for the person who pays', () => {
    const html = render(payer)
    expect(cards(html)).toEqual([
      { title: 'Standard Default $0.05 a minute', checked: true, disabled: false },
      { title: 'Premium $0.10 a minute', checked: false, disabled: false },
      { title: 'Ultra $0.20 a minute', checked: false, disabled: false },
    ])
    expect(html).toContain('Fast and reliable for most calls.')
    expect(html).not.toContain('Only the person who pays')
  })

  it('locks Premium and Ultra for someone who may not pay, with one line why; going back down stays open', () => {
    const html = render({ ...payer, mayRaise: false }, picks({ call_quality: 'premium' }))
    expect(cards(html).map(c => [c.title.split(' ')[0], c.disabled])).toEqual([
      ['Standard', false],
      ['Premium', false],
      ['Ultra', true],
    ])
    expect(html).toContain('Only the person who pays for this workspace can pick Premium or Ultra.')
    expect(html).toContain('Anyone who edits Maya can go back to Standard.')
  })

  it("a partner's client: no prices, and the partner picks the paid levels", () => {
    const html = render({ ...noPrices(payer), mayRaise: false, partnerManaged: true })
    expect(html).not.toContain('a minute')
    expect(cards(html).map(c => c.disabled)).toEqual([false, true, true])
    expect(html).toContain('Your partner picks Premium or Ultra for this workspace.')
    expect(html).not.toContain('Only the person who pays')
  })

  it('without prices (no bill, self-hosted): the same levels, no price, anyone who edits may pick each', () => {
    const html = render(noPrices(payer))
    expect(cards(html).map(c => c.title)).toEqual(['Standard Default', 'Premium', 'Ultra'])
    expect(html).toContain('Every choice here is part of Standard.')
    expect(html).not.toContain('calls cost')
  })

  it("lists only the levels the server has on, and the server's default level", () => {
    const html = render({ ...payer, levels: LEVELS.slice(0, 2), defaultLevel: 'premium' })
    expect(cards(html).map(c => c.title)).toEqual(['Standard $0.05 a minute', 'Premium Default $0.10 a minute'])
  })

  it("names the level's models and their defaults behind Choose specific models", () => {
    const premium = render(payer, picks({ call_quality: 'premium' }))
    expect(premium).toContain('Choose specific models')
    expect(premium).toContain('What Maya thinks with during the call.')
    expect(premium).toContain('Default (GPT-4.1)')
    expect(premium).toContain('Default (ElevenLabs Multilingual v2)')
    expect(premium).toContain('calls cost $0.10 a minute, whichever you pick.')
    expect(premium).not.toContain('Back to defaults')
    const ultra = render(payer, picks({ call_quality: 'ultra', realtime_model: 'gpt-realtime' }))
    expect(ultra).toContain('Realtime model')
    expect(ultra).not.toContain('Language model')
    expect(ultra).toContain('Back to defaults')
  })

  it('shows nothing until the options are there', () => {
    expect(render(undefined as unknown as CallQualityOptions)).toBe('')
  })
})

describe('withLevel', () => {
  it("keeps the picks that belong to the new level and clears the others, so they follow the level's defaults", () => {
    const premium = picks({
      call_quality: 'premium',
      llm_model: 'gpt-4.1',
      voice: { provider: 'elevenlabs', voice_id: 'v1', model: 'eleven_flash_v2_5' } as Draft['voice'],
    })
    expect(withLevel(premium, 'standard', LEVELS[0])).toMatchObject({
      call_quality: 'standard',
      llm_model: '',
      voice: { voice_id: 'v1', model: 'eleven_flash_v2_5' },
    })
    expect(withLevel(premium, 'ultra', LEVELS[2])).toMatchObject({
      call_quality: 'ultra',
      llm_model: '',
      voice: { voice_id: 'v1', model: '' },
      realtime_model: '',
    })
  })
})

describe('the save toast', () => {
  it('says what the calls cost now, the level where there are no prices, nothing when the level stayed', () => {
    expect(levelSavedNote('Maya', 'premium', 'standard', payer)).toBe('Saved. Calls with Maya now cost $0.10 a minute.')
    expect(levelSavedNote('Maya', 'ultra', 'standard', noPrices(payer))).toBe('Saved. Maya now uses Ultra.')
    expect(levelSavedNote('Maya', 'standard', 'standard', payer)).toBeNull()
  })
})
