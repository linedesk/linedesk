// Usage levels on Linedesk Cloud (packages/actions/src/usage-level.ts, decisions.md 2026-11-16): which voice and
// language model a workspace's calls use, the level that makes (Standard 5¢, Premium 10¢ a minute), and the checks.
// A call answered by a realtime model is Ultra (20¢ a minute), which needs the owner's Allow Ultra: without it the call
// falls back to the three stages.
// Levels apply only while this install bills usage (billingState: billing on with usable Stripe keys); a self-hosted
// install uses every option, with no levels and no checks.
import {
  DEFAULT_VOICE_MODELS,
  type LevelChoice,
  languageModelFor,
  languageModelLevel,
  languageModelsOf,
  levelAllowed,
  llmEndpoints,
  type LlmProvider,
  pipelineChoiceUnder,
  pipelineFor,
  REALTIME_MODEL_LEVELS,
  realtimeModelFor,
  realtimeModelLevel,
  type SpeakingVoice,
  USAGE_CENTS_PER_MINUTE,
  type UsageLevel,
  type UsageLevelInput,
  type UsageLevelOptions,
  usageLevel,
  usageLevelProblem,
  voiceModelFor,
  voiceModelLevel,
  voiceModelsOf,
  type VoicePipeline,
} from '@linedesk/actions'
import { assistants, type Tx, workspace_settings } from '@linedesk/db'
import type { Assistant } from '@linedesk/db/types'
import { and, eq } from 'drizzle-orm'
import { recordVersion } from './assistant-versions.ts'
import { billingState } from './billing-settings.ts'
import { brandName } from './branding.ts'
import type { Actor } from './context.ts'
import { Forbidden, Reject } from './handler-context.ts'
import { activeProvider, pipelinesSetUp, setUpProviders, voicePipelinePolicy } from './provider-settings.ts'

/** Whether this install bills usage (Linedesk Cloud), so voices and models have a level. Never throws. */
export async function usageLevelsBilled(tx: Tx): Promise<boolean> {
  return (await billingState(tx).catch(() => null))?.inEffect === 'stripe'
}

/**
 * Whether every part of the workspace's calls runs on its own provider keys. Per-workspace speech, model and voice
 * keys are not built yet (docs/billing.md: own keys), so every Cloud call runs on the install's keys: false.
 */
export async function workspaceOwnKeys(_tx: Tx, _workspaceId: string): Promise<boolean> {
  return false
}

/**
 * The owner's "Allow Premium" (workspace_settings.allow_premium; no row: off). `lock`: read FOR SHARE, so a save
 * checked against it and the owner turning it off run one after the other (the move back to Standard sees the save).
 */
export async function allowPremiumOf(tx: Tx, workspaceId: string, { lock = false } = {}): Promise<boolean> {
  const query = tx
    .select({ on: workspace_settings.allow_premium })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  const [row] = lock ? await query.for('share') : await query
  return row?.on ?? false
}

/** The owner's "Allow Ultra" (workspace_settings.allow_ultra; no row: off); `lock` as for allowPremiumOf. */
export async function allowUltraOf(tx: Tx, workspaceId: string, { lock = false } = {}): Promise<boolean> {
  const query = tx
    .select({ on: workspace_settings.allow_ultra })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  const [row] = lock ? await query.for('share') : await query
  return row?.on ?? false
}

/** What a workspace may use on Linedesk Cloud: own keys, Allow Premium, Allow Ultra (one read of the settings row). */
async function workspaceFlags(tx: Tx, workspaceId: string, { lock = false } = {}) {
  const query = tx
    .select({ premium: workspace_settings.allow_premium, ultra: workspace_settings.allow_ultra })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  const [row] = lock ? await query.for('share') : await query
  return {
    ownKeys: await workspaceOwnKeys(tx, workspaceId),
    allowPremium: row?.premium ?? false,
    allowUltra: row?.ultra ?? false,
  }
}

