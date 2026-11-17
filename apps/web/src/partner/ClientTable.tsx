// Partner › Clients, the list (white-label slice S3, LIN-454): every client workspace of this partner with what needs
// a look first (problems), its number and whether calls reach it, the last real call, and this period's calls, minutes
// and cost from the partner bill's ledger, with the monthly usage limit. Never call content: counts and money only.
import type { ClientProblem, PartnerClient, PartnerClientList, PartnerClientRow, PartnerData } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useQuery } from '../cachedQuery.ts'
import { formatPhone } from '../inbox-model.ts'
import { LinkButton } from '../ui/AppLink.tsx'
import { Card } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { loadClients, PARTNER_CLIENTS_QUERY } from './partner-api.ts'

/** Problems that stop calls or money: red. The rest wait for a look. */
const URGENT: ReadonlySet<ClientProblem> = new Set(['bill_inactive', 'disabled', 'limit_reached', 'forwarding_failed'])

const PROBLEM_KEY: Record<ClientProblem, MessageKey> = {
  bill_inactive: msg('team.partner.clients.problem.bill_inactive'),
  disabled: msg('team.partner.clients.problem.disabled'),
  limit_reached: msg('team.partner.clients.problem.limit_reached'),
  limit_near: msg('team.partner.clients.problem.limit_near'),
  no_number: msg('team.partner.clients.problem.no_number'),
  forwarding_failed: msg('team.partner.clients.problem.forwarding_failed'),
  forwarding_unverified: msg('team.partner.clients.problem.forwarding_unverified'),
  provider_errors: msg('team.partner.clients.problem.provider_errors'),
}

const FORWARDING_KEY: Record<NonNullable<PartnerClientRow['forwarding']>, MessageKey> = {
  verified: msg('team.partner.clients.forwarding.verified'),
  not_needed: msg('team.partner.clients.forwarding.not_needed'),
  unverified: msg('team.partner.clients.forwarding.unverified'),
}

type Props = {
  data: PartnerData
  frozen: boolean
  opening: string | null
  onOpen: (id: string) => void
  onInvite: (client: PartnerClient) => void
  onRelease: (client: PartnerClient) => void
  onSettings: (client: PartnerClientRow) => void
}

