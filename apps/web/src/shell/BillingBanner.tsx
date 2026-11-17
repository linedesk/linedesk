// The bill owner's billing line above every page (docs/billing.md §3.4, §4.3, §11 PR 9): paused calls, a canceled
// plan, a failed payment or recharge, an unpaid number, the monthly cap reached, a low balance with auto-recharge off.
// One line, the most pressing first (billingBanner), leading to Workspace settings › Billing. It reads `billing.state`
// only (a few rows, cached with the page's: settings/billingQueries.ts), never the page's overview. Only for the bill
// owner while the workspace is on a bill; nothing otherwise.
//
// In the trial, once most of its minutes are used (docs/billing.md §3.2 step 7), the line offers one button instead:
// "Keep calls answered" buys the auto-recharge amount with the saved card it names (Buy minutes' path: the owner
// confirms it is them first) and turns auto-recharge on for the rest of the trial. Its tooltip has the full terms.
//
// When callers of the workspace got a busy line today (LIN-450), the least pressing line says how many and offers one
// button: 5 more calls at the same time for the price a month (Settings › Billing's path, with the owner step-up),
// and a link to Settings › Billing for other amounts.
import type { BusyLinePrompt, ExtraCallsData, TopUpData, TrialMinutesPrompt } from '@linedesk/actions'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { PASSKEY_STEP_UP_REQUIRED, StepUpRequired, withPasskeyStepUp } from '../admin/PasskeyStepUp.tsx'
import { auth } from '../auth.ts'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import {
  ADD_CALLS_PARAM,
  billingBanner,
  centsToDollars,
  purchaseKeys,
  refusalKey,
  trialRechargeInput,
} from '../settings/billingModel.ts'
import { loadState, OVERVIEW, STATE } from '../settings/billingQueries.ts'
import { callAction } from '../settings/settings-api.ts'
import { tabWorkspace } from '../tabWorkspace.ts'
import { AppLink } from '../ui/AppLink.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'

const BILLING_HASH = '#workspace/billing'

export function BillingBanner({ toast }: { toast: (text: string) => void }) {
  const t = useT()
  const state = useQuery(STATE, () => loadState())
  const banner = billingBanner(state.data?.bill ?? null)
  if (!banner) return null
  return (
    <div className={cx('setup-bar', `is-${banner.tone}`)} role="status">
      <Icon name={banner.tone === 'danger' ? 'alert' : 'warning'} size={15} />
      {banner.trial ? (
        <TrialPrompt prompt={banner.trial} lineKey={banner.key} toast={toast} />
      ) : banner.busy ? (
        <BusyLine prompt={banner.busy} lineKey={banner.key} toast={toast} />
      ) : (
        <span>
          <b>{t(banner.key)}</b>
          {' · '}
          <AppLink to={BILLING_HASH} title={t('settings.billing.banner.openTip')}>
            {t('settings.billing.banner.open')}
          </AppLink>
        </span>
      )}
    </div>
  )
}

type Card = NonNullable<TrialMinutesPrompt['card']>

/** "Visa ending in 4242", or "your saved card" when the card could not be read. */
function cardName(card: Pick<Card, 'brand' | 'last4'> | null, t: ReturnType<typeof useT>) {
  if (!card?.brand || !card.last4) return t('settings.billing.topUp.cardUnknown')
  return t('settings.billing.topUp.card', {
    brand: card.brand.charAt(0).toUpperCase() + card.brand.slice(1),
    last4: card.last4,
  })
}

/** The purchase's write; a passkey step-up refusal becomes StepUpRequired, so withPasskeyStepUp can ask for it. */
async function buy(input: object, idempotencyKey: string): Promise<TopUpData> {
  try {
    return await callAction<TopUpData>('billing.startTopUp', input, { idempotencyKey })
  } catch (err) {
    if ((err as { code?: string }).code === PASSKEY_STEP_UP_REQUIRED)
      throw Object.assign(new StepUpRequired((err as Error).message, 'confirm'), {
        status: (err as { status?: number }).status,
      })
    throw err
  }
}

/**
 * The trial prompt's line and its one button. The card shown is the card charged: when the server reads another card
 * than the one on screen (or none was readable), the line names it and nothing is charged until the next press.
 */
