// Self-serve sign-up on Linedesk Cloud (`/signup?plan=cloud|partner&interval=year|month`, docs/billing.md §3.2): email,
// then the code, then the person's name, the business's name and its country. Plan `partner` (docs/white-label.md):
// a white-label partner account with its partner bill, no workspace; the app opens the partner area next. The API decides everything (open or not,
// the address, the bot check, the limits, the countries); this page only asks and says what came back. Only the plan
// and the interval travel in the address, never personal data.
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { signInWithCode } from './auth.ts'
import { browserPlace, useCountryHint } from './countryHint.ts'
import { signOutAndForget } from './localData.ts'
import { CountrySelect } from './settings/CountrySelect.tsx'
import { CODE_LENGTH, codeErrorMessage, emailError, normalizeCode, RESEND_AFTER_S } from './sign-in-code.ts'
import {
  askSignupCode,
  type CodeRefusal,
  loadSignupConfig,
  readSignupParams,
  type SignupConfig,
  signUpBusiness,
  SIGNUP_COUNTRIES,
  signupPlanLine,
} from './signup.ts'
import { AuthError } from './ui/AuthError.tsx'
import { AuthPage, cx, Spinner } from './ui/kit.tsx'
import { loadTurnstile } from './turnstile.ts'

type Step = 'email' | 'code' | 'details'

/**
 * `signedIn`: someone is signed in already (an account the sign-up page made earlier, or an existing one): straight
 * to the details. `onDone`: the bill and workspace (or the partner) are made; the app loads it (Checkout comes next).
 */
export function Signup({
  signedIn,
  onDone,
}: {
  signedIn: boolean
  onDone: (partner: boolean) => void | Promise<void>
}) {
  const t = useT()
  const [params] = useState(readSignupParams)
  const [config, setConfig] = useState<SignupConfig | 'unreachable' | null>(null)
  const [step, setStep] = useState<Step>(signedIn ? 'details' : 'email')
  const [email, setEmail] = useState('')

  useEffect(() => {
    void loadSignupConfig().then(setConfig)
  }, [])

  // Another plan than these: the same "not yet" as a country we do not serve.
  if (params.plan !== 'cloud' && params.plan !== 'partner') return <NotYet />
  const partner = params.plan === 'partner'
  if (config === null)
    return (
      <AuthPage>
        <p className="auth-wait">{t('auth.connecting')}</p>
      </AuthPage>
    )
  if (config === 'unreachable')
    return (
      <AuthPage>
        <AuthError message={t('auth.error.server')} />
      </AuthPage>
    )
  if (!config.open) return <Closed />
  const line = partner
    ? config.partnerPlan && signupPlanLine(config.partnerPlan, params.interval, true)
    : config.plan && signupPlanLine(config.plan, params.interval)
  if (step === 'email')
    return (
      <EmailStep
        config={config}
        line={line || null}
        onSent={address => {
          setEmail(address)
          setStep('code')
        }}
      />
    )
  if (step === 'code')
    return <CodeStep email={email} config={config} onDone={() => setStep('details')} onBack={() => setStep('email')} />
  return (
    <DetailsStep interval={params.interval} partner={partner} line={line || null} onDone={() => onDone(partner)} />
  )
}

function Closed() {
  const t = useT()
  return (
    <AuthPage>
      <div className="auth-card">
        <h1>{t('auth.signup.closedTitle')}</h1>
        <p>{t('auth.signup.closedText')}</p>
        <a className="auth-switch" href="/">
          {t('auth.signup.toSignIn')}
        </a>
      </div>
    </AuthPage>
  )
}

/** Outside the US, Canada and Puerto Rico, and the partner plan: not yet. */
function NotYet() {
  const t = useT()
  return (
    <AuthPage>
      <div className="auth-card">
        <h1>{t('auth.signup.notYetTitle')}</h1>
        <p>{t('auth.signup.notYetText')}</p>
        <a className="auth-switch" href="/">
          {t('auth.signup.toSignIn')}
        </a>
      </div>
    </AuthPage>
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

/** The Turnstile widget; `token` is null until it passed (or when it expired). */
function useTurnstile(siteKey: string | null) {
  const box = useRef<HTMLDivElement>(null)
  const [token, setToken] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const reset = useRef<() => void>(() => {})
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
          callback: (value: string) => setToken(value),
          'expired-callback': () => setToken(null),
          'error-callback': () => setFailed(true),
        })
        reset.current = () => {
          setToken(null)
          turnstile.reset(widget)
        }
      })
      .catch(() => setFailed(true))
    return () => {
      removed = true
      if (widget) window.turnstile?.remove(widget)
    }
  }, [siteKey])
  return { box, token, failed, reset: () => reset.current() }
}

function EmailStep({
  config,
  line,
  onSent,
}: {
  config: SignupConfig
  /** The plan picked in the address, in words. */
  line: string | null
  onSent: (email: string) => void
}) {
  const t = useT()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const bot = useTurnstile(config.turnstileSiteKey)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const problem = emailError(email)
    if (problem) return setError(problem)
    if (config.turnstileSiteKey && !bot.token) return setError(t('auth.signup.refused.botCheck'))
    setBusy(true)
    setError(null)
    const answer = await askSignupCode(email.trim(), bot.token ?? '')
    setBusy(false)
    if (answer.ok) return onSent(email.trim())
    setError(answer.reason === 'unreachable' ? t('auth.error.server') : refusalText(t, answer.reason))
    // A Turnstile token is good for one check.
    bot.reset()
  }

  return (
    <AuthPage>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>{t('auth.signup.title')}</h1>
        {line && <p className="auth-hint">{line}</p>}
        <p>{t('auth.signup.intro')}</p>
        <div className="auth-form">
          <input
            type="email"
            aria-label={t('auth.email')}
            placeholder={t('auth.emailPlaceholder')}
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            disabled={busy}
          />
          {config.turnstileSiteKey && <div ref={bot.box} className="auth-turnstile" />}
          {bot.failed && <AuthError message={t('auth.signup.botCheckFailed')} />}
          <button
            type="submit"
            className={cx('k-btn k-btn-primary', busy && 'is-busy')}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy && <Spinner />}
            {busy ? t('auth.sending') : t('auth.signup.sendCode')}
          </button>
          {error && <AuthError message={error} />}
        </div>
        <a className="auth-switch" href="/">
          {t('auth.signup.haveAccount')}
        </a>
      </form>
    </AuthPage>
  )
}

