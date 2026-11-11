// "Confirm your email", inline: a code is emailed to the signed-in member's own address and typed
// here. Confirming inside the session keeps the password and everything else as it is. Shown after a
// password sign-up (onboarding, Account, answering an invitation); until then the API refuses what
// can let someone in later or carry data out (API keys, webhooks, invitations, carrier, numbers).
import { type FormEvent, useEffect, useState } from 'react'
import { auth } from './auth.ts'
import { authErrorMessage, CODE_LENGTH, normalizeCode, RESEND_AFTER_S } from './sign-in-code.ts'
import { Button } from './ui/kit.tsx'

type Result = { error: { code?: string; message?: string; status?: number } | null }
const check = (res: Result) => {
  if (res.error) throw new Error(authErrorMessage(res.error))
}

/** `email`: the session's address when the caller knows it; otherwise it is read from the session. */
export function ConfirmEmail({ email: known, why, onDone }: { email?: string; why: string; onDone: () => void | Promise<void> }) {
  const [email, setEmail] = useState(known ?? '')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waitS, setWaitS] = useState(0)

  useEffect(() => {
    if (known) return
    let active = true
    void auth.getSession().then(res => {
      if (active && res.data) setEmail(res.data.user.email)
    })
    return () => {
      active = false
    }
  }, [known])
  useEffect(() => {
    if (waitS <= 0) return
    const timer = setTimeout(() => setWaitS(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitS])

  async function attempt(work: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const sendCode = () =>
    attempt(async () => {
      check(await auth.emailOtp.sendVerificationOtp({ email, type: 'email-verification' }))
      setSent(true)
      setCode('')
      setWaitS(RESEND_AFTER_S)
    })
  const confirm = (e: FormEvent) => {
    e.preventDefault()
    if (code.length !== CODE_LENGTH) return
    void attempt(async () => {
      check(await auth.emailOtp.verifyEmail({ email, otp: code }))
      await onDone()
    })
  }

  return (
    <form className="confirm-email" onSubmit={confirm} aria-label="Confirm your email">
      <div className="confirm-email-text">
        <b>Confirm your email</b>
        <span>{sent ? `Enter the ${CODE_LENGTH}-digit code we sent to ${email}. It expires in 10 minutes.` : why}</span>
      </div>
      {sent ? (
        <div className="confirm-email-row">
          <span className="k-input">
            <input aria-label="Confirmation code" value={code} onChange={e => setCode(normalizeCode(e.target.value))} disabled={busy}
              inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH + 6} autoFocus
              // Enter confirms the code; the page's own Enter (onboarding: next step) must not run too.
              onKeyDown={e => { if (e.key === 'Enter') e.stopPropagation() }} />
          </span>
          <Button type="submit" variant="primary" size="sm" disabled={busy || code.length !== CODE_LENGTH}>Confirm</Button>
          <Button size="sm" variant="ghost" disabled={busy || waitS > 0} onClick={() => void sendCode()}>
            {waitS > 0 ? `New code in ${waitS} s` : 'Send a new code'}
          </Button>
        </div>
      ) : (
        <div className="confirm-email-row">
          <Button variant="primary" size="sm" disabled={busy || !email} onClick={() => void sendCode()}>Email me a code</Button>
        </div>
      )}
      {error && <div className="confirm-email-error" role="alert">{error}</div>}
    </form>
  )
}
