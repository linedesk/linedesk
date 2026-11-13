// "Test connection": checks that a provider can do its job, not only that the key is valid (LIN-111). Where the
// provider tells cheaply: quota, credit or balance and the account's state; that the configured model, voice or
// bucket exists; for voice and transcription a one-character synthesis or a fraction of a second of audio when
// the quota cannot be read otherwise. The result is ok, warning (works, but soon will not) or error, with a reason
// and a message that names the fix. It never contains a key: provider text is only searched for known codes.
import {
  type LlmProvider,
  llmEndpoints,
  type ProviderFailureReason,
  type ProviderName,
  type ProviderTestData,
  providerDefaultVoices,
  providerSpec,
  type RecordingStoreName,
} from '@linedesk/actions'
import { smtpCheck } from './email.ts'
import { isMailService, type MailService, smtpOf } from './email-services.ts'
import { type ProviderProblem, problemOfError, problemOfResponse } from './provider-errors.ts'
import type { ProviderConfig } from './provider-settings.ts'
import {
  createFileRecordingStore,
  RecordingConfigError,
  recordingsDir,
  S3RequestError,
  s3StoreFromValues,
} from './recording-store.ts'

export const TIMEOUT_MS = 8000
const MAX_MESSAGE = 300
/** Below this balance or credit (in the account's currency) a test warns. */
export const LOW_BALANCE = 5
/** Below this share of the plan's quota left, a test warns. */
const LOW_SHARE = 0.05

type Values = Record<string, string>

const ok = (message = 'Connected'): ProviderTestData => ({ ok: true, status: 'ok', message })
const warning = (reason: ProviderFailureReason, message: string): ProviderTestData => ({
  ok: true,
  status: 'warning',
  reason,
  message,
})
const failed = (problem: ProviderProblem): ProviderTestData => ({ ok: false, status: 'error', ...problem })
const error = (reason: ProviderFailureReason, message: string) => failed({ reason, message })

/** A number from a provider's JSON (Telnyx and Twilio send amounts as strings); null when there is none. */
const num = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const money = (amount: number, currency?: unknown) =>
  `${amount.toFixed(2)} ${typeof currency === 'string' && currency ? currency.toUpperCase() : 'USD'}`
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

// biome-ignore lint/suspicious/noExplicitAny: provider JSON is read field by field
type Json = Record<string, any>
type Answer = { ok: true; body: Json; res: Response } | { ok: false; problem: ProviderProblem; status: number }

/** Requests of one test: the timeout, no redirects, and the failure as a problem of this provider. */
function httpFor(provider: ProviderName, doFetch: typeof fetch) {
  const send = (url: string, init: RequestInit = {}) =>
    doFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  /** A JSON answer, or what its failure means. `what` names the step in the message. */
  async function json(url: string, init: RequestInit, what?: string): Promise<Answer> {
    const res = await send(url, init)
    if (!res.ok) return { ok: false, problem: await problemOfResponse(provider, res, what), status: res.status }
    return { ok: true, body: ((await res.json().catch(() => null)) ?? {}) as Json, res }
  }
  return { send, json }
}
type Http = ReturnType<typeof httpFor>
type Check = (values: Values, http: Http) => Promise<ProviderTestData>

// --- Telephony ----------------------------------------------------------------------------------

const telnyx: Check = async (values, http) => {
  const answer = await http.json('https://api.telnyx.com/v2/balance', {
    headers: { authorization: `Bearer ${values.api_key}` },
  })
  if (!answer.ok) return failed(answer.problem)
  const data = (answer.body.data ?? {}) as Json
  const available = num(data.available_credit) ?? num(data.balance)
  if (available === null) return ok()
  const amount = money(available, data.currency)
  if (available <= 0)
    return error(
      'quota',
      `Telnyx balance is used up (${amount}): calls and numbers stop. Add funds in the Telnyx portal, Billing.`,
    )
  if (available < LOW_BALANCE)
    return warning(
      'quota',
      `Telnyx balance is low (${amount}). Add funds in the Telnyx portal, Billing, before calls stop.`,
    )
  return ok(`Connected, balance ${amount}`)
}

