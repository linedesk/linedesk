// Server admin › Partners (docs/white-label.md): every white-label partner on the install, with its owner, team and
// client workspaces. A server admin creates a partner (its owner is invited by email), approves it, and suspends it:
// a suspended partner's team leaves every client workspace at once until it is approved again. "Waiting for approval"
// (`#admin/partners/waiting`, the link in the new-partner email) lists only the partners still to approve, with their
// number on the tab. A partner's own AI keys (S7) can be turned off here with a reason its owner is emailed: its
// calls then run on the install's keys and are billed until they are turned on again. A partner's own address (S5)
// is removed here at once with a reason its owner is emailed (no approval before: every new address is emailed to the
// instance admins, D3).
import { type AdminPartnerList, PARTNER_CLIENT_LIMIT_MAX } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { useSupportAccess } from '../supportAccess.ts'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { Card, Dialog, FormField, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { runAdmin } from './api.ts'
import { errorText, type Notify } from './notify.ts'
import { BRAND_REVIEWS, loadBrandReviews, PartnerBrands } from './PartnerBrands.tsx'
import { ProtectedNames } from './ProtectedNames.tsx'
import { offersKeysSwitch, waitingCount, waitingPartners } from './partnersModel.ts'
import { day, EMPTY } from './parts.tsx'

export const PARTNERS = 'admin.partners'
export const loadPartners = async () => (await runAdmin('partner.adminList', {})) as AdminPartnerList
type AdminPartner = AdminPartnerList['partners'][number]

/** The partner bill's status, in the words of Server admin › Billing. */
const BILL_STATUS: Record<NonNullable<AdminPartner['billStatus']>, MessageKey> = {
  pending_payment: msg('admin.bills.status.pendingPayment'),
  trialing: msg('admin.bills.status.trialing'),
  active: msg('admin.bills.status.active'),
  past_due: msg('admin.bills.status.pastDue'),
  suspended: msg('admin.bills.status.suspended'),
  canceled: msg('admin.bills.status.canceled'),
  comped: msg('admin.bills.status.comped'),
}

/**
 * What waits for an instance admin here: partners to approve plus brands to review (the tab's number and Overview ›
 * Needs you). Null until both have loaded.
 */
export function usePartnersWaiting(): number | null {
  const supportAccess = useSupportAccess()
  const partners = useQuery(supportAccess ? null : PARTNERS, loadPartners).data
  const brands = useQuery(supportAccess ? null : BRAND_REVIEWS, loadBrandReviews).data
  return partners && brands ? waitingCount(partners.partners, brands.brands) : null
}

/** The page's two views, as links: each has its own address, so Back, reload and the email's link land on it. */
export function PartnerTabs({ waiting, count }: { waiting: boolean; count: number }) {
  const t = useT()
  const format = useFormat()
  return (
    <nav className="adm-billtabs" aria-label={t('admin.partners.tabs')}>
      <div className="ib-tabs">
        <a href="#admin/partners" className="ib-tab" aria-current={waiting ? undefined : 'page'}>
          {t('admin.partners.tabAll')}
        </a>
        <a href="#admin/partners/waiting" className="ib-tab" aria-current={waiting ? 'page' : undefined}>
          {t('admin.partners.tabWaiting')}
          {count ? <span className="n">{format.number(count)}</span> : null}
        </a>
      </div>
    </nav>
  )
}

export function Partners({ notify, waiting = false }: { notify: Notify; waiting?: boolean }) {
  const t = useT()
  const supportAccess = useSupportAccess()
  const query = useQuery(supportAccess ? null : PARTNERS, loadPartners)
  const [name, setName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [limit, setLimit] = useState('')
  const [limitProblem, setLimitProblem] = useState<string | null>(null)
  const shownLimit = limit || String(query.data?.clientLimit ?? '')
  const all = query.data?.partners ?? []
  const pending = waitingPartners(all)
  const shown = waiting ? pending : all
  const waitingNow = usePartnersWaiting()
  // On the waiting tab the partner list is there while partners wait, or as the one "nothing waits" line.
  const showList = !waiting || !query.data || pending.length > 0 || waitingNow === 0

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || !ownerEmail.trim() || busy) return
    setBusy('create')
    setProblem(null)
    try {
      await runAdmin('partner.create', { name: name.trim(), ownerEmail: ownerEmail.trim() })
      notify(t('admin.partners.created', { name: name.trim(), email: ownerEmail.trim() }))
      setName('')
      setOwnerEmail('')
      await query.reload()
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  async function saveLimit(e: FormEvent) {
    e.preventDefault()
    const value = Number(shownLimit)
    if (!Number.isInteger(value) || value < 1 || value > PARTNER_CLIENT_LIMIT_MAX || busy) return
    setBusy('limit')
    setLimitProblem(null)
    try {
      await runAdmin('partner.setClientLimit', { limit: value })
      notify(t('admin.partners.limitSaved', { count: value }))
      setLimit('')
      await query.reload()
    } catch (err) {
      setLimitProblem(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const [keysOff, setKeysOff] = useState<AdminPartner | null>(null)
  const [senderOff, setSenderOff] = useState<AdminPartner | null>(null)
  const [domainOff, setDomainOff] = useState<AdminPartner | null>(null)

  async function keysOn(p: AdminPartner) {
    setBusy(`keys:${p.id}`)
    try {
      await runAdmin('partnerKeys.adminEnable', { partnerId: p.id })
      notify(t('admin.partners.keysOnToast', { name: p.name }))
      await query.reload()
    } catch (err) {
      notify(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  async function change(p: AdminPartner, action: 'partner.approve' | 'partner.suspend') {
    setBusy(p.id)
    try {
      await runAdmin(action, { partnerId: p.id })
      notify(
        action === 'partner.approve'
          ? t('admin.partners.approved', { name: p.name })
          : t('admin.partners.suspendedToast', { name: p.name }),
      )
      await query.reload()
    } catch (err) {
      notify(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PartnerTabs waiting={waiting} count={waitingNow ?? pending.length} />
      {showList && (
        <Card>
          <Loading
            what={t('admin.sections.partners.label')}
            loading={!query.data && !supportAccess}
            error={query.error}
            onRetry={() => void query.reload()}
            skeleton={<SkeletonRows rows={3} columns={5} className="adm-sk-rows" />}
          >
            {query.data && shown.length === 0 ? (
              <p className="adm-notice">{waiting ? t('admin.partners.noneWaiting') : t('admin.partners.empty')}</p>
            ) : (
              <div className="adm-scroll">
                <table className="adm-table adm-stack">
                  <thead>
                    <tr>
                      <th scope="col">{t('admin.partners.name')}</th>
                      <th scope="col">{t('admin.partners.owner')}</th>
                      <th scope="col">{t('admin.partners.bill')}</th>
                      <th scope="col">{t('admin.partners.clients')}</th>
                      <th scope="col" aria-label={t('admin.partners.actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(p => (
                      <tr key={p.id}>
                        <th scope="row">
                          <span className="adm-partner-name">
                            {p.name}
                            {p.status === 'approved' ? (
                              <Badge tone="ok">{t('admin.partners.statusApproved')}</Badge>
                            ) : p.status === 'suspended' ? (
                              <Badge tone="danger">{t('admin.partners.statusSuspended')}</Badge>
                            ) : (
                              <Badge tone="outline">{t('admin.partners.statusPending')}</Badge>
                            )}
                            {p.ownKeysDisabled && (
                              <Badge tone="danger" title={p.ownKeysDisabled.reason}>
                                {t('admin.partners.keysOff')}
                              </Badge>
                            )}
                          </span>
                          <span className="adm-sub">
                            {t('admin.partners.since', { day: day(p.createdAt), count: p.members })}
                          </span>
                          {p.domain && (
                            <span className="adm-sub adm-sub-action">
                              <span>
                                {p.domain.hostname} ·{' '}
                                {p.domain.status === 'active'
                                  ? t('admin.partners.domainLive')
                                  : p.domain.status === 'failed'
                                    ? t('admin.partners.domainFailed')
                                    : t('admin.partners.domainPending')}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={supportAccess || !!busy}
                                title={t('admin.partners.domainRemoveTip', { partner: p.name })}
                                onClick={() => setDomainOff(p)}
                              >
                                {t('admin.partners.domainRemove')}
                              </Button>
                            </span>
                          )}
                          {p.sender && (
                            <span className="adm-sub adm-sub-action" title={p.sender.address}>
                              <span>
                                {p.sender.status === 'verified'
                                  ? t('admin.partners.senderBadge')
                                  : t('admin.partners.senderPending')}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={supportAccess || !!busy}
                                title={t('admin.partners.senderRemoveTip', { partner: p.name })}
                                onClick={() => setSenderOff(p)}
                              >
                                {t('admin.partners.senderRemove')}
                              </Button>
                            </span>
                          )}
                        </th>
                        <td data-label={t('admin.partners.owner')}>
                          {p.owner ? (
                            <>
                              {p.owner.name || p.owner.email}
                              <span className="adm-sub">{p.owner.email}</span>
                            </>
                          ) : p.ownerInvitation ? (
                            <>
                              {p.ownerInvitation.email}
                              <span className="adm-sub">{t('admin.partners.ownerInvited')}</span>
                            </>
                          ) : (
                            EMPTY
                          )}
                        </td>
                        <td data-label={t('admin.partners.bill')}>
                          {p.billStatus ? t(BILL_STATUS[p.billStatus]) : t('admin.partners.noBill')}
                        </td>
                        <td data-label={t('admin.partners.clients')}>{p.clients}</td>
                        <td className="adm-num">
                          <div className="adm-row-actions">
                            {offersKeysSwitch(p) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                busy={busy === `keys:${p.id}`}
                                disabled={supportAccess || !!busy}
                                title={
                                  p.ownKeysDisabled
                                    ? t('admin.partners.keysOnTip', { name: p.name })
                                    : t('admin.partners.keysOffTip', { name: p.name })
                                }
                                onClick={() => (p.ownKeysDisabled ? void keysOn(p) : setKeysOff(p))}
                              >
                                {p.ownKeysDisabled ? t('admin.partners.keysOn') : t('admin.partners.keysOffButton')}
                              </Button>
                            )}
                            {p.status === 'approved' ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                busy={busy === p.id}
                                disabled={supportAccess || !!busy}
                                title={t('admin.partners.suspendTip', { name: p.name })}
                                onClick={() => void change(p, 'partner.suspend')}
                              >
                                {t('admin.partners.suspend')}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="primary"
                                busy={busy === p.id}
                                disabled={supportAccess || !!busy}
                                title={t('admin.partners.approveTip', { name: p.name })}
                                onClick={() => void change(p, 'partner.approve')}
                              >
                                {p.status === 'suspended' ? t('admin.partners.reinstate') : t('admin.partners.approve')}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Loading>
        </Card>
      )}
      {!waiting && (
        <Card title={t('admin.partners.newTitle')} description={t('admin.partners.newDescription')}>
          <form className="adm-form" onSubmit={e => void create(e)}>
            <FormField id="adm-partner-name" label={t('admin.partners.name')}>
              <Input id="adm-partner-name" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
            </FormField>
            <FormField id="adm-partner-owner" label={t('admin.partners.ownerEmail')} error={problem}>
              <Input
                id="adm-partner-owner"
                type="email"
                autoComplete="off"
                value={ownerEmail}
                onChange={e => setOwnerEmail(e.target.value)}
              />
            </FormField>
            <Button
              type="submit"
              variant="primary"
              busy={busy === 'create'}
              disabled={supportAccess || !name.trim() || !ownerEmail.trim()}
            >
              {t('admin.partners.create')}
            </Button>
          </form>
        </Card>
      )}
      {!waiting && (
        <Card title={t('admin.partners.limitTitle')} description={t('admin.partners.limitDescription')}>
          <form className="adm-form" onSubmit={e => void saveLimit(e)}>
            <FormField id="adm-partner-limit" label={t('admin.partners.limit')} error={limitProblem}>
              <Input
                id="adm-partner-limit"
                type="number"
                inputMode="numeric"
                min={1}
                max={PARTNER_CLIENT_LIMIT_MAX}
                value={shownLimit}
                onChange={e => setLimit(e.target.value)}
              />
            </FormField>
            <Button
              type="submit"
              busy={busy === 'limit'}
              disabled={supportAccess || !query.data || !limit || Number(limit) === query.data.clientLimit}
            >
              {t('admin.partners.limitSave')}
            </Button>
          </form>
        </Card>
      )}
      {senderOff?.sender && (
        <DangerConfirmDialog
          confirm={{
            text: t('admin.partners.senderRemoveText', { partner: senderOff.name, address: senderOff.sender.address }),
            action: t('admin.partners.senderRemoveAction'),
            variant: 'danger',
            reason: { label: t('admin.partners.senderRemoveReason'), placeholder: '', min: 3, max: 300 },
          }}
          run={async (_option, reason) => {
            await runAdmin('partnerSender.adminRemove', { partnerId: senderOff.id, reason })
            notify(t('admin.partners.senderRemoveToast'))
            setSenderOff(null)
            await query.reload()
          }}
          onClose={() => setSenderOff(null)}
        />
      )}
      {domainOff?.domain && (
        <DangerConfirmDialog
          confirm={{
            text: t('admin.partners.domainRemoveText', {
              partner: domainOff.name,
              hostname: domainOff.domain.hostname,
            }),
            action: t('admin.partners.domainRemoveAction'),
            variant: 'danger',
            reason: { label: t('admin.partners.domainRemoveReason'), placeholder: '', min: 3, max: 300 },
          }}
          run={async (_option, reason) => {
            await runAdmin('partnerDomain.adminRemove', { partnerId: domainOff.id, reason })
            notify(t('admin.partners.domainRemoveToast'))
            setDomainOff(null)
            await query.reload()
          }}
          onClose={() => setDomainOff(null)}
        />
      )}
      {keysOff && (
        <KeysOffDialog
          partner={keysOff}
          onClose={() => setKeysOff(null)}
          onDone={async () => {
            notify(t('admin.partners.keysOffToast', { name: keysOff.name }))
            setKeysOff(null)
            await query.reload()
          }}
        />
      )}
      <PartnerBrands notify={notify} waiting={waiting} />
      {!waiting && <ProtectedNames notify={notify} />}
    </>
  )
}

/** Turning a partner's own AI keys off: the reason goes to its owner by email. */
function KeysOffDialog({
  partner,
  onClose,
  onDone,
}: {
  partner: AdminPartner
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const t = useT()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function submit() {
    if (busy || reason.trim().length < 3) return
    setBusy(true)
    setProblem(null)
    try {
      await runAdmin('partnerKeys.adminDisable', { partnerId: partner.id, reason: reason.trim() })
      await onDone()
    } catch (err) {
      setProblem(errorText(err))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={t('admin.partners.keysOffTitle', { name: partner.name })}
      description={t('admin.partners.keysOffDescription')}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button type="submit" variant="danger" busy={busy} disabled={reason.trim().length < 3}>
            {t('admin.partners.keysOffButton')}
          </Button>
        </>
      }
    >
      <FormField id="adm-keys-off-reason" label={t('admin.partners.keysOffReason')} error={problem}>
        <Input
          id="adm-keys-off-reason"
          value={reason}
          maxLength={300}
          autoComplete="off"
          onChange={e => setReason(e.target.value)}
        />
      </FormField>
    </Dialog>
  )
}
