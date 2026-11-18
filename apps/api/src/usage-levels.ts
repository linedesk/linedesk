// Call quality on Linedesk Cloud (packages/actions/src/usage-level.ts, decisions.md 2026-11-17): every assistant has
// a level (Standard 5¢, Premium 10¢, Ultra 20¢ a minute by default) and the level alone decides the price. What answers
// its calls: the three stages for Standard and Premium (its own models when they belong to the level, else the server's
// defaults for it, call-quality.ts), a realtime model for Ultra. Prices and the checks of a level the server admin turned
// off apply only while this install bills usage (billingState: billing on with usable Stripe keys); a self-hosted
// install has the same levels, without prices.
import {
  type BillPayerReset,
  CALL_QUALITIES,
  CALL_QUALITY_LABELS,
  type CallQuality,
  type CallQualityLevelOption,
  type CallQualityOptions,
  type CallParts,
  DEFAULT_VOICE_MODELS,
  type LevelChoice,
  languageModelLevel,
  languageModelsOf,
  levelAllowed,
  levelLanguageModelsOf,
  levelRealtimeModelsOf,
  levelVoiceModelsOf,
  llmEndpoints,
  type LlmProvider,
  partFits,
  REALTIME_MODEL_LEVELS,
  realtimeModelLevel,
  type SpeakingVoice,
  type UsageLevel,
  type UsageLevelOptions,
  usageLevel,
  voiceModelLevel,
  voiceModelsOf,
  type VoicePipeline,
} from '@linedesk/actions'
import { organization, type PaidLevel, type Tx, workspace_settings } from '@linedesk/db'
import type { Assistant } from '@linedesk/db/types'
import { and, eq, or } from 'drizzle-orm'
import { lockAssistantVersionsOf } from './assistant-versions.ts'
import { billingRules } from './billing-rules.ts'
import { billingState } from './billing-settings.ts'
import { brandName } from './branding.ts'
import {
  callQualitySettings,
  enabledLevels,
  type LevelDefaultModels,
  levelDefaultModels,
  moveToStandard,
  onStandard,
} from './call-quality.ts'
import type { Actor } from './context.ts'
import { Forbidden, Reject } from './handler-context.ts'
import { activeProvider, setUpProviders } from './provider-settings.ts'

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
  alertOnce(
    `the install's voice model "${id}" (${provider}) is not Standard: calls use ${standard ? `"${standard}"` : 'none (not answered)'}`,
  )
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
    for (const fallback of modelsOf(configured, provider)
      .slice(1)
      .filter(m => languageModelLevel(provider, m) !== 'standard'))
      alertOnce(
        `the install's fallback language model "${fallback}" (${provider}) is not Standard: Standard calls never use it`,
      )
  if (!billed || languageModelLevel(provider, id) === 'standard') return id
  const standard = standardLanguageModelOf(provider)
  alertOnce(
    `the install's language model "${id}" (${provider}) is not Standard: calls use ${standard ? `"${standard}"` : 'none (not answered)'}`,
  )
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
        `${id} is not a Standard language model: on ${brandName()} Cloud the server's default must be one (${
          languageModelsOf(provider)
            .filter(m => m.level === 'standard')
            .map(m => m.id)
            .join(', ') || 'this provider has none'
        })`,
      )
    return
  }
  if (voiceModelsOf(provider).length || DEFAULT_VOICE_MODELS[provider]) {
    const id = model?.trim() || DEFAULT_VOICE_MODELS[provider] || ''
    if (voiceModelLevel(provider, id) !== 'standard')
      throw new Reject(
        `${id || 'No model'} is not a Standard voice model: on ${brandName()} Cloud the server's default must be one (${
          voiceModelsOf(provider)
            .filter(m => m.level === 'standard')
            .map(m => m.model)
            .join(', ') || 'this provider has none'
        })`,
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

/** The models of a "model, fallback, ..." list, or the provider's default alone. */
const modelsOf = (list: string | null | undefined, provider: LlmProvider) => {
  const models = (list ?? '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean)
  return models.length ? models : [llmEndpoints[provider].models[0]!]
}
/** The first model of a "model, fallback" list, or the provider's default. */
const firstModel = (list: string | null | undefined, provider: LlmProvider) => modelsOf(list, provider)[0]!

/** The realtime model the install named before call quality (REALTIME_MODEL), for the editor's legacy `levels`. */
const installRealtimeModel = (configured: string | null | undefined) => configured?.trim() || 'gpt-realtime'

/** What answers a call: the voice and the language model (a realtime model passes itself for both), and the pipeline. */
type Choices = CallParts & { pipeline: VoicePipeline }
type AssistantChoices = Pick<Assistant, 'voice' | 'llm_model' | 'call_quality'> & {
  id?: string
  realtime_model?: string | null
}

/** The pipeline a level answers with: Ultra a realtime model, Standard and Premium the three stages. */
export const pipelineOfLevel = (level: CallQuality): VoicePipeline => (level === 'ultra' ? 'realtime' : 'three_stage')

/**
 * What an assistant's calls use at its level (`level` overrides it): Ultra the realtime model (its own when it picked
 * one, else the server's default for Ultra), Standard and Premium the three stages with its voice provider (its own
 * when that one is set up, else the install's) and the install's language-model provider, each model its own pick
 * when that belongs to the level, else the server's default for the level. null when the level's pipeline is not set
 * up, or (billed) a provider has no model of the level.
 */
export async function assistantChoices(
  tx: Tx,
  assistant: AssistantChoices,
  { billed, level = assistant.call_quality, defaults }: { billed: boolean; level?: CallQuality; defaults?: LevelDefaultModels },
): Promise<Choices | null> {
  const models = defaults ?? (await levelDefaultModels(tx, await callQualitySettings(tx), { billed }))
  if (level === 'ultra') {
    const realtime = await activeProvider(tx, 'realtime').catch(() => null)
    if (!realtime || !models.ultra.realtime) return null
    const own = assistant.realtime_model?.trim()
    const model = { provider: realtime.provider, model: own && realtimeModelLevel(own) ? own : models.ultra.realtime }
    return { voice: model, model, pipeline: 'realtime' }
  }
  const llm = await activeProvider(tx, 'llm').catch(() => null)
  const tts = await activeProvider(tx, 'tts').catch(() => null)
  if (!llm || !tts) return null
  const voices = await setUpProviders(tx, 'tts').catch(() => [])
  const own = assistant.voice.voice_id ? voices.find(v => v.provider === assistant.voice.provider) : undefined
  const voiceProvider = (own ?? tts).provider
  const ownVoiceModel = assistant.voice.provider === voiceProvider ? assistant.voice.model?.trim() : undefined
  const voiceModel =
    ownVoiceModel && partFits(voiceModelLevel(voiceProvider, ownVoiceModel), level)
      ? ownVoiceModel
      : models[level].voice[voiceProvider]
  const ownModel = assistant.llm_model?.trim()
  const languageModel =
    ownModel && partFits(languageModelLevel(llm.provider, ownModel), level) ? ownModel : models[level].llm
  if (voiceModel === undefined || !languageModel) return null
  return {
    voice: { provider: voiceProvider, model: voiceModel },
    model: { provider: llm.provider, model: languageModel },
    pipeline: 'three_stage',
  }
}

/** The refusals of assistant.update for a call quality (the web app never offers what they refuse). */
export const levelOff = (level: CallQuality) => Reject.t('server.api.callQualityOff', { level: LEVEL_NAMES[level] })
export const notOfLevel = (level: CallQuality) =>
  Reject.t('server.api.callQualityModelOutside', { level: LEVEL_NAMES[level] })
const LEVEL_NAMES = CALL_QUALITY_LABELS

/**
 * An assistant's level and model picks before a save: the level must be one the server admin has on (Standard always),
 * and each model the assistant picks must belong to it (its language model at the install's provider, its voice model
 * at its voice provider, a realtime model only on Ultra). Who may raise the level is checked by the caller
 * (level-raise.ts). Checked only when a save changes the level or a pick, so other changes never fail over the
 * install's settings.
 */
export async function checkAssistantLevel(tx: Tx, after: AssistantChoices, { levelChanged }: { levelChanged: boolean }) {
  const level = after.call_quality
  if (levelChanged && !(await enabledLevels(tx))[level]) throw levelOff(level)
  if (after.realtime_model && (level !== 'ultra' || !realtimeModelLevel(after.realtime_model))) throw notOfLevel(level)
  if (after.llm_model) {
    const llm = await activeProvider(tx, 'llm').catch(() => null)
    if (level === 'ultra' || !llm || !partFits(languageModelLevel(llm.provider, after.llm_model), level))
      throw notOfLevel(level)
  }
  if (after.voice.model && (level === 'ultra' || !partFits(voiceModelLevel(after.voice.provider, after.voice.model), level)))
    throw notOfLevel(level)
}

/**
 * The picks an assistant keeps when its level changes: those that belong to the new level (decisions.md 2026-11-17:
 * the server clears the others in the same save, they follow the new level's defaults).
 */
export async function picksForLevel<A extends Pick<Assistant, 'voice' | 'llm_model' | 'realtime_model'>>(
  tx: Tx,
  a: A,
  level: CallQuality,
): Promise<Pick<A, 'voice' | 'llm_model' | 'realtime_model'>> {
  const llm = await activeProvider(tx, 'llm').catch(() => null)
  const { model, ...voice } = a.voice
  const keepVoiceModel = !!model && level !== 'ultra' && partFits(voiceModelLevel(a.voice.provider, model), level)
  const keepModel =
    !!a.llm_model && level !== 'ultra' && !!llm && partFits(languageModelLevel(llm.provider, a.llm_model), level)
  return {
    voice: (keepVoiceModel ? a.voice : voice) as A['voice'],
    llm_model: keepModel ? a.llm_model : null,
    realtime_model: level === 'ultra' ? a.realtime_model : null,
  }
}

/**
 * The assistant as the agent answers with it: the level and the models that were checked, named on it (the agent never
 * picks a model itself). A voice of a provider the call does not use is replaced by that provider's default voice, as
 * the agent does.
 */
function withCheckedModels<A extends AssistantChoices>(a: A, c: Choices, level: CallQuality): A {
  if (c.pipeline === 'realtime') return { ...a, call_quality: 'ultra', realtime_model: c.model.model }
  const voice =
    c.voice.provider === a.voice.provider
      ? { ...a.voice, model: c.voice.model }
      : { ...a.voice, provider: c.voice.provider, voice_id: '', model: c.voice.model }
  return { ...a, call_quality: level, voice: voice as A['voice'], llm_model: c.model.model, realtime_model: null }
}

/**
 * The assistant a call starts with, and the level it is priced at; decided once, here. The assistant's level with the
 * models checked, named on it (withCheckedModels). On Linedesk Cloud, when that level is off (the server admin turned
 * it off since) or a model does not belong to it, the call falls back to Standard with the server's defaults, with one
 * ALERT line: no call runs on a level that is off, or without a price; when even Standard cannot answer, the level
 * stays `not_allowed` and the agent does not answer (the call is filed as missed). On an install that does not bill:
 * the level's pipeline, else the other one when only that is set up (a call never goes unanswered over it).
 */
export async function assistantForCall<A extends AssistantChoices>(
  tx: Tx,
  workspaceId: string,
  assistant: A,
  log: (line: string) => void = alert,
): Promise<{ assistant: A; level: UsageLevel | null; paidLevel: PaidLevel | null; pipeline: VoicePipeline | null }> {
  const billed = await usageLevelsBilled(tx)
  const settings = await callQualitySettings(tx)
  const defaults = await levelDefaultModels(tx, settings, { billed })
  const level = assistant.call_quality
  const choices = await assistantChoices(tx, assistant, { billed, defaults })
  if (!billed) {
    if (choices) return { assistant: withCheckedModels(assistant, choices, level), level: null, paidLevel: null, pipeline: choices.pipeline }
    // Not set up for its level: the other pipeline, when that one is (Standard's defaults, or Ultra's).
    const other: CallQuality = level === 'ultra' ? 'standard' : 'ultra'
    const answered = await assistantChoices(tx, onStandard(assistant), { billed, level: other, defaults })
    if (!answered) return { assistant, level: null, paidLevel: null, pipeline: null }
    console.warn(`assistant ${assistant.id ?? '?'} is on ${level}, which is not set up here: ${other} answers`)
    return {
      assistant: withCheckedModels(onStandard(assistant), answered, other),
      level: null,
      paidLevel: null,
      pipeline: answered.pipeline,
    }
  }
  const enabled = await enabledLevels(tx, settings)
  const ownKeys = await workspaceOwnKeys(tx, workspaceId)
  const decided = choices ? usageLevel({ level, parts: choices, ownKeys, levelEnabled: enabled[level] }) : 'not_allowed'
  if (choices && decided !== 'not_allowed')
    return {
      assistant: withCheckedModels(assistant, choices, level),
      level: decided,
      paidLevel: level,
      pipeline: choices.pipeline,
    }
  const fallback = onStandard(assistant)
  const standard = await assistantChoices(tx, fallback, { billed, defaults })
  const fallbackLevel = standard
    ? usageLevel({ level: 'standard', parts: standard, ownKeys, levelEnabled: true })
    : 'not_allowed'
  const what = !enabled[level]
    ? `${LEVEL_NAMES[level]} is off`
    : choices
      ? `${describeChoices(choices)} is not part of ${LEVEL_NAMES[level]}`
      : `nothing set up to answer on ${LEVEL_NAMES[level]}`
  log(
    `assistant ${assistant.id ?? '?'} of workspace ${workspaceId} cannot answer on its level (${what}): ${
      fallbackLevel === 'not_allowed'
        ? 'no Standard voice and model is set up either, the call is not answered'
        : `the call falls back to Standard (${describeChoices(standard!)})`
    }`,
  )
  if (!standard || fallbackLevel === 'not_allowed')
    return { assistant: fallback, level: 'not_allowed', paidLevel: null, pipeline: 'three_stage' }
  return {
    assistant: withCheckedModels(fallback, standard, 'standard'),
    level: fallbackLevel,
    paidLevel: 'standard',
    pipeline: 'three_stage',
  }
}

/** The level an assistant's calls are priced at, as call start decides it (assistantForCall); null: not billed. */
export async function assistantUsageLevel(tx: Tx, workspaceId: string, assistant: AssistantChoices) {
  return (await assistantForCall(tx, workspaceId, assistant, () => {})).level
}

const describeChoices = (c: Choices) =>
  c.pipeline === 'realtime'
    ? c.model.model
    : `${c.voice.provider}/${c.voice.model}, ${c.model.provider}/${c.model.model}`

/**
 * The voices a call of the assistant speaks with, for the language checks: on the three stages its one voice
 * (provider and voice model, as the call resolves them); Ultra: null (every voice the install has).
 */
export async function assistantVoiceOf(tx: Tx, assistant: AssistantChoices): Promise<SpeakingVoice | null> {
  const billed = await usageLevelsBilled(tx)
  const choices = await assistantChoices(tx, assistant, { billed })
  return choices?.pipeline === 'three_stage' ? choices.voice : null
}

/**
 * Allow Premium or Allow Ultra turned off (until the switches go, call quality 4/5): the workspace's assistants on that
 * level go to Standard, with a version by `by`. Returns the rows it changed.
 */
export const assistantsBackToStandard = (tx: Tx, workspaceId: string, by: string) =>
  moveToStandard(tx, workspaceId, ['premium'], by)
export const assistantsOffUltra = (tx: Tx, workspaceId: string, by: string) =>
  moveToStandard(tx, workspaceId, ['ultra'], by)

/**
 * Before a change that may give these workspaces another bill owner, and before the bill's balance lock: the version
 * locks of all their assistants (billPayerChanged may change them), in the order of `call.start` (a version lock,
 * then the balance), so the two never deadlock.
 */
export async function lockForPayerChange(tx: Tx, workspaceIds: string[]) {
  for (const id of [...new Set(workspaceIds)].sort()) await lockAssistantVersionsOf(tx, id)
}

/**
 * A bill owner changed to another person (LIN-438: `billing.moveWorkspace` to a bill of someone else,
 * `billing.transferOwner`, `billing.handOver`, `team.transferOwnership` moving the bill): Premium and Ultra were the old
 * payer's choice, so each of these workspaces' assistants on them goes to Standard, with a version by `by`, and Allow
 * Premium and Allow Ultra go off (until the switches go, call quality 4/5). Call in the same transaction, after the
 * bill's balance lock and the change itself: a raise meanwhile waited for that change (refuseLevelRaise locks the
 * bill) and was refused, or committed before it and is seen here. Returns what it changed.
 */
export async function billPayerChanged(tx: Tx, workspaceIds: string[], by: string) {
  const reset: BillPayerReset = { workspaceIds: [], movedToStandard: [], movedOffUltra: [] }
  const rows: Assistant[] = []
  for (const workspaceId of [...new Set(workspaceIds)].sort()) {
    // Taken already by lockForPayerChange (then this waits for nothing); not yet only for a workspace moved onto the
    // bill between that and the balance lock (billing.handOver, billing.transferOwner).
    await lockAssistantVersionsOf(tx, workspaceId)
    const switchedOff = await tx
      .update(workspace_settings)
      .set({ allow_premium: false, allow_ultra: false })
      .where(
        and(
          eq(workspace_settings.workspace_id, workspaceId),
          or(eq(workspace_settings.allow_premium, true), eq(workspace_settings.allow_ultra, true)),
        ),
      )
      .returning({ id: workspace_settings.workspace_id })
    const toStandard = await moveToStandard(tx, workspaceId, ['premium'], by)
    const offUltra = await moveToStandard(tx, workspaceId, ['ultra'], by)
    if (!toStandard.length && !offUltra.length && !switchedOff.length) continue
    reset.workspaceIds.push(workspaceId)
    reset.movedToStandard.push(...toStandard.map(a => a.id))
    reset.movedOffUltra.push(...offUltra.map(a => a.id))
    rows.push(...toStandard, ...offUltra)
  }
  return { reset, rows }
}

/**
 * Allow Premium changes what the workspace pays: the owner only, signed in as themselves in the app (billing:manage),
 * never through an API key, a setup link or an instance admin's impersonation.
 */
export function refuseBillingActor(actor: Actor) {
  if (actor.impersonation)
    throw new Forbidden('not while signed in as someone else: the owner decides what the workspace pays')
  if (actor.apiKeyId || actor.personalKeyId || actor.setupKeyId)
    throw new Forbidden('only the owner, signed in to the app, can change this')
}

/** The install's price of a call minute per level, in US cents (Server admin › Billing; the defaults otherwise). */
export async function levelCentsPerMinute(tx: Pick<Tx, 'select'>) {
  const { levels } = await billingRules(tx)
  return {
    standard: levels.standard.microsPerMinute / 10_000,
    premium: levels.premium.microsPerMinute / 10_000,
    ultra: levels.ultra.microsPerMinute / 10_000,
  }
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
  // A white-label client's people see levels without our prices (docs/white-label.md; review of #1109, L-2).
  const [org] = await tx
    .select({ partnerId: organization.partnerId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  const partnerManaged = !!org?.partnerId
  const cents = partnerManaged ? { standard: 0, premium: 0, ultra: 0 } : await levelCentsPerMinute(tx)
  return {
    ...flags,
    ...(partnerManaged ? { partnerManaged } : {}),
    realtimeAllowed: levelAllowed('ultra', flags),
    standardCentsPerMinute: cents.standard,
    premiumCentsPerMinute: cents.premium,
    ultraCentsPerMinute: cents.ultra,
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

/**
 * What the assistant editor shows of call quality (voice.options `callQuality`): the levels the server admin has on,
 * each with its price a minute (null without prices: a white-label client, a workspace on no bill, an install that
 * does not bill), the models that belong to it and what "Default" stands for; the level new assistants start on; and
 * `mayRaise`, whether this member may pick a paid level (level-raise.ts).
 */
export async function callQualityOptions(tx: Tx, workspaceId: string, mayRaise: boolean): Promise<CallQualityOptions> {
  const billed = await usageLevelsBilled(tx)
  const settings = await callQualitySettings(tx)
  const enabled = await enabledLevels(tx, settings)
  const defaults = await levelDefaultModels(tx, settings, { billed })
  const [org] = await tx
    .select({ partnerId: organization.partnerId, bill: organization.billingAccountId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  const partnerManaged = !!org?.partnerId
  // A white-label client's people never see our prices (docs/white-label.md; review of #1109, L-2).
  const cents = billed && !partnerManaged && org?.bill ? await levelCentsPerMinute(tx) : null
  const voices = await setUpProviders(tx, 'tts').catch(() => [])
  const llmProvider = defaults.llmProvider
  const levels: CallQualityLevelOption[] = CALL_QUALITIES.filter(level => enabled[level]).map(level =>
    level === 'ultra'
      ? {
          level,
          centsPerMinute: cents?.ultra ?? null,
          models: [],
          voiceModels: {},
          realtimeModels: levelRealtimeModelsOf(),
          defaults: { llm: null, voice: {}, realtime: defaults.ultra.realtime },
        }
      : {
          level,
          centsPerMinute: cents?.[level] ?? null,
          models: llmProvider ? levelLanguageModelsOf(llmProvider, level) : [],
          voiceModels: Object.fromEntries(voices.map(v => [v.provider, levelVoiceModelsOf(v.provider, level)])),
          realtimeModels: [],
          defaults: { llm: defaults[level].llm, voice: defaults[level].voice, realtime: null },
        },
  )
  return {
    levels,
    defaultLevel: enabled[settings.default] ? settings.default : 'standard',
    mayRaise,
    partnerManaged,
    llmProvider,
  }
}
