// Settings › Assistant › General: the voice model and the language model the assistant's calls use. On Linedesk Cloud
// each has a level (Standard or Premium, levelModel.ts); a Premium one needs Allow Premium (Workspace settings ›
// Billing). Premium choices the workspace may not use are shown greyed out, with one note under the pickers.
import { T, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { sectionHash } from '../ui/SettingsLayout.tsx'
import type { Draft } from './assistantDraft.ts'
import { Section, SelectRow } from './fields.tsx'
import { draftLevel, levelOptions, levelTag, premiumLocked, pricePerMinute } from './levelModel.ts'
import { useVoiceOptions } from './VoiceSettings.tsx'

/** Where Premium and Ultra are allowed (Workspace settings › Billing, owners and admins). */
export const ALLOW_PREMIUM_LINK = sectionHash('workspace', 'billing')

type Props = {
  voice: Draft['voice']
  llmModel: string
  onVoiceModel: (model: string) => void
  onModel: (model: string) => void
  /** Owners and admins (they have Billing, where Premium is allowed): the note links there; members are told to ask. */
  canManageBilling: boolean
}

export function LevelSettings({ voice, llmModel, onVoiceModel, onModel, canManageBilling }: Props) {
  const t = useT()
  const { data: options } = useVoiceOptions()
  const levels = options?.levels
  if (!levels) return null
  const voiceChoices = levels.voiceModels[voice.provider] ?? []
  const voiceDefault = levels.defaultVoiceModels[voice.provider]
  if (!voiceChoices.length && !levels.models.length) return null
  const level = draftLevel(
    { choices: voiceChoices, picked: voice.model, fallback: voiceDefault?.level ?? null },
    { choices: levels.models, picked: llmModel, fallback: levels.defaultModel?.level ?? null },
  )
  const prices = {
    standard: pricePerMinute(levels.standardCentsPerMinute),
    premium: pricePerMinute(levels.premiumCentsPerMinute),
  }
  return (
    <Section
      id="as-level"
      title={t('settings.voice.level.title')}
      description={levels.billed && !levels.partnerManaged ? t('settings.voice.level.help', prices) : undefined}
    >
      {voiceChoices.length > 0 && (
        <SelectRow
          id="as-voice-model"
          title={t('settings.voice.level.voiceModel')}
          description={t('settings.voice.level.voiceModelHelp')}
          value={voice.model}
          options={levelOptions(voiceChoices, voiceDefault, levels, voice.model)}
          onChange={onVoiceModel}
        />
      )}
      {levels.models.length > 0 && (
        <SelectRow
          id="as-llm-model"
          title={t('settings.voice.level.model')}
          description={t('settings.voice.level.modelHelp')}
          value={llmModel}
          options={levelOptions(levels.models, levels.defaultModel, levels, llmModel)}
          onChange={onModel}
        />
      )}
      <div className="st-notes">
        {levels.billed && !levels.partnerManaged && level && (
          <p className="help" role="status">
            {level === 'premium'
              ? t('settings.voice.level.premiumNote', prices)
              : t('settings.voice.level.standardNote', { level: levelTag('standard', levels), price: prices.standard })}
          </p>
        )}
        {premiumLocked(levels) && (
          <p className="help">
            {levels.partnerManaged ? (
              t('settings.voice.level.allowHintPartner')
            ) : canManageBilling ? (
              <T k="settings.voice.level.allowHint" values={{ link: appLink(ALLOW_PREMIUM_LINK) }} />
            ) : (
              t('settings.voice.level.allowHintAsk')
            )}
          </p>
        )}
      </div>
    </Section>
  )
}
