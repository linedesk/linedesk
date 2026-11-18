// A white-label partner's own provider keys (docs/white-label.md, slice S7; actions in packages/actions/src/partner-keys.ts).
//
// - The partner's owner connects one key per stage (speech to text, language model, voice, realtime model) in Partner ›
//   AI keys, signed in recently (the personal key step-up). Stored in `partner_providers`, its own table (never
//   provider_settings: no query of the install's keys can pick a partner's up), AES-256-GCM bound to
//   `partner:<partnerId>:<stage>:<provider>.api_key`. This file is the only reader, always by a partner id it derives
//   itself (the caller's team, or the call's workspace), never from input on the call path. No read returns a key.
// - Per client workspace a switch (`workspace_settings.partner_keys`, the owner only). A call of a switched-on client is
//   forecast `own_keys` at call.start (workspaceOwnKeys) only when the partner is approved and not turned off by an
//   instance admin, the client uses its own carrier, and every stage of the call's pipeline has a partner key that
//   tested ok (and the voice is of the partner's voice provider, never a clone in the install's account). The agent then
//   reads the keys for that call only (GET /v1/agent/call-provider-config, install token), and the call is $0 only when
//   call.finish confirms every stage ran on them (ledger.ts ownKeysConfirmed). Anything missing: billed at its level.
// - A partner key that fails (a test, or a call's voice failure) turns its stage `failing`: calls are not forecast on
//   it until a test passes again; its owner is emailed once a day at most.
import {
  KEY_SOURCES,
  type KeySource,
  type KeySources,
  PARTNER_KEY_STAGES,
  type PartnerKeyCode,
  type PartnerKeyRow,
  type PartnerKeyStage,
  type PartnerKeysData,
  type ProviderName,
  type ProviderTestData,
  providerSpec,
} from '@linedesk/actions'
import {
  calls,
  organization,
  partner_members,
  partner_providers,
  partners,
  type Tx,
  user,
  voice_clones,
  workspace_settings,
} from '@linedesk/db'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { DEFAULT_TIME_ZONE } from './bookings.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { sendNotice } from './email.ts'
import { partnerKeysEmail } from './emails/alerts.ts'
import { Forbidden, type Handler, type Preparer, Reject } from './handler-context.ts'
import { personalKeyStepUpNeeded, personalKeyStepUpRefusal } from './owner-step-up.ts'
import { partnerOnTeam } from './partner-brand.ts'
import { NOT_ON_PARTNER_TEAM } from './partner-refusals.ts'
import { testAnswer, testProviderSaid } from './provider-test.ts'
import { createRateLimiter } from './rate-limit.ts'
import { decryptSecret, encryptSecret, hasSecretsKey, SecretsKeyError } from './secrets.ts'
import { workspaceCarrier } from './workspace-carrier.ts'

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
/** "Test again" asks the provider each time: a few in a row are normal, more per partner are refused. */
export const PARTNER_KEY_TESTS_PER_10_MIN = 10
const allowTest = createRateLimiter({ max: PARTNER_KEY_TESTS_PER_10_MIN, windowMs: 10 * 60_000 })
const FAILURE_MAX = 200
const DAY_MS = 24 * 60 * 60 * 1000

/** The slot (secrets.ts) of a partner's key: a value copied to another partner, stage or provider does not decrypt. */
export const partnerKeySlot = (partnerId: string, stage: string, provider: string) =>
  `partner:${partnerId}:${stage}:${provider}.api_key`
const lastFour = (value: string) => (value.length >= 12 ? value.slice(-4) : null)

