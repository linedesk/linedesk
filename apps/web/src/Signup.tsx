// Self-serve sign-up on Linedesk Cloud (`/signup?plan=cloud|partner&interval=year|month`, docs/billing.md §3.2): email,
// then the code, then the person's name. The business's name and country come in the onboarding's first step (Find
// your business); the API checks where the request comes from and says "not yet" outside the countries served. Plan
// `partner` (docs/white-label.md): a white-label partner account with its partner bill, no workspace, and its company's
// name; Stripe Checkout for the partner bill opens next, and it returns into the partner area. The API decides everything (open or not, the address, the bot check, the
// limits, the countries); this page only asks and says what came back. Only the plan and the interval travel in the
// address, never personal data.
import { T, useFormat, useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { auth, signInWithCode } from './auth.ts'
import { goToCheckout } from './checkout.ts'
import { browserPlace } from './countryHint.ts'
import { signOutAndForget } from './localData.ts'
import { CODE_LENGTH, codeErrorMessage, emailError, normalizeCode, RESEND_AFTER_S } from './sign-in-code.ts'
import {
  askSignupCode,
  type CodeRefusal,
  loadSignupConfig,
  readSignupParams,
  type SignupConfig,
  type SignupPlan,
  type SignupTerms,
  signUpBusiness,
  toCheckoutOrDone,
} from './signup.ts'
import { ExternalLink } from './ui/AppLink.tsx'
import { AuthError } from './ui/AuthError.tsx'
import { AuthPage, cx, Spinner } from './ui/kit.tsx'
import { loadTurnstile } from './turnstile.ts'

type Step = 'email' | 'code' | 'details'

/**
 * `signedIn`: someone is signed in already (an account the sign-up page made earlier, or an existing one): straight
 * to the details, their name filled in. `onDone`: the bill and workspace are made; the app loads it (the onboarding
 * comes next). A partner goes to Checkout instead; `onDone` only when Checkout could not open (the partner area, with
 * "Add a card"). `fromApp`: opened from the workspace menu by a
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
  if (step === 'email')
    return (
      <EmailStep
        config={config}
        partner={partner}
        onSent={address => {
          setEmail(address)
          setStep('code')
        }}
      />
    )
  if (step === 'code')
    return <CodeStep email={email} config={config} onDone={() => setStep('details')} onBack={() => setStep('email')} />
  return (
    <DetailsStep
      interval={params.interval}
      partner={partner}
      terms={config.terms!}
      planNow={!partner && !config.trial ? config.plan : null}
      fromApp={fromApp}
      onTermsChanged={() => void loadSignupConfig().then(setConfig)}
      onDone={workspaceId => onDone(partner, workspaceId)}
    />
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

/**
 * The Turnstile widget; `token` is null until it passed (or when it expired). `collapsed`: it passed without showing
 * anything (an invisible widget), so its box gives back the room kept for it.
 */
function useTurnstile(siteKey: string | null) {
  const box = useRef<HTMLDivElement>(null)
  const [token, setToken] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const reset = useRef<() => void>(() => {})
  useEffect(() => {
    const widget = box.current?.firstElementChild
    if (token && widget instanceof HTMLElement && widget.offsetHeight === 0) setCollapsed(true)
  }, [token])
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
  return { box, token, failed, collapsed, reset: () => reset.current() }
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
        <h1>{partner ? t('auth.signup.partnerTitle') : t('auth.signup.title')}</h1>
        <p>{partner ? t('auth.signup.partnerLead') : t('auth.signup.intro')}</p>
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
          {config.turnstileSiteKey && <TurnstileBox bot={bot} />}
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
        {waitS <= 0 && config.turnstileSiteKey && <TurnstileBox bot={bot} />}
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

/**
 * The last step: the person's name (and a partner's company name), nothing more; the business is found and named in
 * the onboarding's first step. Making the account accepts the terms and the privacy policy shown next to the button
 * (clickwrap, A9), for a business and a partner alike; the API records the versions with the time and the session's IP
 * address. A business goes on to set up its assistant without a card and adds one at the onboarding's last step
 * (`activate`), which shows the terms again and records them with what it charges; a partner goes straight on to
 * Checkout for its partner bill (the button says so), and to its area only when Checkout could not open. From a country not served yet (as the API sees the request): the "not yet" page.
 */
export function DetailsStep({
  interval,
  partner,
  terms,
  planNow,
  fromApp,
  onTermsChanged,
  onDone,
}: {
  interval: 'year' | 'month'
  /** Plan `partner`: the partner's company, not a business that answers calls. */
  partner: boolean
  terms: SignupTerms
  /** No free trial for this account (it had one): the plan, which starts at Checkout. Null: the trial. */
  planNow: SignupPlan | null
  fromApp?: { onBack: () => void }
  onTermsChanged: () => void
  onDone: (workspaceId: string | null) => void | Promise<void>
}) {
  const t = useT()
  const format = useFormat()
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
    // The button stays busy while the page leaves for Checkout.
    if (answer.ok)
      return toCheckoutOrDone(partner ? answer.partnerId : null, goToCheckout, () => onDone(answer.workspaceId))
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

  if (notYet) return <NotYet />
  return (
    <AuthPage>
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
        {planNow && (
          <p className="auth-plan-now">
            {t(interval === 'year' ? 'auth.signup.planNowYearly' : 'auth.signup.planNowMonthly', {
              price: usd(format, interval === 'year' ? planNow.yearlyCents : planNow.monthlyCents),
            })}
          </p>
        )}
        <p className="auth-terms">
          <T
            k={partner ? 'auth.signup.terms' : fromApp ? 'auth.signup.termsCreateWorkspace' : 'auth.signup.termsCreate'}
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
          {busy
            ? t('auth.setup.busy')
            : partner
              ? t('auth.signup.start')
              : fromApp
                ? t('auth.signup.createWorkspace')
                : t('auth.signup.createAccount')}
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
            {t('auth.differentAccount')}
          </button>
        )}
      </form>
    </AuthPage>
  )
}

/** A plan price in dollars, whole dollars without cents ("$9", "$90"), as the activation step shows it. */
const usd = (format: ReturnType<typeof useFormat>, cents: number) =>
  format.currency(cents / 100, 'USD', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })
