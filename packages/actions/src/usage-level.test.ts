import { LEVEL_PRICES } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_MODEL_LEVELS,
  languageModelFor,
  languageModelLevel,
  languageModelsOf,
  centsPerMinute,
  REALTIME_MODEL_LEVELS,
  realtimeModelFor,
  realtimeModelLevel,
  CALL_QUALITY_INSTALL_DEFAULT,
  levelLanguageModel,
  levelLanguageModelsOf,
  levelRealtimeModel,
  levelRealtimeModelsOf,
  levelVoiceModel,
  levelVoiceModelsOf,
  partFits,
  raisesLevel,
  USAGE_CENTS_PER_MINUTE,
  usageLevel,
  VOICE_MODEL_LEVELS,
  voiceModelFor,
  voiceModelLevel,
} from './usage-level.ts'

const flash = { provider: 'elevenlabs', model: 'eleven_flash_v2_5' }
const v3 = { provider: 'elevenlabs', model: 'eleven_v3' }
const mini = { provider: 'openai', model: 'gpt-4.1-mini' }
const big = { provider: 'openai', model: 'gpt-5.4' }

const call = (voice: { provider: string; model: string }, model: { provider: string; model: string }) => ({
  voice,
  model,
})

describe('usageLevel', () => {
  const on = { ownKeys: false, levelEnabled: true }
  it('is the call quality alone, not the highest of its parts', () => {
    expect(usageLevel({ level: 'standard', parts: call(flash, mini), ...on })).toBe('standard')
    expect(usageLevel({ level: 'premium', parts: call(v3, big), ...on })).toBe('premium')
  })

  it('lets Premium run on Standard parts, at the Premium price (decision 3)', () => {
    expect(usageLevel({ level: 'premium', parts: call(flash, mini), ...on })).toBe('premium')
    expect(usageLevel({ level: 'premium', parts: call(v3, mini), ...on })).toBe('premium')
  })

  it('is not allowed for a part that does not belong to the level', () => {
    expect(usageLevel({ level: 'standard', parts: call(v3, mini), ...on })).toBe('not_allowed')
    expect(usageLevel({ level: 'standard', parts: call(flash, big), ...on })).toBe('not_allowed')
    expect(usageLevel({ level: 'ultra', parts: call(flash, mini), ...on })).toBe('not_allowed')
  })

  it('is not allowed on a level the server admin turned off, own keys or not', () => {
    expect(usageLevel({ level: 'premium', parts: call(v3, big), ownKeys: false, levelEnabled: false })).toBe(
      'not_allowed',
    )
    expect(usageLevel({ level: 'premium', parts: call(v3, big), ownKeys: true, levelEnabled: false })).toBe(
      'not_allowed',
    )
  })

  it('is not allowed for an option in no list', () => {
    expect(
      usageLevel({ level: 'premium', parts: call(flash, { provider: 'openai', model: 'gpt-5.6-terra' }), ...on }),
    ).toBe('not_allowed')
    expect(
      usageLevel({ level: 'standard', parts: call({ provider: 'cartesia', model: 'sonic-2' }, mini), ...on }),
    ).toBe('not_allowed')
  })

  it('is own keys, whatever the parts, on the workspace own keys', () => {
    expect(
      usageLevel({
        level: 'standard',
        parts: call(v3, { provider: 'x', model: 'y' }),
        ownKeys: true,
        levelEnabled: true,
      }),
    ).toBe('own_keys')
  })

  it('matches the model id at its provider only', () => {
    expect(
      usageLevel({
        level: 'standard',
        parts: call(flash, { provider: 'openrouter', model: 'openai/gpt-4.1-mini' }),
        ...on,
      }),
    ).toBe('standard')
    expect(
      usageLevel({ level: 'standard', parts: call(flash, { provider: 'openrouter', model: 'gpt-4.1-mini' }), ...on }),
    ).toBe('not_allowed')
  })
})

