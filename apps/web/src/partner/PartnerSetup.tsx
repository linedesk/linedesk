// A white-label partner owner's setup by hand (#partner/setup, 2026-11-18), the fallback to the agent page
// (#partner/agent, agent-first): one flow of full-screen steps, as a Cloud sign-up's onboarding (onboarding/Frame.tsx).
// 1) Your brand: the name, logo and color the clients see, with a live preview. 2) Clients: none to
// UNPAID_PARTNER_CLIENTS drafts, each set up with the agent (the default) or by hand in its own workspace; both lead
// back here. 3) Activate White-label Cloud, the end of the setup: the drafts (each can be removed), the real total and
// Stripe Checkout. The agent page's Activate row and the partner area's Activate line open this same step (one
// Activate screen). Approval never stops anything here: it only gates the brand in emails, said
// quietly on the brand step. The top bar and the footer are the setup pages' own (SetupTopBar, SetupFoot).
import type { MyPartner, PartnerBrandData, PartnerClient, PartnerData } from '@linedesk/actions'
import { UNPAID_PARTNER_CLIENTS } from '@linedesk/actions'
import type { PlanPrices } from '@linedesk/db/types'
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { ColorField, nameProblem, parsedColor } from '../admin/Branding.tsx'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { goToCheckout } from '../checkout.ts'

import { rememberDraftOpenedFrom } from '../onboarding/flow.ts'
import { SetupFoot } from '../onboarding/SetupFoot.tsx'
import { SetupPage, SetupTopBar } from '../onboarding/SetupTopBar.tsx'
import {
  backToPartnerAgent,
  openPartnerActivate,
  PARTNER_AGENT_HASH,
  PARTNER_SETUP_HASH,
  partnerActivateBack,
  rememberPartnerByHand,
} from '../onboarding/setup-choice.ts'
import { callAction } from '../settings/settings-api.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { refreshWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { tabWorkspace } from '../tabWorkspace.ts'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { List, ListRow } from '../ui/list.tsx'
import { PlanCard, usePlanPrice } from '../ui/PlanCard.tsx'
import { PriceLine, usePrice } from '../ui/price.tsx'
import { InviteOwnerDialog, NewClientDialog, roomForClient, unpaidPartner } from './PartnerArea.tsx'
import {
  BRAND_QUERY,
  brandErrorText,
  type Draft,
  draftOf,
  EmailSample,
  inputOf,
  LogoField,
  loadBrand,
  SignInSample,
} from './PartnerBrand.tsx'
import { loadClients, loadPartner, PARTNER_CLIENTS_QUERY, PARTNER_QUERY, partnerErrorText } from './partner-api.ts'
import '../admin/admin.css'
import '../onboarding/onboarding.css'
import './partner-brand.css'
import './partner-setup.css'
import { useSetupKeys } from '../onboarding/setup-keys.ts'

export type PartnerSetupStep = 'agency' | 'clients' | 'activate'

/** The steps this partner goes through: Activate only while White-label Cloud waits for its owner's Checkout. */
export function partnerSetupSteps(data: Pick<PartnerData, 'bill'>): PartnerSetupStep[] {
  return data.bill?.status === 'pending_payment' && data.bill.mine
    ? ['agency', 'clients', 'activate']
    : ['agency', 'clients']
}

/**
 * Where the setup opens: the step the hash names (`#partner/setup/<step>`), else the brand until it is saved, then
 * the clients. Activate is only ever opened on purpose (its own address, from the clients step, the agent page or the
 * partner area).
 */
export function partnerSetupStart(
  hash: string,
  steps: readonly PartnerSetupStep[],
  done: { brand: boolean },
): PartnerSetupStep {
  const named = hash.slice(PARTNER_SETUP_HASH.length + 1) as PartnerSetupStep
  if (hash.startsWith(`${PARTNER_SETUP_HASH}/`) && steps.includes(named)) return named
  return done.brand ? 'clients' : 'agency'
}

/**
 * White-label Cloud's price as the partner bill has it (`planCents` and `seatCents` a month): the base fee and each
 * client workspace a month, and on the yearly plan their totals a year in the grey note under it (ui/price.tsx).
 * The partner area's Activate card shows it so.
 */
