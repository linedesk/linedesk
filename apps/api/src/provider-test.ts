// "Test connection": checks that a provider can do its job, not only that the key is valid (LIN-111). Where the
// provider tells cheaply: quota, credit or balance and the account's state; that the configured model, voice or
// bucket exists; for voice and transcription a one-character synthesis or a fraction of a second of audio when
// the quota cannot be read otherwise. The result is ok, warning (works, but soon will not) or error, with a reason
// and a message that names the fix. It never contains a key: provider text is only searched for known codes.
import {
  type LlmProvider,
  llmEndpoints,
  OAUTH_CLIENT_REJECTED,
  type ProviderFailureReason,
  type ProviderName,
  type ProviderTestData,
  providerDefaultVoices,
  providerFieldLabel,
  providerSpec,
  type RecordingStoreName,
} from '@linedesk/actions'
import { msg } from '@linedesk/i18n'
import { JOBBER_API, JOBBER_CLIENT_REFUSED } from '@linedesk/connectors'
import { LIVE_KEYS_REFUSED, liveKeysAllowed, loadBillingProvider, stripeKeyMode } from '@linedesk/billing'
import { smtpCheck } from './email.ts'
import { isMailService, type MailService, smtpOf } from './email-services.ts'
import { type ProviderProblem, problemOfError, problemOfResponse } from './provider-errors.ts'
import type { ProviderConfig } from './provider-settings.ts'
import { type Reader, type Said, said, sayIn } from './handler-context.ts'
import {
  createFileRecordingStore,
  RecordingConfigError,
  recordingsDir,
  S3RequestError,
  s3StoreFromValues,
} from './recording-store.ts'
import { WEB_ORIGIN } from './emails/templates.ts'
import { s3EndpointProblem, s3Fetch } from './s3-endpoint.ts'

export const TIMEOUT_MS = 8000
const MAX_MESSAGE = 300
/** Below this balance or credit (in the account's currency) a test warns. */
export const LOW_BALANCE = 5
/** Below this share of the plan's quota left, a test warns. */
const LOW_SHARE = 0.05

type Values = Record<string, string>

/**
 * A test's result with its text as a key (`said`), for the reader's language (testAnswer); `message` is its English,
 * which is stored, logged and sent to the admins. Text from a provider or another module has no key.
 */
export type Tested = ProviderTestData & { said?: Said }
/** A problem in our own words: its key and its English. */
type SaidProblem = ProviderProblem & { said?: Said }
const problem = (reason: ProviderFailureReason, text: Said): SaidProblem => ({
  reason,
  message: sayIn(text),
  said: text,
})

const ok = (text: Said = said('server.api.providerTest.connected')): Tested => ({
  ok: true,
  status: 'ok',
  message: sayIn(text),
  said: text,
})
const warning = (reason: ProviderFailureReason, text: Said): Tested => ({
  ok: true,
  status: 'warning',
  reason,
  message: sayIn(text),
  said: text,
})
const failed = (p: SaidProblem): Tested => ({ ok: false, status: 'error', ...p })
const error = (reason: ProviderFailureReason, text: string | Said) =>
  failed(typeof text === 'string' ? { reason, message: text } : problem(reason, text))

/** A result as the reader gets it: the text in their language, without the key. */
export function testAnswer({ said: text, ...result }: Tested, reader?: Reader): ProviderTestData {
  return text && reader ? { ...result, message: sayIn(text, reader) } : result
}

/** A number in the reader's words ("1,234" in English, "1.234" in German). */
const count = (n: number) => (reader: Reader) => reader.format.number(n)

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

/**
 * Requests of one test: the timeout, no redirects, and the failure as a problem of this provider. `free`: the
 * background health check (provider-health-check.ts) — only requests that cost nothing (reading an account, a key, a
 * model list), no tokens, no speech, no transcription.
 */
function httpFor(provider: ProviderName, doFetch: typeof fetch, free = false) {
  const send = (url: string, init: RequestInit = {}) =>
    doFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  /** A JSON answer, or what its failure means. `what` names the step in the message. */
  async function json(url: string, init: RequestInit, what?: string): Promise<Answer> {
    const res = await send(url, init)
    if (!res.ok) return { ok: false, problem: await problemOfResponse(provider, res, what), status: res.status }
    return { ok: true, body: ((await res.json().catch(() => null)) ?? {}) as Json, res }
  }
  return { send, json, free }
}
type Http = ReturnType<typeof httpFor>
type Check = (values: Values, http: Http) => Promise<Tested>

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
  if (available <= 0) return error('quota', said('server.api.providerTest.telnyx.usedUp', { amount }))
  if (available < LOW_BALANCE) return warning('quota', said('server.api.providerTest.telnyx.low', { amount }))
  return ok(said('server.api.providerTest.connectedBalance', { amount }))
}