/** An ALERT line in the API's log: something on Linedesk Cloud runs on what it may not, and was moved to Standard. */
export const alert = (line: string) => console.error(`ALERT usage level: ${line}`)
const alerted = new Set<string>()
/** The same ALERT once per process (the install's defaults are read for every call). */
const alertOnce = (line: string) => {
  if (alerted.has(line)) return
  alerted.add(line)
  alert(line)
}

/**
 * The install's voice model for a voice provider (TTS_MODEL, Server admin › Providers; else the provider's default).
 * On Linedesk Cloud only a Standard one (provider-settings refuses saving another): one set elsewhere (the
 * environment) is replaced by the provider's Standard default, with an ALERT.
 */
export function installVoiceModel(provider: string, configured: string | null | undefined, billed: boolean) {
  const id = configured?.trim() || DEFAULT_VOICE_MODELS[provider] || ''
  if (!billed || voiceModelLevel(provider, id) === 'standard') return id
  const standard = standardVoiceModelOf(provider)
  alertOnce(`the install's voice model "${id}" (${provider}) is not Standard: calls use ${standard ? `"${standard}"` : 'none (not answered)'}`)
  return standard ?? id
}

/**
 * The install's language model (the first of LLM_MODEL's list, else the provider's); on Linedesk Cloud only a Standard
 * one. A fallback after it that is not Standard is named in an ALERT too: the agent drops it on a Standard call
 * (standardFallbacks, apps/agent/src/config.ts).
 */
export function installLanguageModel(provider: LlmProvider, configured: string | null | undefined, billed: boolean) {
  const id = firstModel(configured, provider)
  if (billed)
    for (const fallback of modelsOf(configured, provider).slice(1).filter(m => languageModelLevel(provider, m) !== 'standard'))
      alertOnce(`the install's fallback language model "${fallback}" (${provider}) is not Standard: Standard calls never use it`)
  if (!billed || languageModelLevel(provider, id) === 'standard') return id
  const standard = standardLanguageModelOf(provider)
  alertOnce(`the install's language model "${id}" (${provider}) is not Standard: calls use ${standard ? `"${standard}"` : 'none (not answered)'}`)
  return standard ?? id
}

/** The provider's default voice model when it is Standard, else its first Standard one; null: it has none. */
export const standardVoiceModelOf = (provider: string): string | null => {
  const preferred = DEFAULT_VOICE_MODELS[provider]
  if (preferred && voiceModelLevel(provider, preferred) === 'standard') return preferred
  return voiceModelsOf(provider).find(m => m.level === 'standard')?.model ?? null
}
/** The provider's default language model when it is Standard, else its first Standard one; null: it has none. */
export const standardLanguageModelOf = (provider: LlmProvider): string | null => {
  const preferred = llmEndpoints[provider].models[0]
  if (preferred && languageModelLevel(provider, preferred) === 'standard') return preferred
  return languageModelsOf(provider).find(m => m.level === 'standard')?.id ?? null
}

/**
 * On Linedesk Cloud, refuses making a voice or language model the install's default when it is not Standard (Server
 * admin › Providers: its model field, or picking the provider). Nothing on an install that does not bill usage.
 */
export async function refuseNonStandardDefault(tx: Tx, provider: string, model: string | null | undefined) {
  if (!(await usageLevelsBilled(tx))) return
  if (provider in llmEndpoints) {
    // Every model of the "model, fallback, ..." list: a fallback answers turns too (OpenRouter sends the list).
    const id = modelsOf(model, provider as LlmProvider).find(m => languageModelLevel(provider, m) !== 'standard')
    if (id)
      throw new Reject(
        `${id} is not a Standard language model: on ${brandName()} Cloud the server's default must be one (${languageModelsOf(provider)
          .filter(m => m.level === 'standard')
          .map(m => m.id)
          .join(', ') || 'this provider has none'})`,
      )
    return
  }
  if (voiceModelsOf(provider).length || DEFAULT_VOICE_MODELS[provider]) {
    const id = model?.trim() || DEFAULT_VOICE_MODELS[provider] || ''
    if (voiceModelLevel(provider, id) !== 'standard')
      throw new Reject(
        `${id || 'No model'} is not a Standard voice model: on ${brandName()} Cloud the server's default must be one (${voiceModelsOf(provider)
          .filter(m => m.level === 'standard')
          .map(m => m.model)
          .join(', ') || 'this provider has none'})`,
      )
  }
}