const twilio: Check = async (values, http) => {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(values.account_sid!)}`
  const headers = { authorization: basic(values.account_sid!, values.auth_token!) }
  const account = await http.json(`${base}.json`, { headers })
  if (!account.ok)
    return account.status === 404
      ? error('not_found', 'Twilio does not know this account SID (HTTP 404). Copy it from the Twilio Console.')
      : failed(account.problem)
  if (account.body.status === 'suspended')
    return error(
      'quota',
      'Twilio suspended the account (unpaid balance or a review): calls stop. Resolve it in the Twilio Console.',
    )
  if (account.body.status === 'closed') return error('auth', 'This Twilio account is closed. Use an active account.')
  const balance = await http.json(`${base}/Balance.json`, { headers })
  const amount = balance.ok ? num(balance.body.balance) : null
  if (amount !== null && amount <= 0)
    return error(
      'quota',
      `Twilio balance is used up (${money(amount, balance.ok && balance.body.currency)}). Add funds in the Twilio Console.`,
    )
  if (account.body.type === 'Trial')
    return warning(
      'config',
      'Twilio trial account: calls play a trial message and reach only verified numbers. Upgrade it in the Twilio Console.',
    )
  if (amount !== null && amount < LOW_BALANCE)
    return warning(
      'quota',
      `Twilio balance is low (${money(amount, balance.ok && balance.body.currency)}). Add funds in the Twilio Console.`,
    )
  return ok(amount !== null ? `Connected, balance ${money(amount, balance.ok && balance.body.currency)}` : 'Connected')
}

// --- Speech to text -----------------------------------------------------------------------------

const deepgram: Check = async (values, http) => {
  const headers = { authorization: `Token ${values.api_key}` }
  const projects = await http.json('https://api.deepgram.com/v1/projects', { headers })
  if (!projects.ok) return failed(projects.problem)
  const project = (projects.body.projects as Json[] | undefined)?.[0]?.project_id
  if (typeof project !== 'string')
    return error(
      'permission',
      'The Deepgram key sees no project. Create the key inside a project in the Deepgram console.',
    )
  if (values.model) {
    const models = await http.json('https://api.deepgram.com/v1/models', { headers })
    const names = models.ok
      ? ((models.body.stt ?? []) as Json[]).flatMap(m => [m.canonical_name, m.name, m.architecture])
      : []
    if (models.ok && names.length && !names.includes(values.model))
      return error('not_found', `Deepgram has no model "${values.model}". Clear the model field for the default.`)
  }
  // A key with the Member role may not read balances: then the balance is not checked.
  const balances = await http.json(`https://api.deepgram.com/v1/projects/${encodeURIComponent(project)}/balances`, {
    headers,
  })
  const amounts = balances.ok ? ((balances.body.balances ?? []) as Json[]).map(b => num(b.amount) ?? 0) : []
  if (!amounts.length) return ok()
  const total = amounts.reduce((a, b) => a + b, 0)
  if (total <= 0)
    return warning(
      'quota',
      'Deepgram shows no credit left. Without a payment method on the account, speech recognition stops: add one in the Deepgram console, Billing.',
    )
  return total < LOW_BALANCE
    ? warning('quota', `Deepgram credit is low (${money(total)}). Add credit in the Deepgram console, Billing.`)
    : ok(`Connected, credit ${money(total)}`)
}

