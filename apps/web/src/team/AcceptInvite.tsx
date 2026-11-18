// The page an invitation link opens (`/?invite=<id>`). The person signs in or creates an account
// with the invited address (a code by email proves it), confirms it if needed, and joins. Every
// redirect (a provider) comes back to this same URL, so the flow picks up where it was.
import type { InvitationPreview } from '@linedesk/actions'
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  type AuthMethods,
  auth,
  type LegalLinks,
  fetchAuthMethods,
  passkeySupported,
  requestSignInCode,
  signInWithPasskey,
} from '../auth.ts'
import { ConfirmEmail } from '../ConfirmEmail.tsx'
import { signOutAndForget } from '../localData.ts'
import { CardFooter, CodeStep } from '../Login.tsx'
import { authErrorMessage, authFormError } from '../sign-in-code.ts'
import { rememberSignInMethod, startRedirectSignIn, takeRedirectSignIn } from '../sign-in-methods.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { previewInvitation } from './team-api.ts'
import { AuthError } from '../ui/AuthError.tsx'
import { ProviderButton } from '../ui/brand-logos.tsx'
import { SignedInAuthPage, WaitLine } from '../shell/SignedInAuthPage.tsx'
import { cx, Spinner } from '../ui/kit.tsx'
import { brandName } from '../brand.ts'
import { useT } from '@linedesk/i18n/react'

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

/**
 * An invitation accepted already (at a sign-in with an email code the new member joins at once), opened again: its
 * member goes into the workspace (`open`), someone signed out to the sign-in page, which leads there too (`signIn`),
 * another account reads that the link is spent (`spent`). Only the invited account signed in gets the workspace id
 * from the server (apps/api/src/invitations.ts), so that is what decides. Null: not accepted.
 */
export function acceptedInviteStep(invite: InvitationPreview | null, account: Account | null | undefined) {
  if (invite?.status !== 'accepted' || account === undefined) return null
  if (!account) return 'signIn'
  return invite.workspaceId ? 'open' : 'spent'
}

/** The invitation's card, with the footer every sign-in card has; signed in, the member's own language applies. */
function Card({ title, links, children }: { title: string; links: LegalLinks; children: ReactNode }) {
  return (
    <SignedInAuthPage>
      <div className="auth-card">
        <h1>{title}</h1>
        {children}
        <CardFooter links={links} language={false} />
      </div>
    </SignedInAuthPage>
  )
}

