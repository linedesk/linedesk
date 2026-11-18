// Sign-in. Shows what this install offers (GET /v1/auth-methods): the passkey first where the install and the browser
// can use one, with "Use an email code instead" (a code sent by email) below it; without passkeys the email form comes
// first. Then the sign-in providers, and a password under "Show other options". New accounts come from the sign-up page
// while self-serve sign-up is open (the footer links there), else from an invitation: an unknown address is told to ask
// for one; an invited one gets its account on the first sign-in. "Forgot password?" sets a new one with an emailed code.
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { type AuthMethods, auth, completeSetup, type LegalLinks, passkeySupported, type SsoMethod, fetchAuthMethods, requestPasswordResetCode, requestSignInCode, resetPasswordWithCode, signInWithCode, signInWithPasskey, startSso, takeRedirectError, lostSignInState, providerElsewhereMessage, providerSignInElsewhere } from './auth.ts'
import { authErrorMessage, authFormError, CODE_LENGTH, codeErrorMessage, emailError, newPasswordError, noAccountText, normalizeCode, NO_CODE_HINT_AFTER_S, passwordResetOffer, RESEND_AFTER_S, resetErrorMessage } from './sign-in-code.ts'
import { passkeyRequestClosed, readLastUsedMethod, rememberSignInMethod, signInStart } from './sign-in-methods.ts'
import { emailFieldPasskey } from './passkey-autofill.ts'
import { useQuery } from './cachedQuery.ts'
import { LastUsed, ProviderButton, SignInMark } from './ui/brand-logos.tsx'
import { AuthError } from './ui/AuthError.tsx'
import { HelpTip, type HelpTipContent } from './ui/HelpTip.tsx'
import { AuthPage, cx, Icon, Spinner } from './ui/kit.tsx'
import { NO_PASSWORD_MANAGER } from './ui/passwordManager.ts'
import { brandName, useBrandKnown } from './brand.ts'
import { leftAndDeleted, readDeleted, signedOutOfWorkspace } from './session.ts'
import { isUiLocale, PSEUDO_LOCALE } from '@linedesk/i18n'
import { useLocale } from '@linedesk/i18n/react'
import { activate } from './i18n/index.tsx'
import { AUTOMATIC, LanguageSelect } from './i18n/LanguageSelect.tsx'
import { T, useT } from '@linedesk/i18n/react'
import { i18n } from './i18n/index.tsx'

type Step = 'start' | 'code' | 'password' | 'reset'
type Result = { error: { message?: string; code?: string; status?: number } | null }

/** Keeps trying while the server is unreachable (a restart), so the page recovers by itself. */
const loadAuthMethods = () => fetchAuthMethods()

/** The sign-up page (Signup.tsx); the language this browser chose carries over, it is kept in the browser. */
const SIGNUP_PATH = '/signup'

/**
 * Where someone told "No account for this email" can go instead, while self-serve sign-up is open: the sign-up page.
 * The error itself stays the same for every unknown address (no account enumeration).
 */
export function signupLinkFor(message: string | null, selfServeSignup: boolean | undefined) {
  if (!selfServeSignup || !message || message !== noAccountText()) return undefined
  return { href: SIGNUP_PATH, label: i18n().t('auth.error.signupClosedStartTrial') }
}

const fail = (res: Result) => {
  if (res.error) throw res.error
}


/** Signing in again for a place that asks for a recent sign-in (the admin area): why, and the way back. */
export type Reauth = { title: string; why: string; onBack: () => void }

/**
 * `onDone` resolves once the app has loaded the account, so the form keeps its busy state until the app replaces it.
 * With `reauth`, the same methods sign a signed-in member in again. Accounts come from the sign-up page while self-serve
 * sign-up is open, an invitation, the first-run setup or a server admin (apps/api/src/signup-gate.ts).
 */
