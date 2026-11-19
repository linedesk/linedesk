// Workspace settings › Billing (docs/billing.md §8, §11 PR 9): the bill's page on Linedesk Cloud. The plan and
// its state in plain words (trial countdown, past due, suspended and why, canceled), the balance with "Buy minutes"
// (Stripe Checkout), a failed recharge with Retry, auto-recharge and the monthly cap (raising it confirms it is them),
// this period's usage per workspace and level, the latest invoices with Stripe's pages, the Stripe portal for the card
// and every invoice, and cancel in two clicks (US click-to-cancel). For whoever manages the bill: its owner, or an owner or admin of the only workspace it pays for (decision
// of 2026-11-17). Other owners and admins (a bill of several workspaces, a partner's) read that someone else pays and
// see this workspace's usage, read-only (`billing.workspaceUsage`, docs/billing.md §8). On an install that bills, a
// workspace on no bill shows its owners and admins one line that says so.
import type {
  AutoRechargeData,
  BillingInvoiceRow,
  BillingOverviewBill,
  BillingOverviewData,
  BillingStateData,
  BillingUsageRow,
  CancelData,
  ExtraCallsData,
  IntervalData,
  PortalData,
  RechargeCapData,
  RetryRechargeData,
  TopUpData,
} from '@linedesk/actions'
import { BUSY_WINDOW_DAYS, TOPUP_CENTS } from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { PASSKEY_STEP_UP_REQUIRED, StepUpRequired, withPasskeyStepUp } from '../admin/PasskeyStepUp.tsx'
import { auth } from '../auth.ts'
import { refreshQuery, setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { signInAgain } from '../localData.ts'
import { tabWorkspace } from '../tabWorkspace.ts'
import { ExternalLink, LinkButton } from '../ui/AppLink.tsx'
import { Select } from '../ui/controls.tsx'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { Dialog, FormField, Input } from '../ui/form.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { PlanCard, usePlanPrice } from '../ui/PlanCard.tsx'
import { PriceLine, usePrice } from '../ui/price.tsx'
import { readTrialLink, takeAlreadyRunning } from '../trialLink.ts'
import {
  AMOUNT_CHOICES,
  amountFits,
  canCancel,
  canResume,
  centsToDollars,
  changesRecharge,
  dollarsToCents,
  ADD_CALLS_PARAM,
  extraCallChoices,
  freeExtraCalls,
  microsToDollars,
  paysCharges,
  planLine,
  purchaseKeys,
  refusalKey,
  stateNote,
  statusBadge,
  THRESHOLD_CHOICES,
  TOP_UP_CHOICES,
  usageLine,
  yearlyRefundLine,
} from './billingModel.ts'
import { Section, SwitchRow } from './fields.tsx'
import { loadOverview, loadState, loadWorkspaceUsage, OVERVIEW, STATE, WORKSPACE_USAGE } from './billingQueries.ts'
import { callAction } from './settings-api.ts'
import { useLegalLinks } from '../shell/WorkspaceMenu.tsx'
import './billing.css'

/** The page's text for a refusal: by its code when the page has one, else the server's sentence. */
function errorMessage(err: unknown): string {
  const { t } = i18n()
  const key = refusalKey((err as { code?: string }).code)
  if (key) return t(key)
  return err instanceof Error && err.message ? err.message : t('settings.billing.error.generic')
}

/** Runs a billing write; a passkey step-up refusal becomes StepUpRequired, so withPasskeyStepUp can ask for it. */
async function write<T>(name: string, input: object = {}, options: { idempotencyKey?: string } = {}): Promise<T> {
  try {
    return await callAction<T>(name, input, options)
  } catch (err) {
    if ((err as { code?: string }).code === PASSKEY_STEP_UP_REQUIRED)
      // The status goes along: a refusal is a definite answer, so a purchase's next try gets a new command id.
      throw Object.assign(new StepUpRequired((err as Error).message, 'confirm'), {
        status: (err as { status?: number }).status,
      })
    throw err
  }
}

/**
 * Whose bill the page shows: the workspace's (null), or a white-label partner's (Partner › Billing, its id): every
 * billing read and write then names the partner (`partnerId`), and the cached answers are kept apart from the
 * workspace's.
 */
const BillPartner = createContext<string | null>(null)

/** The page's reads and writes for the bill it shows. */
function useBillCalls() {
  const partnerId = useContext(BillPartner)
  return useMemo(() => {
    const target = partnerId ? { partnerId } : {}
    const overview = partnerId ? `${OVERVIEW}.${partnerId}` : OVERVIEW
    const state = partnerId ? `${STATE}.${partnerId}` : STATE
    return {
      overview,
      state,
      loadOverview: () => loadOverview(partnerId),
      loadState: () => loadState(partnerId),
      write: <T,>(name: string, input: object = {}, options: { idempotencyKey?: string } = {}) =>
        write<T>(name, { ...input, ...target }, options),
      /** After a change: the page reads the bill again (balance, recharges, the state). */
      reload: () => Promise.all([refreshQuery(overview), refreshQuery(state)]),
    }
  }, [partnerId])
}

/**
 * `view` (workspaceBillingView): `owner`, the bill's page for owners and admins (the server answers only who manages
 * the bill; anyone else reads this workspace's usage); `usage`, the usage alone; `none`, an install that bills with no
 * bill for this workspace.
 * `partnerId`: the partner bill instead of the workspace's (its owner, in Partner › Billing).
 */
type Props = {
  toast: (text: string) => void
  view?: 'owner' | 'usage' | 'none'
  partnerId?: string
  /**
   * The reader is in this client workspace through its white-label partner's team: where they do not manage the bill,
   * the page says the workspace is on their partner plan, not that their partner handles billing.
   */
  viaPartner?: boolean
}

export function Billing({ toast, view = 'owner', partnerId, viaPartner = false }: Props) {
  if (view === 'none') return <NoBill />
  if (view === 'usage') return <NotPaying viaPartner={viaPartner} />
  return (
    <BillPartner.Provider value={partnerId ?? null}>
      <OwnerBilling toast={toast} viaPartner={viaPartner} />
    </BillPartner.Provider>
  )
}

/** An install that bills, and this workspace on no bill (decision of 2026-11-17): one calm line. */
function NoBill() {
  const t = useT()
  return (
    <Section id="billing-none" title={t('settings.billing.plan.title')}>
      <div className="billing-plan">
        <b>{t('settings.billing.noBill.title')}</b>
        <span className="help">{t('settings.billing.noBill.text')}</span>
      </div>
    </Section>
  )
}

function OwnerBilling({ toast, viaPartner }: { toast: (text: string) => void; viaPartner: boolean }) {
  const t = useT()
  const calls = useBillCalls()
  const overview = useQuery(calls.overview, calls.loadOverview)
  const state = useQuery(calls.state, calls.loadState)
  const data = overview.data
  return (
    <Loading
      what={t('settings.billing.loading')}
      loading={data === undefined}
      error={overview.error}
      onRetry={() => void overview.reload()}
      skeleton={<Skeleton shape="card" />}
    >
      {data && !data.bill ? (
        data.billingOn ? (
          <NotPaying viaPartner={viaPartner} />
        ) : (
          <Section id="billing-none" title={t('settings.workspace.nav.billing.label')}>
            <span className="help">{t('settings.billing.off')}</span>
          </Section>
        )
      ) : (
        data?.bill && <BillingPage bill={data.bill} state={state.data?.bill ?? null} toast={toast} />
      )}
    </Loading>
  )
}

/**
 * For the workspace's owners and admins who do not manage its bill (docs/billing.md §8: a bill of several workspaces,
 * or a partner's): who handles billing, and this workspace's usage this period. No plan, balance, invoices or payment
 * controls. `viaPartner`: someone on the partner's team, whose own partner plan pays for this client workspace.
 */
function NotPaying({ viaPartner = false }: { viaPartner?: boolean }) {
  const t = useT()
  const format = useFormat()
  const read = useQuery(WORKSPACE_USAGE, loadWorkspaceUsage)
  const usage = read.data?.usage
  const period = usage?.period
  return (
    <>
      <Section id="billing-none" title={t('settings.workspace.nav.billing.label')}>
        <span className="help">
          {viaPartner
            ? t('settings.billing.partnerTeam')
            : usage?.minutesOnly
              ? t('settings.billing.partnerPays')
              : t('settings.billing.notOwner')}
        </span>
      </Section>
      <Loading
        what={t('settings.billing.loading')}
        loading={read.data === undefined}
        error={read.error}
        onRetry={() => void read.reload()}
        skeleton={<Skeleton shape="card" />}
      >
        {usage && (
          <Section
            id="billing-usage"
            title={t('settings.billing.usage.title')}
            description={
              period
                ? t('settings.billing.usage.period', {
                    from: format.date(new Date(period.startsAt)),
                    to: format.date(new Date(period.endsAt)),
                  })
                : undefined
            }
          >
            <UsageRows rows={usage.row ? [usage.row] : []} minutesOnly={usage.minutesOnly} />
          </Section>
        )}
      </Loading>
    </>
  )
}

function BillingPage({
  bill,
  state,
  toast,
}: {
  bill: BillingOverviewBill
  state: BillingStateData['bill']
  toast: (text: string) => void
}) {
  // A comped bill pays nothing: no balance to top up (unless one is left from before) and no auto-recharge.
  const pays = paysCharges(bill)
  const toPay = invoicesToPay(state, bill.invoices)
  return (
    <>
      <BillPlan bill={bill} state={state} toPay={toPay} toast={toast} />
      {(pays || bill.balanceMicros !== 0) && <BalanceCard bill={bill} payFirst={toPay.length > 0} toast={toast} />}
      {pays && <AutoRechargeCard bill={bill} toast={toast} />}
      <UsageCard bill={bill} />
      <InvoicesCard bill={bill} toast={toast} />
      {/* Rarely changed, so last (2026-11-18); the busy-line link scrolls down to it. */}
      {pays && <CallsCard bill={bill} toast={toast} />}
    </>
  )
}

// ---- The plan --------------------------------------------------------------------------------------------------

/**
 * Stripe's hosted invoice pages, the only addresses a pay link in the plan's warning opens. The invoices come from the
 * overview (Stripe's `hosted_invoice_url`, as in the Invoices card); anything else is not linked from the warning.
 */
const STRIPE_INVOICE_PAGES = ['https://invoice.stripe.com/', 'https://pay.stripe.com/']
const isStripeInvoicePage = (url: string | null): url is string =>
  !!url && STRIPE_INVOICE_PAGES.some(prefix => url.startsWith(prefix))

/** How many pay links the warning shows; with more open invoices, a link to the Invoices card follows. */
const PAY_LINKS_SHOWN = 2

/**
 * The invoices the owner pays from the warning while payment is needed (past due, or calls paused): the open ones with
 * a Stripe page, in the overview's order. None in any other state. After paying on Stripe's page, the owner comes back
 * to this tab, and the window's focus reads the bill again (cachedQuery), so the warning goes once Stripe says paid.
 */
function invoicesToPay(state: BillingStateData['bill'], invoices: BillingInvoiceRow[]): BillingInvoiceRow[] {
  if (state?.status !== 'past_due' && state?.status !== 'suspended') return []
  return invoices.filter(inv => inv.status === 'open' && isStripeInvoicePage(inv.url))
}

/** The warning's pay links: one per open invoice (the first two), then "See all open invoices" when there are more. */
function PayLinks({ invoices, primary }: { invoices: BillingInvoiceRow[]; primary: boolean }) {
  const t = useT()
  const format = useFormat()
  const showAll = () => document.getElementById('billing-invoices')?.scrollIntoView({ behavior: 'smooth' })
  return (
    <span className="billing-actions billing-pay">
      {invoices.slice(0, PAY_LINKS_SHOWN).map((inv, i) => (
        <a
          key={inv.id}
          // One primary button per screen: the first pay link, unless a failed recharge's Retry has it.
          className={`k-btn k-btn-sm ${primary && i === 0 ? 'k-btn-primary' : 'k-btn-secondary'}`}
          href={inv.url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('settings.billing.state.payInvoice', { amount: format.currency(centsToDollars(inv.totalCents), 'USD') })}
        </a>
      ))}
      {invoices.length > PAY_LINKS_SHOWN && (
        <LinkButton onClick={showAll}>{t('settings.billing.state.allInvoices')}</LinkButton>
      )}
    </span>
  )
}

/**
 * Whether the address asks for the cancel dialog (`#workspace/billing?cancel=1&ws=…`, the trial emails' "Cancel my
 * trial"); the flag is taken out of the address, so a reload or Back does not open it again.
 */
export function takeCancelRequest(): boolean {
  return takeHashFlag('cancel')
}

/**
 * Whether the address asks for the "add calls at the same time" dialog (`#workspace/billing?addCalls=1&ws=…`, the
 * busy-line email and banner, LIN-450); taken out of the address like the cancel request.
 */
export function takeAddCallsRequest(): boolean {
  return takeHashFlag(ADD_CALLS_PARAM)
}

function takeHashFlag(name: string): boolean {
  // Rendered without a browser (tests, server render): no link to take.
  if (typeof window === 'undefined') return false
  const hash = window.location.hash
  const at = hash.indexOf('?')
  if (at < 0) return false
  const params = new URLSearchParams(hash.slice(at + 1))
  if (params.get(name) !== '1') return false
  params.delete(name)
  const rest = params.toString()
  window.history.replaceState(null, '', `${hash.slice(0, at)}${rest ? `?${rest}` : ''}`)
  return true
}

/**
 * The bill's own facts under its price (Settings › Billing only): how many workspaces are on it, the renewal or the
 * trial's end, the trial's balance note, a missing tax address and what an extra number costs.
 */
function BillFacts({
  bill,
  line,
  date,
}: {
  bill: BillingOverviewBill
  line: ReturnType<typeof planLine>
  date: (iso: string) => string
}) {
  const t = useT()
  const partner = bill.kind === 'partner'
  return (
    <div className="billing-plan">
      {!partner && <span className="help">{t('settings.billing.plan.workspaces', { count: bill.workspaces })}</span>}
      {line && (
        <span className="help">
          {line.days !== undefined
            ? t(line.key, { date: date(line.date), count: line.days })
            : t(line.key, { date: date(line.date) })}
        </span>
      )}
      {bill.status === 'trialing' && (
        <span className="help">
          {t('settings.billing.plan.trialNote')}
          {!bill.autoRecharge.on && ` ${t('settings.billing.plan.trialAutoOff')}`}
        </span>
      )}
      {bill.taxAddressMissing && <span className="help">{t('settings.billing.plan.taxAddressMissing')}</span>}
    </div>
  )
}

function BillPlan({
  bill,
  state,
  toPay,
  toast,
}: {
  bill: BillingOverviewBill
  state: BillingStateData['bill']
  toPay: BillingInvoiceRow[]
  toast: (text: string) => void
}) {
  const t = useT()
  const calls = useBillCalls()
  const format = useFormat()
  const prices = usePrice()
  // "Cancel my trial" in the trial emails links here with `cancel=1`: the cancel dialog opens at once (once).
  const [cancelOpen, setCancelOpen] = useState(() => takeCancelRequest() && canCancel(bill))
  // The Start your free trial link (trialLink.ts) opened on a bill whose trial or plan runs already: said once here.
  const [fromTrialLink] = useState(
    () => takeAlreadyRunning() || (typeof window !== 'undefined' && readTrialLink(window.location.hash) !== null),
  )
  const [switching, setSwitching] = useState(false)
  const intervalSwitch = !bill.cancelAtPeriodEnd ? (bill.intervalSwitch ?? null) : null
  const [resuming, setResuming] = useState(false)
  const supportEmail = useLegalLinks()?.supportEmail ?? null
  const date = (iso: string) => format.date(new Date(iso))
  const badge = statusBadge(bill.status, bill.heldForReview)
  const line = planLine(bill)
  // A partner bill: the partner base fee, then its client workspaces on their own line (docs/white-label.md).
  const partner = bill.kind === 'partner'
  const note = stateNote(state, date, partner)
  // The shared plan card (ui/PlanCard.tsx): the price a month leads, a yearly plan's total is the grey note under it
  // (ui/price.tsx), the same included rows, tax line and "See all details" as the activation steps.
  const pays = paysCharges(bill)
  const planPrice = usePlanPrice()
  const clientCents = bill.clientSeatCents ?? 0
  const price = planPrice(prices.perMonth(bill.seatCents, bill.interval))
  const unit = partner
    ? t('common.plan.clientSeats', { seat: prices.perMonth(clientCents, bill.interval), count: bill.workspaces })
    : t('common.plan.perWorkspace')
  // A yearly plan's total: the partner fee with its client workspaces; a Cloud seat's "a year each" with more than one.
  const planNote = partner
    ? prices.yearNote(bill.seatCents + clientCents * bill.workspaces, bill.interval)
    : prices.yearNote(bill.seatCents, bill.interval, bill.workspaces > 1)
  const comped = t(partner ? 'settings.billing.plan.compedPartner' : 'settings.billing.plan.comped', {
    count: bill.workspaces,
  })
  const held = bill.heldForReview && (bill.status === 'active' || bill.status === 'trialing')

  async function resume() {
    setResuming(true)
    try {
      const done = await calls.write<CancelData>('billing.resume')
      setQueryData<BillingOverviewData | undefined>(calls.overview, d =>
        d?.bill ? { ...d, bill: { ...d.bill, cancelAtPeriodEnd: done.cancelAtPeriodEnd } } : d,
      )
      toast(t('settings.billing.plan.resumed'))
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setResuming(false)
      void calls.reload()
    }
  }

  return (
    <Section
      id="billing-plan"
      title={t('settings.billing.plan.title')}
      actions={
        // Before the first Checkout there is no plan to report on: no "Waiting for a card" before activation started.
        bill.status === 'pending_payment' ? undefined : (
          <Badge tone={badge.tone} dot>
            {t(badge.key)}
          </Badge>
        )
      }
    >
      {pays ? (
        <PlanCard
          bare
          price={price}
          unit={unit}
          note={planNote}
          prices={bill.prices}
          each={partner ? 'client' : bill.workspaces > 1 ? 'workspace' : null}
          calls={partner ? null : bill.calls}
          tax={bill.taxed}
          autoRecharge={bill.autoRecharge.on}
        >
          <BillFacts bill={bill} line={line} date={date} />
        </PlanCard>
      ) : (
        <div className="billing-plan">
          <PriceLine note={null}>{comped}</PriceLine>
          <BillFacts bill={bill} line={line} date={date} />
        </div>
      )}
      {held && (
        <Note tone="warning" title={t('settings.billing.held.title')}>
          {supportEmail
            ? t('settings.billing.held.text', { email: supportEmail })
            : t('settings.billing.held.textNoEmail')}
        </Note>
      )}
      {note && (
        <Note tone={note.tone} title={t(note.title)}>
          {t(note.text, note.values)}
          {toPay.length > 0 && <PayLinks invoices={toPay} primary={!bill.rechargeFailure} />}
        </Note>
      )}
      {state && state.unpaidNumbers.length > 0 && (
        <Note tone="warning" title={t('settings.billing.state.unpaidNumbers.title')}>
          {state.unpaidNumbers.map(n => (
            <span key={n.e164} className="billing-line">
              {t('settings.billing.state.unpaidNumbers.line', { number: n.e164, date: date(n.releaseAt) })}
            </span>
          ))}
        </Note>
      )}
      {fromTrialLink && (bill.status === 'trialing' || bill.status === 'active') && (
        <Note>
          {bill.status === 'trialing'
            ? t('settings.billing.plan.trialLinkTrial')
            : t('settings.billing.plan.trialLinkPlan')}
        </Note>
      )}
      {(canCancel(bill) || canResume(bill) || intervalSwitch) && (
        <div className="billing-actions">
          {intervalSwitch && (
            <Button
              variant="secondary"
              title={t('settings.billing.interval.buttonTip')}
              onClick={() => setSwitching(true)}
            >
              {intervalSwitch.interval === 'month'
                ? t('settings.billing.interval.toMonth')
                : t('settings.billing.interval.toYear')}
            </Button>
          )}
          {canCancel(bill) && (
            <Button
              variant="danger-outline"
              title={t('settings.billing.cancel.buttonTip')}
              onClick={() => setCancelOpen(true)}
            >
              {t('settings.billing.cancel.button')}
            </Button>
          )}
          {canResume(bill) && (
            <Button busy={resuming} title={t('settings.billing.resume.buttonTip')} onClick={() => void resume()}>
              {t('settings.billing.resume.button')}
            </Button>
          )}
        </div>
      )}
      {cancelOpen && <CancelDialog bill={bill} onClose={() => setCancelOpen(false)} toast={toast} />}
      {switching && intervalSwitch && (
        <IntervalDialog bill={bill} to={intervalSwitch} onClose={() => setSwitching(false)} toast={toast} />
      )}
    </Section>
  )
}

/**
 * Monthly or yearly in the free trial (Janik, 2026-11-19): the new price (a month first, a yearly total as the grey
 * note) and that nothing is charged before the trial ends; the switch keeps the trial's end and charges nothing now.
 */
export function IntervalDialog({
  bill,
  to,
  onClose,
  toast,
}: {
  bill: BillingOverviewBill
  to: { interval: 'month' | 'year'; seatCents: number }
  onClose: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const calls = useBillCalls()
  const format = useFormat()
  const prices = usePrice()
  const planPrice = usePlanPrice()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = to.interval === 'month' ? t('settings.billing.interval.toMonth') : t('settings.billing.interval.toYear')
  const note = prices.yearNote(to.seatCents, to.interval) ?? t('common.price.billedMonthly')
  async function run() {
    setBusy(true)
    setError(null)
    try {
      const done = await calls.write<IntervalData>('billing.setInterval', { interval: to.interval })
      // The page shows the new interval at once; the overview read after it brings the rest.
      setQueryData<BillingOverviewData | undefined>(calls.overview, d =>
        d?.bill
          ? {
              ...d,
              bill: {
                ...d.bill,
                interval: done.interval,
                seatCents: to.seatCents,
                intervalSwitch: { interval: d.bill.interval, seatCents: d.bill.seatCents },
              },
            }
          : d,
      )
      toast(
        done.interval === 'month' ? t('settings.billing.interval.doneMonth') : t('settings.billing.interval.doneYear'),
      )
      void calls.reload()
      onClose()
    } catch (err) {
      setBusy(false)
      setError(errorMessage(err))
    }
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      onSubmit={e => {
        e.preventDefault()
        void run()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button variant="primary" type="submit" busy={busy} shortcut={['⏎']}>
            {title}
          </Button>
        </>
      }
    >
      <div className="billing-plan">
        <PriceLine note={note}>
          {planPrice(prices.perMonth(to.seatCents, to.interval))}{' '}
          <span className="help">{t('common.plan.perWorkspace')}</span>
        </PriceLine>
        <span className="help">
          {bill.trialEndsAt
            ? t('settings.billing.interval.noCharge', { date: format.date(new Date(bill.trialEndsAt)) })
            : t('settings.billing.interval.noChargeNoDate')}
        </span>
      </div>
      {error && <Note tone="danger">{error}</Note>}
    </Dialog>
  )
}

/** Cancel (US click-to-cancel): the button above, then this one confirm. What happens is said in plain words. */
export function CancelDialog({
  bill,
  onClose,
  toast,
}: {
  bill: BillingOverviewBill
  onClose: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const calls = useBillCalls()
  const format = useFormat()
  const supportEmail = useLegalLinks()?.supportEmail ?? null
  const end = bill.status === 'trialing' ? bill.trialEndsAt : bill.currentPeriodEnd
  const endText = end ? format.date(new Date(end)) : null
  // What is refunded on request (the terms' "Refunds", docs/billing.md §4.5): a yearly plan paid in the last 14 days,
  // and the unused balance. Both are asked for, never automatic.
  const refund = yearlyRefundLine(bill, iso => format.date(new Date(iso)))
  const balance = bill.availableMicros > 0 ? format.currency(microsToDollars(bill.availableMicros), 'USD') : null
  const ask = supportEmail ? t('settings.billing.cancel.ask', { email: supportEmail }) : null
  // A partner bill: the numbers and calls are its client workspaces'.
  const partner = bill.kind === 'partner'
  return (
    <DangerConfirmDialog
      confirm={{
        text: endText ? t('settings.billing.cancel.text', { date: endText }) : t('settings.billing.cancel.textNoDate'),
        after: t('settings.billing.cancel.after'),
        list: [
          t('settings.billing.cancel.noCharge'),
          ...(refund ? [t(refund.key, refund.values)] : []),
          ...(balance ? [t('settings.billing.cancel.balance', { amount: balance })] : []),
          ...(ask && (refund?.key === 'settings.billing.cancel.yearlyRefund' || balance) ? [ask] : []),
          t(partner ? 'settings.billing.cancel.numbersPartner' : 'settings.billing.cancel.numbers'),
          t(partner ? 'settings.billing.cancel.dataPartner' : 'settings.billing.cancel.data'),
        ],
        action: t('settings.billing.cancel.confirm'),
        busyAction: t('settings.billing.cancel.busy'),
        // Never "Cancel" next to "Cancel plan": backing out says what it does (security review of #1007, L-4).
        dismiss: t('settings.billing.cancel.keep'),
      }}
      run={async () => {
        try {
          const done = await calls.write<CancelData>('billing.cancel')
          setQueryData<BillingOverviewData | undefined>(calls.overview, d =>
            d?.bill ? { ...d, bill: { ...d.bill, cancelAtPeriodEnd: done.cancelAtPeriodEnd } } : d,
          )
        } catch (err) {
          throw new Error(errorMessage(err))
        }
        void calls.reload()
        toast(t('settings.billing.cancel.done'))
        onClose()
      }}
      onClose={onClose}
    />
  )
}

// ---- Calls at the same time (LIN-450) ---------------------------------------------------------------------------

type CallsChange = { workspaceId: string; name: string; from: number; to: number }

/**
 * Calls at the same time per workspace: the included ones, and more in steps of 5 at a price a month, picked from a
 * list. Every change is confirmed in a dialog that says what it costs (more is charged now, fewer is not refunded).
 */
function CallsCard({ bill, toast }: { bill: BillingOverviewBill; toast: (text: string) => void }) {
  const t = useT()
  const { money } = usePrice()
  const calls = bill.calls
  // From the busy-line email or banner: the dialog opens one step up for this workspace, when the owner can add.
  const [asking, setAsking] = useState<CallsChange | null>(() => {
    if (!takeAddCallsRequest() || !calls.canAdd) return null
    const w = calls.workspaces.find(x => x.workspaceId === tabWorkspace()) ?? calls.workspaces[0]
    if (!w || w.extraCalls + calls.step > calls.maxExtra) return null
    return { workspaceId: w.workspaceId, name: w.name, from: w.extraCalls, to: w.extraCalls + calls.step }
  })
  // The card is the page's last: opened from the busy-line link, the page goes down to it, so it is in view once the
  // dialog closes.
  const [fromLink] = useState(() => asking !== null)
  useEffect(() => {
    if (fromLink) document.getElementById('billing-calls')?.scrollIntoView({ block: 'start' })
  }, [fromLink])
  const price = (extra: number) => money(extra * calls.extraCallCents)
  const editable = changesRecharge(bill)
  // A partner bill names each client workspace, also its only one: never "Your assistant answers".
  const partner = bill.kind === 'partner'
  const several = partner || calls.workspaces.length > 1
  if (!calls.workspaces.length) return null
  return (
    <Section
      id="billing-calls"
      title={t('settings.billing.calls.title')}
      // In the trial the row says what is included and the note under it what more cost: the numbers once each.
      description={
        bill.status === 'trialing'
          ? t('settings.billing.calls.busyNote')
          : t(partner ? 'settings.billing.calls.descriptionPartner' : 'settings.billing.calls.description', {
              count: calls.includedPerWorkspace,
              step: calls.step,
              price: price(calls.step),
            })
      }
    >
      {calls.workspaces.map(w => (
        <div className="swrow billing-calls-row" key={w.workspaceId}>
          <div>
            <b>{several ? w.name : t('settings.billing.calls.rowTitle')}</b>
            <span className="help">
              {w.extraCalls
                ? t(
                    // Added at activation in a trial: charged with the plan, and in use, from the trial's end.
                    bill.status === 'trialing'
                      ? 'settings.billing.calls.rowExtraTrial'
                      : 'settings.billing.calls.rowExtra',
                    { count: w.limit, price: price(w.extraCalls) },
                  )
                : t('settings.billing.calls.rowIncluded', { count: w.limit })}
            </span>
            {w.busyCallers > 0 && (
              <span className="help">
                {t('settings.billing.calls.busyCallers', { count: w.busyCallers, days: BUSY_WINDOW_DAYS })}
              </span>
            )}
          </div>
          <Select
            id={`billing-calls-${w.workspaceId}`}
            size="sm"
            align="end"
            value={String(w.extraCalls)}
            disabled={!editable}
            label={several ? t('settings.billing.calls.labelFor', { name: w.name }) : t('settings.billing.calls.label')}
            options={extraCallChoices(calls, w.extraCalls).map(extra => ({
              value: String(extra),
              label: t('settings.billing.calls.option', { count: calls.includedPerWorkspace + extra }),
              description:
                extra === 0
                  ? t('settings.billing.calls.optionIncluded')
                  : t('settings.billing.calls.optionPrice', { price: price(extra) }),
              disabled: extra > w.extraCalls && !calls.canAdd,
            }))}
            onChange={v => setAsking({ workspaceId: w.workspaceId, name: w.name, from: w.extraCalls, to: Number(v) })}
          />
        </div>
      ))}
      {!calls.canAdd && editable && (
        <span className="help">
          {t(partner ? 'settings.billing.calls.afterTrialPartner' : 'settings.billing.calls.afterTrial', {
            step: calls.step,
            price: price(calls.step),
          })}
        </span>
      )}
      {asking && (
        <CallsDialog
          change={asking}
          free={freeExtraCalls(calls, asking)}
          included={calls.includedPerWorkspace}
          price={price}
          onClose={() => setAsking(null)}
          toast={toast}
        />
      )}
    </Section>
  )
}

/** Confirms a change of a workspace's extra calls: what it costs now and from the next bill. */
function CallsDialog({
  change,
  free,
  included,
  price,
  onClose,
  toast,
}: {
  change: CallsChange
  /** No charge now: going back up to what this billing period already paid for. */
  free: boolean
  included: number
  price: (extra: number) => string
  onClose: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signIn, setSignIn] = useState(false)
  const calls = useBillCalls()
  const more = change.to > change.from
  const count = included + change.to

  async function save() {
    setBusy(true)
    setError(null)
    const workspaceId = tabWorkspace()
    let attempt = 0
    try {
      // More calls charge the card: the owner confirms it is them first (a passkey, or a recent sign-in).
      const done = await withPasskeyStepUp(async () => {
        // The passkey dialog signs in again (a new session): the retry makes this workspace the session's again.
        if (attempt++ > 0 && workspaceId) await auth.organization.setActive({ organizationId: workspaceId })
        return calls.write<ExtraCallsData>('billing.setExtraCalls', {
          workspaceId: change.workspaceId,
          extraCalls: change.to,
        })
      }, t('settings.billing.calls.stepUpWhat'))
      setQueryData<BillingOverviewData | undefined>(calls.overview, d =>
        d?.bill
          ? {
              ...d,
              bill: {
                ...d.bill,
                calls: {
                  ...d.bill.calls,
                  workspaces: d.bill.calls.workspaces.map(w =>
                    w.workspaceId === done.workspaceId ? { ...w, extraCalls: done.extraCalls, limit: done.limit } : w,
                  ),
                },
              },
            }
          : d,
      )
      toast(t('settings.billing.calls.saved', { count: done.limit }))
      void calls.reload()
      onClose()
    } catch (err) {
      if ((err as { code?: string }).code === 'SIGN_IN_AGAIN') setSignIn(true)
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  function signInFirst() {
    window.history.replaceState(null, '', `#workspace/billing${workspaceQuery()}`)
    void signInAgain()
  }

  return (
    <Dialog
      title={more ? t('settings.billing.calls.addTitle') : t('settings.billing.calls.removeTitle')}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {!more
              ? t('settings.billing.calls.removeButton')
              : free
                ? t('settings.billing.calls.addFreeButton')
                : t('settings.billing.calls.addButton', { price: price(change.to - change.from) })}
          </Button>
        </>
      }
    >
      <p>
        {change.to === 0
          ? t('settings.billing.calls.textIncluded', { name: change.name, count })
          : t('settings.billing.calls.text', { name: change.name, count, price: price(change.to) })}
      </p>
      <p className="help">
        {!more
          ? t('settings.billing.calls.removeNote')
          : free
            ? t('settings.billing.calls.addFreeNote')
            : t('settings.billing.calls.addNote')}
      </p>
      {error && !signIn && <Note tone="danger">{error}</Note>}
      {signIn && (
        <Note
          tone="warning"
          title={t('settings.billing.cap.signInTitle')}
          action={
            <Button size="sm" title={t('settings.billing.cap.signInTip')} onClick={signInFirst}>
              {t('settings.billing.cap.signIn')}
            </Button>
          }
        >
          {t('settings.billing.calls.signInText')}
        </Note>
      )}
    </Dialog>
  )
}

// ---- The balance -----------------------------------------------------------------------------------------------

/** An empty tab opened while the click is still handled, cut off from this page; null when the browser blocked it. */
function openBlankTab(): Window | null {
  const tab = window.open('', '_blank')
  if (tab) tab.opener = null
  return tab
}

/** `payFirst`: the plan's warning shows pay links, so paying the open invoice is the primary button, not Buy minutes. */
function BalanceCard({
  bill,
  payFirst,
  toast,
}: {
  bill: BillingOverviewBill
  payFirst: boolean
  toast: (text: string) => void
}) {
  const t = useT()
  const calls = useBillCalls()
  const format = useFormat()
  const [buying, setBuying] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const failure = bill.rechargeFailure
  const money = (micros: number) => format.currency(microsToDollars(micros), 'USD')
  const reserved = bill.balanceMicros - bill.availableMicros

  async function retry() {
    setRetrying(true)
    // The invoice page opens in a tab made now, inside the click, so no popup blocker stops it once the answer is
    // here (security review of #1007, L-3). Blocked anyway: this tab goes to the page instead.
    const tab = failure?.needsAction ? openBlankTab() : null
    try {
      const done = await calls.write<RetryRechargeData>('billing.retryRecharge')
      if (done.kind === 'confirm') {
        if (tab) {
          tab.location.href = done.url
          toast(t('settings.billing.retry.confirmOpened'))
        } else window.location.assign(done.url)
      } else {
        tab?.close()
        // i18n-dynamic: settings.billing.retry.done.*
        toast(t(`settings.billing.retry.done.${done.kind}` as MessageKey))
      }
    } catch (err) {
      tab?.close()
      toast(errorMessage(err))
    } finally {
      setRetrying(false)
      void calls.reload()
    }
  }

  return (
    <Section
      id="billing-balance"
      title={t('settings.billing.balance.title')}
      description={t('settings.billing.balance.description')}
    >
      <div className="billing-balance">
        <span className={bill.availableMicros < 0 ? 'billing-amount is-negative' : 'billing-amount'}>
          {money(bill.availableMicros)}
        </span>
        {reserved > 0 && (
          <span className="help">{t('settings.billing.balance.reserved', { amount: money(reserved) })}</span>
        )}
      </div>
      {bill.rechargePending && !failure && (
        <Note tone="info">
          {t('settings.billing.balance.recharging', {
            amount: format.currency(centsToDollars(bill.rechargePending.amountCents), 'USD'),
          })}
        </Note>
      )}
      {failure && (
        <Note
          tone="danger"
          title={t('settings.billing.retry.title')}
          action={
            <Button
              variant="primary"
              busy={retrying}
              disabled={!failure.needsAction && (failure.retriesLeft === 0 || !bill.autoRecharge.on)}
              title={t('settings.billing.retry.buttonTip')}
              onClick={() => void retry()}
            >
              {failure.needsAction ? t('settings.billing.retry.confirmButton') : t('settings.billing.retry.button')}
            </Button>
          }
        >
          {failure.needsAction
            ? t('settings.billing.retry.needsAction')
            : failure.code === TAX_ADDRESS_MISSING
              ? t('settings.billing.retry.noTaxAddress')
              : bill.autoRecharge.on
                ? t('settings.billing.retry.declined', { count: failure.retriesLeft })
                : t('settings.billing.retry.declinedAutoOff')}
        </Note>
      )}
      {bill.canBuyMinutes && paysCharges(bill) && (
        <div className="billing-actions">
          <Button
            // One primary button per screen: Retry takes it while a recharge failed, a pay link while one is shown.
            variant={failure || payFirst ? 'secondary' : 'primary'}
            icon="plus"
            title={t('settings.billing.topUp.buttonTip')}
            onClick={() => setBuying(true)}
          >
            {t('settings.billing.topUp.button')}
          </Button>
        </div>
      )}
      {buying && <TopUpDialog taxed={bill.taxed} onClose={() => setBuying(false)} toast={toast} />}
    </Section>
  )
}

/**
 * "Buy minutes": $5, $10, $20 or another whole amount up to $500. "Pay" first shows which saved card would be charged
 * (brand and last four); "Charge" then charges it at once, after the owner confirms it is them (passkey or a recent
 * sign-in, as for raising the cap). Without a saved card, over the daily limit, or when the bank wants a confirmation,
 * the server answers a Stripe Checkout instead. "Use another card" goes to Checkout directly.
 */
function TopUpDialog({
  taxed,
  onClose,
  toast,
}: {
  taxed: boolean
  onClose: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const calls = useBillCalls()
  const format = useFormat()
  const [picked, setPicked] = useState<number | 'other'>(TOP_UP_CHOICES[1])
  const [other, setOther] = useState('')
  const [busy, setBusy] = useState(false)
  const [card, setCard] = useState<{ id: string; brand: string | null; last4: string | null } | null>(null)
  // The charge's command id, kept across presses while its outcome is unknown (never charged twice).
  const [keys] = useState(() => purchaseKeys())
  const otherCents = dollarsToCents(other, TOPUP_CENTS.min, TOPUP_CENTS.max)
  const cents = picked === 'other' ? otherCents : picked
  const limits = {
    min: format.currency(centsToDollars(TOPUP_CENTS.min), 'USD', { maximumFractionDigits: 0 }),
    max: format.currency(centsToDollars(TOPUP_CENTS.max), 'USD', { maximumFractionDigits: 0 }),
  }

  const cardName = card ? savedCardLabel(card, t) : ''

  async function go(savedCard: boolean) {
    if (!cents) return
    setBusy(true)
    const workspaceId = tabWorkspace()
    let attempt = 0
    try {
      const input = { amountCents: cents, savedCard, ...(savedCard && card ? { confirmCard: card.id } : {}) }
      const done =
        savedCard && card
          ? await withPasskeyStepUp(async () => {
              // The passkey dialog signs in again (a new session): the retry makes this workspace the session's again.
              if (attempt++ > 0 && workspaceId) await auth.organization.setActive({ organizationId: workspaceId })
              const idempotencyKey = keys.keyFor(`${cents}:${card.id}`)
              try {
                const answer = await calls.write<TopUpData>('billing.startTopUp', input, { idempotencyKey })
                keys.settle()
                return answer
              } catch (err) {
                keys.settle(err)
                throw err
              }
            }, t('settings.billing.topUp.stepUpWhat'))
          : await calls.write<TopUpData>('billing.startTopUp', input)
      if (done.kind === 'confirm') {
        // Which card is charged, before anything is: the owner confirms it with the next press.
        setCard(done.card)
        setBusy(false)
        return
      }
      if (done.kind === 'checkout') {
        if (done.fallback === 'declined') toast(t('settings.billing.topUp.declinedToCheckout'))
        if (done.fallback === 'daily_limit') toast(t('settings.billing.topUp.dailyLimitToCheckout'))
        window.location.assign(done.url)
        return
      }
      const amount = format.currency(centsToDollars(done.amountCents), 'USD')
      toast(
        done.kind === 'paid' && done.credited
          ? t('settings.billing.topUp.paid', { amount })
          : t('settings.billing.topUp.processing', { amount }),
      )
      await calls.reload()
      onClose()
    } catch (err) {
      toast(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('settings.billing.topUp.title')}
      description={t('settings.billing.topUp.description')}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        void go(true)
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !cents}
            title={t('settings.billing.topUp.otherCardTip')}
            onClick={() => void go(false)}
          >
            {t('settings.billing.topUp.otherCard')}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!cents}>
            {!cents
              ? t('settings.billing.topUp.payNoAmount')
              : card
                ? t(taxed ? 'settings.billing.topUp.chargeTaxed' : 'settings.billing.topUp.charge', {
                    amount: format.currency(centsToDollars(cents), 'USD'),
                    card: cardName,
                  })
                : t(taxed ? 'settings.billing.topUp.payTaxed' : 'settings.billing.topUp.pay', {
                    amount: format.currency(centsToDollars(cents), 'USD'),
                  })}
          </Button>
        </>
      }
    >
      <div className="billing-choices" role="radiogroup" aria-label={t('settings.billing.topUp.amount')}>
        {TOP_UP_CHOICES.map(c => (
          <Button
            key={c}
            role="radio"
            aria-checked={picked === c}
            variant={picked === c ? 'secondary' : 'ghost'}
            className={picked === c ? 'is-picked' : undefined}
            onClick={() => setPicked(c)}
          >
            {format.currency(centsToDollars(c), 'USD', { maximumFractionDigits: 0 })}
          </Button>
        ))}
        <Button
          role="radio"
          aria-checked={picked === 'other'}
          variant={picked === 'other' ? 'secondary' : 'ghost'}
          className={picked === 'other' ? 'is-picked' : undefined}
          onClick={() => setPicked('other')}
        >
          {t('settings.billing.topUp.other')}
        </Button>
      </div>
      {picked === 'other' && (
        <FormField
          id="billing-topup-other"
          label={t('settings.billing.topUp.otherLabel')}
          description={t('settings.billing.topUp.limits', limits)}
          error={other && !otherCents ? t('settings.billing.topUp.invalid', limits) : null}
        >
          <Input
            id="billing-topup-other"
            inputMode="numeric"
            value={other}
            autoFocus
            invalid={!!other && !otherCents}
            onChange={e => setOther(e.target.value)}
          />
        </FormField>
      )}
      {card && <Note>{t('settings.billing.topUp.cardNote', { card: cardName })}</Note>}
      {taxed && <p className="help">{t('settings.billing.topUp.taxNote')}</p>}
    </Dialog>
  )
}

/**
 * Stripe Tax could not place the customer (no billing address, or one it cannot read): the recharge invoice was not
 * charged at all. Not a card decline: the owner adds the address in the Stripe portal, then tries again.
 */
const TAX_ADDRESS_MISSING = 'stripe_customer_tax_location_invalid'

/** "Visa ending in 4242" for the saved card Buy minutes would charge (Stripe's brand code, capitalized). */
function savedCardLabel(card: { brand: string | null; last4: string | null }, t: ReturnType<typeof useT>) {
  if (!card.brand || !card.last4) return t('settings.billing.topUp.cardUnknown')
  return t('settings.billing.topUp.card', {
    brand: card.brand.charAt(0).toUpperCase() + card.brand.slice(1),
    last4: card.last4,
  })
}

// ---- Auto-recharge and the cap ---------------------------------------------------------------------------------

function AutoRechargeCard({ bill, toast }: { bill: BillingOverviewBill; toast: (text: string) => void }) {
  const t = useT()
  const calls = useBillCalls()
  const format = useFormat()
  const [capOpen, setCapOpen] = useState(false)
  const money = (cents: number) => format.currency(centsToDollars(cents), 'USD', { maximumFractionDigits: 0 })
  const auto = bill.autoRecharge
  const editable = changesRecharge(bill)
  const options = (choices: readonly number[], fits: (c: number) => boolean) =>
    choices.map(c => ({ value: String(c), label: money(c), disabled: !fits(c) }))

  async function save(next: AutoRechargeData | Omit<AutoRechargeData, 'recharging'>) {
    const before = bill.autoRecharge
    const input = { on: next.on, thresholdCents: next.thresholdCents, amountCents: next.amountCents }
    setQueryData<BillingOverviewData | undefined>(calls.overview, d =>
      d?.bill ? { ...d, bill: { ...d.bill, autoRecharge: input } } : d,
    )
    try {
      const done = await calls.write<AutoRechargeData>('billing.setAutoRecharge', input)
      toast(done.recharging ? t('settings.billing.auto.savedRecharging') : t('settings.billing.auto.saved'))
    } catch (err) {
      setQueryData<BillingOverviewData | undefined>(calls.overview, d =>
        d?.bill ? { ...d, bill: { ...d.bill, autoRecharge: before } } : d,
      )
      toast(errorMessage(err))
    } finally {
      void calls.reload()
    }
  }

  return (
    <Section id="billing-auto" title={t('settings.billing.auto.title')}>
      <SwitchRow
        title={t('settings.billing.auto.switch')}
        description={
          auto.on
            ? t(bill.taxed ? 'settings.billing.auto.onTextTaxed' : 'settings.billing.auto.onText', {
                threshold: money(auto.thresholdCents),
                amount: money(auto.amountCents),
              })
            : // What turning it on agrees to, word for word what billing.setAutoRecharge records (source auto_recharge).
              t(bill.taxed ? 'settings.billing.auto.offTermsTaxed' : 'settings.billing.auto.offTerms', {
                amount: money(auto.amountCents),
                threshold: money(auto.thresholdCents),
                cap: money(bill.cap.effectiveCents),
              })
        }
        on={auto.on}
        disabled={!editable}
        onChange={on => void save({ ...auto, on })}
      />
      {auto.on && (
        <div className="billing-row">
          <FormField id="billing-threshold" label={t('settings.billing.auto.threshold')}>
            <Select
              id="billing-threshold"
              size="sm"
              value={String(auto.thresholdCents)}
              options={options(
                THRESHOLD_CHOICES.includes(auto.thresholdCents as never)
                  ? THRESHOLD_CHOICES
                  : [...THRESHOLD_CHOICES, auto.thresholdCents].sort((a, b) => a - b),
                c => amountFits(c, auto.amountCents),
              )}
              onChange={v => void save({ ...auto, thresholdCents: Number(v) })}
              label={t('settings.billing.auto.threshold')}
            />
          </FormField>
          <FormField id="billing-amount" label={t('settings.billing.auto.amount')}>
            <Select
              id="billing-amount"
              size="sm"
              value={String(auto.amountCents)}
              options={options(
                AMOUNT_CHOICES.includes(auto.amountCents as never)
                  ? AMOUNT_CHOICES
                  : [...AMOUNT_CHOICES, auto.amountCents].sort((a, b) => a - b),
                c => amountFits(auto.thresholdCents, c),
              )}
              onChange={v => void save({ ...auto, amountCents: Number(v) })}
              label={t('settings.billing.auto.amount')}
            />
          </FormField>
        </div>
      )}
      <div className="swrow">
        <div>
          <b>{t('settings.billing.cap.title')}</b>
          <span className="help">
            {t(bill.taxed ? 'settings.billing.cap.textTaxed' : 'settings.billing.cap.text', {
              cap: money(bill.cap.effectiveCents),
              used: money(bill.cap.usedThisMonthCents),
            })}
          </span>
        </div>
        <Button
          size="sm"
          disabled={!editable}
          title={t('settings.billing.cap.buttonTip')}
          onClick={() => setCapOpen(true)}
        >
          {t('settings.billing.cap.button')}
        </Button>
      </div>
      {capOpen && <CapDialog bill={bill} onClose={() => setCapOpen(false)} toast={toast} />}
    </Section>
  )
}

/** The monthly cap's base. Raising it confirms it is the owner (passkey, or a sign-in in the last minutes). */
function CapDialog({
  bill,
  onClose,
  toast,
}: {
  bill: BillingOverviewBill
  onClose: () => void
  toast: (text: string) => void
}) {
  const t = useT()
  const calls = useBillCalls()
  const format = useFormat()
  const [text, setText] = useState(String(centsToDollars(bill.cap.baseCents)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signIn, setSignIn] = useState(false)
  const min = 2000
  const cents = dollarsToCents(text, min, bill.cap.ownerMaxBaseCents)
  const money = (c: number) => format.currency(centsToDollars(c), 'USD', { maximumFractionDigits: 0 })
  const extra = bill.cap.effectiveCents - bill.cap.baseCents

  async function save() {
    if (cents === null) return
    setBusy(true)
    setError(null)
    const workspaceId = tabWorkspace()
    let attempt = 0
    try {
      const done = await withPasskeyStepUp(async () => {
        // The passkey dialog signs in again (a new session): the retry makes this workspace the session's again.
        if (attempt++ > 0 && workspaceId) await auth.organization.setActive({ organizationId: workspaceId })
        return calls.write<RechargeCapData>('billing.setRechargeCap', { baseCents: cents })
      }, t('settings.billing.cap.stepUpWhat'))
      toast(t('settings.billing.cap.saved', { cap: money(done.effectiveCents) }))
      void calls.reload()
      onClose()
    } catch (err) {
      if ((err as { code?: string }).code === 'SIGN_IN_AGAIN') setSignIn(true)
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  function signInFirst() {
    window.history.replaceState(null, '', `#workspace/billing${workspaceQuery()}`)
    void signInAgain()
  }

  return (
    <Dialog
      title={t('settings.billing.cap.dialogTitle')}
      description={t(bill.taxed ? 'settings.billing.cap.dialogTextTaxed' : 'settings.billing.cap.dialogText', {
        max: money(bill.cap.ownerMaxBaseCents + extra),
      })}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={cents === null}>
            {t('settings.billing.cap.save')}
          </Button>
        </>
      }
    >
      <FormField
        id="billing-cap"
        label={t('settings.billing.cap.base')}
        description={
          extra > 0
            ? t(
                bill.kind === 'partner'
                  ? 'settings.billing.cap.perWorkspacePartner'
                  : 'settings.billing.cap.perWorkspace',
                {
                  extra: money(extra),
                },
              )
            : t('settings.billing.cap.baseHelp')
        }
        error={
          text && cents === null
            ? t('settings.billing.cap.invalid', { min: money(min), max: money(bill.cap.ownerMaxBaseCents) })
            : null
        }
      >
        <Input
          id="billing-cap"
          inputMode="numeric"
          value={text}
          autoFocus
          invalid={!!text && cents === null}
          onChange={e => setText(e.target.value)}
        />
      </FormField>
      {error && !signIn && <Note tone="danger">{error}</Note>}
      {signIn && (
        <Note
          tone="warning"
          title={t('settings.billing.cap.signInTitle')}
          action={
            <Button size="sm" title={t('settings.billing.cap.signInTip')} onClick={signInFirst}>
              {t('settings.billing.cap.signIn')}
            </Button>
          }
        >
          {t('settings.billing.cap.signInText')}
        </Note>
      )}
    </Dialog>
  )
}

/** `?ws=<id>` so signing in again comes back to this workspace. */
function workspaceQuery() {
  const id = tabWorkspace()
  return id ? `?ws=${encodeURIComponent(id)}` : ''
}

// ---- Usage -----------------------------------------------------------------------------------------------------

function UsageCard({ bill }: { bill: BillingOverviewBill }) {
  const t = useT()
  const format = useFormat()
  const period = bill.period
  return (
    <Section
      id="billing-usage"
      title={t('settings.billing.usage.title')}
      description={
        period
          ? t('settings.billing.usage.period', {
              from: format.date(new Date(period.startsAt)),
              to: format.date(new Date(period.endsAt)),
            })
          : undefined
      }
    >
      <UsageRows rows={bill.usage} />
    </Section>
  )
}

/** The usage lines, one per workspace: the included minutes used, the paid minutes per level and what they cost. */
/** `minutesOnly`: no amounts (a client workspace on its partner's bill, whose partner sets what it charges). */
function UsageRows({ rows, minutesOnly = false }: { rows: BillingUsageRow[]; minutesOnly?: boolean }) {
  const t = useT()
  const format = useFormat()
  return (
    <>
      {rows.length === 0 ? (
        <ListEmpty>{t('settings.billing.usage.empty')}</ListEmpty>
      ) : (
        <List label={t('settings.billing.usage.title')}>
          {rows.map(row => {
            const line = usageLine(row)
            const parts = [
              line.standard && t('settings.billing.usage.standard', { count: line.standard }),
              line.premium && t('settings.billing.usage.premium', { count: line.premium }),
              line.ultra && t('settings.billing.usage.ultra', { count: line.ultra }),
              line.ownKeys && t('settings.billing.usage.ownKeys', { count: line.ownKeys }),
            ].filter((p): p is string => !!p)
            return (
              <ListRow
                key={row.workspaceId}
                title={row.name ?? t('settings.billing.usage.deletedWorkspace')}
                sub={[
                  t('settings.billing.usage.included', { used: line.includedUsedMinutes, of: line.includedMinutes }),
                  parts.length ? format.list(parts) : t('settings.billing.usage.noCalls'),
                ].join(' · ')}
                aside={minutesOnly ? undefined : format.currency(microsToDollars(line.costMicros), 'USD')}
              />
            )
          })}
        </List>
      )}
    </>
  )
}

// ---- Invoices and the portal -----------------------------------------------------------------------------------

function InvoicesCard({ bill, toast }: { bill: BillingOverviewBill; toast: (text: string) => void }) {
  const t = useT()
  const calls = useBillCalls()
  const format = useFormat()
  const [opening, setOpening] = useState(false)

  async function portal() {
    setOpening(true)
    try {
      const { url } = await calls.write<PortalData>('billing.openPortal')
      window.location.assign(url)
    } catch (err) {
      toast(errorMessage(err))
      setOpening(false)
    }
  }

  return (
    <Section
      id="billing-invoices"
      title={t('settings.billing.invoices.title')}
      description={t('settings.billing.invoices.description')}
      actions={
        bill.hasPortal && (
          <Button size="sm" busy={opening} title={t('settings.billing.portal.buttonTip')} onClick={() => void portal()}>
            {t('settings.billing.portal.button')}
          </Button>
        )
      }
    >
      {bill.invoices.length === 0 ? (
        <ListEmpty>{t('settings.billing.invoices.empty')}</ListEmpty>
      ) : (
        <List label={t('settings.billing.invoices.title')}>
          {bill.invoices.map(inv => {
            // The trial's $0.00 plan invoice (Stripe makes one when the trial starts): named so, no amount or status.
            const trial = inv.kind === 'subscription' && inv.totalCents === 0
            return (
              <ListRow
                key={inv.id}
                // i18n-dynamic: settings.billing.invoices.kind.* settings.billing.invoices.status.*
                title={
                  trial
                    ? t('settings.billing.invoices.trial')
                    : t(`settings.billing.invoices.kind.${inv.kind}` as MessageKey)
                }
                sub={[
                  format.date(new Date(inv.createdAt)),
                  inv.number,
                  // Tax as its own line: the total above includes it; the balance never got it.
                  inv.taxCents > 0 &&
                    t('settings.billing.invoices.tax', {
                      amount: format.currency(centsToDollars(inv.taxCents), 'USD'),
                    }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                aside={
                  !trial && (
                    <>
                      {format.currency(centsToDollars(inv.totalCents), 'USD')}{' '}
                      <Badge tone={inv.status === 'open' ? 'danger' : 'neutral'}>
                        {t(`settings.billing.invoices.status.${inv.status}` as MessageKey)}
                      </Badge>
                    </>
                  )
                }
                actions={
                  inv.url && (
                    <ExternalLink href={inv.url}>
                      {inv.status === 'open' ? t('settings.billing.invoices.pay') : t('settings.billing.invoices.view')}
                    </ExternalLink>
                  )
                }
              />
            )
          })}
        </List>
      )}
    </Section>
  )
}
