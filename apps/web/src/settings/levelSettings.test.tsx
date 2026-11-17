// The voice model, language model and Ultra pickers on Linedesk Cloud (LevelSettings, UltraSettings): Premium and Ultra
// choices the workspace may not use are shown greyed out, with one note under the pickers. Owners and admins (they have
// Billing) get a link to Workspace settings › Billing; members are told whom to ask.
import type { LevelChoice, UsageLevelOptions } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { NO_LEVELS } from './voiceSwitch.fixture.ts'

const options = vi.hoisted(() => ({ levels: undefined as unknown }))
vi.mock('./VoiceSettings.tsx', () => ({ useVoiceOptions: () => ({ data: { levels: options.levels } }) }))

const { LevelSettings } = await import('./LevelSettings.tsx')
const { UltraSettings } = await import('./UltraSettings.tsx')

const flash: LevelChoice = { id: 'eleven_flash_v2_5', name: 'ElevenLabs Flash v2.5', level: 'standard', allowed: true }
const v3: LevelChoice = { id: 'eleven_v3', name: 'ElevenLabs v3', level: 'premium', allowed: false }
const realtime: LevelChoice = { id: 'gpt-realtime', name: 'GPT Realtime', level: 'ultra', allowed: false }
const locked: UsageLevelOptions = {
  ...NO_LEVELS,
  billed: true,
  voiceModels: { elevenlabs: [flash, v3] },
  defaultVoiceModels: { elevenlabs: { id: 'eleven_flash_v2_5', level: 'standard' } },
  realtimeModels: [realtime],
  realtimeAllowed: false,
}

const levels = (canManageBilling: boolean) =>
  renderToStaticMarkup(
    <LevelSettings
      voice={{ provider: 'elevenlabs', model: '' } as never}
      llmModel=""
      onVoiceModel={() => {}}
      onModel={() => {}}
      canManageBilling={canManageBilling}
    />,
  )
const ultra = (canManageBilling: boolean) =>
  renderToStaticMarkup(
    <UltraSettings
      pipeline="three_stage"
      realtimeModel=""
      onPipeline={() => {}}
      onRealtimeModel={() => {}}
      canManageBilling={canManageBilling}
    />,
  )

test('owners and admins: Premium is greyed out with one note that links to Billing', () => {
  options.levels = locked
  const html = levels(true)
  expect(html).toContain('Needs Premium. Turn it on in')
  expect(html).toContain('href="#workspace/billing"')
  expect(html).not.toContain('Workspace settings › General')
})

test('members: the same note without a link, and whom to ask', () => {
  options.levels = locked
  const html = levels(false)
  expect(html).toContain('Needs Premium. Ask an owner or admin to turn on Premium in Billing.')
  expect(html).not.toContain('href="#workspace/billing"')
})

test('Ultra: greyed out, one note, the link for owners and admins only', () => {
  options.levels = locked
  expect(ultra(true)).toContain('Needs Ultra. Turn it on in')
  expect(ultra(true)).toContain('href="#workspace/billing"')
  expect(ultra(false)).toContain('Needs Ultra. Ask an owner or admin to turn on Ultra in Billing.')
  expect(ultra(false)).not.toContain('href=')
})

test('everything allowed: no note', () => {
  options.levels = { ...locked, voiceModels: { elevenlabs: [flash, { ...v3, allowed: true }] }, realtimeAllowed: true }
  expect(levels(true)).not.toContain('Needs Premium')
  expect(ultra(true)).not.toContain('Needs Ultra')
})
