// The partner area (`#partner`, docs/white-label.md): a white-label partner's team sees its client workspaces, creates
// new ones and (the owner) manages the team. It needs no workspace: a new partner has no clients yet. Every member of
// the team is an admin of every client workspace; opening one switches to it like the workspace menu does.
import type { MyPartner, PartnerData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { signOutAndForget } from '../localData.ts'
import { callAction } from '../settings/settings-api.ts'
import { refreshWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { switchToWorkspace } from '../shell/invitations.ts'
import { tabWorkspace } from '../tabWorkspace.ts'
import { Card, FormField, Input } from '../ui/form.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, useSection } from '../ui/SettingsLayout.tsx'
import { day } from '../admin/parts.tsx'
import { loadPartner, PARTNER_QUERY, partnerErrorText } from './partner-api.ts'
import '../admin/admin.css'

type Section = 'clients' | 'team'

type Props = {
  partner: MyPartner
  /** Back to the inbox; absent for someone in no workspace yet (they sign out from here instead). */
  onExit?: () => void
  /** After signing out (no workspace). */
  onSignedOut?: () => void
  /** The first client workspace was made by someone in no workspace yet: the session now has one, load it again. */
  onFirstWorkspace?: () => void
}

export function PartnerArea({ partner, onExit, onSignedOut, onFirstWorkspace }: Props) {
  const t = useT()
  const sections: PageSection<Section>[] = [
    { id: 'clients', label: t('team.partner.clients.title') },
    { id: 'team', label: t('team.partner.team.title') },
  ]
  const current = useSection('partner', sections)
  const query = useQuery(PARTNER_QUERY(partner.id), () => loadPartner(partner.id))
  const data = query.data
  const status = data?.partner.status ?? partner.status
  // Esc goes back to the inbox, as from Server admin (not while typing in a field).
  useEffect(() => {
    if (!onExit) return
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (e.key === 'Escape' && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])
  return (
    <div className="adm-mode">
      <div className="pagebar">
        {onExit ? (
          <Button
            size="sm"
            variant="ghost"
            icon="left"
            aria-label={t('team.partner.back')}
            title={t('common.withKey', { label: t('team.partner.back'), key: 'esc' })}
            onClick={onExit}
          />
        ) : null}
        <b>{t('team.partner.pageNamed', { partner: data?.partner.name ?? partner.name })}</b>
        {!onExit && (
          <Button size="sm" variant="ghost" onClick={() => void signOutAndForget().then(onSignedOut)}>
            {t('shell.signOut')}
          </Button>
        )}
      </div>
      <div className="page">
        <SettingsLayout
          page="partner"
          title={data?.partner.name ?? partner.name}
          description={t('team.partner.description')}
          actions={<StatusBadge status={status} />}
          sections={sections}
          current={current}
        >
          {status === 'pending' && <Note tone="info">{t('team.partner.pending')}</Note>}
          {status === 'suspended' && <Note tone="danger">{t('team.partner.suspended')}</Note>}
          <Loading
            what={t('team.partner.page')}
            loading={!data}
            error={query.error}
            onRetry={() => void query.reload()}
            skeleton={<SkeletonRows rows={3} columns={2} />}
          >
            {data &&
              (current === 'clients' ? (
                <Clients data={data} frozen={status !== 'approved'} onFirstWorkspace={onFirstWorkspace} />
              ) : (
                <Team data={data} frozen={status === 'suspended'} />
              ))}
          </Loading>
        </SettingsLayout>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: PartnerData['partner']['status'] }) {
  const t = useT()
  if (status === 'approved') return <Badge tone="ok">{t('team.partner.status.approved')}</Badge>
  if (status === 'suspended') return <Badge tone="danger">{t('team.partner.status.suspended')}</Badge>
  return <Badge tone="outline">{t('team.partner.status.pending')}</Badge>
}

/** After a change: the partner as the server has it now, and the person's workspace list (a new client). */
const reloadPartner = async (id: string) => setQueryData(PARTNER_QUERY(id), await loadPartner(id))

function Clients({
  data,
  frozen,
  onFirstWorkspace,
}: {
  data: PartnerData
  frozen: boolean
  onFirstWorkspace?: () => void
}) {
  const t = useT()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const res = await callAction<{ workspace: { id: string; name: string } }>('workspace.createForClient', {
        partnerId: data.partner.id,
        name: name.trim(),
      })
      setCreated(res.workspace.name)
      setName('')
      // This page opened in no workspace; the server now puts the session in the new one and refuses requests from a
      // page that names none (clientOutdated in the API). So the session loads again first, and the partner area
      // stays open with it.
      if (!tabWorkspace() && onFirstWorkspace) {
        setQueryData(PARTNER_QUERY(data.partner.id), {
          ...data,
          clients: [...data.clients, { ...res.workspace, createdAt: new Date().toISOString() }],
        })
        window.location.hash = '#partner'
        onFirstWorkspace()
        return
      }
      await Promise.all([reloadPartner(data.partner.id), refreshWorkspaces()])
    } catch (err) {
      setProblem(partnerErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  function open(id: string) {
    setOpening(id)
    switchToWorkspace(id).catch(err => {
      setOpening(null)
      setProblem(partnerErrorText(err))
    })
  }

  return (
    <>
      <Card title={t('team.partner.clients.newTitle')} description={t('team.partner.clients.newDescription')}>
        <form className="adm-form" onSubmit={e => void create(e)}>
          <FormField id="partner-client-name" label={t('team.partner.clients.name')} error={problem}>
            <Input
              id="partner-client-name"
              value={name}
              maxLength={80}
              disabled={frozen}
              onChange={e => setName(e.target.value)}
            />
          </FormField>
          <Button type="submit" variant="primary" busy={busy} disabled={frozen || !name.trim()}>
            {t('team.partner.clients.create')}
          </Button>
          {created && <p className="help">{t('team.partner.clients.created', { name: created })}</p>}
        </form>
      </Card>
      <Card title={t('team.partner.clients.title')} description={t('team.partner.clients.listDescription')}>
        {data.clients.length === 0 ? (
          <p className="adm-notice">{t('team.partner.clients.empty')}</p>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">{t('team.partner.clients.name')}</th>
                <th scope="col">{t('team.partner.clients.since')}</th>
                <th scope="col" aria-label={t('team.partner.clients.open')} />
              </tr>
            </thead>
            <tbody>
              {data.clients.map(c => (
                <tr key={c.id}>
                  <th scope="row">{c.name}</th>
                  <td>{day(c.createdAt)}</td>
                  <td className="adm-num">
                    <Button
                      size="sm"
                      busy={opening === c.id}
                      disabled={frozen || !!opening}
                      title={t('team.partner.clients.openTip', { name: c.name })}
                      onClick={() => open(c.id)}
                    >
                      {t('team.partner.clients.open')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}

function Team({ data, frozen }: { data: PartnerData; frozen: boolean }) {
  const t = useT()
  const owner = data.role === 'owner'
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const partnerId = data.partner.id

  async function run(key: string, name: string, input: object, message: string) {
    setBusy(key)
    setProblem(null)
    setDone(null)
    try {
      await callAction(name, { partnerId, ...input })
      setDone(message)
      await reloadPartner(partnerId)
      return true
    } catch (err) {
      setProblem(partnerErrorText(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault()
    const address = email.trim()
    if (!address || busy) return
    if (
      await run(
        'invite',
        'partnerMember.invite',
        { email: address },
        t('team.partner.team.invited', { email: address }),
      )
    )
      setEmail('')
  }

  return (
    <>
      {owner && (
        <Card title={t('team.partner.team.inviteTitle')} description={t('team.partner.team.inviteDescription')}>
          <form className="adm-form" onSubmit={e => void invite(e)}>
            <FormField id="partner-invite-email" label={t('team.partner.team.email')}>
              <Input
                id="partner-invite-email"
                type="email"
                value={email}
                disabled={frozen}
                autoComplete="off"
                onChange={e => setEmail(e.target.value)}
              />
            </FormField>
            <Button type="submit" variant="primary" busy={busy === 'invite'} disabled={frozen || !email.trim()}>
              {t('team.partner.team.invite')}
            </Button>
          </form>
        </Card>
      )}
      {problem && (
        <Note tone="danger" role="alert">
          {problem}
        </Note>
      )}
      {done && (
        <Note tone="success" role="status">
          {done}
        </Note>
      )}
      <Card title={t('team.partner.team.title')} description={t('team.partner.team.description')}>
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{t('team.partner.team.name')}</th>
              <th scope="col">{t('team.partner.team.role')}</th>
              {owner && <th scope="col" aria-label={t('team.partner.team.remove')} />}
            </tr>
          </thead>
          <tbody>
            {data.members.map(m => (
              <tr key={m.userId}>
                <th scope="row">
                  {m.name || m.email}
                  <span className="adm-sub">{m.email}</span>
                </th>
                <td>{m.role === 'owner' ? t('team.partner.role.owner') : t('team.partner.role.admin')}</td>
                {owner && (
                  <td className="adm-num">
                    {m.role !== 'owner' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={busy === m.userId}
                        disabled={frozen || !!busy}
                        title={t('team.partner.team.removeTip', { name: m.name || m.email })}
                        onClick={() =>
                          void run(
                            m.userId,
                            'partnerMember.remove',
                            { userId: m.userId },
                            t('team.partner.team.removed', { name: m.name || m.email }),
                          )
                        }
                      >
                        {t('team.partner.team.remove')}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {data.invitations.map(i => (
              <tr key={i.id}>
                <th scope="row">
                  {i.email}
                  <span className="adm-sub">
                    {i.expired
                      ? t('team.partner.team.inviteExpired')
                      : t('team.partner.team.invitedUntil', { day: day(i.expiresAt) })}
                  </span>
                </th>
                <td>{i.role === 'owner' ? t('team.partner.role.owner') : t('team.partner.role.admin')}</td>
                <td className="adm-num">
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy === i.id}
                    disabled={frozen || !!busy}
                    title={t('team.partner.team.withdrawTip', { email: i.email })}
                    onClick={() =>
                      void run(
                        i.id,
                        'partnerMember.revokeInvite',
                        { invitationId: i.id },
                        t('team.partner.team.withdrawn', { email: i.email }),
                      )
                    }
                  >
                    {t('team.partner.team.withdraw')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}
