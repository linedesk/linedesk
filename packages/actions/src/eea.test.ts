import { describe, expect, test } from 'vitest'
import {
  AI_DISCLOSURE_MODES,
  aiDisclosureInstructions,
  aiDisclosureRisk,
  DEFAULT_AI_DISCLOSURE,
} from './assistant-prompt.ts'
import { greetingFor } from './business.ts'
import { EEA_UK_COUNTRIES, inEeaOrUk } from './eea.ts'
import { DEFAULT_RECORDING_NOTICE } from './settings.ts'

describe('inEeaOrUk', () => {
  test('the EU, the EEA and the UK; not Switzerland or the US', () => {
    expect(EEA_UK_COUNTRIES).toHaveLength(31)
    for (const c of ['DE', 'FR', 'IE', 'NO', 'IS', 'LI', 'GB', 'de', ' gb ']) expect(inEeaOrUk(c)).toBe(true)
    for (const c of ['CH', 'US', 'CA', 'PR', '', null, undefined]) expect(inEeaOrUk(c)).toBe(false)
  })
})

describe('AI disclosure (A1, A2)', () => {
  test('new assistants say at the start that they are an AI', () => {
    expect(DEFAULT_AI_DISCLOSURE).toBe('at_start')
    expect(greetingFor('Brightwater', 'Maya')).toBe(
      'Thanks for calling Brightwater. This is Maya, the AI assistant. How can I help?',
    )
  })
  test('every mode can be picked in every country; the risk only decides the warning', () => {
    expect(AI_DISCLOSURE_MODES).toEqual(['never_confirm', 'never', 'when_asked', 'at_start', 'at_start_consent'])
    expect(aiDisclosureRisk('never', 'DE')).toEqual({ level: 'law', eu: true })
    expect(aiDisclosureRisk('when_asked', 'GB')).toEqual({ level: 'law', eu: true })
    expect(aiDisclosureRisk('when_asked', 'US')).toEqual({ level: 'law', eu: false })
    expect(aiDisclosureRisk('never_confirm', 'US')).toEqual({ level: 'strong', eu: false })
    expect(aiDisclosureRisk('never_confirm', 'FR')).toEqual({ level: 'strong', eu: true })
    expect(aiDisclosureRisk('at_start', 'DE')).toEqual({ level: 'none', eu: true })
    expect(aiDisclosureRisk('at_start_consent', 'US')).toEqual({ level: 'none', eu: false })
    expect(aiDisclosureRisk(null, 'NO')).toEqual({ level: 'none', eu: true })
  })
  test('"never, not even when asked" neither confirms nor denies, and never claims to be human', () => {
    const text = aiDisclosureInstructions('never_confirm')
    expect(text).toBe(
      "Do not bring up on your own that you are an AI. If the caller asks whether you are a person, a robot or an AI, don't confirm or deny it: say that you are here to help with their call, and carry on. Never claim to be human.",
    )
    expect(text).not.toContain('say truthfully')
    for (const mode of AI_DISCLOSURE_MODES.filter(m => m !== 'never_confirm'))
      expect(aiDisclosureInstructions(mode)).toContain('say truthfully that you are an AI assistant. Never claim to be human.')
  })
})

describe('recording notice (A4)', () => {
  test('the default notice mentions transcription', () => {
    expect(DEFAULT_RECORDING_NOTICE).toBe('This call may be recorded and transcribed.')
  })
})