// i18n-ignore: API error bodies for logs and API clients; the partner area shows team.partner.keys.error.<code>
const REFUSALS: Record<PartnerKeyCode, string> = {
  keys_disabled: "a server admin turned this partner's own keys off: they cannot be changed or used",
  wrong_stage: 'that provider belongs to another stage',
  no_secrets_key: 'this server cannot store keys (SECRETS_KEY is not set)',
  client_not_found: 'this workspace is not a client workspace of this partner',
  clone_on_install_keys: "a cloned voice lives in this server's voice account",
  too_many_tests: 'too many key tests: try again in a few minutes',
  key_unreadable: 'the saved key cannot be read on this server (SECRETS_KEY changed): enter it again',
}
const refuse = (code: PartnerKeyCode) => new Reject(REFUSALS[code], code)

/**
 * A provider's error text with anything that looks like a key masked (`sk-…`, long runs of letters, digits and key
 * punctuation) and cut short: it is stored, shown to the partner's team and emailed, so a key never travels in it.
 */
export function maskFailure(text: string, key?: string): string {
  let out = key && key.length >= 4 ? text.replaceAll(key, '[redacted]') : text
  out = out.replace(/\b(sk|rk|pk|xi|sess|key)[-_][A-Za-z0-9_-]{6,}/gi, '[redacted]')
  out = out.replace(/[A-Za-z0-9_+/=-]{24,}/g, '[redacted]')
  return out.replace(/\s+/g, ' ').trim().slice(0, FAILURE_MAX)
}

type Row = typeof partner_providers.$inferSelect

const rowOf = (stage: PartnerKeyStage, row: Row | undefined): PartnerKeyRow => ({
  stage,
  provider: (row?.provider as ProviderName | undefined) ?? null,
  last4: row?.last4 ?? null,
  status: row?.status ?? null,
  failure: row?.failure ?? null,
  checkedAt: row?.checked_at ?? null,
  updatedAt: row?.updated_at ?? null,
})

const rowsOf = (tx: Pick<Tx, 'select'>, partnerId: string) =>
  tx.select().from(partner_providers).where(eq(partner_providers.partner_id, partnerId))

/** Which pipelines the partner's working keys cover. */
function readyOf(rows: readonly Row[]) {
  const ok = (stage: PartnerKeyStage) => rows.some(r => r.category === stage && r.status === 'ok')
  return { threeStage: ok('stt') && ok('llm') && ok('tts'), realtime: ok('realtime') }
}

async function keysData(tx: Tx, partner: typeof partners.$inferSelect, role: string): Promise<PartnerKeysData> {
  const rows = await rowsOf(tx, partner.id)
  return {
    stages: PARTNER_KEY_STAGES.map(stage =>
      rowOf(
        stage,
        rows.find(r => r.category === stage),
      ),
    ),
    canEdit: role === 'owner' && partner.status !== 'suspended' && !partner.own_keys_disabled_at,
    disabled:
      partner.own_keys_disabled_at && partner.own_keys_disabled_reason
        ? { reason: partner.own_keys_disabled_reason, at: partner.own_keys_disabled_at }
        : null,
    ready: readyOf(rows),
  }
}

/** The owner's write gate: on the team as owner, not suspended (partnerOnTeam), and not turned off by an admin. */
async function ownerWrite(tx: Tx, actor: Actor, partnerId: string) {
  const row = await partnerOnTeam(tx, actor, partnerId, true)
  if (row.partner.own_keys_disabled_at) throw refuse('keys_disabled')
  return row
}

/** The stored key of one stage, decrypted. Null when there is none. Throws Reject when it cannot be read here. */
async function storedKey(tx: Pick<Tx, 'select'>, partnerId: string, stage: PartnerKeyStage) {
  const [row] = await tx
    .select()
    .from(partner_providers)
    .where(and(eq(partner_providers.partner_id, partnerId), eq(partner_providers.category, stage)))
  if (!row) return null
  try {
    return {
      row,
      key: decryptSecret(row.key_encrypted, partnerKeySlot(partnerId, stage, row.provider)),
    }
  } catch (e) {
    if (e instanceof SecretsKeyError) return { row, key: null }
    throw e
  }
}

