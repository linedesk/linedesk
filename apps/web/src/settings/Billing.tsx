// Workspace settings › Billing (docs/billing.md §8, §11 PR 9): the bill owner's page on Linedesk Cloud. The plan and
// its state in plain words (trial countdown, past due, suspended and why, canceled), the balance with "Buy minutes"
// (Stripe Checkout), a failed recharge with Retry, auto-recharge and the monthly cap (raising it confirms it is them),
// this period's usage per workspace and level, the latest invoices with Stripe's pages, the Stripe portal for the card
// and every invoice, and cancel in two clicks (US click-to-cancel). Shown only while the workspace is on a bill
// (`me.workspace.billingState`). Anyone else with the section (the workspace's owners and admins) reads that someone
// else pays and sees this workspace's usage, read-only (`billing.workspaceUsage`, docs/billing.md §8).
import type {
  AutoRechargeData,
  BillingOverviewBill,
  BillingOverviewData,
  BillingStateData,
  BillingUsageRow,
  CancelData,
  PortalData,
  RechargeCapData,
  RetryRechargeData,
  TopUpData,
} from '@linedesk/actions'
import { TOPUP_CENTS } from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { PASSKEY_STEP_UP_REQUIRED, StepUpRequired, withPasskeyStepUp } from '../admin/PasskeyStepUp.tsx'
import { auth } from '../auth.ts'
import { refreshQuery, setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { signInAgain } from '../localData.ts'
import { tabWorkspace } from '../tabWorkspace.ts'
import { ExternalLink } from '../ui/AppLink.tsx'
import { Select } from '../ui/controls.tsx'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { Dialog, FormField, Input } from '../ui/form.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import {
  AMOUNT_CHOICES,
  amountFits,
  canCancel,
  canResume,
  centsToDollars,
  changesRecharge,
  dollarsToCents,
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

/** After a change: the page reads the bill again (balance, recharges, the state). */
const reloadBill = () => Promise.all([refreshQuery(OVERVIEW), refreshQuery(STATE)])

/** `owner`: may manage billing (`billing:manage`, the workspace's owner); everyone else gets the usage view alone. */
type Props = { toast: (text: string) => void; owner?: boolean }

export function Billing({ toast, owner = true }: Props) {
  if (!owner) return <NotPaying />
  return <OwnerBilling toast={toast} />
}

function OwnerBilling({ toast }: { toast: (text: string) => void }) {
  const t = useT()
  const overview = useQuery(OVERVIEW, loadOverview)
  const state = useQuery(STATE, loadState)
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
          <NotPaying />
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
 * For the workspace's owners and admins who do not pay (docs/billing.md §8: workspace admins see usage only): who
 * handles billing, and this workspace's usage this period. No plan, balance, invoices or payment controls.
 */
function NotPaying() {
  const t = useT()
  const format = useFormat()
  const read = useQuery(WORKSPACE_USAGE, loadWorkspaceUsage)
  const usage = read.data?.usage
  const period = usage?.period
  return (
    <>
      <Section id="billing-none" title={t('settings.workspace.nav.billing.label')}>
        <span className="help">{t('settings.billing.notOwner')}</span>
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
            <UsageRows rows={usage.row ? [usage.row] : []} />
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
  return (
    <>
      <PlanCard bill={bill} state={state} toast={toast} />
      {(pays || bill.balanceMicros !== 0) && <BalanceCard bill={bill} toast={toast} />}
      {pays && <AutoRechargeCard bill={bill} toast={toast} />}
      <UsageCard bill={bill} />
      <InvoicesCard bill={bill} toast={toast} />
    </>
  )
}

// ---- The plan --------------------------------------------------------------------------------------------------

function PlanCard({
  bill,
  state,
  toast,
}: {
  bill: BillingOverviewBill
  state: BillingStateData['bill']
  toast: (text: string) => void
}) {
  const t = useT()
  const format = useFormat()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [resuming, setResuming] = useState(false)
  const supportEmail = useLegalLinks()?.supportEmail ?? null
  const date = (iso: string) => format.date(new Date(iso))
  const badge = statusBadge(bill.status, bill.heldForReview)
  const line = planLine(bill)
  const note = stateNote(state, date)
  const price = format.currency(centsToDollars(bill.seatCents), 'USD')
  const plan = !paysCharges(bill)
    ? t('settings.billing.plan.comped', { count: bill.workspaces })
    : bill.interval === 'year'
      ? t('settings.billing.plan.yearly', { price, count: bill.workspaces })
      : t('settings.billing.plan.monthly', { price, count: bill.workspaces })
  const held = bill.heldForReview && (bill.status === 'active' || bill.status === 'trialing')

  async function resume() {
    setResuming(true)
    try {
      const done = await write<CancelData>('billing.resume')
      setQueryData<BillingOverviewData | undefined>(OVERVIEW, d =>
        d?.bill ? { ...d, bill: { ...d.bill, cancelAtPeriodEnd: done.cancelAtPeriodEnd } } : d,
      )
      toast(t('settings.billing.plan.resumed'))
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setResuming(false)
      void reloadBill()
    }
  }

  return (
    <Section
      id="billing-plan"
      title={t('settings.billing.plan.title')}
      actions={
        <Badge tone={badge.tone} dot>
          {t(badge.key)}
        </Badge>
      }
    >
      <div className="billing-plan">
        <b>{plan}</b>
        {line && (
          <span className="help">
            {line.days !== undefined
              ? t(line.key, { date: date(line.date), count: line.days })
              : t(line.key, { date: date(line.date) })}
          </span>
        )}
        {bill.status === 'trialing' && <span className="help">{t('settings.billing.plan.trialNote')}</span>}
        {bill.extraNumberCents > 0 && (
          <span className="help">
            {t('settings.billing.plan.numbers', {
              price: format.currency(centsToDollars(bill.extraNumberCents), 'USD', {
                minimumFractionDigits: bill.extraNumberCents % 100 ? 2 : 0,
              }),
            })}
          </span>
        )}
      </div>
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
      {(canCancel(bill) || canResume(bill)) && (
        <div className="billing-actions">
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
    </Section>
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
  const format = useFormat()
  const supportEmail = useLegalLinks()?.supportEmail ?? null
  const end = bill.status === 'trialing' ? bill.trialEndsAt : bill.currentPeriodEnd
  const endText = end ? format.date(new Date(end)) : null
  // What is refunded on request (the terms' "Refunds", docs/billing.md §4.5): a yearly plan paid in the last 14 days,
  // and the unused balance. Both are asked for, never automatic.
  const refund = yearlyRefundLine(bill, iso => format.date(new Date(iso)))
  const balance = bill.availableMicros > 0 ? format.currency(microsToDollars(bill.availableMicros), 'USD') : null
  const ask = supportEmail ? t('settings.billing.cancel.ask', { email: supportEmail }) : null
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
          t('settings.billing.cancel.numbers'),
          t('settings.billing.cancel.data'),
        ],
        action: t('settings.billing.cancel.confirm'),
        busyAction: t('settings.billing.cancel.busy'),
        // Never "Cancel" next to "Cancel plan": backing out says what it does (security review of #1007, L-4).
        dismiss: t('settings.billing.cancel.keep'),
      }}
      run={async () => {
        try {
          const done = await write<CancelData>('billing.cancel')
          setQueryData<BillingOverviewData | undefined>(OVERVIEW, d =>
            d?.bill ? { ...d, bill: { ...d.bill, cancelAtPeriodEnd: done.cancelAtPeriodEnd } } : d,
          )
        } catch (err) {
          throw new Error(errorMessage(err))
        }
        void reloadBill()
        toast(t('settings.billing.cancel.done'))
        onClose()
      }}
      onClose={onClose}
    />
  )
}

// ---- The balance -----------------------------------------------------------------------------------------------

/** An empty tab opened while the click is still handled, cut off from this page; null when the browser blocked it. */
function openBlankTab(): Window | null {
  const tab = window.open('', '_blank')
  if (tab) tab.opener = null
  return tab
}

function BalanceCard({ bill, toast }: { bill: BillingOverviewBill; toast: (text: string) => void }) {
  const t = useT()
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
      const done = await write<RetryRechargeData>('billing.retryRecharge')
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
      void reloadBill()
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
            : bill.autoRecharge.on
              ? t('settings.billing.retry.declined', { count: failure.retriesLeft })
              : t('settings.billing.retry.declinedAutoOff')}
        </Note>
      )}
      {bill.canBuyMinutes && paysCharges(bill) && (
        <div className="billing-actions">
          <Button
            // One primary button per screen: Retry takes it while a recharge failed.
            variant={failure ? 'secondary' : 'primary'}
            icon="plus"
            title={t('settings.billing.topUp.buttonTip')}
            onClick={() => setBuying(true)}
          >
            {t('settings.billing.topUp.button')}
          </Button>
        </div>
      )}
      {buying && <TopUpDialog onClose={() => setBuying(false)} toast={toast} />}
    </Section>
  )
}