function TrialPrompt({
  prompt,
  lineKey,
  toast,
}: {
  prompt: TrialMinutesPrompt
  lineKey: Parameters<ReturnType<typeof useT>>[0]
  toast: (text: string) => void
}) {
  const t = useT()
  const format = useFormat()
  const [card, setCard] = useState<Card | null>(prompt.card)
  const [busy, setBusy] = useState(false)
  // The charge's command id, kept across presses while its outcome is unknown (never charged twice).
  const [keys] = useState(() => purchaseKeys())
  // Whole dollars without cents ("$25"): one short line.
  const usd = (cents: number) =>
    format.currency(
      centsToDollars(cents),
      'USD',
      cents % 100 === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {},
    )
  const values = {
    used: prompt.usedMinutes,
    included: prompt.includedMinutes,
    amount: usd(prompt.amountCents),
    card: cardName(card, t),
    threshold: usd(prompt.thresholdCents),
    cap: usd(prompt.capCents),
    date: prompt.freeUntil ? format.date(new Date(prompt.freeUntil), { dateStyle: 'long' }) : '',
    rate: format.centRate(prompt.standardMicrosPerMinute / 1_000_000, 'USD'),
  }

  async function keep() {
    setBusy(true)
    const workspaceId = tabWorkspace()
    let attempt = 0
    const input = trialRechargeInput(prompt, card)
    try {
      const done = await withPasskeyStepUp(async () => {
        // The passkey dialog signs in again (a new session): the retry makes this workspace the session's again.
        if (attempt++ > 0 && workspaceId) await auth.organization.setActive({ organizationId: workspaceId })
        const idempotencyKey = keys.keyFor(`${prompt.amountCents}:${card?.id ?? ''}`)
        try {
          const answer = await buy(input, idempotencyKey)
          keys.settle()
          return answer
        } catch (err) {
          keys.settle(err)
          throw err
        }
      }, t('settings.billing.topUp.stepUpWhat'))
      if (done.kind === 'confirm') {
        // Another card than the line named (or none was known): named now, charged on the next press.
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
      const amount = usd(done.amountCents)
      toast(
        done.kind === 'paid' && done.credited
          ? t('settings.billing.topUp.paid', { amount })
          : t('settings.billing.topUp.processing', { amount }),
      )
      // The trial recharge is on now: the line goes, and the billing page shows the new balance.
      await Promise.all([refreshQuery(STATE), refreshQuery(OVERVIEW)])
    } catch (err) {
      const key = refusalKey((err as { code?: string }).code)
      toast(key ? t(key) : err instanceof Error && err.message ? err.message : t('settings.billing.error.generic'))
      setBusy(false)
    }
  }

  return (
    <>
      <span>
        <b>{t(lineKey, values)}</b>
      </span>
      <Button
        size="sm"
        variant="primary"
        busy={busy}
        title={t('settings.billing.banner.keepAnsweredTip', values)}
        onClick={() => void keep()}
      >
        {t('settings.billing.banner.keepAnswered')}
      </Button>
    </>
  )
}

/** "Add 5 more lines": the workspace's extra calls one step up; a passkey refusal becomes StepUpRequired. */
async function addLines(prompt: BusyLinePrompt): Promise<ExtraCallsData> {
  try {
    return await callAction<ExtraCallsData>('billing.setExtraCalls', {
      workspaceId: prompt.workspaceId,
      extraCalls: prompt.extraCalls + prompt.step,
      from: 'busy_line',
    })
  } catch (err) {
    if ((err as { code?: string }).code === PASSKEY_STEP_UP_REQUIRED)
      throw Object.assign(new StepUpRequired((err as Error).message, 'confirm'), {
        status: (err as { status?: number }).status,
      })
    throw err
  }
}

/**
 * The busy-line line (LIN-450): how many callers got a busy line today, and one button that adds a step of calls at
 * the same time at the price it names (charged now, prorated, with the plan's card), or the way to Settings › Billing
 * when the button cannot (the trial, an instance admin's cap, the most reached). Other amounts are in Settings › Billing.
 */
function BusyLine({
  prompt,
  lineKey,
  toast,
}: {
  prompt: BusyLinePrompt
  lineKey: Parameters<ReturnType<typeof useT>>[0]
  toast: (text: string) => void
}) {
  const t = useT()
  const format = useFormat()
  const [busy, setBusy] = useState(false)
  const price = format.currency(
    centsToDollars(prompt.stepCents),
    'USD',
    prompt.stepCents % 100 === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {},
  )
  const values = { callers: prompt.callers, count: prompt.limit, step: prompt.step, price }

  async function add() {
    setBusy(true)
    const workspaceId = tabWorkspace()
    let attempt = 0
    try {
      const done = await withPasskeyStepUp(async () => {
        // The passkey dialog signs in again (a new session): the retry makes this workspace the session's again.
        if (attempt++ > 0 && workspaceId) await auth.organization.setActive({ organizationId: workspaceId })
        return addLines(prompt)
      }, t('settings.billing.calls.stepUpWhat'))
      toast(t('settings.billing.calls.saved', { count: done.limit }))
      await Promise.all([refreshQuery(STATE), refreshQuery(OVERVIEW)])
    } catch (err) {
      setBusy(false)
      // A sign-in from the last few minutes is needed: Settings › Billing asks for it, with the same dialog open.
      if ((err as { code?: string }).code === 'SIGN_IN_AGAIN') {
        window.location.hash = `${BILLING_HASH}?${ADD_CALLS_PARAM}=1`
        return
      }
      const key = refusalKey((err as { code?: string }).code)
      toast(key ? t(key) : err instanceof Error && err.message ? err.message : t('settings.billing.error.generic'))
    }
  }

  return (
    <>
      <span>
        <b>{t(lineKey, values)}</b>
        {' · '}
        <AppLink to={BILLING_HASH} title={t('settings.billing.banner.openTip')}>
          {prompt.canAdd ? t('settings.billing.banner.busyOther') : t('settings.billing.banner.open')}
        </AppLink>
      </span>
      {prompt.canAdd && (
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          title={t('settings.billing.banner.busyAddTip', values)}
          onClick={() => void add()}
        >
          {t('settings.billing.banner.busyAdd', values)}
        </Button>
      )}
    </>
  )
}
