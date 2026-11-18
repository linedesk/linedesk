// Settings › Assistant › General: the assistant's call quality (decisions.md 2026-11-17). Standard, Premium or Ultra,
// each with one line and its price a minute (none for a partner's client, a workspace without a bill or a self-hosted
// install); the level alone decides the price. Under it, collapsed, the models of the level: the language model and the
// voice model, or the realtime model on Ultra, each on "Default (…)" until picked. Only the person who pays raises the
// level (voice.options `callQuality.mayRaise`); anyone who edits the assistant lowers it.
import {
  type CallQuality,
  type CallQualityLevelOption,
  type CallQualityOptions,
  type ModelChoice,
  raisesLevel,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { LinkButton } from '../ui/AppLink.tsx'
import { RadioCard, type SelectOption } from '../ui/controls.tsx'
import { Badge, Icon } from '../ui/kit.tsx'
import type { Draft } from './assistantDraft.ts'
import { Section, SelectRow } from './fields.tsx'
import { DEFAULT_CHOICE, levelName, levelPrice, pricePerMinute } from './levelModel.ts'
import { useVoiceOptions } from './VoiceSettings.tsx'

type Picks = Pick<Draft, 'call_quality' | 'voice' | 'llm_model' | 'realtime_model'>

/** The level's line under its name. */
const LEVEL_LINE: Record<CallQuality, MessageKey> = {
  standard: msg('settings.voice.quality.standardLine'),
  premium: msg('settings.voice.quality.premiumLine'),
  ultra: msg('settings.voice.quality.ultraLine'),
}

/**
 * The assistant on another level: its picks that are not of that level go, so they follow the level's defaults (the
 * server does the same in the same save).
 */
export function withLevel<P extends Picks>(
  picks: P,
  level: CallQuality,
  option: CallQualityLevelOption | undefined,
): P {
  const has = (list: readonly ModelChoice[] | undefined, id: string) => !!id && !!list?.some(m => m.id === id)
  return {
    ...picks,
    call_quality: level,
    llm_model: has(option?.models, picks.llm_model) ? picks.llm_model : '',
    voice: {
      ...picks.voice,
      model: has(option?.voiceModels[picks.voice.provider], picks.voice.model) ? picks.voice.model : '',
    },
    realtime_model: has(option?.realtimeModels, picks.realtime_model) ? picks.realtime_model : '',
  }
}

/**
 * What the save toast says after a change of level: what the calls cost now, or the level where there are no prices;
 * null while the level is the saved one.
 */
export function levelSavedNote(
  name: string,
  level: CallQuality,
  savedLevel: CallQuality,
  options: CallQualityOptions | undefined,
): string | null {
  if (level === savedLevel) return null
  const t = i18n().t
  const cents = options?.levels.find(l => l.level === level)?.centsPerMinute
  return cents == null
    ? t('settings.voice.quality.savedLevel', { name, level: levelName(level) })
    : t('settings.voice.quality.savedPrice', { name, price: pricePerMinute(cents) })
}

/** The options of a model picker: "Default (<what it stands for>)", then the level's models in list order. */
function modelOptions(choices: readonly ModelChoice[], defaultId: string | null | undefined, current: string) {
  const t = i18n().t
  const named = choices.find(c => c.id === defaultId)?.name ?? defaultId
  const options: SelectOption<string>[] = [
    {
      value: DEFAULT_CHOICE,
      label: named ? t('settings.voice.quality.defaultNamed', { model: named }) : t('settings.voice.quality.default'),
    },
    ...choices.map(c => ({ value: c.id, label: c.name })),
  ]
  // Saved before a list changed: kept as the selected option, so the picker never shows a blank.
  if (current && !choices.some(c => c.id === current)) options.push({ value: current, label: current })
  return options
}

type Props = {
  picks: Picks
  onChange: (picks: Picks) => void
  /** The assistant's name, as the texts say it ("What Maya thinks with during the call"). */
  name: string
  /** The level as saved: someone who may not pay may still go back to it. */
  savedLevel: CallQuality
}

export function CallQualitySettings({ picks, onChange, name, savedLevel }: Props) {
  const t = useT()
  const options = useVoiceOptions().data?.callQuality
  const [open, setOpen] = useState(false)
  if (!options) return null
  const level = picks.call_quality
  const current = options.levels.find(l => l.level === level)
  // Raising above the saved level is for the person who pays; going back down is for anyone who edits.
  const locked = (l: CallQuality) => !options.mayRaise && raisesLevel(savedLevel, l)
  const anyLocked = options.levels.some(l => locked(l.level))
  const price = current?.centsPerMinute == null ? null : pricePerMinute(current.centsPerMinute)
  const voiceChoices = current?.voiceModels[picks.voice.provider] ?? []
  const ownPicks = !!(picks.llm_model || picks.voice.model || picks.realtime_model)
  return (
    <Section id="as-quality" title={t('settings.voice.quality.title')}>
      <div className="cq-levels" role="radiogroup" aria-label={t('settings.voice.quality.title')}>
        {options.levels.map(l => (
          <RadioCard
            key={l.level}
            name="as-quality"
            checked={l.level === level}
            disabled={locked(l.level)}
            onPick={() => onChange(withLevel(picks, l.level, l))}
            title={
              <>
                {levelName(l.level)}
                {l.level === options.defaultLevel && <Badge>{t('settings.voice.quality.defaultBadge')}</Badge>}
                {levelPrice(l) && <span className="cq-price">{levelPrice(l)}</span>}
              </>
            }
            description={t(LEVEL_LINE[l.level])}
          />
        ))}
      </div>
      {anyLocked && (
        <p className="help">
          {options.partnerManaged
            ? t('settings.voice.quality.partner')
            : t('settings.voice.quality.cannotPay', { name })}
        </p>
      )}
      {current && (
        <details className="vp-more cq-models" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
          <summary>
            <Icon name="down" size={14} className="vp-chevron" />
            {open ? t('settings.voice.quality.hideModels') : t('settings.voice.quality.showModels')}
          </summary>
          <div className="vp-more-body">
            {level === 'ultra' ? (
              <SelectRow
                id="as-realtime-model"
                title={t('settings.voice.quality.realtimeModel')}
                description={t('settings.voice.quality.realtimeModelHelp')}
                value={picks.realtime_model}
                options={modelOptions(current.realtimeModels, current.defaults.realtime, picks.realtime_model)}
                onChange={realtime_model => onChange({ ...picks, realtime_model })}
              />
            ) : (
              <>
                {current.models.length > 0 && (
                  <SelectRow
                    id="as-llm-model"
                    title={t('settings.voice.quality.languageModel')}
                    description={t('settings.voice.quality.languageModelHelp', { name })}
                    value={picks.llm_model}
                    options={modelOptions(current.models, current.defaults.llm, picks.llm_model)}
                    onChange={llm_model => onChange({ ...picks, llm_model })}
                  />
                )}
                {voiceChoices.length > 0 && (
                  <SelectRow
                    id="as-voice-model"
                    title={t('settings.voice.quality.voiceModel')}
                    description={t('settings.voice.quality.voiceModelHelp')}
                    value={picks.voice.model}
                    options={modelOptions(
                      voiceChoices,
                      current.defaults.voice[picks.voice.provider],
                      picks.voice.model,
                    )}
                    onChange={model => onChange({ ...picks, voice: { ...picks.voice, model } })}
                  />
                )}
              </>
            )}
            <p className="help cq-foot">
              {price
                ? t('settings.voice.quality.footPrice', { level: levelName(level), price })
                : t('settings.voice.quality.foot', { level: levelName(level) })}
              {ownPicks && (
                <>
                  {' '}
                  <LinkButton
                    onClick={() =>
                      onChange({ ...picks, llm_model: '', realtime_model: '', voice: { ...picks.voice, model: '' } })
                    }
                  >
                    {t('settings.voice.quality.backToDefaults')}
                  </LinkButton>
                </>
              )}
            </p>
          </div>
        </details>
      )}
    </Section>
  )
}