/** At start: an ALERT for each default of the install (the environment included) that is not Standard on Cloud. */
export async function alertNonStandardDefaults(tx: Tx) {
  const billed = await usageLevelsBilled(tx)
  if (!billed) return
  for (const voice of await setUpProviders(tx, 'tts').catch(() => []))
    installVoiceModel(voice.provider, voice.config.model?.value, billed)
  const llm = await activeProvider(tx, 'llm').catch(() => null)
  if (llm) installLanguageModel(llm.provider as LlmProvider, llm.config.model?.value, billed)
}

type Choices = Pick<UsageLevelInput, 'voice' | 'model'> & { pipeline: VoicePipeline }
type AssistantChoices = Pick<Assistant, 'voice' | 'llm_model' | 'voice_pipeline'> & {
  id?: string
  realtime_model?: string | null
}

/** The models of a "model, fallback, ..." list, or the provider's default alone. */
const modelsOf = (list: string | null | undefined, provider: LlmProvider) => {
  const models = (list ?? '').split(',').map(m => m.trim()).filter(Boolean)
  return models.length ? models : [llmEndpoints[provider].models[0]!]
}
/** The first model of a "model, fallback" list, or the provider's default. */
const firstModel = (list: string | null | undefined, provider: LlmProvider) => modelsOf(list, provider)[0]!

/** The realtime model the install answers with (REALTIME_MODEL; the agent's default otherwise). */
const REALTIME_DEFAULT_MODEL = 'gpt-realtime'
/** The install's realtime model: REALTIME_MODEL, else the agent's default. */
const installRealtimeModel = (configured: string | null | undefined) => configured?.trim() || REALTIME_DEFAULT_MODEL

/**
 * What an assistant's calls use, as the agent picks it: the pipeline (the assistant's choice under the instance admin's
 * policy, the other one when that is not set up; on Linedesk Cloud the three stages when it chose none, a realtime
 * model only when it picked one; `pipeline` overrides it); for the three stages its voice provider (its own when that
 * one has a key, else the install's) with the voice model (voiceModelFor) and the install's language-model provider with
 * the model (languageModelFor). A realtime model answering passes that model for both. null when nothing is set up to
 * answer that way.
 */
export async function assistantChoices(
  tx: Tx,
  assistant: AssistantChoices,
  { billed, pipeline: forced }: { billed: boolean; pipeline?: VoicePipeline },
): Promise<Choices | null> {
  const setUp = await pipelinesSetUp(tx)
  const choice = pipelineChoiceUnder(await voicePipelinePolicy(tx), assistant.voice_pipeline)
  const pipeline = forced ?? pipelineFor(choice ?? (billed ? 'three_stage' : null), setUp)
  if (!setUp[pipeline]) return null
  if (pipeline === 'realtime') {
    const realtime = await activeProvider(tx, 'realtime').catch(() => null)
    if (!realtime) return null
    const model = {
      provider: realtime.provider,
      model: realtimeModelFor(assistant.realtime_model, installRealtimeModel(realtime.config.model?.value)),
    }
    return { voice: model, model, pipeline }
  }
  const llm = await activeProvider(tx, 'llm').catch(() => null)
  const tts = await activeProvider(tx, 'tts').catch(() => null)
  if (!llm || !tts) return null
  const voices = await setUpProviders(tx, 'tts').catch(() => [])
  const own = assistant.voice.voice_id ? voices.find(v => v.provider === assistant.voice.provider) : undefined
  const voice = own ?? tts
  const llmProvider = llm.provider as LlmProvider
  return {
    voice: {
      provider: voice.provider,
      model: voiceModelFor(
        voice.provider,
        assistant.voice.provider === voice.provider ? assistant.voice.model : undefined,
        installVoiceModel(voice.provider, voice.config.model?.value, billed),
      ),
    },
    model: {
      provider: llmProvider,
      model: languageModelFor(
        llmProvider,
        assistant.llm_model,
        installLanguageModel(llmProvider, llm.config.model?.value, billed),
      ),
    },
    pipeline,
  }
}