export function Login({ onDone, reauth }: { onDone: () => Promise<void>; reauth?: Reauth }) {
  const t = useT()
  // What this install offers: the last known at once (kept across visits), checked again in the background.
  const methods = useQuery('auth-methods', loadAuthMethods, { persist: true }).data ?? null
  // Whose page this is (a white-label partner's own address names the partner, brand.ts): known before the title shows.
  const brandKnown = useBrandKnown()
  const [step, setStep] = useState<Step>('start')
  const [form, setForm] = useState({ email: '', password: '' })
  // A failed provider sign-in comes back with ?error=CODE: read once, then shown like any other error.
  const [redirectError] = useState(takeRedirectError)
  const [error, setError] = useState<string | null>(redirectError?.message ?? null)
  // An owner who deleted their workspace and, with it, their own account lands here: say so (until this tab opens
  // a workspace again, Workspace.tsx).
  const [deleted] = useState(() => (reauth ? null : readDeleted()))
  // The server ended the session this device had (a removal, a password change, another device's "Sign out other
  // sessions"…): which workspace it was in (A7).
  const [ended] = useState(() => (reauth ? null : signedOutOfWorkspace()))
  // Someone who left their last workspace with "Also delete my account" (TeamPage.tsx LeaveWorkspace).
  const [left] = useState(() => (reauth ? null : leftAndDeleted()))
  const lostNote = deleted?.accountDeleted
    ? t('auth.deleted')
    : left
      ? t('auth.leftAndDeleted', { workspace: left })
      : ended
        ? t('auth.signedOutOf', { workspace: ended })
        : null
  // `busy` is what is running ('email', 'password', a provider id); it stays set after a success that leaves this page.
  const [busy, setBusy] = useState<string | null>(null)
  const [lastUsed] = useState(readLastUsedMethod)
  const [otherOptions, setOtherOptions] = useState(lastUsed === 'password')
  // The passkey first (LIN-215); the email form opens on "Use an email code instead", after a passkey that did not work,
  // or at once when this device last signed in with email.
  const start = signInStart({
    passkeyOn: Boolean(methods?.passkey),
    supported: passkeySupported(),
    reauth: Boolean(reauth),
    lastUsed,
  })
  const [emailChosen, setEmailChosen] = useState(false)
  const emailOpen = start.emailOpen || emailChosen
  // The browser's own passkey suggestion in the email field, started again after a passkey request ends.
  const [autofillRound, setAutofillRound] = useState(0)
  const autofill = start.passkeyFirst && emailOpen && methods?.emailCode === true && step === 'start'
  // Changes when the suggestion should start (again); 0 while it should not run.
  const autofillRun = autofill ? autofillRound + 1 : 0
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!autofillRun) return
    let live = true
    void emailFieldPasskey.offer().then(async signedIn => {
      // Not offered, stopped by the button, or closed: nothing to say.
      if (!live || !signedIn) return
      setBusy('passkey')
      rememberSignInMethod('passkey')
      await done.current()
    })
    return () => {
      live = false
      emailFieldPasskey.stop()
    }
  }, [autofillRun])
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))

  /** Runs one sign-in attempt; `leaves` is true when success hands over to another page (no flash of the form). */
  async function attempt(what: string, action: () => Promise<boolean>) {
    setBusy(what)
    setError(null)
    try {
      if (await action()) return
    } catch (err) {
      setError(authErrorMessage(err))
    }
    setBusy(null)
  }

  const go = (to: Step) => {
    setStep(to)
    setError(null)
  }

  function sendCode(e: FormEvent) {
    e.preventDefault()
    const invalid = authFormError('email', form)
    if (invalid) return setError(invalid)
    void attempt('email', async () => {
      fail(await requestSignInCode(form.email))
      go('code')
      return false
    })
  }

  function signInWithPassword(e: FormEvent) {
    e.preventDefault()
    const invalid = authFormError('password', form)
    if (invalid) return setError(invalid)
    void attempt('password', async () => {
      fail(await auth.signIn.email({ email: form.email, password: form.password }))
      rememberSignInMethod('password')
      await onDone()
      return true
    })
  }

  function continueWith(method: SsoMethod) {
    void attempt(method.id, async () => {
      rememberSignInMethod(method.id)
      fail(await startSso(method))
      return true
    })
  }

  function continueWithPasskey() {
    // The suggestion in the email field shares the challenge cookie: stopped before the button asks for its own.
    emailFieldPasskey.stop()
    void attempt('passkey', async () => {
      const res = await signInWithPasskey()
      if (res.error) {
        // No passkey here, or the person closed the request: the email code is right below, no error.
        setEmailChosen(true)
        setAutofillRound(r => r + 1)
        if (passkeyRequestClosed(res.error)) return false
        throw res.error
      }
      rememberSignInMethod('passkey')
      await onDone()
      return true
    })
  }

  if (!methods || !brandKnown) return <AuthPage>{error ? <AuthError message={error} /> : <p className="auth-wait">{t('auth.connecting')}</p>}</AuthPage>

  if (methods.setupNeeded && !reauth) return <SetupStep onDone={onDone} />

  if (step === 'code') {
    return <CodeStep email={form.email} supportEmail={methods.links.supportEmail} selfServeSignup={methods.selfServeSignup} onDone={onDone} onDifferentEmail={() => go('start')} />
  }

  if (step === 'reset') {
    return <ResetStep initialEmail={form.email} onDone={onDone} onBack={() => go('password')} />
  }

  const title = reauth ? reauth.title : t('auth.signInTo', { brand: brandName() })
  const signupLink = reauth ? undefined : signupLinkFor(error, methods.selfServeSignup)
  const errorLine = error && <AuthError message={error} link={signupLink} />
  // Without email codes the password is the main form, not one of the other options.
  const passwordFirst = methods.password && !methods.emailCode
  const intro = reauth && <p>{reauth.why}</p>
  // Signing in again: a way back instead of who gets an account.
  const footer = reauth
    ? <button type="button" className="auth-switch" title={t('auth.backTip')} onClick={reauth.onBack}>{t('auth.back')}</button>
    : <AuthFooter methods={methods} />
  // Not while signing in again: a reset ends every session, the one being confirmed too.
  const resetOffer = !reauth ? passwordResetOffer(methods) : null
  const forgotPassword = resetOffer === 'reset'
    ? <button type="button" className="auth-switch" onClick={() => go('reset')}>{t('auth.forgot')}</button>
    : resetOffer === 'ask-admin' && <p className="auth-note">{t('auth.forgotAskAdmin')}</p>
  const passwordForm = (
    <PasswordForm form={form} set={set} busy={busy === 'password'} disabled={busy !== null} error={errorLine}
      autoFocus={step === 'password'} onSubmit={signInWithPassword} />
  )

  if (step === 'password') {
    return (
      <AuthPage>
        <div className="auth-card">
          <h1>{title}</h1>
          {intro}
          {passwordForm}
          {forgotPassword}
          <button type="button" className="auth-switch" onClick={() => go('start')}>
            {t('auth.otherWays')}
          </button>
          {footer}
        </div>
      </AuthPage>
    )
  }

  // Provider sign-ins started at this address cannot finish here: say where they work, with a link.
  const elsewhere = methods.sso.length ? providerSignInElsewhere(methods) : null
  const lostHere = Boolean(elsewhere && error && error === redirectError?.message && lostSignInState(redirectError?.code))
  const errorPanel = (id?: string) =>
    lostHere && elsewhere ? (
      <AuthError id={id} message={providerElsewhereMessage(elsewhere.host)} link={{ href: elsewhere.href, label: t('auth.openHost', { host: elsewhere.host }) }} />
    ) : (
      error && <AuthError id={id} message={error} link={signupLink} />
    )
  const withPasskey = methods.passkey && passkeySupported()
  const passkeyButton = withPasskey && (
    <ProviderButton method="passkey" label={t('auth.method.passkey')} lastUsed={lastUsed === 'passkey'} busy={busy === 'passkey'} busyText={t('auth.signingIn')}
      disabled={busy !== null} onClick={continueWithPasskey} />
  )
  const hasOtherOptions = methods.password && methods.emailCode
  // A passkey alone is no way in: it is added after signing in some other way.
  const nothing = !methods.emailCode && !methods.password && methods.sso.length === 0
  const emailForm = methods.emailCode && (
    <form className="auth-form" onSubmit={sendCode} noValidate>
      <input type="email" id="signin-email" name="email" aria-label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} value={form.email}
        onChange={set('email')} autoCapitalize="none" spellCheck={false}
        // The account's name for password managers ("username", not "email"); with the passkey first, the browser may
        // offer a passkey right in this field (autofill).
        autoComplete={start.passkeyFirst ? 'username webauthn' : 'username'} autoFocus={!start.passkeyFirst || emailOpen}
        aria-describedby={error ? 'auth-error' : undefined} />
      <button type="submit" className={cx('k-btn auth-provider', start.passkeyFirst ? 'k-btn-secondary' : 'k-btn-primary', busy === 'email' && 'is-busy')}
        disabled={busy !== null} aria-busy={busy === 'email' || undefined}>
        {busy === 'email' && <Spinner />}
        <span className="auth-provider-label">{busy === 'email' ? t('auth.sending') : t('auth.provider.continueEmail')}</span>
        {lastUsed === 'email' && <LastUsed />}
      </button>
      {errorPanel('auth-error')}
    </form>
  )

  if (start.passkeyFirst && !reauth) {
    const passkeyBusy = busy === 'passkey'
    return (
      <AuthPage>
        <div className="auth-card">
          <h1>{title}</h1>
          {lostNote && (
            <p className="auth-lost" role="status">
              {lostNote}
            </p>
          )}
          <button type="button" className={cx('k-btn k-btn-primary auth-provider', passkeyBusy && 'is-busy')} disabled={busy !== null}
            aria-busy={passkeyBusy || undefined} autoFocus={!emailOpen} onClick={continueWithPasskey}>
            {passkeyBusy ? <Spinner /> : <SignInMark method="passkey" />}
            <span className="auth-provider-label">{passkeyBusy ? t('auth.signingIn') : t('auth.withPasskey')}</span>
            {lastUsed === 'passkey' && <LastUsed />}
          </button>
          {!methods.emailCode && errorPanel()}
          {methods.emailCode && (emailOpen ? (
            <>
              <hr className="auth-separator" />
              {emailForm}
            </>
          ) : (
            <>
              {errorPanel()}
              <button type="button" className="auth-switch auth-more" onClick={() => setEmailChosen(true)}>{t('auth.useEmailCode')}</button>
            </>
          ))}
          {methods.sso.length > 0 && <hr className="auth-separator" />}
          {methods.sso.map(m => (
            <ProviderButton key={m.id} method={m.id} label={m.label} lastUsed={lastUsed === m.id} busy={busy === m.id}
              disabled={busy !== null} onClick={() => continueWith(m)} />
          ))}
          {elsewhere && !lostHere && (
            <p className="auth-hint">
              <T k="auth.providersAt" values={{ host: elsewhere.host, a: chunks => <a href={elsewhere.href}>{chunks}</a> }} />
            </p>
          )}
          {methods.password && (otherOptions || !methods.emailCode
            ? <ProviderButton method="password" label={t('auth.method.password')} lastUsed={lastUsed === 'password'} disabled={busy !== null} onClick={() => go('password')} />
            : <button type="button" className="auth-switch auth-more" onClick={() => setOtherOptions(true)}>{t('auth.showOther')}</button>)}
          {footer}
        </div>
      </AuthPage>
    )
  }

  return (
    <AuthPage>
      <div className="auth-card">
        <h1>{title}</h1>
        {intro}
        {lostNote && (
          <p className="auth-lost" role="status">
            {lostNote}
          </p>
        )}
        {/* Signing in again: the passkey first, the way that also counts longest (12 hours). */}
        {reauth && passkeyButton}
        {reauth && passkeyButton && (methods.emailCode || methods.password || methods.sso.length > 0) && <hr className="auth-separator" />}
        {emailForm}
        {passwordFirst && passwordForm}
        {passwordFirst && forgotPassword}
        {(methods.emailCode || passwordFirst) && (methods.sso.length > 0 || (withPasskey && !reauth)) && <hr className="auth-separator" />}
        {!methods.emailCode && !passwordFirst && errorPanel()}
        {nothing && <AuthError message={t('auth.noMethod')} />}
        {methods.sso.map(m => (
          <ProviderButton key={m.id} method={m.id} label={m.label} lastUsed={lastUsed === m.id} busy={busy === m.id}
            disabled={busy !== null} onClick={() => continueWith(m)} />
        ))}
        {elsewhere && !lostHere && (
          <p className="auth-hint">
            <T k="auth.providersAt" values={{ host: elsewhere.host, a: chunks => <a href={elsewhere.href}>{chunks}</a> }} />
          </p>
        )}
        {!reauth && passkeyButton}
        {hasOtherOptions && (otherOptions
          ? <ProviderButton method="password" label={t('auth.method.password')} lastUsed={lastUsed === 'password'} disabled={busy !== null} onClick={() => go('password')} />
          : <button type="button" className="auth-switch auth-more" onClick={() => setOtherOptions(true)}>{t('auth.showOther')}</button>)}
        {footer}
      </div>
    </AuthPage>
  )
}

