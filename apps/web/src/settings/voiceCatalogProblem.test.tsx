// More voices when a provider's list could not be read: one calm problem with Try again instead of "No voices yet"
// and the provider's raw English, worded for the reader; the hint about providers without a key only for server admins.
import type { CatalogProvider, VoiceCatalogData } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setProviderAudience } from '../providerAudience.ts'
import { SWITCH_CATALOG } from './voiceSwitch.fixture.ts'

vi.mock('../cachedQuery.ts', () => ({ useQuery: () => ({ data: undefined, error: null, reload: () => {} }) }))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), useWriteAction: () => vi.fn() }))

const { MoreVoices } = await import('./VoiceSettings.tsx')
const { oncePerVoice } = await import('./voiceModel.ts')

const elevenlabs = (error: string | null): CatalogProvider => ({
  provider: 'elevenlabs',
  label: 'ElevenLabs',
  active: true,
  configured: true,
  error: error as CatalogProvider['error'],
})
const cartesia = (configured: boolean): CatalogProvider => ({
  provider: 'cartesia',
  label: 'Cartesia',
  active: false,
  configured,
  error: null,
})

function more(catalog: VoiceCatalogData) {
  return renderToStaticMarkup(
    <MoreVoices
      catalog={catalog}
      voices={oncePerVoice(catalog.voices)}
      main="de"
      others={[]}
      assistantName="Mia"
      error={null}
      onRetry={() => {}}
      selected=""
      onPick={() => {}}
      disabled={false}
      preview={{ playing: null, loading: null, progress: 0, failed: null, toggle: async () => {} }}
    />,
  )
}

const unreadable: VoiceCatalogData = { providers: [elevenlabs('permission'), cartesia(false)], voices: [] }

afterEach(() => setProviderAudience('member'))

describe('More voices when the voice list could not be read', () => {
  it('shows one problem with Try again, not "No voices yet", and no Server admin hint for a customer', () => {
    setProviderAudience('member')
    const html = more(unreadable)
    expect(html).toContain('role="alert"')
    expect(html).toContain('The key for ElevenLabs is missing a permission.')
    expect(html).toContain('Ask whoever runs this server to check the key.')
    expect(html).toContain('Try again')
    expect(html).not.toContain('No voices yet')
    expect(html).not.toContain('Server admin')
    expect(html).not.toContain('Cartesia')
    expect(html).not.toContain('class="vp-tools"') // no search or filters over an empty list
  })

  it('tells a server admin what to fix, and which providers still need a key', () => {
    setProviderAudience('admin')
    const html = more(unreadable)
    expect(html).toContain('Give the key the permission, or enter another key under Server admin › Providers.')
    expect(html).toContain('Cartesia voices appear here once Cartesia has a key in')
    expect(html).toContain('#admin/providers/answering')
    expect(html).not.toContain('No voices yet')
  })

  it('never shows the text an older API sent, only a translated sentence', () => {
    const html = more({
      providers: [elevenlabs('ElevenLabs: the voice list could not be read. Try again in a minute.'), cartesia(false)],
      voices: [],
    })
    expect(html).not.toContain('could not be read')
    expect(html).toContain('ElevenLabs failed.')
    expect(html).toContain('Try again')
  })

  it('a passing problem asks to try again in a moment', () => {
    const html = more({ providers: [elevenlabs('network'), cartesia(false)], voices: [] })
    expect(html).toContain('ElevenLabs is not reachable right now.')
    expect(html).toContain('Try again in a moment.')
  })

  it("lists the other providers' voices, with the problem under them", () => {
    const html = more({ ...SWITCH_CATALOG, providers: [elevenlabs('timeout'), cartesia(true)] })
    expect(html).toContain('class="vp-list"')
    expect(html).toContain('ElevenLabs did not answer in time.')
    expect(html).toContain('Try again')
    expect(html).not.toContain('role="alert"')
  })
})

describe('the hint about providers without a key', () => {
  const noKey: VoiceCatalogData = { ...SWITCH_CATALOG, providers: [elevenlabs(null), cartesia(false)] }
  it('is for server admins only', () => {
    setProviderAudience('member')
    expect(more(noKey)).not.toContain('appear here once')
    setProviderAudience('admin')
    expect(more(noKey)).toContain('Cartesia voices appear here once Cartesia has a key in')
  })
})
