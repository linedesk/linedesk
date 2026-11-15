// While an instance admin is signed in as another user: a bar under every page saying whose
// session this is, how long it lasts, and the way back. The app sits above it, so nothing of the
// app (hints, offline bar, toasts) is covered.
import { type ReactNode, useEffect, useState } from 'react'
import {
  bannerText,
  type Impersonation,
  minutesLeft,
  remainingText,
  stopImpersonation,
  UnsentChanges,
} from '../impersonation.ts'
import { Button } from '../ui/kit.tsx'
import { useNow } from './useNow.ts'
import { useT } from '@linedesk/i18n/react'

export function ImpersonationFrame({
  impersonation,
  children,
}: {
  impersonation: Impersonation | null
  children: ReactNode
}) {
  if (!impersonation) return <>{children}</>
  return (
    <div className="imp-frame">
      <div className="imp-content">{children}</div>
      <ImpersonationBar impersonation={impersonation} />
    </div>
  )
}

function ImpersonationBar({ impersonation }: { impersonation: Impersonation }) {
  const t = useT()
  const now = useNow(15_000)
  const left = minutesLeft(impersonation.expiresAt, now)
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [discardUnsent, setDiscardUnsent] = useState(false)
  const text = bannerText(impersonation)

  // The session has ended on the server: reloading shows sign-in.
  useEffect(() => {
    if (left > 0) return
    const id = setTimeout(() => window.location.reload(), 1500)
    return () => clearTimeout(id)
  }, [left])

  async function back() {
    if (busy) return
    setBusy(true)
    try {
      // A second press after the warning discards what could not be sent, like signing out.
      await stopImpersonation(impersonation.user.id, discardUnsent)
    } catch (err) {
      const unsent = err instanceof UnsentChanges
      setDiscardUnsent(unsent)
      setWarning(unsent ? err.message : t('shell.impersonation.returnFailed', { reason: err instanceof Error ? err.message : String(err) }))
      setBusy(false)
    }
  }

  return (
    <div className="imp-bar" role="region" aria-label={t('shell.impersonation.region')}>
      <span className="imp-text">
        <b>{text.who}</b>
        {text.email && <span className="imp-wide"> ({text.email})</span>}
        <span className="imp-wide"> · {text.by}</span>
        <span className="imp-left"> · {remainingText(left)}</span>
      </span>
      {warning && (
        <span className="imp-warning" role="alert">
          {warning}
        </span>
      )}
      <Button
        size="sm"
        className="imp-back"
        disabled={busy}
        title={t('shell.impersonation.returnTip', { name: impersonation.by.name || impersonation.by.email })}
        onClick={() => void back()}
      >
        {t('shell.impersonation.return')}
      </Button>
    </div>
  )
}
