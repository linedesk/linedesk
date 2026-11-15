// Insights: how the assistant did over a period (insights.get, counted on the server). One sentence,
// four numbers that switch the chart below them, how calls ended, when people call, and an export of
// the period (every call through call.export for owners and admins, totals per day for everyone).
import type { CallExportData, InsightPeriod, InsightsData, JobValueCurrency } from '@linedesk/actions'
import { insightPeriods } from '@linedesk/actions'
import { useEffect, useRef, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { callAction, readAction } from '../settings/settings-api.ts'
import { useAssistantName } from '../store.tsx'
import { Select } from '../ui/controls.tsx'
import { DateInput, FormMessage } from '../ui/form.tsx'
import { AppointmentValue } from '../settings/AppointmentValue.tsx'
import { cx, Icon } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import {
  busiestTime,
  type ChartMetric,
  change,
  columns,
  compareLabel,
  exportName,
  formatMoney,
  groupingFor,
  hourLabel,
  longDate,
  PERIOD_LABELS,
  spanLabel,
  summarySentence,
  tickEvery,
  totalsTable,
  weekdayShort,
  weekdays,
} from './insightsModel.ts'
import { CSV_TYPE, saveFile, type Table, toCsv, toXlsx, XLSX_TYPE } from './spreadsheet.ts'
import './insights.css'
import { fmt } from '../i18n/format.ts'
import { timeZoneLabel } from '../settings/timeZones.ts'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'

type Choice = InsightPeriod | 'custom'
type Range = { from: string; to: string }
const queryKey = (period: Choice, range: Range) =>
  period === 'custom' ? `insights.custom.${range.from}.${range.to}` : `insights.${period}`
const load = (period: Choice, range: Range) => () =>
  readAction<InsightsData>('insights.get', period === 'custom' ? { period, ...range } : { period })
const PERIOD_KEYS: { value: Choice; label: MessageKey }[] = [
  ...insightPeriods.map(p => ({ value: p as Choice, label: PERIOD_LABELS[p] })),
  { value: 'custom', label: msg('insights.period.custom') },
]

/** Today in the browser, YYYY-MM-DD (the server keeps a range from going past the business's today). */
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Props = { canEdit: boolean; toast: (text: string) => void }

export function Insights({ canEdit, toast }: Props) {
  const t = useT()
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
            <h1>{t('insights.title')}</h1>
            <p>
              {data
                ? `${spanLabel(data.from, data.to)} · ${timeZoneLabel(data.timeZone)}`
                : t('insights.lede', { assistant })}
            </p>
          </div>
          <div className="in-controls">
            <Select
              label={t('insights.period.label')}
              value={period}
              options={PERIOD_KEYS.map(o => ({ value: o.value, label: t(o.label) }))}
              onChange={pickPeriod}
              size="sm"
              align="end"
            />
            <ExportMenu data={data} canExportCalls={canEdit} toast={toast} />
          </div>
        </div>
        {period === 'custom' && range && <RangeFields range={range} onChange={setRange} />}
        <Loading
          what={t('insights.title')}
          loading={!data}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<InsightsSkeleton />}
        >
          {data && (
            <>
              <Summary data={data} assistant={assistant} canEdit={canEdit} toast={toast} />
              <Numbers data={data} metric={metric} onMetric={setMetric} />
              <div className="in-two">
                <Outcomes data={data} />
                <BusyTimes data={data} />
              </div>
              <p className="in-foot">
                {t('insights.foot.notCounted')}{' '}
                {data.compareWith
                  ? t('insights.foot.compared', { span: spanLabel(data.compareWith.from, data.compareWith.to) })
                  : data.firstCall
                    ? t('insights.foot.firstCall', { date: longDate(data.firstCall) })
                    : ''}
              </p>
            </>
          )}
        </Loading>
      </div>
    </div>
  )
}

