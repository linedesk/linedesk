// Settings › Assistant › General on Linedesk Cloud: whether the assistant's calls are answered by a realtime model
// (Ultra, levelModel.ts) or by speech to text, a language model and a voice (Standard or Premium), and which realtime
// model. Ultra needs the owner's Allow Ultra; without it the choice is shown, not pickable. Self-hosted installs pick
// the pipeline in Advanced instead (PipelineSection).
import type { VoicePipeline } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { Section, SelectRow } from './fields.tsx'
import { ALLOW_PREMIUM_LINK } from './LevelSettings.tsx'
import { levelOptions, pricePerMinute, ultraLocked } from './levelModel.ts'
import { useVoiceOptions } from './VoiceSettings.tsx'

type Props = {
  /** How the calls are answered now (answeringPipeline). */
  pipeline: VoicePipeline
  realtimeModel: string
  onPipeline: (pipeline: VoicePipeline) => void
  onRealtimeModel: (model: string) => void
}

export function UltraSettings({ pipeline, realtimeModel, onPipeline, onRealtimeModel }: Props) {
  const t = useT()
  const levels = useVoiceOptions().data?.levels
  // Only on Cloud, and only when a realtime model is set up to answer.
  if (!levels?.billed || !levels.realtimeModels.length) return null
  const price = pricePerMinute(levels.ultraCentsPerMinute)
  return (
    <Section id="as-ultra" title={t('settings.voice.ultra.title')}>
      <SelectRow
        id="as-ultra-pipeline"
        title={t('settings.voice.ultra.by')}
        description={t('settings.voice.ultra.byHelp')}
        value={pipeline}
        options={[
          { value: 'three_stage', label: t('settings.voice.ultra.stages') },
          {
            value: 'realtime',
            label: levels.partnerManaged
              ? t('settings.voice.ultra.realtimePlain')
              : t('settings.voice.ultra.realtime', { price }),
            ...(levels.realtimeAllowed ? {} : { description: t('settings.voice.ultra.realtimeOff'), disabled: true }),
          },
        ]}
        onChange={onPipeline}
      />
      {pipeline === 'realtime' && (
        <>
          <SelectRow
            id="as-realtime-model"
            title={t('settings.voice.ultra.model')}
            description={t('settings.voice.ultra.modelHelp')}
            value={realtimeModel}
            options={levelOptions(levels.realtimeModels, levels.defaultRealtimeModel, levels, realtimeModel)}
            onChange={onRealtimeModel}
          />
          {!levels.partnerManaged && (
            <p className="help" role="status">
              {t('settings.voice.ultra.note', { price })}
            </p>
          )}
        </>
      )}
      {ultraLocked(levels) && (
        <p className="help">
          {levels.partnerManaged ? (
            t('settings.voice.ultra.allowHintPartner')
          ) : (
            <T k="settings.voice.ultra.allowHint" values={{ link: appLink(ALLOW_PREMIUM_LINK) }} />
          )}
        </p>
      )}
    </Section>
  )
}
