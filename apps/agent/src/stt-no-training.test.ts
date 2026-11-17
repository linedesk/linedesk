import { initializeLogger } from '@livekit/agents'
import { beforeAll, expect, test, vi } from 'vitest'

// The plugin keeps its options private: record what each Deepgram client is constructed with.
const made = vi.hoisted(() => [] as { kind: string; opts: Record<string, unknown> }[])
vi.mock('@livekit/agents-plugin-deepgram', async importOriginal => {
  const real = await importOriginal<typeof import('@livekit/agents-plugin-deepgram')>()
  return {
    ...real,
    STT: class extends real.STT {
      constructor(opts: ConstructorParameters<typeof real.STT>[0]) {
        super(opts)
        made.push({ kind: 'nova', opts: { ...opts } })
      }
    },
    STTv2: class extends real.STTv2 {
      constructor(opts: ConstructorParameters<typeof real.STTv2>[0]) {
        super(opts)
        made.push({ kind: 'flux', opts: { ...opts } })
      }
    },
  }
})

const { createStt } = await import('./pipeline.ts')
type CallLanguages = import('./pipeline.ts').CallLanguages

beforeAll(() => initializeLogger({ pretty: false, level: 'fatal' }))

test('every live Deepgram stream opts out of model training (mip_opt_out), Flux and Nova alike', () => {
  const english: CallLanguages = { main: 'en', others: [] }
  const spanish: CallLanguages = { main: 'es', others: ['en'] }
  const chinese: CallLanguages = { main: 'zh', others: [] }
  createStt({ provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' }, english)
  createStt({ provider: 'deepgram', apiKey: 'dg', model: 'nova-3' }, english)
  createStt({ provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' }, spanish)
  createStt({ provider: 'deepgram', apiKey: 'dg', model: 'flux-general-en' }, chinese)
  expect(made.map(m => m.kind).sort()).toEqual(['flux', 'flux', 'nova', 'nova'])
  for (const { opts } of made) expect(opts.mipOptOut).toBe(true)
})
