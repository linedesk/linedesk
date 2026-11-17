// Server admin › Partners (docs/white-label.md): every white-label partner on the install, with its owner, team and
// client workspaces. A server admin creates a partner (its owner is invited by email), approves it, and suspends it:
// a suspended partner's team leaves every client workspace at once until it is approved again.
import { type AdminPartnerList, PARTNER_CLIENT_LIMIT_MAX } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { useSupportAccess } from '../supportAccess.ts'
import { Card, FormField, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { runAdmin } from './api.ts'
import { errorText, type Notify } from './notify.ts'
import { PartnerBrands } from './PartnerBrands.tsx'
import { ProtectedNames } from './ProtectedNames.tsx'
import { day, EMPTY } from './parts.tsx'

const PARTNERS = 'admin.partners'
const load = async () => (await runAdmin('partner.adminList', {})) as AdminPartnerList
type AdminPartner = AdminPartnerList['partners'][number]

export function Partners({ notify }: { notify: Notify }) {
  const t = useT()
  const supportAccess = useSupportAccess()
  const query = useQuery(supportAccess ? null : PARTNERS, load)
  const [name, setName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [limit, setLimit] = useState('')
  const [limitProblem, setLimitProblem] = useState<string | null>(null)
  const shownLimit = limit || String(query.data?.clientLimit ?? '')

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
      <div className="adm-card adm-listcard">
        <Loading
          what={t('admin.sections.partners.label')}
          loading={!query.data && !supportAccess}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<SkeletonRows rows={3} columns={5} className="adm-sk-rows" />}
        >
          {query.data && query.data.partners.length === 0 ? (
            <p className="adm-notice">{t('admin.partners.empty')}</p>
          ) : (
            <div className="adm-scroll">
              <table className="adm-table adm-stack">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.partners.name')}</th>
                    <th scope="col">{t('admin.partners.status')}</th>
                    <th scope="col">{t('admin.partners.owner')}</th>
                    <th scope="col" className="adm-num">
                      {t('admin.partners.team')}
                    </th>
                    <th scope="col" className="adm-num">
                      {t('admin.partners.clients')}
                    </th>
                    <th scope="col">{t('admin.partners.createdAt')}</th>
                    <th scope="col" aria-label={t('admin.partners.actions')} />
                  </tr>
                </thead>
                <tbody>
                  {(query.data?.partners ?? []).map(p => (
                    <tr key={p.id}>
                      <th scope="row">{p.name}</th>
                      <td data-label={t('admin.partners.status')}>
                        {p.status === 'approved' ? (
                          <Badge tone="ok">{t('admin.partners.statusApproved')}</Badge>
                        ) : p.status === 'suspended' ? (
                          <Badge tone="danger">{t('admin.partners.statusSuspended')}</Badge>
                        ) : (
                          <Badge tone="outline">{t('admin.partners.statusPending')}</Badge>
                        )}
                      </td>
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
                      <td className="adm-num" data-label={t('admin.partners.team')}>
                        {p.members}
                      </td>
                      <td className="adm-num" data-label={t('admin.partners.clients')}>
                        {p.clients}
                      </td>
                      <td data-label={t('admin.partners.createdAt')}>{day(p.createdAt)}</td>
                      <td className="adm-num">
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
                            busy={busy === p.id}
                            disabled={supportAccess || !!busy}
                            title={t('admin.partners.approveTip', { name: p.name })}
                            onClick={() => void change(p, 'partner.approve')}
                          >
                            {p.status === 'suspended' ? t('admin.partners.reinstate') : t('admin.partners.approve')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loading>
      </div>
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
      <PartnerBrands notify={notify} />
      <ProtectedNames notify={notify} />
    </>
  )
}