const twilio: Check = async (values, http) => {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(values.account_sid!)}`
  const headers = { authorization: basic(values.account_sid!, values.auth_token!) }
  const account = await http.json(`${base}.json`, { headers })
  if (!account.ok)
    return account.status === 404
      ? error('not_found', said('server.api.providerTest.twilio.unknownSid'))
      : failed(account.problem)
  if (account.body.status === 'suspended') return error('quota', said('server.api.providerTest.twilio.suspended'))
  if (account.body.status === 'closed') return error('auth', said('server.api.providerTest.twilio.closed'))
  const balance = await http.json(`${base}/Balance.json`, { headers })
  const amount = balance.ok ? num(balance.body.balance) : null
  if (amount !== null && amount <= 0)
    return error(
      'quota',
      said('server.api.providerTest.twilio.usedUp', { amount: money(amount, balance.ok && balance.body.currency) }),
    )
  if (account.body.type === 'Trial') return warning('config', said('server.api.providerTest.twilio.trial'))
  if (amount !== null && amount < LOW_BALANCE)
    return warning(
      'quota',
      said('server.api.providerTest.twilio.low', { amount: money(amount, balance.ok && balance.body.currency) }),
    )
  return amount !== null
    ? ok(
        said('server.api.providerTest.connectedBalance', {
          amount: money(amount, balance.ok && balance.body.currency),
        }),
      )
    : ok()
}

// --- Speech to text -----------------------------------------------------------------------------

const deepgram: Check = async (values, http) => {
  const headers = { authorization: `Token ${values.api_key}` }
  const projects = await http.json('https://api.deepgram.com/v1/projects', { headers })
  if (!projects.ok) return failed(projects.problem)
  const project = (projects.body.projects as Json[] | undefined)?.[0]?.project_id
  if (typeof project !== 'string') return error('permission', said('server.api.providerTest.deepgram.noProject'))
  if (values.model) {
    const models = await http.json('https://api.deepgram.com/v1/models', { headers })
    const names = models.ok
      ? ((models.body.stt ?? []) as Json[]).flatMap(m => [m.canonical_name, m.name, m.architecture])
      : []
    if (models.ok && names.length && !names.includes(values.model))
      return error('not_found', said('server.api.providerTest.deepgram.noModel', { model: values.model }))
  }
  // A key with the Member role may not read balances: then the balance is not checked.
  const balances = await http.json(`https://api.deepgram.com/v1/projects/${encodeURIComponent(project)}/balances`, {
    headers,
  })
  const amounts = balances.ok ? ((balances.body.balances ?? []) as Json[]).map(b => num(b.amount) ?? 0) : []
  if (!amounts.length) return ok()
  const total = amounts.reduce((a, b) => a + b, 0)
  if (total <= 0) return warning('quota', said('server.api.providerTest.deepgram.noCredit'))
  return total < LOW_BALANCE
    ? warning('quota', said('server.api.providerTest.deepgram.low', { amount: money(total) }))
    : ok(said('server.api.providerTest.connectedCredit', { amount: money(total) }))
}

/** ElevenLabs quota: error when used up and the plan cannot go over, warning when little is left. null: unreadable. */
async function elevenLabsQuota(values: Values, http: Http): Promise<Tested | null> {
  const answer = await http.json('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': values.api_key! },
  })
  if (!answer.ok) return answer.problem.reason === 'permission' ? null : failed(answer.problem)
  const used = num(answer.body.character_count)
  const limit = num(answer.body.character_limit)
  const canExtend =
    answer.body.can_extend_character_limit === true && answer.body.allowed_to_extend_character_limit === true
  const reset = num(answer.body.next_character_count_reset_unix)
  // When the quota resets, as a date ("none" when ElevenLabs does not say).
  const resets = reset ? new Date(reset * 1000).toISOString().slice(0, 10) : 'none'
  if (answer.body.status === 'past_due') return warning('quota', said('server.api.providerTest.elevenlabs.pastDue'))
  if (used === null || limit === null || limit <= 0) return ok()
  if (used >= limit && !canExtend)
    return error(
      'quota',
      said('server.api.providerTest.elevenlabs.usedUp', { used: count(used), limit: count(limit), resets }),
    )
  if ((limit - used) / limit < LOW_SHARE && !canExtend)
    return warning(
      'quota',
      said('server.api.providerTest.elevenlabs.almostUsedUp', { left: count(limit - used), resets }),
    )
  return ok()
}

