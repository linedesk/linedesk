// A white-label partner owner's guided setup by hand (#partner/setup, 2026-11-18): the same full-screen steps as a
// Cloud sign-up's onboarding (onboarding/Frame.tsx), one thing at a time. 1) Your agency: the name, logo and color the
// clients see, with a live preview. 2) The first client: its business name makes a client workspace (a free draft until
// White-label Cloud runs), then the owner picks how to set it up, with the AI agent or by hand. 3) Activate White-label
// Cloud: the real price (the partner bill's) and Stripe Checkout, or set the client up first and activate later.
// Approval never stops anything here: it only gates the brand in emails, said quietly on the brand step.
import type { MyPartner, PartnerBrandData, PartnerClient, PartnerData } from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { ColorField, nameProblem, parsedColor } from '../admin/Branding.tsx'
import { installBrandName } from '../brand.ts'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { goToCheckout } from '../checkout.ts'
import { useCountryHint } from '../countryHint.ts'
import { useUsd } from '../onboarding/ExtraCalls.tsx'
import { Foot, useStepKeys } from '../onboarding/Frame.tsx'
import { PARTNER_AGENT_HASH, PARTNER_SETUP_HASH, rememberPartnerByHand } from '../onboarding/setup-choice.ts'
import { purchaseKeys } from '../settings/billingModel.ts'
import { callAction } from '../settings/settings-api.ts'
import { browserTimeZone } from '../settings/timeZones.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { SetupAccountMenu } from '../shell/SetupAccountMenu.tsx'
import { refreshWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { tabWorkspace } from '../tabWorkspace.ts'
import { FormField, FormMessage, Input } from '../ui/form.tsx'
import { BrandMark, Button, Icon } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { unpaidPartner } from './PartnerArea.tsx'
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

export type PartnerSetupStep = 'agency' | 'client' | 'activate'

/** How the first client is set up: on the AI agent's page, or step by step in its own workspace. */
export type ClientWay = 'agent' | 'hand'

/** The steps this partner goes through: Activate only while White-label Cloud waits for its owner's Checkout. */
export function partnerSetupSteps(data: Pick<PartnerData, 'bill'>): PartnerSetupStep[] {
  return data.bill?.status === 'pending_payment' && data.bill.mine
    ? ['agency', 'client', 'activate']
    : ['agency', 'client']
}

/**
 * Where the setup opens: the step the hash names (`#partner/setup/<step>`), else the first one not done yet. The brand
 * is done once saved, the first client once a client workspace exists.
 */
export function partnerSetupStart(
  hash: string,
  steps: readonly PartnerSetupStep[],
  done: { brand: boolean; clients: number },
): PartnerSetupStep {
  const named = hash.slice(PARTNER_SETUP_HASH.length + 1) as PartnerSetupStep
  if (hash.startsWith(`${PARTNER_SETUP_HASH}/`) && steps.includes(named)) return named
  if (!done.brand) return 'agency'
  if (!done.clients || !steps.includes('activate')) return 'client'
  return 'activate'
}

/** What the first year (or month) of White-label Cloud costs with this many client workspaces, in cents. */
export function partnerChargeCents(price: { interval: string; planCents: number; seatCents: number }, clients: number) {
  return (price.planCents + price.seatCents * clients) * (price.interval === 'year' ? 12 : 1)
}

/** The client this setup is about: the newest client workspace. */
const firstClient = (clients: readonly PartnerClient[]) =>
  [...clients].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null

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
  // How the first client is set up, picked on its step; it decides where Activate and "set it up first" lead.
  const [way, setWay] = useState<ClientWay>('agent')
  const data = query.data
  const steps = data ? partnerSetupSteps(data) : (['agency', 'client', 'activate'] as const)
  const step =
    data && brand.data
      ? partnerSetupStart(hash, steps, { brand: !!brand.data.brand, clients: data.clients.length })
      : 'agency'
  const index = steps.indexOf(step)
  // The bar: the steps before this one are done, and this one counts half once its part is saved.
  const done = index + (step === 'client' && data?.clients.length ? 0.5 : 0)
  const progress = Math.round((done / steps.length) * 100)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !e.shiftKey || e.isComposing) return
      e.preventDefault()
      finishLater()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // i18n-dynamic: team.partner.setup.step.*
  const label = t(`team.partner.setup.step.${step}` as MessageKey)
  return (
    // A partner's own setup: the install's brand, never its white-label one (brand.ts), even with a client workspace open.
    <div
      className="ob k-install-brand"
      role="main"
      aria-label={t('team.partner.setup.title', { partner: partner.name })}
    >
      <div className="ob-top">
        <BrandMark install />
        <b>{installBrandName()}</b>
        <span className="ob-count">
          {t('onboarding.frame.stepCount', { step: index + 1, total: steps.length, label })}
        </span>
        <span className="ob-count-short" aria-hidden="true">
          {t('onboarding.frame.stepShort', { step: index + 1, total: steps.length })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="spark"
          className="ob-agent"
          onClick={() => withAgent(partner.id)}
          aria-label={t('onboarding.frame.agent')}
          title={t('team.partner.setup.agentTitle')}
        >
          {t('onboarding.frame.agent')}
        </Button>
        <Button size="sm" variant="ghost" onClick={finishLater} title={t('team.partner.setup.finishLaterTitle')}>
          {t('onboarding.frame.finishLater')}
        </Button>
        <SetupAccountMenu away />
      </div>
      <div className="ob-bar">
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className={step === 'agency' ? 'ob-main ps-wide' : 'ob-main'}>
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
            onNext={() => goTo('client')}
          />
        ) : step === 'client' ? (
          <ClientStep
            data={data}
            way={way}
            onWay={setWay}
            last={!steps.includes('activate')}
            onFirstWorkspace={onFirstWorkspace}
            onBack={() => goTo('agency')}
            onNext={() => goTo('activate')}
          />
        ) : (
          <ActivateStep
            data={data}
            brandName={brand.data.brand?.name ?? data.partner.name}
            way={way}
            onBack={() => goTo('client')}
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
          <fieldset className="pb-fields ps-fields" disabled={!brand.canEdit || busy}>
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
      <Foot onContinue={() => void next()} canContinue={!invalid} busy={busy} />
    </>
  )
}