/** The free test of one partner key (no tokens, no speech): what testProviderSaid says, masked. */
export async function testPartnerKey(
  provider: ProviderName,
  key: string,
  doFetch: typeof fetch = fetch,
): Promise<ProviderTestData> {
  const answer = testAnswer(
    await testProviderSaid(provider, { api_key: { value: key, source: 'app' } }, doFetch, process.env, { free: true }),
  )
  return { ...answer, message: maskFailure(answer.message, key) }
}

/** Stores a test's result on the stage (only while it is still the same key). */
async function storeTest(
  tx: Tx,
  partnerId: string,
  stage: PartnerKeyStage,
  keyEncrypted: string,
  result: ProviderTestData,
  now: string,
) {
  await tx
    .update(partner_providers)
    .set({ status: result.ok ? 'ok' : 'failing', failure: result.ok ? null : result.message, checked_at: now })
    .where(
      and(
        eq(partner_providers.partner_id, partnerId),
        eq(partner_providers.category, stage),
        eq(partner_providers.key_encrypted, keyEncrypted),
      ),
    )
}

/**
 * A stage of the partner's keys failed on a call or in the daily check: `failing` (calls are no longer forecast on
 * it), and its owner is emailed, once a day at most. `provider` must be the stage's stored one: a failure of another
 * provider (the install's) never marks the partner's key.
 */
export async function markPartnerKeyFailing(
  tx: Tx,
  partnerId: string,
  stage: string,
  provider: string,
  message: string,
  now: string,
) {
  if (!(PARTNER_KEY_STAGES as readonly string[]).includes(stage)) return false
  const [row] = await tx
    .select()
    .from(partner_providers)
    .where(and(eq(partner_providers.partner_id, partnerId), eq(partner_providers.category, stage as PartnerKeyStage)))
  if (!row || row.provider !== provider) return false
  const emailNow = !row.failure_emailed_at || Date.parse(now) - Date.parse(row.failure_emailed_at) >= DAY_MS
  await tx
    .update(partner_providers)
    .set({
      status: 'failing',
      failure: maskFailure(message),
      checked_at: now,
      ...(emailNow ? { failure_emailed_at: now } : {}),
    })
    .where(and(eq(partner_providers.partner_id, partnerId), eq(partner_providers.category, row.category)))
  if (emailNow)
    await emailOwner(tx, partnerId, {
      kind: 'failing',
      provider: providerSpec(row.provider as ProviderName).label,
      reason: maskFailure(message),
    })
  return true
}

/** One email to the partner's owner (sent without waiting; never holds up what it is about). */
async function emailOwner(tx: Pick<Tx, 'select'>, partnerId: string, content: Parameters<typeof partnerKeysEmail>[0]) {
  const [owner] = await tx
    .select({ email: user.email })
    .from(partner_members)
    .innerJoin(user, eq(user.id, partner_members.user_id))
    .where(and(eq(partner_members.partner_id, partnerId), eq(partner_members.role, 'owner'), isNull(user.disabledAt)))
  // i18n-ignore: the log label of a failed send, not shown to anyone
  const what = `partner keys email to ${partnerId}`
  if (owner) sendNotice({ to: owner.email, ...partnerKeysEmail(content, WEB_ORIGIN) }, what)
}

// --- Calls -----------------------------------------------------------------------------------------------------------

/** What a call answers with, as usage-levels.ts decides it (assistantChoices). */
export type OwnKeysChoices = {
  pipeline: 'three_stage' | 'realtime'
  voice: { provider: string; model?: string | null }
  voiceId?: string | null
}

/**
 * Whether a call of this workspace runs on its partner's own keys (S7): the client is switched on, its partner
 * approved and not turned off by an instance admin, it uses its own carrier, and every stage of the call's pipeline has
 * a partner key that tested ok; for the three stages the voice is of the partner's voice provider and not a clone in
 * the install's voice account. Never throws (false).
 */