type PasswordFormProps = {
  form: { email: string; password: string }
  set: (key: 'email' | 'password') => (e: { target: { value: string } }) => void
  busy: boolean; disabled: boolean; error: ReactNode; autoFocus: boolean; onSubmit: (e: FormEvent) => void
}

/** Email and password. */
function PasswordForm({ form, set, busy, disabled, error, autoFocus, onSubmit }: PasswordFormProps) {
  const t = useT()
  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      <input type="email" id="signin-username" name="username" aria-label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} value={form.email}
        onChange={set('email')} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={autoFocus} />
      <input type="password" id="signin-password" name="password" aria-label={t('auth.method.password')} placeholder={t('auth.method.password')}
        value={form.password} onChange={set('password')} autoComplete="current-password" />
      <button type="submit" className="k-btn k-btn-primary" disabled={disabled}>
        {busy ? t('auth.signingIn') : t('auth.signIn')}
      </button>
      {error}
    </form>
  )
}

/**
 * Who can get an account: the sign-up page while self-serve sign-up is open on this install (`selfServeSignup`), else an
 * invitation from a workspace admin. On its own line "Need help? Write to …" (the install's support address, when set),
 * then Terms · Privacy, each only when set.
 */
export function AuthFooter({ methods }: { methods: AuthMethods }) {
  const t = useT()
  return (
    <footer className="auth-footer">
      <div className="auth-notes">
        <p className="auth-note">
          {methods.selfServeSignup
            ? <T k="auth.noAccountSignup" values={{ a: chunks => <a className="k-link" href={SIGNUP_PATH}>{chunks}</a> }} />
            : t('auth.noAccount')}
        </p>
        {methods.links.supportEmail && <NeedHelp email={methods.links.supportEmail} />}
      </div>
      <LegalLinksLine links={methods.links} />
      <SignInLanguage />
    </footer>
  )
}

