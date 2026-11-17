// The partner area (`#partner`, docs/white-label.md): a white-label partner's team sees its client workspaces, creates
// new ones and (the owner) manages the team and the partner bill. It needs no workspace: a new partner has no clients
// yet. Every member of the team is an admin of every client workspace; opening one switches to it like the workspace
// menu does. Where billing is on, client workspaces are seats on the partner bill, which must run first (S2).
import type { MyPartner, PartnerClient, PartnerClientRow, PartnerData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { goToCheckout } from '../checkout.ts'
import { signOutAndForget } from '../localData.ts'
import { Billing } from '../settings/Billing.tsx'
import { purchaseKeys } from '../settings/billingModel.ts'
import { callAction } from '../settings/settings-api.ts'
import { Toast } from '../shell/Toast.tsx'
import { useToast } from '../shell/useToast.ts'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { refreshWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { switchToWorkspace } from '../shell/invitations.ts'
import { tabWorkspace } from '../tabWorkspace.ts'
import { Card, Dialog, FormField, Input } from '../ui/form.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, useSection } from '../ui/SettingsLayout.tsx'
import { day } from '../admin/parts.tsx'
import { ClientSettingsDialog } from './ClientSettingsDialog.tsx'
import { ClientTable } from './ClientTable.tsx'
import { InvitedPicker } from './InvitedPicker.tsx'
import { loadClients, loadPartner, PARTNER_CLIENTS_QUERY, PARTNER_QUERY, partnerErrorText } from './partner-api.ts'
import '../admin/admin.css'

type Section = 'clients' | 'team' | 'billing'

/** Bill states in which client workspaces can be added (the plan runs: trial, paid, or comped). */
const RUNNING: readonly string[] = ['trialing', 'active', 'past_due', 'comped']

/**
 * Whether client workspaces are closed: a suspended partner; with a partner bill, until it runs (approval then gates
 * only the brand, S4); without one (no billing on this server), until a server admin approved the partner.
 */
export function clientsFrozen(data: Pick<PartnerData, 'bill'> & { partner: { status: string } }) {
  if (data.partner.status === 'suspended') return true
  return data.bill ? !RUNNING.includes(data.bill.status) : data.partner.status !== 'approved'
}

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
  const toaster = useToast()
  const query = useQuery(PARTNER_QUERY(partner.id), () => loadPartner(partner.id))
  const data = query.data
  const status = data?.partner.status ?? partner.status
  // Partner › Billing: the partner bill's own page, for its owner (the partner's owner).
  const billMine = !!data?.bill?.mine
  const sections: PageSection<Section>[] = [
    { id: 'clients', label: t('team.partner.clients.title') },
    { id: 'team', label: t('team.partner.team.title') },
    ...(billMine ? [{ id: 'billing' as const, label: t('team.partner.billing.title') }] : []),
  ]
  const current = useSection('partner', sections)
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
          {status === 'pending' && (
            <Note tone="info">{data?.bill ? t('team.partner.pendingBilled') : t('team.partner.pending')}</Note>
          )}
          {status === 'suspended' && <Note tone="danger">{t('team.partner.suspended')}</Note>}
          {data?.bill && status !== 'suspended' && <BillNote data={data} />}
          <Loading
            what={t('team.partner.page')}
            loading={!data}
            error={query.error}
            onRetry={() => void query.reload()}
            skeleton={<SkeletonRows rows={3} columns={2} />}
          >
            {data &&
              (current === 'billing' && billMine ? (
                <Billing toast={text => toaster.show(text)} partnerId={data.partner.id} />
              ) : current === 'team' ? (
                <Team data={data} frozen={status === 'suspended'} />
              ) : (
                <Clients
                  data={data}
                  frozen={clientsFrozen(data)}
                  onFirstWorkspace={onFirstWorkspace}
                  toast={text => toaster.show(text)}
                />
              ))}
          </Loading>
        </SettingsLayout>
      </div>
      {toaster.toast && <Toast toast={toaster.toast} onUndo={() => {}} />}
    </div>
  )
}

/**
 * The partner bill in one line above the sections: waiting for a card (its owner adds one here and the free trial
 * starts), in the free trial (how many client workspaces it takes), or not running.
 */