/** ElevenLabs quota: error when used up and the plan cannot go over, warning when little is left. null: unreadable. */
async function elevenLabsQuota(values: Values, http: Http): Promise<ProviderTestData | null> {
  const answer = await http.json('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': values.api_key! },
  })
  if (!answer.ok) return answer.problem.reason === 'permission' ? null : failed(answer.problem)
  const used = num(answer.body.character_count)
  const limit = num(answer.body.character_limit)
  const canExtend =
    answer.body.can_extend_character_limit === true && answer.body.allowed_to_extend_character_limit === true
  const reset = num(answer.body.next_character_count_reset_unix)
  const resetText = reset ? `; it resets on ${new Date(reset * 1000).toISOString().slice(0, 10)}` : ''
  if (answer.body.status === 'past_due')
    return warning(
      'quota',
      'The ElevenLabs payment is past due: pay it in ElevenLabs, Subscription, before the voice stops.',
    )
  if (used === null || limit === null || limit <= 0) return ok()
  if (used >= limit && !canExtend)
    return error(
      'quota',
      `ElevenLabs quota used up (${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} credits${resetText}): the assistant cannot speak. Upgrade the plan or turn on usage-based billing in ElevenLabs.`,
    )
  if ((limit - used) / limit < LOW_SHARE && !canExtend)
    return warning(
      'quota',
      `ElevenLabs quota almost used up (${(limit - used).toLocaleString('en-US')} credits left${resetText}). Upgrade the plan in ElevenLabs.`,
    )
  return ok()
}

const elevenLabsStt: Check = async (values, http) =>
  (await elevenLabsQuota(values, http)) ?? ok('Connected (the key may not read the quota)')

/** A WAV of a fifth of a second of silence: what the transcription test sends. */
export function silentWav(seconds = 0.2, rate = 16000): Uint8Array<ArrayBuffer> {
  const samples = Math.round(seconds * rate)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
}

const OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe'
const openaiStt: Check = async (values, http) => {
  const model = values.model || OPENAI_STT_MODEL
  const form = new FormData()
  form.append('model', model)
  form.append('file', new Blob([silentWav()], { type: 'audio/wav' }), 'test.wav')
  const res = await http.send('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${values.api_key}` },
    body: form,
  })
  if (!res.ok) return failed(await problemOfResponse('openai_stt', res, `the model ${model}`))
  return ok()
}

// --- Language models ----------------------------------------------------------------------------

/** The first model of a "model, fallback" list, else the provider's default. */
const firstModel = (value: string | undefined, fallback: string) => value?.split(',')[0]?.trim() || fallback

/** A chat request of a few tokens: the key, the model and the account's quota in one. */
async function tinyCompletion(provider: ProviderName, http: Http, baseUrl: string, apiKey: string, model: string) {
  const limit =
    provider === 'openai' || provider === 'openai_realtime' ? { max_completion_tokens: 16 } : { max_tokens: 5 }
  const res = await http.send(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK.' }], ...limit }),
  })
  return res.ok ? null : await problemOfResponse(provider, res, `the model ${model}`)
}

/** The live and the summary model each answer a few tokens. */
const llm =
  (provider: LlmProvider): Check =>
  async (values, http) => {
    const endpoint = llmEndpoints[provider]
    const models = [
      ...new Set([
        firstModel(values.model, endpoint.models[0]),
        firstModel(values.summary_model, endpoint.summaryModels[0]),
      ]),
    ]
    for (const model of models) {
      const problem = await tinyCompletion(provider, http, endpoint.baseUrl, values.api_key!, model)
      if (problem) return failed(problem)
    }
    return ok()
  }

const openrouter: Check = async (values, http) => {
  const headers = { authorization: `Bearer ${values.api_key}` }
  const key = await http.json('https://openrouter.ai/api/v1/key', { headers })
  if (!key.ok) return failed(key.problem)
  const remaining = num(key.body.data?.limit_remaining)
  if (remaining !== null && remaining <= 0)
    return error('quota', "The OpenRouter key's credit limit is reached. Raise it in OpenRouter, Settings, API Keys.")
  const credits = await http.json('https://openrouter.ai/api/v1/credits', { headers })
  const left = credits.ok
    ? (num(credits.body.data?.total_credits) ?? 0) - (num(credits.body.data?.total_usage) ?? 0)
    : null
  if (left !== null && left <= 0)
    return error(
      'quota',
      'OpenRouter credits are used up: the assistant cannot answer. Buy credits in OpenRouter, Settings, Credits.',
    )
  const models = await llm('openrouter')(values, http)
  if (!models.ok) return models
  if (left !== null && left < 1)
    return warning('quota', `OpenRouter credit is low (${money(left)}). Buy credits in OpenRouter, Settings, Credits.`)
  return ok(left !== null ? `Connected, credit ${money(left)}` : 'Connected')
}