describe('call quality', () => {
  it('lets a part belong to its level: Standard Standard, Premium Premium and Standard, Ultra realtime only', () => {
    expect(partFits('standard', 'standard')).toBe(true)
    expect(partFits('premium', 'standard')).toBe(false)
    expect(partFits('standard', 'premium')).toBe(true)
    expect(partFits('premium', 'premium')).toBe(true)
    expect(partFits('ultra', 'premium')).toBe(false)
    expect(partFits('ultra', 'ultra')).toBe(true)
    expect(partFits('standard', 'ultra')).toBe(false)
    expect(partFits(null, 'premium')).toBe(false)
  })

  it('raises only to a dearer level', () => {
    expect(raisesLevel('standard', 'premium')).toBe(true)
    expect(raisesLevel('premium', 'ultra')).toBe(true)
    expect(raisesLevel('ultra', 'premium')).toBe(false)
    expect(raisesLevel('premium', 'standard')).toBe(false)
    expect(raisesLevel('premium', 'premium')).toBe(false)
  })

  it('defaults to GPT-4.1 mini and Flash v2.5 on Standard, GPT-4.1 and Multilingual v2 on Premium', () => {
    expect(levelLanguageModel('openai', 'standard')).toBe('gpt-4.1-mini')
    expect(levelLanguageModel('openrouter', 'standard')).toBe('openai/gpt-4.1-mini')
    expect(levelLanguageModel('openai', 'premium')).toBe('gpt-4.1')
    expect(levelVoiceModel('elevenlabs', 'standard')).toBe('eleven_flash_v2_5')
    expect(levelVoiceModel('elevenlabs', 'premium')).toBe('eleven_multilingual_v2')
    expect(levelRealtimeModel()).toBe('gpt-realtime')
  })

  it('takes the first pick that belongs to the level, else the default, else what the provider has', () => {
    expect(levelLanguageModel('openai', 'standard', 'gpt-5.4', 'gpt-5.4-nano')).toBe('gpt-5.4-nano')
    expect(levelLanguageModel('openai', 'premium', 'gpt-5.4-mini')).toBe('gpt-5.4-mini')
    expect(levelLanguageModel('mistral', 'premium')).toBe('mistral-small-latest')
    expect(levelLanguageModel('groq', 'standard', 'llama-9')).toBe('llama-3.3-70b-versatile')
    expect(levelLanguageModel('nobody', 'standard')).toBeNull()
    expect(levelVoiceModel('cartesia', 'premium')).toBe('sonic-3.6')
    expect(levelVoiceModel('elevenlabs', 'standard', 'eleven_v3')).toBe('eleven_flash_v2_5')
    expect(levelRealtimeModel('gpt-realtime-mini', 'gpt-realtime-2')).toBe('gpt-realtime-2')
  })

  it('lists the models of a level', () => {
    expect(levelVoiceModelsOf('elevenlabs', 'standard').map(m => m.id)).toEqual(['eleven_flash_v2_5'])
    expect(levelVoiceModelsOf('elevenlabs', 'premium').map(m => m.id)).toEqual([
      'eleven_flash_v2_5',
      'eleven_multilingual_v2',
      'eleven_v3',
    ])
    expect(levelLanguageModelsOf('openai', 'standard').map(m => m.id)).toEqual([
      'gpt-5.4-mini',
      'gpt-4.1-mini',
      'gpt-5.4-nano',
    ])
    expect(levelLanguageModelsOf('openai', 'ultra')).toEqual([])
    expect(levelRealtimeModelsOf().map(m => m.id)).toEqual(['gpt-realtime', 'gpt-realtime-2'])
  })

  it('keeps Premium and Ultra on and new assistants on Standard on a fresh install', () => {
    expect(CALL_QUALITY_INSTALL_DEFAULT).toMatchObject({ premium: true, ultra: true, default: 'standard' })
  })
})

describe('the lists', () => {
  it('have the decided prices', () => {
    expect(USAGE_CENTS_PER_MINUTE).toEqual({ standard: 5, premium: 10, ultra: 20, own_keys: 0 })
  })

  it('have no option twice', () => {
    const voices = VOICE_MODEL_LEVELS.map(v => `${v.provider}/${v.model}`)
    expect(new Set(voices).size).toBe(voices.length)
    const models = LANGUAGE_MODEL_LEVELS.flatMap(m => Object.entries(m.ids).map(([p, id]) => `${p}/${id}`))
    expect(new Set(models).size).toBe(models.length)
  })

  it('give each option its level', () => {
    expect(voiceModelLevel('elevenlabs', 'eleven_multilingual_v2')).toBe('premium')
    expect(voiceModelLevel('cartesia', 'sonic-3.6')).toBe('standard')
    expect(voiceModelLevel('openai', 'gpt-4o-mini-tts')).toBe('standard')
    expect(languageModelLevel('anthropic', 'claude-haiku-5-5')).toBe('standard')
    expect(languageModelLevel('gemini', 'gemini-3.8-flash')).toBe('premium')
    expect(languageModelLevel('groq', 'llama-3.3-70b-versatile')).toBe('standard')
    expect(languageModelLevel('gemini', 'gemini-2.5-flash')).toBeNull()
  })

  it('list the models a provider serves', () => {
    expect(languageModelsOf('mistral')).toEqual([
      { id: 'mistral-small-latest', name: 'Mistral Small', level: 'standard' },
    ])
    expect(languageModelsOf('openai').map(m => m.id)).toEqual([
      'gpt-5.4-mini',
      'gpt-4.1-mini',
      'gpt-5.4-nano',
      'gpt-5.4',
      'gpt-4.1',
    ])
  })
})

describe('the effective models', () => {
  it('use the assistant voice model only when its provider has it', () => {
    expect(voiceModelFor('elevenlabs', 'eleven_v3', 'eleven_turbo_v2_5')).toBe('eleven_v3')
    expect(voiceModelFor('cartesia', 'eleven_v3', null)).toBe('sonic-3.6')
    expect(voiceModelFor('elevenlabs', undefined, 'eleven_turbo_v2_5')).toBe('eleven_turbo_v2_5')
    expect(voiceModelFor('elevenlabs', '', null)).toBe('eleven_flash_v2_5')
  })

  it('use the assistant language model only when the install provider serves it', () => {
    expect(languageModelFor('openai', 'gpt-5.4', 'gpt-4.1-mini')).toBe('gpt-5.4')
    expect(languageModelFor('gemini', 'gpt-5.4', 'gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite')
    expect(languageModelFor('openai', null, 'gpt-4.1-mini')).toBe('gpt-4.1-mini')
  })
})

describe('realtime models (Ultra)', () => {
  const realtime = { provider: 'openai_realtime', model: 'gpt-realtime' }
  it('are listed as Ultra: gpt-realtime and gpt-realtime-2; others are in no list', () => {
    expect(REALTIME_MODEL_LEVELS.map(m => [m.model, m.level])).toEqual([
      ['gpt-realtime', 'ultra'],
      ['gpt-realtime-2', 'ultra'],
    ])
    expect(realtimeModelLevel('gpt-realtime-mini')).toBeNull()
  })
  it('a realtime model belongs to Ultra only', () => {
    const on = { ownKeys: false, levelEnabled: true }
    expect(usageLevel({ level: 'ultra', parts: call(realtime, realtime), ...on })).toBe('ultra')
    expect(usageLevel({ level: 'premium', parts: call(realtime, realtime), ...on })).toBe('not_allowed')
    expect(usageLevel({ level: 'ultra', parts: call(realtime, realtime), ownKeys: true, levelEnabled: true })).toBe(
      'own_keys',
    )
    const mini = { provider: 'openai_realtime', model: 'gpt-realtime-mini' }
    expect(usageLevel({ level: 'ultra', parts: call(mini, mini), ...on })).toBe('not_allowed')
  })
})

describe('centsPerMinute', () => {
  it('prices the levels a call can run on, and throws for one without a price', () => {
    expect(centsPerMinute('standard')).toBe(5)
    expect(centsPerMinute('premium')).toBe(10)
    expect(centsPerMinute('own_keys')).toBe(0)
    expect(() => centsPerMinute('not_allowed')).toThrow(/must not run/)
    expect(centsPerMinute('ultra')).toBe(20)
  })
  it("takes every paid level's price from the billing price table (LEVEL_PRICES)", () => {
    for (const level of ['standard', 'premium', 'ultra'] as const)
      expect(centsPerMinute(level) * 10_000).toBe(LEVEL_PRICES[level].microsPerMinute)
  })
})

describe('realtimeModelFor', () => {
  it("is the assistant's listed realtime model, else the install's", () => {
    expect(realtimeModelFor('gpt-realtime-2', 'gpt-realtime')).toBe('gpt-realtime-2')
    expect(realtimeModelFor(null, 'gpt-realtime')).toBe('gpt-realtime')
    expect(realtimeModelFor(' ', 'gpt-realtime')).toBe('gpt-realtime')
    // Not in the list (gpt-realtime-2.1 is left out on purpose): the install's.
    expect(realtimeModelFor('gpt-realtime-2.1', 'gpt-realtime')).toBe('gpt-realtime')
    expect(REALTIME_MODEL_LEVELS.map(m => m.model)).toEqual(['gpt-realtime', 'gpt-realtime-2'])
  })
})
