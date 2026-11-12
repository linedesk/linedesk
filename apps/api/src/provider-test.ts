// "Test connection": one cheap authenticated request per provider. The result is ok or a short
// reason; it never contains a key.
import { providerSpec, type ProviderName, type ProviderTestData, type RecordingStoreName } from '@linedesk/actions'
import { smtpCheck } from './email.ts'
import { isMailService, type MailService, smtpOf } from './email-services.ts'
import type { ProviderConfig } from './provider-settings.ts'
import {
  createFileRecordingStore,
  RecordingConfigError,
  recordingsDir,
  S3RequestError,
  s3StoreFromValues,
} from './recording-store.ts'

export const TIMEOUT_MS = 8000
const MAX_MESSAGE = 200

type Values = Record<string, string>
type Request = { url: string; init?: RequestInit }

const bearer =
  (url: string) =>
  (values: Values): Request => ({ url, init: { headers: { authorization: `Bearer ${values.api_key}` } } })
const keyHeader =
  (url: string, name: string, extra: Record<string, string> = {}) =>
  (values: Values): Request => ({ url, init: { headers: { [name]: values.api_key!, ...extra } } })
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

type OAuthApp = 'google' | 'microsoft' | 'github' | 'oidc'
const oauthApps: readonly ProviderName[] = ['google', 'microsoft', 'github', 'oidc']
const isOAuthApp = (provider: ProviderName): provider is OAuthApp => oauthApps.includes(provider)

/** How to test each provider of the registry (packages/actions/src/admin.ts). */
const checks: Record<
  Exclude<ProviderName, RecordingStoreName | OAuthApp | 'smtp' | MailService>,
  (values: Values) => Request
> = {
  twilio: values => ({
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(values.account_sid!)}.json`,
    init: { headers: { authorization: basic(values.account_sid!, values.auth_token!) } },
  }),
  telnyx: bearer('https://api.telnyx.com/v2/balance'),
  deepgram: values => ({
    url: 'https://api.deepgram.com/v1/projects',
    init: { headers: { authorization: `Token ${values.api_key}` } },
  }),
  openrouter: bearer('https://openrouter.ai/api/v1/key'),
  openai: bearer('https://api.openai.com/v1/models'),
  openai_realtime: bearer('https://api.openai.com/v1/models'),
  elevenlabs: keyHeader('https://api.elevenlabs.io/v1/user', 'xi-api-key'),
  cartesia: keyHeader('https://api.cartesia.ai/voices?limit=1', 'x-api-key', { 'cartesia-version': '2025-04-16' }),
}

/**
 * SMTP: connect and log in. The answer is cut down to what an operator needs (which host, a
 * timeout, a refused login), never the server's own text beyond a status code: the SMTP URL may
 * point anywhere, and its password must not come back.
 */
async function testSmtp(
  url: string,
  from: string | undefined,
  loginHint = 'the user and password in the SMTP URL',
): Promise<ProviderTestData> {
  const result = await smtpCheck(url, from)
  if (result.ok) return { ok: true, message: 'Connected' }
  const password = (() => {
    try {
      return decodeURIComponent(new URL(url).password)
    } catch {
      return ''
    }
  })()
  const scrubbed = [url, password]
    .filter(Boolean)
    .reduce((t, secret) => t.replaceAll(secret, '[redacted]'), result.message)
  const login = /\b(535|534|530|EAUTH)\b/.test(scrubbed)
  return {
    ok: false,
    message: login
      ? `The mail server refused the login: check ${loginHint}`
      : scrubbed.startsWith('Could not send email: ')
        ? scrubbed.slice(0, MAX_MESSAGE) // our own text: which host did not answer
        : 'The mail server did not accept the connection: check host, port and TLS (smtps:// for port 465, smtp:// for 587)',
  }
}

/** Where an OAuth app exchanges a code for tokens. OIDC: from its discovery document. */
async function tokenEndpoint(provider: OAuthApp, values: Values, doFetch: typeof fetch): Promise<string> {
  if (provider === 'google') return 'https://oauth2.googleapis.com/token'
  if (provider === 'github') return 'https://github.com/login/oauth/access_token'
  if (provider === 'microsoft')
    return `https://login.microsoftonline.com/${encodeURIComponent(values.tenant_id || 'common')}/oauth2/v2.0/token`
  const res = await doFetch(values.discovery_url!, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`the discovery URL answered HTTP ${res.status}`)
  // A fixed message, never the body: the URL may point anywhere.
  const document = (await res.json().catch(() => null)) as { token_endpoint?: unknown } | null
  if (!document) throw new Error('the discovery URL did not answer with JSON')
  const endpoint = document.token_endpoint
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint))
    throw new Error('the discovery document has no https token_endpoint')
  return endpoint
}

/**
 * An OAuth app is checked by exchanging a made-up code: the provider first checks the client ID and
 * secret ("invalid_client", GitHub's "incorrect_client_credentials") and only then the code
 * ("invalid_grant", "bad_verification_code"). So a rejected code means the app is right.
 */