function BillNote({ data }: { data: PartnerData }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const bill = data.bill!
  if (bill.status === 'pending_payment') {
    if (!bill.mine) return <Note tone="info">{t('team.partner.bill.waitsForOwner')}</Note>
    const start = async () => {
      setBusy(true)
      setFailed(false)
      try {
        await goToCheckout(data.partner.id)
      } catch {
        setFailed(true)
        setBusy(false)
      }
    }
    return (
      <Note tone="info">
        {t('team.partner.bill.addCard')}{' '}
        <Button size="sm" variant="primary" busy={busy} onClick={() => void start()}>
          {t('auth.checkout.addCard')}
        </Button>
        {failed && <span className="help"> {t('auth.checkout.startFailed')}</span>}
      </Note>
    )
  }
  if (bill.status === 'trialing')
    return <Note tone="info">{t('team.partner.bill.trial', { count: bill.trialClientLimit })}</Note>
  if (!RUNNING.includes(bill.status)) return <Note tone="danger">{t('team.partner.bill.inactive')}</Note>
  return null
}

function StatusBadge({ status }: { status: PartnerData['partner']['status'] }) {
  const t = useT()
  if (status === 'approved') return <Badge tone="ok">{t('team.partner.status.approved')}</Badge>
  if (status === 'suspended') return <Badge tone="danger">{t('team.partner.status.suspended')}</Badge>
  return <Badge tone="outline">{t('team.partner.status.pending')}</Badge>
}

/** After a change: the partner as the server has it now, and the person's workspace list (a new client). */
const reloadPartner = async (id: string) => {
  const [partner, clients] = await Promise.all([loadPartner(id), loadClients(id)])
  setQueryData(PARTNER_QUERY(id), partner)
  setQueryData(PARTNER_CLIENTS_QUERY(id), clients)
}
/** After a change to one client's limit or switches: the client list as the server has it now. */
const reloadClients = async (id: string) => setQueryData(PARTNER_CLIENTS_QUERY(id), await loadClients(id))

