// Server side of the registry. Patch actions run generically; the rest have a handler here.
import {
  type CallQuality,
  raisesLevel,
  actions,
  type AssistantRestoreData,
  AWAIT_TRANSCRIPT_MAX_SEC,
  type CallFinishData,
  type CorrectTranscriptData,
  buyableAreaCode,
  buyOfferIn,
  behaviourOn,
  callerRecognized,
  type CallerAttestation,
  english,
  isPickable,
  followLanguageDefault,
  mainLanguageOf,
  spokenLanguages,
  unspokenLanguages,
  heardLanguages,
  languageCodes,
  providerSpec,
  type ProviderName,
  isActiveContact,
  setsTransferNumber,
  ASSISTANT_CALL_MAX_MINUTES,
  confirmsNumber,
  offerHasAreaCode,
  isE164,
  normalizeCallerId,
  recordingKey,
  testCallContact,
  type ActionDef,
  type ActionResult,
  type CallTestFinding,
  type CarrierNumbersData,
  type NearbyNumbersData,
  nearbyAreaCodes,
  type ReplyTiming,
  type KeySource,
  type VoiceFailure,
  VOICE_FAILURES_PER_CALL,
  VOICE_FAILURE_MESSAGE_MAX,
  isPerCallProviderError,
  callLanguageOf,
  languageModelLevel,
  realtimeModelLevel,
  voiceModelLevel,
} from '@linedesk/actions'
import { addDays, businessHoursContext, type BusinessHoursContext, dateLabel, localDate } from '@linedesk/calendar'
import {
  assistant_calendars,
  assistants,
  availability_exceptions,
  availability_rules,
  billing_accounts,
  call_evaluations,
  call_events,
  call_reservations,
  calls,
  contacts,
  organization,
  phone_numbers,
  reply_timings,
  syncedTables,
  transcript_segments,
  workspace_members,
  workspace_settings,
  type Tx,
  workspaceCallLimit,
} from '@linedesk/db'
import type { ActionItem, Assistant, AssistantVoice, Closure, PhoneNumber, TransferContact } from '@linedesk/db/types'
import { sipTlsFromEnv, TelephonyError, type TelephonyProvider } from '@linedesk/telephony'
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { adminHandlers } from './admin-handlers.ts'
import { setupEmailHandlers } from './setup-emails.ts'
import { founderEmailHandlers } from './founder-email.ts'
import { billingSettingsHandlers } from './billing-settings.ts'
import { billingAdminHandlers } from './billing-admin.ts'
import { billingRules } from './billing-rules.ts'
import { billingOwnerHandlers } from './billing-owner.ts'
import { billingPageHandlers, billingPagePreparers } from './billing-page.ts'
import { stripeEventHandlers, stripeEventPreparers } from './stripe-events.ts'
import { providerHealthHandlers, recordProviderFailure } from './provider-failures.ts'
import { brandingHandlers, brandName } from './branding.ts'
import { issueCallToken } from './agent-token.ts'
import { startS3Recording } from './recording-egress.ts'
import { purgeCommandsAbout } from './command-log.ts'
import { eraseCallNow } from './data-purge.ts'
import { emailRoutingChangesIn, transferChanges } from './audit.ts'
import { agentSetupHandlers } from './agent-setup.ts'
import { installSetupHandlers } from './install-setup.ts'
import { requestInboundTrunkSync } from './inbound-trunk.ts'
import { apiKeyHandlers } from './api-keys.ts'
import { personalKeyHandlers } from './personal-keys.ts'
import { oauthHandlers } from './oauth.ts'
import { recordHandlers } from './records.ts'
import { assistantForNumber, assistantHandlers, assistantIn } from './assistants.ts'
import {
  assistantVersionHandlers,
  lockAssistantVersion,
  recordVersion,
  versionForCall,
  versionOf,
  VERSIONED_ACTIONS,
  withVersion,
} from './assistant-versions.ts'
import { bookingContext, bookingHandlers, bookingsForTest, DEFAULT_TIME_ZONE } from './bookings.ts'
import { calendarConnectionHandlers } from './calendar-connections.ts'
import { appConnectionHandlers } from './app-connections.ts'
import { shopifyCallHandlers, shopifyCallSetup } from './shopify-calls.ts'
import { mailAnalysisHandlers } from './mail-analysis.ts'
import { mailConnectionHandlers } from './mail-connections.ts'
import { appPushHandlers } from './app-pushes.ts'
import { calendarToolHandlers } from './calendar-tools.ts'
import { callerHistory } from './caller-history.ts'
import {
  type CarrierAccount,
  carrierHandlers,
  INSTALL_NUMBER_ADMIN_ONLY,
  lockWorkspaceCarrier,
  ownCarrierProvider,
  telephonyForWorkspace,
  tryLockWorkspaceCarrier,
} from './workspace-carrier.ts'
import { refreshTransferTrunk, transferTrunkHandlers } from './transfer-trunk.ts'
import { outboundHandlers, outboundRefusal, syncInstallDestinations } from './outbound-policy.ts'
import { switchOffLoopingTransfers } from './transfer-loops.ts'
import { impersonationHandlers } from './impersonation.ts'
import type { Actor } from './context.ts'
import { impersonatorOf } from './impersonation-guard.ts'
import {
  type Handler,
  type HandlerCtx,
  lockCall,
  notFound,
  type Preparer,
  Forbidden,
  NotFound,
  type Reader,
  Reject,
  type Undo,
} from './handler-context.ts'
import { languageInSentence } from '@linedesk/i18n'
import { activeProvider, installHearing, installLanguages, telephonyProvider } from './provider-settings.ts'
import { refuseLevelChange } from './level-raise.ts'
import { assistantForCall, assistantVoiceOf, checkAssistantLevel, picksForLevel } from './usage-levels.ts'
import { startTestCall } from './test-call.ts'
import { liveCallHandlers } from './live-call.ts'
import { membershipHandlers } from './memberships.ts'
import {
  areaCodeCountryRefusal,
  buyCountryRefusal,
  installPurchaseRefusal,
  logPurchase,
  NUMBER_NOT_ACTIVATED,
  NUMBER_SETUP_BUSY,
  NUMBERS_NEED_DOCUMENTS,
  numberCountryRefusal,
  purchaseCountry,
} from './number-purchases.ts'
import { teamHandlers } from './team.ts'
import { emailRecipientHandlers } from './email-recipients.ts'
import { workspaceCreationHandlers } from './workspace-creation-handlers.ts'
import { teamMemberEditHandlers } from './team-member-edit.ts'
import { transferHandlers } from './transfers.ts'
import { insightsHandlers } from './insights.ts'
import { userAvatarHandlers } from './user-avatar.ts'
import { authenticatorHandlers, authenticatorPreparers } from './authenticator.ts'
import { workspaceIconHandlers } from './workspace-icon.ts'
import { recordingNoticeFor, workspaceSettingsHandlers } from './workspace-settings.ts'
import { workspaceLocale } from './workspace-locale.ts'
import { applyCountryDefaults } from './country-defaults.ts'
import { publicHolidayHandlers } from './public-holidays.ts'
import { checkAssistantVoice, releaseUnusedClones, voiceHandlers, voicePreparers } from './voices.ts'
import { promptOverridesForCall, systemPromptHandlers } from './system-prompt.ts'
import { sampleHandlers } from './sample-calls.ts'
import { goLiveChecklistHandlers } from './go-live-checklist.ts'
import {
  isOwnNumber,
  recordCallFinished,
  recordCallStarted,
  recordOnboardingStep,
  recordSetupEvent,
} from './setup-events.ts'
import {
  queueAssignNotification,
  queueCallEvaluation,
  queueMailAnalysis,
  queueCallTranscript,
  queueForwardingCheck,
  queueRecordingDeletion,
  queueCallPush,
  queueCallRelease,
} from './jobs.ts'
import {
  afterCallTranscriptHandlers,
  transcribeCallAgain,
  transcriberInEffect,
  transcribesAfterCalls,
} from './after-call-transcript.ts'
import { queueFinishedNews, releaseHeldNews } from './call-news.ts'
import { recordingStoreCache } from './recording-store.ts'
import { claimForwardingCheck, forwardingCheckHandlers, forwardingCheckStart } from './forwarding-check.ts'
import { claimNewCallerForTest, expectNewCallerForTest } from './new-caller-for-test.ts'
import { queueSpendingAlerts, spendingCap } from './spending-cap.ts'
import { numberUnpaid, payBoughtNumberMonth } from './billing-periods.ts'
import { billOfCall, busyLineAlert, type CallRefusal, gateCall, postFinishedCall } from './call-billing.ts'
import { evaluationHandlers } from './evaluations.ts'
import { businessHandlers } from './business-import.ts'
import { knowledgeHandlers } from './knowledge.ts'
import { knowledgeQuestionHandlers } from './knowledge-questions.ts'
import { notificationHandlers } from './notification-settings.ts'
import { starHandlers } from './star-prompt.ts'
import { feedbackHandlers } from './feedback.ts'
import { pushHandlers } from './push.ts'
import { contactImportHandlers } from './contact-import.ts'
import { contactMergeHandlers } from './contact-merge.ts'
import { keepsRecordings } from './recording-retention.ts'
import { callExportHandlers } from './call-export.ts'
import { integrationHandlers, queueCallStarted, queueLookup } from './integrations.ts'
import { queueUsageLimitAlerts, type UsageLimit, usageLimit } from './usage-limit.ts'
import { askWebhook, clearCallPayloads, duringCallLookups, lookUpCaller, webhookHandlers } from './webhooks.ts'
import { PENDING_PAYMENT, refusePendingPayment, waitsForOwnTrial } from './self-serve.ts'
import { selfServeHandlers } from './signup-handlers.ts'
import { termsUpdateHandlers } from './terms-update.ts'
import { partnerHandlers } from './partners.ts'
import { billingNumberRefusal, checkoutHandlers, checkoutPreparers } from './billing-checkout.ts'
import { workspaceDeletePreparers } from './workspace-delete-plan.ts'
import { matchLocale, type Translator } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import { partnerBrandHandlers } from './partner-brand.ts'
import {
  maskFailure,
  partnerKeyHandlers,
  partnerKeyPreparers,
  partnerVoiceFailure,
  reportConfirmsOwnKeys,
} from './partner-keys.ts'
import { partnerSenderHandlers, partnerSenderPreparers } from './partner-sender.ts'
import { partnerDomainHandlers, partnerDomainPreparers } from './partner-domain.ts'
import { partnerSetupHandlers } from './partner-setup.ts'
import {
  alertNumbersNotReady,
  buyHeldNumber,
  requirementGroupNote,
  germanNumbersHandlers,
  germanRequirementGroup,
  NUMBERS_BEING_SET_UP,
  numberBuyOffers,
  warnAtHeldNumbersLimit,
  germanNumbersNotReadyWhy,
} from './number-buy.ts'
import { signupAccessHandlers } from './signup-access.ts'

export { Forbidden, NotFound, Reject, type HandlerCtx, type Undo }

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

async function runPatch(
  { tx, actor, now }: HandlerCtx,
  def: ActionDef,
  input: unknown,
): Promise<Omit<ActionResult, 'ok'>> {
  const patch = def.patch!
  if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
  const table = syncedTables[patch.table]
  const scope = and(eq(table.id, patch.id(input)), eq(table.workspace_id, actor.workspaceId))
  const values = patch.set(input, now)
  const rows = Object.keys(values).length
    ? await tx.update(table).set(values).where(scope).returning()
    : await tx.select().from(table).where(scope)
  if (!rows[0]) throw notFound(patch.table)
  return { rows: { [patch.table]: rows } }
}

/** The assistant's transfer contacts as saved now (an assistant of another workspace has none). */
async function assistantTransfers(tx: Tx, workspaceId: string, assistantId: string): Promise<TransferContact[]> {
  const [row] = await tx
    .select({ transfers: assistants.transfers })
    .from(assistants)
    .where(and(eq(assistants.id, assistantId), eq(assistants.workspace_id, workspaceId)))
  return row?.transfers ?? []
}

/** Messages the assistant takes on one call: each one is a push, so a caller cannot flood the team. */
export const MESSAGES_PER_CALL = 3

/** Only `call.start` may run without a workspace: it is the action that resolves it. */
async function loadCall(tx: Tx, actor: Actor, callId: string) {
  if (!actor.workspaceId) throw new Reject('no workspace (send x-workspace-id)')
  const [call] = await tx
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspace_id, actor.workspaceId)))
  if (!call) throw Reject.t('server.api.callNotFound')
  return call
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A carrier that is selected but not configured is the operator's to fix: say what is missing. */
async function configuredProvider(tx: Tx): Promise<TelephonyProvider> {
  try {
    return await telephonyProvider(tx)
  } catch (e) {
    throw new Reject(`phone setup is not configured: ${errorMessage(e)}`)
  }
}

