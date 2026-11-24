// The page the sign-in email's button opens (`#sign-in=<token>`, apps/api/src/sign-in-link.ts), in any browser or
// device: mail apps often open links in another browser or their own. Nothing signs in when the page opens, so a mail
// scanner that follows the link signs nobody in: it shows whose account this is and signs in only on Continue, in this
// browser. The page it opens on (the app, or the sign-up page with its plan) is where the flow goes on after Continue.

import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { brandName } from './brand.ts'
import { authErrorMessage } from './sign-in-code.ts'
import { rememberSignInMethod } from './sign-in-methods.ts'
import { AuthError } from './ui/AuthError.tsx'
import { AuthPage, cx, Spinner } from './ui/kit.tsx'
import { Loading, Skeleton } from './ui/LoadStates.tsx'

const PREFIX = '#sign-in='

/**
 * The token from the address, read once; the address loses it at once (history, a shared screen, a bookmark). Null
 * when this is no sign-in link.
 */
export function takeSignInLinkToken(): string | null {
  const { hash, pathname, search } = window.location
  if (!hash.startsWith(PREFIX)) return null
  window.history.replaceState(null, '', `${pathname}${search}`)
  return hash.slice(PREFIX.length) || null
}

type State = { state: 'checking' } | { state: 'ready'; email: string } | { state: 'spent' }

const post = (path: string, token: string) =>
  fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })

/** `onDone` resolves once the app has the new session; `onLeave` goes on to the sign-in page (or the app). */
export function SignInLink({
  token,
  onDone,
  onLeave,
}: {
  token: string
  onDone: () => Promise<void>
  onLeave: () => void
}) {
  const t = useT()
  const [link, setLink] = useState<State>({ state: 'checking' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The check failed (server down, too many requests): the load-problem look with Try again, never a guess.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    void attempt
    post('/v1/sign-in-link/check', token)
      .then(async res => {
        const body = (await res.json().catch(() => null)) as { state?: string; email?: string; code?: string } | null
        if (!live) return
        if (!res.ok) return setLoadError(authErrorMessage({ code: body?.code, status: res.status }))
        if (body?.state === 'ready' && body.email) setLink({ state: 'ready', email: body.email })
        else setLink({ state: 'spent' })
      })
      .catch(err => live && setLoadError(authErrorMessage(err)))
    return () => {
      live = false
    }
  }, [token, attempt])

  async function continueSignIn() {
    setBusy(true)
    setError(null)
    try {
      const res = await post('/v1/sign-in-link/use', token)
      const body = (await res.json().catch(() => null)) as { ok?: boolean; state?: string; code?: string | null } | null
      if (res.ok && body?.ok) {
        rememberSignInMethod('email')
        return await onDone()
      }
      if (body?.state === 'spent') setLink({ state: 'spent' })
      else setError(authErrorMessage({ code: body?.code ?? undefined, status: res.status }))
    } catch (err) {
      setError(authErrorMessage(err))
    }
    setBusy(false)
  }

  const brand = brandName()
  return (
    <AuthPage>
      <Loading
        what={t('auth.link.what')}
        loading={link.state === 'checking'}
        error={loadError}
        onRetry={() => {
          setLoadError(null)
          setAttempt(n => n + 1)
        }}
        skeleton={<LinkSkeleton />}
      >
        <div className="auth-card">
          {link.state === 'ready' && (
            <>
              <h1>{t('auth.link.title', { brand })}</h1>
              <p>{t('auth.link.as', { email: link.email })}</p>
              <button
                type="button"
                className={cx('k-btn k-btn-primary', busy && 'is-busy')}
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void continueSignIn()}
              >
                {busy && <Spinner />}
                {busy ? t('auth.signingIn') : t('auth.link.continue')}
              </button>
              {error && <AuthError message={error} />}
              <button type="button" className="auth-switch" onClick={onLeave}>
                {t('auth.link.notYou')}
              </button>
            </>
          )}
          {link.state === 'spent' && (
            <>
              <h1>{t('auth.link.spentTitle')}</h1>
              <p>{t('auth.link.spentText')}</p>
              {error && <AuthError message={error} />}
              <button type="button" className="k-btn k-btn-primary" onClick={onLeave}>
                {t('auth.link.toSignIn')}
              </button>
            </>
          )}
        </div>
      </Loading>
    </AuthPage>
  )
}

/** The card's shape while the link is checked: the title, one line and the button. */
function LinkSkeleton() {
  return (
    <div className="auth-card auth-link-skeleton">
      <Skeleton shape="text" width="70%" height={36} />
      <Skeleton shape="text" width="85%" />
      <Skeleton width="100%" height={40} />
    </div>
  )
}
