// Admin, Overview: the first thing an operator sees. Usage (calls, minutes), roughly what it costs
// per provider, whether the parts of the install work, and how many workspaces and people there are.
// Numbers and health load separately: health waits for LiveKit and the mail server.
import { providerCategories } from '@callfront/actions'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/kit.tsx'
import { type AdminHealth, type AdminOverview, loadHealth, loadOverview, type ServiceStatus } from './api.ts'
import { LoadError, Skeleton } from './parts.tsx'

const money = (usd: number) => (usd < 0.01 && usd > 0 ? '< $0.01' : `$${usd.toFixed(2)}`)
const count = (n: number) => n.toLocaleString('en-US')

function useLoad<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async () => {
    setError(null)
    try {
      setValue(await load())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [load])
  useEffect(() => void run(), [run])
  return { value, error, retry: run, reset: () => setValue(null) }
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

const healthRows: { key: keyof AdminHealth; label: string }[] = [
  { key: 'api', label: 'API' },
  { key: 'livekit', label: 'LiveKit' },
  { key: 'sip', label: 'Phone (SIP)' },
  { key: 'agent', label: 'Voice agent' },
  { key: 'email', label: 'Email' },
]

function HealthRow({ label, status }: { label: string; status: ServiceStatus | undefined }) {
  const state = !status ? 'wait' : status.ok ? 'ok' : 'bad'
  return (
    <div className="adm-health-row">
      <span className={`adm-health-dot ${state}`} aria-hidden="true" />
      <b>{label}</b>
      <span className="help">{!status ? 'Checking…' : status.message}</span>
    </div>
  )
}

function Health() {
  const health = useLoad(loadHealth)
  const checking = !health.value && !health.error
  return (
    <Card
      title="Health"
      action={
        <Button
          size="sm"
          variant="ghost"
          disabled={checking}
          onClick={() => {
            health.reset()
            void health.retry()
          }}
        >
          Check again
        </Button>
      }
    >
      {health.error ? (
        <LoadError what="Health" message={health.error} onRetry={() => void health.retry()} />
      ) : (
        <div className="adm-health" aria-live="polite">
          {healthRows.map(row => (
            <HealthRow key={row.key} label={row.label} status={health.value?.[row.key]} />
          ))}
        </div>
      )}
    </Card>
  )
}

function Costs({ overview }: { overview: AdminOverview }) {
  const total7d = overview.costs.reduce((sum, c) => sum + c.cost7d, 0)
  const totalMonth = overview.costs.reduce((sum, c) => sum + c.costMonth, 0)
  return (
    <Card title="Providers" note="Estimated from list prices per call minute. Your bill is at each provider.">
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
                About, 7 days
              </th>
              <th scope="col" className="adm-num">
                About, this month
              </th>
            </tr>
          </thead>
          <tbody>
            {overview.costs.map(c => (
              <tr key={c.category}>
                <th scope="row">{providerCategories[c.category]}</th>
                <td>{c.label ?? <span className="help">Not set up</span>}</td>
                <td className="adm-num">{count(c.minutes7d)}</td>
                <td className="adm-num">{c.provider ? money(c.cost7d) : '–'}</td>
                <td className="adm-num">{c.provider ? money(c.costMonth) : '–'}</td>
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
  const overview = useLoad(loadOverview)
  const o = overview.value
  if (overview.error)
    return <LoadError what="The overview" message={overview.error} onRetry={() => void overview.retry()} />
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
              label="About, 7 days"
              value={money(o.costs.reduce((sum, c) => sum + c.cost7d, 0))}
              note="Provider cost"
            />
          </>
        ) : (
          ['a', 'b', 'c', 'd'].map(key => <Skeleton key={key} className="adm-stat" />)
        )}
      </div>
      <Health />
      {o ? <Costs overview={o} /> : <Skeleton className="adm-card adm-skel-card" />}
      {o && (
        <Card title="People">
          <div className="adm-people">
            <button type="button" className="adm-link" onClick={() => onOpen('workspaces')}>
              <b>{count(o.workspaces.total)}</b> workspaces
              {o.workspaces.disabled > 0 && <span className="help"> · {o.workspaces.disabled} disabled</span>}
              {o.workspaces.new7d > 0 && <span className="help"> · {o.workspaces.new7d} new this week</span>}
            </button>
            <button type="button" className="adm-link" onClick={() => onOpen('users')}>
              <b>{count(o.users.total)}</b> users
              {o.users.disabled > 0 && <span className="help"> · {o.users.disabled} disabled</span>}
              {o.users.new7d > 0 && <span className="help"> · {o.users.new7d} new this week</span>}
            </button>
          </div>
        </Card>
      )}
    </>
  )
}