/** The carrier a workspace sets numbers up with (its own account, else the install's). `telephony` overrides it in tests. */
/** One page of the carrier's numbers (Telnyx and Twilio both allow 250 per request). */
const CARRIER_NUMBERS_PAGE = 250

async function setupCarrier(
  tx: Tx,
  workspaceId: string,
  telephony?: TelephonyProvider,
): Promise<{ provider: TelephonyProvider; account: CarrierAccount }> {
  try {
    const resolved = await telephonyForWorkspace(tx, workspaceId)
    return telephony ? { provider: telephony, account: resolved.account } : resolved
  } catch (e) {
    if (e instanceof Reject) throw e
    throw new Reject(`phone setup is not configured: ${errorMessage(e)}`)
  }
}

/**
 * The carrier account a number is in: the workspace's own (only ever the number's own workspace) or the
 * install's. A number in the workspace's account is never handed to the install's carrier, or the reverse.
 */
async function releaseCarrier(tx: Tx, number: PhoneNumber): Promise<TelephonyProvider> {
  if (number.carrier_account === 'install') return configuredProvider(tx)
  const own = await ownCarrierProvider(tx, number.workspace_id)
  if (!own)
    throw new Reject(
      `${number.e164} is in the workspace's own carrier account, which is not set up any more: release it there`,
    )
  return own
}

/**
 * Carrier failures are final for the command: the user sees the reason, the client does not retry. The carrier's
 * HTTP status goes along ("HTTP 401"), so the app can say what it means (providerFailureReasonOfText, LIN-111).
 */
async function atCarrier<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (e) {
    if (!(e instanceof TelephonyError)) throw e
    // Failures with a code are told in the app's words: the carrier's name orders and requirements of the operator's
    // account, which stay in the server log (LIN-300).
    if (e.code) {
      console.error(`phone setup: ${e.message}`)
      throw new Reject(e.code === 'country_requirements' ? NUMBERS_NEED_DOCUMENTS : NUMBER_NOT_ACTIVATED)
    }
    const reason = e.status ? `${e.message} (HTTP ${e.status})` : e.message
    // The app shows most refusals in general words ("couldn't be connected"): the carrier's own answer goes to the server
    // log too, so a failed purchase can be told from the log (its words, never the key).
    console.error(`carrier request refused: ${reason}`)
    throw new Reject(reason)
  }
}

/** Gives a number that this command bought back to the carrier, so nothing is paid for without a row. */
const releaseBought =
  (provider: TelephonyProvider, number: { e164: string; providerRef: string }): Undo =>
  async () => {
    try {
      await provider.releaseNumber(number)
      return `${number.e164} was released`
    } catch (e) {
      return `releasing ${number.e164} failed (${errorMessage(e)}): release it at the carrier, or set it up again`
    }
  }

/** The business hours `call.start` gives the agent; `closure` while vacation or closure mode is on. */
export type CallHours = Pick<BusinessHoursContext, 'openNow' | 'summary'> &
  Partial<BusinessHoursContext> & { closure?: Pick<Closure, 'greeting'> }

/** The closure as the agent hears it, when today (in the workspace's zone) is one of its days; else null. */
export function closureNow(closure: Closure | null | undefined, timeZone: string, nowMs: number): CallHours | null {
  if (!closure) return null
  const today = localDate(nowMs, timeZone)
  if (today < closure.from || today > closure.until) return null
  const back = dateLabel(addDays(closure.until, 1))
  return {
    openNow: false,
    summary: `Closed for a break from ${dateLabel(closure.from)} to ${dateLabel(closure.until)}, back on ${back}.`,
    closure: { greeting: closure.greeting },
  }
}

/**
 * The workspace's business hours for the voice agent: open now or not, when that changes, and a
 * sentence it can use ("Closed now; opens tomorrow at 7:00 AM"), holidays included. Vacation or
 * closure mode wins over the hours, also when the workspace does not use hours. null: nothing to say.
 */
export async function businessHoursFor(tx: Tx, workspace_id: string, now: string): Promise<CallHours | null> {
  const [settings] = await tx
    .select({
      timezone: workspace_settings.timezone,
      on: workspace_settings.business_hours_on,
      closure: workspace_settings.closure,
    })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspace_id))
  const timeZone = settings?.timezone ?? DEFAULT_TIME_ZONE
  const closed = closureNow(settings?.closure, timeZone, Date.parse(now))
  if (closed) return closed
  // Hours are opt-in: until the workspace turns them on the assistant says nothing about them.
  if (!settings?.on) return null
  const rules = await tx.select().from(availability_rules).where(eq(availability_rules.workspace_id, workspace_id))
  if (!rules.length) return null
  const exceptions = await tx
    .select()
    .from(availability_exceptions)
    .where(
      and(
        eq(availability_exceptions.workspace_id, workspace_id),
        gte(availability_exceptions.date, localDate(Date.parse(now), timeZone)),
      ),
    )
  try {
    const hours = businessHoursContext(rules, timeZone, Date.parse(now), exceptions)
    return hours && withUpcomingClosure(hours, settings.closure, timeZone, Date.parse(now))
  } catch (e) {
    console.warn(`business hours of ${workspace_id} could not be read: ${errorMessage(e)}`)
    return null
  }
}

/** A closure that starts in the next two weeks is mentioned, so the assistant can tell callers ahead. */
function withUpcomingClosure(
  hours: CallHours,
  closure: Closure | null | undefined,
  timeZone: string,
  nowMs: number,
): CallHours {
  const today = localDate(nowMs, timeZone)
  if (!closure || closure.from <= today || closure.from > addDays(today, 14)) return hours
  return {
    ...hours,
    summary: `${hours.summary} Closed for a break from ${dateLabel(closure.from)} to ${dateLabel(closure.until)}.`,
  }
}

type OpenCall = {
  from: string
  to: string
  room?: string
  source?: 'phone' | 'test' | 'simulated'
  label: string
  assistant: Assistant | null
  /** What the caller's carrier said about the caller ID (phone calls; missing from an older agent). */
  attestation?: CallerAttestation
  spamLikely?: boolean
  /** The call test's new caller (call.newCallerForTest): answered as if the number were new. */
  newCaller?: boolean
}

/**
 * The contact as the assistant may see it: on a call whose caller ID is not trusted (callerRecognized), nothing the
 * team wrote about the number's owner, only the number itself (the callback number).
 */
export function contactForAssistant<C extends { name: string | null; note: string | null; name_source: string | null }>(
  contact: C,
  recognized: boolean,
): C {
  return recognized ? contact : { ...contact, name: null, note: null, name_source: null }
}

/** The agent's token for the call it just opened (agent-token.ts); the command log keeps it redacted. */
function withCallToken<R extends { data: { callId: string; workspaceId: string } }>(result: R) {
  return { ...result, data: { ...result.data, callToken: issueCallToken(result.data.workspaceId, result.data.callId) } }
}

/**
 * Registers a live call in a workspace: finds or creates the caller and opens the call. On the path to
 * the greeting, so it does nothing else: stale calls and unreported recordings are the API's minute
 * sweeps (stale-calls.ts, orphan-recordings.ts).
 */
async function openCall(
  { tx, now }: Pick<HandlerCtx, 'tx' | 'now'>,
  workspace_id: string,
  { from, to, room, source = 'phone', label, assistant, attestation, spamLikely, newCaller = false }: OpenCall,
) {
  const [workspace] = await tx
    .select({ disabledAt: organization.disabledAt })
    .from(organization)
    .where(eq(organization.id, workspace_id))
  // A phone number always has its workspace; a test call names it, so it has to exist.
  if (!workspace && source === 'test') throw Reject.t('server.api.noSuchWorkspace')
  if (workspace?.disabledAt) throw Reject.t('server.api.workspaceOfDisabled', { label })
  // A withheld or malformed caller ID ("anonymous", "restricted") names nobody: no contact (all such
  // callers would share one), so no bookings to change and nothing to block.
  const contact = source === 'test' || isE164(from) ? await callerContact(tx, workspace_id, from, source) : null
  // A second call.start for the room of a live billed call (the agent's request timed out after the first one
  // committed, and LiveKit dispatched the job again): that call is answered again, never a second one opened beside it,
  // so no phantom call holds a reservation or is billed (security review of #864, L4). Unbilled calls as before.
  const again = source === 'phone' && room ? await liveBilledCallInRoom(tx, workspace_id, room) : null
  const id = again?.id ?? newId('call')
  // A blocked caller is not answered: the call is filed quietly in Spam and the agent hangs up (`blocked`).
  const spam = !again && source !== 'test' && !!contact?.row.blocked_at
  // Over the workspace's monthly spending cap: not answered by the assistant (spending-cap.ts), filed like a busy call.
  // A simulated call (the call simulator) costs nothing and holds no line: no cap, no live-call limit.
  const cap = source === 'phone' && !spam && !again ? await spendingCap(tx, workspace_id, now) : null
  const overCap = !!cap?.reached
  const busyAt = source === 'phone' && !spam && !overCap && !again ? await atLiveCallLimit(tx, workspace_id, now) : null
  const busy = busyAt !== null
  // The fixed line and nothing else so far: spam, busy, over the admin's cap. Billing may refuse the call below too.
  const unanswered = spam || busy || overCap
  // The owner calling from their own phone to try it out: kept on the call, so it never counts as a real caller.
  const fromOwnNumber = source === 'phone' && isE164(from) && (await isOwnNumber(tx, workspace_id, from))
  // The business's time zone (Workspace settings › General): the assistant is told the date and time in it.
  const [zone] = await tx
    .select({
      timezone: workspace_settings.timezone,
      country: workspace_settings.country,
      holidays: workspace_settings.holidays,
      country_hint: workspace_settings.country_hint,
      country_hint_source: workspace_settings.country_hint_source,
    })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspace_id))
  const timeZone = zone?.timezone ?? DEFAULT_TIME_ZONE
  // Where the business is (Workspace settings › General, else worked out) and its country's language: the region numbers callers
  // say are read in, the greeting's language when the assistant has none of its own. The texts a call that is not
  // answered is filed with are in the language the call is answered in, like its summary (callLanguageOf).
  const locale = await workspaceLocale(tx, workspace_id, zone ?? null)
  const t = teamT(callLanguageOf(assistant, locale.resolvedLanguage))
  // The agent answers with the assistant's pipeline, or the one the instance admin picked for every workspace. On
  // Linedesk Cloud the call's level is decided here, once: a voice or model the workspace may no longer use (its level
  // turned off) falls back to the install's defaults for this call.
  // On Cloud it is also what the agent answers with (`pipeline`): never a realtime model off Ultra, never the
  // install's own models when they are not Standard. A call still `not_allowed` after the fallback is not answered.
  const forCall = assistant && (await assistantForCall(tx, workspace_id, assistant))
  // Linedesk Cloud: a phone call of a workspace on a bill passes the billing gate (call-billing.ts), which reserves it
  // or refuses it. Null on every install and workspace that is not billed: the call goes on as before.
  const bill = source === 'phone' && !unanswered && !again ? await billOfCall(tx, workspace_id, now) : null
  let [call] = again
    ? [again]
    : await tx
        .insert(calls)
        .values({
          id,
          workspace_id,
          contact_id: contact?.row.id ?? null,
          from_number: from,
          to_number: to,
          source,
          started_at: now,
          room: room ?? id,
          from_own_number: fromOwnNumber,
          caller_attestation: source === 'phone' ? (attestation ?? null) : null,
          spam_likely: source === 'phone' && spamLikely === true,
          assistant_id: assistant?.id ?? null,
          assistant_version: await versionForCall(tx, workspace_id, assistant?.id),
          // White-label own keys (S7): forecast on the partner's keys; the agent reads them for this call only.
          partner_keys: forCall?.level === 'own_keys',
          ...(spam
            ? blockedCall(now, t)
            : overCap
              ? overCapCall(now, t)
              : busyAt !== null
                ? busyCall(now, t, busyAt)
                : {}),
        })
        .returning()
  // Refused by billing (no balance, too many calls on the bill, the plan not active, billing switched on but not
  // working, a voice or model the plan does not allow): the same fixed line as over the spending cap, filed as missed
  // with "Call back" and the reason. The API refuses these itself, never relying on the agent.
  let refused: CallRefusal | null = null
  // A white-label client's monthly usage limit its partner set (usage-limit.ts), read once for the check and the email.
  const limit: UsageLimit | null = bill ? await usageLimit(tx, workspace_id, now) : null
  if (bill && !bill.usable) refused = 'billing_error'
  else if (bill && forCall?.level === 'not_allowed') refused = 'level_not_allowed'
  // An extra number whose month could not be paid answers with the fixed line until it is paid.
  else if (bill && (await numberUnpaid(tx, workspace_id, to))) refused = 'number_unpaid'
  // A white-label client at the monthly usage limit its partner set (usage-limit.ts): the same fixed line, filed as
  // missed. Checked only here, when a call starts: a running call is never cut.
  else if (bill && limit?.reached) refused = 'usage_limit'
  else if (bill) {
    const gate = await gateCall(tx, {
      callId: id,
      billId: bill.billId,
      workspaceId: workspace_id,
      assistant,
      level: forCall?.level ?? null,
      paidLevel: forCall?.paidLevel ?? null,
      now,
    })
    if (!gate.allow) refused = gate.reason
  }
  if (refused)
    [call] = await tx
      .update(calls)
      .set(refusedCall(now, t, refused))
      .where(eq(calls.id, id))
      .returning()
  // Older agents only know `blocked`: hang up without answering. It covers every call that is not answered.
  const blocked = unanswered || !!refused
  if (!again) await recordCallStarted(tx, call!, spam)
  // Integrations (Zapier) hear of answered phone calls only: not spam, busy, over the cap or refused.
  if (!again && !unanswered && !refused) await queueCallStarted(tx, call!)
  // A busy call is filed as missed right away: the team hears of it like of any other finished call.
  if (busy || overCap || refused) await queueCallPush(tx, id, 'finished')
  // All calls at the same time were in use: the bill owner hears it once a day (Settings › Billing has more).
  if (busy || refused === 'too_many_calls') await busyLineAlert(tx, workspace_id, now, timeZone)
  // The cap may have been lowered below this month's spend since the last call: the 100 % email goes out now then.
  if (overCap) await queueSpendingAlerts(tx, workspace_id, now, cap)
  // Likewise a usage limit lowered below this period's use: the partner team's 100 % email goes out now then.
  if (refused === 'usage_limit') await queueUsageLimitAlerts(tx, workspace_id, now, limit)
  const businessHours = await businessHoursFor(tx, workspace_id, now)
  // Caller ID is cheap to fake: unless the carrier vouched for the number (or the owner turned the check off), the
  // caller is handled like one from an unknown number (no booking changes, no history, no name or note). The contact
  // stays linked to the call for the team.
  const recognized = callerRecognized(source, attestation, assistant?.behaviours)
  // What the assistant may know about the caller: a recognized caller's contact, unless the call test asked for a new
  // caller (LIN-531), whose number's earlier test calls must not steer the assistant.
  const known = recognized && !newCaller
  const booking = blocked
    ? null
    : await bookingContext(tx, workspace_id, now, {
        contactId: known ? (contact?.row.id ?? null) : null,
        assistantId: assistant?.id ?? null,
      })
  // Said right after the greeting; the agent appends it (null: off).
  const recordingNotice = blocked ? null : await recordingNoticeFor(tx, workspace_id)
  // "Don't keep" recordings: the agent does not record at all (the transcript comes from live speech recognition).
  const keepRecording = await keepsRecordings(tx, workspace_id)
  // A returning caller's last calls and upcoming bookings: only a phone caller matched to a contact, and only when the
  // assistant's owner leaves "Know the caller's previous calls" on.
  const history =
    source !== 'test' && contact && known && !blocked && behaviourOn(assistant?.behaviours, 'caller_history')
      ? await callerHistory(tx, workspace_id, contact.row, {
          callId: id,
          now,
          canChangeBookings: booking?.canChangeBookings === true,
        })
      : null
  // What the assistant can ask the business's system during the call (its webhook's during-call lookups).
  const lookups = blocked ? [] : await duringCallLookups(tx, assistant?.id)
  // The business's Shopify store: the changes the assistant may offer and the checks they need (shopify-calls.ts).
  const shopify = blocked ? null : await shopifyCallSetup(tx, workspace_id)
  // What answers: the level the call runs on (Ultra: the realtime model), with the models named (assistantForCall).
  const answeredBy = forCall?.assistant
  return {
    rows: { calls: [call!], ...(contact ? { contacts: [contact.row] } : {}) },
    data: {
      callId: id,
      workspaceId: workspace_id,
      isNewContact: contact?.isNew ?? false,
      contact: contact ? contactForAssistant(contact.row, known) : null,
      callerRecognized: recognized,
      assistant: answeredBy ?? null,
      blocked,
      busy,
      overCap,
      refused,
      businessHours,
      booking,
      recordingNotice,
      keepRecording,
      callerHistory: history,
      timeZone,
      lookups,
      shopify,
      workspaceCountry: locale.resolvedCountry,
      workspaceLanguage: locale.resolvedLanguage,
      usageLevel: forCall?.level ?? null,
      // White-label own keys (S7): the agent reads the partner's keys for this call (GET /v1/agent/call-provider-config).
      keys: call!.partner_keys && !blocked ? ('partner' as const) : null,
      // The speech recognition model of the level that answers (Server admin › Settings › Calls › Call quality).
      sttModel: forCall?.sttModel ?? null,
      // The instance admin's wording for parts of the system prompt (Server admin › System prompt; LIN-346).
      promptOverrides: blocked ? {} : await promptOverridesForCall(tx),
    },
  }
}