const elevenLabsStt: Check = async (values, http) =>
  (await elevenLabsQuota(values, http)) ?? ok(said('server.api.providerTest.connectedNoQuota'))

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
  if (http.free) {
    const found = await http.json(
      `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
      { headers: { authorization: `Bearer ${values.api_key}` } },
      `the model ${model}`,
    )
    return found.ok ? ok() : failed(found.problem)
  }
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

// --- After-call transcription ---------------------------------------------------------------------
// The free reads only (no audio is sent): the key, and for OpenAI that it may use gpt-transcribe.

const openaiTranscript: Check = async (values, http) => {
  const found = await http.json(
    'https://api.openai.com/v1/models/gpt-transcribe',
    { headers: { authorization: `Bearer ${values.api_key}` } },
    'the model gpt-transcribe',
  )
  return found.ok ? ok() : failed(found.problem)
}

const assemblyai: Check = async (values, http) => {
  const res = await http.send('https://api.assemblyai.com/v2/transcript?limit=1', {
    headers: { authorization: values.api_key! },
  })
  return res.ok ? ok() : failed(await problemOfResponse('assemblyai', res, 'the key'))
}

// --- Language models ----------------------------------------------------------------------------

/** The first model of a "model, fallback" list, else the provider's default. */
const firstModel = (value: string | undefined, fallback: string) => value?.split(',')[0]?.trim() || fallback

/** A chat request of a few tokens: the key, the model and the account's quota in one. */
async function tinyCompletion(provider: ProviderName, http: Http, baseUrl: string, apiKey: string, model: string) {
  // The free check: the key reads the model list (Anthropic with its own headers), no tokens.
  if (http.free) {
    const headers: Record<string, string> =
      provider === 'anthropic'
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${apiKey}` }
    const res = await http.send(`${baseUrl}/models`, { headers })
    return res.ok ? null : await problemOfResponse(provider, res, 'the key')
  }
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
  if (remaining !== null && remaining <= 0) return error('quota', said('server.api.providerTest.openrouter.keyLimit'))
  const credits = await http.json('https://openrouter.ai/api/v1/credits', { headers })
  const left = credits.ok
    ? (num(credits.body.data?.total_credits) ?? 0) - (num(credits.body.data?.total_usage) ?? 0)
    : null
  if (left !== null && left <= 0) return error('quota', said('server.api.providerTest.openrouter.usedUp'))
  const models = await llm('openrouter')(values, http)
  if (!models.ok) return models
  if (left !== null && left < 1)
    return warning('quota', said('server.api.providerTest.openrouter.low', { amount: money(left) }))
  return left !== null ? ok(said('server.api.providerTest.connectedCredit', { amount: money(left) })) : ok()
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
        ? error('not_found', said('server.api.providerTest.elevenlabs.noVoice', { voice }))
        : failed(found.problem)
  }
  if (values.model) {
    const models = await http.json('https://api.elevenlabs.io/v1/models', { headers })
    const ids = models.ok && Array.isArray(models.body) ? (models.body as Json[]).map(m => m.model_id) : []
    if (ids.length && !ids.includes(values.model))
      return error('not_found', said('server.api.providerTest.elevenlabs.noModel', { model: values.model }))
  }
  // The quota could not be read with this key: one character of speech shows whether it can speak (not in the free check).
  if (!quota && !http.free) {
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
      return error('unknown', said('server.api.providerTest.elevenlabs.noAudio'))
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
      ? error('not_found', said('server.api.providerTest.cartesia.noVoice', { voice }))
      : failed(found.problem)
  // Cartesia does not tell the credit left: one character of speech shows whether it can speak (402 when used up).
  // The free check stops at the voice: the key works.
  if (http.free) return ok()
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

// --- Bot check ----------------------------------------------------------------------------------
// Cloudflare Turnstile (self-serve sign-up, docs/billing.md §3.1): siteverify with a token that cannot be valid. A
// good secret key answers `invalid-input-response`; a wrong one `invalid-input-secret`. Free, nothing is recorded.

const turnstile: Check = async (values, http) => {
  const answer = await http.json('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: values.secret_key!, response: 'linedesk-provider-test' }),
  })
  if (!answer.ok) return failed(answer.problem)
  const codes = Array.isArray(answer.body['error-codes']) ? (answer.body['error-codes'] as unknown[]).map(String) : []
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret'))
    return error('auth', said('server.api.providerTest.turnstile.unknownSecret'))
  if (!/^0x[\w-]{10,}$/.test(values.site_key ?? ''))
    return error('config', said('server.api.providerTest.turnstile.siteKey'))
  return ok()
}

