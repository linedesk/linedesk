// Install setup by hand (LIN-128, docs/self-host-first-run.md): where the walkthrough is (`setup.install` in
// instance_settings) and the round trips that show a part really works (`provider.tryOut`): a code emailed to the
// admin and typed back, a short question to the live model, a bundled recording transcribed, a sentence spoken, three
// available numbers listed without buying. Each tries the provider calls use, never returns or logs a key, and records
// its result for the setup checklist (rememberTest), so "Works" means the same in both places.
import { createHash, randomInt } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  type InstallProgress,
  type InstallStep,
  installSteps,
  type LlmProvider,
  llmEndpoints,
  type ProviderName,
  providerSpec,
  type TryOutData,
  type TryOutKind,
} from '@linedesk/actions'
import { instance_settings, type Tx, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { restartState } from './instance-env.ts'
import { problemOfError, problemOfResponse } from './provider-errors.ts'
import { activeProvider, type ProviderConfig, telephonyProvider } from './provider-settings.ts'
import { createRateLimiter } from './rate-limit.ts'
import { rememberTest } from './setup-checklist.ts'
import { BUNDLED_PREVIEWS_DIR, installDefaultVoice, PREVIEW_TEXT, voiceProviderInUse } from './voices.ts'

const SETTING = 'setup.install'
const TIMEOUT_MS = 15_000

/** Off on Cloud (LINEDESK_INSTALL_SETUP=off): the operator's admins keep the checklist, never the walkthrough. */
export const installSetupEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.LINEDESK_INSTALL_SETUP?.trim().toLowerCase() !== 'off'

const fresh = (): InstallProgress => ({ step: 'welcome', skipped: [], finishedAt: null, setAsideAt: null })

export async function readInstallProgress(tx: Tx | typeof db = db): Promise<InstallProgress> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, SETTING))
  if (!row) return fresh()
  try {
    const stored = JSON.parse(row.value) as Partial<InstallProgress>
    const known = (s: unknown): s is InstallStep => (installSteps as readonly unknown[]).includes(s)
    return {
      step: known(stored.step) ? stored.step : 'welcome',
      skipped: Array.isArray(stored.skipped) ? stored.skipped.filter(known) : [],
      finishedAt: typeof stored.finishedAt === 'string' ? stored.finishedAt : null,
      setAsideAt: typeof stored.setAsideAt === 'string' ? stored.setAsideAt : null,
    }
  } catch {
    return fresh()
  }
}

/** GET /v1/admin/install-setup: where the walkthrough is, whether it is on, and whether a restart is pending. */
export async function installSetupState() {
  return {
    enabled: installSetupEnabled(),
    progress: await readInstallProgress(),
    restart: await restartState(db),
    /** How email goes out in this process: `log` is EMAIL_TO_LOG (development), `none` is not set up. */
    emailDelivery: emailSender.kind,
  }
}

// --- Round trips ---------------------------------------------------------------------------------

/** Per admin and kind: enough to retry, not enough to run up a bill. Email less, it lands in a real inbox. */
const tryLimit = createRateLimiter({ max: 20, windowMs: 3_600_000 })
const emailLimit = createRateLimiter({ max: 5, windowMs: 3_600_000 })

/** The code of the last test email per admin: only its hash, for ten minutes, five tries. */
const EMAIL_CODE_MS = 10 * 60_000
const emailCodes = new Map<string, { hash: string; expires: number; tries: number }>()
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')
/** For the tests: forget every pending code. */
export const forgetEmailCodes = () => emailCodes.clear()

const values = (config: ProviderConfig) =>
  Object.fromEntries(Object.entries(config).flatMap(([f, e]) => (e ? [[f, e.value]] : []))) as Record<string, string>
const labelOf = (provider: ProviderName) => providerSpec(provider).label
const seconds = (since: number) => Math.round((performance.now() - since) / 100) / 10
const send = (url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })

type Tried = Omit<TryOutData, 'kind'>
const failed = (provider: string | null, message: string): Tried => ({ ok: false, provider, message })

/** The words of a sentence, for comparing what was said with what came back. */
const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
/** How much of the expected sentence came back, 0 to 1. */
export function wordMatch(expected: string, heard: string) {
  const want = words(expected)
  const got = new Set(words(heard))
  return want.length ? want.filter(w => got.has(w)).length / want.length : 0
}