/**
 * The live phone call in this room of the workspace that holds a billing reservation, if any. Locked by the room's
 * name first, so two call.starts for one room never both open a billed call.
 */
async function liveBilledCallInRoom(tx: Tx, workspace_id: string, room: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`call-room:${room}`}, 0))`)
  const [live] = await tx
    .select({ call: calls })
    .from(calls)
    .innerJoin(call_reservations, eq(call_reservations.call_id, calls.id))
    .where(
      and(
        eq(calls.workspace_id, workspace_id),
        eq(calls.room, room),
        eq(calls.source, 'phone'),
        eq(calls.status, 'live'),
      ),
    )
  return live?.call ?? null
}

/** The contact with this number: found (a merged one's survivor, a deleted one restored) or created. */
async function callerContact(tx: Tx, workspace_id: string, phone: string, source: 'phone' | 'test' | 'simulated') {
  let [contact] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspace_id, workspace_id), eq(contacts.phone, phone)))
  // A number of a contact that was merged into another one belongs to that one now.
  if (contact?.merged_into)
    [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspace_id, workspace_id), eq(contacts.id, contact.merged_into)))
  // A deleted contact who calls again is back in Contacts.
  if (contact?.deleted_at)
    [contact] = await tx.update(contacts).set({ deleted_at: null }).where(eq(contacts.id, contact.id)).returning()
  if (contact) return { row: contact, isNew: false }
  const name = source === 'test' ? testCallContact.name : null
  const [created] = await tx
    .insert(contacts)
    .values({ id: newId('ct'), workspace_id, phone, name })
    .returning()
  return { row: created!, isNew: true }
}

type Outcome = NonNullable<(typeof calls.$inferSelect)['outcome']>
type Urgency = (typeof calls.$inferSelect)['urgency']

/**
 * A call flagged urgent while it ran (the assistant, a transfer) stays urgent and out of Spam: the summary reads
 * what the caller said, and a caller could talk it into "spam" or "low". Spam becomes a callback then.
 */
export function keptUrgent(
  current: Urgency,
  outcome: Outcome,
  urgency: Urgency,
): { outcome: Outcome; urgency: Urgency } {
  if (current !== 'urgent') return { outcome, urgency }
  return { outcome: outcome === 'spam' ? 'callback' : outcome, urgency: 'urgent' }
}

/**
 * Calls the assistant of a workspace that is on no bill (self-host) answers at the same time. One more is not answered:
 * filed as missed, so the team calls back, and the agent hangs up. Every call costs speech and model minutes; nobody
 * can run up a bill with many lines at once. A billed workspace follows the billing rules instead (`liveCallLimit`).
 */
export const LIVE_CALLS_PER_WORKSPACE = liveCallsPerWorkspace()

/**
 * LIVE_CALLS_PER_WORKSPACE from the environment: a whole number from 1 to 100, else the default 5. Raised only for a
 * capacity check (many test calls to one number), then put back (docs/commands.md, "Load test").
 */
export function liveCallsPerWorkspace(env: { LIVE_CALLS_PER_WORKSPACE?: string } = process.env): number {
  const raw = env.LIVE_CALLS_PER_WORKSPACE?.trim()
  const value = raw ? Number(raw) : Number.NaN
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 5
}
/**
 * Live calls started longer ago than the assistant stays on a call (plus a margin) are not counted: their agent is
 * gone, or they were put through to a person and cost no assistant minutes any more.
 */
const LIVE_CALL_MAX_MS = (ASSISTANT_CALL_MAX_MINUTES + 5) * 60_000

/**
 * The phone calls a workspace's assistant answers at once (LIN-450). On a bill: an instance admin's cap for the bill
 * (Server admin › Billing, `billing.setConcurrency`), else the billing rules' included calls plus the extra calls its
 * owner bought (Settings › Billing). On no bill: LIVE_CALLS_PER_WORKSPACE plus any extra calls.
 */
export async function liveCallLimit(tx: Tx, workspace_id: string): Promise<number> {
  const [row] = await tx
    .select({
      extra: organization.extraCalls,
      bill: organization.billingAccountId,
      cap: billing_accounts.concurrent_calls_cap,
    })
    .from(organization)
    .leftJoin(billing_accounts, eq(billing_accounts.id, organization.billingAccountId))
    .where(eq(organization.id, workspace_id))
  if (!row?.bill) return LIVE_CALLS_PER_WORKSPACE + (row?.extra ?? 0)
  return row.cap ?? workspaceCallLimit(row.extra, await billingRules(tx))
}

/**
 * The workspace's limit when it has as many phone calls in progress as its assistant answers at once, else null (test
 * calls have their own limits).
 */
async function atLiveCallLimit(tx: Tx, workspace_id: string, now: string): Promise<number | null> {
  // Two calls arriving at once cannot both see room for one more.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`live-calls:${workspace_id}`}))`)
  const [row] = await tx
    .select({ live: sql<number>`count(*)::int` })
    .from(calls)
    .where(
      and(
        eq(calls.workspace_id, workspace_id),
        eq(calls.status, 'live'),
        eq(calls.source, 'phone'),
        gt(calls.started_at, new Date(Date.parse(now) - LIVE_CALL_MAX_MS).toISOString()),
      ),
    )
  const limit = await liveCallLimit(tx, workspace_id)
  return (row?.live ?? 0) >= limit ? limit : null
}

/**
 * A call over the workspace's limit of calls at once: filed as missed, unread, with a callback. The agent tells the
 * caller the lines are busy and hangs up (BUSY_LINE in apps/agent).
 */
const busyCall = (now: string, t: TeamT, limit: number) => ({
  status: 'completed' as const,
  ended_at: now,
  duration_sec: 0,
  outcome: 'hangup' as const,
  title: t('call.autoSummary.missed.title'),
  summary: t('call.autoSummary.missed.busy', { count: limit }),
  action_items: [{ text: t('call.autoSummary.missed.callBack') }],
})

/**
 * A call while the workspace is over its monthly spending cap: filed as missed, unread, with a callback. The agent
 * tells the caller the business will call back and hangs up (OVER_CAP_LINE in apps/agent).
 */
const overCapCall = (now: string, t: TeamT) => ({
  status: 'completed' as const,
  ended_at: now,
  duration_sec: 0,
  outcome: 'hangup' as const,
  title: t('call.autoSummary.missed.title'),
  summary: t('call.autoSummary.missed.overCap'),
  action_items: [{ text: t('call.autoSummary.missed.callBack') }],
})

/**
 * A call the billing gate refused (call-billing.ts): filed as missed, unread, with a callback and the reason. The agent
 * says the same line as over the spending cap (the business will call back) and hangs up.
 */
// i18n-dynamic: call.autoSummary.missed.billing.*
const refusedCall = (now: string, t: TeamT, reason: CallRefusal) => ({
  status: 'completed' as const,
  ended_at: now,
  duration_sec: 0,
  outcome: 'hangup' as const,
  title: t('call.autoSummary.missed.title'),
  summary: t(`call.autoSummary.missed.billing.${reason}`),
  action_items: [{ text: t('call.autoSummary.missed.callBack') }],
})

/** A call from a blocked number: over before it began, read, in Spam. */
const blockedCall = (now: string, t: TeamT) => ({
  status: 'completed' as const,
  ended_at: now,
  duration_sec: 0,
  outcome: 'spam' as const,
  unread: false,
  title: t('call.autoSummary.blocked.title'),
  summary: t('call.autoSummary.blocked.summary'),
})

/**
 * `t()` for the texts filed on a call for the team: in the language the call is answered in like the call summaries
 * (callLanguageOf; written once per call, emails, webhooks and exports carry them too), the closest UI language, else
 * English.
 */
type TeamT = Translator['t']
const teamT = (language: string): TeamT => getT(matchLocale([language])).t

/**
 * The on-call number is a person's phone, never a Linedesk number (the workspace's own or any other on the
 * install) nor a business line that forwards to one of the workspace's own numbers (`forwarded_from`): a transfer
 * there would ring back into Linedesk and be answered by an assistant. Another workspace's `forwarded_from` does not
 * count: a forwarding check saves it from a caller ID, which can be faked, so it must never lock anyone else out.
 */