function CodeStep({
  email,
  config,
  onDone,
  onBack,
}: {
  email: string
  config: SignupConfig
  onDone: () => void
  onBack: () => void
}) {
  const t = useT()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [waitS, setWaitS] = useState(RESEND_AFTER_S)
  const bot = useTurnstile(waitS > 0 ? null : config.turnstileSiteKey)

  useEffect(() => {
    if (waitS <= 0) return
    const timer = setTimeout(() => setWaitS(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitS])

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
    if (config.turnstileSiteKey && !bot.token) return setError(t('auth.signup.refused.botCheck'))
    setError(null)
    const answer = await askSignupCode(email, bot.token ?? '')
    bot.reset()
    if (!answer.ok)
      return setError(answer.reason === 'unreachable' ? t('auth.error.server') : refusalText(t, answer.reason))
    setWaitS(RESEND_AFTER_S)
  }

  return (
    <AuthPage>
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
        >
          {busy && <Spinner />}
          {busy ? t('auth.checking') : t('auth.signup.continue')}
        </button>
        {waitS <= 0 && config.turnstileSiteKey && <div ref={bot.box} className="auth-turnstile" />}
        <div className="auth-links">
          <button type="button" className="auth-switch" disabled={waitS > 0} onClick={() => void resend()}>
            {waitS > 0 ? t('auth.code.resendIn', { seconds: waitS }) : t('auth.code.resend')}
          </button>
          <button type="button" className="auth-switch" onClick={onBack}>
            {t('auth.differentEmail')}
          </button>
        </div>
      </form>
    </AuthPage>
  )
}

function DetailsStep({
  interval,
  partner,
  line,
  onDone,
}: {
  interval: 'year' | 'month'
  /** Plan `partner`: the partner's company, not a business that answers calls. */
  partner: boolean
  line: string | null
  onDone: () => void | Promise<void>
}) {
  const t = useT()
  const [name, setName] = useState('')
  const [business, setBusiness] = useState('')
  const hint = useCountryHint()
  const [picked, setPicked] = useState<string | null>(null)
  const country = picked ?? hint?.country ?? ''
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const notServed = Boolean(country) && !(SIGNUP_COUNTRIES as readonly string[]).includes(country)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!name.trim()) return setError(t('auth.signup.nameMissing'))
    if (!business.trim()) return setError(t('auth.create.nameMissing'))
    if (!country) return setError(t('shell.newWorkspace.countryMissing'))
    if (notServed) return setError(t('auth.signup.notYetText'))
    setBusy(true)
    setError(null)
    const answer = await signUpBusiness({
      name: name.trim(),
      businessName: business.trim(),
      country,
      plan: partner ? 'partner' : 'cloud',
      interval,
      timeZone: browserPlace().timeZone ?? undefined,
    })
    if (answer.ok) return onDone()
    setBusy(false)
    setError(
      answer.partnerOwned
        ? t('auth.signup.partnerOwned')
        : answer.notYet
          ? t('auth.signup.notYetText')
          : answer.closed
            ? t('auth.signup.closedText')
            : t('auth.signup.failed'),
    )
  }

  return (
    <AuthPage>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>{partner ? t('auth.signup.partnerDetailsTitle') : t('auth.signup.detailsTitle')}</h1>
        <p>{partner ? t('auth.signup.partnerDetailsText') : t('auth.signup.detailsText')}</p>
        {line && <p className="auth-hint">{line}</p>}
        <label>
          {t('auth.signup.yourName')}
          <input value={name} onChange={e => setName(e.target.value)} autoComplete="name" autoFocus disabled={busy} />
        </label>
        <label>
          {partner ? t('auth.signup.partnerName') : t('shell.newWorkspace.name')}
          <input
            value={business}
            onChange={e => setBusiness(e.target.value)}
            autoComplete="organization"
            disabled={busy}
          />
        </label>
        <div className="auth-field">
          <label htmlFor="signup-country">{t('settings.general.country.label')}</label>
          <CountrySelect id="signup-country" value={country} onChange={setPicked} disabled={busy} />
          {notServed && <span className="auth-hint">{t('auth.signup.notYetText')}</span>}
        </div>
        {error && <AuthError message={error} />}
        <button
          type="submit"
          className={cx('k-btn k-btn-primary', busy && 'is-busy')}
          disabled={busy || notServed}
          aria-busy={busy || undefined}
        >
          {busy && <Spinner />}
          {busy ? t('auth.setup.busy') : t('auth.signup.start')}
        </button>
        <button
          type="button"
          className="auth-switch"
          onClick={() => void signOutAndForget().then(() => window.location.reload())}
        >
          {t('auth.differentAccount')}
        </button>
      </form>
    </AuthPage>
  )
}
