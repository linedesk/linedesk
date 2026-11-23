// Self-serve sign-up on Linedesk Cloud (`/signup?plan=cloud|partner&interval=year|month`): email,
// then the code, then the person's name. The business's name and country come in the onboarding's first step (Find
// your business); the API checks where the request comes from and says "not yet" outside the countries served. Plan
// `partner` (docs/white-label.md): a white-label partner account with its partner bill, no workspace, and its company's
// name; its owner's agent setup page (#partner/agent) opens next, and "Activate White-label Cloud" there opens Stripe
// Checkout once the setup is ready (setup before payment, 2026-11-18). The API decides everything (open or not, the address, the bot check, the
// limits, the countries); this page only asks and says what came back. Only the plan and the interval travel in the
// address, never personal data.
import { T, useT } from '@linedesk/i18n/react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { auth, providerSignInElsewhere, type SsoMethod, signInWithCode, startSso, takeRedirectError } from './auth.ts'
import { rememberSignInMethod } from './sign-in-methods.ts'
import { ProviderButton } from './ui/brand-logos.tsx'
import { CardFooter, CodeWait, HaveAccount, useAuthMethods } from './Login.tsx'
import { browserPlace } from './countryHint.ts'
import { signOutAndForget } from './localData.ts'
import {
  CODE_LENGTH,
  codeErrorMessage,
  emailError,
  normalizeCode,
  RESEND_AFTER_S,
  resendInText,
} from './sign-in-code.ts'
import {
  askProviderSignup,
  askSignupCode,
  type CodeRefusal,
  loadSignupConfig,
  readSignupParams,
  type SignupConfig,
  type SignupTerms,
  signUpBusiness,
} from './signup.ts'
import { ExternalLink } from './ui/AppLink.tsx'
import { AuthError } from './ui/AuthError.tsx'
import { cx, Spinner } from './ui/kit.tsx'
import { SignedInAuthPage, WaitLine } from './shell/SignedInAuthPage.tsx'
import { loadTurnstile } from './turnstile.ts'

type Step = 'email' | 'code' | 'details'

/**
 * `signedIn`: someone is signed in already (an account the sign-up page made earlier, or an existing one): straight
 * to the details, their name filled in. `onDone`: the bill and workspace are made; the app loads it (the onboarding
 * comes next). A partner too: its agent setup page comes next, Checkout only once it activates White-label Cloud there.
 * `fromApp`: opened from the workspace menu by a
 * Cloud customer who adds a workspace (its own bill); Back returns to the workspace they came from.
 */
export function Signup({
  signedIn,
  fromApp,
  onDone,
}: {
  signedIn: boolean
  fromApp?: { onBack: () => void }
  onDone: (partner: boolean, workspaceId: string | null) => void | Promise<void>
}) {
  const t = useT()
  const [params] = useState(readSignupParams)
  const [config, setConfig] = useState<SignupConfig | 'unreachable' | null>(null)
  const [step, setStep] = useState<Step>(signedIn ? 'details' : 'email')
  const [email, setEmail] = useState('')
  // The server's cooldown after the first code (null from an older server: the usual first wait).
  const [firstWait, setFirstWait] = useState<number | null>(null)

  useEffect(() => {
    void loadSignupConfig().then(setConfig)
  }, [])

  // Another plan than these: the same "not yet" as a country we do not serve.
  if (params.plan !== 'cloud' && params.plan !== 'partner') return <NotYet />
  const partner = params.plan === 'partner'
  // A partner's own sign-up: the install's brand on every card, as on its team invitation (PartnerInvite).
  if (config === null)
    return (
      <SignedInAuthPage install={partner}>
        <WaitLine />
      </SignedInAuthPage>
    )
  if (config === 'unreachable')
    return (
      <SignedInAuthPage install={partner}>
        <AuthError message={t('auth.error.server')} />
      </SignedInAuthPage>
    )
  if (!config.open) return <Closed install={partner} />
  if (step === 'email')
    return (
      <EmailStep
        config={config}
        partner={partner}
        onSent={(address, retryAfter) => {
          setEmail(address)
          setFirstWait(retryAfter)
          setStep('code')
        }}
      />
    )
  if (step === 'code')
    return (
      <CodeStep
        email={email}
        config={config}
        partner={partner}
        firstWait={firstWait}
        onDone={() => setStep('details')}
        onBack={() => setStep('email')}
      />
    )
  return (
    <DetailsStep
      interval={params.interval}
      partner={partner}
      terms={config.terms!}
      noTrial={!partner && !config.trial}
      fromApp={fromApp}
      onTermsChanged={() => void loadSignupConfig().then(setConfig)}
      onDone={workspaceId => onDone(partner, workspaceId)}
    />
  )
}

