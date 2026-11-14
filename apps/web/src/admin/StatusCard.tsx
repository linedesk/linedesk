// Admin › Overview, on top: "Ready for calls" (LIN-158). One read-only list, in the words of Admin › Providers: the
// groups a call needs, the server's own parts (API, read sync, voice agent), and an optional group only while it
// fails. Each row links to where it is fixed; nothing is edited or tested here. Folds to one line once everything
// works; a failing group a call needs makes the headline "Calls are not answered" with the reason. The install
// walkthrough shows the same list (StatusList) without links: it never navigates away (design rule 14).
import { type GroupStatus, overviewGroups, readiness, type StatusState, statusText } from '@linedesk/actions'
import { useState } from 'react'
import { refreshQuery } from '../cachedQuery.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { ADMIN_HEALTH, type AdminHealth, type HealthPart } from './api.ts'
import { AgentFirst } from './Providers.tsx'
import type { ProviderStatusState } from './providerStatus.ts'

type Row = { id: string; label: string; state: StatusState; text: string; href: string }

const serverParts: { key: HealthPart; label: string }[] = [
  { key: 'api', label: 'API' },
  { key: 'readSync', label: 'Read sync' },
  { key: 'agent', label: 'Voice agent' },
]

const groupRow = (g: GroupStatus): Row => ({
  id: g.id,
  label: g.label,
  state: g.state,
  text: [statusText(g), g.providerLabel, g.state !== 'works' && g.state !== 'missing' ? g.message : null]
    .filter(Boolean)
    .join(' · '),
  href: `#admin/providers/${g.id}`,
})

/** The server's own parts, as the health check reports them. */
export const serverRows = (health: AdminHealth | null): Row[] =>
  serverParts.map(({ key, label }) => {
    const status = health?.[key]
    return {
      id: key,
      label,
      state: !status ? 'checking' : status.ok ? 'works' : 'failing',
      text: status?.message ?? 'Checking…',
      href: '#admin/system',
    }
  })

/** The rows: the groups a call needs (and optional ones while they fail), then the server's parts when given. */
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
  const rows = [...overviewGroups(groups).map(groupRow), ...(health !== undefined ? serverRows(health) : [])]
  return (
    <div className="adm-health" aria-live="polite">
      {rows.map(row => (
        <div key={row.id} className="adm-health-row">
          <StatusMark state={row.state} />
          <b>
            {links ? (
              <a className="adm-link" href={row.href} title={`Open ${row.label}`}>
                {row.label}
              </a>
            ) : (
              row.label
            )}
          </b>
          <span className={row.state === 'failing' ? 'help adm-status-bad' : 'help'}>{row.text}</span>
        </div>
      ))}
    </div>
  )
}

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
  const blocked = ready.state === 'blocked'
  return (
    <section className="adm-card" aria-label="Ready for calls">
      <div className="adm-card-head">
        <div>
          <h2 className={blocked ? 'adm-status-bad' : undefined}>
            {allGood ? <Icon name="check" size={14} /> : blocked ? '! ' : null} {headline}
          </h2>
          <p className="help">
            {allGood
              ? 'Email, phone carrier, answering calls and call audio work.'
              : (ready.reason ?? (serverDown ? `${serverDown.label}: ${serverDown.text}` : null))}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refreshQuery(ADMIN_HEALTH)}
          title="Ask LiveKit, the read sync and the voice agent again"
        >
          Check again
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          title={expanded ? 'Fold the list' : 'Show every part'}
        >
          {expanded ? 'Hide' : 'Show'}
        </Button>
      </div>
      {expanded && <StatusList groups={groups} health={status.health} />}
      {notSetUp && (
        <AgentFirst lead="Not set up yet? An AI agent sets up the rest with you in about 15 minutes." quiet />
      )}
    </section>
  )
}