/** From and to of a custom range. A change applies once both are days and the first is not after the last. */
function RangeFields({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const t = useT()
  const [draft, setDraft] = useState(range)
  const today = localToday()
  const valid = Boolean(draft.from && draft.to && draft.from <= draft.to)
  function set(next: Range) {
    setDraft(next)
    if (next.from && next.to && next.from <= next.to) onChange(next)
  }
  return (
    <div className="in-range" role="group" aria-label={t('insights.period.custom')}>
      <label htmlFor="in-from">{t('insights.range.from')}</label>
      <DateInput id="in-from" value={draft.from} max={today} onChange={from => set({ ...draft, from })} />
      <label htmlFor="in-to">{t('insights.range.to')}</label>
      <DateInput
        id="in-to"
        value={draft.to}
        min={draft.from}
        max={today}
        invalid={!valid}
        onChange={to => set({ ...draft, to })}
      />
      {!valid && <FormMessage>{t('insights.range.order')}</FormMessage>}
    </div>
  )
}

/** The page's cards in grey, in their own classes and sizes: summary, the four numbers with the chart, two panels. */
function InsightsSkeleton() {
  const t = useT()
  return (
    <>
      <section className="k-card in-summary">
        <Skeleton shape="text" width="62%" className="in-sk-sentence" />
        <Skeleton shape="text" width="40%" />
      </section>
      <section className="k-card in-numbers">
        <div className="in-tiles">
          {NUMBERS.map(n => (
            <div key={n.key} className="in-tile">
              <span className="in-tile-l">{t(n.label)}</span>
              <Skeleton width={40} height={24} className="in-sk-number" />
              <Skeleton shape="text" width="70%" />
            </div>
          ))}
        </div>
        <div className="in-chart">
          <Skeleton shape="text" width={120} />
          <Skeleton height={160} />
        </div>
      </section>
      <div className="in-two">
        {[t('insights.outcomes.title'), t('insights.busy.title')].map(title => (
          <section key={title} className="k-card in-panel">
            <h2>{title}</h2>
            <Skeleton height={140} />
          </section>
        ))}
      </div>
    </>
  )
}

// --- Summary and appointment value ---------------------------------------------------------------

/**
 * A changed appointment value in every cached period at once (the summary and the Booked tile multiply it):
 * the fixed periods and, from the summary, the custom range on screen. Workspace settings › General calls it too.
 */
export function showAppointmentValue(cents: number | null, currency: JobValueCurrency, shown?: Range) {
  const keys = [
    ...insightPeriods.map(p => queryKey(p, { from: '', to: '' })),
    ...(shown ? [queryKey('custom', shown)] : []),
  ]
  for (const key of keys)
    setQueryData<InsightsData | undefined>(
      key,
      s => (s ? { ...s, jobValueCents: cents, jobValueCurrency: currency } : s),
      { persist: true },
    )
}

function Summary({ data, assistant, canEdit, toast }: { data: InsightsData; assistant: string } & Props) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const value = data.jobValueCents
  const currency = data.jobValueCurrency ?? 'USD'
  const booked = data.current.booked
  return (
    <section className="k-card in-summary" aria-label={t('insights.summary.label')}>
      <p className="in-sentence">{summarySentence(assistant, data, data.current)}</p>
      {editing ? (
        <AppointmentValue
          id="in-appointment-value-input"
          label={t('insights.value.label')}
          value={value}
          currency={currency}
          canEdit={canEdit}
          autoFocus
          onDone={() => setEditing(false)}
          onSaved={(cents, c) => showAppointmentValue(cents, c, { from: data.from, to: data.to })}
          toast={toast}
        />
      ) : value !== null ? (
        <p className="in-value">
          {booked > 0 && (
            <>
              <T
                k="insights.value.total"
                values={{ amount: formatMoney(value * booked, currency), b: chunks => <b>{chunks}</b> }}
              />{' '}
            </>
          )}
          <span className="in-muted">
            {booked > 0
              ? `· ${t('insights.value.perAppointment', { count: booked, amount: formatMoney(value, currency) })}`
              : t('insights.value.countsAs', { amount: formatMoney(value, currency) })}
            {canEdit && (
              <>
                {' · '}
                <button type="button" className="in-link" onClick={() => setEditing(true)}>
                  {t('common.action.change')}
                </button>
              </>
            )}
          </span>
        </p>
      ) : (
        canEdit && (
          <p className="in-value in-muted">
            <T
              k="insights.value.set"
              values={{
                link: chunks => (
                  <button type="button" className="in-link" onClick={() => setEditing(true)}>
                    {chunks}
                  </button>
                ),
              }}
            />
          </p>
        )
      )}
    </section>
  )
}

// --- The four numbers and the chart --------------------------------------------------------------