async function checkOnCallNotLinedesk(tx: HandlerCtx['tx'], workspaceId: string, e164: string, name: string) {
  // The destination policy: a country the workspace may call, a landline or mobile (outbound-policy.ts).
  const refusal = await outboundRefusal(tx, workspaceId, e164, 'transfer')
  if (refusal) throw new Reject(`${name}: ${refusal}`)
  const [linedesk] = await tx
    .select({ e164: phone_numbers.e164 })
    .from(phone_numbers)
    .where(
      or(
        eq(phone_numbers.e164, e164),
        and(eq(phone_numbers.forwarded_from, e164), eq(phone_numbers.workspace_id, workspaceId)),
      ),
    )
    .limit(1)
  if (!linedesk) return
  throw new Reject(
    linedesk.e164 === e164
      ? `${name}'s number is a ${brandName()} number; enter the person's own phone`
      : `${name}'s number forwards its calls to ${brandName()}; enter the person's own phone`,
  )
}

/**
 * An assistant may speak only languages its calls' voice speaks: on the three stages its own voice with the voice model
 * the call uses (assistantVoiceOf), else (a realtime model answers) any voice provider of the install (installLanguages);
 * the main one and the picked ones. Those the assistant already has stay saveable while its voice stays (the voice
 * providers may have changed since; a call then leaves out what its voice can't speak), and `any` stays allowed: a call
 * then speaks every language the voice does. A save that changes the voice checks them all again. A hidden language
 * (HIDDEN_LANGUAGES, its test calls failed) is refused as a new choice, whatever the voice; one the assistant already
 * has stays saveable.
 */
async function checkAssistantLanguages(
  tx: Tx,
  workspaceId: string,
  assistantId: string,
  languages: StoredLanguages,
  change: { voice?: AssistantVoice; call_quality?: CallQuality } = {},
) {
  const stored = await assistantIn(tx, workspaceId, assistantId)
  if (!stored) throw Reject.t('server.api.noSuchAssistant')
  const voice = change.voice ?? stored.voice
  const voiceChanged =
    voice.provider !== stored.voice.provider ||
    voice.voice_id !== stored.voice.voice_id ||
    (voice.model ?? '') !== (stored.voice.model ?? '')
  const had = unspokenLanguages(stored.languages, [])
  const hidden = unspokenLanguages(languages, []).filter(code => !isPickable(code) && !had.includes(code))
  if (hidden.length)
    throw Reject.t('server.api.languageHidden', {
      languages: (reader: Reader) => reader.format.list(hidden.map(code => languageInSentence(code, reader.locale))),
    })
  // A new language the speech recognition does not hear (AssemblyAI: Polish and five more) is refused; one the
  // assistant already has is kept (the call leaves it out, callLanguagesOf).
  const hearing = await installHearing(tx)
  const unheard = unspokenLanguages(languages, heardLanguages(languageCodes, hearing)).filter(
    code => !had.includes(code),
  )
  if (unheard.length && hearing)
    throw Reject.t('server.api.sttCantHear', {
      stt: providerSpec(hearing.provider as ProviderName).label,
      languages: (reader: Reader) => reader.format.list(unheard.map(code => languageInSentence(code, reader.locale))),
    })
  const kept = voiceChanged ? [] : had
  const callVoice = await assistantVoiceOf(tx, {
    voice,
    llm_model: stored.llm_model,
    call_quality: change.call_quality ?? stored.call_quality,
  })
  const spoken = callVoice ? spokenLanguages([callVoice]) : await installLanguages(tx)
  const missing = unspokenLanguages(languages, spoken).filter(code => !kept.includes(code))
  if (!missing.length) return
  // The languages by their names in the reader's language ("Spanisch und Französisch" in German).
  const names = (reader: Reader) => reader.format.list(missing.map(code => languageInSentence(code, reader.locale)))
  throw callVoice
    ? Reject.t('server.api.voiceCantSpeak', { voice: callVoice.model || callVoice.provider, languages: names })
    : Reject.t('server.api.voicesCantSpeak', { languages: names })
}
type StoredLanguages = Parameters<typeof unspokenLanguages>[0]

type LevelInput = {
  assistantId: string
  voice?: AssistantVoice
  llm_model?: string | null
  call_quality?: CallQuality
  realtime_model?: string | null
}
/** Whether an assistant.update names what decides its calls' level: the level, the voice or a model. */
const choosesLevel = (input: LevelInput) =>
  input.voice !== undefined ||
  input.llm_model !== undefined ||
  input.call_quality !== undefined ||
  input.realtime_model !== undefined

/**
 * An assistant's level and model picks after a save (assistant.update): the level must be on, a raise is for a
 * workspace owner or admin and a white-label client's people change it only where the partner lets them
 * (refuseLevelChange), each pick must belong to the level. A new level clears the picks of the old one that do
 * not belong to it (picksForLevel), unless the save names them. Returns what the save writes of them, and the change
 * for the audit log (null: nothing that decides the level changed).
 */
async function checkAssistantChoices(
  tx: Tx,
  actor: Actor,
  input: LevelInput,
): Promise<{ set: Partial<LevelFields>; change: UsageLevelChange | null }> {
  const workspaceId = actor.workspaceId!
  const stored = await assistantIn(tx, workspaceId, input.assistantId)
  if (!stored) throw Reject.t('server.api.noSuchAssistant')
  const level = input.call_quality ?? stored.call_quality
  const levelChanged = level !== stored.call_quality
  const kept = levelChanged ? await picksForLevel(tx, stored, level) : stored
  const after: LevelFields = {
    call_quality: level,
    voice: input.voice ?? kept.voice,
    llm_model: input.llm_model !== undefined ? input.llm_model : kept.llm_model,
    realtime_model: input.realtime_model !== undefined ? input.realtime_model : kept.realtime_model,
  }
  // A save that leaves them as they are (the web app sends the voice with every save) is never refused over them.
  const change = usageLevelChange(stored, after)
  if (!change) return { set: {}, change: null }
  // Who may change it, before what the save names is checked: a refused caller learns nothing about the lists.
  await refuseLevelChange(tx, actor, {
    raises: raisesLevel(stored.call_quality, level),
    changesQuality: changesQualityPicks(stored, after),
  })
  if (input.voice?.model && !voiceModelLevel(input.voice.provider, input.voice.model))
    throw new Reject(
      `${input.voice.model} is not a voice model of ${input.voice.provider} here: pick one of voice.options`,
    )
  if (input.llm_model) {
    const llm = await activeProvider(tx, 'llm').catch(() => null)
    if (!llm || !languageModelLevel(llm.provider, input.llm_model))
      throw new Reject(
        `${input.llm_model} is not a language model of this server's provider: pick one of voice.options`,
      )
  }
  if (input.realtime_model && !realtimeModelLevel(input.realtime_model))
    throw new Reject(`${input.realtime_model} is not a realtime model an assistant can pick: pick one of voice.options`)
  await checkAssistantLevel(tx, after, { levelChanged })
  return {
    set: levelChanged
      ? { call_quality: level, voice: after.voice, llm_model: after.llm_model, realtime_model: after.realtime_model }
      : {},
    change,
  }
}

type LevelFields = Pick<Assistant, 'voice' | 'llm_model' | 'call_quality'> & { realtime_model?: string | null }

/**
 * Whether a save changes what the call quality block picks: the level, the language or realtime model, or a voice model
 * picked for the same voice provider. A voice of another provider without a model (the voice picker) leaves its model
 * to the defaults and is no call quality change, so a white-label client's people still pick a voice where the partner
 * keeps call quality (decision of 2026-11-18). One that names a model picks it, and is one.
 */
function changesQualityPicks(stored: LevelFields, after: LevelFields) {
  if (stored.call_quality !== after.call_quality) return true
  if ((stored.llm_model ?? null) !== (after.llm_model ?? null)) return true
  if ((stored.realtime_model ?? null) !== (after.realtime_model ?? null)) return true
  if (stored.voice.provider !== after.voice.provider) return Boolean(after.voice.model)
  return (stored.voice.model || null) !== (after.voice.model || null)
}

/** What decides a call's level, as the audit log keeps it: the level, the voice model, the language model. */
const levelFieldsOf = (a: LevelFields) => ({
  call_quality: a.call_quality,
  voice_model: a.voice.model ? `${a.voice.provider}/${a.voice.model}` : null,
  llm_model: a.llm_model ?? null,
  realtime_model: a.realtime_model ?? null,
})
/** A change of what decides the level (who doubled the bill), for the audit log: before and after; null: none. */
export type UsageLevelChange = { before: ReturnType<typeof levelFieldsOf>; after: ReturnType<typeof levelFieldsOf> }
function usageLevelChange(stored: LevelFields, after: LevelFields): UsageLevelChange | null {
  const before = levelFieldsOf(stored)
  const now = levelFieldsOf(after)
  return JSON.stringify(before) === JSON.stringify(now) ? null : { before, after: now }
}

/** Actions with work before their transaction (handler-context.ts, Preparer). */
export const preparers: Record<string, Preparer> = {
  ...voicePreparers,
  ...authenticatorPreparers,
  ...stripeEventPreparers,
  ...checkoutPreparers,
  ...billingPagePreparers,
  ...partnerKeyPreparers,
  ...partnerSenderPreparers,
  ...partnerDomainPreparers,
  ...workspaceDeletePreparers,
}

/**
 * The next steps the API itself put on a call while it ran (BOOKING_MISSES_NOTE when booking changes were locked):
 * call.finish replaces the assistant's list, these stay. Messages the assistant took come back in its list.
 */
/**
 * Names the call's contact with the name the caller gave, when it has none yet; kept as a caller's, so it unlocks
 * nothing on later calls (contacts.name_source). `replacing`: a name an earlier summary of this call gave, which a
 * better one replaces. The contacts written, or null.
 */
async function nameCaller(tx: Tx, contactId: string | null, name: string | undefined, replacing?: string) {
  if (!name || !contactId) return null
  const [contact] = await tx.select().from(contacts).where(eq(contacts.id, contactId))
  const replaces = !!replacing && contact?.name === replacing && contact.name_source === 'caller'
  if (!contact || (contact.name && !replaces) || contact.name === name) return null
  return tx.update(contacts).set({ name, name_source: 'caller' }).where(eq(contacts.id, contact.id)).returning()
}

export const teamNotesOf = (stored: ActionItem[], finished: { text: string }[]) =>
  stored.filter(item => item.kind !== 'message' && !finished.some(f => f.text === item.text))

/**
 * Whether connecting a number that is already in the carrier account is refused for this actor. The install's account
 * (whatever carrier it is: Telnyx, Twilio, any other adapter) is shared by every workspace: only an instance admin may
 * hand one of its numbers to a workspace, whatever the workspace's bill (none, comped, paying); others buy a new one or
 * bring their own account (Janik, 2026-11-19, LIN-626). The workspace's own account and `dev` (no account) are never
 * refused. The app shows the link by the same rule (canAttach, onboarding.ts).
 */
const attachRefused = (actor: Actor, { account, provider }: { account: 'install' | 'workspace'; provider: string }) =>
  account === 'install' && provider !== 'dev' && !actor.permissions.includes('instance:admin')

