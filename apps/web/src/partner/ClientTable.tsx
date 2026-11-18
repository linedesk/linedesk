// Partner › Clients, the list (white-label slice S3, LIN-454): one row per client workspace that fits the page at every
// width. The name with what needs a look (problems, worst first, in amber or red), the owner and the number under it,
// this period's usage from the partner bill's ledger as an amount with a small bar against the monthly limit, and one
// Open with a "…" menu for the rest. Never call content: counts and money only.
import type { PartnerClient, PartnerClientList, PartnerClientRow, PartnerData } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { formatPhone } from '../inbox-model.ts'
import { ColumnHeads, ListEmpty, MenuButton, type MenuItem } from '../ui/list.tsx'
import { Badge, Button, cx } from '../ui/kit.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { barWidth, clientActions, othersThanOwner, problemTone, usageTone, usedNothing } from './clientModel.ts'
import { loadClients, PARTNER_CLIENTS_QUERY } from './partner-api.ts'
import './partner-area.css'

const PROBLEM_KEY: Record<PartnerClientRow['problems'][number], MessageKey> = {
  bill_inactive: msg('team.partner.clients.problem.bill_inactive'),
  disabled: msg('team.partner.clients.problem.disabled'),
  limit_reached: msg('team.partner.clients.problem.limit_reached'),
  limit_near: msg('team.partner.clients.problem.limit_near'),
  no_number: msg('team.partner.clients.problem.no_number'),
  forwarding_failed: msg('team.partner.clients.problem.forwarding_failed'),
  forwarding_unverified: msg('team.partner.clients.problem.forwarding_unverified'),
  provider_errors: msg('team.partner.clients.problem.provider_errors'),
}

type Props = {
  data: PartnerData
  frozen: boolean
  /** Before White-label Cloud is paid: the client workspaces are drafts, open to set up, whose owners' invitations wait. */
  invitesWait?: boolean
  opening: string | null
  onOpen: (id: string, hash?: string) => void
  onInvite: (client: PartnerClient) => void
  onRelease: (client: PartnerClient) => void
  onDelete: (client: PartnerClient) => void
  onSettings: (client: PartnerClientRow) => void
}

/** The list from `partner.listClients`; while it loads, rows of its shape keep the place. */
export function ClientList({
  data,
  frozen,
  invitesWait = false,
  opening,
  onOpen,
  onInvite,
  onRelease,
  onDelete,
  onSettings,
}: Props) {
  const t = useT()
  const format = useFormat()
  const id = data.partner.id
  const query = useQuery(PARTNER_CLIENTS_QUERY(id), () => loadClients(id))
  const list: PartnerClientList | undefined = query.data
  const period = list?.period
  const short = (iso: string) => format.date(new Date(iso), { month: 'short', day: 'numeric' })
  // Without a partner bill (billing off) the numbers are the calendar month's, not a billing period's.
  const usageHead = !data.bill
    ? t('team.partner.clients.col.usageMonth')
    : period
      ? t('team.partner.clients.col.usagePeriod', { from: short(period.startsAt), to: short(period.endsAt) })
      : t('team.partner.clients.col.usage')

  if (data.clients.length === 0) return <ListEmpty>{t('team.partner.clients.empty')}</ListEmpty>
  return (
    <div className="pc-list">
      <ColumnHeads className="pc-cols" labels={[t('team.partner.clients.col.business'), usageHead]} />
      <Loading
        what={t('team.partner.clients.loadClients')}
        loading={!list}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonList rows={Math.min(data.clients.length, 5)} />}
      >
        {list && (
          <ul className="pc-rows" aria-label={t('team.partner.clients.title')}>
            {list.clients.map(row => (
              <ClientRow
                key={row.id}
                row={row}
                client={data.clients.find(c => c.id === row.id)}
                data={data}
                frozen={frozen}
                invitesWait={invitesWait}
                opening={opening}
                onOpen={onOpen}
                onInvite={onInvite}
                onRelease={onRelease}
                onDelete={onDelete}
                onSettings={onSettings}
              />
            ))}
          </ul>
        )}
      </Loading>
    </div>
  )
}