function Closed({ install }: { install?: boolean }) {
  const t = useT()
  return (
    <SignedInAuthPage install={install}>
      <div className="auth-card">
        <h1>{t('auth.signup.closedTitle')}</h1>
        <p>{t('auth.signup.closedText')}</p>
        <a className="auth-switch" href="/">
          {t('auth.signup.toSignIn')}
        </a>
      </div>
    </SignedInAuthPage>
  )
}

/** Outside the US, Canada and Puerto Rico, and the partner plan: not yet. */
function NotYet({ install }: { install?: boolean }) {
  const t = useT()
  return (
    <SignedInAuthPage install={install}>
      <div className="auth-card">
        <h1>{t('auth.signup.notYetTitle')}</h1>
        <p>{t('auth.signup.notYetText')}</p>
        <a className="auth-switch" href="/">
          {t('auth.signup.toSignIn')}
        </a>
      </div>
    </SignedInAuthPage>
  )
}

/** A refused code request in the page's words. */
function refusalText(t: ReturnType<typeof useT>, reason: CodeRefusal) {
  switch (reason) {
    case 'blocked_domain':
      return t('auth.signup.refused.blockedDomain')
    case 'bot_check':
      return t('auth.signup.refused.botCheck')
    case 'too_many':
      return t('auth.signup.refused.tooMany')
    case 'busy':
      return t('auth.signup.refused.busy')
    case 'closed':
      return t('auth.signup.closedText')
    case 'invalid_email':
      return t('auth.error.invalidEmail')
    default:
      return t('auth.error.unexpected')
  }
}

/**
 * The Turnstile widget; `token` is null until it passed (or when it expired). It shows only when Cloudflare needs the
 * person to act (`interaction-only`); `collapsed` while nothing shows, so its box takes no room. `ready` waits for the
 * token (a few seconds at most for a check that needs nobody), for a button pressed before it came.
 */
function useTurnstile(siteKey: string | null) {
  const box = useRef<HTMLDivElement>(null)
  const [token, setToken] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [collapsed, setCollapsed] = useState(true)
  const reset = useRef<() => void>(() => {})
  const latest = useRef<string | null>(null)
  const waiting = useRef<((token: string | null) => void)[]>([])
  const take = useCallback((value: string | null) => {
    latest.current = value
    setToken(value)
    if (value) for (const resolve of waiting.current.splice(0)) resolve(value)
  }, [])
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const widget = el.firstElementChild
      setCollapsed(!(widget instanceof HTMLElement) || widget.offsetHeight === 0)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!siteKey || !box.current) return
    let removed = false
    let widget: string | undefined
    void loadTurnstile()
      .then(turnstile => {
        if (removed || !box.current) return
        widget = turnstile.render(box.current, {
          sitekey: siteKey,
          action: 'signup',
          appearance: 'interaction-only',
          callback: take,
          'expired-callback': () => take(null),
          'error-callback': () => {
            setFailed(true)
            for (const resolve of waiting.current.splice(0)) resolve(null)
          },
        })
        reset.current = () => {
          take(null)
          turnstile.reset(widget)
        }
      })
      .catch(() => setFailed(true))
    return () => {
      removed = true
      if (widget) window.turnstile?.remove(widget)
    }
  }, [siteKey, take])
  /** The token, waiting up to `ms` for one still on its way; null when none came (the bot check failed or needs the person). */
  const ready = (ms = 8000): Promise<string | null> =>
    latest.current || failed
      ? Promise.resolve(latest.current)
      : new Promise(resolve => {
          waiting.current.push(resolve)
          setTimeout(() => resolve(latest.current), ms)
        })
  return { box, token, failed, collapsed, ready, reset: () => reset.current() }
}

/** Counts `waitS` down by one a second until 0. */
function useCountdown(waitS: number, setWaitS: (update: (s: number) => number) => void) {
  useEffect(() => {
    if (waitS <= 0) return
    const timer = setTimeout(() => setWaitS(s => Math.max(0, s - 1)), 1000)
    return () => clearTimeout(timer)
  }, [waitS, setWaitS])
}

/** Where the Turnstile widget renders: centered under the field, whatever its width (app.css `.auth-turnstile`). */
export function TurnstileBox({ bot }: { bot: Pick<ReturnType<typeof useTurnstile>, 'box' | 'collapsed'> }) {
  return <div ref={bot.box} className={cx('auth-turnstile', bot.collapsed && 'is-collapsed')} />
}