/** The provider calls use for a part; the realtime model when it answers calls in place of speech, model and voice. */
async function inUse(tx: Tx, category: 'stt' | 'llm' | 'tts') {
  const active = await activeProvider(tx, category)
  if (active) return { ...active, realtime: false }
  const realtime = await activeProvider(tx, 'realtime')
  return realtime ? { ...realtime, realtime: true } : null
}

const CALLER_LINE = 'Hi, my water heater is leaking. Can someone come out today?'

async function tryLlm(tx: Tx): Promise<Tried> {
  const active = await inUse(tx, 'llm')
  if (!active) return failed(null, 'No language model is set up yet.')
  const { provider, config } = active
  // Only OpenAI's realtime model has a chat model behind the same key.
  const realtime = active.realtime && provider === 'openai_realtime'
  if (active.realtime && !realtime) return failed(labelOf(provider), `${labelOf(provider)} is tried in a test call.`)
  const v = values(config)
  // With one OpenAI key, calls are answered by the realtime model; its summary model shows the key and quota work.
  const endpoint = realtime ? llmEndpoints.openai : llmEndpoints[provider as LlmProvider]
  if (!endpoint) return failed(labelOf(provider), `${labelOf(provider)} cannot be tried here.`)
  const model = realtime ? v.summary_model || 'gpt-4.1-mini' : v.model?.split(',')[0]?.trim() || endpoint.models[0]
  const limit = provider === 'openai' || realtime ? { max_completion_tokens: 80 } : { max_tokens: 80 }
  const start = performance.now()
  const res = await send(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${v.api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You answer the phone for Brightwater Plumbing & Heating in Portland. Reply in one or two short spoken sentences.',
        },
        { role: 'user', content: CALLER_LINE },
      ],
      ...limit,
    }),
  })
  const took = seconds(start)
  if (!res.ok) return failed(labelOf(provider), (await problemOfResponse(provider, res, `the model ${model}`)).message)
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const reply = body.choices?.[0]?.message?.content?.trim()
  if (!reply) return failed(labelOf(provider), `${model} answered with nothing.`)
  const slow = took > 1.5 && !realtime ? ' Callers notice a pause above about 1.5 s: a faster model helps.' : ''
  return {
    ok: true,
    provider: labelOf(provider),
    reply: reply.slice(0, 400),
    seconds: took,
    message: `${model} answered in ${took} s.${slow}`,
  }
}

/** A curated voice's bundled sample: our own recording of PREVIEW_TEXT, shipped with the app. */
const TEST_CLIP = join(BUNDLED_PREVIEWS_DIR, 'elevenlabs', 'cgSgspJ2msm6clMCkdW9.mp3')

async function transcribe(provider: ProviderName, v: Record<string, string>, clip: Buffer): Promise<Response> {
  const file = () => new Blob([new Uint8Array(clip)], { type: 'audio/mpeg' })
  if (provider === 'deepgram')
    return send(
      `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(v.model || 'nova-3')}&smart_format=true`,
      {
        method: 'POST',
        headers: { authorization: `Token ${v.api_key}`, 'content-type': 'audio/mpeg' },
        body: new Uint8Array(clip),
      },
    )
  if (provider === 'elevenlabs_stt') {
    const form = new FormData()
    // The configured model streams; the same account transcribes a file with the batch model.
    form.append('model_id', 'scribe_v1')
    form.append('file', file(), 'caller.mp3')
    return send('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': v.api_key! },
      body: form,
    })
  }
  // OpenAI transcription, and the realtime key (its own transcription model hears the caller on calls).
  const form = new FormData()
  form.append('model', provider === 'openai_stt' && v.model ? v.model : 'gpt-4o-mini-transcribe')
  form.append('file', file(), 'caller.mp3')
  return send('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${v.api_key}` },
    body: form,
  })
}

