// A sign-up waiting for Checkout (docs/billing.md §3.2): the workspace is `pending_payment` until a card is added and
// the free trial (its length set per install, Server admin › Billing) starts. Nothing else of the app opens before (no number, no test call, no setup link: the API
// refuses those too, apps/api/src/self-serve.ts). "Add a card" goes to Stripe Checkout; it comes back to
// /billing/return (CheckoutReturn.tsx).
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import type { Me } from './auth.ts'
import { goToCheckout } from './checkout.ts'
import { planWords } from './signup.ts'
import { signOutAndForget } from './localData.ts'
import { AuthError } from './ui/AuthError.tsx'
import { AuthPage, cx, Spinner } from './ui/kit.tsx'

export function PendingPayment({ me, onDone }: { me: Me; onDone: () => void | Promise<void> }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const start = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await goToCheckout()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }
  return (
    <AuthPage>
      <div className="auth-card">
        <h1>{t('auth.pendingPayment.title', { workspace: me.workspace?.name ?? '' })}</h1>
        <p>
          {me.workspace?.trialDays
            ? t('auth.pendingPayment.trialText', { days: me.workspace.trialDays })
            : t('auth.pendingPayment.trialTextNoDays')}
        </p>
        {me.workspace?.plan && (
          <p className="auth-hint">
            {t('auth.pendingPayment.plan', { plan: planWords(me.workspace.plan.interval, me.workspace.plan.cents) })}
          </p>
        )}
        {failed && <AuthError message={t('auth.checkout.startFailed')} />}
        <button
          type="button"
          className={cx('k-btn k-btn-primary', busy && 'is-busy')}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void start()}
        >
          {busy && <Spinner />}
          {busy ? t('auth.checkout.opening') : t('auth.checkout.addCard')}
        </button>
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>
          {t('auth.differentAccount')}
        </button>
      </div>
    </AuthPage>
  )
}