export function PartnerPrice({
  price,
}: {
  price: { interval: 'month' | 'year'; planCents: number; seatCents: number }
}) {
  const t = useT()
  const { money } = usePrice()
  const note =
    price.interval === 'year'
      ? t('team.partner.bill.yearNote', { price: money(price.planCents * 12), seat: money(price.seatCents * 12) })
      : null
  return (
    <PriceLine note={note}>
      {t('team.partner.bill.price', { price: money(price.planCents), seat: money(price.seatCents) })}
    </PriceLine>
  )
}

/**
 * What Activate costs with these drafts, in the shared plan card (ui/PlanCard.tsx): the price a month first ("$14 a
 * month", "+ $9 a month × 2 client workspaces" next to it), what Checkout charges right after as the grey note ("$384
 * billed yearly, charged today"), what each client workspace includes, the tax line and "See all details". No trial
 * for a partner, so the price leads.
 */
export function PartnerTotal({
  price,
  prices,
  clients,
}: {
  price: { interval: 'month' | 'year'; planCents: number; seatCents: number }
  prices: PlanPrices | null | undefined
  clients: number
}) {
  const t = useT()
  const { money } = usePrice()
  const planPrice = usePlanPrice()
  const total = money(partnerChargeCents(price, clients))
  return (
    <PlanCard
      price={planPrice(money(price.planCents))}
      unit={t('common.plan.clientSeats', { seat: money(price.seatCents), count: clients })}
      note={t(
        price.interval === 'year'
          ? 'team.partner.setup.activate.chargedYearly'
          : 'team.partner.setup.activate.chargedMonthly',
        { total },
      )}
      prices={prices}
      each="client"
    />
  )
}

/** What the first year (or month) of White-label Cloud costs with this many client workspaces, in cents. */
export function partnerChargeCents(price: { interval: string; planCents: number; seatCents: number }, clients: number) {
  return (price.planCents + price.seatCents * clients) * (price.interval === 'year' ? 12 : 1)
}

/** The client workspaces in the order they were made. */
const inOrder = (clients: readonly PartnerClient[]) =>
  [...clients].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

const goTo = (step: PartnerSetupStep) => {
  window.location.hash = `${PARTNER_SETUP_HASH}/${step}`
}
const finishLater = () => {
  window.location.hash = '#partner'
}

export function PartnerSetup({
  partner,
  onFirstWorkspace,
}: {
  partner: MyPartner
  /** The first client workspace was made while in no workspace: the session loads again (NoWorkspace). */
  onFirstWorkspace?: () => void
}) {
  const t = useT()
  const query = useQuery(PARTNER_QUERY(partner.id), () => loadPartner(partner.id))
  const brand = useQuery(BRAND_QUERY(partner.id), () => loadBrand(partner.id))
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const follow = () => setHash(window.location.hash)
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  const data = query.data
  const steps = data ? partnerSetupSteps(data) : (['agency', 'clients', 'activate'] as const)
  const step = data && brand.data ? partnerSetupStart(hash, steps, { brand: !!brand.data.brand }) : 'agency'
  const index = steps.indexOf(step)

  // i18n-dynamic: team.partner.setup.step.*
  const label = t(`team.partner.setup.step.${step}` as MessageKey)
  return (
    // A partner's own setup: the install's brand, never its white-label one (brand.ts), even with a client workspace open.
    <SetupPage
      className="k-install-brand"
      label={t('team.partner.setup.title', { partner: partner.name })}
      bar={
        <SetupTopBar
          step={{ n: index + 1, m: steps.length, name: label }}
          // Activate is the end of the setup: no way off to the agent there, only Back.
          agentPath={step === 'activate' ? undefined : () => backToPartnerAgent(partner.id)}
          exit={{ kind: 'finish-later', onExit: finishLater, title: t('team.partner.setup.finishLaterTitle') }}
          brand="install"
          away
        />
      }
    >
      {!data || !brand.data ? (
        <Loading
          what={t('team.partner.page')}
          loading
          error={query.error ?? brand.error}
          onRetry={() => {
            void query.reload()
            void brand.reload()
          }}
          skeleton={<SkeletonFields fields={3} />}
        />
      ) : step === 'agency' ? (
        <AgencyStep
          data={data}
          brand={brand.data}
          onSaved={next => setQueryData(BRAND_QUERY(partner.id), next)}
          onNext={() => goTo('clients')}
          onAgentSetup={() => backToPartnerAgent(partner.id)}
        />
      ) : step === 'clients' ? (
        <ClientsStep
          data={data}
          last={!steps.includes('activate')}
          onFirstWorkspace={onFirstWorkspace}
          onBack={() => goTo('agency')}
          onNext={() => {
            // Activate's Back from here leads to this step again.
            if (steps.includes('activate')) openPartnerActivate(null)
            else finishLater()
          }}
        />
      ) : (
        <ActivateStep
          data={data}
          onBack={() => {
            window.location.hash = partnerActivateBack()
          }}
        />
      )}
    </SetupPage>
  )
}