/**
 * "Buy minutes": $5, $10, $20 or another whole amount up to $500. "Pay" first shows which saved card would be charged
 * (brand and last four); "Charge" then charges it at once, after the owner confirms it is them (passkey or a recent
 * sign-in, as for raising the cap). Without a saved card, over the daily limit, or when the bank wants a confirmation,
 * the server answers a Stripe Checkout instead. "Use another card" goes to Checkout directly.
 */
function TopUpDialog({ onClose, toast }: { onClose: () => void; toast: (text: string) => void }) {
  const t = useT()
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
                const answer = await write<TopUpData>('billing.startTopUp', input, { idempotencyKey })
                keys.settle()
                return answer
              } catch (err) {
                keys.settle(err)
                throw err
              }
            }, t('settings.billing.topUp.stepUpWhat'))
          : await write<TopUpData>('billing.startTopUp', input)
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
      await reloadBill()
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
                ? t('settings.billing.topUp.charge', {
                    amount: format.currency(centsToDollars(cents), 'USD'),
                    card: cardName,
                  })
                : t('settings.billing.topUp.pay', { amount: format.currency(centsToDollars(cents), 'USD') })}
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
    </Dialog>
  )
}

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
    setQueryData<BillingOverviewData | undefined>(OVERVIEW, d =>
      d?.bill ? { ...d, bill: { ...d.bill, autoRecharge: input } } : d,
    )
    try {
      const done = await write<AutoRechargeData>('billing.setAutoRecharge', input)
      toast(done.recharging ? t('settings.billing.auto.savedRecharging') : t('settings.billing.auto.saved'))
    } catch (err) {
      setQueryData<BillingOverviewData | undefined>(OVERVIEW, d =>
        d?.bill ? { ...d, bill: { ...d.bill, autoRecharge: before } } : d,
      )
      toast(errorMessage(err))
    } finally {
      void reloadBill()
    }
  }

  return (
    <Section id="billing-auto" title={t('settings.billing.auto.title')}>
      <SwitchRow
        title={t('settings.billing.auto.switch')}
        description={
          auto.on
            ? t('settings.billing.auto.onText', {
                threshold: money(auto.thresholdCents),
                amount: money(auto.amountCents),
              })
            : t('settings.billing.auto.offText')
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
            {t('settings.billing.cap.text', {
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
        return write<RechargeCapData>('billing.setRechargeCap', { baseCents: cents })
      }, t('settings.billing.cap.stepUpWhat'))
      toast(t('settings.billing.cap.saved', { cap: money(done.effectiveCents) }))
      void reloadBill()
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
      description={t('settings.billing.cap.dialogText', { max: money(bill.cap.ownerMaxBaseCents + extra) })}
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
            ? t('settings.billing.cap.perWorkspace', { extra: money(extra) })
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
function UsageRows({ rows }: { rows: BillingUsageRow[] }) {
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
                aside={format.currency(microsToDollars(line.costMicros), 'USD')}
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
  const format = useFormat()
  const [opening, setOpening] = useState(false)

  async function portal() {
    setOpening(true)
    try {
      const { url } = await write<PortalData>('billing.openPortal')
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
          {bill.invoices.map(inv => (
            <ListRow
              key={inv.id}
              // i18n-dynamic: settings.billing.invoices.kind.* settings.billing.invoices.status.*
              title={t(`settings.billing.invoices.kind.${inv.kind}` as MessageKey)}
              sub={[format.date(new Date(inv.createdAt)), inv.number].filter(Boolean).join(' · ')}
              aside={
                <>
                  {format.currency(centsToDollars(inv.totalCents), 'USD')}{' '}
                  <Badge tone={inv.status === 'open' ? 'danger' : 'neutral'}>
                    {t(`settings.billing.invoices.status.${inv.status}` as MessageKey)}
                  </Badge>
                </>
              }
              actions={
                inv.url && (
                  <ExternalLink href={inv.url}>
                    {inv.status === 'open' ? t('settings.billing.invoices.pay') : t('settings.billing.invoices.view')}
                  </ExternalLink>
                )
              }
            />
          ))}
        </List>
      )}
    </Section>
  )
}