/** "Need help? Write to support@…": its own quiet line, the address a mailto link (sign-in footer, the code step). */
export function NeedHelp({ email }: { email: string }) {
  return (
    <p className="auth-note">
      <T k="auth.needHelp" values={{ email, a: chunks => <a className="k-link" href={`mailto:${email}`}>{chunks}</a> }} />
    </p>
  )
}

// i18n-ignore: Always English: language picker label must be readable regardless of current UI language
const LANGUAGE_LABEL_EN = 'Language'

/**
 * The language before signing in: this browser only, until the member's own choice applies after sign-in. A globe and
 * "Language" in English (never translated) sit before the select, so someone who cannot read the current language
 * still finds it.
 */
function SignInLanguage() {
  const locale = useLocale()
  const id = useId()
  return (
    <div className="auth-language">
      <label className="auth-language-label" htmlFor={id} lang="en">
        <Icon name="globe" size={13} />
        {LANGUAGE_LABEL_EN}
      </label>
      <LanguageSelect
        id={id}
        value={isUiLocale(locale) || locale === PSEUDO_LOCALE ? locale : 'en'}
        onChange={next => void activate(next === AUTOMATIC ? 'en' : next, { remember: next !== PSEUDO_LOCALE })}
        withAutomatic={false}
        size="sm"
        align="start"
      />
    </div>
  )
}

