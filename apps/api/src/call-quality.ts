// Call quality (decisions.md 2026-11-17): the install's settings for Standard, Premium and Ultra (Server admin ›
// Providers › Call quality), kept in instance_settings `call_quality`: whether Premium and Ultra can be picked, the
// level new assistants start on, and per level the models an assistant without its own pick uses. A missing row or
// entry reads as CALL_QUALITY_INSTALL_DEFAULT with the default models (CALL_QUALITY_DEFAULTS); Ultra's realtime model
// defaults to what the install already uses, speech recognition to its provider's first model (STT_MODELS).
import {
  CALL_QUALITIES,
  CALL_QUALITY_INSTALL_DEFAULT,
  CALL_QUALITY_LABELS,
  type CallQuality,
  type CallQualitySettings,
  DEFAULT_VOICE_MODELS,
  type LlmProvider,
  levelLanguageModel,
  levelRealtimeModel,
  levelSttModel,
  levelVoiceModel,
  llmEndpoints,
} from '@linedesk/actions'
import { assistants, instance_settings, type Tx } from '@linedesk/db'
import type { Assistant } from '@linedesk/db/types'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { lockAssistantVersionsOf, recordVersion } from './assistant-versions.ts'
import { Reject } from './handler-context.ts'
import { activeProvider, setUpProviders } from './provider-settings.ts'

export const CALL_QUALITY_KEY = 'call_quality'

const levelDefaults = z
  .object({
    llm: z.string().trim().min(1).optional(),
    voice: z.record(z.string(), z.string().trim().min(1)).optional(),
    stt: z.string().trim().min(1).optional(),
  })
  .strip()
/** The stored settings; anything it does not know is dropped, anything missing reads as the install default. */
export const callQualitySettingsSchema = z.object({
  premium: z.boolean(),
  ultra: z.boolean(),
  default: z.enum(CALL_QUALITIES),
  models: z.object({
    standard: levelDefaults,
    premium: levelDefaults,
    ultra: z.object({ realtime: z.string().trim().min(1).optional() }).strip(),
  }),
})

/** The install's call quality settings as stored; a missing or unreadable row: the install default. Never throws. */
export async function callQualitySettings(tx: Pick<Tx, 'select'>): Promise<CallQualitySettings> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, CALL_QUALITY_KEY))
  if (!row) return CALL_QUALITY_INSTALL_DEFAULT
  try {
    const parsed = callQualitySettingsSchema.safeParse(JSON.parse(row.value))
    if (parsed.success) return parsed.data
  } catch {}
  console.error('call quality: the stored settings cannot be read, the install default applies')
  return CALL_QUALITY_INSTALL_DEFAULT
}

/** Stores the install's call quality settings. */
export async function saveCallQualitySettings(tx: Tx, settings: CallQualitySettings, actorId: string, now: string) {
  const value = JSON.stringify(callQualitySettingsSchema.parse(settings))
  await tx
    .insert(instance_settings)
    .values({ key: CALL_QUALITY_KEY, value, updated_at: now, updated_by: actorId })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actorId } })
}

/** Whether a realtime model is connected (Ultra needs one). Never throws. */
export const realtimeSetUp = async (tx: Tx) => (await activeProvider(tx, 'realtime').catch(() => null)) !== null

/**
 * Which levels can be picked and answer calls: Standard always, Premium while the server admin has it on, Ultra while
 * it is on and a realtime model is connected.
 */
export async function enabledLevels(tx: Tx, settings?: CallQualitySettings): Promise<Record<CallQuality, boolean>> {
  const s = settings ?? (await callQualitySettings(tx))
  return { standard: true, premium: s.premium, ultra: s.ultra && (await realtimeSetUp(tx)) }
}

/** The level a new assistant starts on: the install's default while it is enabled, else Standard. */
export async function newAssistantLevel(tx: Tx): Promise<CallQuality> {
  const settings = await callQualitySettings(tx)
  return (await enabledLevels(tx, settings))[settings.default] ? settings.default : 'standard'
}

/**
 * What "Default" stands for on each level, for the providers set up: the language model of the install's language-model
 * provider, the voice model per voice provider, the speech recognition model of the install's speech recognition
 * provider, and Ultra's realtime model. `billed` false (no prices): a provider
 * with no model of the level in the lists uses its own default, so a self-hosted install always answers.
 */
