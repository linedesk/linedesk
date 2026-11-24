// The page a partner team invitation link opens (`#partner-invite=<token>`, docs/white-label.md), the same card as a
// workspace invitation's (team/AcceptInvite.tsx): "Join {partner}", who invited which address and as what, then the
// way in. Signed out, the link shows that before anyone signs in (POST /v1/partner-invitations/preview) with the ways in
// for the invited address; a new address gets its account with the email code (the invitation lets it in,
// apps/api/src/signup-gate.ts), and the page loads again signed in. Signed in: Join, or what stops it (another address,
// on the team already). Always the install's brand: a partner's team works under Linedesk, never its own white label.
import type { PartnerInvitationPreview, PartnerInvitationView } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useEffect, useState } from 'react'
import { type AuthMethods, auth, fetchAuthMethods } from '../auth.ts'
import { brandName } from '../brand.ts'
import { signOutAndForget } from '../localData.ts'
import { CardFooter, CodeStep, useAuthMethods } from '../Login.tsx'
import { authErrorMessage } from '../sign-in-code.ts'
import { callAction } from '../settings/settings-api.ts'
import { SignedInAuthPage, WaitLine } from '../shell/SignedInAuthPage.tsx'
import { InviteSignIn } from '../team/AcceptInvite.tsx'
import { AuthError } from '../ui/AuthError.tsx'
import { Button } from '../ui/kit.tsx'
import { partnerErrorText, refreshMyPartners } from './partner-api.ts'

type Props = {
  token: string
  /** Joined, or left the page: the app opens as it is now (the partner area after a join). */
  onDone: (joined: boolean) => void
}