async function trySpeech(tx: Tx): Promise<Tried> {
  const active = await inUse(tx, 'stt')
  if (!active) return failed(null, 'No speech to text is set up yet.')
  const { provider, config } = active
  if (!['deepgram', 'elevenlabs_stt', 'openai_stt', 'openai_realtime'].includes(provider))
    return failed(labelOf(provider), `${labelOf(provider)} cannot be tried here.`)
  const start = performance.now()
  const res = await transcribe(provider, values(config), await readFile(TEST_CLIP))
  const took = seconds(start)
  if (!res.ok) return failed(labelOf(provider), (await problemOfResponse(provider, res, 'transcribing')).message)
  // biome-ignore lint/suspicious/noExplicitAny: the three providers' JSON, read field by field
  const body = (await res.json()) as any
  const heard: string = (body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? body.text ?? '').trim()
  const match = wordMatch(PREVIEW_TEXT, heard)
  const ok = match >= 0.6
  return {
    ok,
    provider: labelOf(provider),
    expected: PREVIEW_TEXT,
    heard,
    seconds: took,
    message: ok
      ? `Heard ${Math.round(match * 100)}% of the words in ${took} s.`
      : heard
        ? `Only ${Math.round(match * 100)}% of the words came back. Check the model setting, or try another provider.`
        : 'Nothing came back from the recording. Check the model setting, or try another provider.',
  }
}

const SPOKEN = 'Thanks for calling Brightwater Plumbing, this is Maya. How can I help you today?'

async function tryVoice(tx: Tx): Promise<Tried> {
  const voice = await voiceProviderInUse(tx)
  const pick = await installDefaultVoice(tx)
  if (!voice || !pick) {
    const realtime = await activeProvider(tx, 'realtime')
    if (realtime)
      return {
        ok: true,
        provider: labelOf(realtime.provider),
        message: `${labelOf(realtime.provider)} speaks on calls with its own voice: hear it in a test call.`,
      }
    return failed(null, 'No voice is set up yet.')
  }
  const start = performance.now()
  const audio = await voice.synthesize(pick.voiceId, SPOKEN)
  const took = seconds(start)
  return {
    ok: true,
    provider: labelOf(voice.name),
    seconds: took,
    audio: `data:${audio.contentType};base64,${audio.bytes.toString('base64')}`,
    message: `Spoken in ${took} s. Each assistant picks its own voice later.`,
  }
}

async function tryCarrier(tx: Tx, areaCode: string): Promise<Tried> {
  const carrier = await telephonyProvider(tx)
  const label = carrier.name === 'dev' ? 'Development carrier' : labelOf(carrier.name)
  // Telnyx answers an empty search with an error ("No numbers found for the given filters"): that is an answer, not
  // a connection problem.
  const found = await carrier.searchNumbers({ country: 'US', areaCode, limit: 3 }).catch((e: unknown) => {
    if (e instanceof Error && /no numbers found/i.test(e.message)) return []
    throw e
  })
  if (!found.length)
    // The carrier answered with the keys in effect: it works, this area code is just empty right now.
    return {
      ok: true,
      provider: label,
      numbers: [],
      message: `${label} answers, but has no numbers in ${areaCode} right now. Try a nearby area code.`,
    }
  return {
    ok: true,
    provider: label,
    numbers: found.map(n => n.e164),
    message: `${label} can give out numbers: ${found.length} available in ${areaCode}. Nothing was bought.`,
  }
}

async function tryEmail(tx: Tx, actorId: string): Promise<Tried> {
  if (emailSender.kind === 'none') return failed(null, 'No email is set up yet.')
  // The API sends with the settings it started with: a saved change is tried once it runs with it.
  if ((await restartState(db)).pending)
    return failed(null, 'The new email settings are used after the API restarts. Try again then.')
  const [me] = await tx.select({ email: user.email }).from(user).where(eq(user.id, actorId))
  if (!me?.email) return failed(null, 'Your account has no email address.')
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const sent = await emailSender
    .send({
      to: me.email,
      subject: `${code} is your Linedesk test code`,
      text: `Your email works.\n\nType this code into the install setup to finish the test:\n\n    ${code}\n\nIt works for ten minutes.`,
    })
    .then(
      () => true,
      (e: unknown) => {
        // The mail server's own words go to the API log only.
        console.error('install setup: test email not sent:', e instanceof Error ? e.message : e)
        return false
      },
    )
  if (!sent) return failed(null, 'The test email could not be sent. Check the email settings; the API log says why.')
  emailCodes.set(actorId, { hash: hashCode(code), expires: Date.now() + EMAIL_CODE_MS, tries: 0 })
  const where = emailSender.kind === 'log' ? ' It went to the API log (EMAIL_TO_LOG), not a real inbox.' : ''
  return {
    ok: true,
    provider: emailSender.kind === 'log' ? 'API log' : 'Email',
    sentTo: me.email,
    message: `A code went to ${me.email}. Type it in to finish the test.${where}`,
  }
}