export async function levelDefaultModels(tx: Tx, settings: CallQualitySettings, { billed }: { billed: boolean }) {
  const llm = await activeProvider(tx, 'llm').catch(() => null)
  const llmProvider = (llm?.provider ?? null) as LlmProvider | null
  const voices = await setUpProviders(tx, 'tts').catch(() => [])
  const realtime = await activeProvider(tx, 'realtime').catch(() => null)
  const stt = await activeProvider(tx, 'stt').catch(() => null)
  const sttProvider = stt?.provider ?? null
  const threeStage = (level: 'standard' | 'premium') => ({
    llm: llmProvider
      ? (levelLanguageModel(llmProvider, level, settings.models[level].llm) ??
        (billed ? null : (llmEndpoints[llmProvider].models[0] ?? null)))
      : null,
    voice: Object.fromEntries(
      voices.flatMap(v => {
        const id =
          levelVoiceModel(v.provider, level, settings.models[level].voice?.[v.provider]) ??
          (billed ? null : (DEFAULT_VOICE_MODELS[v.provider] ?? ''))
        return id === null ? [] : [[v.provider, id]]
      }),
    ) as Record<string, string>,
    stt: sttProvider ? levelSttModel(sttProvider, settings.models[level].stt) : null,
  })
  return {
    llmProvider,
    sttProvider,
    standard: threeStage('standard'),
    premium: threeStage('premium'),
    ultra: {
      realtime: realtime ? levelRealtimeModel(settings.models.ultra.realtime) : null,
    },
  }
}
export type LevelDefaultModels = Awaited<ReturnType<typeof levelDefaultModels>>

/**
 * The assistant on Standard: its picks that are not Standard dropped (they follow the server's Standard defaults).
 * What a level turned off and a payer change leave.
 */
export function onStandard<
  A extends Pick<Assistant, 'voice' | 'llm_model' | 'call_quality'> & { realtime_model?: string | null },
>(a: A): A {
  const { model: _model, ...voice } = a.voice
  return { ...a, call_quality: 'standard', voice, llm_model: null, realtime_model: null }
}

/**
 * Moves assistants on one of `levels` to Standard (onStandard), each with a version by `by`: in one workspace
 * (`workspaceId`), or in every workspace (null: a server admin turned a level off). Takes the version locks of the
 * assistants it moves first (by id), as every save does, so a save running at the same time finishes before or starts
 * after. Returns the rows it changed.
 */
export async function moveToStandard(tx: Tx, workspaceId: string | null, levels: CallQuality[], by: string) {
  const paid = levels.filter(l => l !== 'standard')
  if (!paid.length) return []
  const where = and(
    inArray(assistants.call_quality, paid),
    workspaceId ? eq(assistants.workspace_id, workspaceId) : undefined,
  )
  const found = await tx.select({ workspace_id: assistants.workspace_id }).from(assistants).where(where)
  for (const ws of [...new Set(found.map(r => r.workspace_id))].sort()) await lockAssistantVersionsOf(tx, ws)
  const rows = await tx.select().from(assistants).where(where).orderBy(assistants.id).for('update')
  const changed: Assistant[] = []
  for (const row of rows) {
    const { call_quality, voice, llm_model, realtime_model } = onStandard(row)
    const [updated] = await tx
      .update(assistants)
      .set({ call_quality, voice, llm_model, realtime_model })
      .where(eq(assistants.id, row.id))
      .returning()
    await recordVersion(tx, row.workspace_id, row.id, { by })
    changed.push(updated!)
  }
  return changed
}

/** How long after a level was turned off its Undo moves the assistants back (decisions.md 2026-11-18, review L-2). */
export const UNDO_TURN_OFF_MS = 24 * 60 * 60 * 1000
/** instance_settings key of the last turn-off of `level`: when, and the assistants it moved to Standard. */
const turnOffKey = (level: 'premium' | 'ultra') => `${CALL_QUALITY_KEY}.turned_off.${level}`
/**
 * `payerChanged`: the moved assistants whose workspace has had another payer since (forgetTurnOffsIn): their Undo
 * would be a raise the new payer never chose (LIN-438), so it leaves them on Standard.
 */
const turnOffSchema = z.object({
  at: z.string(),
  assistantIds: z.array(z.string()),
  payerChanged: z.array(z.string()).default([]),
})

/** Keeps what turning `level` off just did, for its Undo: replaces the record of an earlier turn-off. */
export async function recordTurnOff(
  tx: Tx,
  level: 'premium' | 'ultra',
  assistantIds: string[],
  actorId: string,
  now: string,
) {
  const value = JSON.stringify({ at: now, assistantIds })
  await tx
    .insert(instance_settings)
    .values({ key: turnOffKey(level), value, updated_at: now, updated_by: actorId })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actorId } })
}

