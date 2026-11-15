// The page an invitation link opens (`/?invite=<id>`). The person signs in or creates an account
// with the invited address (a code by email proves it), confirms it if needed, and joins. Every
// redirect (a provider) comes back to this same URL, so the flow picks up where it was.
import type { InvitationPreview } from '@linedesk/actions'
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { type AuthMethods, auth, fetchAuthMethods, passkeySupported, requestSignInCode, signInWithPasskey } from '../auth.ts'
import { ConfirmEmail } from '../ConfirmEmail.tsx'
import { signOutAndForget } from '../localData.ts'
import { CodeStep } from '../Login.tsx'
import { authErrorMessage, authFormError } from '../sign-in-code.ts'
import { rememberSignInMethod, startRedirectSignIn, takeRedirectSignIn } from '../sign-in-methods.ts'
import { previewInvitation } from './team-api.ts'
import { roleInSentence } from './team-model.ts'
import { AuthError } from '../ui/AuthError.tsx'
import { ProviderButton } from '../ui/brand-logos.tsx'
import { AuthPage } from '../ui/kit.tsx'
import { brandName } from '../brand.ts'

const INVITE_PARAM = 'invite'

export const readInviteId = () => new URL(window.location.href).searchParams.get(INVITE_PARAM)

export function clearInviteId() {
  const url = new URL(window.location.href)
  url.searchParams.delete(INVITE_PARAM)
  window.history.replaceState(null, '', url)
}

type Account = { email: string; emailVerified: boolean }
type Result = { error: { message?: string } | null }
const fail = (res: Result) => {
  if (res.error) throw new Error(authErrorMessage(res.error))
}
const here = () => window.location.href

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <AuthPage><div className="auth-card"><h1>{title}</h1>{children}</div></AuthPage>
}

export function AcceptInvite({ invitationId, onDone }: { invitationId: string; onDone: () => void }) {
  const [invite, setInvite] = useState<InvitationPreview | null>(null)
  const [account, setAccount] = useState<Account | null | undefined>(undefined)
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [codeSent, setCodeSent] = useState(false)

  const loadAccount = useCallback(async () => {
    const session = (await auth.getSession()).data
    takeRedirectSignIn(Boolean(session))
    setAccount(session ? { email: session.user.email, emailVerified: session.user.emailVerified } : null)
    return session
  }, [])
  // A new account made with the invited address joins in the same step (apps/api/src/memberships.ts,
  // joinInvitedWorkspaces): signed in and the invitation no longer pending means they are in.
  const afterSignIn = useCallback(async () => {
    const session = await loadAccount()
    if (!session) return
    const now = await previewInvitation(invitationId).catch(() => null)
    if (now && now.status !== 'pending') onDone()
  }, [invitationId, loadAccount, onDone])
  useEffect(() => {
    previewInvitation(invitationId).then(setInvite, (e: unknown) => setError(authErrorMessage(e)))
    fetchAuthMethods().then(setMethods, (e: unknown) => setError(authErrorMessage(e)))
    void loadAccount()
  }, [invitationId, loadAccount])

  async function attempt(work: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      // Our own messages as they are; a network failure (TypeError) or anything else in plain words.
      setError(e instanceof Error && !(e instanceof TypeError) ? e.message : authErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const errorLine = error && <AuthError message={error} />
  if (!invite || account === undefined || !methods) return <AuthPage>{errorLine}</AuthPage>
  if (invite.status !== 'pending') {
    return (
      <Card title={invite.status === 'expired' ? 'This invitation has expired' : 'This invitation is no longer valid'}>
        <p>Ask the person who invited you to send a new one.</p>
        <button type="button" className="k-btn k-btn-secondary" onClick={onDone}>Continue to {brandName()}</button>
      </Card>
    )
  }
  const lead = <p>{invite.invitedBy || 'A teammate'} invited {invite.email} to join as {roleInSentence(invite.role)}.</p>
  const title = `Join ${invite.workspaceName}`

  if (!account && codeSent) return <CodeStep email={invite.email} onDone={afterSignIn} onDifferentEmail={() => setCodeSent(false)} />
  if (!account) {
    return (
      <SignInForInvite title={title} lead={lead} email={invite.email} methods={methods} busy={busy} error={errorLine} attempt={attempt}
        onCodeSent={() => setCodeSent(true)} onSignedIn={afterSignIn} />
    )
  }
  if (account.email.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Card title={title}>
        {lead}
        <p>You are signed in as {account.email}. Sign out, then continue with {invite.email}.</p>
        {errorLine}
        <button type="button" className="k-btn k-btn-primary" disabled={busy} autoFocus onClick={() => attempt(async () => { await signOutAndForget(); await loadAccount() })}>Sign out and continue</button>
        <button type="button" className="auth-switch" onClick={onDone}>Not now</button>
      </Card>
    )
  }
  if (!account.emailVerified) {
    return (
      <Card title={title}>
        {errorLine}
        <ConfirmEmail email={invite.email} onDone={async () => { await loadAccount() }}
          why={`To join ${invite.workspaceName}, confirm that ${invite.email} is yours. We email you a code.`} />
      </Card>
    )
  }
  return (
    <Card title={title}>
      {lead}
      {errorLine}
      <button type="button" className="k-btn k-btn-primary" disabled={busy} autoFocus onClick={() => attempt(async () => {
        fail(await auth.organization.acceptInvitation({ invitationId }))
        onDone()
      })}>Join {invite.workspaceName}</button>
      <button type="button" className="auth-switch" onClick={onDone}>Not now</button>
    </Card>
  )
}

type SignInProps = {
  title: string; lead: ReactNode; email: string; methods: AuthMethods; busy: boolean; error: ReactNode
  attempt: (work: () => Promise<void>) => Promise<void>; onCodeSent: () => void; onSignedIn: () => Promise<void>
}

/** Signed out: the invited address is fixed; any method this install offers works. */
function SignInForInvite({ title, lead, email, methods, busy, error, attempt, onCodeSent, onSignedIn }: SignInProps) {
  // A new account comes from a proven address (a code or a provider): a password signs in an existing one only.
  const [mode, setMode] = useState<'choose' | 'signIn'>('choose')
  const [form, setForm] = useState({ password: '' })
  const back = { callbackURL: here(), errorCallbackURL: here() }

  function submit(e: FormEvent) {
    e.preventDefault()
    void attempt(async () => {
      const invalid = authFormError('password', { ...form, name: '', email })
      if (invalid) throw new Error(invalid)
      fail(await auth.signIn.email({ email, password: form.password }))
      rememberSignInMethod('password')
      await onSignedIn()
    })
  }

  return (
    <AuthPage>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>{title}</h1>
        {lead}
        <label>Email<input value={email} readOnly /></label>
        {mode === 'choose' && (
          <>
            {methods.emailCode && (
              <button type="button" className="k-btn k-btn-primary" disabled={busy} autoFocus onClick={() => attempt(async () => {
                fail(await requestSignInCode(email))
                onCodeSent()
              })}>Email me a code</button>
            )}
            {/* Someone who already has an account with a passkey: in with it (another account's is caught below). */}
            {methods.passkey && passkeySupported() && (
              <ProviderButton method="passkey" label="Passkey" lastUsed={false} disabled={busy}
                onClick={() => attempt(async () => {
                  fail(await signInWithPasskey())
                  rememberSignInMethod('passkey')
                  await onSignedIn()
                })} />
            )}
            {methods.sso.map(m => (
              <ProviderButton key={m.id} method={m.id} label={m.label} lastUsed={false} disabled={busy}
                onClick={() => attempt(async () => {
                  // Counted as a sign-in only once it comes back with a session (loadAccount).
                  startRedirectSignIn(m.id)
                  fail(await auth.signIn.social({ provider: m.id, ...back }))
                })} />
            ))}
            {methods.password && <button type="button" className="auth-switch" onClick={() => setMode('signIn')}>I already have a password</button>}
          </>
        )}
        {mode !== 'choose' && (
          <>
            <label>Password<input required type="password" minLength={8} value={form.password} autoFocus autoComplete="current-password"
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))} /></label>
            <button type="submit" className="k-btn k-btn-primary" disabled={busy}>Sign in</button>
            <button type="button" className="auth-switch" onClick={() => setMode('choose')}>Other ways to continue</button>
          </>
        )}
        {error}
      </form>
    </AuthPage>
  )
}