function ClientRow({
  row,
  client,
  data,
  frozen,
  invitesWait,
  opening,
  onOpen,
  onInvite,
  onRelease,
  onDelete,
  onSettings,
}: Omit<Props, 'data'> & { row: PartnerClientRow; client: PartnerClient | undefined; data: PartnerData }) {
  const t = useT()
  const format = useFormat()
  const suspended = data.partner.status === 'suspended'
  const others = othersThanOwner(client)
  const facts: ReactNode[] = [
    ownerText(t, row),
    row.number
      ? row.numbers > 1
        ? t('team.partner.clients.numberAndMore', { number: formatPhone(row.number), count: row.numbers - 1 })
        : formatPhone(row.number)
      : null,
    row.lastRealCallAt
      ? t('team.partner.clients.lastCall', {
          day: format.date(new Date(row.lastRealCallAt), { month: 'short', day: 'numeric' }),
        })
      : null,
  ].filter(Boolean)
  const labels: Record<ReturnType<typeof clientActions>[number]['id'], string> = {
    settings: t('team.partner.clients.settings'),
    inviteOwner: t('team.partner.clients.inviteOwner'),
    ownerInvitation: t('team.partner.clients.ownerInvitation'),
    release: t('team.partner.clients.release'),
    delete: t('team.partner.clients.delete'),
  }
  const items: MenuItem[] = clientActions(row, client, data.role === 'owner', !!data.bill).map(action => ({
    id: action.id,
    label: labels[action.id],
    disabled:
      !action.enabled ||
      suspended ||
      (action.id !== 'settings' && !!opening) ||
      (action.id === 'inviteOwner' && (frozen || invitesWait)) ||
      (action.id === 'ownerInvitation' && (frozen || invitesWait)),
    title:
      action.id === 'settings'
        ? row.billed
          ? t('team.partner.clients.settingsTip', { name: row.name })
          : t('team.partner.clients.limit.notBilled')
        : action.id === 'inviteOwner'
          ? t('team.partner.clients.inviteOwnerTip', { name: row.name })
          : action.id === 'ownerInvitation'
            ? t('team.partner.clients.ownerInvitationTip', { name: row.name })
            : action.id === 'release'
              ? t('team.partner.clients.releaseTip', { name: row.name })
              : t('team.partner.clients.deleteTip', { name: row.name }),
    danger: action.id === 'release' || action.id === 'delete',
    onSelect: () => {
      if (action.id === 'settings') onSettings(row)
      else if (action.id === 'inviteOwner' && client) onInvite(client)
      else if (action.id === 'ownerInvitation') onOpen(row.id, '#workspace/team')
      else if (action.id === 'release' && client) onRelease(client)
      else if (action.id === 'delete' && client) onDelete(client)
    },
  }))

  return (
    <li className="pc-row">
      <div className="pc-main">
        <div className="pc-name">
          <span className="pc-title">{row.name}</span>
          {row.ownKeys && (
            <Badge title={t('team.partner.clients.ownKeys.badgeTip')}>{t('team.partner.clients.ownKeys.badge')}</Badge>
          )}
          {row.problems.map(p => (
            <Badge key={p} tone={problemTone(p)}>
              {t(PROBLEM_KEY[p])}
            </Badge>
          ))}
        </div>
        <span className="pc-sub">
          {facts.map((fact, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed order of at most three facts
            <span key={i}>
              <span className={i === 0 ? undefined : 'pc-fact'}>
                {fact}
                {i < facts.length - 1 && ' ·'}
              </span>
              {i < facts.length - 1 && ' '}
            </span>
          ))}
        </span>
        {others.length > 0 && (
          <span className="pc-sub">
            {t('team.partner.clients.others', { people: others.map(m => memberLine(t, m)).join(' · ') })}
          </span>
        )}
      </div>
      <Usage row={row} />
      <div className="pc-actions">
        <Button
          size="sm"
          variant="secondary"
          busy={opening === row.id}
          disabled={frozen || !!opening}
          title={t('team.partner.clients.openTip', { name: row.name })}
          onClick={() => onOpen(row.id)}
        >
          {t('team.partner.clients.open')}
        </Button>
        {items.length > 0 && <MenuButton items={items} title={t('team.partner.clients.more', { name: row.name })} />}
      </div>
    </li>
  )
}

/**
 * This period's cost against the limit, with a small bar; calls and minutes under it (with "No limit" where there is
 * none). A dash when nothing was used yet.
 */
function Usage({ row }: { row: PartnerClientRow }) {
  const t = useT()
  const format = useFormat()
  const tone = usageTone(row.limitPercent)
  const dollars = (cents: number, digits?: number) =>
    format.currency(cents / 100, 'USD', digits === undefined ? undefined : { maximumFractionDigits: digits })
  const nothing = usedNothing(row)
  // Minutes come from the partner bill's ledger: off the bill only the calls are known.
  const counts = row.billed
    ? t('team.partner.clients.counts', { calls: row.calls, minutes: Math.ceil(row.seconds / 60) })
    : t('team.partner.clients.callCount', { calls: row.calls })
  const limited = row.limitCents !== null && row.limitPercent !== null
  const share = limited ? format.number(row.limitPercent! / 100, { style: 'percent', maximumFractionDigits: 0 }) : ''
  const below = [row.billed && !limited ? t('team.partner.clients.noLimit') : null, nothing ? null : counts].filter(
    Boolean,
  )
  return (
    <div className="pc-usage">
      <span className="pc-amount">
        {nothing ? (
          <span className="pc-dash" title={t('team.partner.clients.nothingUsed')}>
            –
          </span>
        ) : row.costCents === null ? (
          counts
        ) : (
          <b>{dollars(row.costCents)}</b>
        )}
        {limited && (
          <span className="pc-of"> {t('team.partner.clients.limitOf', { amount: dollars(row.limitCents!, 0) })}</span>
        )}
      </span>
      {limited && (
        <span
          className={cx('pc-bar', tone && `is-${tone}`)}
          role="img"
          aria-label={t('team.partner.clients.limitShare', { share })}
          title={t('team.partner.clients.limitShare', { share })}
        >
          <span style={{ width: `${barWidth(row.limitPercent!)}%` }} />
        </span>
      )}
      {row.costCents !== null && below.length > 0 && <span className="pc-sub pc-counts">{below.join(' · ')}</span>}
    </div>
  )
}

function ownerText(t: ReturnType<typeof useT>, row: PartnerClientRow) {
  if (row.owner === null) return t('team.partner.clients.noOwner')
  if (row.owner.state === 'invited') return t('team.partner.clients.ownerInvited', { email: row.owner.email })
  return t('team.partner.clients.ownerIs', { name: row.owner.name || row.owner.email })
}

/** "Dana Ruiz (admin, invited by Mike Brennan)": someone in a client workspace who is not on the partner team. */
export function memberLine(t: ReturnType<typeof useT>, m: PartnerClient['otherMembers'][number]) {
  const who = m.name || m.email
  return m.invitedBy
    ? t('team.partner.clients.memberInvitedBy', { name: who, role: m.role, by: m.invitedBy })
    : t('team.partner.clients.member', { name: who, role: m.role })
}
