import type { LevelChoice, UsageLevelOptions } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHOICE, draftLevel, levelOptions, levelTag, premiumLocked, pricePerMinute } from './levelModel.ts'
import { NO_LEVELS } from './voiceSwitch.fixture.ts'

const flash: LevelChoice = { id: 'eleven_flash_v2_5', name: 'ElevenLabs Flash v2.5', level: 'standard', allowed: true }
const v3: LevelChoice = { id: 'eleven_v3', name: 'ElevenLabs v3', level: 'premium', allowed: false }
const cloud: UsageLevelOptions = {
  ...NO_LEVELS,
  billed: true,
  voiceModels: { elevenlabs: [flash, v3] },
  defaultVoiceModels: { elevenlabs: { id: 'eleven_flash_v2_5', level: 'standard' } },
}

describe('level labels', () => {
  it('shows prices in cents, as decided', () => {
    expect(pricePerMinute(10)).toBe('10¢')
    expect(levelTag('premium', cloud)).toBe('Premium, 10¢/min')
    expect(levelTag('standard', cloud)).toBe('Standard')
  })

  it('shows no labels without billing', () => {
    expect(levelTag('premium', NO_LEVELS)).toBeUndefined()
  })
})

describe('levelOptions', () => {
  it('starts with the default it stands for, then the choices; Premium greyed out until allowed', () => {
    const options = levelOptions([flash, v3], cloud.defaultVoiceModels.elevenlabs, cloud, DEFAULT_CHOICE)
    expect(options.map(o => o.value)).toEqual([DEFAULT_CHOICE, 'eleven_flash_v2_5', 'eleven_v3'])
    expect(options[0]).toMatchObject({ label: 'Default (ElevenLabs Flash v2.5)', description: 'Standard' })
    expect(options[2]).toMatchObject({ disabled: true, description: 'Premium, 10¢/min. Needs Allow Premium' })
    const allowed = levelOptions([flash, { ...v3, allowed: true }], null, cloud, '')
    expect(allowed[2]).toMatchObject({ description: 'Premium, 10¢/min' })
    expect(allowed[2]).not.toHaveProperty('disabled')
  })

  it('keeps a saved choice that is no longer listed, so the picker never shows a blank', () => {
    expect(levelOptions([flash], null, cloud, 'eleven_turbo_v2_5').at(-1)).toEqual({
      value: 'eleven_turbo_v2_5',
      label: 'eleven_turbo_v2_5',
    })
  })
})

describe('draftLevel', () => {
  it('is Premium when either choice is, Standard when both are, unknown otherwise', () => {
    const voice = { choices: [flash, v3], picked: '', fallback: 'standard' as const }
    const model = { choices: [] as LevelChoice[], picked: '', fallback: 'standard' as const }
    expect(draftLevel(voice, model)).toBe('standard')
    expect(draftLevel({ ...voice, picked: 'eleven_v3' }, model)).toBe('premium')
    expect(draftLevel(voice, { ...model, fallback: null })).toBeNull()
  })
})

describe('premiumLocked', () => {
  it('is true on Cloud while a Premium choice cannot be picked', () => {
    expect(premiumLocked(cloud)).toBe(true)
    expect(premiumLocked({ ...cloud, voiceModels: { elevenlabs: [flash, { ...v3, allowed: true }] } })).toBe(false)
    expect(premiumLocked({ ...cloud, billed: false })).toBe(false)
  })
})