/** The first step. Plan `partner`: White-label Cloud's name and what it is for, with its free days (none: left out). */
export function EmailStep({
  config,
  partner,
  onSent,
}: {
  config: SignupConfig
  partner: boolean
  onSent: (email: string, retryAfter: number | null) => void
}) {
  const t = useT()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Refused for now (too many codes for this address or network): when a new code can be asked for, counting down.
  const [waitS, setWaitS] = useState(0)
  const bot = useTurnstile(config.turnstileSiteKey)
  const methods = useAuthMethods()
  const links = methods?.links ?? null
  // The install's sign-in providers, as on the sign-in page; none where they only work at another address.
  const providers = methods && !providerSignInElsewhere(methods) ? methods.sso : []
  // A provider sign-up that came back refused (its ticket expired, the address's domain, sign-up closed meanwhile).
  const [returned, setReturned] = useState<string | null>(null)
  useEffect(() => {
    if (takeRedirectError()) setReturned(t('auth.signup.providerRefused'))
  }, [t])
  const [opening, setOpening] = useState<string | null>(null)
  useCountdown(waitS, setWaitS)

  /** The bot check's token, waiting for one still on its way; null (with the page's words) when there is none. */
  async function botToken(): Promise<string | null> {
    if (!config.turnstileSiteKey) return ''
    const token = await bot.ready()
    if (!token) setError(t('auth.signup.refused.botCheck'))
    return token
  }

  /** A refused attempt in the page's words; a limit counts down until it lets the next one through. */
  function refused(answer: { reason: CodeRefusal | 'unreachable'; retryAfter: number | null }) {
    if (answer.retryAfter && (answer.reason === 'too_many' || answer.reason === 'busy')) {
      setError(answer.reason === 'busy' ? t('auth.signup.refused.busyFor') : null)
      setWaitS(answer.retryAfter)
    } else setError(answer.reason === 'unreachable' ? t('auth.error.server') : refusalText(t, answer.reason))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || opening) return
    const problem = emailError(email)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    const token = await botToken()
    if (token === null) return setBusy(false)
    const answer = await askSignupCode(email.trim(), token)
    setBusy(false)
    if (answer.ok) return onSent(email.trim(), answer.retryAfter)
    refused(answer)
    // A Turnstile token is good for one check.
    bot.reset()
  }

  /**
   * Continue with a provider: the same checks as a code first (the API keeps a ticket in a cookie), then the
   * provider's page; it comes back here signed in, and the details step follows, terms and all.
   */
  async function continueWith(method: SsoMethod) {
    if (busy || opening) return
    setOpening(method.id)
    setError(null)
    const token = await botToken()
    if (token === null) return setOpening(null)
    const answer = await askProviderSignup(token)
    bot.reset()
    if (!answer.ok) {
      setOpening(null)
      return refused(answer)
    }
    rememberSignInMethod(method.id)
    const res = await startSso(method).catch(() => ({ error: true }))
    if (res.error) {
      setOpening(null)
      setError(t('auth.error.server'))
    }
  }

  return (
    <SignedInAuthPage install={partner}>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>
          {partner
            ? t('auth.signup.partnerTitle')
            : config.trial
              ? t('auth.signup.title')
              : t('auth.signup.titleNoTrial')}
        </h1>
        <p>{partner ? t('auth.signup.partnerLead') : t('auth.signup.intro')}</p>
        <div className="auth-form">
          <input
            type="email"
            aria-label={t('auth.email')}
            placeholder={t('auth.emailPlaceholder')}
            value={email}
            onChange={e => {
              setEmail(e.target.value)
              // Another address may ask at once (the wait was for the one refused).
              setWaitS(0)
            }}
            autoComplete="email"
            autoFocus
            disabled={busy || opening !== null}
          />
          {config.turnstileSiteKey && <TurnstileBox bot={bot} />}
          {bot.failed && <AuthError message={t('auth.signup.botCheckFailed')} />}
          <button
            type="submit"
            className={cx('k-btn k-btn-primary', busy && 'is-busy')}
            disabled={busy || opening !== null}
            aria-busy={busy || undefined}
          >
            {busy && <Spinner />}
            {t('auth.signup.sendCode')}
          </button>
          {(error ?? returned) && <AuthError message={(error ?? returned)!} />}
          {waitS > 0 && <CodeWait waitS={waitS} providerNote={t('auth.signup.waitHaveAccount')} />}
          {providers.length > 0 && waitS <= 0 && (
            <>
              <div className="auth-or">{t('auth.signup.or')}</div>
              {providers.map(m => (
                <ProviderButton
                  key={m.id}
                  method={m.id}
                  label={m.label}
                  lastUsed={false}
                  busy={opening === m.id}
                  disabled={busy || opening !== null}
                  onClick={() => void continueWith(m)}
                />
              ))}
            </>
          )}
        </div>
        <CardFooter links={links} note={<HaveAccount />} />
      </form>
    </SignedInAuthPage>
  )
}