function LegalLinksLine({ links }: { links: LegalLinks }) {
  const t = useT()
  const items = [
    links.terms && <a key="terms" href={links.terms} target="_blank" rel="noreferrer">{t('common.legal.terms')}</a>,
    links.privacy && <a key="privacy" href={links.privacy} target="_blank" rel="noreferrer">{t('common.legal.privacy')}</a>,
  ].filter(Boolean)
  if (!items.length) return null
  return <nav className="auth-legal" aria-label={t('auth.legalLabel')}>{items}</nav>
}

type CodeStepProps = {
  email: string
  /** SUPPORT_EMAIL of this install: named in the "No email?" line when set. */
  supportEmail?: string | null
  /** Signing in from an invitation: the address may sign in, so the page says the code was sent and does not send them to ask for an invitation. */
  invited?: boolean
  /** Self-serve sign-up is open (GET /v1/auth-methods): "No account for this email" links to the sign-up page. */
  selfServeSignup?: boolean
  onDone: () => Promise<void>
  onDifferentEmail: () => void
}

/** One field for the six digits: typing, pasting the whole code or the OS's one-time-code fill all work; the sixth digit submits. */
export function CodeStep({ email, supportEmail, invited = false, selfServeSignup = false, onDone, onDifferentEmail }: CodeStepProps) {
  const t = useT()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [waitS, setWaitS] = useState(RESEND_AFTER_S)
  const [late, setLate] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (waitS <= 0) return
    const timer = setTimeout(() => setWaitS(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitS])

  useEffect(() => {
    const timer = setTimeout(() => setLate(true), NO_CODE_HINT_AFTER_S * 1000)
    return () => clearTimeout(timer)
  }, [])

  async function check(value: string) {
    setBusy(true)
    setError(null)
    const res = await signInWithCode(email, value).catch(error => ({ error }))
    if (!res.error) {
      // Stay on "Signing in…" until the app has the account and replaces this page: no flash of the form.
      setSignedIn(true)
      rememberSignInMethod('email')
      return onDone()
    }
    setBusy(false)
    setError(codeErrorMessage(res.error))
    setCode('')
    input.current?.focus()
  }

  function change(value: string) {
    const digits = normalizeCode(value)
    setCode(digits)
    if (digits.length === CODE_LENGTH && !busy) void check(digits)
  }

  async function resend() {
    setError(null)
    setCode('')
    setWaitS(RESEND_AFTER_S)
    const res = await requestSignInCode(email).catch(error => ({ error }))
    if (res.error) setError(authErrorMessage(res.error))
    input.current?.focus()
  }

  return (
    <AuthPage>
      <form className="auth-card" noValidate onSubmit={e => { e.preventDefault(); if (code.length === CODE_LENGTH) void check(code) }}>
        <h1>{t('auth.code.title')}</h1>
        {/* No code goes to an address that cannot sign in (apps/api/src/signup-gate.ts), so the line hedges, and says the
            same for every address: whether this one has an account is not told (no account enumeration). From an
            invitation the address may sign in, so it says plainly that the code was sent. */}
        <p>{invited ? t('auth.code.sentInvited', { email }) : t('auth.code.sentIfAccount', { email })}</p>
        <input ref={input} className="auth-code" id="signin-code" name="code" aria-label={t('auth.code.label')} value={code}
          onChange={e => change(e.target.value)} disabled={busy}
          inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH + 6} autoFocus
          aria-describedby={error ? 'code-error' : undefined} />
        {error && <AuthError message={error} id="code-error" link={signupLinkFor(error, selfServeSignup)} />}
        <button type="submit" className={cx('k-btn k-btn-primary', (busy || signedIn) && 'is-busy')}
          disabled={busy || code.length < CODE_LENGTH} aria-busy={busy || signedIn || undefined}>
          {(busy || signedIn) && <Spinner />}
          {signedIn ? t('auth.signingIn') : busy ? t('auth.checking') : t('auth.signIn')}
        </button>
        <div className="auth-links">
          <button type="button" className="auth-switch" disabled={waitS > 0} onClick={() => void resend()}>
            {waitS > 0 ? t('auth.code.resendIn', { seconds: waitS }) : t('auth.code.resend')}
          </button>
          <button type="button" className="auth-switch" onClick={onDifferentEmail}>{t('auth.differentEmail')}</button>
        </div>
        {/* Said once when Resend opens, not every second of the countdown; focus stays in the code field. */}
        <span className="sr-only" role="status">{waitS > 0 ? '' : t('auth.code.resendReady')}</span>
        {/* Only after a minute without a sign-in: before that the email is most likely still on its way. */}
        {late && <NoCodeHint invited={invited} supportEmail={supportEmail} />}
      </form>
    </AuthPage>
  )
}

