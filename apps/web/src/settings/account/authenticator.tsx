// Setting up an authenticator app, the fallback to the passkey for Server admin (authenticator-api.ts), in Account ›
// Sign-in & security (index.tsx): a new secret shown as a QR code and a key, then the first code from the app.
import type { AuthenticatorStartData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import {
  AuthenticatorRequestError,
  confirmAuthenticator,
  groupedSecret,
  qrCodeSrc,
  startAuthenticator,
} from '../../authenticator-api.ts'

/** How long a check counts for Server admin (apps/api/src/admin-second-factor.ts ADMIN_PASSKEY_HOURS). */
export const AUTHENTICATOR_HOURS = 12

/** The text for a failed authenticator request: the server's own message, or the status in the app language. */
export function authenticatorErrorText(e: unknown, t: ReturnType<typeof useT>): string {
  if (e instanceof AuthenticatorRequestError) return t('account.authenticator.requestFailed', { status: e.status })
  return e instanceof Error ? e.message : String(e)
}

export function useAuthenticatorSetup(onAdded: () => Promise<void> | void) {
  const [started, setStarted] = useState<AuthenticatorStartData | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(authenticatorErrorText(e, t))
    } finally {
      setBusy(false)
    }
  }
  const start = () =>
    attempt(async () => {
      setStarted(await startAuthenticator())
      setCode('')
    })
  const confirm = () =>
    attempt(async () => {
      await confirmAuthenticator(code.trim())
      setStarted(null)
      setCode('')
      await onAdded()
    })
  const cancel = () => {
    setStarted(null)
    setCode('')
    setError(null)
  }
  return { started, code, setCode, busy, error, start, confirm, cancel }
}

/** The QR code and, below it, the key to type in for an app that cannot scan. */
export function AuthenticatorQr({ data }: { data: AuthenticatorStartData }) {
  const t = useT()
  return (
    <div className="ac-authenticator-qr">
      <span className="help">{t('account.authenticator.scan')}</span>
      <img src={qrCodeSrc(data.otpauthUrl)} alt={t('account.authenticator.qrAlt')} width={184} height={184} />
      <span className="help">{t('account.authenticator.key')}</span>
      <code className="ac-authenticator-key">{groupedSecret(data.secret)}</code>
    </div>
  )
}