function CodeStep({
  email,
  config,
  partner,
  firstWait,
  onDone,
  onBack,
}: {
  email: string
  config: SignupConfig
  partner: boolean
  /** The server's cooldown after the first code; null: the usual first wait. */
  firstWait: number | null
  onDone: () => void
  onBack: () => void
}) {
  const t = useT()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [waitS, setWaitS] = useState(firstWait ?? RESEND_AFTER_S)
  // A resend refused for now: when a new code can be asked for, and the other ways in (LIN-661).
  const [limited, setLimited] = useState(false)
  const bot = useTurnstile(waitS > 0 ? null : config.turnstileSiteKey)
  const links = useAuthMethods()?.links ?? null
  useCountdown(waitS, setWaitS)

  async function check(value: string) {
    setBusy(true)
    setError(null)
    const res = await signInWithCode(email, value).catch(error => ({ error }))
    setBusy(false)
    if (!res.error) return onDone()
    setError(codeErrorMessage(res.error))
    setCode('')
  }

  function change(value: string) {
    const digits = normalizeCode(value)
    setCode(digits)
    if (digits.length === CODE_LENGTH && !busy) void check(digits)
  }

  async function resend() {
    setError(null)
    const token = config.turnstileSiteKey ? await bot.ready() : ''
    if (token === null) return setError(t('auth.signup.refused.botCheck'))
    setLimited(false)
    const answer = await askSignupCode(email, token)
    bot.reset()
    if (answer.ok) return setWaitS(answer.retryAfter ?? RESEND_AFTER_S)
    if (answer.retryAfter && (answer.reason === 'too_many' || answer.reason === 'busy')) {
      setWaitS(answer.retryAfter)
      setLimited(true)
      return
    }
    setError(answer.reason === 'unreachable' ? t('auth.error.server') : refusalText(t, answer.reason))
  }

  return (
    <SignedInAuthPage install={partner}>
      <form
        className="auth-card"
        noValidate
        onSubmit={e => {
          e.preventDefault()
          if (code.length === CODE_LENGTH) void check(code)
        }}
      >
        <h1>{t('auth.code.title')}</h1>
        <p>{t('auth.code.sentInvited', { email })}</p>
        <input
          className="auth-code"
          aria-label={t('auth.code.label')}
          placeholder={t('auth.code.label')}
          value={code}
          onChange={e => change(e.target.value)}
          disabled={busy}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={CODE_LENGTH + 6}
          autoFocus
        />
        {error && <AuthError message={error} />}
        <button
          type="submit"
          className={cx('k-btn k-btn-primary', busy && 'is-busy')}
          disabled={busy || code.length < CODE_LENGTH}
          aria-busy={busy || undefined}
        >
          {busy && <Spinner />}
          {t('auth.signup.continue')}
        </button>
        {waitS <= 0 && config.turnstileSiteKey && <TurnstileBox bot={bot} />}
        {limited && waitS > 0 && <CodeWait waitS={waitS} providerNote={t('auth.signup.waitHaveAccount')} />}
        <div className="auth-links">
          <button type="button" className="auth-switch" disabled={waitS > 0} onClick={() => void resend()}>
            {waitS > 0 ? resendInText(waitS) : t('auth.code.resend')}
          </button>
          <button type="button" className="auth-switch" onClick={onBack}>
            {t('auth.differentEmail')}
          </button>
        </div>
        <CardFooter links={links} />
      </form>
    </SignedInAuthPage>
  )
}

/**
 * The last step: the person's name (and a partner's company name), nothing more; the business is found and named in
 * the onboarding's first step. Making the account accepts the terms and the privacy policy shown next to the button
 * (clickwrap, A9), for a business and a partner alike; the API records the versions with the time and the session's IP
 * address. A business goes on to set up its assistant without a card and adds one at the onboarding's last step
 * (`activate`), which never asks for the terms again; a partner goes on to its agent setup page and pays when it
 * activates White-label Cloud there. Neither sees a price here: it comes with the plan at that last step. From a country not served yet (as the API sees the request):
 * the "not yet" page.
 */
