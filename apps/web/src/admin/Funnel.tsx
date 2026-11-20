// Server admin › Onboarding › Funnel (LIN-425): the workspaces that signed up each week and how far they got, from
// our own tables (apps/api/src/admin-funnel.ts). The tiles are the whole range, the table one row per sign-up week.
import { useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { Select } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { Loading, Skeleton, SkeletonRows } from '../ui/LoadStates.tsx'
import { type FunnelCounts, loadFunnel } from './api.ts'

const RANGES = ['4', '8', '12', '26'] as const
type Range = (typeof RANGES)[number]

/** The steps in the order a workspace reaches them; sign-ups first, the base of every share. */
const STEPS = ['signed_up', 'set_up', 'first_call', 'paid'] as const satisfies readonly (keyof FunnelCounts)[]

function useLabels() {
  const t = useT()
  return {
    signed_up: t('admin.funnel.step.signedUp'),
    set_up: t('admin.funnel.step.setUp'),
    first_call: t('admin.funnel.step.firstCall'),
    paid: t('admin.funnel.step.paid'),
  } satisfies Record<(typeof STEPS)[number], string>
}

/** The share of sign-ups, whole percent; nothing when nobody signed up. A row shows none for a step nobody reached. */
function useShare() {
  const format = useFormat()
  return (n: number, of: number) =>
    of > 0 ? format.number(n / of, { style: 'percent', maximumFractionDigits: 0 }) : null
}

function Tiles({ total }: { total: FunnelCounts }) {
  const t = useT()
  const format = useFormat()
  const labels = useLabels()
  const share = useShare()
  return (
    <div className="adm-stats adm-funnel-stats">
      {STEPS.map(step => {
        const pct = step === 'signed_up' ? null : share(total[step], total.signed_up)
        return (
          <div className="adm-stat" key={step}>
            <span>{labels[step]}</span>
            <b>{format.number(total[step])}</b>
            {pct && <small>{t('admin.funnel.ofSignUps', { share: pct })}</small>}
          </div>
        )
      })}
    </div>
  )
}

const tilesSkeleton = (
  <div className="adm-stats adm-funnel-stats" aria-hidden="true">
    {STEPS.map(step => (
      <div className="adm-stat" key={step}>
        <Skeleton shape="text" width={70} />
        <Skeleton className="adm-sk-value" width={36} height={22} />
      </div>
    ))}
  </div>
)

export function Funnel() {
  const t = useT()
  const format = useFormat()
  const labels = useLabels()
  const share = useShare()
  const [range, setRange] = useState<Range>('8')
  const query = useQuery(`admin.funnel.${range}`, () => loadFunnel(Number(range)))
  const data = query.data
  const weekLabel = (iso: string, index: number) =>
    index === 0
      ? t('admin.funnel.thisWeek')
      : format.dateTime(new Date(`${iso}T00:00:00Z`), { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return (
    <Card
      title={t('admin.funnel.title')}
      description={t('admin.funnel.description')}
      help={t('admin.funnel.help')}
      actions={
        <Select
          size="sm"
          align="end"
          label={t('admin.funnel.range')}
          value={range}
          onChange={setRange}
          options={RANGES.map(r => ({ value: r, label: t('admin.funnel.lastWeeks', { weeks: Number(r) }) }))}
        />
      }
    >
      <Loading
        what={t('admin.funnel.title')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={
          <>
            {tilesSkeleton}
            <SkeletonRows rows={Number(range)} columns={5} className="adm-sk-rows" />
          </>
        }
      >
        {data && (
          <>
            <Tiles total={data.total} />
            <div className="adm-scroll">
              <table className="adm-table adm-funnel-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.funnel.week')}</th>
                    {STEPS.map(step => (
                      <th scope="col" className="adm-num" key={step}>
                        {labels[step]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr key={row.week_start} className={row.signed_up === 0 ? 'adm-funnel-quiet' : undefined}>
                      <th scope="row">{weekLabel(row.week_start, i)}</th>
                      {STEPS.map(step => {
                        const pct = step === 'signed_up' || row[step] === 0 ? null : share(row[step], row.signed_up)
                        return (
                          <td className="adm-num" key={step}>
                            {format.number(row[step])}
                            {pct && <span className="adm-funnel-pct">{pct}</span>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Loading>
    </Card>
  )
}