export async function workspaceOwnKeys(tx: Tx, workspaceId: string, choices: OwnKeysChoices): Promise<boolean> {
  try {
    const [row] = await tx
      .select({ on: workspace_settings.partner_keys, partner: partners })
      .from(organization)
      .innerJoin(partners, eq(partners.id, organization.partnerId))
      .innerJoin(workspace_settings, eq(workspace_settings.workspace_id, organization.id))
      .where(eq(organization.id, workspaceId))
    if (!row?.on || row.partner.status !== 'approved' || row.partner.own_keys_disabled_at) return false
    if ((await workspaceCarrier(tx, workspaceId)) === 'default') return false
    const rows = await rowsOf(tx, row.partner.id)
    const ok = (stage: PartnerKeyStage) => rows.find(r => r.category === stage && r.status === 'ok')
    if (choices.pipeline === 'realtime') return !!ok('realtime')
    const tts = ok('tts')
    if (!ok('stt') || !ok('llm') || !tts || tts.provider !== choices.voice.provider) return false
    if (choices.voiceId) {
      const [clone] = await tx
        .select({ id: voice_clones.id })
        .from(voice_clones)
        .where(and(eq(voice_clones.workspace_id, workspaceId), eq(voice_clones.voice_id, choices.voiceId)))
      if (clone) return false
    }
    return true
  } catch (e) {
    console.error(`own keys of workspace ${workspaceId} could not be read; the call runs on the install's keys`, e)
    return false
  }
}

/** The workspace's partner, for a call's own keys. */
async function partnerOfCall(tx: Pick<Tx, 'select'>, callId: string) {
  const [row] = await tx
    .select({ call: calls, partner: partners })
    .from(calls)
    .innerJoin(organization, eq(organization.id, calls.workspace_id))
    .innerJoin(partners, eq(partners.id, organization.partnerId))
    .where(eq(calls.id, callId))
  return row ?? null
}

type AgentEntry = { provider: string; api_key: string }

/**
 * GET /v1/agent/call-provider-config: the partner's working keys for one call that call.start forecast on them and
 * that is still running, in clear, for the voice agent's install token only. Null (404) for any other call: one not on
 * own keys, finished, of a workspace without a partner, of a partner suspended or turned off.
 */
export async function partnerKeysForCall(tx: Pick<Tx, 'select'>, callId: string) {
  const found = await partnerOfCall(tx, callId)
  if (!found?.call.partner_keys || found.call.status === 'completed') return null
  if (found.partner.status !== 'approved' || found.partner.own_keys_disabled_at) return null
  const rows = await rowsOf(tx, found.partner.id)
  const config: Partial<Record<PartnerKeyStage, AgentEntry>> = {}
  for (const row of rows) {
    if (row.status !== 'ok') continue
    config[row.category] = {
      provider: row.provider,
      api_key: decryptSecret(row.key_encrypted, partnerKeySlot(found.partner.id, row.category, row.provider)),
    }
  }
  return config
}

/** Whether a call's report confirms it ran fully on the partner's keys (any pipeline): every stage reported `partner`. */
export function reportConfirmsOwnKeys(sources: KeySources | null | undefined): boolean {
  if (!sources) return false
  const values = Object.values(sources)
  if (!values.length || values.some(v => v !== 'partner' || !KEY_SOURCES.includes(v))) return false
  return (
    sources.realtime === 'partner' ||
    (sources.stt === 'partner' && sources.llm === 'partner' && sources.tts === 'partner')
  )
}

/**
 * call.reportVoiceFailure of a call on the partner's keys: the stage's partner key is marked failing (never the
 * install's provider). True when it was the partner's key. Decided by what served the stage (`source`, the agent's
 * keySources), not by the forecast: a call forecast on own keys that fell back to the install's config reports
 * `install`, and that failure is the install's provider's (security review of #1289/#1290, L-4).
 */
export async function partnerVoiceFailure(
  tx: Tx,
  callId: string,
  failure: { stage: string; provider: string; message: string },
  now: string,
  source: KeySource | undefined,
) {
  if (source !== 'partner') return false
  const found = await partnerOfCall(tx, callId)
  if (!found?.call.partner_keys) return false
  return markPartnerKeyFailing(tx, found.partner.id, failure.stage, failure.provider, failure.message, now)
}