/** Where a round trip's result goes in the setup checklist: the provider it tried, with the keys it tried. */
async function remember(tx: Tx, kind: TryOutKind, result: Tried) {
  const category = kind === 'email' ? null : kind
  if (!category) return
  const active = category === 'telephony' ? await activeProvider(tx, 'telephony') : await inUse(tx, category)
  // Speech heard by the realtime model counts for the realtime row, not for an unset speech provider.
  if (active) rememberTest(active.provider, active.config, { ok: result.ok, message: result.message })
}

function refuseImpersonation(actor: { impersonation?: unknown }) {
  if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
}

export const installSetupHandlers: Record<string, Handler> = {
  'install.setProgress': async ({ tx, actor, now }, input) => {
    const progress = await readInstallProgress(tx)
    if (input.step) progress.step = input.step
    if (input.skip && !progress.skipped.includes(input.skip)) progress.skipped.push(input.skip)
    if (input.setAside !== undefined) progress.setAsideAt = input.setAside ? now : null
    if (input.finished !== undefined) progress.finishedAt = input.finished ? now : null
    const value = JSON.stringify(progress)
    await tx
      .insert(instance_settings)
      .values({ key: SETTING, value, updated_at: now, updated_by: actor.actorId })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
    return { rows: {}, data: { progress } }
  },

  'provider.tryOut': async ({ tx, actor }, input) => {
    refuseImpersonation(actor)
    const kind = input.kind as TryOutKind
    const limiter = kind === 'email' ? emailLimit : tryLimit
    if (!limiter(`${actor.actorId}:${kind}`)) throw new Reject('Tried too often in the last hour; try again later.')
    let result: Tried
    try {
      result =
        kind === 'llm'
          ? await tryLlm(tx)
          : kind === 'stt'
            ? await trySpeech(tx)
            : kind === 'tts'
              ? await tryVoice(tx)
              : kind === 'telephony'
                ? await tryCarrier(tx, input.areaCode ?? '971')
                : await tryEmail(tx, actor.actorId)
    } catch (e) {
      const active =
        kind === 'email' ? null : kind === 'telephony' ? await activeProvider(tx, 'telephony') : await inUse(tx, kind)
      const provider = active?.provider ?? null
      const message =
        e instanceof Error && e.name === 'TimeoutError'
          ? `No answer within ${TIMEOUT_MS / 1000} seconds.`
          : provider
            ? problemOfError(provider, e).message
            : e instanceof Error
              ? e.message
              : String(e)
      result = failed(provider ? labelOf(provider) : null, message)
    }
    // A sent email counts once its code comes back (provider.confirmEmail); the realtime model's own voice is not
    // tried here, so it records nothing.
    const tried = !(result.ok && (kind === 'email' || (kind === 'tts' && !result.audio)))
    if (tried) await remember(tx, kind, result)
    const data: TryOutData = { kind, ...result }
    return { rows: {}, data }
  },

  'provider.confirmEmail': async ({ tx, actor }, input) => {
    refuseImpersonation(actor)
    const pending = emailCodes.get(actor.actorId)
    if (!pending || pending.expires < Date.now()) throw new Reject('No test code is waiting: send a new one.')
    if (pending.tries >= 5) {
      emailCodes.delete(actor.actorId)
      throw new Reject('Too many wrong codes: send a new one.')
    }
    pending.tries++
    if (pending.hash !== hashCode(input.code)) throw new Reject('That is not the code from the email.')
    emailCodes.delete(actor.actorId)
    // Delivery works end to end: the email row of the checklist says so, when a real mail server sent it with the
    // settings stored now (not the API log, not settings a restart has not picked up yet).
    const email = await activeProvider(tx, 'email')
    if (email && emailSender.kind === 'smtp' && !(await restartState(db)).pending)
      rememberTest(email.provider, email.config, { ok: true, message: 'Test email arrived' })
    return { rows: {}, data: { ok: true, message: 'Email works: the code arrived.' } }
  },
}
