// Server admin › Calls › Call quality (CallQuality.tsx): Standard always on, Premium and Ultra by switch (Ultra only
// with a realtime model), prices where the install bills, the level new assistants start on (only levels that are on),
// the default models per level; a level turned off says how many assistants moved, and Undo puts them back.
import type { CallQualityAdminData, CallQualityAdminLevel } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ data: undefined as unknown, calls: [] as unknown[], answer: undefined as unknown }))
vi.mock('../cachedQuery.ts', () => ({
  useQuery: () => ({ data: state.data, error: null, reload: () => {} }),
  setQueryData: (_key: string, data: unknown) => {
    state.data = data
  },
}))
vi.mock('./api.ts', () => ({
  runAdmin: async (name: string, input: unknown) => {
    state.calls.push([name, input])
    return state.answer
  },
}))

const { CallQualityCard, changeCallQuality } = await import('./CallQuality.tsx')

const mini = { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' }
const full = { id: 'gpt-4.1', name: 'GPT-4.1' }
const flash = { id: 'eleven_flash_v2_5', name: 'ElevenLabs Flash v2.5' }
const multi = { id: 'eleven_multilingual_v2', name: 'ElevenLabs Multilingual v2' }
const realtime = { id: 'gpt-realtime', name: 'GPT Realtime' }
const flux = { id: 'flux-general-en', name: 'Deepgram Flux' }
const nova = { id: 'nova-3', name: 'Deepgram Nova-3' }
const levels = (ultraOn: boolean): CallQualityAdminLevel[] => [
  {
    level: 'standard',
    enabled: true,
    models: [mini],
    voiceModels: { elevenlabs: [flash] },
    realtimeModels: [],
    sttModels: [flux, nova],
    defaults: {
      llm: 'gpt-4.1-mini',
      voice: { elevenlabs: 'eleven_flash_v2_5' },
      realtime: null,
      stt: 'flux-general-en',
    },
  },
  {
    level: 'premium',
    enabled: true,
    models: [full, mini],
    voiceModels: { elevenlabs: [multi, flash] },
    realtimeModels: [],
    sttModels: [flux, nova],
    defaults: { llm: 'gpt-4.1', voice: { elevenlabs: 'eleven_multilingual_v2' }, realtime: null, stt: 'nova-3' },
  },
  {
    level: 'ultra',
    enabled: ultraOn,
    models: [],
    voiceModels: {},
    realtimeModels: [realtime],
    sttModels: [],
    defaults: { llm: null, voice: {}, realtime: 'gpt-realtime', stt: null },
  },
]
const billed: CallQualityAdminData = {
  settings: { premium: true, ultra: false, default: 'standard', models: { standard: {}, premium: {}, ultra: {} } },
  realtimeSetUp: true,
  centsPerMinute: { standard: 5, premium: 10, ultra: 20 },
  llmProvider: 'openai',
  sttProvider: 'deepgram',
  levels: levels(false),
}

const render = (data: CallQualityAdminData) => {
  state.data = data
  return renderToStaticMarkup(<CallQualityCard notify={() => {}} />)
}

beforeEach(() => {
  state.calls = []
})

describe('the Call quality card', () => {
  it('shows the levels with their prices and a link to Billing where the install bills', () => {
    const html = render(billed)
    expect(html).toContain('Prices are set in <a')
    expect(html).toContain('href="#admin/billing"')
    expect(html).toContain('Fast and reliable for most calls. $0.05 a minute.')
    expect(html).toContain('Always on')
    expect(html).toContain('A smarter model and a more expressive voice. $0.10 a minute.')
    expect(html).toContain('One realtime model hears and speaks. $0.20 a minute.')
  })

  it('without billing: the same levels without prices', () => {
    const html = render({ ...billed, centsPerMinute: null })
    expect(html).toContain('What assistants can pick.')
    expect(html).not.toContain('Billing')
    expect(html).not.toContain('a minute')
  })

  it('Ultra cannot be turned on until a realtime model is connected', () => {
    const html = render({ ...billed, realtimeSetUp: false })
    expect(html).toContain('Connect a realtime model first.')
    expect(html).toMatch(/aria-label="Ultra"[^>]*disabled|disabled[^>]*aria-label="Ultra"/)
  })

  it('offers the levels that are on for new assistants, and the default models per level, Ultra marked off', () => {
    const html = render(billed)
    expect(html).toContain('New assistants start on')
    expect(html).toContain('Show default models')
    expect(html).toContain('GPT-4.1 mini')
    expect(html).toContain('ElevenLabs Multilingual v2')
    expect(html).toContain('GPT Realtime')
    expect(html).toMatch(/Ultra<span class="[^"]*">Off<\/span>/)
  })

  it("shows speech recognition per Standard and Premium, with the models of the install's provider", () => {
    const html = render(billed)
    expect(html).toContain('Speech recognition')
    expect(html).toMatch(/id="adm-cq-standard-stt"/)
    expect(html).toMatch(/id="adm-cq-premium-stt"/)
    expect(html).not.toMatch(/id="adm-cq-ultra-stt"/)
    expect(html).toContain('Deepgram Nova-3')
  })

  it('no speech recognition provider set up: no speech recognition rows', () => {
    const none = levels(false).map(l => ({ ...l, sttModels: [], defaults: { ...l.defaults, stt: null } }))
    const html = render({ ...billed, sttProvider: null, levels: none })
    expect(html).not.toContain('Speech recognition')
  })
})

describe('turning a level off', () => {
  it('says how many assistants moved to Standard; Undo turns it back on and moves them back', async () => {
    const notify = vi.fn()
    state.answer = {
      ...billed,
      settings: { ...billed.settings, premium: false },
      moved: [{ level: 'premium', assistantIds: ['as1', 'as2'] }],
    }
    await changeCallQuality({ premium: false }, 'premium', notify)
    expect(state.calls).toEqual([['callQuality.set', { premium: false }]])
    expect(notify).toHaveBeenCalledWith('Premium is off. 2 assistants moved to Standard.', expect.any(Function))
    state.answer = billed
    await notify.mock.calls[0]![1]()
    expect(state.calls[1]).toEqual([
      'callQuality.set',
      { premium: true, restore: { level: 'premium', assistantIds: ['as1', 'as2'] } },
    ])
  })

  it('says so when no assistant used it', async () => {
    const notify = vi.fn()
    state.answer = { ...billed, moved: [{ level: 'premium', assistantIds: [] }] }
    await changeCallQuality({ premium: false }, 'premium', notify)
    expect(notify.mock.calls[0]![0]).toBe('Premium is off. No assistant used it.')
  })
})