/** What the link shows before sign-in: the partner, the role, the address and who sent it, or `gone`. */
export async function previewPartnerInvitation(token: string): Promise<PartnerInvitationPreview> {
  const res = await fetch('/v1/partner-invitations/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok)
    throw Object.assign(new Error('invitation unavailable'), { code: 'INVITATION_UNAVAILABLE', status: res.status })
  return (await res.json()) as PartnerInvitationPreview
}

export function PartnerInvite({ token, onDone }: Props) {
  const session = auth.useSession()
  if (session.isPending)
    return (
      <SignedInAuthPage install>
        <WaitLine />
      </SignedInAuthPage>
    )
  return session.data?.user ? (
    <SignedInInvite token={token} onDone={onDone} />
  ) : (
    <SignedOutInvite token={token} onDone={onDone} />
  )
}

/** "Mike Brennan invited dana@example.com to join as an admin.", as on a workspace invitation. */
function Lead({ invitedBy, email, role }: { invitedBy: string | null; email: string; role: string }) {
  const t = useT()
  return <p>{t('team.invite.lead', { inviter: invitedBy || t('team.invite.aTeammate'), email, role })}</p>
}

/** The card every state of the page is in, with the footer every sign-in card has (the member's language, signed in). */
function Card({ title, signedIn, children }: { title: string; signedIn: boolean; children: ReactNode }) {
  const links = useAuthMethods()?.links ?? null
  return (
    <SignedInAuthPage install>
      <div className="auth-card">
        <h1>{title}</h1>
        {children}
        <CardFooter links={links} language={!signedIn} />
      </div>
    </SignedInAuthPage>
  )
}

/** Spent, withdrawn, expired or not known: say so and go on to the app. */
function Gone({ signedIn, onDone }: { signedIn: boolean; onDone: (joined: boolean) => void }) {
  const t = useT()
  return (
    <Card title={t('team.invite.invalid')} signedIn={signedIn}>
      <p>{t('team.invite.askAgain')}</p>
      <Button variant="secondary" onClick={() => onDone(false)}>
        {t('team.invite.continueTo', { brand: brandName() })}
      </Button>
    </Card>
  )
}

/** Signed out: the invitation's card with the ways in for the invited address; signed in, the page loads again. */
function SignedOutInvite({ token, onDone }: Props) {
  const t = useT()
  const [preview, setPreview] = useState<PartnerInvitationPreview | null>(null)
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [codeSent, setCodeSent] = useState(false)

  useEffect(() => {
    previewPartnerInvitation(token).then(setPreview, (e: unknown) => setError(authErrorMessage(e)))
    fetchAuthMethods().then(setMethods, (e: unknown) => setError(authErrorMessage(e)))
  }, [token])

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
  // Signed in now: the page loads again at the same address, where the signed-in card offers Join. It stays busy.
  const signedIn = async () => {
    window.location.reload()
    await new Promise(() => {})
  }

  const errorLine = error && <AuthError message={error} />
  if (!preview || !methods) return <SignedInAuthPage install>{errorLine || <WaitLine />}</SignedInAuthPage>
  if (preview.status !== 'open') return <Gone signedIn={false} onDone={onDone} />
  if (codeSent)
    return (
      <CodeStep
        email={preview.email}
        links={methods.links}
        supportEmail={methods.links.supportEmail}
        invited
        onDone={signedIn}
        onDifferentEmail={() => setCodeSent(false)}
      />
    )
  return (
    <InviteSignIn
      title={t('team.partner.invite.title', { partner: preview.partnerName })}
      lead={<Lead invitedBy={preview.invitedBy} email={preview.email} role={preview.role} />}
      email={preview.email}
      methods={methods}
      busy={busy}
      error={errorLine}
      attempt={attempt}
      onCodeSent={() => setCodeSent(true)}
      onSignedIn={signedIn}
      install
    />
  )
}

/**
 * Signed in: Join for the invited address; signed in with another one, sign out and continue with the invited one (the
 * page loads again signed out, at the same link), as on a workspace invitation; on the team already, open it.
 */
function SignedInInvite({ token, onDone }: Props) {
  const t = useT()
  const current = auth.useSession().data?.user?.email ?? ''
  const [view, setView] = useState<PartnerInvitationView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [busy, setBusy] = useState<'join' | 'signOut' | null>(null)

  useEffect(() => {
    callAction<PartnerInvitationView>('partnerInvitation.view', { token }).then(setView, err => {
      if ((err as { code?: string })?.code === 'invitation_invalid') setGone(true)
      else setProblem(partnerErrorText(err))
    })
  }, [token])

  async function join() {
    setBusy('join')
    setProblem(null)
    try {
      await callAction('partnerInvitation.accept', { token })
      await refreshMyPartners()
      onDone(true)
    } catch (err) {
      setProblem(partnerErrorText(err))
      setBusy(null)
    }
  }
  async function signOutAndContinue() {
    setBusy('signOut')
    await signOutAndForget().catch(() => {})
    window.location.reload()
  }

  const problemLine = problem && <AuthError message={problem} />
  if (gone) return <Gone signedIn onDone={onDone} />
  if (!view) return <SignedInAuthPage install>{problemLine || <WaitLine />}</SignedInAuthPage>
  const notNow = (
    <button type="button" className="auth-switch" onClick={() => onDone(false)}>
      {t('team.partner.invite.notNow')}
    </button>
  )
  return (
    <Card title={t('team.partner.invite.title', { partner: view.partnerName })} signedIn>
      {view.state === 'member' ? (
        <p>{t('team.partner.invite.member', { partner: view.partnerName })}</p>
      ) : (
        <Lead invitedBy={view.invitedBy} email={view.email} role={view.role} />
      )}
      {view.state === 'other_email' && <p>{t('team.invite.otherAccount', { current, invited: view.email })}</p>}
      {problemLine}
      {view.state === 'open' && (
        <>
          <Button variant="primary" busy={busy === 'join'} disabled={busy !== null} onClick={() => void join()}>
            {t('team.partner.invite.join')}
          </Button>
          {notNow}
        </>
      )}
      {view.state === 'member' && (
        <>
          <Button variant="primary" onClick={() => onDone(true)}>
            {t('team.partner.invite.open')}
          </Button>
          {notNow}
        </>
      )}
      {view.state === 'other_email' && (
        <>
          <Button
            variant="primary"
            busy={busy === 'signOut'}
            disabled={busy !== null}
            onClick={() => void signOutAndContinue()}
          >
            {t('team.invite.signOutContinue')}
          </Button>
          {notNow}
        </>
      )}
    </Card>
  )
}
