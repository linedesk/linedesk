// Server admin › Calls › Call quality (decision of 2026-11-17): which levels assistants can pick (Standard always,
// Premium and Ultra by switch; Ultra only with a realtime model), the level new assistants start on, and, collapsed,
// the default models per level. Turning a level off moves its assistants to Standard at once, with Undo in the toast.
import {
  CALL_QUALITY_LABELS,
  type CallQuality,
  type CallQualityAdminData,
  type CallQualityAdminLevel,
  type ModelChoice,
  type ProviderName,
  providerSpec,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { SelectRow, SkeletonSelectRow, SwitchRow } from '../settings/fields.tsx'
import { pricePerMinute } from '../settings/levelModel.ts'
import { appLink } from '../ui/AppLink.tsx'
import type { SelectOption } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { Badge, Icon } from '../ui/kit.tsx'
import { Loading } from '../ui/LoadStates.tsx'
import { type AdminInputs, runAdmin } from './api.ts'
import { errorText, type Notify } from './notify.ts'

const KEY = 'admin.callQuality'
const load = async () => (await runAdmin('callQuality.get', {})) as unknown as CallQualityAdminData

type SetInput = AdminInputs['callQuality.set']
const save = async (input: SetInput) => (await runAdmin('callQuality.set', input)) as unknown as CallQualityAdminData

/** Each level's line, with its price where the install bills. */
const LINE: Record<CallQuality, { price: MessageKey; plain: MessageKey }> = {
  standard: { price: msg('admin.callQuality.standardPrice'), plain: msg('admin.callQuality.standard') },
  premium: { price: msg('admin.callQuality.premiumPrice'), plain: msg('admin.callQuality.premium') },
  ultra: { price: msg('admin.callQuality.ultraPrice'), plain: msg('admin.callQuality.ultra') },
}
const lineOf = (data: CallQualityAdminData, level: CallQuality) => {
  const cents = data.centsPerMinute?.[level]
  return cents == null ? i18n().t(LINE[level].plain) : i18n().t(LINE[level].price, { price: pricePerMinute(cents) })
}

/** A model picker's options: the level's models in list order, and the current one if a list changed since. */
const choices = (list: readonly ModelChoice[], current: string | null): SelectOption<string>[] => [
  ...list.map(m => ({ value: m.id, label: m.name })),
  ...(current && !list.some(m => m.id === current) ? [{ value: current, label: current }] : []),
]

const providerLabel = (provider: string) => {
  try {
    return providerSpec(provider as ProviderName).label
  } catch {
    return provider
  }
}

/**
 * Saves a change. A level turned off says how many assistants moved to Standard, with Undo: the level back on and
 * those assistants back on it.
 */
export async function changeCallQuality(input: SetInput, offLevel: 'premium' | 'ultra' | undefined, notify: Notify) {
  const t = i18n().t
  try {
    const next = await save(input)
    setQueryData(KEY, next)
    if (!offLevel) return
    const moved = next.moved?.find(m => m.level === offLevel)?.assistantIds ?? []
    notify(t('admin.callQuality.off', { level: CALL_QUALITY_LABELS[offLevel], count: moved.length }), async () =>
      setQueryData(
        KEY,
        await save({ [offLevel]: true, ...(moved.length ? { restore: { level: offLevel, assistantIds: moved } } : {}) }),
      ),
    )
  } catch (e) {
    notify(errorText(e))
  }
}

export function CallQualityCard({ notify }: { notify: Notify }) {
  const t = useT()
  const query = useQuery(KEY, load)
  const [open, setOpen] = useState(false)
  const data = query.data
  const change = (input: SetInput, offLevel?: 'premium' | 'ultra') => changeCallQuality(input, offLevel, notify)
  const level = (l: CallQuality) => data?.levels.find(x => x.level === l)
  const enabledLevels = data?.levels.filter(l => l.enabled).map(l => l.level) ?? ['standard']
  return (
    <Card
      id="call-quality"
      className="adm-cq"
      title={t('admin.callQuality.title')}
      description={
        data?.centsPerMinute ? (
          <T k="admin.callQuality.descriptionBilling" values={{ link: appLink('#admin/billing') }} />
        ) : (
          t('admin.callQuality.description')
        )
      }
    >
      <Loading
        what={t('admin.callQuality.what')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={
          <>
            <SkeletonSelectRow title={CALL_QUALITY_LABELS.standard} />
            <SkeletonSelectRow title={CALL_QUALITY_LABELS.premium} />
            <SkeletonSelectRow title={CALL_QUALITY_LABELS.ultra} />
          </>
        }
      >
        {data && (
          <>
            <div className="swrow">
              <div>
                <b>{CALL_QUALITY_LABELS.standard}</b>
                <span className="help">{lineOf(data, 'standard')}</span>
              </div>
              <span className="adm-cq-always">{t('admin.callQuality.alwaysOn')}</span>
            </div>
            <SwitchRow
              title={CALL_QUALITY_LABELS.premium}
              description={lineOf(data, 'premium')}
              on={data.settings.premium}
              onChange={on => void change({ premium: on }, on ? undefined : 'premium')}
            />
            <SwitchRow
              title={CALL_QUALITY_LABELS.ultra}
              description={data.realtimeSetUp ? lineOf(data, 'ultra') : t('admin.callQuality.ultraNeedsRealtime')}
              on={data.realtimeSetUp && data.settings.ultra}
              disabled={!data.realtimeSetUp}
              onChange={on => void change({ ultra: on }, on ? undefined : 'ultra')}
            />
            <SelectRow
              id="adm-cq-default"
              title={t('admin.callQuality.newAssistants')}
              description={t('admin.callQuality.newAssistantsHelp')}
              value={data.settings.default}
              options={enabledLevels.map(l => ({ value: l, label: CALL_QUALITY_LABELS[l] }))}
              onChange={next => void change({ default: next })}
            />
            <details className="vp-more adm-cq-models" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
              <summary>
                <Icon name="down" size={14} className="vp-chevron" />
                {open ? t('admin.callQuality.hideModels') : t('admin.callQuality.showModels')}
              </summary>
              <div className="vp-more-body">
                <p className="help adm-cq-foot">{t('admin.callQuality.modelsHelp')}</p>
                {(['standard', 'premium'] as const).map(l => {
                  const lv = level(l)
                  return lv && <StageModels key={l} level={lv} change={change} />
                })}
                {level('ultra') && <UltraModels level={level('ultra')!} change={change} />}
              </div>
            </details>
          </>
        )}
      </Loading>
    </Card>
  )
}

type ModelsProps = { level: CallQualityAdminLevel; change: (input: SetInput) => Promise<void> }

function GroupHead({ level }: { level: CallQualityAdminLevel }) {
  const t = useT()
  return (
    <b className="adm-cq-group-head">
      {CALL_QUALITY_LABELS[level.level]}
      {!level.enabled && <Badge>{t('admin.callQuality.offBadge')}</Badge>}
    </b>
  )
}

/** Standard or Premium: the language model, a voice model per voice provider set up, and speech recognition. */
function StageModels({ level, change }: ModelsProps) {
  const t = useT()
  const l = level.level as 'standard' | 'premium'
  const voices = Object.entries(level.voiceModels).filter(([, list]) => list.length > 0)
  if (!level.models.length && !voices.length && !level.sttModels.length) return null
  return (
    <div className="adm-cq-group">
      <GroupHead level={level} />
      {level.models.length > 0 && (
        <SelectRow
          id={`adm-cq-${l}-llm`}
          title={t('admin.callQuality.languageModel')}
          value={level.defaults.llm ?? ''}
          options={choices(level.models, level.defaults.llm)}
          onChange={llm => void change({ models: { [l]: { llm } } })}
        />
      )}
      {voices.map(([provider, list]) => (
        <SelectRow
          key={provider}
          id={`adm-cq-${l}-voice-${provider}`}
          title={
            voices.length > 1
              ? t('admin.callQuality.voiceModelOf', { provider: providerLabel(provider) })
              : t('admin.callQuality.voiceModel')
          }
          value={level.defaults.voice[provider] ?? ''}
          options={choices(list, level.defaults.voice[provider] ?? null)}
          onChange={model => void change({ models: { [l]: { voice: { [provider]: model } } } })}
        />
      ))}
      {level.sttModels.length > 0 && (
        <SelectRow
          id={`adm-cq-${l}-stt`}
          title={t('admin.callQuality.speechRecognition')}
          value={level.defaults.stt ?? ''}
          options={choices(level.sttModels, level.defaults.stt)}
          onChange={stt => void change({ models: { [l]: { stt } } })}
        />
      )}
    </div>
  )
}

/** Ultra: the realtime model. */
function UltraModels({ level, change }: ModelsProps) {
  const t = useT()
  if (!level.realtimeModels.length) return null
  return (
    <div className="adm-cq-group">
      <GroupHead level={level} />
      <SelectRow
        id="adm-cq-ultra-realtime"
        title={t('admin.callQuality.realtimeModel')}
        value={level.defaults.realtime ?? ''}
        options={choices(level.realtimeModels, level.defaults.realtime)}
        onChange={realtime => void change({ models: { ultra: { realtime } } })}
      />
    </div>
  )
}