/**
 * Before an Undo of a level turned off: refused unless `level` was turned off at most 24 hours ago and every listed
 * assistant is one that turn-off moved (review L-2: never a raise of assistants it did not move, or later). The record
 * is used up: one Undo per turn-off. Takes the version locks of the listed assistants' workspaces first, then the
 * record, the order of a payer change (forgetTurnOffsIn), so the two never deadlock; two Undos of the same turn-off
 * cannot both pass. Returns the assistants the Undo moves back: those listed, without the ones whose workspace has had
 * another payer since the turn-off (LIN-438).
 */
export async function takeTurnOff(tx: Tx, level: 'premium' | 'ultra', assistantIds: string[], now: string) {
  await lockVersionsOfAssistants(tx, assistantIds)
  const [row] = await tx
    .select()
    .from(instance_settings)
    .where(eq(instance_settings.key, turnOffKey(level)))
    .for('update')
  let record: z.infer<typeof turnOffSchema> | null = null
  try {
    record = row ? turnOffSchema.parse(JSON.parse(row.value)) : null
  } catch {}
  const label = { level: CALL_QUALITY_LABELS[level] }
  const age = record ? Date.parse(now) - Date.parse(record.at) : Number.NaN
  if (!record || !(age >= 0 && age <= UNDO_TURN_OFF_MS)) throw Reject.t('server.api.callQualityUndoExpired', label)
  const moved = new Set(record.assistantIds)
  if (assistantIds.some(id => !moved.has(id))) throw Reject.t('server.api.callQualityUndoNotMoved', label)
  await tx.delete(instance_settings).where(eq(instance_settings.key, turnOffKey(level)))
  const payerChanged = new Set(record.payerChanged)
  return assistantIds.filter(id => !payerChanged.has(id))
}

/** The version locks of every workspace these assistants are in, in the order of the workspace ids. */
async function lockVersionsOfAssistants(tx: Tx, assistantIds: string[]) {
  if (!assistantIds.length) return
  const found = await tx
    .selectDistinct({ workspace_id: assistants.workspace_id })
    .from(assistants)
    .where(inArray(assistants.id, assistantIds))
  for (const ws of found.map(r => r.workspace_id).sort()) await lockAssistantVersionsOf(tx, ws)
}

/**
 * A payer change of these workspaces (billPayerChanged, LIN-438): their assistants a level turned off had moved are
 * marked in that turn-off's record, so its Undo leaves them on Standard; the new payer never chose Premium or Ultra.
 * Called with the workspaces' version locks held (lockForPayerChange), before the record's lock, as takeTurnOff does.
 */
export async function forgetTurnOffsIn(tx: Tx, workspaceIds: string[]) {
  if (!workspaceIds.length) return
  for (const level of ['premium', 'ultra'] as const) {
    const [row] = await tx
      .select()
      .from(instance_settings)
      .where(eq(instance_settings.key, turnOffKey(level)))
      .for('update')
    if (!row) continue
    let record: z.infer<typeof turnOffSchema>
    try {
      record = turnOffSchema.parse(JSON.parse(row.value))
    } catch {
      continue // Unreadable: its Undo is refused anyway (takeTurnOff).
    }
    const marked = new Set(record.payerChanged)
    const open = record.assistantIds.filter(id => !marked.has(id))
    if (!open.length) continue
    const inWorkspaces = await tx
      .select({ id: assistants.id })
      .from(assistants)
      .where(and(inArray(assistants.id, open), inArray(assistants.workspace_id, workspaceIds)))
    if (!inWorkspaces.length) continue
    const value = JSON.stringify({ ...record, payerChanged: [...marked, ...inWorkspaces.map(r => r.id)] })
    await tx
      .update(instance_settings)
      .set({ value })
      .where(eq(instance_settings.key, turnOffKey(level)))
  }
}

/**
 * Undo of a level turned off (Server admin › Providers › Call quality): the assistants it moved go back to `level`,
 * only those still on Standard, each with a version by `by`. Their own model picks were dropped by the move and stay
 * on the defaults. Returns the rows it changed.
 */
export async function moveBackToLevel(tx: Tx, assistantIds: string[], level: CallQuality, by: string) {
  if (!assistantIds.length || level === 'standard') return []
  const where = and(inArray(assistants.id, assistantIds), eq(assistants.call_quality, 'standard'))
  const found = await tx.select({ workspace_id: assistants.workspace_id }).from(assistants).where(where)
  for (const ws of [...new Set(found.map(r => r.workspace_id))].sort()) await lockAssistantVersionsOf(tx, ws)
  const rows = await tx.update(assistants).set({ call_quality: level }).where(where).returning()
  for (const row of rows) await recordVersion(tx, row.workspace_id, row.id, { by })
  return rows
}