/** Every partner key of a partner: for rotate-secrets-key.ts and the daily check. */
export const allPartnerKeys = (tx: Pick<Tx, 'select'>) => tx.select().from(partner_providers)

/**
 * The daily free check of partner keys (provider-health-check.ts): a `failing` stage that works again goes back to
 * `ok`; an `ok` one that is refused turns `failing` (and its owner is emailed once a day). Not for a suspended partner
 * or one whose own keys an instance admin turned off: no call uses those keys (security review of #1289/#1290, I-3).
 * Never throws.
 */
export async function checkPartnerKeys(
  dbOrTx: typeof db,
  doFetch: typeof fetch = fetch,
  now = new Date().toISOString(),
) {
  const rows = (
    await dbOrTx
      .select({ row: partner_providers })
      .from(partner_providers)
      .innerJoin(partners, eq(partners.id, partner_providers.partner_id))
      .where(and(ne(partners.status, 'suspended'), isNull(partners.own_keys_disabled_at)))
  ).map(r => r.row)
  for (const row of rows) {
    try {
      const key = decryptSecret(row.key_encrypted, partnerKeySlot(row.partner_id, row.category, row.provider))
      const result = await testPartnerKey(row.provider as ProviderName, key, doFetch)
      await dbOrTx.transaction(async tx => {
        if (result.ok) await storeTest(tx, row.partner_id, row.category, row.key_encrypted, result, now)
        else await markPartnerKeyFailing(tx, row.partner_id, row.category, row.provider, result.message, now)
      })
    } catch (e) {
      console.error(`partner key check of ${row.partner_id}/${row.category} failed`, e instanceof Error ? e.message : e)
    }
  }
}

// --- Actions ---------------------------------------------------------------------------------------------------------

/**
 * partnerKeys.test asks the provider outside the transaction (handler-context.ts, Preparer): the caller's team and the
 * key are read here, the result is stored by the handler, only while the stage still holds the same key.
 */
export const partnerKeyPreparers: Record<string, Preparer> = {
  'partnerKeys.test': async ({ actor }, input: { partnerId: string; stage: PartnerKeyStage }) => {
    const stored = await db.transaction(async tx => {
      await ownerWrite(tx, actor, input.partnerId)
      if (!allowTest(input.partnerId)) throw refuse('too_many_tests')
      const stored = await storedKey(tx, input.partnerId, input.stage)
      if (stored && !stored.key) throw refuse('key_unreadable')
      return stored ? { provider: stored.row.provider, keyEncrypted: stored.row.key_encrypted, key: stored.key! } : null
    })
    if (!stored) return { result: null, keyEncrypted: null }
    // Asked after the partner row's lock is let go (security review of #1289/#1290, I-1): up to a provider timeout.
    return {
      keyEncrypted: stored.keyEncrypted,
      result: await testPartnerKey(stored.provider as ProviderName, stored.key),
    }
  },
}