const handlers: Record<string, Handler> = {
  // The patch, plus: a voice must be one the workspace may use, and a clone it stops using is released.
  'assistant.update': async (ctx, input) => {
    if (!ctx.actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    // The version lock first (withVersion took it already; taking it again does not wait), as a level turned off and a
    // payer change take it before they move the assistants: everything read below is what the save writes over.
    await lockAssistantVersion(ctx.tx, input.assistantId)
    if (input.voice) await checkAssistantVoice(ctx.tx, ctx.actor.workspaceId, input.voice)
    // A new main language moves an untouched default voice along (followLanguageDefault); a voice picked by name stays.
    if (input.languages && !input.voice) {
      const stored = await assistantIn(ctx.tx, ctx.actor.workspaceId, input.assistantId)
      const workspaceLanguage = (await workspaceLocale(ctx.tx, ctx.actor.workspaceId)).resolvedLanguage
      const followed =
        stored &&
        followLanguageDefault(
          stored.voice,
          mainLanguageOf(stored.languages, workspaceLanguage),
          mainLanguageOf(input.languages, workspaceLanguage),
        )
      if (followed) input = { ...input, voice: followed }
    }
    // The languages against the voice the calls speak with: again when the voice or the level changes.
    if (input.languages || input.voice || input.call_quality !== undefined) {
      const languages =
        input.languages ?? (await assistantIn(ctx.tx, ctx.actor.workspaceId, input.assistantId))?.languages
      if (input.languages || languages)
        await checkAssistantLanguages(ctx.tx, ctx.actor.workspaceId, input.assistantId, languages, {
          voice: input.voice,
          call_quality: input.call_quality,
        })
    }
    // Only contacts that can be dialled: one switched off because its line forwards to Linedesk
    // (switchOffLoopingTransfers) keeps its number, and the rest of the list stays editable.
    for (const contact of (input.transfers ?? []) as TransferContact[])
      if (isActiveContact(contact))
        await checkOnCallNotLinedesk(ctx.tx, ctx.actor.workspaceId, contact.number!, contact.name)
    const before = input.transfers ? await assistantTransfers(ctx.tx, ctx.actor.workspaceId, input.assistantId) : null
    const rulesBefore =
      input.email_rules !== undefined
        ? ((await assistantIn(ctx.tx, ctx.actor.workspaceId, input.assistantId))?.email_rules ?? null)
        : undefined
    // The level and the models it will answer with: on, of the lists and of the level; a raise only by an owner or admin.
    const level = choosesLevel(input) ? await checkAssistantChoices(ctx.tx, ctx.actor, input) : null
    const levelChange = level?.change ?? null
    const result = await runPatch(ctx, actions.get('assistant.update')!, { ...input, ...level?.set })
    if (input.voice) await releaseUnusedClones(ctx.tx, ctx.actor.workspaceId)
    if (setsTransferNumber(input)) await recordSetupEvent(ctx.tx, ctx.actor.workspaceId, 'mobile_added', ctx.now)
    // A change of the numbers calls are put through to is in the audit log (audit.ts, TRANSFER_CHANGE_ACTIONS).
    const changes = before && transferChanges(before, input.transfers as TransferContact[])
    // So is a change of the voice model, language model or pipeline (audit.ts, usageLevelChange): what the calls cost.
    // And a change of the call email rules (audit.ts, emailRoutingChanges): who they added and removed, no text.
    const routingChanges =
      rulesBefore !== undefined ? await emailRoutingChangesIn(ctx.tx, rulesBefore, input.email_rules) : null
    if (!changes && !levelChange && !routingChanges) return result
    return {
      ...result,
      data: {
        ...(changes ? { transferChanges: changes } : {}),
        ...(levelChange ? { usageLevelChange: levelChange } : {}),
        ...(routingChanges ? { emailRoutingChanges: routingChanges } : {}),
      },
    }
  },

  // An earlier version back, as a new version: the same checks as assistant.update. Its calendars are matched to the
  // linked ones; one no longer linked is named in the result, one linked since is switched off.
  'assistant.restoreVersion': async ({ tx, actor }, input: { assistantId: string; number: number }) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const workspaceId = actor.workspaceId
    // The version lock first, as every save and a level turned off take it: what is read below cannot change before the
    // restore writes (a level turned off waits, or has moved the assistant already and the level check sees it).
    await lockAssistantVersion(tx, input.assistantId)
    const current = (await assistantIn(tx, workspaceId, input.assistantId))!
    const { settings } = await versionOf(tx, workspaceId, input.assistantId, input.number)
    const { calendars: kept, ...fields } = settings
    if (actor.emailUnverified && setsTransferNumber(fields)) throw Forbidden.t('server.api.confirmEmailForTransfer')
    await checkAssistantVoice(tx, workspaceId, fields.voice).catch(e => {
      throw Reject.t('server.api.versionVoiceGone', { number: input.number, error: errorMessage(e) })
    })
    // A version from before call quality has no level: Standard, the column's default (as the check and the audit
    // below assume), its picks only where they belong to it.
    const versionLevel: CallQuality = fields.call_quality ?? 'standard'
    if (fields.languages)
      await checkAssistantLanguages(tx, workspaceId, input.assistantId, fields.languages, {
        voice: fields.voice,
        call_quality: versionLevel,
      }).catch(e => {
        throw Reject.t('server.api.versionLanguagesGone', { number: input.number, error: errorMessage(e) })
      })
    for (const contact of fields.transfers ?? [])
      if (contact.number) await checkOnCallNotLinedesk(tx, workspaceId, contact.number, contact.name)
    // Like assistant.update: checked only when the version changes the level or a model.
    const levelAfter = {
      call_quality: versionLevel,
      ...(await picksForLevel(
        tx,
        { voice: fields.voice, llm_model: fields.llm_model ?? null, realtime_model: fields.realtime_model ?? null },
        versionLevel,
      )),
    }
    const levelChange = usageLevelChange(current, levelAfter)
    if (levelChange) {
      await checkAssistantLevel(tx, levelAfter, { levelChanged: versionLevel !== current.call_quality }).catch(e => {
        throw Reject.t('server.api.versionVoiceOrModelGone', { number: input.number, error: errorMessage(e) })
      })
      await refuseLevelChange(tx, actor, {
        raises: raisesLevel(current.call_quality, versionLevel),
        changesQuality: changesQualityPicks(current, levelAfter),
      })
    }
    const transfersBefore = await assistantTransfers(tx, workspaceId, input.assistantId)
    // A version from before a level column has no key for it: the column's default (null), as the check and the audit
    // above assume, not what the assistant has now.
    const restored = await tx
      .update(assistants)
      .set({
        ...fields,
        call_quality: levelAfter.call_quality,
        voice: levelAfter.voice,
        llm_model: levelAfter.llm_model,
        realtime_model: levelAfter.realtime_model,
      })
      .where(and(eq(assistants.id, input.assistantId), eq(assistants.workspace_id, workspaceId)))
      .returning()
    await releaseUnusedClones(tx, workspaceId)
    const linked = await tx
      .select()
      .from(assistant_calendars)
      .where(eq(assistant_calendars.assistant_id, input.assistantId))
    const keyOf = (c: { connection_id: string; external_id: string }) => `${c.connection_id}/${c.external_id}`
    const wanted = new Map(kept.map(c => [keyOf(c), c]))
    const calendars = []
    for (const row of linked) {
      const was = wanted.get(keyOf(row))
      const set = was
        ? { instruction: was.instruction, enabled: was.enabled, is_default: was.is_default }
        : { enabled: false, is_default: false }
      calendars.push(
        ...(await tx.update(assistant_calendars).set(set).where(eq(assistant_calendars.id, row.id)).returning()),
      )
    }
    // The assistant keeps a default while it has calendars: the version's, else the oldest one that is on.
    if (calendars.length && !calendars.some(c => c.is_default)) {
      const next =
        [...calendars].sort((a, b) => a.created_at.localeCompare(b.created_at)).find(c => c.enabled) ?? calendars[0]!
      const [updated] = await tx
        .update(assistant_calendars)
        .set({ is_default: true, enabled: true })
        .where(eq(assistant_calendars.id, next.id))
        .returning()
      calendars.splice(calendars.indexOf(next), 1, updated!)
    }
    const linkedKeys = new Set(linked.map(keyOf))
    const missingCalendars = kept.filter(c => !linkedKeys.has(keyOf(c))).map(c => c.name)
    const number = await recordVersion(tx, workspaceId, input.assistantId, {
      by: actor.actorId,
      restoredFrom: input.number,
    })
    const data: AssistantRestoreData = { number: number!, missingCalendars }
    const changes = transferChanges(transfersBefore, restored[0]?.transfers ?? [])
    return {
      rows: { assistants: restored, assistant_calendars: calendars },
      data: {
        ...data,
        ...(changes ? { transferChanges: changes } : {}),
        ...(levelChange ? { usageLevelChange: levelChange } : {}),
      },
    }
  },

  ...adminHandlers,
  ...providerHealthHandlers,
  ...assistantHandlers,
  ...assistantVersionHandlers,
  ...impersonationHandlers,
  ...teamHandlers,
  ...emailRecipientHandlers,
  ...workspaceCreationHandlers,
  ...teamMemberEditHandlers,
  ...membershipHandlers,
  ...workspaceSettingsHandlers,
  ...workspaceIconHandlers,
  ...userAvatarHandlers,
  ...authenticatorHandlers,
  ...publicHolidayHandlers,
  ...insightsHandlers,
  ...transferHandlers(businessHoursFor),
  ...voiceHandlers,
  ...systemPromptHandlers,
  ...brandingHandlers,
  ...sampleHandlers,
  ...goLiveChecklistHandlers,
  ...notificationHandlers,
  ...setupEmailHandlers,
  ...founderEmailHandlers,
  ...billingSettingsHandlers,
  ...billingAdminHandlers,
  ...stripeEventHandlers,
  ...billingOwnerHandlers,
  ...selfServeHandlers,
  ...termsUpdateHandlers,
  ...partnerHandlers,
  ...partnerBrandHandlers,
  ...partnerKeyHandlers,
  ...partnerSenderHandlers,
  ...partnerDomainHandlers,
  ...partnerSetupHandlers,
  ...germanNumbersHandlers,
  ...signupAccessHandlers,
  ...checkoutHandlers,
  ...billingPageHandlers,
  ...starHandlers,
  ...feedbackHandlers,
  ...pushHandlers,
  ...calendarConnectionHandlers,
  ...appConnectionHandlers,
  ...shopifyCallHandlers,
  ...mailConnectionHandlers,
  ...mailAnalysisHandlers(queueMailAnalysis),
  ...appPushHandlers,
  ...calendarToolHandlers,
  ...carrierHandlers(),
  ...forwardingCheckHandlers(queueForwardingCheck),
  ...transferTrunkHandlers(),
  ...outboundHandlers(),
  ...liveCallHandlers(),
  ...apiKeyHandlers,
  ...personalKeyHandlers,
  ...oauthHandlers,
  ...recordHandlers,
  ...agentSetupHandlers,
  ...installSetupHandlers,
  ...bookingHandlers,
  ...evaluationHandlers(queueCallEvaluation),
  ...afterCallTranscriptHandlers,
  ...webhookHandlers,
  ...integrationHandlers,
  ...knowledgeHandlers,
  ...businessHandlers,
  ...knowledgeQuestionHandlers,
  ...callExportHandlers,

  // The patch, and the webhook payloads and command log entries that carry the call are cleared (they hold the caller's details).
  // `permanent`: erased now instead of after 30 days (data-purge.ts eraseCallNow), owners and admins only (call:erase).
  'call.delete': async (ctx, input) => {
    if (input.permanent && !ctx.actor.permissions.includes('call:erase'))
      throw Forbidden.t('server.api.eraseNeedsAdmin')
    const result = await runPatch(ctx, actions.get('call.delete')!, input)
    await clearCallPayloads(ctx.tx, ctx.actor.workspaceId!, input.callId)
    await purgeCommandsAbout(ctx.tx, ctx.actor.workspaceId!, 'callId', input.callId)
    // Its evaluation goes too (it quotes what went wrong on the call); a restored call can be evaluated again.
    await ctx.tx
      .delete(call_evaluations)
      .where(and(eq(call_evaluations.call_id, input.callId), eq(call_evaluations.workspace_id, ctx.actor.workspaceId!)))
    if (!input.permanent) return result
    await eraseCallNow(ctx.tx, ctx.actor.workspaceId!, input.callId, ctx.actor.actorId)
    return { rows: {} }
  },

  // The patch, and the command log keeps only ids of what was done to the contact (command-log.ts).
  'contact.delete': async (ctx, input) => {
    const result = await runPatch(ctx, actions.get('contact.delete')!, input)
    await purgeCommandsAbout(ctx.tx, ctx.actor.workspaceId!, 'contactId', input.contactId)
    return result
  },

  'contact.create': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const [existing] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspace_id, actor.workspaceId), eq(contacts.phone, input.phone)))
    if (existing && (!existing.deleted_at || existing.merged_into))
      throw Reject.t('server.api.alreadyContact', { phone: input.phone })
    const fields = {
      name: input.name ?? null,
      name_source: input.name ? ('member' as const) : null,
      company: input.company ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      note: input.note ?? null,
    }
    const [contact] = existing
      ? await tx
          .update(contacts)
          .set({ ...fields, deleted_at: null })
          .where(eq(contacts.id, existing.id))
          .returning()
      : await tx
          .insert(contacts)
          .values({ id: newId('ct'), workspace_id: actor.workspaceId, phone: input.phone, ...fields })
          .returning()
    return { rows: { contacts: [contact!] }, data: { contactId: contact!.id } }
  },

  ...contactImportHandlers,
  ...contactMergeHandlers,

  // Carriers may send numbers without the "+" or as 10 digits: both are read as E.164 first, so a caller is
  // matched to their contact and the dialled number to its workspace whatever the shape. Ten digits are a US
  // number only on a call to a +1 number: the dialled one can only match one of ours that is, and the caller's
  // is read that way only when it is.
  'call.start': async ({ tx, now }, input) => {
    const to = normalizeCallerId(input.to, { nationalUs: true })
    const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, to))
    if (!number) throw Reject.t('server.api.noWorkspaceForNumber', { number: input.to })
    const assistant = await assistantForNumber(tx, number.workspace_id, number.assistant_id)
    const from = normalizeCallerId(input.from, { nationalUs: number.e164.startsWith('+1') })
    // Our own forwarding check arriving: not answered, not filed, never a real call (forwarding-check.ts).
    const check = await claimForwardingCheck(tx, { from, to, now })
    if (check) return forwardingCheckStart(check)
    const newCaller = await claimNewCallerForTest(tx, { from, to, now })
    return withCallToken(
      await openCall({ tx, now }, number.workspace_id, {
        from,
        to,
        room: input.room,
        source: input.source,
        label: to,
        assistant,
        attestation: input.attestation,
        spamLikely: input.spamLikely,
        newCaller,
      }),
    )
  },

  // The agent only knows the workspace from the dispatch the API signed (assistant.startTestCall).
  'call.startTest': async ({ tx, actor, now }, input) => {
    if (!actor.workspaceId) throw new Reject('no workspace (send x-workspace-id)')
    // The assistant comes from the signed dispatch; it must still be one of this workspace's.
    const [workspace] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, actor.workspaceId))
    if (!workspace) throw Reject.t('server.api.noSuchWorkspace')
    const assistant = await assistantIn(tx, actor.workspaceId, input.assistantId)
    // A room is one test call: the browser's join token outlives the room, and rejoining would open a new call.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`test-room:${input.room}`}))`)
    // The dispatch the API signed ties a room to one workspace, so looking in it is enough (and uses its index).
    const [used] = await tx
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.workspace_id, actor.workspaceId), eq(calls.room, input.room)))
      .limit(1)
    if (used) throw new Reject('this test call has ended: start a new one')
    return withCallToken(
      await openCall({ tx, now }, actor.workspaceId, {
        from: testCallContact.phone,
        to: testCallContact.phone,
        room: input.room,
        source: 'test',
        label: 'this test call',
        assistant,
      }),
    )
  },

  'call.findForTest': async ({ tx, now, calendars }, input) => {
    const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, input.to))
    if (!number) throw Reject.t('server.api.numberNotSetUp', { number: input.to })
    // A phone call comes in on the number; a no-phone test call is found by its room. The first call since the moment:
    // a later call from the same test number is another run's (LIN-263: call-test took another session's call).
    const which = input.room
      ? eq(calls.room, input.room)
      : input.from
        ? and(eq(calls.from_number, input.from), eq(calls.to_number, input.to))
        : undefined
    const [call] = which
      ? await tx
          .select()
          .from(calls)
          .where(and(eq(calls.workspace_id, number.workspace_id), which, gte(calls.started_at, input.since)))
          .orderBy(asc(calls.started_at))
          .limit(1)
      : []
    const segments = call
      ? await tx
          .select({
            speaker: transcript_segments.speaker,
            text: transcript_segments.text,
            at_ms: transcript_segments.at_ms,
          })
          .from(transcript_segments)
          .where(eq(transcript_segments.call_id, call.id))
          .orderBy(asc(transcript_segments.at_ms))
      : []
    const count = (speaker: string) => segments.filter(s => s.speaker === speaker).length
    const data: CallTestFinding = {
      workspaceId: number.workspace_id,
      call: call
        ? {
            id: call.id,
            status: call.status,
            outcome: call.outcome,
            urgency: call.urgency,
            title: call.title,
            summary: call.summary,
            recording_key: call.recording_key,
            duration_sec: call.duration_sec,
            action_items: call.action_items.length,
            transfer_result: call.transfer_result,
          }
        : null,
      turns: { caller: count('caller'), agent: count('agent'), system: count('system') },
      lines: segments,
      bookingReady: (await bookingContext(tx, number.workspace_id, now, { assistantId: number.assistant_id })) !== null,
      bookings: call ? await bookingsForTest(tx, { calendars }, number.workspace_id, call.id) : [],
    }
    return { rows: {}, data }
  },

  // Only for a number of this install; the caller's number is read like call.start reads it, so the two match.
  'call.newCallerForTest': async ({ tx, now }, input) => {
    const to = normalizeCallerId(input.to, { nationalUs: true })
    const [number] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, to))
    if (!number) throw Reject.t('server.api.numberNotSetUp', { number: input.to })
    const from = normalizeCallerId(input.from, { nationalUs: to.startsWith('+1') })
    await expectNewCallerForTest(tx, { from, to, now })
    return { rows: {}, data: { from, to } }
  },

  'call.listNumbers': async ({ tx }) => {
    const numbers = await tx.select({ e164: phone_numbers.e164 }).from(phone_numbers).orderBy(asc(phone_numbers.e164))
    return { rows: {}, data: { numbers: numbers.map(n => n.e164) } }
  },

  'assistant.startTestCall': async ({ tx, actor }, input) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    // Only an assistant of the caller's own workspace goes into the signed dispatch.
    const assistant = input.assistantId ? await assistantIn(tx, actor.workspaceId, input.assistantId) : null
    return { rows: {}, data: await startTestCall(tx, actor, assistant?.id) }
  },

  // Only an active member of the call's workspace can be its assignee; the voice assistant cannot assign.
  // Each change is recorded in the call's activity (call_events) and, when someone else assigned it,
  // the assignee is told (assign-notifications.ts).
  'call.assign': async ({ tx, actor, now }, input: { callId: string; userId: string | null; notify?: boolean }) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    if (actor.role === 'agent') throw Forbidden.t('server.api.assistantCannotAssign')
    // Same answer as the patch it stands in for: a call of another workspace is not found.
    const [call] = await tx
      .select()
      .from(calls)
      .where(and(eq(calls.id, input.callId), eq(calls.workspace_id, actor.workspaceId)))
    if (!call) throw notFound('calls')
    if (input.userId) {
      const [assignee] = await tx
        .select({ disabled: workspace_members.disabled })
        .from(workspace_members)
        .where(and(eq(workspace_members.workspace_id, call.workspace_id), eq(workspace_members.user_id, input.userId)))
      if (!assignee) throw Reject.t('server.api.notAMember')
      if (assignee.disabled) throw Reject.t('server.api.memberDisabled')
    }
    if (call.assignee_id === input.userId) return { rows: { calls: [call] } }
    const actorId = actor.apiKeyId ? null : actor.actorId
    const [event] = await tx
      .insert(call_events)
      .values({
        id: newId('cev'),
        workspace_id: call.workspace_id,
        call_id: call.id,
        kind: 'assigned',
        actor_id: actorId,
        assignee_id: input.userId,
        created_at: now,
      })
      .returning()
    if (input.userId && input.userId !== actorId && input.notify !== false) await queueAssignNotification(tx, event!.id)
    const updated = await tx.update(calls).set({ assignee_id: input.userId }).where(eq(calls.id, call.id)).returning()
    return { rows: { calls: updated, call_events: [event!] } }
  },

  // The members calls can be assigned to (API keys and MCP clients look up a userId here).
  'member.list': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const rows = await tx
      .select({ userId: workspace_members.user_id, name: workspace_members.name, role: workspace_members.role })
      .from(workspace_members)
      .where(and(eq(workspace_members.workspace_id, actor.workspaceId), eq(workspace_members.disabled, false)))
      .orderBy(asc(workspace_members.name))
    return { rows: {}, data: { members: rows } }
  },

  'call.appendTranscript': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const [segment] = await tx
      .insert(transcript_segments)
      .values({
        id: newId('seg'),
        workspace_id: call.workspace_id,
        call_id: call.id,
        speaker: input.speaker,
        text: input.text,
        at_ms: input.atMs,
        tool_event: input.toolEvent ?? null,
      })
      .returning()
    return { rows: { transcript_segments: [segment!] } }
  },

  // Not synced (admin overview only): no rows go back to the store.
  // A stage of the voice pipeline failed (VoiceFailure): kept on the call (the call's own view), once per stage, provider
  // and reason.
  'call.reportVoiceFailure': async (
    { tx, actor, now },
    input: { callId: string; failure: VoiceFailure; keySource?: KeySource },
  ) => {
    const call = await loadCall(tx, actor, input.callId)
    // A race in the call's own conversation (two replies at once): the call went on, nothing to keep (LIN-249).
    if (isPerCallProviderError(input.failure.message)) return { rows: {}, data: { failure: input.failure } }
    // A stage the partner's own keys served (S7): the partner's key of that stage is failing, never the install's
    // provider. One that fell back to the install's keys is the install's failure (security review, L-4).
    const partners = call.partner_keys && (await partnerVoiceFailure(tx, call.id, input.failure, now, input.keySource))
    if (partners) {
      const known = call.voice_failures.some(
        f =>
          f.stage === input.failure.stage && f.provider === input.failure.provider && f.reason === input.failure.reason,
      )
      if (known || call.voice_failures.length >= VOICE_FAILURES_PER_CALL)
        return { rows: {}, data: { failure: input.failure } }
      const failure: VoiceFailure = {
        ...input.failure,
        message: maskFailure(input.failure.message).slice(0, VOICE_FAILURE_MESSAGE_MAX),
      }
      const rows = await tx
        .update(calls)
        .set({ voice_failures: [...call.voice_failures, { ...failure, at: now }] })
        .where(eq(calls.id, call.id))
        .returning()
      return { rows: { calls: rows }, data: { failure } }
    }
    // One failure model (LIN-111): the stage's provider is failing for the whole install too (Server admin › Providers, one
    // email per streak). A vague reason comes back refined by the provider's own test, and that is what the call keeps
    // and the agent shows on the test call.
    const recorded = await recordProviderFailure(
      tx,
      input.failure.provider,
      { reason: input.failure.reason, message: input.failure.message },
      'agent',
      { scope: { workspaceId: call.workspace_id, callId: call.id } },
    )
    const failure: VoiceFailure = {
      ...input.failure,
      reason: recorded.reason,
      message: recorded.message.slice(0, VOICE_FAILURE_MESSAGE_MAX),
    }
    const { stage, provider, reason } = failure
    const known = call.voice_failures.some(f => f.stage === stage && f.provider === provider && f.reason === reason)
    if (known || call.voice_failures.length >= VOICE_FAILURES_PER_CALL) return { rows: {}, data: { failure } }
    const rows = await tx
      .update(calls)
      .set({ voice_failures: [...call.voice_failures, { ...failure, at: now }] })
      .where(eq(calls.id, call.id))
      .returning()
    return { rows: { calls: rows }, data: { failure } }
  },

  'call.recordTimings': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    await tx.insert(reply_timings).values(
      input.replies.map((r: ReplyTiming) => ({
        id: newId('rt'),
        workspace_id: call.workspace_id,
        call_id: call.id,
        at: r.at,
        pipeline: input.pipeline,
        providers: input.providers,
        turn_ms: r.turnMs ?? null,
        model_ms: r.modelMs ?? null,
        voice_ms: r.voiceMs ?? null,
        server_ms: r.serverMs ?? null,
        total_ms: r.totalMs ?? null,
        heard_ms: r.heardMs ?? null,
      })),
    )
    return { rows: {} }
  },

  'call.finish': async ({ tx, actor, now }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const duration_sec = Math.max(0, Math.round((Date.parse(now) - Date.parse(call.started_at)) / 1000))
    const { outcome, urgency } = keptUrgent(call.urgency, input.outcome ?? 'answered', input.urgency ?? call.urgency)
    // A recorded call's news waits for the corrected transcript when after-call transcription is on (call-news.ts).
    // A repeated finish (agent retry after a lost answer) gets the hold the first one set.
    // A call on the partner's own keys (S7) never goes to the install's after-call transcription: its live transcript stays.
    const held =
      call.status === 'completed'
        ? !!call.awaiting_transcript_until
        : !call.partner_keys &&
          input.awaitTranscript === true &&
          (await keepsRecordings(tx, call.workspace_id)) &&
          (await transcribesAfterCalls(tx))
    const [updated] = await tx
      .update(calls)
      .set({
        status: 'completed',
        ended_at: now,
        duration_sec,
        outcome,
        urgency,
        title: input.title ?? call.title,
        summary: input.summary ?? call.summary,
        action_items: input.actionItems
          ? [...input.actionItems, ...teamNotesOf(call.action_items, input.actionItems)]
          : call.action_items,
        fields: input.fields ?? call.fields,
        missing_info: input.missing ?? call.missing_info,
        // What the agent reported of a call on the partner's own keys (S7); the first report stays.
        ...(call.partner_keys && input.keySources && !call.key_sources ? { key_sources: input.keySources } : {}),
        ...(held && call.status !== 'completed'
          ? { awaiting_transcript_until: new Date(Date.parse(now) + AWAIT_TRANSCRIPT_MAX_SEC * 1000).toISOString() }
          : {}),
      })
      .where(eq(calls.id, call.id))
      .returning()
    const rows: ActionResult['rows'] = { calls: [updated!] }
    // A billed call's usage posts now, with its end and duration set above (call-billing.ts); a repeated finish finds
    // it posted. A failure leaves the call finished: the stale sweep posts it again.
    // $0 only when it was forecast on the partner's keys and the agent confirms every stage ran on them (S7).
    await postFinishedCall(tx, call.id, now, {
      ownKeysConfirmed: call.partner_keys && reportConfirmsOwnKeys(updated!.key_sources),
    })
    const named = await nameCaller(tx, call.contact_id, input.callerName)
    if (named) rows.contacts = named
    // Only the first finish notifies; a repeated one (agent retry after a timeout) is not news.
    if (call.status !== 'completed') {
      if (held) await queueCallRelease(tx, call.id, AWAIT_TRANSCRIPT_MAX_SEC)
      else await queueFinishedNews(tx, updated!)
      // This call's minutes may take the workspace to 80 % or 100 % of its spending cap.
      await queueSpendingAlerts(tx, call.workspace_id, now)
      await recordCallFinished(tx, updated!, now)
    }
    return { rows, data: { held, named: !!named } satisfies CallFinishData }
  },

  // The agent asks for the corrected transcript of a held call: outside a transaction (the provider takes seconds), the
  // lines are written in one short one at the end. A failure leaves the live lines and tries again in the background.
  'call.correctTranscript': async ({ tx, actor }, input: { callId: string }) => {
    const call = await loadCall(tx, actor, input.callId)
    // Once per call: a second request (a retry, a second agent) finds it taken, and the CALL_RELEASE job queues no
    // background transcription for a call whose transcription started here.
    const [claimed] = await tx
      .update(calls)
      .set({ transcript_requested_at: sql`now()` })
      .where(
        and(eq(calls.id, call.id), isNotNull(calls.awaiting_transcript_until), isNull(calls.transcript_requested_at)),
      )
      .returning({ id: calls.id })
    if (!claimed) return { rows: {}, data: { status: 'skipped' } satisfies CorrectTranscriptData }
    // Recordings turned off since call.finish: the recording is being deleted and leaves the server no more.
    if (!(await keepsRecordings(tx, call.workspace_id)))
      return { rows: {}, data: { status: 'skipped' } satisfies CorrectTranscriptData }
    try {
      const result = await transcribeCallAgain(tx, call.id, await transcriberInEffect(tx), recordingStoreCache(tx))
      if (result.status !== 'updated' || !result.lines)
        return { rows: {}, data: { status: 'skipped' } satisfies CorrectTranscriptData }
      const lines = await tx
        .select({ speaker: transcript_segments.speaker, text: transcript_segments.text })
        .from(transcript_segments)
        .where(eq(transcript_segments.call_id, call.id))
        .orderBy(asc(transcript_segments.at_ms), asc(transcript_segments.id))
      return { rows: {}, data: { status: 'updated', lines } satisfies CorrectTranscriptData }
    } catch (e) {
      console.warn(`after-call transcription of call ${call.id} failed, trying again later: ${errorMessage(e)}`)
      await queueCallTranscript(tx, call.id)
      return { rows: {}, data: { status: 'failed' } satisfies CorrectTranscriptData }
    }
  },

  // The summary of the corrected transcript, then the news the call held (call-news.ts). A call no longer held (the
  // CALL_RELEASE job was first) keeps the summary its news went out with: the email and the inbox say the same, and
  // the team may have changed it since.
  'call.finalize': async ({ tx, actor }, input) => {
    await lockCall(tx, input.callId)
    const call = await loadCall(tx, actor, input.callId)
    if (call.status !== 'completed') throw Reject.t('server.api.callNotFinished')
    if (!call.awaiting_transcript_until) return { rows: {} }
    // A title or summary the team changed while the news was held stays.
    const unchanged = (stored: string | null, sent: string | undefined) => sent === undefined || stored === sent
    const rows: ActionResult['rows'] = {}
    if (
      input.summary !== undefined ||
      input.title !== undefined ||
      input.outcome ||
      input.urgency ||
      input.actionItems ||
      input.callerName
    ) {
      const previous = new Set(input.previous?.actionItems ?? [])
      // Urgent stays urgent when the team or a tool flagged it. While the news is held, an urgency only the first
      // summary set (unchanged since) may change: it may come from a misheard word. A tool's flag is in both summaries.
      const fromFirstSummary = input.previous?.urgency === call.urgency
      const current = fromFirstSummary ? (input.urgency ?? call.urgency) : call.urgency
      const { outcome, urgency } = keptUrgent(
        current,
        input.outcome ?? call.outcome ?? 'answered',
        input.urgency ?? call.urgency,
      )
      const [updated] = await tx
        .update(calls)
        .set({
          outcome,
          urgency,
          title: unchanged(call.title, input.previous?.title) ? (input.title ?? call.title) : call.title,
          summary: unchanged(call.summary, input.previous?.summary) ? (input.summary ?? call.summary) : call.summary,
          // The agent's items from call.finish are replaced; what the team or a tool added stays.
          action_items: input.actionItems
            ? [
                ...input.actionItems,
                ...teamNotesOf(
                  call.action_items.filter(item => !previous.has(item.text)),
                  input.actionItems,
                ),
              ]
            : call.action_items,
          fields: input.fields ?? call.fields,
          missing_info: input.missing ?? call.missing_info,
        })
        .where(eq(calls.id, call.id))
        .returning()
      rows.calls = [updated!]
      const named = await nameCaller(tx, call.contact_id, input.callerName, input.previous?.callerName)
      if (named) rows.contacts = named
    }
    const released = await releaseHeldNews(tx, call.id)
    if (released) rows.calls = [released]
    return { rows }
  },

  // Read-only in the registry: runs outside a transaction, so the request to the business's system holds none open.
  'call.lookUpCaller': async ({ tx, actor }, input: { callId: string }) => {
    const call = await loadCall(tx, actor, input.callId)
    return { rows: {}, data: await lookUpCaller(tx, call) }
  },

  // Read-only in the registry, like call.lookUpCaller: the request to the business's system holds no transaction open.
  'call.askWebhook': async (
    { tx, actor },
    input: { callId: string; lookup: string; values: Record<string, unknown> },
  ) => {
    const call = await loadCall(tx, actor, input.callId)
    return {
      rows: {},
      data: await askWebhook(tx, call, input, process.env, (request, answer) => queueLookup(tx, call, request, answer)),
    }
  },

  'call.startRecording': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    // One start at a time per call, so a retry finds the egress the first one started (recording-egress.ts). NO KEY
    // UPDATE: the transcript lines written meanwhile check their foreign key to this row, which FOR UPDATE would block
    // while egress answers (LIN-673).
    // i18n-ignore: 'no key update' is a Postgres lock mode, not text
    const [locked] = await tx
      .select({ status: calls.status })
      .from(calls)
      .where(eq(calls.id, call.id))
      .for('no key update')
    if (locked?.status !== 'live') throw Reject.t('server.api.callEnded')
    const assistant = call.assistant_id
      ? await assistantIn(tx, call.workspace_id, call.assistant_id).catch(() => null)
      : null
    if (assistant?.record_calls === false) throw Reject.t('server.api.callNotRecorded')
    const egressId = await startS3Recording(tx, call.room ?? call.id, recordingKey(call.workspace_id, call.id))
    return { rows: {}, data: { egressId } }
  },

  'call.setRecording': async ({ tx, actor }, input) => {
    const call = await loadCall(tx, actor, input.callId)
    const recording_key = recordingKey(call.workspace_id, call.id, input.format)
    // An agent that does not say (older versions) recorded into the store RECORDING_STORE names: null.
    const recording_store = input.store ?? null
    const rows = await tx.update(calls).set({ recording_key, recording_store }).where(eq(calls.id, call.id)).returning()
    // A workspace that keeps no recordings (an agent that recorded anyway: older, or the setting changed mid-call).
    if (!(await keepsRecordings(tx, call.workspace_id))) await queueRecordingDeletion(tx, call.id)
    // A stronger model hears the recording again and corrects the caller's lines (after-call-transcript.ts); for a
    // held call the agent asks for it now (call.correctTranscript).
    else if (!call.awaiting_transcript_until && (await transcribesAfterCalls(tx)))
      await queueCallTranscript(tx, call.id)
    return { rows: { calls: rows } }
  },

  'call.takeMessage': async ({ tx, actor }, input) => {
    await lockCall(tx, input.callId)
    const call = await loadCall(tx, actor, input.callId)
    // Only messages count: other next steps (a note for the team after failed booking changes) take no slot.
    const taken = call.action_items.filter(item => item.kind === 'message').length
    if (call.status === 'live' && taken >= MESSAGES_PER_CALL) {
      throw new Reject(
        `${MESSAGES_PER_CALL} messages are saved on this call already: tell the caller the team has them, and add nothing more`,
      )
    }
    const action_items = [...call.action_items, { text: input.message, kind: 'message' as const }]
    if (call.source !== 'test') await queueCallPush(tx, call.id, 'message')
    return { rows: { calls: await tx.update(calls).set({ action_items }).where(eq(calls.id, call.id)).returning() } }
  },

  // The same update as the action's patch, plus a push the first time a call becomes urgent.
  'call.flagUrgent': async ({ tx, actor }, input: { callId: string }) => {
    const call = await loadCall(tx, actor, input.callId)
    const rows = await tx.update(calls).set({ urgency: 'urgent' }).where(eq(calls.id, call.id)).returning()
    if (call.urgency !== 'urgent' && call.source !== 'test') await queueCallPush(tx, call.id, 'urgent')
    return { rows: { calls: rows } }
  },

  'onboarding.setStep': async ({ tx, actor, now }, input) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    // Before the trial starts the setup ends at `activate` (the card): no number step, no finishing or setting aside. A
    // partner's draft client workspace has no trial of its own: its number is refused on its own until the partner paid.
    if (
      (input.step === 'phone' || input.step === 'done' || input.step === 'skipped') &&
      (await waitsForOwnTrial(tx, actor.workspaceId))
    )
      throw new Reject(PENDING_PAYMENT)
    await tx
      .insert(workspace_settings)
      .values({ workspace_id: actor.workspaceId, timezone: DEFAULT_TIME_ZONE, onboarding_step: input.step })
      .onConflictDoUpdate({ target: workspace_settings.workspace_id, set: { onboarding_step: input.step } })
    await recordOnboardingStep(tx, actor.workspaceId, input.step, now)
    return { rows: {} }
  },

  'onboarding.recordEvent': async ({ tx, actor, now }, input) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    await recordSetupEvent(tx, actor.workspaceId, input.event, now)
    return { rows: {} }
  },

  // The numbers to pick from for "Use a number you have": one free read of the carrier account, never a purchase.
  'phoneNumber.listCarrierNumbers': async ({ tx, actor, telephony }) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const { provider, account } = await setupCarrier(tx, actor.workspaceId, telephony)
    // Same rule as attaching (phoneNumber.setup, attachRefused): only instance admins see the install's account.
    if (attachRefused(actor, { account, provider: provider.name })) {
      return { rows: {}, data: { numbers: [], more: false } satisfies CarrierNumbersData }
    }
    const owned = await atCarrier(() => provider.listNumbers(CARRIER_NUMBERS_PAGE))
    const all = owned.map(n => n.e164)
    const taken = all.length
      ? new Set(
          (
            await tx.select({ e164: phone_numbers.e164 }).from(phone_numbers).where(inArray(phone_numbers.e164, all))
          ).map(n => n.e164),
        )
      : new Set<string>()
    const numbers = all.filter(e164 => !taken.has(e164)).sort()
    return { rows: {}, data: { numbers, more: owned.length >= CARRIER_NUMBERS_PAGE } satisfies CarrierNumbersData }
  },

  // An area code without a free number (LIN-313): its overlays and the closest codes, each searched once at the
  // carrier (free) and kept when it has a number not set up here yet. Never buys anything.
  'phoneNumber.searchNearby': async ({ tx, actor, telephony }, input) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const { provider } = await setupCarrier(tx, actor.workspaceId, telephony)
    const candidates = nearbyAreaCodes(input.areaCode)
    const found = await Promise.allSettled(
      candidates.map(a => atCarrier(() => provider.searchNumbers({ country: a.country, areaCode: a.code, limit: 5 }))),
    )
    // One code the carrier refused is passed over; a carrier that refuses every search (a bad key) is told as such.
    const failed = found.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed && found.every(r => r.status === 'rejected')) throw failed.reason
    const free: NearbyNumbersData['free'] = []
    for (const [i, result] of found.entries()) {
      const a = candidates[i]!
      if (result.status === 'fulfilled' && (await firstFreeNumber(tx, result.value)))
        free.push({ code: a.code, sameArea: a.sameArea })
    }
    const data: NearbyNumbersData = { areaCode: input.areaCode, searched: candidates.map(a => a.code), free }
    return { rows: {}, data }
  },

  'phoneNumber.setup': async ({ tx, actor, now, telephony, onRollback, onCommit }, input) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const workspace_id = actor.workspaceId
    // Never waits long for a lock while it holds a connection: a burst of setups must not fill the pool.
    await tx.execute(sql`set local lock_timeout = '5s'`)
    // Serialised with carrier.set, so the carrier cannot change while a number is set up with it. A second
    // setup in the workspace meanwhile is refused at once rather than waiting.
    if (!(await tryLockWorkspaceCarrier(tx, workspace_id))) throw new Reject(NUMBER_SETUP_BUSY)
    const { provider, account: carrier_account } = await setupCarrier(tx, workspace_id, telephony)
    const sipEndpoint = process.env.LIVEKIT_SIP_ENDPOINT ?? ''
    if (provider.name !== 'dev' && !sipEndpoint)
      throw new Reject('phone setup is not configured: LIVEKIT_SIP_ENDPOINT is not set')

    // Everything that can refuse is checked before the carrier is asked anything, and before anything is bought.
    if (actor.workspaceDisabled) throw Reject.t('server.api.workspaceDisabled')
    // No number before Checkout.
    await refusePendingPayment(tx, workspace_id)
    const assistant = await assistantIn(tx, workspace_id, input.assistantId)
    const onInstallAccount = carrier_account === 'install' && provider.name !== 'dev'
    // A number on our carrier account is paid from the bill: Checkout confirmed, not held, the trial's limit, the
    // balance for an extra one.
    if (carrier_account === 'install' && input.purchase) {
      const billRefusal = await billingNumberRefusal(tx, actor, workspace_id)
      if (billRefusal) throw new Reject(billRefusal)
    }
    // Attaching names a number already in the account: refused before the carrier is asked (attachRefused).
    const attachRule = { account: carrier_account, provider: provider.name }
    if (!input.purchase && attachRefused(actor, attachRule)) throw new Forbidden(INSTALL_NUMBER_ADMIN_ONLY)
    // Only workspaces in a country of the install's buy offers may buy (numberBuyOffers: the US, Canada, Puerto Rico;
    // Germany where the server has it on), and by area code only in their own country and its offered codes
    // (LIN-300). Asked once, when a purchase is allowed by the input; refused before the carrier is searched.
    const offers = await numberBuyOffers(tx, { account: carrier_account, provider: provider.name })
    const country = input.purchase ? await purchaseCountry(tx, workspace_id, input, offers) : null
    const offer = country ? buyOfferIn(offers, country) : undefined
    const countryRefusal = country ? buyCountryRefusal(country, offers) : null
    if (countryRefusal && !input.e164) throw new Reject(countryRefusal)
    const areaRefusal =
      country && input.areaCode && !input.e164 ? areaCodeCountryRefusal(input.areaCode, country, offer) : null
    if (areaRefusal) throw new Reject(areaRefusal)
    if (input.purchase && !input.e164 && !input.areaCode && offerHasAreaCode(offer))
      throw new Reject('give an area code (areaCode) to buy a number in')
    // Turned on but not set up yet at the carrier (no requirement group): said calmly, the operator is alerted.
    if (input.purchase && offer && !offer.ready) {
      alertNumbersNotReady(workspace_id, await germanNumbersNotReadyWhy(tx, provider.name))
      throw new Reject(NUMBERS_BEING_SET_UP)
    }
    // A country whose numbers are held in the install's name (Germany) orders with the install's requirement group.
    const requirementGroupRef =
      input.purchase && carrier_account === 'install' && offer?.country === 'DE'
        ? ((await germanRequirementGroup(tx)) ?? undefined)
        : undefined
    // A purchase's limits are checked before the carrier is searched or asked about a number, so a refused one makes
    // no carrier request (and takes the install-wide purchase lock before it does). A number typed in is refused for
    // everyone but instance admins whether or not it is in the install's account: the answer never tells which.
    if (onInstallAccount && input.purchase) {
      const refusal = await installPurchaseRefusal(tx, actor, workspace_id, { byNumber: Boolean(input.e164), now })
      if (refusal) throw new Reject(refusal)
    }
    // Only a purchase may search: attaching always names the number.
    // A few candidates, so a number that is already set up here (dev's are always the same) is passed over.
    // The search is in the area code's own country (US, CA or PR: the carriers file Puerto Rico's numbers under PR),
    // else the offer's (Germany).
    const searchCountry = (input.areaCode && buyableAreaCode(input.areaCode)?.country) || offer?.country || 'US'
    const e164: string | undefined =
      input.e164 ??
      (await firstFreeNumber(
        tx,
        await atCarrier(() =>
          provider.searchNumbers({
            country: searchCountry,
            areaCode: input.areaCode,
            limit: 5,
            ...(offer && offer.numberType !== 'local' ? { numberType: offer.numberType } : {}),
            ...(requirementGroupRef ? { withRequirements: true } : {}),
          }),
        ),
      ))
    if (!e164 && requirementGroupRef) {
      // None in stock in the install's own numbers: said calmly, the operator is alerted (another area code or type).
      // i18n-ignore: an operator log line (ALERT), never shown in the app
      alertNumbersNotReady(
        workspace_id,
        `the carrier has no free number${input.areaCode ? ` in ${input.areaCode}` : ''}${await requirementGroupNote(tx, provider)}`,
      )
      throw new Reject(NUMBERS_BEING_SET_UP)
    }
    if (!e164) throw new Reject(english.t('server.api.noNumberInAreaCode', { areaCode: input.areaCode ?? '' }))
    const [taken] = await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, e164))
    if (taken) throw new Reject(english.t('server.api.numberAlreadySetUp', { number: e164 }))

    const existing = await atCarrier(() => provider.findNumber(e164))
    if (!existing && !input.purchase) {
      throw new Reject(
        `${e164} is not in the ${provider.name} account. Check the number; to buy it, pass purchase: true`,
      )
    }
    // A number typed with purchase: true that is already in the account is attached too: the same rule.
    if (existing && attachRefused(actor, attachRule)) throw new Forbidden(INSTALL_NUMBER_ADMIN_ONLY)
    const buying = !existing
    // A number typed in that is not in the account would be bought: the same country rules, also its own country.
    if (buying && countryRefusal) throw new Reject(countryRefusal)
    const numberRefusal = buying && country && input.e164 ? numberCountryRefusal(input.e164, country) : null
    if (numberRefusal) throw new Reject(numberRefusal)
    // Logged (committed) before the carrier is asked: a purchase that fails later still counts.
    if (buying)
      await logPurchase(actor, {
        workspaceId: workspace_id,
        e164,
        provider: provider.name,
        carrierAccount: carrier_account,
      })
    const number =
      existing ??
      (await atCarrier(() =>
        requirementGroupRef
          ? buyHeldNumber(tx, provider, e164, requirementGroupRef, workspace_id)
          : provider.buyNumber(e164),
      ))
    if (buying) onRollback?.(releaseBought(provider, number))

    await atCarrier(() => provider.routeToSip(number, sipEndpoint, { secure: sipTlsFromEnv() }))
    const rows = await tx
      .insert(phone_numbers)
      .values({
        id: newId('pn'),
        workspace_id,
        e164,
        provider: provider.name,
        provider_ref: number.providerRef,
        carrier_account,
        assistant_id: assistant?.id ?? null,
        // A bought number is the business's new number; an attached one is taken as a forwarding
        // target, the product's default, and counts as verified only after a test call.
        mode: input.mode ?? (existing ? 'forward_conditional' : 'new'),
        purchased: !existing,
        verified_at: !existing && (input.mode ?? 'new') === 'new' ? now : null,
        // The API's clock, as calls.started_at: forwardingVerifiedFor compares the two, and the database's clock
        // (transaction start, microseconds) can be a few milliseconds ahead of a call that comes in right after.
        created_at: now,
      })
      .returning()
    // An extra number pays its first month now, in this transaction (LIN-506).
    if (buying && carrier_account === 'install') await payBoughtNumberMonth(tx, workspace_id, rows[0]!.id, now)
    // Numbers held in the install's name (Germany): the operator is warned from 8 on (number-buy.ts).
    if (buying && requirementGroupRef) await warnAtHeldNumbersLimit(tx, e164)
    // Warm transfers from a number in the workspace account dial through that account: set its trunk up now.
    if (carrier_account === 'workspace')
      await refreshTransferTrunk(tx, workspace_id, {
        actorId: actor.actorId,
        trigger: 'phoneNumber.setup',
        impersonatedBy: impersonatorOf(actor),
      })
    // An install-account number in a new country: the install's carrier profiles may call it too, once this commits
    // (Telnyx; logged, never fails the setup). Own-account numbers never widen the install's profiles.
    if (carrier_account === 'install') onCommit?.(() => syncInstallDestinations())
    // LiveKit's inbound trunk takes calls to the number once this commits, before the command answers (inbound-trunk.ts).
    onCommit?.(async () => void (await requestInboundTrunkSync()))
    // The go-live checklist's first step ("Connect your number"), and where Server admin › Onboarding sees a business stop.
    await recordSetupEvent(tx, workspace_id, 'number_connected', now)
    // A workspace whose country is worked out from its numbers may be in another country now: what follows it moves.
    await applyCountryDefaults(tx, workspace_id)
    // A transfer contact on this number would now ring back into Linedesk: switched off.
    const switchedOff = await switchOffLoopingTransfers(tx, workspace_id, [e164])
    return { rows: { phone_numbers: rows, ...(switchedOff.length ? { assistants: switchedOff } : {}) } }
  },

  // Detaches the number from the workspace; a number Linedesk bought also goes back to the carrier, an
  // attached one is taken off Linedesk's routing there (its other settings at the carrier stay).
  // The carrier is asked last, right before the commit: if it refuses, nothing changes here.
  'phoneNumber.release': async ({ tx, actor, telephony, onCommit }, input) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const [number] = await tx
      .select()
      .from(phone_numbers)
      .where(and(eq(phone_numbers.id, input.phoneNumberId), eq(phone_numbers.workspace_id, actor.workspaceId)))
    if (!number) throw Reject.t('server.api.phoneNumberNotFound')
    if (!confirmsNumber(input.confirm, number.e164))
      throw new Reject(english.t('server.api.typeNumberToConfirm', { number: number.e164 }))
    await lockWorkspaceCarrier(tx, actor.workspaceId)
    await tx.delete(phone_numbers).where(eq(phone_numbers.id, number.id))
    const owned = number.provider_ref ? { e164: number.e164, providerRef: number.provider_ref } : null
    let releasedAtCarrier = false
    let unroutedAtCarrier = false
    if (number.provider !== 'dev') {
      const provider = telephony ?? (await releaseCarrier(tx, number))
      if (number.purchased) {
        // A bought number goes back to the carrier: only at the carrier that has it.
        if (provider.name !== number.provider) {
          throw new Reject(
            `${number.e164} is at ${number.provider}, but ${provider.name} is the carrier in use: release it there, or switch the carrier back first`,
          )
        }
        if (!owned) throw new Reject(`${number.e164} has no carrier reference: release it at ${number.provider}`)
        await atCarrier(() => provider.releaseNumber(owned))
        releasedAtCarrier = true
      } else if (provider.name === number.provider && owned) {
        // An attached number stays the business's but stops reaching Linedesk. At another carrier than the
        // one in use, or without a reference, there is nothing Linedesk can reach: it is only detached here.
        await atCarrier(() => provider.unrouteNumber(owned))
        unroutedAtCarrier = true
      }
    }
    // No rows: the delete reaches browsers through read sync (a returned row would be written back locally).
    // The trunk keeps only the remaining numbers as caller IDs (or goes, without any).
    if (number.carrier_account === 'workspace')
      await refreshTransferTrunk(tx, actor.workspaceId, {
        actorId: actor.actorId,
        trigger: 'phoneNumber.release',
        impersonatedBy: impersonatorOf(actor),
      })
    if (number.carrier_account !== 'workspace') onCommit?.(() => syncInstallDestinations())
    // And LiveKit's inbound trunk stops taking calls to it (inbound-trunk.ts).
    onCommit?.(async () => void (await requestInboundTrunkSync()))
    return { rows: {}, deleted: { phone_numbers: [number.id] }, data: { releasedAtCarrier, unroutedAtCarrier } }
  },
}