/** Step 1: the name, logo and color the clients see, next to how their sign-in page and an email look with them. */
function AgencyStep({
  data,
  brand,
  onSaved,
  onNext,
  onAgentSetup,
}: {
  data: PartnerData
  brand: PartnerBrandData
  onSaved: (data: PartnerBrandData) => void
  onNext: () => void
  /** The first step: its back slot leads to the partner's AI agent setup, as on every setup's first page. */
  onAgentSetup: () => void
}) {
  const t = useT()
  const saved = draftOf(brand, data.partner.name)
  const [draft, setDraft] = useState<Draft>(saved)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const update = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }))
  const nameKey = nameProblem(draft.name)
  const invalid = !!nameKey || parsedColor(draft.color) === undefined
  const logo = draft.logo === undefined ? (brand.brand?.logoUrl ?? null) : draft.logo
  const dirty = !brand.brand || JSON.stringify(draft) !== JSON.stringify(saved)

  async function next() {
    if (busy || invalid) return
    if (!dirty || !brand.canEdit) return onNext()
    setBusy(true)
    setProblem(null)
    try {
      onSaved(await callAction<PartnerBrandData>('partnerBrand.set', inputOf(data.partner.id, draft)))
      onNext()
    } catch (err) {
      setProblem(brandErrorText(err, t))
      setBusy(false)
    }
  }
  useSetupKeys({ onEnter: () => void next() })

  return (
    <>
      <div className="ob-body">
        <h1>{t('team.partner.setup.agency.title')}</h1>
        <p className="ob-lede">{t('team.partner.setup.agency.lede')}</p>
        <div className="ps-brand">
          <fieldset className="pb-fields" disabled={!brand.canEdit || busy}>
            <FormField id="ps-name" label={t('admin.branding.name')} error={nameKey && t(nameKey)}>
              <Input
                id="ps-name"
                value={draft.name}
                maxLength={40}
                invalid={!!nameKey}
                autoFocus
                onChange={e => update({ name: e.target.value })}
              />
            </FormField>
            <LogoField
              logo={logo}
              hasSaved={!!brand.brand?.logoUrl}
              readOnly={!brand.canEdit}
              onChange={next => update({ logo: next })}
            />
            <ColorField text={draft.color} onChange={color => update({ color })} />
          </fieldset>
          <section className="ps-preview" aria-label={t('admin.branding.preview')}>
            <SignInSample draft={draft} logo={logo} />
            <EmailSample draft={draft} logo={logo} />
          </section>
        </div>
        {data.partner.status === 'pending' && <p className="ob2-note">{t('team.partner.approvalPending')}</p>}
        {problem && <FormMessage>{problem}</FormMessage>}
      </div>
      <SetupFoot onContinue={() => void next()} canContinue={!invalid} busy={busy} agentBack={onAgentSetup} />
    </>
  )
}

/**
 * Step 2: the client workspaces, none to UNPAID_PARTNER_CLIENTS drafts before White-label Cloud runs. Before its
 * Checkout each row is set up with the agent (the default: the agent page with that client picked) or by hand (its own
 * onboarding, which comes back here at its end). Once it runs, what a client still needs comes next on its row: its
 * number, then its owner's invitation. Add client is the partner area's New client dialog, the one draft-limit sentence
 * as a fine note under it. None yet: Add client is the step's own action and "Later" the quiet way on.
 */
