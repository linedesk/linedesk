// Server admin › Overview › Reply delay: how long the assistant's replies take, from the caller's last word to the
// reply's first audio, split by where the time goes (end of turn, model, voice, Linedesk's agent, the phone network),
// per pipeline. One stacked bar of the medians per pipeline, on a shared scale, and a table with the median and p90 of
// each part (also the legend and the values the bar's colors cannot carry alone).
import { providers as providerRegistry } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useQuery } from '../cachedQuery.ts'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { loadLatency, type PipelineLatency, type Percentiles } from './api.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { EMPTY } from './parts.tsx'

const PIPELINE_LABELS: Record<PipelineLatency['pipeline'], MessageKey> = {
  cascaded: msg('admin.replyDelay.pipeline.cascaded'),
  realtime: msg('admin.replyDelay.pipeline.realtime'),
}

const labelOf = (provider: string | undefined) =>
  provider ? ((providerRegistry as Record<string, { label: string }>)[provider]?.label ?? provider) : null

type Part = { key: string; label: string; slot: number; value: Percentiles }

/** The parts of one pipeline's reply, in the order the time passes; parts it does not have are left out. */
function partsOf(p: PipelineLatency): Part[] {
  const t = i18n().t
  const by = (provider: string | undefined) => {
    const label = labelOf(provider)
    return { provider: label ?? '', known: label ? 'yes' : 'no' }
  }
  const parts: (Part | null)[] = [
    { key: 'turn', label: t('admin.replyDelay.part.turn', by(p.providers.turn)), slot: 1, value: p.turn },
    {
      key: 'model',
      label:
        p.pipeline === 'realtime'
          ? t('admin.replyDelay.part.realtimeModel', by(p.providers.model))
          : t('admin.replyDelay.part.languageModel', by(p.providers.model)),
      slot: 2,
      value: p.model,
    },
    p.voice.p50 !== null
      ? { key: 'voice', label: t('admin.replyDelay.part.voice', by(p.providers.voice)), slot: 3, value: p.voice }
      : null,
    { key: 'server', label: t('admin.replyDelay.part.server'), slot: 4, value: p.server },
    p.phone.calls > 0 ? { key: 'phone', label: t('admin.replyDelay.part.phone'), slot: 5, value: p.phone } : null,
  ]
  return parts.filter((part): part is Part => part !== null && part.value.p50 !== null)
}

const ms = (value: number | null) =>
  value === null
    ? EMPTY
    : value >= 1000
      ? i18n().t('admin.replyDelay.seconds', {
          value: fmt().number(value / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        })
      : i18n().t('admin.replyDelay.milliseconds', { value: fmt().number(value) })
const sumOf = (parts: Part[]) => parts.reduce((sum, part) => sum + Math.max(0, part.value.p50 ?? 0), 0)

function PipelineBar({ latency, scale }: { latency: PipelineLatency; scale: number }) {
  const t = useT()
  const parts = partsOf(latency)
  const pipeline = t(PIPELINE_LABELS[latency.pipeline])
  const heard = sumOf(parts)
  return (
    <div className="adm-delay">
      <div className="adm-delay-head">
        <b>{pipeline}</b>
        <span className="help">
          {t('admin.replyDelay.summary', {
            count: latency.replies,
            median: ms(heard),
            where: latency.phone.calls > 0 ? 'phone' : 'server',
          })}
        </span>
      </div>
      <div
        className="adm-delay-bar"
        role="img"
        aria-label={t('admin.replyDelay.barLabel', {
          pipeline,
          parts: fmt().list(
            parts.map(p => t('admin.replyDelay.partValue', { label: p.label, value: ms(p.value.p50) })),
            { type: 'unit', style: 'short' },
          ),
        })}
      >
        {parts.map(part => (
          <span
            key={part.key}
            className={`adm-delay-seg adm-series-${part.slot}`}
            style={{ width: `${(Math.max(0, part.value.p50 ?? 0) / scale) * 100}%` }}
            title={t('admin.replyDelay.segmentTip', {
              label: part.label,
              median: ms(part.value.p50),
              p90: ms(part.value.p90),
            })}
          />
        ))}
      </div>
      <table className="adm-table adm-delay-table">
        <thead>
          <tr>
            <th scope="col">{t('admin.replyDelay.column.part')}</th>
            <th scope="col" className="adm-num">
              {t('admin.replyDelay.column.median')}
            </th>
            <th scope="col" className="adm-num">
              {t('admin.replyDelay.column.p90')}
            </th>
          </tr>
        </thead>
        <tbody>
          {parts.map(part => (
            <tr key={part.key}>
              <th scope="row">
                <span className={`adm-delay-key adm-series-${part.slot}`} aria-hidden="true" />
                {part.label}
              </th>
              <td className="adm-num">{ms(part.value.p50)}</td>
              <td className="adm-num">{ms(part.value.p90)}</td>
            </tr>
          ))}
          <tr className="adm-total">
            <th scope="row">{t('admin.replyDelay.total')}</th>
            <td className="adm-num">{ms(latency.total.p50)}</td>
            <td className="adm-num">{ms(latency.total.p90)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export function ReplyDelay() {
  const t = useT()
  const query = useQuery('admin.latency', loadLatency)
  const data = query.data
  const note = t('admin.replyDelay.note')
  if (!data)
    return (
      <section className="adm-card" aria-label={t('admin.replyDelay.title')}>
        <div className="adm-card-head">
          <div>
            <h2>{t('admin.replyDelay.title')}</h2>
            <p className="help">{note}</p>
          </div>
        </div>
        <Loading
          what={t('admin.replyDelay.title')}
          loading
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<SkeletonRows rows={2} columns={2} className="adm-sk-rows" />}
        />
      </section>
    )
  // One scale for all pipelines, so their bars compare.
  const scale = Math.max(1, ...data.pipelines.map(p => sumOf(partsOf(p))))
  return (
    <section className="adm-card" aria-label={t('admin.replyDelay.title')}>
      <div className="adm-card-head">
        <div>
          <h2>{t('admin.replyDelay.title')}</h2>
          <p className="help">{note}</p>
        </div>
      </div>
      {data.pipelines.length ? (
        data.pipelines.map(p => <PipelineBar key={p.pipeline} latency={p} scale={scale} />)
      ) : (
        <p className="help">{t('admin.replyDelay.empty')}</p>
      )}
    </section>
  )
}