/**
 * Step 2: the first client's business name makes its workspace (a draft before White-label Cloud runs), then how it is
 * set up: with the AI agent (its page sets up the partner's clients too) or step by step in the client's workspace.
 */
function ClientStep({
  data,
  way,
  onWay,
  last,
  onFirstWorkspace,
  onBack,
  onNext,
}: {
  data: PartnerData
  way: ClientWay
  onWay: (way: ClientWay) => void
  /** No Activate step after this one (White-label Cloud runs): Continue goes to the way picked. */
  last: boolean
  onFirstWorkspace?: () => void
  onBack: () => void
  onNext: () => void
}) {
  const client = firstClient(data.clients)
  return client ? (
    <ClientWayStep data={data} client={client} way={way} onWay={onWay} last={last} onBack={onBack} onNext={onNext} />
  ) : (
    <NewClientStep data={data} onFirstWorkspace={onFirstWorkspace} onBack={onBack} />
  )
}

function NewClientStep({
  data,
  onFirstWorkspace,
  onBack,
}: {
  data: PartnerData
  onFirstWorkspace?: () => void
  onBack: () => void
}) {
  const t = useT()
  const unpaid = unpaidPartner(data)
  const hint = useCountryHint()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // One key per client asked for: a retry after no answer gets the client made the first time back (as NewClientDialog).
  const [keys] = useState(() => purchaseKeys())

  async function create() {
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const timeZone = browserTimeZone()
      const input = {
        partnerId: data.partner.id,
        name: name.trim(),
        ...(hint?.country ? { country: hint.country } : {}),
        ...(timeZone ? { timeZone } : {}),
      }
      const res = await callAction<{ workspace: { id: string; name: string } }>('workspace.createForClient', input, {
        idempotencyKey: keys.keyFor(JSON.stringify(input)),
      })
      keys.settle()
      const made: PartnerClient = {
        ...res.workspace,
        createdAt: new Date().toISOString(),
        owner: null,
        otherMembers: [],
        invitedByTeam: [],
      }
      setQueryData(PARTNER_QUERY(data.partner.id), { ...data, clients: [...data.clients, made] })
      // In no workspace yet the server now puts the session in the new one: it loads again, and this step stays open
      // on the hash (as NewClientDialog does).
      if (!tabWorkspace() && onFirstWorkspace) {
        window.location.hash = `${PARTNER_SETUP_HASH}/client`
        onFirstWorkspace()
        return
      }
      const [partner, clients] = await Promise.all([loadPartner(data.partner.id), loadClients(data.partner.id)])
      setQueryData(PARTNER_QUERY(data.partner.id), partner)
      setQueryData(PARTNER_CLIENTS_QUERY(data.partner.id), clients)
      void refreshWorkspaces()
    } catch (err) {
      keys.settle(err)
      setProblem(partnerErrorText(err))
      setBusy(false)
    }
  }
  useStepKeys({ onEnter: () => void create(), onEscape: onBack })

  return (
    <>
      <div className="ob-body">
        <h1>{t('team.partner.setup.client.title')}</h1>
        <p className="ob-lede">
          {t(unpaid ? 'team.partner.setup.client.ledeDraft' : 'team.partner.setup.client.lede')}
        </p>
        <FormField id="ps-client" label={t('team.partner.clients.name')} error={problem}>
          <Input
            id="ps-client"
            value={name}
            maxLength={80}
            autoFocus
            placeholder={t('team.partner.setup.client.placeholder')}
            onChange={e => setName(e.target.value)}
          />
        </FormField>
      </div>
      <Foot
        onBack={onBack}
        onContinue={() => void create()}
        canContinue={!!name.trim()}
        busy={busy}
        label={t(unpaid ? 'team.partner.setup.client.createDraft' : 'team.partner.clients.create')}
      />
    </>
  )
}

