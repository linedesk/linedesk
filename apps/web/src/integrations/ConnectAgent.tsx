// The consent page of an MCP client's OAuth sign-in (LIN-126, docs/api.md): GET /oauth/authorize sends the person here
// (#connect-agent?<the request>). It shows who asks, where the answer goes and the account it will act as; Allow
// (oauth.approve, with the same confirmation a new personal key needs) sends the browser back to the client with a
// single-use code, Cancel with access_denied. Signed out, the sign-in keeps the hash and comes back here.
import {
  OAUTH_CONSENT_HASH,
  OAUTH_PROBLEMS,
  type OAuthApproveData,
  type OAuthDescribeData,
  type OAuthProblem,
  type OAuthRequest,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { brandName } from '../brand.ts'
import { StepUpFields, StepUpSubmit, useKeyStepUp } from '../settings/account/KeyStepUp.tsx'
import { callAction } from '../settings/settings-api.ts'
import { AuthError } from '../ui/AuthError.tsx'
import { AuthPage, Button } from '../ui/kit.tsx'

export const isConnectAgentHash = (hash: string) =>
  hash === OAUTH_CONSENT_HASH || hash.startsWith(`${OAUTH_CONSENT_HASH}?`)

/** The authorization request in the hash, or null when the link lost its client or redirect. */
export function readConnectRequest(hash: string): OAuthRequest | null {
  const params = new URLSearchParams(hash.slice(OAUTH_CONSENT_HASH.length + 1))
  const client_id = params.get('client_id')
  const redirect_uri = params.get('redirect_uri')
  if (!client_id || !redirect_uri) return null
  const optional = ['response_type', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope'] as const
  const request: OAuthRequest = { client_id, redirect_uri }
  for (const name of optional) {
    const value = params.get(name)
    if (value !== null) request[name] = value
  }
  return request
}

type Problem = OAuthProblem | 'request' | 'tooManyKeys' | 'emailUnconfirmed'

const PROBLEM_TEXT: Record<Problem, MessageKey> = {
  client: msg('account.connectAgent.problem.client'),
  redirect: msg('account.connectAgent.problem.redirect'),
  response_type: msg('account.connectAgent.problem.response_type'),
  pkce: msg('account.connectAgent.problem.pkce'),
  resource: msg('account.connectAgent.problem.resource'),
  metadata_unreachable: msg('account.connectAgent.problem.metadata_unreachable'),
  request: msg('account.connectAgent.problem.request'),
  tooManyKeys: msg('account.connectAgent.problem.tooManyKeys'),
  emailUnconfirmed: msg('account.connectAgent.problem.emailUnconfirmed'),
}

/** The refusal code of a failed action as a problem this page has a text for; null for anything else. */
function problemOf(err: unknown): Problem | null {
  const code = (err as { code?: unknown }).code
  if (code === 'TOO_MANY_KEYS') return 'tooManyKeys'
  if (code === 'EMAIL_NOT_VERIFIED') return 'emailUnconfirmed'
  return (OAUTH_PROBLEMS as readonly unknown[]).includes(code) ? (code as OAuthProblem) : null
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AuthPage>
      <div className="auth-card connect-agent">
        <h1>{title}</h1>
        {children}
      </div>
    </AuthPage>
  )
}

/** `onLeave` opens the app instead (the hash is cleared): for a request that cannot be approved. */
export function ConnectAgent({ onLeave }: { onLeave: () => void }) {
  const t = useT()
  const [request] = useState(() => readConnectRequest(window.location.hash))
  const [described, setDescribed] = useState<OAuthDescribeData | null>(
    request ? null : { ok: false, problem: 'client', errorTo: null },
  )
  const [loadFailed, setLoadFailed] = useState<Problem | 'failed' | null>(request ? null : 'request')

  useEffect(() => {
    if (!request) return
    callAction<OAuthDescribeData>('oauth.describe', request).then(setDescribed, (err: unknown) =>
      setLoadFailed(problemOf(err) ?? 'failed'),
    )
  }, [request])

  if (loadFailed || (described && !described.ok)) {
    const problem = loadFailed ?? (described && !described.ok ? described.problem : 'request')
    return (
      <Refused
        text={problem === 'failed' ? t('account.connectAgent.failed') : t(PROBLEM_TEXT[problem])}
        errorTo={!loadFailed && described && !described.ok ? described.errorTo : null}
        onLeave={onLeave}
      />
    )
  }
  if (!described || !request) return <AuthPage>{null}</AuthPage>
  return <Consent request={request} about={described} />
}

/**
 * A request that cannot be approved. `errorTo`: the client may hear the error (its redirect URI is registered); it
 * goes there only when the person clicks, never on its own (no open redirect through a self-registered client).
 */
function Refused({ text, errorTo, onLeave }: { text: string; errorTo: string | null; onLeave: () => void }) {
  const t = useT()
  return (
    <Card title={t('account.connectAgent.problem.title')}>
      <AuthError message={text} />
      {errorTo && (
        <Button
          variant="secondary"
          title={t('account.connectAgent.returnToAgentTip')}
          onClick={() => window.location.assign(errorTo)}
        >
          {t('account.connectAgent.returnToAgent')}
        </Button>
      )}
      <Button variant="secondary" title={t('account.connectAgent.backTip', { brand: brandName() })} onClick={onLeave}>
        {t('account.connectAgent.back', { brand: brandName() })}
      </Button>
    </Card>
  )
}

/** How long the page must be visible and focused before Allow works. */
const ARM_MS = 1000

/**
 * False until the page has been visible and focused for ARM_MS, and again each time it is hidden or loses the focus:
 * a key press or click meant for another window (a page that opens this one under the pointer) never approves.
 */
function useArmedAfterFocus(): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const restart = () => {
      clearTimeout(timer)
      setArmed(false)
      if (document.visibilityState === 'visible' && document.hasFocus())
        timer = setTimeout(() => setArmed(true), ARM_MS)
    }
    restart()
    window.addEventListener('focus', restart)
    window.addEventListener('blur', restart)
    document.addEventListener('visibilitychange', restart)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', restart)
      window.removeEventListener('blur', restart)
      document.removeEventListener('visibilitychange', restart)
    }
  }, [])
  return armed
}

