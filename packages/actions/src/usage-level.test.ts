import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_MODEL_LEVELS,
  languageModelFor,
  languageModelLevel,
  languageModelsOf,
  centsPerMinute,
  levelAllowed,
  REALTIME_MODEL_LEVELS,
  realtimeModelLevel,
  USAGE_CENTS_PER_MINUTE,
  usageLevel,
  usageLevelProblem,
  VOICE_MODEL_LEVELS,
  voiceModelFor,
  voiceModelLevel,
} from './usage-level.ts'

const flash = { provider: 'elevenlabs', model: 'eleven_flash_v2_5' }
const v3 = { provider: 'elevenlabs', model: 'eleven_v3' }
const mini = { provider: 'openai', model: 'gpt-4.1-mini' }
const big = { provider: 'openai', model: 'gpt-5.4' }

describe('usageLevel', () => {
  it('is Standard when voice and model are Standard', () => {
    expect(usageLevel({ voice: flash, model: mini, ownKeys: false })).toBe('standard')
  })

  it('is Premium when the voice or the model is Premium', () => {
    expect(usageLevel({ voice: v3, model: mini, ownKeys: false, allowPremium: true })).toBe('premium')
    expect(usageLevel({ voice: flash, model: big, ownKeys: false, allowPremium: true })).toBe('premium')
    expect(usageLevel({ voice: v3, model: big, ownKeys: false })).toBe('premium')
  })

  it('is not allowed for Premium without Allow Premium', () => {
    expect(usageLevel({ voice: v3, model: mini, ownKeys: false, allowPremium: false })).toBe('not_allowed')
    expect(usageLevel({ voice: flash, model: mini, ownKeys: false, allowPremium: false })).toBe('standard')
  })

  it('is not allowed for an option in neither list', () => {
    expect(usageLevel({ voice: flash, model: { provider: 'openai', model: 'gpt-5.6-terra' }, ownKeys: false })).toBe(
      'not_allowed',
    )
    expect(usageLevel({ voice: { provider: 'cartesia', model: 'sonic-2' }, model: mini, ownKeys: false })).toBe(
      'not_allowed',
    )
  })

  it('is own keys, whatever the choices, on the workspace own keys', () => {
    expect(usageLevel({ voice: v3, model: { provider: 'x', model: 'y' }, ownKeys: true, allowPremium: false })).toBe(
      'own_keys',
    )
  })

  it('matches the model id at its provider only', () => {
    expect(
      usageLevel({ voice: flash, model: { provider: 'openrouter', model: 'openai/gpt-4.1-mini' }, ownKeys: false }),
    ).toBe('standard')
    expect(usageLevel({ voice: flash, model: { provider: 'openrouter', model: 'gpt-4.1-mini' }, ownKeys: false })).toBe(
      'not_allowed',
    )
  })
})

describe('the lists', () => {
  it('have the decided prices', () => {
    expect(USAGE_CENTS_PER_MINUTE).toEqual({ standard: 5, premium: 10, own_keys: 0 })
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

describe('usageLevelProblem', () => {
  it('names why a Cloud workspace may not use the choices', () => {
    expect(usageLevelProblem({ voice: v3, model: mini, ownKeys: false, allowPremium: false })).toBe('premiumNotAllowed')
    expect(usageLevelProblem({ voice: v3, model: mini, ownKeys: false, allowPremium: true })).toBeNull()
    expect(
      usageLevelProblem({
        voice: flash,
        model: { provider: 'openai', model: 'o9' },
        ownKeys: false,
        allowPremium: true,
      }),
    ).toBe('ownKeysOnly')
    expect(
      usageLevelProblem({
        voice: flash,
        model: { provider: 'openai', model: 'o9' },
        ownKeys: true,
        allowPremium: false,
      }),
    ).toBeNull()
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

describe('levelAllowed', () => {
  const off = { billed: true, allowPremium: false, allowUltra: false, ownKeys: false }
  it('allows everything without billing or with own keys, Premium only with Allow Premium, Ultra with Allow Ultra', () => {
    expect(levelAllowed('premium', { ...off, billed: false })).toBe(true)
    expect(levelAllowed('premium', { ...off, ownKeys: true })).toBe(true)
    expect(levelAllowed('premium', off)).toBe(false)
    expect(levelAllowed('premium', { ...off, allowPremium: true })).toBe(true)
    expect(levelAllowed('standard', off)).toBe(true)
    expect(levelAllowed('ultra', { ...off, allowPremium: true })).toBe(false)
    expect(levelAllowed('ultra', { ...off, allowUltra: true })).toBe(true)
    expect(levelAllowed('ultra', { ...off, billed: false })).toBe(true)
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
  it('a realtime call is Ultra, which is not allowed until Allow Ultra exists', () => {
    expect(usageLevel({ voice: realtime, model: realtime, ownKeys: false })).toBe('not_allowed')
    expect(usageLevel({ voice: realtime, model: realtime, ownKeys: false, allowUltra: true })).toBe('ultra')
    expect(usageLevel({ voice: realtime, model: realtime, ownKeys: true })).toBe('own_keys')
    expect(usageLevelProblem({ voice: realtime, model: realtime, ownKeys: false, allowPremium: true })).toBe(
      'ultraNotAllowed',
    )
    const mini = { provider: 'openai_realtime', model: 'gpt-realtime-mini' }
    expect(usageLevelProblem({ voice: mini, model: mini, ownKeys: false, allowPremium: true })).toBe('ownKeysOnly')
  })
})

describe('centsPerMinute', () => {
  it('prices the levels a call can run on, and throws for one without a price', () => {
    expect(centsPerMinute('standard')).toBe(5)
    expect(centsPerMinute('premium')).toBe(10)
    expect(centsPerMinute('own_keys')).toBe(0)
    expect(() => centsPerMinute('not_allowed')).toThrow(/must not run/)
    expect(() => centsPerMinute('ultra')).toThrow(/must not run/)
  })
})
