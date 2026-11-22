// Server admin › Overview: the first thing an operator sees, under the "Ready for calls" card (StatusCard.tsx, which
// says whether the parts of the install work). Usage (calls, minutes), roughly what it costs per provider, and how many
// workspaces and people there are.
import { providerCategoryLabel } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { cx } from '../ui/kit.tsx'
import { LoadProblem, Skeleton, SkeletonRows, useLoading } from '../ui/LoadStates.tsx'
import { type AdminOverview, loadOverview } from './api.ts'
import { ReplyDelay } from './ReplyDelay.tsx'
import { ShopifySetups } from './ShopifySetups.tsx'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { EMPTY } from './parts.tsx'

const usd = (amount: number) => fmt().currency(amount, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (amount: number) =>
  amount < 0.01 && amount > 0 ? i18n().t('admin.overview.lessThan', { amount: usd(0.01) }) : usd(amount)
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
  const t = useT()
  return (
    <Card title={t('admin.overview.costs.title')} note={t('admin.overview.costs.note')}>
      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.overview.costs.part')}</th>
              <th scope="col">{t('admin.overview.costs.inUse')}</th>
              <th scope="col" className="adm-num">
                {t('admin.overview.costs.minutes7d')}
              </th>
              <th scope="col" className="adm-num">
                {t('admin.overview.costs.cost7d')}
              </th>
              <th scope="col" className="adm-num">
                {t('admin.overview.costs.costMonth')}
              </th>
            </tr>
          </thead>
          <tbody>
            {overview.costs.map(c => (
              <tr key={c.category}>
                <th scope="row">{providerCategoryLabel(c.category, i18n())}</th>
                <td>{c.label ?? <span className="help">{t('admin.overview.costs.notSetUp')}</span>}</td>
                <td className="adm-num">{count(c.minutes7d)}</td>
                <td className="adm-num">{c.provider ? money(c.cost7d) : EMPTY}</td>
                <td className="adm-num">{c.provider ? money(c.costMonth) : EMPTY}</td>
              </tr>
            ))}
            <tr className="adm-total">
              <th scope="row">{t('admin.overview.costs.total')}</th>
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

type Props = { onOpen: (section: 'workspaces' | 'users' | 'providers' | 'server') => void }

const bold = (chunks: ReactNode[]) => <b>{chunks}</b>

export function Overview({ onOpen }: Props) {
  const t = useT()
  const overview = useLoad('admin.overview', loadOverview)
  // The numbers wait behind the loading gate (no flash, no blink); the labels and card titles show at once.
  const view = useLoading(!overview.value)
  const o = view.phase === 'content' ? overview.value : undefined
  const busy = cx('ld-busy', view.phase === 'reserve' && 'is-reserved')
  if (overview.error || view.phase === 'slow')
    return (
      <LoadProblem
        className="adm-card"
        what={t('admin.overview.what')}
        message={overview.error ?? undefined}
        slow={!overview.error}
        onRetry={() => void overview.retry()}
      />
    )
  return (
    <>
      <div className="adm-stats">
        {o ? (
          <>
            <Stat
              label={t('admin.overview.stat.callsToday')}
              value={count(o.calls.today)}
              note={t('admin.overview.stat.callsTodayNote')}
            />
            <Stat label={t('admin.overview.stat.calls7d')} value={count(o.calls.last7d)} />
            <Stat
              label={t('admin.overview.costs.minutes7d')}
              value={count(o.minutes.last7d)}
              note={t('admin.overview.stat.minutesMonth', { count: o.minutes.month })}
            />
            <Stat
              label={t('admin.overview.costs.cost7d')}
              value={money(o.costs.reduce((sum, c) => sum + c.cost7d, 0))}
              note={t('admin.overview.stat.costNote')}
            />
          </>
        ) : (
          [
            t('admin.overview.stat.callsToday'),
            t('admin.overview.stat.calls7d'),
            t('admin.overview.costs.minutes7d'),
            t('admin.overview.costs.cost7d'),
          ].map(label => (
            <div key={label} className={cx('adm-stat', busy)} aria-busy="true">
              <span>{label}</span>
              <Skeleton width={56} height={22} className="adm-sk-value" />
            </div>
          ))
        )}
      </div>
      <ShopifySetups />
      <ReplyDelay />
      {o ? (
        <Costs overview={o} />
      ) : (
        <Card title={t('admin.overview.costs.title')} note={t('admin.overview.costs.note')}>
          <div className={busy}>
            <SkeletonRows rows={4} columns={4} className="adm-sk-rows" />
          </div>
        </Card>
      )}
      {o && (
        <Card title={t('admin.overview.people.title')}>
          <div className="adm-people">
            <button type="button" className="adm-link" onClick={() => onOpen('workspaces')}>
              <T k="admin.overview.people.workspaces" values={{ count: o.workspaces.total, b: bold }} />
              {o.workspaces.disabled > 0 && (
                <span className="help"> {t('admin.overview.people.disabled', { count: o.workspaces.disabled })}</span>
              )}
              {o.workspaces.new7d > 0 && (
                <span className="help"> {t('admin.overview.people.newThisWeek', { count: o.workspaces.new7d })}</span>
              )}
            </button>
            <button type="button" className="adm-link" onClick={() => onOpen('users')}>
              <T k="admin.overview.people.users" values={{ count: o.users.total, b: bold }} />
              {o.users.disabled > 0 && (
                <span className="help"> {t('admin.overview.people.disabled', { count: o.users.disabled })}</span>
              )}
              {o.users.new7d > 0 && (
                <span className="help"> {t('admin.overview.people.newThisWeek', { count: o.users.new7d })}</span>
              )}
            </button>
          </div>
        </Card>
      )}
    </>
  )
}