// --- Connected apps -----------------------------------------------------------------------------
// Slack checks a made-up code before the client (`oauth.v2.access` answers `invalid_code` to any client ID), so the
// code exchange of the other OAuth apps proves nothing for Slack. `oauth.v2.exchange` with a made-up token checks the
// client ID first (`invalid_client_id`); the secret Slack checks only with a real code, so here only its form (32 hex
// digits). A wrong secret of the right form shows at the first connect, which records Slack as failing
// (app-connections.ts). Free, nothing is changed at Slack.

const slack: Check = async (values, http) => {
  const clientId = values.client_id!.trim()
  const secret = values.client_secret!.trim()
  if (!/^\d+\.\d+$/.test(clientId)) return error('auth', said('server.api.providerTest.slack.clientIdForm'))
  if (!/^[0-9a-f]{32}$/i.test(secret)) return error('auth', said('server.api.providerTest.slack.secretForm'))
  const answer = await http.json('https://slack.com/api/oauth.v2.exchange', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, token: 'xoxb-linedesk-connection-test' }),
  })
  if (!answer.ok) return failed(answer.problem)
  if (answer.body.error === 'invalid_client_id')
    return error('auth', said('server.api.providerTest.slack.unknownClientId'))
  if (answer.body.error === 'bad_client_secret')
    return error('auth', said('server.api.providerTest.slack.secretRejected'))
  if (answer.body.error === 'ratelimited') return error('network', said('server.api.providerTest.slack.rateLimited'))
  return warning('unknown', said('server.api.providerTest.slack.secretAtConnect'))
}

// Jobber has no app token and no introspection, but its token endpoint checks the client ID and secret before the
// grant: a made-up refresh token from an unknown client or with a wrong secret gets HTTP 401 "The provided client id
// and secret do not match an existing application" (checked live 2026-11-17). Any other refusal of the made-up token
// comes from past that check. Free, nothing is changed at Jobber (the token does not exist).
const JOBBER_TOKEN_URL = `${JOBBER_API}/api/oauth/token`

const jobber: Check = async (values, http) => {
  const res = await http.send(JOBBER_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'linedesk-connection-test',
      client_id: values.client_id!.trim(),
      client_secret: values.client_secret!.trim(),
    }),
  })
  const body = await res.text().catch(() => '')
  const { label } = providerSpec('jobber')
  if (JOBBER_CLIENT_REFUSED.test(body)) return error('auth', `${label} ${OAUTH_CLIENT_REJECTED}`)
  if (res.status === 429 || res.status >= 500)
    return error('network', said('server.api.providerTest.answered', { provider: label, status: res.status }))
  // Past the client check: Jobber refused only the made-up refresh token.
  if (res.status === 400 || res.status === 401) return ok()
  // Any other answer proves nothing about the client ID and secret: a wrong one shows at the first connect.
  return warning('unknown', said('server.api.providerTest.answered', { provider: label, status: res.status }))
}

type HttpProvider = Exclude<ProviderName, RecordingStoreName | OAuthApp | 'smtp' | MailService | 'stripe'>
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
  slack,
  jobber,
  openai_transcript: openaiTranscript,
  deepgram_transcript: deepgram,
  assemblyai,
  elevenlabs_transcript: elevenLabsStt,
  turnstile,
}

// --- Billing ------------------------------------------------------------------------------------
// Stripe (docs/billing.md §7): GET /v1/account through the billing adapter, free and readable with a restricted key.
// It names the mode, country and default currency; live keys are refused unless the server allows them
// (BILLING_LIVE_KEYS=1, production only; packages/billing/src/keys.ts).

/** What a Stripe key may not write, for the provider test's warning (security review of #1040, M-1). */
const STRIPE_WRITE_DENIED = {
  products: msg('admin.provider.test.stripeDenied.products'),
  prices: msg('admin.provider.test.stripeDenied.prices'),
  both: msg('admin.provider.test.stripeDenied.both'),
} as const

