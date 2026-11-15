// Server admin › Overview, on top: "Ready for calls" (LIN-158). One read-only summary in the words of Server admin ›
// Providers: a calm line with the mark and the headline, and the details below it: the groups a call needs (and an
// optional group only while it fails), then the server's own parts (API, read sync, voice agent) under System. Each
// part is a row of the app's list (ui/list.tsx) that opens where it is fixed; nothing is edited or tested here. The
// same status rule as Providers: a part that works shows only its mark (the words are its tooltip) and what is in use,
// muted; words only for a problem. The details fold away once everything works; a failing group a call needs makes the
// headline "Calls are not answered" with the reason. The install walkthrough shows the same rows (StatusList) without
// links: it never navigates away (design rule 14).
import { type GroupStatus, overviewGroups, readiness, type StatusState, statusText } from '@linedesk/actions'
import { useState } from 'react'
import { refreshQuery } from '../cachedQuery.ts'
import { HelpTip } from '../ui/form.tsx'
import { cx, Button, Icon } from '../ui/kit.tsx'
import { List, ListRow } from '../ui/list.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { ADMIN_HEALTH, type AdminHealth, type HealthPart } from './api.ts'
import { AgentFirst } from './Providers.tsx'
import { groupProblem, groupValue, type ProviderStatusState } from './providerStatus.ts'

/**
 * One part: its mark (with `mark` as tooltip), its name, a short muted value at the right (what is in use, or "Not set
 * up"), and for a problem a sentence under the name (`problem`, it wraps) with the detail behind a (?) (`help`).
 */
export type Row = {
  id: string
  label: string
  state: StatusState
  mark: string
  value: string | null
  problem: string | null
  help: string | null
  href: string
}

const serverParts: { key: HealthPart; label: string }[] = [
  { key: 'api', label: 'API' },
  { key: 'readSync', label: 'Read sync' },
  { key: 'agent', label: 'Voice agent' },
]

/** What a working server part says beyond its mark: only the voice agent's last check-in is worth a line. */
const quietWhenOk: readonly HealthPart[] = ['api', 'readSync']

export const groupRow = (g: GroupStatus): Row => {
  const problem = groupProblem(g)
  return {
    id: g.id,
    label: g.label,
    state: g.state,
    mark: statusText(g),
    // A problem is said under the name, in full; the right side stays short.
    value: problem ? null : groupValue(g),
    problem: problem?.line ?? null,
    help: problem?.detail ?? null,
    href: `#admin/providers/${g.id}`,
  }
}

/** The server's own parts, as the health check reports them. */
export const serverRows = (health: AdminHealth | null): Row[] =>
  serverParts.map(({ key, label }) => {
    const status = health?.[key]
    const state: StatusState = !status ? 'checking' : status.ok ? 'works' : 'failing'
    const failing = status && !status.ok
    return {
      id: key,
      label,
      state,
      mark: !status ? 'Checking…' : status.ok ? 'Responding' : `Failing: ${status.message}`,
      value: failing || (status?.ok && quietWhenOk.includes(key)) ? null : (status?.message ?? null),
      problem: failing ? status.message : null,
      help: null,
      href: '#admin/system',
    }
  })

function StatusRow({ row, link }: { row: Row; link: boolean }) {
  const bad = row.state === 'failing'
  return (
    <ListRow
      className={cx('adm-status-row', link && 'adm-status-row-link')}
      lead={<StatusMark state={row.state} label={row.mark} />}
      sub={
        row.problem ? (
          <span className={cx('adm-status-problem', bad && 'adm-status-bad')}>
            {row.problem}
            {row.help && <HelpTip text={row.help} />}
          </span>
        ) : null
      }
      title={
        link ? (
          <a className="adm-status-link" href={row.href} title={`Open ${row.label}`}>
            {row.label}
          </a>
        ) : (
          row.label
        )
      }
      aside={
        row.value ? (
          <span className={cx('adm-status-value', bad && 'adm-status-bad')} title={row.value}>
            {row.value}
          </span>
        ) : null
      }
      actions={link ? <Icon name="left" size={13} className="adm-status-chevron" /> : null}
    />
  )
}

/** The rows: the groups a call needs (and optional ones while they fail), then the server's parts under System. */
export function StatusList({
  groups,
  health,
  links = true,
}: {
  groups: readonly GroupStatus[]
  /** The server's parts: on the overview only. */
  health?: AdminHealth | null
  links?: boolean
}) {
  const parts = overviewGroups(groups).map(groupRow)
  const server = health !== undefined ? serverRows(health) : null
  return (
    <div className="adm-health" aria-live="polite">
      {server && <h3 className="adm-health-sub">Providers</h3>}
      <List label="Providers">
        {parts.map(row => (
          <StatusRow key={row.id} row={row} link={links} />
        ))}
      </List>
      {server && (
        <>
          <h3 className="adm-health-sub">System</h3>
          <List label="System">
            {server.map(row => (
              <StatusRow key={row.id} row={row} link={links} />
            ))}
          </List>
        </>
      )}
    </div>
  )
}

/** The card's state at a glance: the headline's mark. */
const headlineMark = (state: ReturnType<typeof readiness>['state'], serverDown: boolean): StatusState =>
  state === 'blocked' || state === 'failing' || serverDown
    ? 'failing'
    : state === 'ready'
      ? 'works'
      : state === 'checking'
        ? 'checking'
        : 'missing'

export function StatusCard({ status }: { status: ProviderStatusState }) {
  const [open, setOpen] = useState<boolean | null>(null)
  if (!status.status) return <Skeleton className="adm-card adm-skel-card" />
  const { groups } = status.status
  const ready = readiness(groups)
  const server = serverRows(status.health)
  const serverDown = server.find(r => r.state === 'failing')
  const allGood = ready.state === 'ready' && !serverDown && server.every(r => r.state === 'works')
  const expanded = open ?? !allGood
  const notSetUp = groups.some(g => g.needed && g.state === 'missing')
  const headline = serverDown && ready.state === 'ready' ? `${serverDown.label} is failing` : ready.headline
  const mark = headlineMark(ready.state, !!serverDown)
  const line = allGood
    ? 'Email, phone carrier, answering calls and call audio work.'
    : (ready.reason ?? (serverDown ? `${serverDown.label}: ${serverDown.problem}` : null))
  return (
    <section className="adm-card adm-ready" aria-label="Ready for calls">
      <div className="adm-ready-head">
        <StatusMark state={mark} label={headline} />
        <div className="adm-ready-text">
          <h2 className={ready.state === 'blocked' ? 'adm-status-bad' : undefined}>{headline}</h2>
          {line && <p className="help">{line}</p>}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refreshQuery(ADMIN_HEALTH)}
          title="Ask LiveKit, the read sync and the voice agent again"
        >
          Check again
        </Button>
      </div>
      <button
        type="button"
        className="adm-ready-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        title={expanded ? 'Hide the parts' : 'Show every part and what it uses'}
      >
        <Icon name="down" size={12} />
        {expanded ? 'Hide details' : 'Show details'}
      </button>
      {expanded && <StatusList groups={groups} health={status.health} />}
      {notSetUp ? (
        <AgentFirst lead="Not set up yet? An AI agent sets up the rest with you in about 10 minutes." quiet />
      ) : (
        <AgentFirst lead="Everything is set up. Want to change something?" quiet complete />
      )}
    </section>
  )
}
