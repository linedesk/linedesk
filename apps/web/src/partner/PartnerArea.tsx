// The partner area (`#partner`, docs/white-label.md): a white-label partner's team sees its client workspaces, creates
// new ones and (the owner) manages the team and the partner bill. It needs no workspace: a new partner has no clients
// yet. Every member of the team is an admin of every client workspace; opening one switches to it like the workspace
// menu does. Where billing is on, client workspaces are seats on the partner bill, which must run first (S2).
import {
  type MyPartner,
  type PartnerClient,
  type PartnerClientRow,
  type PartnerData,
  UNPAID_PARTNER_CLIENTS,
} from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { day } from '../admin/parts.tsx'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { goToCheckout } from '../checkout.ts'
import { useCountryHint } from '../countryHint.ts'
import { Billing } from '../settings/Billing.tsx'
import { PARTNER_AGENT_HASH, PARTNER_SETUP_HASH, rememberPartnerByHand } from '../onboarding/setup-choice.ts'
import { SetupTopBar } from '../onboarding/SetupTopBar.tsx'
import { purchaseKeys } from '../settings/billingModel.ts'
import { CountrySelect } from '../settings/CountrySelect.tsx'
import { callAction } from '../settings/settings-api.ts'
import { TimeZonePicker } from '../settings/TimeZonePicker.tsx'
import { browserTimeZone } from '../settings/timeZones.ts'
import { AskName } from '../shell/AskName.tsx'
import { switchToWorkspace } from '../shell/invitations.ts'
import { Toast } from '../shell/Toast.tsx'
import { useToast } from '../shell/useToast.ts'
import { refreshWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { tabWorkspace } from '../tabWorkspace.ts'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { Card, Dialog, FormField, Input } from '../ui/form.tsx'
import { Avatar, Badge, Button, Icon, Note } from '../ui/kit.tsx'
import { List, ListRow } from '../ui/list.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, sectionParts, useSection } from '../ui/SettingsLayout.tsx'
import { ClientSettingsDialog } from './ClientSettingsDialog.tsx'
import { ClientList } from './ClientTable.tsx'
import { InvitedPicker } from './InvitedPicker.tsx'
import { loadClients, loadPartner, PARTNER_CLIENTS_QUERY, PARTNER_QUERY, partnerErrorText } from './partner-api.ts'
import '../admin/admin.css'
import './partner-area.css'
import { PartnerBrand } from './PartnerBrand.tsx'
import { PartnerDomain } from './PartnerDomain.tsx'
import { PartnerKeys } from './PartnerKeys.tsx'
import { PartnerSender } from './PartnerSender.tsx'
import { PartnerPrice, PartnerSetup } from './PartnerSetup.tsx'

type Section = 'clients' | 'team' | 'brand' | 'domain' | 'email' | 'keys' | 'billing'

/** Bill states in which client workspaces can be added (the plan runs: trial, paid, or comped). */
const RUNNING: readonly string[] = ['trialing', 'active', 'past_due', 'comped']

/**
 * The partner area's sections: Domain for every partner (it says itself when this server has no provider for it);
 * Email sender and AI keys only for a partner with a bill (White-label Cloud: own keys take the usage fee away, the
 * sender needs the install's Resend), Billing only for the partner bill's owner.
 */
export function partnerSections(t: ReturnType<typeof useT>, billing: boolean, keys = false): PageSection<Section>[] {
  return [
    { id: 'clients', label: t('team.partner.clients.title') },
    { id: 'team', label: t('team.partner.team.title') },
    { id: 'brand', label: t('team.partner.brand.title') },
    { id: 'domain', label: t('team.partner.domain.title') },
    ...(keys
      ? [
          { id: 'email' as const, label: t('team.partner.sender.title') },
          { id: 'keys' as const, label: t('team.partner.keys.title') },
        ]
      : []),
    ...(billing ? [{ id: 'billing' as const, label: t('team.partner.billing.title') }] : []),
  ]
}

/**
 * Whether client workspaces are closed: a suspended partner; with a partner bill, while it does not run (approval then
 * gates only the brand, S4), except before its Checkout, when the partner prepares drafts (unpaidPartner); without one
 * (no billing on this server), until a server admin approved the partner.
 */
export function clientsFrozen(data: Pick<PartnerData, 'bill'> & { partner: { status: string } }) {
  if (data.partner.status === 'suspended') return true
  if (unpaidPartner(data)) return false
  return data.bill ? !RUNNING.includes(data.bill.status) : data.partner.status !== 'approved'
}

/**
 * White-label Cloud is not paid yet (setup before payment, 2026-11-18): the partner sets up and prepares up to
 * UNPAID_PARTNER_CLIENTS client workspaces; invitations, numbers and calls wait for its Checkout.
 */
export const unpaidPartner = (data: Pick<PartnerData, 'bill'>) => data.bill?.status === 'pending_payment'

/** Whether another client workspace can be made now: before the Checkout, only up to UNPAID_PARTNER_CLIENTS. */
export const roomForClient = (data: Pick<PartnerData, 'bill' | 'clients'>) =>
  !unpaidPartner(data) || data.clients.length < UNPAID_PARTNER_CLIENTS

type Props = {
  partner: MyPartner
  /** Back to the inbox; absent for someone in no workspace yet (the account menu signs out). */
  onExit?: () => void
  /** The first client workspace was made by someone in no workspace yet: the session now has one, load it again. */
  onFirstWorkspace?: () => void
}

export function PartnerArea(props: Props) {
  // The owner's guided setup (#partner/setup): full screen, in place of the area.
  const setup = useHashStartsWith(PARTNER_SETUP_HASH)
  if (setup && props.partner.role === 'owner' && props.partner.status !== 'suspended')
    return <PartnerSetup partner={props.partner} onFirstWorkspace={props.onFirstWorkspace} />
  return <PartnerConsole {...props} />
}

/** Whether the address is `prefix` or below it (`prefix/…`), following it as it changes. */
function useHashStartsWith(prefix: string) {
  const [on, setOn] = useState(() => hashUnder(window.location.hash, prefix))
  useEffect(() => {
    const follow = () => setOn(hashUnder(window.location.hash, prefix))
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [prefix])
  return on
}

/** `hash` is `prefix` or a page below it. */
export const hashUnder = (hash: string, prefix: string) => hash === prefix || hash.startsWith(`${prefix}/`)

function PartnerConsole({ partner, onExit, onFirstWorkspace }: Props) {
  const t = useT()
  const toaster = useToast()
  const query = useQuery(PARTNER_QUERY(partner.id), () => loadPartner(partner.id))
  const data = query.data
  const status = data?.partner.status ?? partner.status
  // Partner › Billing: the partner bill's own page, for its owner (the partner's owner). Until the partner has loaded,
  // a link straight to it (`#partner/billing`) keeps its section, so the page does not fall back to Clients.
  const billMine = !!data?.bill?.mine
  const [linked] = useState(() => sectionParts('partner', window.location.hash).section)
  const sections = useMemo(
    () =>
      partnerSections(
        t,
        billMine || (!data && linked === 'billing'),
        !!data?.bill || (!data && (linked === 'keys' || linked === 'email')),
      ),
    [t, billMine, data, linked],
  )
  const current = useSection('partner', sections)
  // Esc goes back to the inbox, as from Server admin (not while typing in a field, and not when it closes a dialog or
  // a menu: that Esc only closes it).
  useEffect(() => {
    if (!onExit) return
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (el?.closest('[role="dialog"], [role="menu"]') || document.querySelector('[aria-modal="true"]')) return
      onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])
  return (
    <div className="adm-mode k-install-brand">
      {/* The setup pages' top bar (SetupTopBar): Linedesk, never a white-label brand (brand.ts), and what this page is;
          the AI agent, the way back to the inbox where there is one (Esc too) and the account menu (another workspace or
          partner, sign out). The partner's own name is the context line over the sections. */}
      <SetupTopBar
        label={t('team.partner.page')}
        agentPath={
          partner.role === 'owner' && status !== 'suspended'
            ? () => {
                rememberPartnerByHand(partner.id, false)
                window.location.hash = PARTNER_AGENT_HASH
              }
            : undefined
        }
        exit={
          onExit
            ? {
                kind: 'close',
                onExit,
                title: t('common.withKey', { label: t('team.partner.back'), key: 'esc' }),
              }
            : null
        }
        brand="install"
        away
      />
      <div className="page">
        <SettingsLayout
          page="partner"
          title={t('team.partner.page')}
          context={<span className="sl-context-text">{data?.partner.name ?? partner.name}</span>}
          sections={sections}
          current={current}
        >
          {/* Only what stops the partner shows above every section; approval never does where billing is on (it only
              gates the brand in emails: said in Brand), and activating is the Clients section's own card. */}
          {status === 'suspended' && <Note tone="danger">{t('team.partner.suspended')}</Note>}
          {data?.bill && status !== 'suspended' && !RUNNING.includes(data.bill.status) && !unpaidPartner(data) && (
            <Note tone="danger">{t('team.partner.bill.inactive')}</Note>
          )}
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
              ) : current === 'email' && data.bill ? (
                <PartnerSender partnerId={data.partner.id} toast={text => toaster.show(text)} />
              ) : current === 'keys' && data.bill ? (
                <PartnerKeys partnerId={data.partner.id} toast={text => toaster.show(text)} />
              ) : current === 'domain' ? (
                <PartnerDomain partnerId={data.partner.id} toast={text => toaster.show(text)} />
              ) : current === 'brand' ? (
                <PartnerBrand partnerId={data.partner.id} partnerName={data.partner.name} />
              ) : current === 'team' ? (
                <Team
                  data={data}
                  frozen={status === 'suspended' || unpaidPartner(data)}
                  toast={text => toaster.show(text)}
                />
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
      {/* A team member who joined with an email code has no name yet: asked here, never in a client workspace. The
          partner area is never open while a server admin is signed in as someone (no `partner` permission then). */}
      <AskName impersonating={false} />
    </div>
  )
}

/**
 * White-label Cloud waits for its Checkout (the Clients section's own card, never a banner over every section): its
 * real price a month (the partner bill's), billed yearly or monthly, and Activate; until then up to
 * UNPAID_PARTNER_CLIENTS client workspaces are drafts. Someone else on the team reads that the owner activates it.
 * `primary`: the page's one main action once there is a client to activate it for (else New client is).
 */
function ActivateCard({ data, primary }: { data: PartnerData; primary: boolean }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const bill = data.bill!
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
    <Card title={t('team.partner.bill.activateTitle')}>
      {/* The button under the words, not in the card's head: on a phone the head has no room for both. */}
      <div className="pa-activate">
        <div className="pa-activate-text">
          <PartnerPrice price={bill.price} />
          <p className="pa-fine">
            {t('team.partner.bill.draftsNote', { limit: UNPAID_PARTNER_CLIENTS })}
            {failed && <span className="help"> {t('auth.checkout.startFailed')}</span>}
          </p>
        </div>
        <Button size="sm" variant={primary ? 'primary' : 'secondary'} busy={busy} onClick={() => void start()}>
          {t('team.partner.bill.activateButton')}
        </Button>
      </div>
    </Card>
  )
}

/** After a change: the partner as the server has it now, and the person's workspace list (a new client). */
const reloadPartner = async (id: string) => {
  const [partner, clients] = await Promise.all([loadPartner(id), loadClients(id)])
  setQueryData(PARTNER_QUERY(id), partner)
  setQueryData(PARTNER_CLIENTS_QUERY(id), clients)
}
/** After a change to one client's limit or switches: the client list as the server has it now. */
const reloadClients = async (id: string) => setQueryData(PARTNER_CLIENTS_QUERY(id), await loadClients(id))

/** Partner › Clients: the list (or its empty state with one action), Activate before payment, New client. */
export function Clients({
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
  const [creating, setCreating] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [inviting, setInviting] = useState<PartnerClient | null>(null)
  const [releasing, setReleasing] = useState<PartnerClient | null>(null)
  const [deleting, setDeleting] = useState<PartnerClient | null>(null)
  const [settings, setSettings] = useState<PartnerClientRow | null>(null)

  /** Opens a client workspace like the workspace menu does; `hash`: the page in it (the inbox by default). */
  function open(id: string, hash?: string) {
    setOpening(id)
    setProblem(null)
    switchToWorkspace(id, hash).catch(err => {
      setOpening(null)
      setProblem(partnerErrorText(err))
    })
  }

  const room = roomForClient(data)
  const empty = data.clients.length === 0
  // Why New client cannot be used now, said next to it (never a disabled button alone): the drafts before activating
  // are used up; otherwise the note above the sections (suspended, plan not running) or, without billing, approval.
  const blocked = frozen
    ? !data.bill && data.partner.status === 'pending'
      ? t('team.partner.pending')
      : null
    : room
      ? null
      : t('team.partner.clients.draftLimit', { limit: UNPAID_PARTNER_CLIENTS })
  const activating = !!data.bill && unpaidPartner(data) && data.partner.status !== 'suspended'
  const newClient = (
    <Button
      size="sm"
      variant={activating && !empty ? 'secondary' : 'primary'}
      icon="plus"
      disabled={frozen || !room}
      title={t('team.partner.clients.newTip')}
      onClick={() => setCreating(true)}
    >
      {t('team.partner.clients.new')}
    </Button>
  )
  return (
    <>
      {activating && <ActivateCard data={data} primary={!empty} />}
      <Card title={t('team.partner.clients.title')} actions={empty ? undefined : newClient}>
        {problem && (
          <Note tone="danger" role="alert">
            {problem}
          </Note>
        )}
        {blocked && <p className="pa-fine">{blocked}</p>}
        {empty ? (
          // The first run's one action: a client workspace (a draft before White-label Cloud is active).
          <div className="empty pa-empty">
            <span className="ob-badge" aria-hidden="true">
              <Icon name="users" size={20} />
            </span>
            <b>{t('team.partner.clients.emptyTitle')}</b>
            <span>{t(unpaidPartner(data) ? 'team.partner.clients.emptyDraft' : 'team.partner.clients.emptyText')}</span>
            {newClient}
          </div>
        ) : (
          <ClientList
            data={data}
            frozen={frozen}
            invitesWait={unpaidPartner(data)}
            opening={opening}
            onOpen={open}
            onInvite={setInviting}
            onRelease={setReleasing}
            onDelete={setDeleting}
            onSettings={setSettings}
          />
        )}
      </Card>
      {creating && (
        <NewClientDialog
          data={data}
          onFirstWorkspace={onFirstWorkspace}
          onOpen={(id, hash) => open(id, hash)}
          onInvite={client => {
            setCreating(false)
            setInviting(client)
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {inviting && (
        <InviteOwnerDialog
          partnerId={data.partner.id}
          client={inviting}
          onClose={() => setInviting(null)}
          onSent={email => toast(t('team.partner.clients.ownerInviteSent', { email, name: inviting.name }))}
        />
      )}
      {releasing && <ReleaseDialog partnerId={data.partner.id} client={releasing} onClose={() => setReleasing(null)} />}
      {deleting && (
        <DeleteClientDialog
          partnerId={data.partner.id}
          client={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => toast(t('team.partner.delete.done', { name: deleting.name }))}
        />
      )}
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

/**
 * New client: the business's name and, for the partner's owner, its owner's email; then the next step for the new
 * workspace (open it to get its number, or invite its owner) in the same dialog. Country and time zone start as this
 * browser's, as for a workspace of one's own.
 */
export function NewClientDialog({
  data,
  onFirstWorkspace,
  onOpen,
  onInvite,
  onClose,
  onMade,
  returnHash = '#partner',
}: {
  data: PartnerData
  onFirstWorkspace?: () => void
  onOpen: (id: string, hash?: string) => void
  onInvite: (client: PartnerClient) => void
  onClose: () => void
  /**
   * The partner's agent setup page (AgentSetup, scope "partner"): the new workspace goes straight back to the page,
   * which sets it up next, instead of the dialog's next steps.
   */
  onMade?: (workspace: { id: string; name: string }) => void
  /** Where the page stays while the session loads again after the first client workspace. */
  returnHash?: string
}) {
  const t = useT()
  // Before White-label Cloud is paid a client workspace is a draft: its owner's invitation waits (unpaidPartner).
  const unpaid = unpaidPartner(data)
  const owner = data.role === 'owner' && !unpaid
  // Where the business is: this browser's country and time zone until picked, as for a workspace of one's own.
  const hint = useCountryHint()
  const [picked, setPicked] = useState<string | null>(null)
  const country = picked ?? hint?.country ?? ''
  const [timeZone, setTimeZone] = useState(() => browserTimeZone() ?? '')
  const [name, setName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [made, setMade] = useState<{ id: string; name: string; ownerInvited: string | null } | null>(null)
  // One key per client asked for: a retry after no answer (a timeout, a dropped connection) gets the client made the
  // first time back, never a second one (security review of #1113, L-3).
  const [keys] = useState(() => purchaseKeys())

  async function create() {
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const email = ownerEmail.trim()
      const input = {
        partnerId: data.partner.id,
        name: name.trim(),
        ...(owner && email ? { ownerEmail: email } : {}),
        ...(country ? { country } : {}),
        ...(timeZone ? { timeZone } : {}),
      }
      const res = await callAction<{ workspace: { id: string; name: string } }>('workspace.createForClient', input, {
        idempotencyKey: keys.keyFor(JSON.stringify(input)),
      })
      keys.settle()
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
        window.location.hash = returnHash
        onFirstWorkspace()
        return
      }
      await Promise.all([reloadPartner(data.partner.id), refreshWorkspaces()])
      if (onMade) return onMade(res.workspace)
      setMade({ ...res.workspace, ownerInvited: owner && email ? email : null })
    } catch (err) {
      keys.settle(err)
      setProblem(partnerErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (made) {
    const client = data.clients.find(c => c.id === made.id) ?? {
      id: made.id,
      name: made.name,
      createdAt: new Date().toISOString(),
      owner: null,
      otherMembers: [],
      invitedByTeam: [],
    }
    return (
      <Dialog
        // A dialog of its own (not the form's, updated): it takes the focus as it opens, so Esc closes it.
        key="made"
        title={t('team.partner.clients.madeTitle', { name: made.name })}
        description={
          made.ownerInvited
            ? t('team.partner.clients.madeInvited', { email: made.ownerInvited })
            : unpaid
              ? t('team.partner.clients.madeDraft')
              : t('team.partner.clients.madeNext')
        }
        size="sm"
        onClose={onClose}
        footer={
          <>
            {owner && !made.ownerInvited ? (
              <Button variant="ghost" onClick={() => onInvite(client)}>
                {t('team.partner.clients.inviteOwner')}
              </Button>
            ) : (
              <Button variant="ghost" onClick={onClose}>
                {t('common.action.close')}
              </Button>
            )}
            {unpaid ? (
              <Button variant="primary" onClick={() => onOpen(made.id)}>
                {t('team.partner.clients.openDraft')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => onOpen(made.id, '#workspace/phone')}>
                {t('team.partner.clients.setUpNumber')}
              </Button>
            )}
          </>
        }
      />
    )
  }

  return (
    <Dialog
      title={t('team.partner.clients.newTitle')}
      description={unpaid ? t('team.partner.clients.newDraftDescription') : t('team.partner.clients.newDescription')}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        void create()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
            {t('team.partner.clients.create')}
          </Button>
        </>
      }
    >
      <FormField id="partner-client-name" label={t('team.partner.clients.name')} error={problem}>
        <Input id="partner-client-name" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
      </FormField>
      <div className="pc-place">
        <FormField id="partner-client-country" label={t('settings.general.country.label')}>
          <CountrySelect id="partner-client-country" value={country} onChange={setPicked} disabled={busy} />
        </FormField>
        <FormField id="partner-client-zone" label={t('team.partner.clients.timeZone')}>
          <TimeZonePicker id="partner-client-zone" value={timeZone} onChange={setTimeZone} disabled={busy} />
        </FormField>
      </div>
      {owner && (
        <FormField
          id="partner-client-owner"
          label={t('team.partner.clients.ownerEmail')}
          help={t('team.partner.clients.ownerEmailHelp')}
        >
          <Input
            id="partner-client-owner"
            type="email"
            value={ownerEmail}
            autoComplete="off"
            onChange={e => setOwnerEmail(e.target.value)}
          />
        </FormField>
      )}
    </Dialog>
  )
}

/** Invites the client's own owner by email (the partner's owner; never someone on the partner team). */
function InviteOwnerDialog({
  partnerId,
  client,
  onClose,
  onSent,
}: {
  partnerId: string
  client: PartnerClient
  onClose: () => void
  onSent: (email: string) => void
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
      onSent(email.trim())
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

/**
 * Deletes a client workspace nobody owns yet (`partner.deleteClient`, the partner's owner): all its data, and its seat
 * leaves the partner plan. The workspace's name is typed to confirm.
 */
function DeleteClientDialog({
  partnerId,
  client,
  onClose,
  onDeleted,
}: {
  partnerId: string
  client: PartnerClient
  onClose: () => void
  onDeleted: () => void
}) {
  const t = useT()
  return (
    <DangerConfirmDialog
      confirm={{
        text: t('team.partner.delete.text', { name: client.name }),
        after: t('team.partner.delete.after'),
        list: [
          t('team.partner.delete.data'),
          ...(client.owner && 'invited' in client.owner
            ? [t('team.partner.delete.invitation', { email: client.owner.invited })]
            : []),
          ...(client.otherMembers.length ? [t('team.partner.delete.people')] : []),
          t('team.partner.delete.bill'),
        ],
        action: t('team.partner.delete.confirm'),
        busyAction: t('team.partner.delete.busy'),
        typed: client.name,
        variant: 'danger',
      }}
      run={async () => {
        try {
          await callAction('partner.deleteClient', { partnerId, workspaceId: client.id, confirmName: client.name })
        } catch (err) {
          throw new Error(partnerErrorText(err))
        }
        await Promise.all([reloadPartner(partnerId), refreshWorkspaces()])
        onDeleted()
        onClose()
      }}
      onClose={onClose}
    />
  )
}

/**
 * Partner › Team: the people who manage the client workspaces, as a list like Workspace settings › Team, and for the
 * owner the open invitations and an Invite line at the end. Results are toasts; a refused invitation is said under
 * the address.
 */
function Team({ data, frozen, toast }: { data: PartnerData; frozen: boolean; toast: (text: string) => void }) {
  const t = useT()
  const owner = data.role === 'owner'
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const partnerId = data.partner.id

  async function run(key: string, name: string, input: object, message: string) {
    setBusy(key)
    setProblem(null)
    try {
      await callAction(name, { partnerId, ...input })
      await reloadPartner(partnerId)
      toast(message)
      return true
    } catch (err) {
      if (key === 'invite') setProblem(partnerErrorText(err))
      else toast(partnerErrorText(err))
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
    <Card title={t('team.partner.team.title')} description={t('team.partner.team.description')}>
      <List label={t('team.partner.team.title')}>
        {data.members.map(m => (
          <ListRow
            key={m.userId}
            lead={<Avatar name={m.name || m.email} size={24} />}
            title={m.name || m.email}
            sub={m.email}
            aside={m.role === 'owner' ? t('team.partner.role.owner') : t('team.partner.role.admin')}
            actions={
              owner &&
              (m.role !== 'owner' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  busy={busy === m.userId}
                  disabled={frozen || !!busy}
                  aria-label={t('team.partner.team.removeTip', { name: m.name || m.email })}
                  title={t('team.partner.team.removeTip', { name: m.name || m.email })}
                  onClick={() =>
                    void run(
                      m.userId,
                      'partnerMember.remove',
                      { userId: m.userId },
                      t('team.partner.team.removed', { name: m.name || m.email }),
                    )
                  }
                />
              ) : (
                <span className="pt-rm-space" />
              ))
            }
          />
        ))}
        {data.invitations.map(i => (
          <ListRow
            key={i.id}
            lead={<Avatar name={i.email} size={24} />}
            title={
              <>
                <span className="k-row-text">{i.email}</span>
                <Badge>{i.expired ? t('team.invitation.expired') : t('team.invitation.invited')}</Badge>
              </>
            }
            sub={
              i.expired
                ? t('team.partner.team.inviteExpired')
                : t('team.partner.team.invitedUntil', { day: day(i.expiresAt) })
            }
            aside={i.role === 'owner' ? t('team.partner.role.owner') : t('team.partner.role.admin')}
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                busy={busy === i.id}
                disabled={frozen || !!busy}
                aria-label={t('team.partner.team.withdrawTip', { email: i.email })}
                title={t('team.partner.team.withdrawTip', { email: i.email })}
                onClick={() =>
                  void run(
                    i.id,
                    'partnerMember.revokeInvite',
                    { invitationId: i.id },
                    t('team.partner.team.withdrawn', { email: i.email }),
                  )
                }
              />
            }
          />
        ))}
      </List>
      {owner && (
        <form className="pt-invite" onSubmit={e => void invite(e)}>
          <FormField
            id="partner-invite-email"
            label={t('team.partner.team.inviteTitle')}
            help={
              unpaidPartner(data)
                ? t('team.partner.team.inviteAfterActivate')
                : t('team.partner.team.inviteDescription')
            }
            error={problem}
          >
            <Input
              id="partner-invite-email"
              type="email"
              value={email}
              placeholder={t('team.invite.placeholder')}
              disabled={frozen}
              autoComplete="off"
              onChange={e => setEmail(e.target.value)}
            />
          </FormField>
          <Button type="submit" variant="primary" busy={busy === 'invite'} disabled={frozen || !email.trim()}>
            {t('team.partner.team.invite')}
          </Button>
        </form>
      )}
    </Card>
  )
}