/** "No email? Check spam…": the code step shows it after NO_CODE_HINT_AFTER_S without a sign-in. */
export function NoCodeHint({ invited, supportEmail }: Pick<CodeStepProps, 'invited' | 'supportEmail'>) {
  const t = useT()
  return (
    <div className="auth-notes">
      <p className="auth-note">{t(invited ? 'auth.code.noEmailInvited' : 'auth.code.noEmail')}</p>
      {supportEmail && <NeedHelp email={supportEmail} />}
    </div>
  )
}

type ResetStepProps = { initialEmail: string; onDone: () => Promise<void>; onBack: () => void }

/**
 * "Forgot password?": the email, then the emailed code and a new password. The server ends every
 * session of the account; this browser then signs in with the new password.
 */
function ResetStep({ initialEmail, onDone, onBack }: ResetStepProps) {
  const t = useT()
  const [email, setEmail] = useState(initialEmail)
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'send' | 'reset' | 'signIn' | null>(null)
  const [waitS, setWaitS] = useState(0)

  useEffect(() => {
    if (waitS <= 0) return
    const timer = setTimeout(() => setWaitS(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitS])

  async function send(e?: FormEvent) {
    e?.preventDefault()
    const invalid = emailError(email)
    if (invalid) return setError(invalid)
    setBusy('send')
    setError(null)
    const res = await requestPasswordResetCode(email.trim()).catch(error => ({ error }))
    setBusy(null)
    if (res.error) return setError(authErrorMessage(res.error))
    setSent(true)
    setCode('')
    setWaitS(RESEND_AFTER_S)
  }

  async function reset(e: FormEvent) {
    e.preventDefault()
    if (code.length < CODE_LENGTH) return setError(t('auth.code.enter', { digits: CODE_LENGTH }))
    const invalid = newPasswordError(password)
    if (invalid) return setError(invalid)
    setBusy('reset')
    setError(null)
    const res = await resetPasswordWithCode(email.trim(), code, password).catch(error => ({ error }))
    if (res.error) {
      setBusy(null)
      return setError(resetErrorMessage(res.error))
    }
    // The password is set; sign in with it. Stay busy until the app replaces this page.
    setBusy('signIn')
    const signedIn = await auth.signIn.email({ email: email.trim(), password }).catch(error => ({ error }))
    if (signedIn.error) {
      setBusy(null)
      return setError(t('auth.reset.signInFailed'))
    }
    rememberSignInMethod('password')
    await onDone()
  }

  if (!sent) {
    return (
      <AuthPage>
        <form className="auth-card" noValidate onSubmit={send}>
          <h1>{t('auth.reset.title')}</h1>
          <p>{t('auth.reset.text')}</p>
          <div className="auth-form">
            <input type="email" id="reset-username" name="username" aria-label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} value={email}
              onChange={e => setEmail(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus
              aria-describedby={error ? 'reset-error' : undefined} />
            <button type="submit" className={cx('k-btn k-btn-primary', busy === 'send' && 'is-busy')} disabled={busy !== null}
              aria-busy={busy === 'send' || undefined}>
              {busy === 'send' && <Spinner />}
              {busy === 'send' ? t('auth.sending') : t('auth.reset.send')}
            </button>
            {error && <AuthError message={error} id="reset-error" />}
          </div>
          <button type="button" className="auth-switch" onClick={onBack}>{t('auth.reset.back')}</button>
        </form>
      </AuthPage>
    )
  }

  const working = busy === 'reset' || busy === 'signIn'
  return (
    <AuthPage>
      <form className="auth-card" noValidate onSubmit={reset}>
        <h1>{t('auth.code.title')}</h1>
        {/* The same words for every address: whether it has an account here is not told (no account enumeration). */}
        <p>{t('auth.reset.sent', { email: email.trim(), digits: CODE_LENGTH })}</p>
        <div className="auth-form">
          {/* The account the new password belongs to, for password managers: they update that login. */}
          <input type="email" name="username" autoComplete="username" value={email.trim()} readOnly hidden />
          <input className="auth-code" id="reset-code" name="code" aria-label={t('auth.reset.code')} value={code}
            onChange={e => setCode(normalizeCode(e.target.value))}
            disabled={working} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH + 6} autoFocus
            aria-describedby={error ? 'reset-error' : undefined} />
          <input type="password" id="reset-new-password" name="new-password" aria-label={t('auth.reset.newPassword')}
            placeholder={t('auth.reset.newPasswordPlaceholder', { min: 8 })} value={password} onChange={e => setPassword(e.target.value)}
            disabled={working} autoComplete="new-password" minLength={8} />
          <button type="submit" className={cx('k-btn k-btn-primary', working && 'is-busy')} disabled={busy !== null}
            aria-busy={working || undefined}>
            {working && <Spinner />}
            {busy === 'signIn' ? t('auth.signingIn') : busy === 'reset' ? t('common.action.saving') : t('auth.reset.set')}
          </button>
          {error && <AuthError message={error} id="reset-error" />}
        </div>
        <p className="auth-note">{t('auth.reset.signsOut')}</p>
        {waitS > 0
          ? <p className="auth-note">{t('auth.code.wait', { seconds: waitS })}</p>
          : <button type="button" className="auth-switch" disabled={busy !== null} onClick={() => void send()}>{t('auth.code.resend')}</button>}
        <button type="button" className="auth-switch" onClick={() => { setSent(false); setError(null) }}>{t('auth.differentEmail')}</button>
      </form>
    </AuthPage>
  )
}

/** Where the setup code is: the API prints it at start, setup-code.ts prints it again (apps/api/src/setup.ts; docs/hosting.md). */
const setupCodeHelp = (): HelpTipContent => {
  const { t } = i18n()
  return {
    text: t('auth.setup.codeHelp', { brand: brandName() }),
    commands: [
      { label: t('auth.setup.codeInLog'), code: 'docker compose logs api | grep -A2 "no admin yet"' },
      { label: t('auth.setup.codeAgain'), code: 'docker compose exec api node apps/api/src/setup-code.ts' },
      { label: t('auth.setup.codeLocal'), code: 'pnpm --filter @linedesk/api setup:code' },
    ],
  }
}

/** A fresh install: the setup code from the server log makes the first admin (apps/api/src/setup.ts). */
function SetupStep({ onDone }: { onDone: () => Promise<void> }) {
  const t = useT()
  const [form, setForm] = useState({ code: '', name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.code.trim() || !form.name.trim() || !form.email.trim()) return setError(t('auth.setup.missing'))
    if (form.password.length < 12) return setError(t('auth.setup.shortPassword', { min: 12 }))
    setBusy(true)
    setError(null)
    try {
      const result = await completeSetup(form)
      if (result.signedIn === false) return window.location.reload()
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <AuthPage>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>{t('auth.setup.title', { brand: brandName() })}</h1>
        <p>{t('auth.setup.text')}</p>
        <div className="auth-form">
          <span className="k-has-help">
            {/* From the server log, not a code by SMS or email: no one-time-code suggestions. */}
            <input id="setup-code" name="setup-code" aria-label={t('auth.setup.code')} placeholder={t('auth.setup.code')} value={form.code}
              onChange={set('code')} {...NO_PASSWORD_MANAGER} autoCapitalize="characters" spellCheck={false} autoFocus />
            <HelpTip inField label={t('auth.setup.codeWhere')} {...setupCodeHelp()} />
          </span>
          <input id="setup-name" name="name" aria-label={t('auth.setup.name')} placeholder={t('auth.setup.name')} value={form.name} onChange={set('name')}
            autoComplete="name" />
          <input type="email" id="setup-username" name="username" aria-label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} value={form.email}
            onChange={set('email')} autoComplete="username" autoCapitalize="none" spellCheck={false} />
          <input type="password" id="setup-new-password" name="new-password" aria-label={t('auth.method.password')}
            placeholder={t('auth.setup.passwordPlaceholder', { min: 12 })} value={form.password} onChange={set('password')} autoComplete="new-password"
            minLength={12} />
          <button type="submit" className="k-btn k-btn-primary" disabled={busy}>{busy ? t('auth.setup.busy') : t('auth.setup.submit')}</button>
          {error && <AuthError message={error} />}
        </div>
        <p className="auth-note">{t('auth.setup.next')}</p>
      </form>
    </AuthPage>
  )
}
