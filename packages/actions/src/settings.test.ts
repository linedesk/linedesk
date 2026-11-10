import { describe, expect, it } from 'vitest'
import { assistantUpdate } from './settings.ts'

describe('assistant.update', () => {
  it('keeps the free-text instructions the voice agent reads', () => {
    const input = assistantUpdate.input.parse({ assistantId: 'as1', business_profile: { instructions: 'Hours: 24/7' } })
    expect(input.business_profile).toEqual({ instructions: 'Hours: 24/7' })
  })
})