for (const def of actions.values()) {
  if (!def.patch && !handlers[def.name]) throw new Error(`action ${def.name} has neither a patch nor a handler`)
}

/** The actions with a server handler (tests check which also have a patch). */
export const handlerNames: ReadonlySet<string> = new Set(Object.keys(handlers))

/** A handler wins over the patch: an action with both is optimistic in the browser and checked here. */
export function runHandler(ctx: HandlerCtx, def: ActionDef, input: unknown) {
  const run = () => (handlers[def.name] ? handlers[def.name]!(ctx, input) : runPatch(ctx, def, input))
  // A change of an assistant's call settings is kept as a version (assistant-versions.ts).
  return VERSIONED_ACTIONS.has(def.name) ? withVersion(ctx, input as { assistantId?: string }, run) : run()
}

/** The first of the carrier's candidates that no workspace has set up yet. */
async function firstFreeNumber(tx: Tx, candidates: { e164: string }[]): Promise<string | undefined> {
  if (!candidates.length) return undefined
  const taken = await tx
    .select({ e164: phone_numbers.e164 })
    .from(phone_numbers)
    .where(
      inArray(
        phone_numbers.e164,
        candidates.map(c => c.e164),
      ),
    )
  const used = new Set(taken.map(t => t.e164))
  return candidates.find(c => !used.has(c.e164))?.e164
}