/**
 * The level of an assistant's calls in a workspace, as call start decides it (assistantForCall): `standard`, `premium`
 * or `own_keys`; `not_allowed` when even the Standard defaults are not (nothing Standard set up). null on an install
 * that does not bill usage.
 */
export async function assistantUsageLevel(
  tx: Tx,
  workspaceId: string,
  assistant: AssistantChoices,
): Promise<UsageLevel | null> {
  return (await assistantForCall(tx, workspaceId, assistant, () => {})).level
}

/** The refusal of assistant.update for choices a Cloud workspace may not use (the web app never offers them). */
export const PREMIUM_NOT_ALLOWED =
  'Premium voices and models are not allowed in this workspace: the owner can turn on Allow Premium in Settings, or pick a Standard one'
export const OWN_KEYS_ONLY =
  'That voice or model is available only with your own provider keys: pick a Standard or Premium one'
export const ULTRA_NOT_ALLOWED =
  'Ultra (answering with a realtime model) is not allowed in this workspace: the owner can turn on Allow Ultra in Settings, or pick speech to text, language model and voice'

/**
 * On Linedesk Cloud: refuses an assistant's voice and model the workspace may not use (Premium without Allow
 * Premium, a realtime model without Allow Ultra, an option in neither list without own keys). Nothing on an install
 * that does not bill usage. Checked only when a save changes the voice, the model or the pipeline, so other changes
 * never fail over the install's own defaults. A realtime model the assistant did not pick in this save (the admin's
 * policy, a pick from before) is not refused: its calls fall back to the three stages (assistantForCall), which are
 * checked instead.
 */
export async function checkAssistantLevel(
  tx: Tx,
  workspaceId: string,
  assistant: AssistantChoices,
  { picksRealtime }: { picksRealtime: boolean },
) {
  if (!(await usageLevelsBilled(tx))) return
  let choices = await assistantChoices(tx, assistant, { billed: true })
  if (choices?.pipeline === 'realtime' && !picksRealtime)
    choices = await assistantChoices(tx, assistant, { billed: true, pipeline: 'three_stage' })
  if (!choices) return
  const problem = usageLevelProblem({ ...choices, ...(await workspaceFlags(tx, workspaceId, { lock: true })) })
  if (problem === 'premiumNotAllowed') throw new Reject(PREMIUM_NOT_ALLOWED)
  if (problem === 'ultraNotAllowed') throw new Reject(ULTRA_NOT_ALLOWED)
  if (problem === 'ownKeysOnly') throw new Reject(OWN_KEYS_ONLY)
}

/** The assistant's choices back on the install's defaults: the voice model and the language model it picked dropped. */
export const onStandardDefaults = <A extends Pick<Assistant, 'voice' | 'llm_model'>>(a: A): A => {
  const { model: _model, ...voice } = a.voice
  return { ...a, voice, llm_model: null }
}

/**
 * The assistant as the agent should answer with it on Linedesk Cloud: the voice model and language model that were
 * checked, named on it (the agent would otherwise use the install's own, which may not be Standard). A voice of a
 * provider the call does not use is replaced by that provider's default voice, as the agent does.
 */
function withCheckedModels<A extends AssistantChoices>(a: A, c: Choices): A {
  if (c.pipeline === 'realtime') return { ...a, realtime_model: c.model.model }
  const voice =
    c.voice.provider === a.voice.provider
      ? { ...a.voice, model: c.voice.model }
      : { ...a.voice, provider: c.voice.provider, voice_id: '', model: c.voice.model }
  return { ...a, voice: voice as A['voice'], llm_model: c.model.model }
}

/**
 * The assistant a call starts with on Linedesk Cloud, and the level it is priced at; decided once, here. When the
 * workspace may use its choices: as it is, with the checked models named. Otherwise (Allow Premium turned off, a list
 * changed since it was saved, a realtime model without Allow Ultra) the call falls back to the install's Standard
 * defaults on the three stages, with one ALERT line: no call runs on a level the workspace did not allow, or without a
 * price. When even that is not allowed (nothing Standard set up), the level stays `not_allowed` and the agent does not
 * answer (the call is filed as missed). `pipeline`: what the agent must answer with (null: not billed, as before).
 */
