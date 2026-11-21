// Server admin › Overview, on top: "Ready for calls" (LIN-158). One read-only summary in the words of Server admin ›
// Providers: a calm line with the mark and the headline, and the details below it: the groups a call needs (and an
// optional group only while it fails), then the server's own parts (API, read sync, voice agent) under System. Each
// part is a row of the app's list (ui/list.tsx) that opens where it is fixed; nothing is edited or tested here. The
// same status rule as Providers: a part that works shows only its mark (the words are its tooltip) and what is in use,
// muted; words only for a problem. The details fold away once everything works; a failing group a call needs makes the
// headline "Calls are not answered" with the reason. The install walkthrough shows the same rows (StatusList) without
// links: it never navigates away (design rule 14).
import { type GroupStatus, overviewGroups, readiness, type StatusState, statusText } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { refreshQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { HelpTip } from '../ui/form.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import { List, ListRow } from '../ui/list.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { ADMIN_HEALTH, type AdminHealth, type HealthPart } from './api.ts'
import { AgentFirst } from './Providers.tsx'
import { groupProblem, groupValue, type ProviderStatusState, providerErrorLine } from './providerStatus.ts'

/**
 * One part: its mark (with `mark` as tooltip), its name, a short muted value at the right (what is in use, or "Not set
 * up"), and for a problem a sentence under the name (`problem`, it wraps) with the detail behind a (?) (`help`).
 */
export type Row = {
  id: string
  label: string
  /** null: a part with no state of its own (Billing › Prices and rules); the row keeps the mark's place empty. */
  state: StatusState | null
  mark: string
  value: string | null
  problem: string | null
  help: string | null
  href: string
}

const serverParts: { key: HealthPart; label: MessageKey }[] = [
  { key: 'api', label: msg('admin.status.part.api') },
  { key: 'readSync', label: msg('admin.status.part.readSync') },
  { key: 'agent', label: msg('admin.status.part.agent') },
]

/** What a working server part says beyond its mark: only the voice agent's last check-in is worth a line. */
const quietWhenOk: readonly HealthPart[] = ['api', 'readSync']

export const groupRow = (g: GroupStatus): Row => {
  const problem = groupProblem(g)
  return {
    id: g.id,
    label: g.label,
    state: g.state,
    mark: statusText(g, i18n()),
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
    const { t } = i18n()
    const status = health?.[key]
    const state: StatusState = !status ? 'checking' : status.ok ? 'works' : 'failing'
    const failing = status && !status.ok
    return {
      id: key,
      label: t(label),
      state,
      // The status word once in the mark; the error once, short, under the name, its full text behind the (?).
      mark: !status
        ? t('admin.providers.checking')
        : status.ok
          ? t('admin.status.responding')
          : t('admin.status.failing'),
      value: failing || (status?.ok && quietWhenOk.includes(key)) ? null : (status?.message ?? null),
      problem: failing ? providerErrorLine(status.message) : null,
      help: failing && providerErrorLine(status.message) !== status.message.trim() ? status.message : null,
      href: '#admin/server',
    }
  })

/** One part as a row of the list; with `link` the whole row opens `href` (Overview, Billing). */
export function StatusRow({ row, link }: { row: Row; link: boolean }) {
  const t = useT()
  const bad = row.state === 'failing'
  return (
    <ListRow
      className={cx('adm-status-row', link && 'adm-status-row-link')}
      lead={
        row.state ? (
          <StatusMark state={row.state} label={row.mark} />
        ) : (
          <span className="adm-status-nomark" aria-hidden />
        )
      }
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
          <a className="adm-status-link" href={row.href} title={t('admin.status.openTip', { part: row.label })}>
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
  const t = useT()
  const parts = overviewGroups(groups).map(groupRow)
  const server = health !== undefined ? serverRows(health) : null
  return (
    <div className="adm-health" aria-live="polite">
      {server && <h3 className="adm-health-sub">{t('admin.status.providers')}</h3>}
      <List label={t('admin.status.providers')}>
        {parts.map(row => (
          <StatusRow key={row.id} row={row} link={links} />
        ))}
      </List>
      {server && (
        <>
          <h3 className="adm-health-sub">{t('admin.status.system')}</h3>
          <List label={t('admin.status.system')}>
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
  const t = useT()
  const [open, setOpen] = useState<boolean | null>(null)
  if (!status.status) return <Skeleton className="adm-card adm-skel-card" />
  const { groups } = status.status
  const ready = readiness(groups, i18n())
  const server = serverRows(status.health)
  const serverDown = server.find(r => r.state === 'failing')
  const allGood = ready.state === 'ready' && !serverDown && server.every(r => r.state === 'works')
  const expanded = open ?? !allGood
  const notSetUp = groups.some(g => g.needed && g.state === 'missing')
  const headline =
    serverDown && ready.state === 'ready' ? t('admin.status.partFailing', { part: serverDown.label }) : ready.headline
  const mark = headlineMark(ready.state, !!serverDown)
  const line = allGood
    ? t('admin.status.allGood')
    : (ready.reason ??
      (serverDown ? t('admin.status.partProblem', { part: serverDown.label, problem: serverDown.problem }) : null))
  return (
    <section className="adm-card adm-ready" aria-label={t('admin.status.readyLabel')}>
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
          title={t('admin.status.checkAgainTip')}
        >
          {t('admin.status.checkAgain')}
        </Button>
      </div>
      <button
        type="button"
        className="adm-ready-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        title={expanded ? t('admin.status.details.hideTip') : t('admin.status.details.showTip')}
      >
        <Icon name="down" size={12} />
        {expanded ? t('admin.status.details.hide') : t('admin.status.details.show')}
      </button>
      {expanded && <StatusList groups={groups} health={status.health} />}
      {notSetUp ? (
        <AgentFirst lead={t('admin.status.agentNotSetUpLead')} quiet />
      ) : (
        <AgentFirst lead={t('admin.status.agentAllSetLead')} quiet complete />
      )}
    </section>
  )
}