async function testOAuthApp(provider: OAuthApp, values: Values, doFetch: typeof fetch): Promise<ProviderTestData> {
  const { label } = providerSpec(provider)
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'linedesk-connection-test',
      client_id: values.client_id!,
      client_secret: values.client_secret!,
      redirect_uri: 'https://localhost/linedesk-connection-test',
    })
    const res = await doFetch(await tokenEndpoint(provider, values, doFetch), {
      method: 'POST',
      body,
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const error = ((await res.json().catch(() => ({}))) as { error?: unknown }).error
    if (error === 'invalid_client' || error === 'incorrect_client_credentials' || error === 'unauthorized_client')
      return { ok: false, message: `${label} rejected the client ID or secret` }
    if (error === 'invalid_grant' || error === 'bad_verification_code' || error === 'redirect_uri_mismatch')
      return { ok: true, message: 'Connected' }
    return {
      ok: false,
      message: `${label} answered HTTP ${res.status}${typeof error === 'string' ? ` (${error.slice(0, 40)})` : ''}`,
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError')
      return { ok: false, message: `${label} did not answer within ${TIMEOUT_MS / 1000} seconds` }
    return {
      ok: false,
      message: `Could not reach ${label}: ${errorText(e)}`
        .replaceAll(values.client_secret!, '[redacted]')
        .slice(0, MAX_MESSAGE),
    }
  }
}

/** Node's fetch says only "fetch failed"; the reason (connection refused, unknown host) is in the cause. */
export const errorText = (e: unknown) => {
  if (!(e instanceof Error)) return String(e)
  const cause = e.cause as { message?: string; code?: string } | undefined
  return cause?.message || cause?.code || e.message
}

/** What an S3 status means for the operator. Fixed texts: S3's own messages can quote the key ID. */
function s3Problem(e: S3RequestError): string {
  if (e.code === 'NoSuchBucket') return 'Bucket not found'
  if (e.status === 401 || e.status === 403) return `Keys rejected (HTTP ${e.status})`
  if ([301, 307].includes(e.status) || e.code === 'PermanentRedirect' || e.code === 'AuthorizationHeaderMalformed')
    return 'Wrong region or endpoint'
  return `Storage answered HTTP ${e.status}`
}

/**
 * Recording storage: put a small object, read it back and delete it. Errors name the step and the
 * status; values that are secret never appear (S3 text is not passed on, other text is scrubbed).
 */
async function testRecordingStore(
  provider: RecordingStoreName,
  values: Values,
  doFetch: typeof fetch,
  env: Record<string, string | undefined>,
): Promise<ProviderTestData> {
  const secrets = [values.secret_access_key, values.access_key_id].filter((v): v is string => !!v && v.length >= 4)
  const scrub = (text: string) =>
    secrets.reduce((t, value) => t.replaceAll(value, '[redacted]'), text).slice(0, MAX_MESSAGE)
  try {
    const store =
      provider === 'file'
        ? createFileRecordingStore(recordingsDir(env))
        : s3StoreFromValues(values, (input, init) =>
            doFetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }),
          )
    await store.probe()
    return { ok: true, message: 'Connected' }
  } catch (e) {
    if (e instanceof RecordingConfigError) return { ok: false, message: scrub(e.message) }
    if (e instanceof S3RequestError) return { ok: false, message: s3Problem(e) }
    if (e instanceof Error && e.name === 'TimeoutError')
      return { ok: false, message: `No answer within ${TIMEOUT_MS / 1000} seconds` }
    return { ok: false, message: scrub(`Could not reach the storage: ${errorText(e)}`) }
  }
}

const isRecordingStore = (provider: ProviderName): provider is RecordingStoreName =>
  providerSpec(provider).category === 'recording'

/** `values` are the keys in effect. `doFetch` is replaced in tests. */
export async function testProvider(
  provider: ProviderName,
  config: ProviderConfig,
  doFetch: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderTestData> {
  const { label, fields } = providerSpec(provider)
  const values: Values = Object.fromEntries(
    Object.entries(config).flatMap(([field, entry]) => (entry ? [[field, entry.value]] : [])),
  )
  const missing = Object.keys(fields).filter(field => !fields[field]!.optional && !values[field])
  if (missing.length) return { ok: false, message: `Not set: ${missing.map(field => fields[field]!.label).join(', ')}` }
  if (isRecordingStore(provider)) return testRecordingStore(provider, values, doFetch, env)
  if (provider === 'smtp') return testSmtp(values.url!, values.from)
  if (isMailService(provider)) {
    const smtp = smtpOf(provider, values)
    return smtp ? testSmtp(smtp.url, smtp.from, 'the key or password') : { ok: false, message: 'Not set up' }
  }
  if (isOAuthApp(provider)) return testOAuthApp(provider, values, doFetch)

  // Whatever comes back, a key must not travel on: drop every value that appears in the text.
  const scrub = (text: string) =>
    Object.values(values)
      .reduce((t, value) => t.replaceAll(value, '[redacted]'), text)
      .slice(0, MAX_MESSAGE)
  try {
    const { url, init } = checks[provider](values)
    const res = await doFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.ok) return { ok: true, message: 'Connected' }
    if (res.status === 401 || res.status === 403)
      return { ok: false, message: `${label} rejected the key (HTTP ${res.status})` }
    if (res.status === 404 && provider === 'twilio')
      return { ok: false, message: 'Twilio does not know this account SID (HTTP 404)' }
    // A fixed message per status: provider error text can quote parts of what was sent.
    return {
      ok: false,
      message:
        res.status === 429
          ? `${label} is rate limiting (HTTP 429), try again in a minute`
          : `${label} answered HTTP ${res.status}`,
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError')
      return { ok: false, message: `${label} did not answer within ${TIMEOUT_MS / 1000} seconds` }
    return { ok: false, message: scrub(`Could not reach ${label}: ${errorText(e)}`) }
  }
}
