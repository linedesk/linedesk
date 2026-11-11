// Insights: how the assistant did over the last 7, 30 or 90 days (insights.get, counted on the
// server), with the change against the span before, calls per day, the busiest hours and weekdays,
// and what the booked jobs are worth when the owner set a value per job.
import type { InsightCounts, InsightRange, InsightsData } from '@linedesk/actions'
import { insightRanges } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Section } from '../settings/fields.tsx'
import { patchWorkspaceSettings, readAction } from '../settings/settings-api.ts'
import { useAssistantName, useRun } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { cx } from '../ui/kit.tsx'
import { LoadProblem, Skeleton } from '../ui/LoadStates.tsx'
import {
  formatMoney,
  hourLabel,
  parseMoney,
  peakIndex,
  plural,
  rangeLabel,
  shortDate,
  summarySentence,
  trend,
  WEEKDAYS,
} from './insightsModel.ts'
import './insights.css'

const queryKey = (days: InsightRange) => `insights.${days}`
const load = (days: InsightRange) => () => readAction<InsightsData>('insights.get', { days })

type Props = { canEdit: boolean; toast: (text: string) => void }

export function Insights({ canEdit, toast }: Props) {
  const [days, setDays] = useState<InsightRange>(30)
  const query = useQuery(queryKey(days), load(days), { persist: true })
  const assistant = useAssistantName()
  const data = query.data
  return (
    <div className="page">
      <div className="page-in st-page in-page">
        <div className="page-head">
          <div>
            <h1>Insights</h1>
            <p>How {assistant} handled your calls.</p>
          </div>
          <RangeSwitch value={days} onChange={setDays} />
        </div>
        {!data && query.error && (
          <LoadProblem what="Insights" message={query.error} onRetry={() => void query.reload()} />
        )}
        {!data && !query.error && <Loading />}
        {data && (
          <>
            <Summary data={data} assistant={assistant} />
            <Tiles data={data} />
            <Section id="in-daily" title="Calls per day" description={`Answered and missed, ${rangeLabel(data.days)}.`}>
              <DailyChart daily={data.daily} />
            </Section>
            <div className="in-two">
              <Section
                id="in-hours"
                title="Busiest hours"
                description={`Calls per hour of the day (${data.timeZone.replace('_', ' ')}).`}
              >
                <BarChart values={data.byHour} label={hourLabel} ticks={[0, 6, 12, 18]} unit="hour" />
              </Section>
              <Section id="in-days" title="Busiest days" description="Calls per day of the week.">
                <BarChart
                  values={mondayFirst(data.byWeekday)}
                  label={i => WEEKDAYS[(i + 1) % 7]!.slice(0, 3)}
                  ticks={[0, 1, 2, 3, 4, 5, 6]}
                  unit="day"
                />
              </Section>
            </div>
            <JobValue value={data.jobValueCents} canEdit={canEdit} toast={toast} />
          </>
        )}
      </div>
    </div>
  )
}

function Loading() {
  return (
    <div className="in-loading" role="status" aria-busy="true" aria-label="Loading insights">
      <Skeleton className="sk-card" />
      <Skeleton className="sk-card" />
    </div>
  )
}

function RangeSwitch({ value, onChange }: { value: InsightRange; onChange: (days: InsightRange) => void }) {
  return (
    <div className="st-seg in-range" role="radiogroup" aria-label="Period">
      {insightRanges.map(d => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={value === d}
          className={cx('st-seg-b', value === d && 'on')}
          onClick={() => onChange(d)}
          title={`The last ${d} days`}
        >
          {d} days
        </button>
      ))}
    </div>
  )
}

function Summary({ data, assistant }: { data: InsightsData; assistant: string }) {
  const value = data.jobValueCents !== null && data.current.booked > 0 ? data.jobValueCents * data.current.booked : null
  return (
    <section className="k-card in-summary" aria-label="Summary">
      <p className="in-sentence">{summarySentence(assistant, data.days, data.current)}</p>
      {value !== null && (
        <p className="in-value">
          ≈ <b>{formatMoney(value)}</b> in booked work
          <span className="in-muted">
            {' '}
            · {plural(data.current.booked, 'job')} × {formatMoney(data.jobValueCents!)}
          </span>
        </p>
      )}
    </section>
  )
}

type Tile = {
  label: string
  value: number | null
  previous: number | null
  note?: string
  danger?: boolean
  help?: string
}

function tilesOf({ current: c, previous: p }: InsightsData): Tile[] {
  const pick = (key: keyof InsightCounts) => ({ value: c[key], previous: p[key] })
  return [
    { label: 'Answered', ...pick('answered'), note: `of ${plural(c.calls, 'call')}` },
    {
      label: 'Missed',
      ...pick('missed'),
      danger: c.missed > 0,
      help: 'Nobody picked up: the assistant was not running or not set up.',
    },
    { label: 'Urgent', ...pick('urgent') },
    { label: 'Booked', ...pick('booked'), help: 'Calls that ended with an appointment the assistant booked.' },
    { label: 'Messages taken', ...pick('messages'), help: 'Messages and callback requests.' },
    { label: 'Transferred', ...pick('transferred') },
    { label: 'Spam blocked', ...pick('spam') },
    { label: 'Minutes', ...pick('minutes'), help: 'Talk time of all calls.' },
    {
      label: 'After hours',
      ...pick('afterHours'),
      help: 'Answered calls outside your business hours.',
      note: c.afterHours === null ? 'Set business hours' : undefined,
    },
  ]
}