/** The realtime model must exist for the key; the summary goes to the chat API with the same key (and quota). */
const openaiRealtime: Check = async (values, http) => {
  const headers = { authorization: `Bearer ${values.api_key}` }
  const model = values.model || 'gpt-realtime'
  const found = await http.json(
    `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
    { headers },
    `the model ${model}`,
  )
  if (!found.ok) return failed(found.problem)
  const problem = await tinyCompletion(
    'openai_realtime',
    http,
    llmEndpoints.openai.baseUrl,
    values.api_key!,
    values.summary_model || 'gpt-4.1-mini',
  )
  return problem ? failed(problem) : ok()
}

// --- Voice --------------------------------------------------------------------------------------

const ELEVENLABS_TEST_MODEL = 'eleven_flash_v2_5'
const elevenlabs: Check = async (values, http) => {
  const headers = { 'xi-api-key': values.api_key! }
  const quota = await elevenLabsQuota(values, http)
  if (quota && !quota.ok) return quota
  const voice = values.voice_id || providerDefaultVoices.elevenlabs!
  if (values.voice_id) {
    const found = await http.json(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voice)}`, { headers })
    if (!found.ok && found.problem.reason !== 'permission')
      return found.status === 400 || found.status === 404
        ? error(
            'not_found',
            `The default voice ${voice} is not in this ElevenLabs account. Pick another or clear the field.`,
          )
        : failed(found.problem)
  }
  if (values.model) {
    const models = await http.json('https://api.elevenlabs.io/v1/models', { headers })
    const ids = models.ok && Array.isArray(models.body) ? (models.body as Json[]).map(m => m.model_id) : []
    if (ids.length && !ids.includes(values.model))
      return error('not_found', `ElevenLabs has no model "${values.model}". Clear the model field for the default.`)
  }
  // The quota could not be read with this key: one character of speech shows whether it can speak.
  if (!quota) {
    const res = await http.send(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_16000`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '.', model_id: values.model || ELEVENLABS_TEST_MODEL }),
      },
    )
    if (!res.ok) return failed(await problemOfResponse('elevenlabs', res, 'speaking'))
    if (!(await res.arrayBuffer()).byteLength)
      return error('unknown', 'ElevenLabs returned no audio for a test sentence.')
  }
  return quota ?? ok()
}

const CARTESIA_VERSION = '2025-04-16'
const cartesia: Check = async (values, http) => {
  const headers = { 'x-api-key': values.api_key!, 'cartesia-version': CARTESIA_VERSION }
  const voice = values.voice_id || providerDefaultVoices.cartesia!
  const found = await http.json(`https://api.cartesia.ai/voices/${encodeURIComponent(voice)}`, { headers })
  if (!found.ok)
    return found.problem.reason === 'not_found'
      ? error('not_found', `The voice ${voice} is not available to this Cartesia key. Pick another or clear the field.`)
      : failed(found.problem)
  // Cartesia does not tell the credit left: one character of speech shows whether it can speak (402 when used up).
  const res = await http.send('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: values.model || 'sonic-2',
      transcript: '.',
      voice: { mode: 'id', id: voice },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 8000 },
    }),
  })
  if (!res.ok) return failed(await problemOfResponse('cartesia', res, 'speaking'))
  return ok()
}

/** A place every key can read (Google's own example, the Google office in Sydney). */
export const PLACES_TEST_PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4'
// Place Details asking only for the ID (Google's free "IDs only" request), for a well-known place.
const googlePlaces: Check = async (values, http) => {
  const answer = await http.json(`https://places.googleapis.com/v1/places/${PLACES_TEST_PLACE}`, {
    headers: { 'x-goog-api-key': values.api_key!, 'x-goog-fieldmask': 'id' },
  })
  return answer.ok ? ok() : failed(answer.problem)
}