/** The list from `partner.listClients`; while it loads, the partner's own list keeps the order of names. */
export function ClientTable({ data, frozen, opening, onOpen, onInvite, onRelease, onSettings }: Props) {
  const t = useT()
  const format = useFormat()
  const id = data.partner.id
  const query = useQuery(PARTNER_CLIENTS_QUERY(id), () => loadClients(id))
  const list: PartnerClientList | undefined = query.data
  const owner = data.role === 'owner'
  const byId = new Map(data.clients.map(c => [c.id, c]))
  const period = list?.period
  const description = period
    ? t('team.partner.clients.period', {
        from: format.date(new Date(period.startsAt)),
        to: format.date(new Date(period.endsAt)),
      })
    : t('team.partner.clients.listDescription')

  return (
    <Card title={t('team.partner.clients.title')} description={description}>
      {data.clients.length === 0 ? (
        <p className="adm-notice">{t('team.partner.clients.empty')}</p>
      ) : (
        <Loading
          what={t('team.partner.clients.loadClients')}
          loading={!list}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<SkeletonRows rows={Math.min(data.clients.length, 5)} columns={4} />}
        >
          {list && (
            <div className="adm-scroll">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th scope="col">{t('team.partner.clients.col.business')}</th>
                    <th scope="col">{t('team.partner.clients.col.number')}</th>
                    <th scope="col">{t('team.partner.clients.col.lastCall')}</th>
                    <th scope="col" className="adm-num">
                      {t('team.partner.clients.col.calls')}
                    </th>
                    <th scope="col" className="adm-num">
                      {t('team.partner.clients.col.minutes')}
                    </th>
                    <th scope="col" className="adm-num">
                      {t('team.partner.clients.col.cost')}
                    </th>
                    <th scope="col" className="adm-num">
                      {t('team.partner.clients.col.limit')}
                    </th>
                    <th scope="col" aria-label={t('team.partner.clients.col.actions')} />
                  </tr>
                </thead>
                <tbody>
                  {list.clients.map(row => {
                    const client = byId.get(row.id)
                    return (
                      <tr key={row.id}>
                        <th scope="row">
                          <LinkButton
                            title={t('team.partner.clients.openTip', { name: row.name })}
                            onClick={() => !frozen && !opening && onOpen(row.id)}
                          >
                            {row.name}
                          </LinkButton>
                          <span className="adm-sub">{ownerLine(t, row)}</span>
                          {client && client.otherMembers.length > 0 && (
                            <span className="adm-sub">
                              {t('team.partner.clients.others', {
                                people: client.otherMembers.map(m => memberLine(t, m)).join(' · '),
                              })}
                            </span>
                          )}
                          {row.problems.length > 0 && (
                            <span className="adm-badges">
                              {row.problems.map(p => (
                                <Badge key={p} tone={URGENT.has(p) ? 'danger' : 'neutral'}>
                                  {t(PROBLEM_KEY[p])}
                                </Badge>
                              ))}
                            </span>
                          )}
                        </th>
                        <td>
                          {row.number ? formatPhone(row.number) : t('team.partner.clients.noNumber')}
                          {row.numbers > 1 && (
                            <span className="adm-sub">
                              {t('team.partner.clients.moreNumbers', { count: row.numbers - 1 })}
                            </span>
                          )}
                          {row.forwarding && <span className="adm-sub">{t(FORWARDING_KEY[row.forwarding])}</span>}
                        </td>
                        <td>
                          {row.lastRealCallAt
                            ? format.date(new Date(row.lastRealCallAt))
                            : t('team.partner.clients.noCall')}
                        </td>
                        <td className="adm-num">{format.number(row.calls)}</td>
                        <td className="adm-num">{format.number(Math.ceil(row.seconds / 60))}</td>
                        <td className="adm-num">
                          {row.costCents === null ? '–' : format.currency(row.costCents / 100, 'USD')}
                        </td>
                        <td className="adm-num">
                          {row.limitCents === null || row.limitPercent === null ? (
                            t('team.partner.clients.noLimit')
                          ) : (
                            <>
                              {format.number(row.limitPercent / 100, { style: 'percent', maximumFractionDigits: 0 })}
                              <span className="adm-sub">
                                {t('team.partner.clients.limitOf', {
                                  amount: format.currency(row.limitCents / 100, 'USD', { maximumFractionDigits: 0 }),
                                })}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="adm-num">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!row.billed || data.partner.status === 'suspended'}
                            title={
                              row.billed
                                ? t('team.partner.clients.settingsTip', { name: row.name })
                                : t('team.partner.clients.limit.notBilled')
                            }
                            onClick={() => onSettings(row)}
                          >
                            {t('team.partner.clients.settings')}
                          </Button>
                          {owner && client && client.owner === null && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={frozen || !!opening}
                              title={t('team.partner.clients.inviteOwnerTip', { name: row.name })}
                              onClick={() => onInvite(client)}
                            >
                              {t('team.partner.clients.inviteOwner')}
                            </Button>
                          )}
                          {owner && client?.owner && !('invited' in client.owner) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={data.partner.status === 'suspended' || !!opening}
                              title={t('team.partner.clients.releaseTip', { name: row.name })}
                              onClick={() => onRelease(client)}
                            >
                              {t('team.partner.clients.release')}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            busy={opening === row.id}
                            disabled={frozen || !!opening}
                            title={t('team.partner.clients.openTip', { name: row.name })}
                            onClick={() => onOpen(row.id)}
                          >
                            {t('team.partner.clients.open')}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Loading>
      )}
    </Card>
  )
}

function ownerLine(t: ReturnType<typeof useT>, row: PartnerClientRow) {
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