export function ClientsStep({
  data,
  last,
  onFirstWorkspace,
  onBack,
  onNext,
}: {
  data: PartnerData
  /** No Activate step after this one (White-label Cloud runs): Continue ends the setup. */
  last: boolean
  onFirstWorkspace?: () => void
  onBack: () => void
  onNext: () => void
}) {
  const t = useT()
  const unpaid = unpaidPartner(data)
  const clients = inOrder(data.clients)
  const room = roomForClient(data)
  // Once White-label Cloud runs: each client's number from the client list (the partner area's), to say what is next.
  const rows = useQuery(!unpaid && clients.length > 0 ? PARTNER_CLIENTS_QUERY(data.partner.id) : null, () =>
    loadClients(data.partner.id),
  )
  const [adding, setAdding] = useState(false)
  const [inviting, setInviting] = useState<PartnerClient | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  /**
   * Opens a client: on the agent page with it picked, in its own workspace's onboarding by hand, or on its phone page
   * for its number.
   */
  async function open(client: PartnerClient, way: 'agent' | 'hand' | 'number') {
    if (opening) return
    setOpening(`${way}:${client.id}`)
    setProblem(null)
    if (way !== 'number') rememberPartnerByHand(data.partner.id, way === 'hand')
    // Its setup ends back on this step (onboarding/flow.ts).
    rememberDraftOpenedFrom(client.id, location.hash)
    try {
      // By hand: the client workspace opens on its onboarding (it ends back on this step, Onboarding.tsx).
      await switchToWorkspace(
        client.id,
        way === 'agent' ? PARTNER_AGENT_HASH : way === 'number' ? '#workspace/phone' : undefined,
      )
    } catch (err) {
      setProblem(partnerErrorText(err))
      setOpening(null)
    }
  }
  const empty = clients.length === 0
  useSetupKeys(adding || inviting ? {} : { onEnter: empty ? () => setAdding(true) : onNext, onEscape: onBack })

  const actionsFor = (c: PartnerClient) => {
    const button = (way: 'agent' | 'hand' | 'number', variant: 'ghost' | 'secondary', label: string) => (
      <Button
        size="sm"
        variant={variant}
        busy={opening === `${way}:${c.id}`}
        disabled={!!opening}
        onClick={() => void open(c, way)}
      >
        {label}
      </Button>
    )
    if (unpaid)
      return (
        <>
          {button('hand', 'ghost', t('team.partner.setup.clients.byHand'))}
          {button('agent', 'secondary', t('team.partner.setup.clients.withAgent'))}
        </>
      )
    const row = rows.data?.clients.find(r => r.id === c.id)
    return (
      <>
        {c.owner === null && data.role === 'owner' && (
          <Button size="sm" variant="ghost" disabled={!!opening} onClick={() => setInviting(c)}>
            {t('team.partner.clients.inviteOwner')}
          </Button>
        )}
        {row && !row.number && button('number', 'secondary', t('team.partner.setup.clients.addNumber'))}
      </>
    )
  }
  const subFor = (c: PartnerClient) => {
    if (unpaid) return undefined
    if (c.owner === null) return t('team.partner.clients.noOwner')
    if ('invited' in c.owner) return t('team.partner.clients.ownerInvited', { email: c.owner.invited })
    return t('team.partner.clients.ownerIs', { name: c.owner.name || c.owner.email })
  }

  return (
    <>
      <div className="ob-body">
        <h1>{t('team.partner.setup.clients.title')}</h1>
        <p className="ob-lede">{t('team.partner.setup.clients.lede')}</p>
        {clients.length > 0 && (
          <List label={t('team.partner.setup.clients.title')} className="ps-clients">
            {clients.map(c => (
              <ListRow key={c.id} title={c.name} sub={subFor(c)} actions={actionsFor(c)} />
            ))}
          </List>
        )}
        <div className="ps-add">
          <Button
            size="sm"
            variant={empty ? 'primary' : 'ghost'}
            icon="plus"
            disabled={!room}
            title={room ? undefined : t('team.partner.clients.setupLimit', { limit: UNPAID_PARTNER_CLIENTS })}
            onClick={() => setAdding(true)}
          >
            {t('team.partner.setup.clients.add')}
          </Button>
          {/* Before the Checkout: the one draft-limit sentence, also why Add client is greyed at the cap. */}
          {unpaid && (
            <p className="ps-fine">{t('team.partner.clients.setupLimit', { limit: UNPAID_PARTNER_CLIENTS })}</p>
          )}
        </div>
        {problem && <FormMessage>{problem}</FormMessage>}
      </div>
      {empty ? (
        <SetupFoot onBack={onBack} onSkipStep={onNext} laterTitle={t('team.partner.setup.clients.laterTitle')} />
      ) : (
        <SetupFoot onBack={onBack} onContinue={onNext} label={last ? t('onboarding.frame.done') : undefined} />
      )}
      {adding && (
        <NewClientDialog
          data={data}
          onFirstWorkspace={onFirstWorkspace}
          returnHash={`${PARTNER_SETUP_HASH}/clients`}
          onOpen={() => {}}
          onInvite={() => {}}
          onClose={() => setAdding(false)}
          onMade={() => setAdding(false)}
        />
      )}
      {inviting && (
        <InviteOwnerDialog
          partnerId={data.partner.id}
          client={inviting}
          onClose={() => setInviting(null)}
          onSent={() => {}}
        />
      )}
    </>
  )
}

