// The Voice card until the voice options are read (LIN-432): grey rows in the card, never a default voice that turns
// into the realtime model's voices (or the other way round) when the options come.
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
const state: { data: VoiceOptionsData | undefined; error: string | null } = { data: undefined, error: null }
vi.mock('../cachedQuery.ts', () => ({
  useQuery: () => ({ ...state, reload: () => {} }),
  refreshQuery: () => {},
}))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), useWriteAction: () => vi.fn() }))

const { VoiceLoading } = await import('./VoiceSettings.tsx')

const card = () =>
  renderToStaticMarkup(
    <VoiceLoading>
      <p>the voice picker</p>
    </VoiceLoading>,
  )

describe('the Voice card while the voice options load', () => {
  it('shows the card with skeleton rows, not the picker', () => {
    state.data = undefined
    state.error = null
    const html = card()
    expect(html).toContain('id="as-voice"')
    expect(html).toContain('aria-busy="true"')
    expect(html.match(/class="vp-row"/g)).toHaveLength(2)
    expect(html).not.toContain('the voice picker')
    expect(html).not.toContain('Default voice')
  })

  it('shows the picker once the options are there', () => {
    state.data = OPTIONS
    expect(card()).toBe('<p>the voice picker</p>')
  })

  it('says when the options could not be read, with Try again', () => {
    state.data = undefined
    state.error = 'The server did not answer'
    const html = card()
    expect(html).toContain('The server did not answer')
    expect(html).not.toContain('class="vp-row"')
  })
})