type HttpProvider = Exclude<ProviderName, RecordingStoreName | OAuthApp | 'smtp' | MailService>
/** How to test each provider of the registry (packages/actions/src/admin.ts) that answers over HTTP. */
const checks: Record<HttpProvider, Check> = {
  telnyx,
  twilio,
  deepgram,
  elevenlabs_stt: elevenLabsStt,
  openai_stt: openaiStt,
  openrouter,
  openai: llm('openai'),
  anthropic: llm('anthropic'),
  gemini: llm('gemini'),
  groq: llm('groq'),
  mistral: llm('mistral'),
  openai_realtime: openaiRealtime,
  elevenlabs,
  cartesia,
  google_places: googlePlaces,
}

// --- Email --------------------------------------------------------------------------------------

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
  if (result.ok) return ok()
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
  if (/\b(535|534|530|EAUTH)\b/.test(scrubbed))
    return error('auth', `The mail server refused the login: check ${loginHint}`)
  return error(
    'network',
    scrubbed.startsWith('Could not send email: ')
      ? scrubbed.slice(0, MAX_MESSAGE) // our own text: which host did not answer
      : 'The mail server did not accept the connection: check host, port and TLS (smtps:// for port 465, smtp:// for 587)',
  )
}

/** The domain of a From line ("Desk <desk@example.com>" or a bare address). */
export const fromDomain = (from: string | undefined) => /@([^\s>]+)>?\s*$/.exec(from ?? '')?.[1]?.toLowerCase() ?? null

/** Resend sends only from verified domains. A key with sending access only cannot list them: then not checked. */
async function resendDomain(values: Values, doFetch: typeof fetch): Promise<ProviderTestData | null> {
  const domain = fromDomain(values.from)
  if (!domain) return null
  const answer = await httpFor('resend', doFetch).json('https://api.resend.com/domains', {
    headers: { authorization: `Bearer ${values.api_key}` },
  })
  if (!answer.ok) return null
  const listed = ((answer.body.data ?? []) as Json[]).find(d => String(d.name).toLowerCase() === domain)
  if (!listed)
    return error('config', `${domain} is not a domain in Resend: add and verify it under Domains, or change From.`)
  if (listed.status !== 'verified')
    return error(
      'config',
      `${domain} is not verified in Resend yet (${String(listed.status).slice(0, 30)}): finish the DNS records under Domains.`,
    )
  return null
}

// --- Sign-in and calendar apps ------------------------------------------------------------------

type OAuthApp = 'google' | 'microsoft' | 'github' | 'oidc'
const oauthApps: readonly ProviderName[] = ['google', 'microsoft', 'github', 'oidc']
const isOAuthApp = (provider: ProviderName): provider is OAuthApp => oauthApps.includes(provider)

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
 * ("invalid_grant", "bad_verification_code"). So a rejected code means the app is right. Missing scopes or a
 * disabled calendar API show only when a member connects: then the calendar records the failure.
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
    const answer = (await res.json().catch(() => ({}))) as { error?: unknown; error_description?: unknown }
    const code = answer.error
    // Microsoft names an expired secret in the description (AADSTS7000222).
    if (typeof answer.error_description === 'string' && answer.error_description.includes('AADSTS7000222'))
      return error(
        'auth',
        `The ${label} client secret has expired: make a new one in Microsoft Entra and enter it here.`,
      )
    if (code === 'invalid_client' || code === 'incorrect_client_credentials' || code === 'unauthorized_client')
      return error('auth', `${label} rejected the client ID or secret`)
    if (code === 'invalid_grant' || code === 'bad_verification_code' || code === 'redirect_uri_mismatch') return ok()
    return error(
      res.status >= 500 ? 'network' : 'unknown',
      `${label} answered HTTP ${res.status}${typeof code === 'string' ? ` (${code.slice(0, 40)})` : ''}`,
    )
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError')
      return error('timeout', `${label} did not answer within ${TIMEOUT_MS / 1000} seconds`)
    return error(
      'network',
      `Could not reach ${label}: ${errorText(e)}`.replaceAll(values.client_secret!, '[redacted]').slice(0, MAX_MESSAGE),
    )
  }
}

