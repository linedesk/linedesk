// Server admin › Overview › Reply delay: how long the assistant's replies take, from the caller's last word to the
// reply's first audio, split by where the time goes (end of turn, model, voice, Linedesk's agent, the phone network),
// per pipeline. One stacked bar of the medians per pipeline, on a shared scale, and a table with the median and p90 of
// each part (also the legend and the values the bar's colors cannot carry alone).
import { providers as providerRegistry } from '@linedesk/actions'
import { useQuery } from '../cachedQuery.ts'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { loadLatency, type PipelineLatency, type Percentiles } from './api.ts'

const PIPELINE_LABELS: Record<PipelineLatency['pipeline'], string> = {
  cascaded: 'Speech to text, language model, voice',
  realtime: 'Realtime model',
}

const labelOf = (provider: string | undefined) =>
  provider ? ((providerRegistry as Record<string, { label: string }>)[provider]?.label ?? provider) : null

type Part = { key: string; label: string; slot: number; value: Percentiles }

/** The parts of one pipeline's reply, in the order the time passes; parts it does not have are left out. */
function partsOf(p: PipelineLatency): Part[] {
  const turn = labelOf(p.providers.turn)
  const model = labelOf(p.providers.model)
  const voice = labelOf(p.providers.voice)
  const parts: (Part | null)[] = [
    { key: 'turn', label: `End of turn${turn ? ` · ${turn}` : ''}`, slot: 1, value: p.turn },
    {
      key: 'model',
      label:
        p.pipeline === 'realtime'
          ? `Model to first audio${model ? ` · ${model}` : ''}`
          : `Language model${model ? ` · ${model}` : ''}`,
      slot: 2,
      value: p.model,
    },
    p.voice.p50 !== null
      ? { key: 'voice', label: `Voice${voice ? ` · ${voice}` : ''}`, slot: 3, value: p.voice }
      : null,
    { key: 'server', label: 'Linedesk agent', slot: 4, value: p.server },
    p.phone.calls > 0 ? { key: 'phone', label: 'Phone network (call tests)', slot: 5, value: p.phone } : null,
  ]
  return parts.filter((part): part is Part => part !== null && part.value.p50 !== null)
}

const ms = (value: number | null) =>
  value === null ? '–' : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`
const sumOf = (parts: Part[]) => parts.reduce((sum, part) => sum + Math.max(0, part.value.p50 ?? 0), 0)

function PipelineBar({ latency, scale }: { latency: PipelineLatency; scale: number }) {
  const parts = partsOf(latency)
  const heard = sumOf(parts)
  return (
    <div className="adm-delay">
      <div className="adm-delay-head">
        <b>{PIPELINE_LABELS[latency.pipeline]}</b>
        <span className="help">
          {latency.replies.toLocaleString('en-US')} replies · median {ms(heard)}
          {latency.phone.calls > 0 ? ' as heard on the phone' : ' on the server'}
        </span>
      </div>
      <div
        className="adm-delay-bar"
        role="img"
        aria-label={`${PIPELINE_LABELS[latency.pipeline]}: ${parts.map(p => `${p.label} ${ms(p.value.p50)}`).join(', ')}`}
      >
        {parts.map(part => (
          <span
            key={part.key}
            className={`adm-delay-seg adm-series-${part.slot}`}
            style={{ width: `${(Math.max(0, part.value.p50 ?? 0) / scale) * 100}%` }}
            title={`${part.label}: median ${ms(part.value.p50)}, p90 ${ms(part.value.p90)}`}
          />
        ))}
      </div>
      <table className="adm-table adm-delay-table">
        <thead>
          <tr>
            <th scope="col">Where the time goes</th>
            <th scope="col" className="adm-num">
              Median
            </th>
            <th scope="col" className="adm-num">
              p90
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
            <th scope="row">On the server, caller's last word to the reply</th>
            <td className="adm-num">{ms(latency.total.p50)}</td>
            <td className="adm-num">{ms(latency.total.p90)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export function ReplyDelay() {
  const query = useQuery('admin.latency', loadLatency)
  const data = query.data
  const note =
    "From the caller's last word to the reply's first audio, medians of the last 7 days. The phone network comes from call tests over the phone."
  if (!data)
    return (
      <section className="adm-card" aria-label="Reply delay">
        <div className="adm-card-head">
          <div>
            <h2>Reply delay</h2>
            <p className="help">{note}</p>
          </div>
        </div>
        <Loading
          what="Reply delay"
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
    <section className="adm-card" aria-label="Reply delay">
      <div className="adm-card-head">
        <div>
          <h2>Reply delay</h2>
          <p className="help">{note}</p>
        </div>
      </div>
      {data.pipelines.length ? (
        data.pipelines.map(p => <PipelineBar key={p.pipeline} latency={p} scale={scale} />)
      ) : (
        <p className="help">No replies measured in the last 7 days.</p>
      )}
    </section>
  )
}