export const partnerKeyHandlers: Record<string, Handler> = {
  'partnerKeys.get': async ({ tx, actor }, input: { partnerId: string }) => {
    const row = await partnerOnTeam(tx, actor, input.partnerId, false)
    return { rows: {}, data: await keysData(tx, row.partner, row.role) }
  },

  'partnerKeys.set': async (
    { tx, actor, now },
    input: { partnerId: string; stage: PartnerKeyStage; provider: ProviderName; apiKey: string },
  ) => {
    // The personal key step-up (run-action.ts answers it first, with the code the page acts on).
    const stepUp = await personalKeyStepUpNeeded(tx, actor)
    if (stepUp) throw new Forbidden(personalKeyStepUpRefusal(stepUp).error)
    const team = await ownerWrite(tx, actor, input.partnerId)
    if (providerSpec(input.provider).category !== input.stage) throw refuse('wrong_stage')
    if (!hasSecretsKey()) throw refuse('no_secrets_key')
    const values = {
      provider: input.provider,
      key_encrypted: encryptSecret(input.apiKey, partnerKeySlot(input.partnerId, input.stage, input.provider)),
      last4: lastFour(input.apiKey),
      status: 'untested' as const,
      failure: null,
      checked_at: null,
      failure_emailed_at: null,
      updated_at: now,
      updated_by: actor.actorId,
    }
    await tx
      .insert(partner_providers)
      .values({ partner_id: input.partnerId, category: input.stage, ...values })
      .onConflictDoUpdate({ target: [partner_providers.partner_id, partner_providers.category], set: values })
    return { rows: {}, data: await keysData(tx, team.partner, team.role) }
  },

  'partnerKeys.clear': async ({ tx, actor }, input: { partnerId: string; stage: PartnerKeyStage }) => {
    const team = await ownerWrite(tx, actor, input.partnerId)
    await tx
      .delete(partner_providers)
      .where(and(eq(partner_providers.partner_id, input.partnerId), eq(partner_providers.category, input.stage)))
    return { rows: {}, data: await keysData(tx, team.partner, team.role) }
  },

  'partnerKeys.test': async ({ tx, actor, now, prepared }, input: { partnerId: string; stage: PartnerKeyStage }) => {
    const team = await ownerWrite(tx, actor, input.partnerId)
    const { result, keyEncrypted } = prepared as { result: ProviderTestData | null; keyEncrypted: string | null }
    if (result && keyEncrypted) await storeTest(tx, input.partnerId, input.stage, keyEncrypted, result, now)
    return { rows: {}, data: { result, keys: await keysData(tx, team.partner, team.role) } }
  },

  'partner.setClientOwnKeys': async ({ tx, actor }, input: { partnerId: string; workspaceId: string; on: boolean }) => {
    const team = await ownerWrite(tx, actor, input.partnerId)
    const [client] = await tx
      .select({ id: organization.id, billingAccountId: organization.billingAccountId })
      .from(organization)
      .where(and(eq(organization.id, input.workspaceId), eq(organization.partnerId, input.partnerId)))
    if (!client) throw refuse('client_not_found')
    // On a billed install only a client on the partner bill: own keys change what the partner pays.
    if (team.partner.billing_account_id && client.billingAccountId !== team.partner.billing_account_id)
      throw refuse('client_not_found')
    const changed = await tx
      .update(workspace_settings)
      .set({ partner_keys: input.on })
      .where(eq(workspace_settings.workspace_id, client.id))
      .returning({ id: workspace_settings.workspace_id })
    if (!changed.length)
      await tx
        .insert(workspace_settings)
        .values({ workspace_id: client.id, timezone: DEFAULT_TIME_ZONE, partner_keys: input.on })
    return { rows: {}, data: { workspaceId: client.id, on: input.on } }
  },

  'partnerKeys.adminDisable': async ({ tx, now, onCommit }, input: { partnerId: string; reason: string }) => {
    const [partner] = await tx
      .update(partners)
      .set({ own_keys_disabled_reason: input.reason, own_keys_disabled_at: now, updated_at: now })
      .where(eq(partners.id, input.partnerId))
      .returning()
    if (!partner) throw new Forbidden(NOT_ON_PARTNER_TEAM)
    onCommit?.(() => emailOwner(db, partner.id, { kind: 'disabled', reason: input.reason }))
    return { rows: {}, data: { partnerId: partner.id } }
  },

  'partnerKeys.adminEnable': async ({ tx, now }, input: { partnerId: string }) => {
    const [partner] = await tx
      .update(partners)
      .set({ own_keys_disabled_reason: null, own_keys_disabled_at: null, updated_at: now })
      .where(eq(partners.id, input.partnerId))
      .returning()
    if (!partner) throw new Forbidden(NOT_ON_PARTNER_TEAM)
    return { rows: {}, data: { partnerId: partner.id } }
  },
}