/** What a failed Stripe request means. Stripe's own text is not passed on (it can quote part of the key). */
function stripeProblem(e: unknown): SaidProblem {
  const status = typeof e === 'object' && e && 'statusCode' in e ? Number(e.statusCode) : undefined
  const type = typeof e === 'object' && e && 'type' in e ? String(e.type) : ''
  if (type === 'StripeAuthenticationError' || status === 401)
    return problem('auth', said('server.api.providerTest.stripe.keyRejected'))
  if (type === 'StripePermissionError' || status === 403)
    return problem('permission', said('server.api.providerTest.stripe.permission'))
  if (type === 'StripeRateLimitError' || status === 429)
    return problem('network', said('server.api.providerTest.stripe.rateLimited'))
  if (type === 'StripeConnectionError') return problem('network', said('server.api.providerTest.stripe.unreachable'))
  return problem(
    status && status >= 500 ? 'network' : 'unknown',
    said('server.api.providerTest.stripe.answered', { status: status ? String(status) : 'none' }),
  )
}

export async function testStripe(
  values: Values,
  doFetch: typeof fetch,
  env: Record<string, string | undefined>,
): Promise<Tested> {
  const secretKey = values.secret_key!
  const mode = stripeKeyMode(secretKey)
  if (!mode) return error('config', said('server.api.providerTest.stripe.notAKey'))
  if (mode === 'live' && !liveKeysAllowed(env)) return error('config', LIVE_KEYS_REFUSED)
  try {
    const provider = await loadBillingProvider({ secretKey, webhookSecret: values.webhook_secret! }, doFetch)
    const account = await provider.account()
    if (!account) return error('config', said('server.api.providerTest.notSetUp'))
    const where = [account.country, account.defaultCurrency?.toUpperCase()].filter(Boolean).join(', ') || 'none'
    // The catalog sync writes Products and Prices (security review of #1040, M-1): probed without writing anything.
    const access = await provider.catalogWriteAccess()
    const denied =
      access.products === false
        ? access.prices === false
          ? 'both'
          : 'products'
        : access.prices === false
          ? 'prices'
          : null
    const line = (reader: Reader) =>
      reader.t('server.api.providerTest.stripe.connected', { mode, where, account: account.id })
    if (denied)
      return warning(
        'permission',
        said('admin.provider.test.stripeCatalogWrite', {
          line,
          denied: reader => reader.t(STRIPE_WRITE_DENIED[denied]),
        }),
      )
    // Every trial and plan Checkout asks for terms consent, which Stripe refuses without the account's Terms of
    // Service URL (stripe_terms_url_missing). The API cannot set it: the admin is told where, before an owner meets it.
    if ((await provider.checkoutTermsReady(WEB_ORIGIN)) === false)
      return warning('config', said('admin.provider.test.stripeTermsUrl', { line }))
    // The catalog sync keeps the customer portal to the design (no cancel): it needs write on its configuration.
    if ((await provider.portalWriteAccess()) === false)
      return warning('permission', said('admin.provider.test.stripePortalWrite', { line }))
    return ok(
      said(
        mode === 'live'
          ? 'server.api.providerTest.stripe.connectedLive'
          : 'server.api.providerTest.stripe.connectedTest',
        {
          where,
          account: account.id,
        },
      ),
    )
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      return error('timeout', said('server.api.providerTest.stripe.timeout', { seconds: TIMEOUT_MS / 1000 }))
    return failed(stripeProblem(e))
  }
}

// --- Email -----------------------------------------------------------------------------------

/**
 * SMTP: connect and log in. The answer is cut down to what an operator needs (which host, a
 * timeout, a refused login), never the server's own text beyond a status code: the SMTP URL may
 * point anywhere, and its password must not come back.
 */
async function testSmtp(url: string, from: string | undefined, login: 'url' | 'key' = 'url'): Promise<Tested> {
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
    return error(
      'auth',
      said(login === 'url' ? 'server.api.providerTest.smtp.loginRefused' : 'server.api.providerTest.smtp.keyRefused'),
    )
  return error(
    'network',
    scrubbed.startsWith('Could not send email: ')
      ? scrubbed.slice(0, MAX_MESSAGE) // our own text: which host did not answer
      : said('server.api.providerTest.smtp.notAccepted'),
  )
}

/** The domain of a From line ("Desk <desk@example.com>" or a bare address). */
export const fromDomain = (from: string | undefined) => /@([^\s>]+)>?\s*$/.exec(from ?? '')?.[1]?.toLowerCase() ?? null