export async function assistantForCall<A extends AssistantChoices>(
  tx: Tx,
  workspaceId: string,
  assistant: A,
  log: (line: string) => void = alert,
): Promise<{ assistant: A; level: UsageLevel | null; pipeline: VoicePipeline | null }> {
  if (!(await usageLevelsBilled(tx))) return { assistant, level: null, pipeline: null }
  const flags = await workspaceFlags(tx, workspaceId)
  const choices = await assistantChoices(tx, assistant, { billed: true })
  const level = choices ? usageLevel({ ...choices, ...flags }) : 'not_allowed'
  if (choices && level !== 'not_allowed')
    return { assistant: withCheckedModels(assistant, choices), level, pipeline: choices.pipeline }
  const fallback = { ...onStandardDefaults(assistant), voice_pipeline: 'three_stage' as const }
  const standard = await assistantChoices(tx, fallback, { billed: true, pipeline: 'three_stage' })
  const fallbackLevel = standard ? usageLevel({ ...standard, ...flags }) : 'not_allowed'
  const what = choices
    ? `${choices.pipeline === 'realtime' ? 'realtime model' : 'voice and model'} ${describeChoices(choices)}`
    : 'nothing set up to answer'
  log(
    `assistant ${assistant.id ?? '?'} of workspace ${workspaceId} is not allowed (${what}): ${
      fallbackLevel === 'not_allowed'
        ? 'no Standard voice and model is set up either, the call is not answered'
        : `the call falls back to the Standard defaults (${describeChoices(standard!)})`
    }`,
  )
  if (!standard || fallbackLevel === 'not_allowed') return { assistant: fallback, level: 'not_allowed', pipeline: 'three_stage' }
  return { assistant: withCheckedModels(fallback, standard), level: fallbackLevel, pipeline: 'three_stage' }
}

const describeChoices = (c: Choices) =>
  c.pipeline === 'realtime' ? c.model.model : `${c.voice.provider}/${c.voice.model}, ${c.model.provider}/${c.model.model}`

/**
 * The voices a call of the assistant speaks with, for the language checks: on the three stages its one voice
 * (provider and voice model, as the call resolves them); a realtime model: null (every voice the install has).
 */
export async function assistantVoiceOf(tx: Tx, assistant: AssistantChoices): Promise<SpeakingVoice | null> {
  const billed = await usageLevelsBilled(tx)
  const choices = await assistantChoices(tx, assistant, { billed })
  return choices?.pipeline === 'three_stage' ? choices.voice : null
}

/**
 * Turning Allow Premium off: every assistant of the workspace on a Premium voice model or language model goes back to
 * the install's defaults (Standard), with a version by `by` (the owner). Returns the rows it changed.
 */
export async function assistantsBackToStandard(tx: Tx, workspaceId: string, by: string) {
  const rows = await tx.select().from(assistants).where(eq(assistants.workspace_id, workspaceId)).for('update')
  const changed = []
  for (const row of rows) {
    const premiumVoice = !!row.voice.model && voiceModelLevel(row.voice.provider, row.voice.model) === 'premium'
    const premiumModel = !!row.llm_model && LANGUAGE_PREMIUM(row.llm_model)
    if (!premiumVoice && !premiumModel) continue
    const set = {
      ...(premiumVoice ? { voice: onStandardDefaults(row).voice } : {}),
      ...(premiumModel ? { llm_model: null } : {}),
    }
    const [updated] = await tx
      .update(assistants)
      .set(set)
      .where(and(eq(assistants.id, row.id), eq(assistants.workspace_id, workspaceId)))
      .returning()
    await recordVersion(tx, workspaceId, row.id, { by })
    changed.push(updated!)
  }
  return changed
}

/**
 * Turning Allow Ultra off: every assistant of the workspace that answers with a realtime model goes back to the three
 * stages and the install's realtime model, with a version by `by` (the owner). Returns the rows it changed.
 */
