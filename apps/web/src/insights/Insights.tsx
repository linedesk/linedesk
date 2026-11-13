// Insights: how the assistant did over a period (insights.get, counted on the server). One sentence,
// four numbers that switch the chart below them, how calls ended, when people call, and an export of
// the period (every call through call.export for owners and admins, totals per day for everyone).
import type { CallExportData, InsightPeriod, InsightsData, JobValueCurrency } from '@linedesk/actions'
import { insightPeriods } from '@linedesk/actions'
import { useEffect, useRef, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { callAction, patchWorkspaceSettings, readAction } from '../settings/settings-api.ts'
import { useAssistantName, useRun } from '../store.tsx'
import { Select } from '../ui/controls.tsx'
import { Input } from '../ui/form.tsx'
import { cx, Icon } from '../ui/kit.tsx'
import { LoadProblem, Skeleton } from '../ui/LoadStates.tsx'
import {
  busiestTime,
  type ChartMetric,
  change,
  columns,
  CURRENCY_OPTIONS,
  compareLabel,
  exportName,
  formatMoney,
  groupingFor,
  hourLabel,
  longDate,
  PERIOD_LABELS,
  parseMoney,
  plural,
  spanLabel,
  summarySentence,
  tickEvery,
  totalsTable,
  WEEKDAYS,
} from './insightsModel.ts'
import { CSV_TYPE, saveFile, type Table, toCsv, toXlsx, XLSX_TYPE } from './spreadsheet.ts'
import './insights.css'

type Choice = InsightPeriod | 'custom'
type Range = { from: string; to: string }
const queryKey = (period: Choice, range: Range) =>
  period === 'custom' ? `insights.custom.${range.from}.${range.to}` : `insights.${period}`
const load = (period: Choice, range: Range) => () =>
  readAction<InsightsData>('insights.get', period === 'custom' ? { period, ...range } : { period })
const PERIOD_OPTIONS = [
  ...insightPeriods.map(p => ({ value: p as Choice, label: PERIOD_LABELS[p] })),
  { value: 'custom' as Choice, label: 'Custom range' },
]

/** Today in the browser, YYYY-MM-DD (the server keeps a range from going past the business's today). */
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Props = { canEdit: boolean; toast: (text: string) => void }

export function Insights({ canEdit, toast }: Props) {
  const [period, setPeriod] = useState<Choice>('30d')
  const [range, setRange] = useState<Range | null>(null)
  const [metric, setMetric] = useState<ChartMetric>('answered')
  const shownRange = range ?? { from: '', to: '' }
  const query = useQuery(queryKey(period, shownRange), load(period, shownRange), { persist: true })
  const assistant = useAssistantName()
  // An answer cached by an older version of the page has no daily counts per outcome: wait for the new one.
  const data = query.data?.byWeekdayHour ? query.data : undefined
  const lastShown = useRef<Range | null>(null)
  if (data) lastShown.current = { from: data.from, to: data.to }

  function pickPeriod(next: Choice) {
    // A custom range starts as the period on screen, so it is one change away from what you want.
    if (next === 'custom' && !range) setRange(lastShown.current ?? { from: localToday(), to: localToday() })
    setPeriod(next)
  }

  return (
    <div className="page">
      <div className="page-in st-page in-page">
        <div className="page-head">
          <div>
            <h1>Insights</h1>
            <p>
              {data
                ? `${spanLabel(data.from, data.to)} · ${data.timeZone.replace('_', ' ')}`
                : `How ${assistant} handled your calls.`}
            </p>
          </div>
          <div className="in-controls">
            <Select
              label="Period"
              value={period}
              options={PERIOD_OPTIONS}
              onChange={pickPeriod}
              size="sm"
              align="end"
            />
            <ExportMenu data={data} canExportCalls={canEdit} toast={toast} />
          </div>
        </div>
        {period === 'custom' && range && <RangeFields range={range} onChange={setRange} />}
        {!data && query.error && (
          <LoadProblem what="Insights" message={query.error} onRetry={() => void query.reload()} />
        )}
        {!data && !query.error && <Loading />}
        {data && (
          <>
            <Summary data={data} assistant={assistant} canEdit={canEdit} toast={toast} />
            <Numbers data={data} metric={metric} onMetric={setMetric} />
            <div className="in-two">
              <Outcomes data={data} />
              <BusyTimes data={data} />
            </div>
            <p className="in-foot">
              Test calls and calls from your own phones are not counted.{' '}
              {data.compareWith
                ? `Compared with ${spanLabel(data.compareWith.from, data.compareWith.to)}.`
                : data.firstCall
                  ? `First call ${longDate(data.firstCall)}.`
                  : ''}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/** From and to of a custom range. A change applies once both are days and the first is not after the last. */
function RangeFields({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const [draft, setDraft] = useState(range)
  const today = localToday()
  const valid = Boolean(draft.from && draft.to && draft.from <= draft.to)
  function set(next: Range) {
    setDraft(next)
    if (next.from && next.to && next.from <= next.to) onChange(next)
  }
  return (
    <div className="in-range" role="group" aria-label="Custom range">
      <label htmlFor="in-from">From</label>
      <Input
        id="in-from"
        type="date"
        value={draft.from}
        max={today}
        onChange={e => set({ ...draft, from: e.target.value })}
      />
      <label htmlFor="in-to">to</label>
      <Input
        id="in-to"
        type="date"
        value={draft.to}
        min={draft.from}
        max={today}
        invalid={!valid}
        onChange={e => set({ ...draft, to: e.target.value })}
      />
      {!valid && <span className="in-error">The first day comes before the last.</span>}
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

// --- Summary and job value -----------------------------------------------------------------------

function Summary({ data, assistant, canEdit, toast }: { data: InsightsData; assistant: string } & Props) {
  const [editing, setEditing] = useState(false)
  const job = data.jobValueCents
  const currency = data.jobValueCurrency ?? 'USD'
  const booked = data.current.booked
  return (
    <section className="k-card in-summary" aria-label="Summary">
      <p className="in-sentence">{summarySentence(assistant, data, data.current)}</p>
      {editing ? (
        <JobValue value={job} currency={currency} shown={data} onDone={() => setEditing(false)} toast={toast} />
      ) : job !== null ? (
        <p className="in-value">
          {booked > 0 && (
            <>
              ≈ <b>{formatMoney(job * booked, currency)}</b> in booked work{' '}
            </>
          )}
          <span className="in-muted">
            {booked > 0
              ? `· ${plural(booked, 'job')} × ${formatMoney(job, currency)}`
              : `A booked job counts as ${formatMoney(job, currency)}`}
            {canEdit && (
              <>
                {' · '}
                <button type="button" className="in-link" onClick={() => setEditing(true)}>
                  Change
                </button>
              </>
            )}
          </span>
        </p>
      ) : (
        canEdit && (
          <p className="in-value in-muted">
            <button type="button" className="in-link" onClick={() => setEditing(true)}>
              Set a job value
            </button>{' '}
            to see what the booked jobs are worth.
          </p>
        )
      )}
    </section>
  )
}

/**
 * What a booked job is worth on average and in which currency: owners and admins set it, the summary
 * multiplies it. Saved when the focus leaves the form (not when it moves from the amount to the currency).
 */
function JobValue({
  value,
  currency: savedCurrency,
  shown,
  onDone,
  toast,
}: {
  value: number | null
  currency: JobValueCurrency
  shown: Range
  onDone: () => void
  toast: Props['toast']
}) {
  const run = useRun()
  const [text, setText] = useState(value === null ? '' : String(value / 100))
  const [currency, setCurrency] = useState(savedCurrency)
  const parsed = parseMoney(text)
  const invalid = parsed === undefined

  function save() {
    if (invalid) return
    onDone()
    if (parsed === value && currency === savedCurrency) return
    const keys = [
      ...insightPeriods.map(p => queryKey(p, { from: '', to: '' })),
      queryKey('custom', { from: shown.from, to: shown.to }),
    ]
    for (const key of keys)
      setQueryData<InsightsData | undefined>(
        key,
        s => (s ? { ...s, jobValueCents: parsed, jobValueCurrency: currency } : s),
        { persist: true },
      )
    patchWorkspaceSettings({ jobValueCents: parsed, jobValueCurrency: currency })
    void run('workspace.updateSettings', { jobValueCents: parsed, jobValueCurrency: currency })
    toast(parsed === null ? 'Job value cleared.' : `A booked job counts as ${formatMoney(parsed, currency)}.`)
  }

  return (
    <form
      className="in-job-form"
      onSubmit={e => {
        e.preventDefault()
        save()
      }}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) save()
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') onDone()
      }}
    >
      <label htmlFor="in-job-value-input" className="in-muted">
        Average value of a booked job
      </label>
      <div className="in-job-row">
        <Input
          id="in-job-value-input"
          inputMode="decimal"
          autoFocus
          placeholder="e.g. 350"
          value={text}
          invalid={invalid}
          onChange={e => setText(e.target.value)}
        />
        <Select label="Currency" value={currency} options={CURRENCY_OPTIONS} onChange={setCurrency} size="sm" />
      </div>
      {invalid && <span className="in-error">A number, like 350 or 1,250.</span>}
    </form>
  )
}

// --- The four numbers and the chart --------------------------------------------------------------

const NUMBERS: { key: ChartMetric; label: string; help: string }[] = [
  { key: 'answered', label: 'Answered', help: 'Calls the assistant or your team picked up.' },
  { key: 'booked', label: 'Booked', help: 'Calls that ended with an appointment the assistant booked.' },
  { key: 'messages', label: 'Messages taken', help: 'Messages and callback requests.' },
  { key: 'missed', label: 'Missed', help: 'Nobody picked up: the assistant was not running or not set up.' },
]

function Numbers({
  data,
  metric,
  onMetric,
}: {
  data: InsightsData
  metric: ChartMetric
  onMetric: (m: ChartMetric) => void
}) {
  const c = data.current
  const versus = compareLabel(data)
  const real = c.calls - c.spam
  return (
    <section className="k-card in-numbers" aria-label="Key numbers">
      <div className="in-tiles" role="tablist" aria-label="Show in the chart">
        {NUMBERS.map(n => {
          const value = c[n.key]
          const sub =
            n.key === 'answered' && real > 0
              ? `${Math.round((c.answered / real) * 100)}% of ${plural(real, 'call')}`
              : n.key === 'booked' && data.jobValueCents !== null && value > 0
                ? `≈ ${formatMoney(value * data.jobValueCents, data.jobValueCurrency)}`
                : null
          const delta = versus ? `${change(value, data.previous[n.key])} vs ${versus}` : null
          return (
            <button
              key={n.key}
              type="button"
              role="tab"
              aria-selected={metric === n.key}
              className="in-tile"
              title={n.help}
              onClick={() => onMetric(n.key)}
            >
              <span className="in-tile-l">{n.label}</span>
              <b className={cx('in-tile-n', n.key === 'missed' && value > 0 && 'in-danger')}>
                {value.toLocaleString('en-US')}
              </b>
              <span className="in-tile-s">{delta ?? sub ?? ' '}</span>
              {delta && sub && <span className="in-tile-s">{sub}</span>}
            </button>
          )
        })}
      </div>
      <Chart data={data} metric={metric} />
    </section>
  )
}

function Chart({ data, metric }: { data: InsightsData; metric: ChartMetric }) {
  const grouping = groupingFor(data.days)
  const cols = columns(data.daily, metric, grouping, data.today)
  const max = Math.max(1, ...cols.map(c => c.value + c.missed))
  const every = tickEvery(cols.length)
  const name = NUMBERS.find(n => n.key === metric)!.label
  const stacked = metric === 'answered'
  return (
    <div className="in-chart" role="tabpanel">
      <div className="in-chart-head">
        <span>
          <b>{name}</b> per {grouping}
        </span>
        <span className="in-legend">
          {stacked && (
            <>
              <span>
                <i className="in-key" />
                Answered
              </span>
              <span>
                <i className="in-key in-key-missed" />
                Missed
              </span>
            </>
          )}
          {cols.some(c => c.partial) && (
            <span>
              <i className="in-key in-key-partial" />
              Not over yet
            </span>
          )}
        </span>
      </div>
      <div
        className={cx('in-cols', cols.length > 40 && 'in-cols-dense')}
        role="img"
        aria-label={`${name} per ${grouping}`}
      >
        {cols.map(c => (
          <div
            key={c.key}
            className="in-col"
            title={`${c.label}: ${c.value.toLocaleString('en-US')}${stacked ? ` answered, ${c.missed} missed` : ''}${c.partial ? ' so far' : ''}`}
          >
            {stacked && <span className="in-bar in-missed" style={{ height: `${(c.missed / max) * 100}%` }} />}
            <span
              className={cx('in-bar', metric === 'missed' && 'in-missed', c.partial && 'in-partial')}
              style={{ height: `${(c.value / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="in-axis">
        {cols.map((c, i) => (
          <span key={c.key}>{(cols.length - 1 - i) % every === 0 ? c.tick : ''}</span>
        ))}
      </div>
    </div>
  )
}

// --- How calls ended -----------------------------------------------------------------------------

function Outcomes({ data }: { data: InsightsData }) {
  const c = data.current
  const rows: { label: string; value: number; tone?: 'soft' | 'danger' }[] = [
    { label: 'Booked', value: c.booked },
    { label: 'Message or callback', value: c.messages },
    { label: 'Transferred to you', value: c.transferred },
    { label: 'Answered, no follow-up', value: c.other, tone: 'soft' },
    { label: 'Spam blocked', value: c.spam, tone: 'soft' },
    { label: 'Missed', value: c.missed, tone: 'danger' },
  ]
  const total = Math.max(1, c.calls)
  return (
    <section className="k-card in-panel" aria-labelledby="in-out-h">
      <h2 id="in-out-h">How calls ended</h2>
      <p className="in-desc">Every call counts once.</p>
      <ul className="in-outcomes">
        {rows.map(r => (
          <li key={r.label}>
            <span>{r.label}</span>
            <span className="in-out-n">
              <b>{r.value.toLocaleString('en-US')}</b> · {Math.round((r.value / total) * 100)}%
            </span>
            <span className="in-track">
              <span
                className={cx('in-fill', r.tone && `in-fill-${r.tone}`)}
                style={{ width: `${(r.value / total) * 100}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
      <div className="in-flags">
        <span className={cx('in-flag', c.urgent > 0 && 'in-flag-urgent')}>{plural(c.urgent, 'urgent call')}</span>
        <span className="in-flag">
          {c.afterHours === null
            ? 'Set business hours to count calls after hours'
            : `${plural(c.afterHours, 'call')} after hours`}
        </span>
      </div>
    </section>
  )
}

// --- When people call ----------------------------------------------------------------------------

/** Monday first, like the chart's weeks. */
const ROWS = [1, 2, 3, 4, 5, 6, 0]

function BusyTimes({ data }: { data: InsightsData }) {
  const grid = data.byWeekdayHour
  const max = Math.max(1, ...grid.flat())
  const busiest = busiestTime(grid)
  return (
    <section className="k-card in-panel" aria-labelledby="in-busy-h">
      <h2 id="in-busy-h">When people call</h2>
      <p className="in-desc">Darker means more calls.</p>
      <div className="in-heat" role="img" aria-label={busiest ? `Busiest: ${busiest}` : 'No calls yet'}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one label per hour, fixed order
          <span key={h} className="in-heat-h">
            {h % 6 === 0 ? hourLabel(h).replace(' ', '') : ''}
          </span>
        ))}
        {ROWS.map(w => (
          <HeatRow key={w} weekday={w} values={grid[w] ?? []} max={max} />
        ))}
      </div>
      <p className="in-peak">
        {busiest ? (
          <>
            Busiest: <b>{busiest}</b>
          </>
        ) : (
          'No calls yet.'
        )}
      </p>
    </section>
  )
}

function HeatRow({ weekday, values, max }: { weekday: number; values: number[]; max: number }) {
  const day = WEEKDAYS[weekday]!
  return (
    <>
      <span className="in-heat-d">{day.slice(0, 3)}</span>
      {values.map((v, h) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: one cell per hour, fixed order
          key={h}
          className="in-heat-c"
          title={`${day}s ${hourLabel(h)}: ${plural(v, 'call')}`}
          style={v ? { opacity: 0.12 + 0.88 * (v / max) } : undefined}
          data-empty={v === 0 || undefined}
        />
      ))}
    </>
  )
}

// --- Export --------------------------------------------------------------------------------------

type ExportChoice = { id: string; label: string; what: 'calls' | 'totals'; format: 'csv' | 'xlsx' }
const CHOICES: ExportChoice[] = [
  { id: 'calls-xlsx', label: 'Every call', what: 'calls', format: 'xlsx' },
  { id: 'calls-csv', label: 'Every call', what: 'calls', format: 'csv' },
  { id: 'totals-xlsx', label: 'Totals per day', what: 'totals', format: 'xlsx' },
  { id: 'totals-csv', label: 'Totals per day', what: 'totals', format: 'csv' },
]

function ExportMenu({
  data,
  canExportCalls,
  toast,
}: {
  data: InsightsData | undefined
  canExportCalls: boolean
  toast: Props['toast']
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const choices = CHOICES.filter(c => canExportCalls || c.what === 'totals')

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  async function run(choice: ExportChoice) {
    if (!data) return
    setOpen(false)
    setBusy(true)
    try {
      const note = `${spanLabel(data.from, data.to)}, times in ${data.timeZone.replace('_', ' ')}`
      const name = exportName(choice.what, data)
      if (choice.what === 'totals') {
        save(name, choice.format, totalsTable(data), 'Totals per day', note)
        toast(`Exported ${plural(data.daily.length, 'day')}.`)
        return
      }
      const result = await callAction<CallExportData>('call.export', {
        from: data.from,
        to: data.to,
        format: choice.format === 'csv' ? 'csv' : 'table',
      })
      if (choice.format === 'csv') saveFile(`${name}.csv`, result.csv ?? '', CSV_TYPE)
      else if (result.table) save(name, 'xlsx', result.table, 'Calls', note)
      toast(
        result.truncated
          ? `Exported the newest ${result.count.toLocaleString('en-US')} calls. Pick a shorter period for the rest.`
          : `Exported ${plural(result.count, 'call')}.`,
      )
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cx('k-select', 'k-select-sm', 'k-select-end', 'in-export', open && 'open')} ref={root}>
      <button
        type="button"
        className="k-select-btn"
        disabled={!data || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Download the numbers of this period"
        onClick={() => setOpen(o => !o)}
      >
        <span>{busy ? 'Exporting…' : 'Export'}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="k-select-list" role="menu" aria-label="Export">
          {choices.map(c => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="k-select-opt in-export-opt"
              onClick={() => void run(c)}
            >
              <span className="k-select-opt-t">
                <span>{c.label}</span>
              </span>
              <span className="in-fmt">{c.format === 'csv' ? 'CSV' : 'Excel'}</span>
            </button>
          ))}
          {!canExportCalls && <p className="in-export-note">Owners and admins can also export every call.</p>}
        </div>
      )}
    </div>
  )
}

function save(name: string, format: 'csv' | 'xlsx', table: Table, sheet: string, note: string) {
  if (format === 'csv') saveFile(`${name}.csv`, toCsv(table), CSV_TYPE)
  else saveFile(`${name}.xlsx`, toXlsx(table, sheet, note), XLSX_TYPE)
}