/** Resend sends only from verified domains. A key with sending access only cannot list them: then not checked. */
async function resendDomain(values: Values, doFetch: typeof fetch): Promise<Tested | null> {
  const domain = fromDomain(values.from)
  if (!domain) return null
  const answer = await httpFor('resend', doFetch).json('https://api.resend.com/domains', {
    headers: { authorization: `Bearer ${values.api_key}` },
  })
  if (!answer.ok) return null
  const listed = ((answer.body.data ?? []) as Json[]).find(d => String(d.name).toLowerCase() === domain)
  if (!listed) return error('config', said('server.api.providerTest.resend.notADomain', { domain }))
  if (listed.status !== 'verified')
    return error(
      'config',
      said('server.api.providerTest.resend.notVerified', { domain, status: String(listed.status).slice(0, 30) }),
    )
  return null
}

// --- Sign-in and calendar apps ------------------------------------------------------------------

type OAuthApp = 'google' | 'microsoft' | 'github' | 'oidc' | 'calendly' | 'calcom' | 'hubspot'
const oauthApps: readonly ProviderName[] = ['google', 'microsoft', 'github', 'oidc', 'calendly', 'calcom', 'hubspot']
const isOAuthApp = (provider: ProviderName): provider is OAuthApp => oauthApps.includes(provider)

/** Where an OAuth app exchanges a code for tokens. OIDC: from its discovery document. */
async function tokenEndpoint(provider: OAuthApp, values: Values, doFetch: typeof fetch): Promise<string> {
  if (provider === 'google') return 'https://oauth2.googleapis.com/token'
  if (provider === 'github') return 'https://github.com/login/oauth/access_token'
  if (provider === 'calendly') return 'https://auth.calendly.com/oauth/token'
  if (provider === 'calcom') return 'https://api.cal.com/v2/auth/oauth2/token'
  if (provider === 'hubspot') return 'https://api.hubapi.com/oauth/v3/token'
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
 * The request that checks an OAuth app. Most providers check the client ID and secret before the code, so a made-up
 * code they reject ("invalid_grant", "bad_verification_code") means the app is right. HubSpot and Microsoft check the
 * code first and pass any client with "BAD_AUTH_CODE" or "AADSTS9002313" (LIN-370): they are asked for an app token
 * instead (client_credentials), which they refuse for an unknown client or a wrong secret. A token they do issue is
 * not kept. Calendly asks for PKCE before it looks at the client, so its request has a code_verifier.
 */
function oauthProbe(provider: OAuthApp, values: Values): URLSearchParams {
  const client = { client_id: values.client_id!, client_secret: values.client_secret! }
  if (provider === 'hubspot') return new URLSearchParams({ grant_type: 'client_credentials', ...client })
  if (provider === 'microsoft')
    return new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
      ...client,
    })
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'linedesk-connection-test',
    ...client,
    redirect_uri: 'https://localhost/linedesk-connection-test',
    ...(provider === 'calendly' && { code_verifier: 'linedesk-connection-test-code-verifier-0123456789' }),
  })
}

/** Providers asked for an app token (oauthProbe): any answer but a refused client means the client is right. */
const asksForAppToken = (provider: OAuthApp) => provider === 'hubspot' || provider === 'microsoft'

type OAuthAnswer = { error?: unknown; error_description?: unknown; error_codes?: unknown; status?: unknown }

/** Microsoft's AADSTS codes in an answer. */
const aadstsCodes = (answer: OAuthAnswer): number[] =>
  Array.isArray(answer.error_codes) ? answer.error_codes.map(Number) : []

/**
 * Whether the provider refused the client ID or secret. HubSpot names the refused part in `status`; Microsoft
 * answers an unknown client with AADSTS700016 and a wrong secret with AADSTS7000215; GitHub answers an unknown client
 * ID with 404.
 */
function refusedClient(provider: OAuthApp, res: Response, answer: OAuthAnswer): boolean {
  if (answer.status === 'BAD_CLIENT_ID' || answer.status === 'BAD_CLIENT_SECRET') return true
  if (['invalid_client', 'incorrect_client_credentials', 'unauthorized_client'].includes(String(answer.error)))
    return true
  if (aadstsCodes(answer).some(code => code === 700016 || code === 7000215)) return true
  return provider === 'github' && res.status === 404
}

/**
 * Whether an app-token answer comes from past the client check: a token, or the provider's own refusal of the grant
 * or scope (not every app may get an app token). Only an answer in the provider's shape counts (HubSpot's `status`,
 * Microsoft's AADSTS codes), never a bare 400 from something in between.
 */
