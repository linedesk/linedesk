// The way back to Integrations from a place an integration is set up outside it (the assistant's booking page for
// calendars, Advanced › Webhook for Make, n8n and webhooks) (LIN-735). Integrations marks the trip in sessionStorage
// before it leaves, so the mark survives a provider's sign-in page; the page shows Done (back to Integrations) while the mark is
// there, and drops it when the person leaves that page.
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { Button } from '../ui/kit.tsx'
import './integrations.css'

const KEY = 'linedesk.fromIntegrations'
const HOME = '#integrations'

/** Before Integrations sends the person to a place outside it. */
export function markFromIntegrations() {
  try {
    sessionStorage.setItem(KEY, '1')
  } catch {}
}

function marked(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function unmark() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {}
}

/**
 * Done at the bottom right, back to Integrations, as on every integration's own page; only when the person came from
 * Integrations. At the bottom, since the webhook link scrolls the page down to its card, the last one.
 */
export function BackToIntegrations() {
  const t = useT()
  const [shown] = useState(marked)
  useEffect(() => unmark, [])
  if (!shown) return null
  return (
    <div className="ig-detail-foot">
      <Button
        variant="primary"
        onClick={() => (window.location.hash = HOME)}
        title={t('settings.integrations.doneBackTip')}
      >
        {t('settings.integrations.done')}
      </Button>
    </div>
  )
}