function Clients({
  data,
  frozen,
  onFirstWorkspace,
  toast,
}: {
  data: PartnerData
  frozen: boolean
  onFirstWorkspace?: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const owner = data.role === 'owner'
  const [name, setName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [inviting, setInviting] = useState<PartnerClient | null>(null)
  const [releasing, setReleasing] = useState<PartnerClient | null>(null)
  const [settings, setSettings] = useState<PartnerClientRow | null>(null)
  // One key per client asked for: a retry after no answer (a timeout, a dropped connection) gets the client made the
  // first time back, never a second one (security review of #1113, L-3).
  const [keys] = useState(() => purchaseKeys())

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const email = ownerEmail.trim()
      const input = {
        partnerId: data.partner.id,
        name: name.trim(),
        ...(owner && email ? { ownerEmail: email } : {}),
      }
      const res = await callAction<{ workspace: { id: string; name: string } }>('workspace.createForClient', input, {
        idempotencyKey: keys.keyFor(JSON.stringify(input)),
      })
      keys.settle()
      setCreated(res.workspace.name)
      setName('')
      setOwnerEmail('')
      // This page opened in no workspace; the server now puts the session in the new one and refuses requests from a
      // page that names none (clientOutdated in the API). So the session loads again first, and the partner area
      // stays open with it.
      if (!tabWorkspace() && onFirstWorkspace) {
        setQueryData(PARTNER_QUERY(data.partner.id), {
          ...data,
          clients: [
            ...data.clients,
            {
              ...res.workspace,
              createdAt: new Date().toISOString(),
              owner: owner && email ? { invited: email } : null,
              otherMembers: [],
              invitedByTeam: [],
            },
          ],
        })
        window.location.hash = '#partner'
        onFirstWorkspace()
        return
      }
      await Promise.all([reloadPartner(data.partner.id), refreshWorkspaces()])
    } catch (err) {
      keys.settle(err)
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
          {owner && (
            <FormField
              id="partner-client-owner"
              label={t('team.partner.clients.ownerEmail')}
              description={t('team.partner.clients.ownerEmailHelp')}
            >
              <Input
                id="partner-client-owner"
                type="email"
                value={ownerEmail}
                disabled={frozen}
                autoComplete="off"
                onChange={e => setOwnerEmail(e.target.value)}
              />
            </FormField>
          )}
          {/* While a card is missing, Add a card above is the one primary action. */}
          <Button type="submit" variant={frozen ? undefined : 'primary'} busy={busy} disabled={frozen || !name.trim()}>
            {t('team.partner.clients.create')}
          </Button>
          {created && <p className="help">{t('team.partner.clients.created', { name: created })}</p>}
        </form>
      </Card>
      <ClientTable
        data={data}
        frozen={frozen}
        opening={opening}
        onOpen={open}
        onInvite={setInviting}
        onRelease={setReleasing}
        onSettings={setSettings}
      />
      {inviting && (
        <InviteOwnerDialog partnerId={data.partner.id} client={inviting} onClose={() => setInviting(null)} />
      )}
      {releasing && <ReleaseDialog partnerId={data.partner.id} client={releasing} onClose={() => setReleasing(null)} />}
      {settings && (
        <ClientSettingsDialog
          partnerId={data.partner.id}
          client={settings}
          owner={owner}
          onClose={() => setSettings(null)}
          onSaved={async message => {
            await reloadClients(data.partner.id)
            toast(message)
          }}
        />
      )}
    </>
  )
}

/** Invites the client's own owner by email (the partner's owner; never someone on the partner team). */
function InviteOwnerDialog({
  partnerId,
  client,
  onClose,
}: {
  partnerId: string
  client: PartnerClient
  onClose: () => void
}) {
  const t = useT()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function send() {
    if (!email.trim() || busy) return
    setBusy(true)
    setProblem(null)
    try {
      await callAction('workspace.inviteClientOwner', { partnerId, workspaceId: client.id, email: email.trim() })
      await reloadPartner(partnerId)
      onClose()
    } catch (err) {
      setProblem(partnerErrorText(err))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={t('team.partner.clients.inviteOwnerTitle', { name: client.name })}
      description={t('team.partner.clients.ownerEmailHelp')}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        void send()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!email.trim()}>
            {t('team.partner.team.invite')}
          </Button>
        </>
      }
    >
      <FormField id="partner-owner-email" label={t('team.partner.team.email')} error={problem}>
        <Input
          id="partner-owner-email"
          type="email"
          value={email}
          autoComplete="off"
          onChange={e => setEmail(e.target.value)}
        />
      </FormField>
    </Dialog>
  )
}

/**
 * Hands a client workspace over to its owner (`partner.releaseClient`): the team leaves it, and where billing is on
 * it moves to a bill of the client's own that waits for their card. The workspace's name is typed to confirm.
 */
function ReleaseDialog({
  partnerId,
  client,
  onClose,
}: {
  partnerId: string
  client: PartnerClient
  onClose: () => void
}) {
  const t = useT()
  // Nobody the team invited leaves unless picked here (security review of #1113, M-1).
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  return (
    <DangerConfirmDialog
      confirm={{
        text: t('team.partner.release.text', { name: client.name }),
        after: t('team.partner.release.after'),
        list: [
          t('team.partner.release.team'),
          ...(client.invitedByTeam.length ? [t('team.partner.release.invitedStay')] : []),
          t('team.partner.release.bill'),
          t('team.partner.release.data'),
        ],
        action: t('team.partner.release.confirm'),
        busyAction: t('team.partner.release.busy'),
        typed: client.name,
        variant: 'danger',
      }}
      run={async () => {
        try {
          await callAction('partner.releaseClient', {
            partnerId,
            workspaceId: client.id,
            confirmName: client.name,
            removeMemberIds: [...removing],
          })
        } catch (err) {
          throw new Error(partnerErrorText(err))
        }
        await Promise.all([reloadPartner(partnerId), refreshWorkspaces()])
        onClose()
      }}
      onClose={onClose}
    >
      <InvitedPicker
        people={client.invitedByTeam}
        legend={t('team.partner.release.invitedPick')}
        selected={removing}
        onChange={setRemoving}
      />
    </DangerConfirmDialog>
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
