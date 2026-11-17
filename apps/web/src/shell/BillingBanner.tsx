// The bill owner's billing line above every page (docs/billing.md §3.4, §4.3, §11 PR 9): paused calls, a canceled
// plan, a failed payment or recharge, an unpaid number, the monthly cap reached, a low balance with auto-recharge off.
// One line, the most pressing first (billingBanner), leading to Workspace settings › Billing. It reads `billing.state`
// only (a few rows, cached with the page's: settings/billingQueries.ts), never the page's overview. Only for the bill
// owner while the workspace is on a bill; nothing otherwise.
import { useT } from '@linedesk/i18n/react'
import { useQuery } from '../cachedQuery.ts'
import { billingBanner } from '../settings/billingModel.ts'
import { loadState, STATE } from '../settings/billingQueries.ts'
import { AppLink } from '../ui/AppLink.tsx'
import { cx, Icon } from '../ui/kit.tsx'

const BILLING_HASH = '#workspace/billing'

export function BillingBanner() {
  const t = useT()
  const state = useQuery(STATE, loadState)
  const banner = billingBanner(state.data?.bill ?? null)
  if (!banner) return null
  return (
    <div className={cx('setup-bar', `is-${banner.tone}`)} role="status">
      <Icon name={banner.tone === 'danger' ? 'alert' : 'warning'} size={15} />
      <span>
        <b>{t(banner.key)}</b>
        {' · '}
        <AppLink to={BILLING_HASH} title={t('settings.billing.banner.openTip')}>
          {t('settings.billing.banner.open')}
        </AppLink>
      </span>
    </div>
  )
}