const NUMBERS: { key: ChartMetric; label: MessageKey; help: MessageKey }[] = [
  { key: 'answered', label: msg('insights.number.answered'), help: msg('insights.number.answeredHelp') },
  { key: 'booked', label: msg('insights.number.booked'), help: msg('insights.number.bookedHelp') },
  { key: 'messages', label: msg('insights.number.messages'), help: msg('insights.number.messagesHelp') },
  { key: 'missed', label: msg('insights.number.missed'), help: msg('insights.number.missedHelp') },
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
  const t = useT()
  const c = data.current
  const versus = compareLabel(data)
  const real = c.calls - c.spam
  return (
    <section className="k-card in-numbers" aria-label={t('insights.number.label')}>
      <div className="in-tiles" role="tablist" aria-label={t('insights.number.tabs')}>
        {NUMBERS.map(n => {
          const value = c[n.key]
          const sub =
            n.key === 'answered' && real > 0
              ? t('insights.number.shareOf', { share: c.answered / real, count: real })
              : n.key === 'booked' && data.jobValueCents !== null && value > 0
                ? `≈ ${formatMoney(value * data.jobValueCents, data.jobValueCurrency)}`
                : null
          const delta = versus
            ? t('insights.number.versus', { change: change(value, data.previous[n.key]), versus })
            : null
          return (
            <button
              key={n.key}
              type="button"
              role="tab"
              aria-selected={metric === n.key}
              className="in-tile"
              title={t(n.help)}
              onClick={() => onMetric(n.key)}
            >
              <span className="in-tile-l">{t(n.label)}</span>
              <b className={cx('in-tile-n', n.key === 'missed' && value > 0 && 'in-danger')}>
                {fmt().number(value)}
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
  const t = useT()
  const grouping = groupingFor(data.days)
  const cols = columns(data.daily, metric, grouping, data.today)
  const max = Math.max(1, ...cols.map(c => c.value + c.missed))
  const every = tickEvery(cols.length)
  const name = t(NUMBERS.find(n => n.key === metric)!.label)
  const stacked = metric === 'answered'
  return (
    <div className="in-chart" role="tabpanel">
      <div className="in-chart-head">
        <span>
          <T k="insights.chart.per" values={{ name, grouping, b: chunks => <b>{chunks}</b> }} />
        </span>
        <span className="in-legend">
          {stacked && (
            <>
              <span>
                <i className="in-key" />
                {t('insights.number.answered')}
              </span>
              <span>
                <i className="in-key in-key-missed" />
                {t('insights.number.missed')}
              </span>
            </>
          )}
          {cols.some(c => c.partial) && (
            <span>
              <i className="in-key in-key-partial" />
              {t('insights.chart.partial')}
            </span>
          )}
        </span>
      </div>
      <div
        className={cx('in-cols', cols.length > 40 && 'in-cols-dense')}
        role="img"
        aria-label={t('insights.chart.perPlain', { name, grouping })}
      >
        {cols.map(c => (
          <div
            key={c.key}
            className="in-col"
            title={t(stacked ? 'insights.chart.columnStacked' : 'insights.chart.column', {
              label: c.label,
              value: c.value,
              missed: c.missed,
              partial: c.partial ? 'yes' : 'no',
            })}
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
  const t = useT()
  const c = data.current
  const rows: { label: string; value: number; tone?: 'soft' | 'danger' }[] = [
    { label: t('insights.number.booked'), value: c.booked },
    { label: t('insights.outcomes.message'), value: c.messages },
    { label: t('insights.outcomes.transferred'), value: c.transferred },
    { label: t('insights.outcomes.other'), value: c.other, tone: 'soft' },
    { label: t('insights.outcomes.spam'), value: c.spam, tone: 'soft' },
    { label: t('insights.number.missed'), value: c.missed, tone: 'danger' },
  ]
  const total = Math.max(1, c.calls)
  return (
    <section className="k-card in-panel" aria-labelledby="in-out-h">
      <h2 id="in-out-h">{t('insights.outcomes.title')}</h2>
      <p className="in-desc">{t('insights.outcomes.desc')}</p>
      <ul className="in-outcomes">
        {rows.map(r => (
          <li key={r.label}>
            <span>{r.label}</span>
            <span className="in-out-n">
              <b>{fmt().number(r.value)}</b> · {fmt().number(r.value / total, { style: 'percent' })}
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
        <span className={cx('in-flag', c.urgent > 0 && 'in-flag-urgent')}>
          {t('insights.outcomes.urgent', { count: c.urgent })}
        </span>
        <span className="in-flag">
          {c.afterHours === null
            ? t('insights.outcomes.setHours')
            : t('insights.outcomes.afterHours', { count: c.afterHours })}
        </span>
      </div>
    </section>
  )
}

// --- When people call ----------------------------------------------------------------------------

/** Monday first, like the chart's weeks. */
const ROWS = [1, 2, 3, 4, 5, 6, 0]

function BusyTimes({ data }: { data: InsightsData }) {
  const t = useT()
  const grid = data.byWeekdayHour
  const max = Math.max(1, ...grid.flat())
  const busiest = busiestTime(grid)
  return (
    <section className="k-card in-panel" aria-labelledby="in-busy-h">
      <h2 id="in-busy-h">{t('insights.busy.title')}</h2>
      <p className="in-desc">{t('insights.busy.desc')}</p>
      <div
        className="in-heat"
        role="img"
        aria-label={busiest ? t('insights.busy.busiestPlain', { when: busiest }) : t('insights.busy.none')}
      >
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one label per hour, fixed order
          <span key={h} className="in-heat-h">
            {h % 6 === 0 ? hourLabel(h) : ''}
          </span>
        ))}
        {ROWS.map(w => (
          <HeatRow key={w} weekday={w} values={grid[w] ?? []} max={max} />
        ))}
      </div>
      <p className="in-peak">
        {busiest ? (
          <T k="insights.busy.busiest" values={{ when: busiest, b: chunks => <b>{chunks}</b> }} />
        ) : (
          t('insights.busy.noneYet')
        )}
      </p>
    </section>
  )
}

function HeatRow({ weekday, values, max }: { weekday: number; values: number[]; max: number }) {
  const t = useT()
  const days = weekdays(weekday)
  return (
    <>
      <span className="in-heat-d">{weekdayShort(weekday)}</span>
      {values.map((v, h) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: one cell per hour, fixed order
          key={h}
          className="in-heat-c"
          title={t('insights.busy.cell', { days, hour: hourLabel(h), count: v })}
          style={v ? { opacity: 0.12 + 0.88 * (v / max) } : undefined}
          data-empty={v === 0 || undefined}
        />
      ))}
    </>
  )
}

// --- Export --------------------------------------------------------------------------------------

type ExportChoice = { id: string; label: MessageKey; what: 'calls' | 'totals'; format: 'csv' | 'xlsx' }
const CHOICES: ExportChoice[] = [
  { id: 'calls-xlsx', label: msg('insights.export.calls'), what: 'calls', format: 'xlsx' },
  { id: 'calls-csv', label: msg('insights.export.calls'), what: 'calls', format: 'csv' },
  { id: 'totals-xlsx', label: msg('insights.export.totals'), what: 'totals', format: 'xlsx' },
  { id: 'totals-csv', label: msg('insights.export.totals'), what: 'totals', format: 'csv' },
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
  const t = useT()
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
      const note = t('insights.export.note', { span: spanLabel(data.from, data.to), zone: timeZoneLabel(data.timeZone) })
      const name = exportName(choice.what, data)
      if (choice.what === 'totals') {
        save(name, choice.format, totalsTable(data), t('insights.export.totals'), note)
        toast(t('insights.export.doneDays', { count: data.daily.length }))
        return
      }
      const result = await callAction<CallExportData>('call.export', {
        from: data.from,
        to: data.to,
        format: choice.format === 'csv' ? 'csv' : 'table',
      })
      if (choice.format === 'csv') saveFile(`${name}.csv`, result.csv ?? '', CSV_TYPE)
      else if (result.table) save(name, 'xlsx', result.table, t('insights.export.sheetCalls'), note)
      toast(
        result.truncated
          ? t('insights.export.truncated', { count: result.count })
          : t('insights.export.doneCalls', { count: result.count }),
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
        title={t('insights.export.title')}
        onClick={() => setOpen(o => !o)}
      >
        <span>{busy ? t('insights.export.exporting') : t('insights.export.button')}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="k-select-list" role="menu" aria-label={t('insights.export.button')}>
          {choices.map(c => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="k-select-opt in-export-opt"
              onClick={() => void run(c)}
            >
              <span className="k-select-opt-t">
                <span>{t(c.label)}</span>
              </span>
              <span className="in-fmt">{c.format === 'csv' ? 'CSV' : 'Excel'}</span>
            </button>
          ))}
          {!canExportCalls && <p className="in-export-note">{t('insights.export.adminsOnly')}</p>}
        </div>
      )}
    </div>
  )
}

function save(name: string, format: 'csv' | 'xlsx', table: Table, sheet: string, note: string) {
  if (format === 'csv') saveFile(`${name}.csv`, toCsv(table), CSV_TYPE)
  else saveFile(`${name}.xlsx`, toXlsx(table, sheet, note), XLSX_TYPE)
}