/** Node's fetch says only "fetch failed"; the reason (connection refused, unknown host) is in the cause. */
export const errorText = (e: unknown) => {
  if (!(e instanceof Error)) return String(e)
  const cause = e.cause as { message?: string; code?: string } | undefined
  return cause?.message || cause?.code || e.message
}

// --- Recording storage --------------------------------------------------------------------------

/** What an S3 failure means for the operator. Fixed texts: S3's own messages can quote the key ID. */
export function s3Problem(e: S3RequestError): ProviderProblem {
  if (e.code === 'NoSuchBucket') return { reason: 'not_found', message: 'Bucket not found' }
  if (e.code === 'AccessDenied' || e.code === 'AllAccessDisabled')
    return {
      reason: 'permission',
      message: `The keys may not ${e.step} in the bucket (HTTP ${e.status}): give them read, write and delete on it`,
    }
  if (e.code === 'QuotaExceeded' || e.status === 507)
    return { reason: 'quota', message: 'The storage is full or over its quota' }
  if (e.status === 401 || e.status === 403) return { reason: 'auth', message: `Keys rejected (HTTP ${e.status})` }
  if ([301, 307].includes(e.status) || e.code === 'PermanentRedirect' || e.code === 'AuthorizationHeaderMalformed')
    return { reason: 'config', message: 'Wrong region or endpoint' }
  return { reason: e.status >= 500 ? 'network' : 'unknown', message: `Storage answered HTTP ${e.status}` }
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
    return ok()
  } catch (e) {
    if (e instanceof RecordingConfigError) return error('config', scrub(e.message))
    if (e instanceof S3RequestError) return failed(s3Problem(e))
    if (e instanceof Error && e.name === 'TimeoutError')
      return error('timeout', `No answer within ${TIMEOUT_MS / 1000} seconds`)
    return error('network', scrub(`Could not reach the storage: ${errorText(e)}`))
  }
}

const isRecordingStore = (provider: ProviderName): provider is RecordingStoreName =>
  providerSpec(provider).category === 'recording'

/** The fields a provider needs that have no value. */
export function missingFields(provider: ProviderName, config: ProviderConfig): string[] {
  const { fields } = providerSpec(provider)
  return Object.keys(fields).filter(field => !fields[field]!.optional && !config[field]?.value)
}

/** `config` holds the keys in effect. `doFetch` is replaced in tests. */
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
  const missing = missingFields(provider, config)
  if (missing.length) return error('config', `Not set: ${missing.map(field => fields[field]!.label).join(', ')}`)
  if (isRecordingStore(provider)) return testRecordingStore(provider, values, doFetch, env)
  if (provider === 'smtp') return testSmtp(values.url!, values.from)
  if (isMailService(provider)) {
    const smtp = smtpOf(provider, values)
    if (!smtp) return error('config', 'Not set up')
    const login = await testSmtp(smtp.url, smtp.from, 'the key or password')
    if (!login.ok || provider !== 'resend') return login
    return (await resendDomain(values, doFetch).catch(() => null)) ?? login
  }
  if (isOAuthApp(provider)) return testOAuthApp(provider, values, doFetch)

  // Whatever comes back, a key must not travel on: drop every secret value that appears in the text.
  const scrub = (text: string) =>
    Object.entries(values)
      .filter(([field, value]) => fields[field]?.secret && value.length >= 4)
      .map(([, value]) => value)
      .reduce((t, value) => t.replaceAll(value, '[redacted]'), text)
      .slice(0, MAX_MESSAGE)
  try {
    const result = await checks[provider](values, httpFor(provider, doFetch))
    return { ...result, message: scrub(result.message) }
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError')
      return error('timeout', `${label} did not answer within ${TIMEOUT_MS / 1000} seconds`)
    const { reason, message } = problemOfError(provider, e)
    return error(reason, scrub(`${message.replace(/\.$/, '')} (${errorText(e)})`))
  }
}
