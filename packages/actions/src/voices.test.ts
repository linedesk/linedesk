import { describe, expect, it } from 'vitest'
import { curatedVoices, curatedVoicesIn } from './voices.ts'
import { english, type Words } from './words.ts'

describe('curated voices', () => {
  it("describe each voice in the reader's words, English by default (LIN-371)", () => {
    const keys: Words = { ...english, t: (key => key) as Words['t'] }
    const ids = (curatedVoices.elevenlabs ?? []).map(v => v.id)
    expect(curatedVoicesIn('elevenlabs', keys).map(v => v.id)).toEqual(ids)
    for (const voice of curatedVoicesIn('elevenlabs', keys))
      expect(voice.description).toMatch(/^settings\.voice\.curated\./)
    expect(curatedVoicesIn('elevenlabs')[0]?.description).toBe('Warm and bright, female')
    expect(curatedVoicesIn('nobody')).toEqual([])
  })
})