export async function assistantsOffUltra(tx: Tx, workspaceId: string, by: string) {
  const rows = await tx.select().from(assistants).where(eq(assistants.workspace_id, workspaceId)).for('update')
  const changed = []
  for (const row of rows) {
    if (row.voice_pipeline !== 'realtime' && !row.realtime_model) continue
    const [updated] = await tx
      .update(assistants)
      .set({ voice_pipeline: row.voice_pipeline === 'realtime' ? 'three_stage' : row.voice_pipeline, realtime_model: null })
      .where(and(eq(assistants.id, row.id), eq(assistants.workspace_id, workspaceId)))
      .returning()
    await recordVersion(tx, workspaceId, row.id, { by })
    changed.push(updated!)
  }
  return changed
}

/** Whether a stored language-model id is Premium at any provider. */
const LANGUAGE_PREMIUM = (id: string) =>
  (Object.keys(llmEndpoints) as LlmProvider[]).some(provider => languageModelLevel(provider, id) === 'premium')

/**
 * Allow Premium changes what the workspace pays: the owner only, signed in as themselves in the app (billing:manage),
 * never through an API key, a setup link or an instance admin's impersonation.
 */
export function refuseBillingActor(actor: Actor) {
  if (actor.impersonation)
    throw new Forbidden('not while signed in as someone else: the owner decides what the workspace pays')
  if (actor.apiKeyId || actor.setupKeyId) throw new Forbidden('only the owner, signed in to the app, can change this')
}

/** What the assistant editor shows of levels (voice.options `levels`). */
export async function levelOptions(tx: Tx, workspaceId: string): Promise<UsageLevelOptions> {
  const billed = await usageLevelsBilled(tx)
  const { ownKeys, allowPremium, allowUltra } = await workspaceFlags(tx, workspaceId)
  const flags = { billed, allowPremium, allowUltra, ownKeys }
  const choice = (id: string, name: string, level: LevelChoice['level']): LevelChoice => ({
    id,
    name,
    level,
    allowed: levelAllowed(level, flags),
  })
  const voices = await setUpProviders(tx, 'tts').catch(() => [])
  const llm = await activeProvider(tx, 'llm').catch(() => null)
  const llmProvider = (llm?.provider ?? null) as LlmProvider | null
  const defaultVoiceModels = Object.fromEntries(
    voices.map(v => {
      const id = installVoiceModel(v.provider, v.config.model?.value, billed)
      return [v.provider, { id, level: voiceModelLevel(v.provider, id) }]
    }),
  )
  const defaultModelId = llmProvider ? installLanguageModel(llmProvider, llm?.config.model?.value, billed) : null
  const realtime = await activeProvider(tx, 'realtime').catch(() => null)
  const defaultRealtimeId = realtime ? installRealtimeModel(realtime.config.model?.value) : null
  return {
    ...flags,
    realtimeAllowed: levelAllowed('ultra', flags),
    standardCentsPerMinute: USAGE_CENTS_PER_MINUTE.standard,
    premiumCentsPerMinute: USAGE_CENTS_PER_MINUTE.premium,
    ultraCentsPerMinute: USAGE_CENTS_PER_MINUTE.ultra,
    realtimeModels: realtime ? REALTIME_MODEL_LEVELS.map(m => choice(m.model, m.name, m.level)) : [],
    defaultRealtimeModel: defaultRealtimeId
      ? { id: defaultRealtimeId, level: realtimeModelLevel(defaultRealtimeId) }
      : null,
    voiceModels: Object.fromEntries(
      voices.map(v => [v.provider, voiceModelsOf(v.provider).map(m => choice(m.model, m.name, m.level))]),
    ),
    defaultVoiceModels,
    llmProvider,
    models: llmProvider ? languageModelsOf(llmProvider).map(m => choice(m.id, m.name, m.level)) : [],
    defaultModel:
      llmProvider && defaultModelId
        ? { id: defaultModelId, level: languageModelLevel(llmProvider, defaultModelId) }
        : null,
  }
}
