// Server admin › Overview: the first thing an operator sees, under the "Ready for calls" card (StatusCard.tsx, which
// says whether the parts of the install work). Usage (calls, minutes), roughly what it costs per provider, and how many
// workspaces and people there are.
import { providerCategories } from '@linedesk/actions'
import type { ReactNode } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { cx } from '../ui/kit.tsx'
import { LoadProblem, Skeleton, SkeletonRows, useLoading } from '../ui/LoadStates.tsx'
import { type AdminOverview, loadOverview } from './api.ts'
import { ReplyDelay } from './ReplyDelay.tsx'
import { fmt } from '../i18n/format.ts'
import { EMPTY } from './parts.tsx'

const money = (usd: number) => (usd < 0.01 && usd > 0 ? '< $0.01' : `$${usd.toFixed(2)}`)
const count = (n: number) => fmt().number(n)

/** The last answer at once when admin is opened again, a fresh one in the background. */
function useLoad<T>(key: string, load: () => Promise<T>) {
  const query = useQuery(key, load)
  return {
    value: query.data ?? null,
    error: query.data ? null : query.error,
    retry: query.reload,
  }
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="adm-stat">
      <span>{label}</span>
      <b>{value}</b>
      {note && <small>{note}</small>}
    </div>
  )
}

function Card({
  title,
  note,
  action,
  children,
}: {
  title: string
  note?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="adm-card" aria-label={title}>
      <div className="adm-card-head">
        <div>
          <h2>{title}</h2>
          {note && <p className="help">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Costs({ overview }: { overview: AdminOverview }) {
  const total7d = overview.costs.reduce((sum, c) => sum + c.cost7d, 0)
  const totalMonth = overview.costs.reduce((sum, c) => sum + c.costMonth, 0)
  return (
    <Card title="Costs" note="Estimated from list prices.">
      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">Part</th>
              <th scope="col">In use</th>
              <th scope="col" className="adm-num">
                Minutes, 7 days
              </th>
              <th scope="col" className="adm-num">
                Cost over 7 days
              </th>
              <th scope="col" className="adm-num">
                Cost this month
              </th>
            </tr>
          </thead>
          <tbody>
            {overview.costs.map(c => (
              <tr key={c.category}>
                <th scope="row">{providerCategories[c.category]}</th>
                <td>{c.label ?? <span className="help">Not set up</span>}</td>
                <td className="adm-num">{count(c.minutes7d)}</td>
                <td className="adm-num">{c.provider ? money(c.cost7d) : EMPTY}</td>
                <td className="adm-num">{c.provider ? money(c.costMonth) : EMPTY}</td>
              </tr>
            ))}
            <tr className="adm-total">
              <th scope="row">Total</th>
              <td />
              <td />
              <td className="adm-num">{money(total7d)}</td>
              <td className="adm-num">{money(totalMonth)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}

type Props = { onOpen: (section: 'workspaces' | 'users' | 'providers' | 'system') => void }

export function Overview({ onOpen }: Props) {
  const overview = useLoad('admin.overview', loadOverview)
  // The numbers wait behind the loading gate (no flash, no blink); the labels and card titles show at once.
  const view = useLoading(!overview.value)
  const o = view.phase === 'content' ? overview.value : undefined
  const busy = cx('ld-busy', view.phase === 'reserve' && 'is-reserved')
  if (overview.error || view.phase === 'slow')
    return (
      <LoadProblem
        className="adm-card"
        what="The overview"
        message={overview.error ?? undefined}
        onRetry={() => void overview.retry()}
      />
    )
  return (
    <>
      <div className="adm-stats">
        {o ? (
          <>
            <Stat label="Calls today" value={count(o.calls.today)} note="Since midnight UTC" />
            <Stat label="Calls, 7 days" value={count(o.calls.last7d)} />
            <Stat
              label="Minutes, 7 days"
              value={count(o.minutes.last7d)}
              note={`${count(o.minutes.month)} this month`}
            />
            <Stat
              label="Cost over 7 days"
              value={money(o.costs.reduce((sum, c) => sum + c.cost7d, 0))}
              note="About, at provider list prices"
            />
          </>
        ) : (
          ['Calls today', 'Calls, 7 days', 'Minutes, 7 days', 'Cost over 7 days'].map(label => (
            <div key={label} className={cx('adm-stat', busy)} aria-busy="true">
              <span>{label}</span>
              <Skeleton width={56} height={22} className="adm-sk-value" />
            </div>
          ))
        )}
      </div>
      <ReplyDelay />
      {o ? (
        <Costs overview={o} />
      ) : (
        <Card title="Costs" note="Estimated from list prices.">
          <div className={busy}>
            <SkeletonRows rows={4} columns={4} className="adm-sk-rows" />
          </div>
        </Card>
      )}
      {o && (
        <Card title="People">
          <div className="adm-people">
            <button type="button" className="adm-link" onClick={() => onOpen('workspaces')}>
              <b>{count(o.workspaces.total)}</b> {o.workspaces.total === 1 ? 'workspace' : 'workspaces'}
              {o.workspaces.disabled > 0 && <span className="help"> · {o.workspaces.disabled} disabled</span>}
              {o.workspaces.new7d > 0 && <span className="help"> · {o.workspaces.new7d} new this week</span>}
            </button>
            <button type="button" className="adm-link" onClick={() => onOpen('users')}>
              <b>{count(o.users.total)}</b> {o.users.total === 1 ? 'user' : 'users'}
              {o.users.disabled > 0 && <span className="help"> · {o.users.disabled} disabled</span>}
              {o.users.new7d > 0 && <span className="help"> · {o.users.new7d} new this week</span>}
            </button>
          </div>
        </Card>
      )}
    </>
  )
}
