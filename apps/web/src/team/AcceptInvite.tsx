// The page an invitation link opens (`/?invite=<id>`). The person signs in or creates an account
// with the invited address (a code by email proves it), confirms it if needed, and joins. Every
// redirect (provider, verification link) comes back to this same URL, so the flow picks up where it was.
import type { InvitationPreview } from '@linedesk/actions'
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { type AuthMethods, auth, fetchAuthMethods, requestSignInCode } from '../auth.ts'
import { CodeStep } from '../Login.tsx'
import { authFormError } from '../sign-in-code.ts'
import { previewInvitation } from './team-api.ts'
import { AuthPage } from '../ui/kit.tsx'

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
  if (res.error) throw new Error(res.error.message ?? 'That did not work')
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
  const [sent, setSent] = useState<string | null>(null)
  const [codeSent, setCodeSent] = useState(false)

  const loadAccount = useCallback(async () => {
    const session = (await auth.getSession()).data
    setAccount(session ? { email: session.user.email, emailVerified: session.user.emailVerified } : null)
  }, [])
  useEffect(() => {
    previewInvitation(invitationId).then(setInvite, (e: Error) => setError(e.message))
    fetchAuthMethods().then(setMethods, (e: Error) => setError(e.message))
    void loadAccount()
  }, [invitationId, loadAccount])

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

  const errorLine = error && <div className="auth-error" role="alert">{error}</div>
  if (!invite || account === undefined || !methods) return <AuthPage>{errorLine}</AuthPage>
  if (invite.status !== 'pending') {
    return (
      <Card title={invite.status === 'expired' ? 'This invitation has expired' : 'This invitation is no longer valid'}>
        <p>Ask the person who invited you to send a new one.</p>
        <button type="button" className="k-btn k-btn-secondary" onClick={onDone}>Continue to Linedesk</button>
      </Card>
    )
  }
  const lead = <p>{invite.invitedBy || 'A teammate'} invited {invite.email} to join as {invite.role}.</p>
  const title = `Join ${invite.workspaceName}`
  if (sent) return <Card title="Check your email"><p>{sent}</p>{errorLine}</Card>

  if (!account && codeSent) return <CodeStep email={invite.email} onDone={async () => { await loadAccount() }} onDifferentEmail={() => setCodeSent(false)} />
  if (!account) {
    return (
      <SignInForInvite title={title} lead={lead} email={invite.email} methods={methods} busy={busy} error={errorLine} attempt={attempt}
        onCodeSent={() => setCodeSent(true)} onSignedIn={loadAccount} />
    )
  }
  if (account.email.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Card title={title}>
        {lead}
        <p>You are signed in as {account.email}. Sign out, then continue with {invite.email}.</p>
        {errorLine}
        <button type="button" className="k-btn k-btn-primary" disabled={busy} autoFocus onClick={() => attempt(async () => { await auth.signOut(); await loadAccount() })}>Sign out and continue</button>
        <button type="button" className="auth-switch" onClick={onDone}>Not now</button>
      </Card>
    )
  }
  if (!account.emailVerified) {
    return (
      <Card title="Confirm your email">
        <p>To join {invite.workspaceName}, confirm that {invite.email} is yours. We will email you a link.</p>
        {errorLine}
        <button type="button" className="k-btn k-btn-primary" disabled={busy} autoFocus onClick={() => attempt(async () => {
          fail(await auth.sendVerificationEmail({ email: invite.email, callbackURL: here() }))
          setSent(`We sent a confirmation link to ${invite.email}. Open it to join ${invite.workspaceName}.`)
        })}>Email me a link</button>
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
  const [mode, setMode] = useState<'choose' | 'signIn' | 'signUp'>('choose')
  const [form, setForm] = useState({ name: '', password: '' })
  const back = { callbackURL: here(), errorCallbackURL: here() }

  function submit(e: FormEvent) {
    e.preventDefault()
    void attempt(async () => {
      const invalid = authFormError(mode === 'signUp' ? 'signUp' : 'password', { ...form, email })
      if (invalid) throw new Error(invalid)
      if (mode === 'signUp') fail(await auth.signUp.email({ name: form.name, email, password: form.password }))
      else fail(await auth.signIn.email({ email, password: form.password }))
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
            {methods.sso.map(m => (
              <button key={m.id} type="button" className="k-btn k-btn-secondary" disabled={busy}
                onClick={() => attempt(async () => fail(await auth.signIn.social({ provider: m.id, ...back })))}>Continue with {m.label}</button>
            ))}
            {methods.password && methods.signUp !== false && <button type="button" className="auth-switch" onClick={() => setMode('signUp')}>Create an account with a password</button>}
            {methods.password && <button type="button" className="auth-switch" onClick={() => setMode('signIn')}>I already have a password</button>}
          </>
        )}
        {mode === 'signUp' && <label>Your name<input required value={form.name} autoComplete="name" autoFocus onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>}
        {mode !== 'choose' && (
          <>
            <label>Password<input required type="password" minLength={8} value={form.password} autoFocus={mode === 'signIn'} autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))} /></label>
            <button type="submit" className="k-btn k-btn-primary" disabled={busy}>{mode === 'signUp' ? 'Create account' : 'Sign in'}</button>
            <button type="button" className="auth-switch" onClick={() => setMode('choose')}>Other ways to continue</button>
          </>
        )}
        {error}
      </form>
    </AuthPage>
  )
}
