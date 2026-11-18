// A white-label partner owner's setup by hand (#partner/setup, 2026-11-18), the fallback to the agent page
// (#partner/agent, agent-first): one flow of full-screen steps, as a Cloud sign-up's onboarding (onboarding/Frame.tsx).
// 1) Your agency: the name, logo and color the clients see, with a live preview. 2) Clients: none to
// UNPAID_PARTNER_CLIENTS drafts, each set up with the agent (the default) or by hand in its own workspace; both lead
// back here. 3) Activate White-label Cloud, the end of the setup: the drafts (each can be removed), the real total and
// Stripe Checkout. The agent page's Activate row and the partner area's Activate line open this same step (Janik,
// 2026-11-18: one Activate screen). Approval never stops anything here: it only gates the brand in emails, said
// quietly on the brand step. The top bar and the footer are the setup pages' own (SetupTopBar, SetupFoot).
import type { MyPartner, PartnerBrandData, PartnerClient, PartnerData } from '@linedesk/actions'
import { UNPAID_PARTNER_CLIENTS } from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { ColorField, nameProblem, parsedColor } from '../admin/Branding.tsx'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { goToCheckout } from '../checkout.ts'
import { useStepKeys } from '../onboarding/Frame.tsx'
import { SetupFoot } from '../onboarding/SetupFoot.tsx'
import { SetupTopBar } from '../onboarding/SetupTopBar.tsx'
import {
  PARTNER_AGENT_HASH,
  openPartnerActivate,
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
import { List, ListRow } from '../ui/list.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { PriceLine, usePrice } from '../ui/price.tsx'
import { NewClientDialog, roomForClient, unpaidPartner } from './PartnerArea.tsx'
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
 * What Activate costs with these drafts (ui/price.tsx): the price a month first ("$14 a month + $9 a month × 2 client
 * workspaces"), and what Checkout charges right after as the grey note ("$384 billed yearly, charged today").
 */
export function PartnerTotal({
  price,
  clients,
}: {
  price: { interval: 'month' | 'year'; planCents: number; seatCents: number }
  clients: number
}) {
  const t = useT()
  const { money } = usePrice()
  const total = money(partnerChargeCents(price, clients))
  return (
    <PriceLine
      note={t(
        price.interval === 'year'
          ? 'team.partner.setup.activate.chargedYearly'
          : 'team.partner.setup.activate.chargedMonthly',
        { total },
      )}
    >
      {t('team.partner.setup.activate.price', {
        price: money(price.planCents),
        seat: money(price.seatCents),
        count: clients,
      })}
    </PriceLine>
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
const withAgent = (partnerId: string) => {
  rememberPartnerByHand(partnerId, false)
  window.location.hash = PARTNER_AGENT_HASH
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
    <div
      className="ob k-install-brand"
      role="main"
      aria-label={t('team.partner.setup.title', { partner: partner.name })}
    >
      <SetupTopBar
        step={{ n: index + 1, m: steps.length, name: label }}
        // Activate is the end of the setup: no way off to the agent there, only Back (Janik, 2026-11-18).
        agentPath={step === 'activate' ? undefined : () => withAgent(partner.id)}
        exit={{ kind: 'finish-later', onExit: finishLater, title: t('team.partner.setup.finishLaterTitle') }}
        brand="install"
        away
      />
      <div className="ob-main">
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
      </div>
    </div>
  )
}

/** Step 1: the name, logo and color the clients see, next to how their sign-in page and an email look with them. */
function AgencyStep({
  data,
  brand,
  onSaved,
  onNext,
}: {
  data: PartnerData
  brand: PartnerBrandData
  onSaved: (data: PartnerBrandData) => void
  onNext: () => void
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
  useStepKeys({ onEnter: () => void next() })

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
      <SetupFoot onContinue={() => void next()} canContinue={!invalid} busy={busy} />
    </>
  )
}

/**
 * Step 2: the client workspaces, none to UNPAID_PARTNER_CLIENTS drafts before White-label Cloud runs. Each row is set
 * up with the agent (the default: the agent page with that client picked) or by hand (its own onboarding, which comes
 * back here at its end). Add client is the partner area's New client dialog; none is fine ("Skip, add clients later").
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
  const [adding, setAdding] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  /** Sets a client up: on the agent page with it picked, or in its own workspace's onboarding by hand. */
  async function setUp(client: PartnerClient, way: 'agent' | 'hand') {
    if (opening) return
    setOpening(`${way}:${client.id}`)
    setProblem(null)
    rememberPartnerByHand(data.partner.id, way === 'hand')
    try {
      // By hand: the client workspace opens on its onboarding (it ends back on this step, Onboarding.tsx).
      await switchToWorkspace(client.id, way === 'agent' ? PARTNER_AGENT_HASH : undefined)
    } catch (err) {
      setProblem(partnerErrorText(err))
      setOpening(null)
    }
  }
  useStepKeys(adding ? {} : { onEnter: onNext, onEscape: onBack })

  const addClient = (
    <Button
      size="sm"
      variant={clients.length ? 'ghost' : 'secondary'}
      icon="plus"
      disabled={!room}
      title={room ? undefined : t('team.partner.clients.setupLimit', { limit: UNPAID_PARTNER_CLIENTS })}
      onClick={() => setAdding(true)}
    >
      {t('team.partner.setup.clients.add')}
    </Button>
  )
  return (
    <>
      <div className="ob-body">
        <h1>{t('team.partner.setup.clients.title')}</h1>
        <p className="ob-lede">
          {unpaid
            ? t('team.partner.clients.setupLimit', { limit: UNPAID_PARTNER_CLIENTS })
            : t('team.partner.setup.clients.lede')}
        </p>
        {clients.length > 0 && (
          <List label={t('team.partner.setup.clients.title')} className="ps-clients">
            {clients.map(c => (
              <ListRow
                key={c.id}
                title={c.name}
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={opening === `hand:${c.id}`}
                      disabled={!!opening}
                      onClick={() => void setUp(c, 'hand')}
                    >
                      {t('team.partner.setup.clients.byHand')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      busy={opening === `agent:${c.id}`}
                      disabled={!!opening}
                      onClick={() => void setUp(c, 'agent')}
                    >
                      {t('team.partner.setup.clients.withAgent')}
                    </Button>
                  </>
                }
              />
            ))}
          </List>
        )}
        {/* At the cap the line above says why Add client is greyed: it is only a limit for the setup. */}
        <div className="ps-add">{addClient}</div>
        {problem && <FormMessage>{problem}</FormMessage>}
      </div>
      <SetupFoot
        onBack={onBack}
        onContinue={onNext}
        variant={clients.length ? 'primary' : 'secondary'}
        label={clients.length ? (last ? t('onboarding.frame.done') : undefined) : t('team.partner.setup.clients.skip')}
      />
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
  useStepKeys(removing ? {} : { onEnter: () => void activate(), onEscape: onBack })

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
        <div className="ob-activate-plan">
          <PartnerTotal price={data.bill!.price} clients={clients.length} />
        </div>
        {problem && <FormMessage>{problem}</FormMessage>}
      </div>
      <SetupFoot
        onBack={onBack}
        onContinue={() => void activate()}
        busy={busy}
        label={t('team.partner.bill.activateButton')}
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