export function AcceptInvite({ invitationId, onDone }: { invitationId: string; onDone: () => void }) {
  const t = useT()
  const [invite, setInvite] = useState<InvitationPreview | null>(null)
  const [account, setAccount] = useState<Account | null | undefined>(undefined)
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [error, setError] = useState<string | null>(null)
  // What runs ('code', 'join', a provider's id…): that button shows the spinner and keeps its label; all wait meanwhile.
  const [busy, setBusy] = useState<string | null>(null)
  const [codeSent, setCodeSent] = useState(false)
  // Opening the workspace of an invitation this account accepted already; false once that did not work (they left it).
  const [opening, setOpening] = useState<boolean | null>(null)

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
  // Its member opening the link again lands in the workspace instead of reading that the link is spent (U6).
  const accepted = acceptedInviteStep(invite, account)
  const workspaceId = invite?.status === 'accepted' ? (invite.workspaceId ?? null) : null
  useEffect(() => {
    if (opening !== null) return
    if (accepted === 'signIn') onDone()
    if (accepted !== 'open' || !workspaceId) return
    setOpening(true)
    // Without the invitation in the address, or the reload into the workspace would open this page again.
    clearInviteId()
    switchToWorkspace(workspaceId).catch(() => setOpening(false))
  }, [accepted, workspaceId, opening, onDone])
  useEffect(() => {
    previewInvitation(invitationId).then(setInvite, (e: unknown) => setError(authErrorMessage(e)))
    fetchAuthMethods().then(setMethods, (e: unknown) => setError(authErrorMessage(e)))
    void loadAccount()
  }, [invitationId, loadAccount])

  async function attempt(what: string, work: () => Promise<void>) {
    setBusy(what)
    setError(null)
    try {
      await work()
    } catch (e) {
      // Our own messages as they are; a network failure (TypeError) or anything else in plain words.
      setError(e instanceof Error && !(e instanceof TypeError) ? e.message : authErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const errorLine = error && <AuthError message={error} />
  // While the workspace of an accepted invitation opens: the wait line, as while loading.
  if (
    !invite ||
    account === undefined ||
    !methods ||
    accepted === 'signIn' ||
    (accepted === 'open' && opening !== false)
  )
    return <SignedInAuthPage>{errorLine || <WaitLine />}</SignedInAuthPage>
  if (invite.status !== 'pending') {
    return (
      <Card
        title={invite.status === 'expired' ? t('team.invite.expired') : t('team.invite.invalid')}
        links={methods.links}
      >
        <p>{t('team.invite.askAgain')}</p>
        <button type="button" className="k-btn k-btn-secondary" onClick={onDone}>
          {t('team.invite.continueTo', { brand: brandName() })}
        </button>
      </Card>
    )
  }
  const lead = (
    <p>
      {t('team.invite.lead', {
        inviter: invite.invitedBy || t('team.invite.aTeammate'),
        email: invite.email,
        role: invite.role,
      })}
    </p>
  )
  const title = t('team.invite.join', { workspace: invite.workspaceName })

  if (!account && codeSent)
    return (
      <CodeStep
        email={invite.email}
        links={methods.links}
        supportEmail={methods.links.supportEmail}
        invited
        onDone={afterSignIn}
        onDifferentEmail={() => setCodeSent(false)}
      />
    )
  if (!account) {
    return (
      <InviteSignIn
        title={title}
        lead={lead}
        email={invite.email}
        methods={methods}
        busy={busy}
        error={errorLine}
        attempt={attempt}
        onCodeSent={() => setCodeSent(true)}
        onSignedIn={afterSignIn}
      />
    )
  }
  if (account.email.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Card title={title} links={methods.links}>
        {lead}
        <p>{t('team.invite.otherAccount', { current: account.email, invited: invite.email })}</p>
        {errorLine}
        <button
          type="button"
          className={cx('k-btn k-btn-primary', busy === 'signOut' && 'is-busy')}
          disabled={busy !== null}
          aria-busy={busy === 'signOut' || undefined}
          onClick={() =>
            attempt('signOut', async () => {
              await signOutAndForget()
              await loadAccount()
            })
          }
        >
          {busy === 'signOut' && <Spinner />}
          {t('team.invite.signOutContinue')}
        </button>
        <button type="button" className="auth-switch" onClick={onDone}>
          {t('team.invite.notNow')}
        </button>
      </Card>
    )
  }
  if (!account.emailVerified) {
    return (
      <Card title={title} links={methods.links}>
        {errorLine}
        <ConfirmEmail
          email={invite.email}
          onDone={async () => {
            await loadAccount()
          }}
          why={t('team.invite.confirmWhy', { workspace: invite.workspaceName, email: invite.email })}
        />
      </Card>
    )
  }
  return (
    <Card title={title} links={methods.links}>
      {lead}
      {errorLine}
      <button
        type="button"
        className={cx('k-btn k-btn-primary', busy === 'join' && 'is-busy')}
        disabled={busy !== null}
        aria-busy={busy === 'join' || undefined}
        onClick={() =>
          attempt('join', async () => {
            fail(await auth.organization.acceptInvitation({ invitationId }))
            onDone()
          })
        }
      >
        {busy === 'join' && <Spinner />}
        {t('team.invite.join', { workspace: invite.workspaceName })}
      </button>
      <button type="button" className="auth-switch" onClick={onDone}>
        {t('team.invite.notNow')}
      </button>
    </Card>
  )
}

type SignInProps = {
  title: string
  lead: ReactNode
  email: string
  methods: AuthMethods
  /** What runs ('code', 'password', 'passkey', a provider's id), or null. */
  busy: string | null
  error: ReactNode
  attempt: (what: string, work: () => Promise<void>) => Promise<void>
  onCodeSent: () => void
  onSignedIn: () => Promise<void>
  /** The install's brand (a partner team invitation, PartnerInvite.tsx), never a white-label one. */
  install?: boolean
}

/**
 * Signed out, an invitation's card: "Join …", who invited which address, then the ways in for that address (it is
 * fixed); any method this install offers works. Workspace invitations and partner team invitations (PartnerInvite.tsx)
 * share it, so both read the same.
 */
export function InviteSignIn({
  title,
  lead,
  email,
  methods,
  busy,
  error,
  attempt,
  onCodeSent,
  onSignedIn,
  install,
}: SignInProps) {
  const t = useT()
  // A new account comes from a proven address (a code or a provider): a password signs in an existing one only.
  const [mode, setMode] = useState<'choose' | 'signIn'>('choose')
  const [form, setForm] = useState({ password: '' })
  const back = { callbackURL: here(), errorCallbackURL: here() }

  function submit(e: FormEvent) {
    e.preventDefault()
    void attempt('password', async () => {
      const invalid = authFormError('password', { ...form, name: '', email })
      if (invalid) throw new Error(invalid)
      fail(await auth.signIn.email({ email, password: form.password }))
      rememberSignInMethod('password')
      await onSignedIn()
    })
  }

  return (
    <SignedInAuthPage install={install}>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>{title}</h1>
        {lead}
        {/* The account's name for password managers: the password below fills and saves for this address. */}
        <label>
          {t('auth.email')}
          <input type="email" name="username" autoComplete="username" value={email} readOnly />
        </label>
        {mode === 'choose' && (
          <>
            {methods.emailCode && (
              <button
                type="button"
                className={cx('k-btn k-btn-primary', busy === 'code' && 'is-busy')}
                disabled={busy !== null}
                aria-busy={busy === 'code' || undefined}
                onClick={() =>
                  attempt('code', async () => {
                    fail(await requestSignInCode(email))
                    onCodeSent()
                  })
                }
              >
                {busy === 'code' && <Spinner />}
                {t('auth.signup.sendCode')}
              </button>
            )}
            {/* Someone who already has an account with a passkey: in with it (another account's is caught below). */}
            {methods.passkey && passkeySupported() && (
              <ProviderButton
                method="passkey"
                label={t('auth.method.passkey')}
                lastUsed={false}
                disabled={busy !== null}
                onClick={() =>
                  attempt('passkey', async () => {
                    fail(await signInWithPasskey())
                    rememberSignInMethod('passkey')
                    await onSignedIn()
                  })
                }
              />
            )}
            {methods.sso.map(m => (
              <ProviderButton
                key={m.id}
                method={m.id}
                label={m.label}
                lastUsed={false}
                busy={busy === m.id}
                disabled={busy !== null}
                onClick={() =>
                  attempt(m.id, async () => {
                    // Counted as a sign-in only once it comes back with a session (loadAccount).
                    startRedirectSignIn(m.id)
                    fail(await auth.signIn.social({ provider: m.id, ...back }))
                  })
                }
              />
            ))}
            {methods.password && (
              <button type="button" className="auth-switch" onClick={() => setMode('signIn')}>
                {t('team.invite.havePassword')}
              </button>
            )}
          </>
        )}
        {mode !== 'choose' && (
          <>
            <label>
              {t('auth.method.password')}
              <input
                required
                type="password"
                name="password"
                minLength={8}
                value={form.password}
                autoFocus
                autoComplete="current-password"
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              />
            </label>
            <button
              type="submit"
              className={cx('k-btn k-btn-primary', busy === 'password' && 'is-busy')}
              disabled={busy !== null}
              aria-busy={busy === 'password' || undefined}
            >
              {busy === 'password' && <Spinner />}
              {t('auth.signIn')}
            </button>
            <button type="button" className="auth-switch" onClick={() => setMode('choose')}>
              {t('team.invite.otherWays')}
            </button>
          </>
        )}
        {error}
        <CardFooter links={methods.links} />
      </form>
    </SignedInAuthPage>
  )
}