function Consent({ request, about }: { request: OAuthRequest; about: Extract<OAuthDescribeData, { ok: true }> }) {
  const t = useT()
  const name = about.clientName
  const [leaving, setLeaving] = useState(false)
  const armed = useArmedAfterFocus()
  const stepUp = useKeyStepUp(
    async () => {
      const { redirectTo } = await callAction<OAuthApproveData>('oauth.approve', request)
      setLeaving(true)
      window.location.assign(redirectTo)
    },
    err => {
      const problem = problemOf(err)
      return problem ? t(PROBLEM_TEXT[problem]) : t('account.connectAgent.failed')
    },
  )
  const cancel = () => {
    if (leaving) return
    setLeaving(true)
    window.location.assign(about.denyTo)
  }

  function allow() {
    if (armed && !leaving) stepUp.submit()
  }

  // Esc cancels and Enter allows, anywhere on the page; a held key (repeat) does neither. Nothing has the focus at
  // first, and Allow works only once the page was visible and focused for a moment (useArmedAfterFocus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented) return
      if (e.key === 'Escape') cancel()
      // In the form (the code field, a button) Enter is the form's own submit.
      else if (e.key === 'Enter' && !(e.target instanceof Element && e.target.closest('form'))) allow()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    allow()
  }

  const redirectLine = {
    web: msg('account.connectAgent.redirect.web'),
    loopback: msg('account.connectAgent.redirect.loopback'),
    app: msg('account.connectAgent.redirect.app'),
  } as const satisfies Record<typeof about.redirect.kind, MessageKey>

  return (
    <Card title={t('account.connectAgent.title', { name, brand: brandName() })}>
      <p>{t('account.connectAgent.lead', { name })}</p>
      <ul className="connect-agent-facts">
        <li>{t('account.connectAgent.account', { email: about.email })}</li>
        <li>{t(redirectLine[about.redirect.kind], { where: about.redirect.where })}</li>
        <li>
          {about.clientHost
            ? t('account.connectAgent.publishedBy', { host: about.clientHost })
            : t('account.connectAgent.unverified')}
        </li>
        <li>{t('account.connectAgent.revokeNote')}</li>
      </ul>
      <form className="auth-form" onSubmit={submit}>
        {stepUp.signInFirst && <p className="help">{t('account.connectAgent.signInFirst')}</p>}
        <StepUpFields
          stepUp={stepUp}
          id="connect-agent-code"
          texts={{
            withEither: msg('account.connectAgent.confirm.withEither'),
            withPasskey: msg('account.connectAgent.confirm.withPasskey'),
          }}
        />
        {stepUp.error && <AuthError message={stepUp.error} />}
        {leaving && !stepUp.error && (
          <p className="help" role="status">
            {t('account.connectAgent.redirecting', { name })}
          </p>
        )}
        <StepUpSubmit
          stepUp={stepUp}
          label={t('account.connectAgent.allow')}
          busyLabel={t('account.connectAgent.allowing')}
          tip={t('common.withKey', { label: t('account.connectAgent.allowTip', { name }), key: '↵' })}
          shortcut={['↵']}
          disabled={leaving || !armed}
        />
        <Button
          variant="secondary"
          shortcut={['esc']}
          disabled={leaving}
          title={t('common.withKey', { label: t('account.connectAgent.cancelTip', { name }), key: 'esc' })}
          onClick={cancel}
        >
          {t('account.connectAgent.cancel')}
        </Button>
      </form>
    </Card>
  )
}