const pastClientCheck = (provider: OAuthApp, res: Response, answer: OAuthAnswer) =>
  res.ok ||
  (res.status === 400 && (provider === 'hubspot' ? typeof answer.status === 'string' : aadstsCodes(answer).length > 0))

/**
 * An OAuth app is checked with one token request that the provider refuses for a wrong client (oauthProbe). Missing
 * scopes or a disabled calendar API show only when a member connects: then the calendar records the failure.
 */
async function testOAuthApp(provider: OAuthApp, values: Values, doFetch: typeof fetch): Promise<Tested> {
  const { label } = providerSpec(provider)
  try {
    const res = await doFetch(await tokenEndpoint(provider, values, doFetch), {
      method: 'POST',
      body: oauthProbe(provider, values),
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        // Calendly takes the client ID and secret as HTTP Basic only.
        ...(provider === 'calendly' && {
          authorization: `Basic ${btoa(`${values.client_id}:${values.client_secret}`)}`,
        }),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const answer = (await res.json().catch(() => ({}))) as OAuthAnswer
    // Microsoft names an expired secret in the description (AADSTS7000222).
    if (typeof answer.error_description === 'string' && answer.error_description.includes('AADSTS7000222'))
      return error('auth', said('server.api.providerTest.oauth.secretExpired', { provider: label }))
    if (refusedClient(provider, res, answer)) return error('auth', `${label} ${OAUTH_CLIENT_REJECTED}`)
    const aadsts = aadstsCodes(answer)
    // A tenant Microsoft does not know (AADSTS90002), or not a tenant ID or domain (AADSTS900023).
    if (aadsts.includes(90002) || aadsts.includes(900023))
      return error(
        'config',
        said('server.api.providerTest.oauth.unknownTenant', {
          provider: label,
          tenant: (values.tenant_id || 'common').slice(0, 80),
        }),
      )
    // Microsoft answers an unknown client ID with AADSTS53003 too, so this cannot tell the two apart.
    if (aadsts.includes(53003))
      return error('permission', said('server.api.providerTest.oauth.conditionalAccess', { provider: label }))
    if (asksForAppToken(provider)) {
      if (pastClientCheck(provider, res, answer)) return ok()
    } else if (['invalid_grant', 'bad_verification_code', 'redirect_uri_mismatch'].includes(String(answer.error)))
      return ok()
    const code = typeof answer.status === 'string' ? answer.status : answer.error
    return error(
      res.status >= 500 ? 'network' : 'unknown',
      `${label} answered HTTP ${res.status}${typeof code === 'string' ? ` (${code.slice(0, 40)})` : ''}`.replaceAll(
        values.client_secret!,
        '[redacted]',
      ),
    )
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError')
      return error('timeout', said('server.api.providerTest.timeout', { provider: label, seconds: TIMEOUT_MS / 1000 }))
    return error(
      'network',
      said('server.api.providerTest.oauth.unreachable', {
        provider: label,
        error: errorText(e).replaceAll(values.client_secret!, '[redacted]').slice(0, MAX_MESSAGE),
      }),
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
export function s3Problem(e: S3RequestError): SaidProblem {
  if (e.code === 'NoSuchBucket') return problem('not_found', said('server.api.providerTest.s3.noBucket'))
  if (e.code === 'AccessDenied' || e.code === 'AllAccessDisabled')
    return problem('permission', said('server.api.providerTest.s3.denied', { step: e.step, status: e.status }))
  if (e.code === 'QuotaExceeded' || e.status === 507) return problem('quota', said('server.api.providerTest.s3.full'))
  if (e.status === 401 || e.status === 403)
    return problem('auth', said('server.api.providerTest.s3.keysRejected', { status: e.status }))
  if ([301, 307].includes(e.status) || e.code === 'PermanentRedirect' || e.code === 'AuthorizationHeaderMalformed')
    return problem('config', said('server.api.providerTest.s3.region'))
  return problem(
    e.status >= 500 ? 'network' : 'unknown',
    said('server.api.providerTest.s3.answered', { status: e.status }),
  )
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
): Promise<Tested> {
  const secrets = [values.secret_access_key, values.access_key_id].filter((v): v is string => !!v && v.length >= 4)
  const scrub = (text: string) =>
    secrets.reduce((t, value) => t.replaceAll(value, '[redacted]'), text).slice(0, MAX_MESSAGE)
  try {
    // Never to link-local or metadata addresses (s3-endpoint.ts).
    const refused = provider === 's3' && values.endpoint ? await s3EndpointProblem(values.endpoint) : null
    if (refused) return error('config', refused.message)
    const guarded = s3Fetch(doFetch)
    const store =
      provider === 'file'
        ? createFileRecordingStore(recordingsDir(env))
        : s3StoreFromValues(values, (input, init) =>
            guarded(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }),
          )
    await store.probe()
    return ok()
  } catch (e) {
    if (e instanceof RecordingConfigError) return error('config', scrub(e.message))
    if (e instanceof S3RequestError) return failed(s3Problem(e))
    if (e instanceof Error && e.name === 'TimeoutError')
      return error('timeout', said('server.api.providerTest.s3.timeout', { seconds: TIMEOUT_MS / 1000 }))
    return error('network', said('server.api.providerTest.s3.unreachable', { error: scrub(errorText(e)) }))
  }
}

const isRecordingStore = (provider: ProviderName): provider is RecordingStoreName =>
  providerSpec(provider).category === 'recording'

/** The fields a provider needs that have no value. */
export function missingFields(provider: ProviderName, config: ProviderConfig): string[] {
  const { fields } = providerSpec(provider)
  return Object.keys(fields).filter(field => !fields[field]!.optional && !config[field]?.value)
}

/**
 * `config` holds the keys in effect. `doFetch` is replaced in tests. `free`: only requests that cost nothing (the
 * background health check): the key, the account and its balance where the provider tells, never tokens or speech.
 */
export async function testProvider(
  provider: ProviderName,
  config: ProviderConfig,
  doFetch: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
  options: { free?: boolean } = {},
): Promise<ProviderTestData> {
  return testAnswer(await testProviderSaid(provider, config, doFetch, env, options))
}

/** testProvider with the result's key (Tested.said), for an answer in the reader's language (testAnswer). */
export async function testProviderSaid(
  provider: ProviderName,
  config: ProviderConfig,
  doFetch: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
  { free = false }: { free?: boolean } = {},
): Promise<Tested> {
  const { label, fields } = providerSpec(provider)
  const values: Values = Object.fromEntries(
    Object.entries(config).flatMap(([field, entry]) => (entry ? [[field, entry.value]] : [])),
  )
  const missing = missingFields(provider, config)
  if (missing.length)
    return error(
      'config',
      said('server.api.providerTest.notSet', {
        fields: missing.map(field => providerFieldLabel(provider, field)).join(', '),
      }),
    )
  if (isRecordingStore(provider)) return testRecordingStore(provider, values, doFetch, env)
  if (provider === 'smtp') return testSmtp(values.url!, values.from)
  if (isMailService(provider)) {
    const smtp = smtpOf(provider, values)
    if (!smtp) return error('config', said('server.api.providerTest.notSetUp'))
    const login = await testSmtp(smtp.url, smtp.from, 'key')
    if (!login.ok || provider !== 'resend') return login
    return (await resendDomain(values, doFetch).catch(() => null)) ?? login
  }
  if (isOAuthApp(provider)) return testOAuthApp(provider, values, doFetch)
  if (provider === 'stripe') return testStripe(values, doFetch, env)

  // Whatever comes back, a key must not travel on: drop every secret value that appears in the text.
  const scrub = (text: string) =>
    Object.entries(values)
      .filter(([field, value]) => fields[field]?.secret && value.length >= 4)
      .map(([, value]) => value)
      .reduce((t, value) => t.replaceAll(value, '[redacted]'), text)
      .slice(0, MAX_MESSAGE)
  try {
    const result = await checks[provider](values, httpFor(provider, doFetch, free))
    // The params of a said text are scrubbed too: a model or voice field is never a secret, but nothing slips through.
    const text = result.said && {
      ...result.said,
      ...(result.said.params && {
        params: Object.fromEntries(
          Object.entries(result.said.params).map(([name, value]) => [
            name,
            typeof value === 'string' ? scrub(value) : value,
          ]),
        ),
      }),
    }
    return { ...result, message: scrub(result.message), ...(text && { said: text }) }
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError')
      return error('timeout', said('server.api.providerTest.timeout', { provider: label, seconds: TIMEOUT_MS / 1000 }))
    const { reason, message } = problemOfError(provider, e)
    return error(reason, scrub(`${message.replace(/\.$/, '')} (${errorText(e)})`))
  }
}