function ClientWayStep({
  data,
  client,
  way,
  onWay,
  last,
  onBack,
  onNext,
}: {
  data: PartnerData
  client: PartnerClient
  way: ClientWay
  onWay: (way: ClientWay) => void
  last: boolean
  onBack: () => void
  onNext: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const unpaid = unpaidPartner(data)

  async function next() {
    if (busy) return
    if (!last) return onNext()
    setBusy(true)
    setProblem(null)
    try {
      await setUpClient(data.partner.id, client.id, way)
    } catch (err) {
      setProblem(partnerErrorText(err))
      setBusy(false)
    }
  }
  useStepKeys({ onEnter: () => void next(), onEscape: onBack })

  const choices: { id: ClientWay; title: string; text: string }[] = [
    { id: 'agent', title: t('team.partner.setup.way.agent'), text: t('team.partner.setup.way.agentText') },
    {
      id: 'hand',
      title: t('team.partner.setup.way.hand'),
      text: t('team.partner.setup.way.handText', { client: client.name }),
    },
  ]
  return (
    <>
      <div className="ob-body">
        <p className="ps-made">
          <Icon name="check" size={14} />
          {t(unpaid ? 'team.partner.setup.way.madeDraft' : 'team.partner.setup.way.made', { client: client.name })}
        </p>
        <h1>{t('team.partner.setup.way.title', { client: client.name })}</h1>
        <p className="ob-lede">{t('team.partner.setup.way.lede')}</p>
        <div
          className="k-radios ob-choices"
          role="radiogroup"
          aria-label={t('team.partner.setup.way.title', { client: client.name })}
        >
          {choices.map(c => (
            <label key={c.id} className={way === c.id ? 'ob-choice on' : 'ob-choice'}>
              <input type="radio" name="ps-way" checked={way === c.id} onChange={() => onWay(c.id)} />
              <div>
                <b>{c.title}</b>
                <span>{c.text}</span>
              </div>
            </label>
          ))}
        </div>
        {problem && <FormMessage>{problem}</FormMessage>}
      </div>
      <Foot
        onBack={onBack}
        onContinue={() => void next()}
        canContinue
        busy={busy}
        label={
          last ? t(way === 'agent' ? 'team.partner.setup.way.goAgent' : 'team.partner.setup.way.goHand') : undefined
        }
      />
    </>
  )
}

/** Sets the first client up the way picked: the AI agent's page, or the client's own workspace and its onboarding. */
async function setUpClient(partnerId: string, clientId: string, way: ClientWay) {
  if (way === 'agent') return withAgent(partnerId)
  rememberPartnerByHand(partnerId, true)
  // Its inbox address: a client workspace still being set up opens on its onboarding there.
  await switchToWorkspace(clientId)
}

/**
 * Step 3: White-label Cloud's price as the partner bill has it (a month each, billed yearly or monthly), what is
 * charged at Checkout with the client workspaces there are, and Stripe Checkout. Setting the client up first is the
 * equal other way: Activate stays in the partner area and on the agent's page.
 */
function ActivateStep({
  data,
  brandName: agency,
  way,
  onBack,
}: {
  data: PartnerData
  brandName: string
  way: ClientWay
  onBack: () => void
}) {
  const t = useT()
  const usd = useUsd()
  const [busy, setBusy] = useState<'activate' | 'later' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const client = firstClient(data.clients)
  const price = data.bill!.price
  const yearly = price.interval === 'year'
  const count = data.clients.length

  async function activate() {
    if (busy) return
    setBusy('activate')
    setProblem(null)
    // Back from Checkout the owner lands where the way picked leads (setup-choice.ts, partnerLanding).
    rememberPartnerByHand(data.partner.id, way === 'hand')
    try {
      await goToCheckout(data.partner.id)
    } catch {
      setProblem(t('auth.checkout.startFailed'))
      setBusy(null)
    }
  }
  async function later() {
    if (busy || !client) return
    setBusy('later')
    setProblem(null)
    try {
      await setUpClient(data.partner.id, client.id, way)
    } catch (err) {
      setProblem(partnerErrorText(err))
      setBusy(null)
    }
  }
  useStepKeys({ onEnter: () => void activate(), onEscape: onBack })

  return (
    <>
      <div className="ob-body">
        <h1>{t('team.partner.setup.activate.title')}</h1>
        <p className="ob-lede">{t('team.partner.setup.activate.lede')}</p>
        <section className="ob-points" aria-label={t('team.partner.setup.activate.summary')}>
          <Point icon="phone" label={t('team.partner.setup.activate.agency')} value={agency} />
          {client && (
            <Point
              icon="phone"
              label={t('team.partner.setup.activate.clients')}
              value={t('team.partner.setup.activate.clientsValue', { client: client.name, count })}
            />
          )}
          <Point
            icon="phone"
            next
            label={t('team.partner.setup.activate.next')}
            value={t('team.partner.setup.activate.nextValue')}
          />
        </section>
        <div className="ob-activate-plan">
          <b>{t('team.partner.setup.activate.price', { plan: usd(price.planCents), seat: usd(price.seatCents) })}</b>
          <span>
            {t(yearly ? 'team.partner.setup.activate.chargeYearly' : 'team.partner.setup.activate.chargeMonthly', {
              total: usd(partnerChargeCents(price, count)),
              count,
            })}
          </span>
        </div>
        {problem && <FormMessage>{problem}</FormMessage>}
      </div>
      <Foot
        onBack={onBack}
        onContinue={() => void activate()}
        canContinue
        busy={busy === 'activate'}
        label={t('team.partner.bill.activateButton')}
        onSkipStep={client ? () => void later() : undefined}
        laterLabel={t(
          way === 'agent' ? 'team.partner.setup.activate.laterAgent' : 'team.partner.setup.activate.laterHand',
        )}
        laterTitle={t('team.partner.setup.activate.laterTitle')}
      />
    </>
  )
}

/** One summary row, as on a Cloud sign-up's Activate step: done (a check) or what comes next (its own icon). */
function Point({ icon, label, value, next }: { icon: 'phone'; label: string; value: string; next?: boolean }) {
  return (
    <div className="ob-point">
      <span className="ob-pi">
        <Icon name={next ? icon : 'check'} size={16} />
      </span>
      <div>
        <b>{label}</b>
        <span>{value}</span>
      </div>
    </div>
  )
}