function Tiles({ data }: { data: InsightsData }) {
  return (
    <div className="in-tiles">
      {tilesOf(data).map(t => {
        const change = t.value !== null && t.previous !== null ? trend(t.value, t.previous) : null
        return (
          <div
            key={t.label}
            className="k-card in-tile"
            title={[t.help, change && `${change} vs the ${data.days} days before`].filter(Boolean).join(' ')}
          >
            <span className="in-tile-l">{t.label}</span>
            <b className={cx('in-tile-n', t.danger && 'in-danger')}>
              {t.value === null ? '–' : t.value.toLocaleString('en-US')}
            </b>
            <span className="in-tile-s">
              {t.note ??
                (change ? (
                  <>
                    {change}
                    <span className="in-vs"> vs previous {data.days} days</span>
                  </>
                ) : (
                  '\u00a0'
                ))}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Stacked columns: answered in ink, missed in red on top. */
function DailyChart({ daily }: { daily: InsightsData['daily'] }) {
  const max = Math.max(1, ...daily.map(d => d.answered + d.missed))
  const every = daily.length <= 7 ? 1 : daily.length <= 30 ? 7 : 15
  return (
    <div className="in-chart">
      <div className="in-cols in-cols-daily" role="img" aria-label={`Calls per day, at most ${max}`}>
        {daily.map(d => (
          <div
            key={d.date}
            className="in-col"
            title={`${shortDate(d.date)}: ${plural(d.answered, 'answered call')}${d.missed ? `, ${d.missed} missed` : ''}`}
          >
            <span className="in-bar in-missed" style={{ height: `${(d.missed / max) * 100}%` }} />
            <span className="in-bar" style={{ height: `${(d.answered / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="in-axis">
        {daily.map((d, i) => (
          <span key={d.date}>{(daily.length - 1 - i) % every === 0 ? shortDate(d.date) : ''}</span>
        ))}
      </div>
    </div>
  )
}

/** Columns in grey with the busiest one in ink. */
function BarChart({
  values,
  label,
  ticks,
  unit,
}: {
  values: number[]
  label: (i: number) => string
  ticks: number[]
  unit: string
}) {
  const max = Math.max(1, ...values)
  const peak = peakIndex(values)
  return (
    <div className="in-chart">
      <div
        className="in-cols"
        role="img"
        aria-label={peak === null ? 'No calls yet' : `Busiest ${unit}: ${label(peak)}`}
      >
        {values.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one column per hour or weekday, fixed order
          <div key={i} className="in-col" title={`${label(i)}: ${plural(v, 'call')}`}>
            <span className={cx('in-bar', i !== peak && 'in-quiet')} style={{ height: `${(v / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="in-axis">
        {values.map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: same columns as above
          <span key={i}>{ticks.includes(i) ? label(i) : ''}</span>
        ))}
      </div>
      {peak !== null && (
        <p className="in-peak">
          Busiest: <b>{label(peak)}</b>
        </p>
      )}
    </div>
  )
}

const mondayFirst = (byWeekday: number[]) => [...byWeekday.slice(1), byWeekday[0] ?? 0]

/** What a booked job is worth on average: owners and admins set it, the summary multiplies it. */
function JobValue({
  value,
  canEdit,
  toast,
}: {
  value: number | null
  canEdit: boolean
  toast: (text: string) => void
}) {
  const run = useRun()
  const shown = value === null ? '' : String(value / 100)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const parsed = parseMoney(text)
  const invalid = parsed === undefined

  function save() {
    if (invalid || parsed === value) return
    for (const d of insightRanges)
      setQueryData<InsightsData | undefined>(queryKey(d), s => (s ? { ...s, jobValueCents: parsed } : s), {
        persist: true,
      })
    patchWorkspaceSettings({ jobValueCents: parsed })
    void run('workspace.updateSettings', { jobValueCents: parsed })
    toast(parsed === null ? 'Job value cleared.' : `A booked job counts as ${formatMoney(parsed)}.`)
  }

  if (!canEdit && value === null) return null
  return (
    <Section
      id="in-job-value"
      title="Value of a booked job"
      description={
        canEdit ? 'An average is fine. Insights shows what the booked jobs are worth.' : 'Set by an owner or admin.'
      }
    >
      <form
        className="in-job-form"
        onSubmit={e => {
          e.preventDefault()
          save()
        }}
      >
        <Input
          id="in-job-value-input"
          inputMode="decimal"
          aria-label="Value of a booked job in dollars"
          placeholder="e.g. 350"
          value={text}
          disabled={!canEdit}
          invalid={invalid}
          onChange={e => setText(e.target.value)}
          onBlur={save}
          end={<span className="in-unit">USD</span>}
        />
        {invalid && <span className="in-error">A number, like 350 or 1,250.</span>}
      </form>
    </Section>
  )
}