export function DetailsStep({
  interval,
  partner,
  terms,
  noTrial = false,
  fromApp,
  onTermsChanged,
  onDone,
}: {
  interval: 'year' | 'month'
  /** Plan `partner`: the partner's company, not a business that answers calls. */
  partner: boolean
  terms: SignupTerms
  /** No free trial for this account (it had one): its plan starts at the setup's last step, never here. */
  noTrial?: boolean
  fromApp?: { onBack: () => void }
  onTermsChanged: () => void
  onDone: (workspaceId: string | null) => void | Promise<void>
}) {
  const t = useT()
  // Signed in already: the account's name, which the person may still change.
  const known = auth.useSession().data?.user?.name ?? ''
  const [typed, setName] = useState<string | null>(null)
  const name = typed ?? known
  const [company, setCompany] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notYet, setNotYet] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!name.trim()) return setError(t('auth.signup.nameMissing'))
    if (partner && !company.trim()) return setError(t('auth.signup.partnerNameMissing'))
    setBusy(true)
    setError(null)
    const place = browserPlace()
    const answer = await signUpBusiness({
      name: name.trim(),
      ...(partner ? { businessName: company.trim() } : {}),
      plan: partner ? 'partner' : 'cloud',
      interval,
      timeZone: place.timeZone ?? undefined,
      locale: place.locale ?? undefined,
      acceptedTerms: { termsVersion: terms.termsVersion, privacyVersion: terms.privacyVersion },
    })
    // A partner sets up first (its agent setup page) and pays when it activates White-label Cloud there (2026-11-18).
    if (answer.ok) return onDone(answer.workspaceId)
    setBusy(false)
    if (answer.notYet) return setNotYet(true)
    // Changed while the page was open: the new links are loaded, and the person reads them and continues again.
    if (answer.termsChanged) onTermsChanged()
    setError(
      answer.termsChanged
        ? t('auth.signup.termsChanged')
        : answer.partnerOwned
          ? t('auth.signup.partnerOwned')
          : answer.closed
            ? t('auth.signup.closedText')
            : t('auth.signup.failed'),
    )
  }

  if (notYet) return <NotYet install={partner} />
  return (
    <SignedInAuthPage install={partner}>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>
          {partner
            ? t('auth.signup.partnerDetailsTitle')
            : fromApp
              ? t('auth.signup.newWorkspaceTitle')
              : t('auth.signup.nameTitle')}
        </h1>
        <p>{partner ? t('auth.signup.partnerDetailsText') : t('auth.signup.nameText')}</p>
        <label>
          {t('auth.signup.yourName')}
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            autoComplete="name"
            autoFocus={!name}
            disabled={busy}
          />
        </label>
        {partner && (
          <label>
            {t('auth.signup.partnerName')}
            <input
              value={company}
              onChange={e => setCompany(e.target.value)}
              autoComplete="organization"
              disabled={busy}
            />
          </label>
        )}
        {error && <AuthError message={error} />}
        {partner && <p className="auth-plan-now">{t('auth.signup.partnerPayLater')}</p>}
        {/* Nothing is charged at sign-up: the plan and its price come at the setup's last step (Activate). */}
        {noTrial && <p className="auth-plan-now">{t('auth.signup.payLater')}</p>}
        <p className="auth-terms">
          <T
            k={fromApp ? 'auth.signup.termsCreateWorkspace' : 'auth.signup.termsCreate'}
            values={{
              terms: chunks => <ExternalLink href={terms.termsUrl}>{chunks}</ExternalLink>,
              privacy: chunks => <ExternalLink href={terms.privacyUrl}>{chunks}</ExternalLink>,
            }}
          />
        </p>
        <button
          type="submit"
          className={cx('k-btn k-btn-primary', busy && 'is-busy')}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy && <Spinner />}
          {fromApp ? t('auth.signup.createWorkspace') : t('auth.signup.createAccount')}
        </button>
        {fromApp ? (
          <button type="button" className="auth-switch" disabled={busy} onClick={fromApp.onBack}>
            {t('auth.back')}
          </button>
        ) : (
          <button
            type="button"
            className="auth-switch"
            onClick={() => void signOutAndForget().then(() => window.location.reload())}
          >
            {t('auth.differentEmail')}
          </button>
        )}
      </form>
    </SignedInAuthPage>
  )
}