/**
 * Step 3, the end of the setup: White-label Cloud with the drafts it starts with (each can be removed here), the price
 * a month with what Checkout charges right after as the grey note, and Stripe Checkout. Only Back and Activate: the
 * agent page's Activate row and the partner area's Activate line open this same step.
 */
export function ActivateStep({ data, onBack }: { data: PartnerData; onBack: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PartnerClient | null>(null)
  const clients = inOrder(data.clients)

  async function activate() {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await goToCheckout(data.partner.id)
    } catch {
      setProblem(t('auth.checkout.startFailed'))
      setBusy(false)
    }
  }
  useSetupKeys(removing ? {} : { onEnter: () => void activate(), onEscape: onBack })

  return (
    <>
      <div className="ob-body">
        <h1>{t('team.partner.setup.activate.title')}</h1>
        <p className="ob-lede">{t('team.partner.setup.activate.lede')}</p>
        {clients.length > 0 && (
          <List label={t('team.partner.setup.activate.clients')} className="ps-clients">
            {clients.map(c => (
              <ListRow
                key={c.id}
                title={c.name}
                actions={
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(c)}>
                    {t('team.partner.setup.activate.remove')}
                  </Button>
                }
              />
            ))}
          </List>
        )}
        <PartnerTotal price={data.bill!.price} prices={data.bill!.prices} clients={clients.length} />
        {problem && <FormMessage>{problem}</FormMessage>}
      </div>
      <SetupFoot
        onBack={onBack}
        onContinue={() => void activate()}
        busy={busy}
        label={t('team.partner.bill.activateButton')}
        hint={t('onboarding.activate.cardHint')}
      />
      {removing && <RemoveDraftDialog data={data} client={removing} onClose={() => setRemoving(null)} />}
    </>
  )
}

/**
 * Removes a draft before the Checkout: the partner's owner deletes a client workspace nobody owns yet
 * (`partner.deleteClient`, audited; a draft never has an owner, its invitation waits for the Checkout). A light
 * confirm: a draft holds only what was set up in it.
 */
function RemoveDraftDialog({
  data,
  client,
  onClose,
}: {
  data: PartnerData
  client: PartnerClient
  onClose: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function remove() {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await callAction('partner.deleteClient', {
        partnerId: data.partner.id,
        workspaceId: client.id,
        confirmName: client.name,
      })
    } catch (err) {
      setProblem(partnerErrorText(err))
      setBusy(false)
      return
    }
    // The tab's own workspace went: the page loads again, back on this step, in the partner's next workspace or none.
    if (tabWorkspace() === client.id) return window.location.reload()
    const [partner, clients] = await Promise.all([loadPartner(data.partner.id), loadClients(data.partner.id)])
    setQueryData(PARTNER_QUERY(data.partner.id), partner)
    setQueryData(PARTNER_CLIENTS_QUERY(data.partner.id), clients)
    void refreshWorkspaces()
    onClose()
  }
  return (
    <Dialog
      title={t('team.partner.setup.activate.removeTitle', { name: client.name })}
      description={t('team.partner.setup.activate.removeText')}
      size="sm"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button variant="danger" busy={busy} onClick={() => void remove()}>
            {t('team.partner.setup.activate.remove')}
          </Button>
        </>
      }
    >
      {problem && <FormMessage>{problem}</FormMessage>}
    </Dialog>
  )
}
