// The automatic forwarding check (onboarding concept, "The phone step in depth", 6a to 6c). The owner dialled the
// forwarding code; Linedesk calls the business's own number from a number of the install (the check line), lets it
// ring unanswered, and watches whether that call arrives on the workspace's Linedesk number. The arriving call is
// matched on our caller number and the time, never on Diversion or History-Info headers: carriers drop or rewrite
// those. call.start hands the arriving leg here before anything else: it is neither answered by the assistant nor
// filed as a call, so it never counts as a real one.
//
// Why the outbound leg goes through LiveKit SIP and not the carrier's call-control API: it is the path warm transfers
// and the phone call test already dial through (an outbound trunk at the carrier, a LiveKit SIP outbound trunk), it
// works the same for Telnyx and Twilio, and it needs no public webhook: LiveKit tells us in the request itself whether
// the callee answered, was busy or did not answer. Call control would need a call-control application with a webhook
// URL the carrier can reach, which a self-hosted install on a laptop does not have.
import {
  FORWARDING_CHECKS_PER_DAY,
  FORWARDING_CHECKS_PER_HOUR,
  FORWARDING_CHECKS_PER_INSTALL_DAY,
  FORWARDING_CHECKS_PER_NUMBER_DAY,
  FORWARDING_NUMBERS_PER_WORKSPACE_DAY,
  FORWARDING_RING_SECONDS,
  forwardingGuideForCarrier,
  phoneCountry,
  english,
  FORWARDING_REFUSED,
  type ForwardingCheckView,
  isCheckableBusinessNumber,
  outboundNumberProblem,
  LINE_LOOKUPS_PER_10_MIN,
  LINE_LOOKUPS_PER_INSTALL_DAY,
  LINE_LOOKUPS_PER_WORKSPACE_DAY,
  type LineLookupData,
} from '@linedesk/actions'
import {
  type ForwardingCheckStatus,
  forwarding_checks,
  line_lookups,
  organization,
  phone_numbers,
  type Tx,
} from '@linedesk/db'
import {
  createTelnyxOutbound,
  createTwilioOutbound,
  type DevForwardingOutcome,
  devForwardingOutcome,
  installCarrierName,
  type OutboundSip,
  TelephonyError,
  telnyxSpendLimits,
} from '@linedesk/telephony'
import { and, count, desc, eq, gt, gte, isNull, or, sql } from 'drizzle-orm'
import { CHECK_TRUNK_NAME } from './carrier-profile-names.ts'
import { db } from './db.ts'
import { type Handler, type Reader, Reject, type Said, sayIn, wordsOf } from './handler-context.ts'
import { enMessages, type MessageKey, msg } from '@linedesk/i18n'
import { deleteLivekitRoom, findSipCallerRoom } from './livekit-status.ts'
import { installTelephony, telephonyProvider } from './provider-settings.ts'
import { createRateLimiter } from './rate-limit.ts'
import { recordSetupEvent } from './setup-events.ts'
import { installDestinations } from './outbound-policy.ts'
import { switchOffLoopingTransfers } from './transfer-loops.ts'
import { recordSpendCaps } from './telnyx-spend-caps.ts'
import { LivekitError, livekitSip } from './transfer-trunk.ts'
import { CARRIER_TIMEOUT_MS, telephonyForWorkspace } from './workspace-carrier.ts'

type Env = Record<string, string | undefined>
type Check = typeof forwarding_checks.$inferSelect

/** After the outbound leg was answered, how long the forwarded call may take to show up on the Linedesk number. */
export const ARRIVAL_GRACE_MS = 8_000
/** A call from the check number this long after the check dialled still belongs to it (counted from the dial). */
const MATCH_WINDOW_MS = (FORWARDING_RING_SECONDS + 60) * 1000
/** A check whose job did not start within this long is not dialled any more: the owner was told it did not run. */
export const MAX_QUEUE_MS = 30_000
/** A check still `dialing` after this long did not finish (the API restarted mid-call): shown as not checked. */
const STALE_MS = (FORWARDING_RING_SECONDS + 120) * 1000
/**
 * How long after a check ended (and hung up its outbound call) a forwarded call from it may still arrive: the carrier
 * cancels the forwarded leg when ours ends, so later than this it came from another check.
 */
const LATE_ARRIVAL_MS = 15_000
/** Results a later arrival of the check's call still turns into `works` (the call came after we gave up on it). */
const ARRIVAL_UPGRADES = new Set<ForwardingCheckStatus>([
  'dialing',
  'answered',
  'rang_through',
  'no_assistant',
  'forwards_elsewhere',
])
/** Results an arrival on another Linedesk number still turns into `forwards_elsewhere`. */
const ELSEWHERE_FROM = new Set<ForwardingCheckStatus>(['dialing', 'answered', 'rang_through', 'no_assistant'])
/** The install-wide lock every check start takes, so the limits across workspaces are counted under it. */
const START_LOCK = 'forwarding-check:start'
const LOOKUP_LOCK = 'forwarding-check:lookup'
/** The install-wide lock around setting up the check trunk, so two API processes never rotate it at once. */
const TRUNK_LOCK = 'forwarding-check:trunk'
/** The caller ID forwarding checks show under `dev`: never dialled, only matched. */
export const DEV_CHECK_NUMBER = '+12025550199'
/** The LiveKit room of a check's outbound call is this and the check's id. */
const CHECK_ROOM_PREFIX = 'fwdcheck-'

const allowLookup = createRateLimiter({ max: LINE_LOOKUPS_PER_10_MIN, windowMs: 10 * 60_000 })

const FORWARDING_MODES = new Set(['forward_conditional', 'forward_all'])

/** A refusal written for the business, in the caller's language; the web app shows it as it is (FORWARDING_REFUSED). */
const refused = (key: MessageKey, params?: Said['params']) => Reject.t(key, params, FORWARDING_REFUSED)

/** A check's outcome as stored in its row: the text as a key and params, written in each reader's language (detailText). */
const storedDetail = (key: MessageKey, params?: Record<string, string>) =>
  JSON.stringify({ key, params } satisfies Said)

/** A stored detail in a reader's words; one stored as text (before keys) as it is. */
export function detailText(detail: string | null, reader?: Reader): string | null {
  if (!detail?.startsWith('{')) return detail
  try {
    const said = JSON.parse(detail) as Said
    if (typeof said?.key === 'string' && said.key in enMessages) return sayIn(said, reader)
  } catch {
    // Text that only starts with a brace: as it is.
  }
  return detail
}

/** `reader`: whoever reads it (wordsOf); English when not given. */
export function checkView(check: Check, nowMs = Date.now(), reader?: Reader): ForwardingCheckView {
  const age = nowMs - Date.parse(check.started_at)
  // Not dialled in time (the job refuses it from then on), or dialled and never finished.
  const stale = check.status === 'dialing' && ((!check.dialed_at && age > MAX_QUEUE_MS + 10_000) || age > STALE_MS)
  const ringSeconds =
    check.arrived_at && check.dialed_at
      ? Math.max(1, Math.round((Date.parse(check.arrived_at) - Date.parse(check.dialed_at)) / 1000))
      : null
  return {
    id: check.id,
    phoneNumberId: check.phone_number_id,
    businessNumber: check.business_number,
    status: stale ? 'not_checked' : check.status,
    detail: stale
      ? sayIn({ key: msg('server.api.forwardingCheck.didNotFinish') }, reader)
      : detailText(check.detail, reader),
    ringSeconds,
    simulated: check.simulated,
    startedAt: check.started_at,
    finishedAt: check.finished_at,
  }
}

/** Whether a call from `from` is inside a check's window: our caller number, counted from the moment it dialled. */
function inWindow(check: Pick<Check, 'caller_number' | 'dialed_at'>, from: string, nowMs: number): boolean {
  if (!check.caller_number || !check.dialed_at || from !== check.caller_number) return false
  const since = nowMs - Date.parse(check.dialed_at)
  return since >= 0 && since <= MATCH_WINDOW_MS
}

/**
 * Whether an inbound call is a check's call arriving where it should: our caller number calling the check's Linedesk
 * number, after the check dialled and inside its window. Nothing else counts (no forwarding headers).
 */
export function arrivesFor(
  check: Pick<Check, 'caller_number' | 'linedesk_number' | 'dialed_at'>,
  call: { from: string; to: string },
  nowMs: number,
): boolean {
  return call.to === check.linedesk_number && inWindow(check, call.from, nowMs)
}

const displayNumber = (e164: string) =>
  /^\+1\d{10}$/.test(e164) ? `+1 ${e164.slice(2, 5)} ${e164.slice(5, 8)} ${e164.slice(8)}` : e164

/**
 * Whether a check's outbound call could have produced a call arriving at `nowMs`: it had dialled and had not ended
 * more than LATE_ARRIVAL_MS before. A forwarded call exists only while ours rings, so this is what ties an arriving
 * call to the one check (and business number) it came from, also when the same caller number dials one check after
 * another.
 */
export function couldBeFrom(check: Pick<Check, 'dialed_at' | 'finished_at'>, nowMs: number): boolean {
  if (!check.dialed_at || Date.parse(check.dialed_at) > nowMs) return false
  return !check.finished_at || nowMs <= Date.parse(check.finished_at) + LATE_ARRIVAL_MS
}

/**
 * Called by call.start before a call is opened. Every call from the caller number of a check inside its window is a
 * check's call, whichever Linedesk number it reached: it is never answered by the assistant nor filed. It is put down
 * to the check whose outbound call was ringing when it came (couldBeFrom); when that is not exactly one check, it is
 * only dropped. On that check's own Linedesk number the check becomes `works` (also after it was given up as answered,
 * rang through or forwarding elsewhere, when the forwarded call came late), the business number is saved on the
 * number, the number counts as verified and the setup milestone is recorded. On another Linedesk number the check
 * ends as `forwards_elsewhere`. A simulated check (`dev`) only gets its result. Returns the check, or null for every other call.
 */
export async function claimForwardingCheck(
  tx: Tx,
  call: { from: string; to: string; now: string },
): Promise<Check | null> {
  const nowMs = Date.parse(call.now)
  const recent = await tx
    .select()
    .from(forwarding_checks)
    .where(
      and(
        eq(forwarding_checks.caller_number, call.from),
        gt(forwarding_checks.dialed_at, new Date(nowMs - MATCH_WINDOW_MS).toISOString()),
      ),
    )
    .orderBy(desc(forwarding_checks.dialed_at))
    .limit(20)
    .for('update')
  const ours = recent.filter(check => inWindow(check, call.from, nowMs))
  if (!ours.length) return null
  const ringing = ours.filter(check => couldBeFrom(check, nowMs))
  // Two checks ringing at once (other workspaces, the same caller number): the one on the number reached, if one is.
  const onNumber = ringing.filter(check => check.linedesk_number === call.to)
  const from = ringing.length === 1 ? ringing[0]! : onNumber.length === 1 ? onNumber[0]! : null
  if (!from) return ours[0]!
  if (from.linedesk_number === call.to) {
    if (!ARRIVAL_UPGRADES.has(from.status)) return from
    const [arrived] = await tx
      .update(forwarding_checks)
      .set({ status: 'works', arrived_at: call.now, finished_at: call.now, detail: null })
      .where(eq(forwarding_checks.id, from.id))
      .returning()
    // A simulated check (`dev`) proves nothing about the line: the number is not verified, no milestone, no change.
    if (from.simulated) return arrived!
    // Saved for this workspace only: it never refuses the number to another workspace (a caller ID can be faked).
    await tx
      .update(phone_numbers)
      .set({ verified_at: call.now, forwarded_from: from.business_number })
      .where(and(eq(phone_numbers.id, from.phone_number_id), eq(phone_numbers.workspace_id, from.workspace_id)))
    // A transfer contact on the business line would now ring back into Linedesk: switched off.
    await switchOffLoopingTransfers(tx, from.workspace_id, [from.business_number])
    await recordSetupEvent(tx, from.workspace_id, 'forwarding_verified', call.now)
    return arrived!
  }
  // Our caller reached another Linedesk number: that is where this check's business phone forwards to. Named only
  // when it is one of the workspace's own numbers; another business's number is never shown.
  if (!ELSEWHERE_FROM.has(from.status)) return from
  const [reached] = await tx
    .select({ workspaceId: phone_numbers.workspace_id })
    .from(phone_numbers)
    .where(eq(phone_numbers.e164, call.to))
  const [elsewhere] = await tx
    .update(forwarding_checks)
    .set({
      status: 'forwards_elsewhere',
      arrived_at: call.now,
      finished_at: call.now,
      detail:
        reached?.workspaceId === from.workspace_id
          ? storedDetail(msg('server.api.forwardingCheck.forwardsTo'), {
              number: displayNumber(call.to),
              linedesk: displayNumber(from.linedesk_number),
            })
          : storedDetail(msg('server.api.forwardingCheck.forwardsElsewhere'), {
              linedesk: displayNumber(from.linedesk_number),
            }),
    })
    .where(eq(forwarding_checks.id, from.id))
    .returning()
  return elsewhere!
}

/** What call.start answers for a check's arriving leg: hang up at once, file nothing (an older agent hangs up too). */
export const forwardingCheckStart = (check: Check) => ({
  rows: {},
  data: {
    callId: check.id,
    workspaceId: check.workspace_id,
    forwardingCheck: true,
    blocked: true,
    busy: false,
    overCap: false,
    isNewContact: false,
    contact: null,
    assistant: null,
    businessHours: null,
    booking: null,
    recordingNotice: null,
    keepRecording: false,
    callerHistory: null,
    lookups: [],
  },
})

// ─── The dial ──────────────────────────────────────────────────────────────────────────────────────────────

/** How the outbound leg to the business number ended: answered (by anyone), or refused with a SIP status. */
export type DialOutcome = { kind: 'answered' } | { kind: 'failed'; sipStatus: number | null; message: string }

/** Places and ends the check's outbound call. `dial` settles when the callee answered or the call failed. */
export interface CheckDialer {
  /** `linedeskNumber`: where the forwarded call should arrive (only a simulation uses it). */
  dial(call: {
    room: string
    from: string
    to: string
    linedeskNumber: string
    ringSeconds: number
  }): Promise<DialOutcome>
  hangUp(room: string): Promise<void>
  /**
   * Whether the call is in a Linedesk room from `from` to `to` although nobody claimed it (the assistant did not
   * start); that room is hung up. Asked after an answered dial that never arrived.
   */
  reachedLinedesk(call: { from: string; to: string; sinceMs: number }): Promise<boolean>
}

/**
 * The number the check calls from and how it dials; or why there is none. `simulated`: nothing is really dialled
 * (`dev`), so its result never counts as verified.
 */
export type CheckLine = { callerNumber: string; dialer: CheckDialer; simulated?: boolean } | { unavailable: string }

/** The SIP status in a LiveKit refusal: its Twirp metadata, else the first SIP code in its message. */
export function sipStatusOf(e: unknown): number | null {
  const body = e instanceof LivekitError ? e.body : {}
  const meta = (body.meta ?? {}) as Record<string, unknown>
  for (const value of [meta.sip_status_code, meta.sipStatusCode, meta.code]) {
    const n = Number(value)
    if (Number.isInteger(n) && n >= 300 && n < 700) return n
  }
  const text = `${typeof body.msg === 'string' ? body.msg : ''} ${e instanceof Error ? e.message : String(e)}`
  const match = /sip status:?\s*(\d{3})|\b([3-6]\d\d)\b(?=\s+[A-Za-z])/i.exec(text)
  const code = Number(match?.[1] ?? match?.[2])
  return Number.isInteger(code) && code >= 300 ? code : null
}

/** What a refused outbound leg means for the owner. null: not a result about the line (our own setup failed). */
export function failureStatus(outcome: Extract<DialOutcome, { kind: 'failed' }>): ForwardingCheckStatus | null {
  const code = outcome.sipStatus
  if (code === 486 || code === 600) return 'busy'
  if (code === 408 || code === 480 || code === 487) return 'rang_through'
  if (code === 401 || code === 407) return null
  if (code !== null && code >= 400) return 'unreachable'
  if (/timed? ?out|no answer|ringing timeout/i.test(outcome.message)) return 'rang_through'
  return null
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * `dev`: nothing is dialled; the business number's last digit picks what happens (devForwardingOutcome). A forwarded
 * call arrives through the same path a real one takes (claimForwardingCheck), so the whole check runs locally.
 */
export function devDialer(
  arrive: (from: string, to: string) => Promise<void>,
  timing = { forwardMs: 2500, failMs: 1500, noAnswerMs: 6000 },
): CheckDialer {
  let reached = false
  return {
    async dial({ from, to, linedeskNumber }) {
      reached = false
      const outcome: DevForwardingOutcome = devForwardingOutcome(to)
      if (outcome === 'forwarded') {
        await sleep(timing.forwardMs)
        await arrive(from, linedeskNumber)
        return { kind: 'answered' }
      }
      if (outcome === 'answered' || outcome === 'no_assistant') {
        if (outcome === 'no_assistant') reached = true
        await sleep(timing.forwardMs)
        return { kind: 'answered' }
      }
      if (outcome === 'no_answer') {
        await sleep(timing.noAnswerMs)
        return { kind: 'failed', sipStatus: 480, message: 'simulated: no answer' }
      }
      await sleep(timing.failMs)
      return outcome === 'busy'
        ? { kind: 'failed', sipStatus: 486, message: 'simulated: busy' }
        : { kind: 'failed', sipStatus: 404, message: 'simulated: not reachable' }
    },
    async hangUp() {},
    async reachedLinedesk() {
      return reached
    },
  }
}

/** A forwarding check's dial through LiveKit SIP and the install's check trunk; hangs up by deleting the room. */
export function livekitDialer(
  trunk: () => Promise<string>,
  reprovision: (failed: string) => Promise<string>,
  env: Env,
  doFetch: typeof fetch = fetch,
): CheckDialer {
  const sip = livekitSip(env, doFetch)
  if (!sip) throw new Error('LiveKit is not set up')
  const attempt = async (trunkId: string, call: Parameters<CheckDialer['dial']>[0]): Promise<DialOutcome> => {
    try {
      await sip.createSipParticipant(
        {
          sipTrunkId: trunkId,
          sipCallTo: call.to,
          sipNumber: call.from,
          roomName: call.room,
          participantIdentity: 'forwarding-check',
          participantName: 'Forwarding check',
          waitUntilAnswered: true,
          ringingTimeout: `${call.ringSeconds}s`,
          maxCallDuration: `${call.ringSeconds + 30}s`,
        },
        (call.ringSeconds + 15) * 1000,
      )
      return { kind: 'answered' }
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'TimeoutError'
      const message = timedOut ? 'no answer (timed out)' : e instanceof Error ? e.message : String(e)
      const body = e instanceof LivekitError && typeof e.body.msg === 'string' ? `: ${e.body.msg.slice(0, 200)}` : ''
      return { kind: 'failed', sipStatus: timedOut ? null : sipStatusOf(e), message: `${message}${body}` }
    }
  }
  return {
    async dial(call) {
      const trunkId = await trunk()
      const outcome = await attempt(trunkId, call)
      // The carrier refused the trunk's credentials (rotated elsewhere): set it up again and dial once more.
      if (outcome.kind === 'failed' && (outcome.sipStatus === 401 || outcome.sipStatus === 407))
        return attempt(await reprovision(trunkId), call)
      return outcome
    },
    async hangUp(room) {
      await deleteLivekitRoom(room, env, doFetch).catch(() => false)
    },
    async reachedLinedesk(call) {
      const room = await findSipCallerRoom(call, env, doFetch)
      if (room) await deleteLivekitRoom(room, env, doFetch).catch(() => false)
      return room !== null
    },
  }
}

/**
 * A number as typed in Server admin as E.164, or null. Written with + (or 00) it is read as it is ("+44 20 7946 0000" stays
 * British); only a bare ten-digit number (or eleven starting with 1) without a country code is read as North American.
 */
export function asE164(value: string | undefined | null): string | null {
  const text = (value ?? '').trim()
  const international = /^(\+|00)/.test(text)
  const digits = text.replace(/^00/, '').replace(/\D/g, '')
  if (international) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
}

let provisioning: Promise<string> | null = null

/** How many of the account's numbers are looked at for a free one (the most one page holds at Telnyx). */
const ACCOUNT_NUMBERS_PAGE = 250

/**
 * The check number set for the install (Server admin › Providers, or its variable), or the dev caller ID; else null.
 */
export async function configuredCheckNumber(tx: Tx): Promise<string | null> {
  const carrier = await installTelephony(tx)
  if ('named' in carrier) return carrier.named === 'dev' ? DEV_CHECK_NUMBER : null
  return asE164(carrier.config.check_number?.value)
}

type InstallCarrier = Extract<Awaited<ReturnType<typeof installTelephony>>, { provider: unknown }>

/**
 * The number the install's checks call from, or why there is none; dials nothing. Under `dev` the simulated caller
 * ID. `accountNumbers`: the numbers in the install's carrier account (asked only when no check number is set).
 */
async function checkCaller(
  carrier: Awaited<ReturnType<typeof installTelephony>>,
  env: Env,
  doFetch: typeof fetch,
  accountNumbers: () => Promise<string[]>,
): Promise<
  | { unavailable: string }
  | { callerNumber: string; simulated: true }
  | { callerNumber: string; simulated: false; carrier: InstallCarrier }
> {
  if ('named' in carrier) {
    if (carrier.named !== 'dev') return { unavailable: `the carrier ${carrier.named} has no forwarding check` }
    return { callerNumber: DEV_CHECK_NUMBER, simulated: true }
  }
  if (!livekitSip(env, doFetch)) return { unavailable: 'LiveKit is not set up on this server' }
  const used = new Set((await db.select({ e164: phone_numbers.e164 }).from(phone_numbers)).map(n => n.e164))
  let callerNumber = asE164(carrier.config.check_number?.value)
  if (callerNumber && used.has(callerNumber))
    return {
      unavailable: `the forwarding check number ${callerNumber} is a workspace's number; pick another in Server admin › Providers`,
    }
  // One page: an account with more numbers than that and none free among them sets the check number instead.
  if (!callerNumber) callerNumber = (await accountNumbers().catch(() => [])).find(e164 => !used.has(e164)) ?? null
  if (!callerNumber)
    return {
      unavailable:
        'no number to call from: every number in the carrier account belongs to a workspace; add a forwarding check number in Server admin › Providers',
    }
  return { callerNumber, simulated: false, carrier }
}

const listAccountNumbers = async () =>
  (await (await db.transaction(tx => telephonyProvider(tx))).listNumbers(ACCOUNT_NUMBERS_PAGE)).map(n => n.e164)

/** The account's numbers as the availability answer reads them: asked of the carrier at most once a minute. */
let accountNumbersCache: { at: number; numbers: Promise<string[]> } | null = null
const cachedAccountNumbers = () => {
  if (!accountNumbersCache || Date.now() - accountNumbersCache.at > 60_000)
    accountNumbersCache = { at: Date.now(), numbers: listAccountNumbers().catch(() => []) }
  return accountNumbersCache.numbers
}

/**
 * Whether this server can run a forwarding check now, and whether it would be simulated (`dev`), without dialling:
 * what the web app reads before it offers "Check forwarding". The reason it cannot stays in the server's log.
 */
export async function forwardingCheckAvailability(
  tx: Tx,
  env: Env = process.env,
  doFetch: typeof fetch = fetch,
): Promise<{ available: boolean; simulated: boolean }> {
  const caller = await checkCaller(await installTelephony(tx, env), env, doFetch, cachedAccountNumbers).catch(e => ({
    unavailable: e instanceof Error ? e.message : String(e),
  }))
  if ('unavailable' in caller) return { available: false, simulated: false }
  return { available: true, simulated: caller.simulated }
}

/**
 * The install's check line: the check number from Server admin › Providers (the carrier's "Forwarding check number"),
 * else the first number in the install's carrier account that no workspace uses. Under `dev`: a simulation. Never a
 * workspace's number, so a business never sees one of its own numbers or another business's calling.
 */
export async function installCheckLine(env: Env = process.env, doFetch: typeof fetch = fetch): Promise<CheckLine> {
  const found = await checkCaller(await db.transaction(tx => installTelephony(tx)), env, doFetch, listAccountNumbers)
  if ('unavailable' in found) return found
  if (found.simulated)
    return {
      callerNumber: found.callerNumber,
      simulated: true,
      dialer: devDialer(async (from, to) => {
        await db.transaction(tx => claimForwardingCheck(tx, { from, to, now: new Date().toISOString() }).then(() => {}))
      }),
    }
  const { carrier, callerNumber } = found
  const values = Object.fromEntries(Object.entries(carrier.config).map(([field, v]) => [field, v?.value ?? '']))
  const name = installCarrierName(CHECK_TRUNK_NAME)
  const sip = livekitSip(env, doFetch)!
  const outbound = async (): Promise<OutboundSip> => {
    const timed: typeof fetch = (input, init) =>
      doFetch(input, { ...init, signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS) })
    if (carrier.provider === 'telnyx') {
      // The check line calls business numbers of every workspace: the install's ceiling; each check is held to the
      // same list before it is queued (phoneNumber.checkForwarding).
      const destinations = await db.transaction(tx => installDestinations(tx))
      return createTelnyxOutbound({
        apiKey: values.api_key!,
        name,
        destinations: destinations.length ? destinations : undefined,
        spendLimits: telnyxSpendLimits(env),
        onSpendCaps: problem => recordSpendCaps(name, problem),
        fetch: timed,
      }).ensureOutboundSip()
    }
    return createTwilioOutbound({
      accountSid: values.account_sid!,
      authToken: values.auth_token!,
      name,
      fetch: timed,
    }).ensureOutboundSip()
  }
  const caller = callerNumber
  const existingTrunk = async () =>
    (await sip.outboundTrunks()).find(t => t.name === name && t.numbers?.includes(caller))?.sipTrunkId ?? null
  /**
   * A new password at the carrier and a new LiveKit trunk with it; the old trunks go after. One at a time in this
   * process, and under a Postgres lock across processes, so one API never rotates the password under another's dial.
   * `failed`: the trunk the carrier just refused; a different trunk found under the lock was set up by another
   * process meanwhile and is used as it is.
   */
  const provision = (failed: string | null = null): Promise<string> => {
    provisioning ??= db
      .transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${TRUNK_LOCK}))`)
        const current = await existingTrunk()
        if (current && current !== failed) return current
        const trunkId = await sip.createOutboundTrunk(name, [caller], await outbound())
        for (const old of await sip.outboundTrunks())
          if (old.name === name && old.sipTrunkId !== trunkId) await sip.deleteTrunk(old.sipTrunkId)
        return trunkId
      })
      .finally(() => {
        provisioning = null
      })
    return provisioning
  }
  const trunk = async () => (await existingTrunk()) ?? provision()
  return { callerNumber, dialer: livekitDialer(trunk, provision, env, doFetch) }
}

export type RunDeps = {
  line?: () => Promise<CheckLine>
  ringSeconds?: number
  graceMs?: number
  pollMs?: number
}

const loadCheck = async (id: string) =>
  (await db.select().from(forwarding_checks).where(eq(forwarding_checks.id, id)))[0]

/** Ends a check that is still dialing: an arrival that came first is never overwritten. */
async function finish(
  id: string,
  status: ForwardingCheckStatus,
  detail: string | null,
  { onlyUndialled = false, ...extra }: { arrived_at?: string; onlyUndialled?: boolean } = {},
) {
  await db
    .update(forwarding_checks)
    .set({ status, detail, finished_at: new Date().toISOString(), ...extra })
    .where(
      and(
        eq(forwarding_checks.id, id),
        eq(forwarding_checks.status, 'dialing'),
        onlyUndialled ? isNull(forwarding_checks.dialed_at) : undefined,
      ),
    )
}

/** Resolves once the check's call arrived (status left `dialing`), polling the row; or never, until `stop`. */
function arrival(id: string, pollMs: number, stopped: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const tick = async () => {
      if (stopped()) return
      const check = await loadCheck(id).catch(() => undefined)
      if (check && check.status !== 'dialing') return resolve()
      setTimeout(tick, pollMs)
    }
    void tick()
  })
}

/**
 * Runs one check (the forwarding.check job): finds the check line, dials the business number, and ends with what
 * happened. The arriving call is claimed by call.start; this only watches the row for it, and hangs up as soon as
 * it arrived, or when the business phone was answered, was busy or rang out.
 */
export async function runForwardingCheck(checkId: string, deps: RunDeps = {}): Promise<ForwardingCheckStatus> {
  const ringSeconds = deps.ringSeconds ?? FORWARDING_RING_SECONDS
  const graceMs = deps.graceMs ?? ARRIVAL_GRACE_MS
  const pollMs = deps.pollMs ?? 1000
  const check = await loadCheck(checkId)
  if (check?.status !== 'dialing') return check?.status ?? 'not_checked'
  // Queued too long (jobs were down, the API restarted): the owner was already told it did not run.
  if (Date.now() - Date.parse(check.started_at) > MAX_QUEUE_MS) {
    await finish(checkId, 'not_checked', storedDetail(msg('server.api.forwardingCheck.notStartedInTime')))
    return 'not_checked'
  }
  let line: CheckLine
  try {
    line = await (deps.line ?? (() => installCheckLine()))()
  } catch (e) {
    line = { unavailable: e instanceof Error ? e.message : String(e) }
  }
  if ('unavailable' in line) {
    // The reason is for whoever runs the server (carrier and LiveKit errors, setting names): logged, not shown.
    console.warn(`forwarding check ${checkId}: no check line: ${line.unavailable}`)
    await finish(checkId, 'not_checked', storedDetail(msg('server.api.forwardingCheck.notAvailable')))
    return 'not_checked'
  }
  // Never the install calling itself: not the check number, not any Linedesk number (the action refused both too).
  const [own] = await db
    .select({ id: phone_numbers.id })
    .from(phone_numbers)
    .where(eq(phone_numbers.e164, check.business_number))
  if (own || check.business_number === line.callerNumber) {
    await finish(checkId, 'not_checked', storedDetail(msg('server.api.forwardingCheck.ownNumber')))
    return 'not_checked'
  }
  // Setting up the line can take a while: past MAX_QUEUE_MS the owner already sees "did not finish", so never dial then.
  const [dialing] = await db
    .update(forwarding_checks)
    .set({ caller_number: line.callerNumber, dialed_at: new Date().toISOString(), simulated: line.simulated === true })
    .where(
      and(
        eq(forwarding_checks.id, checkId),
        eq(forwarding_checks.status, 'dialing'),
        isNull(forwarding_checks.dialed_at),
        gt(forwarding_checks.started_at, new Date(Date.now() - MAX_QUEUE_MS).toISOString()),
      ),
    )
    .returning()
  if (!dialing) {
    // Too late, or another run took it (a job retried by hand), or it ended meanwhile.
    await finish(checkId, 'not_checked', storedDetail(msg('server.api.forwardingCheck.notStartedInTime')), {
      onlyUndialled: true,
    })
    return (await loadCheck(checkId))?.status ?? 'not_checked'
  }
  const status = async (fallback: ForwardingCheckStatus) => (await loadCheck(checkId))?.status ?? fallback
  const room = `${CHECK_ROOM_PREFIX}${checkId}`
  let done = false
  const arrived = arrival(checkId, pollMs, () => done).then(() => 'arrived' as const)
  try {
    const first = await Promise.race([
      arrived,
      line.dialer.dial({
        room,
        from: line.callerNumber,
        to: check.business_number,
        linedeskNumber: check.linedesk_number,
        ringSeconds,
      }),
    ])
    if (first === 'arrived') return status('works')
    if (first.kind === 'answered') {
      // Answered: by Linedesk when the call was forwarded (it arrives in a moment), else by voicemail or a person.
      const late = await Promise.race([arrived, sleep(graceMs).then(() => 'late' as const)])
      if (late === 'arrived') return status('works')
      // Reached Linedesk all the same, but nothing claimed it: the assistant (the agent) did not start.
      const reached = await line.dialer
        .reachedLinedesk({
          from: line.callerNumber,
          to: check.linedesk_number,
          sinceMs: Date.parse(dialing.dialed_at!),
        })
        .catch(() => false)
      if (reached)
        await finish(checkId, 'no_assistant', storedDetail(msg('server.api.forwardingCheck.noAssistant')), {
          arrived_at: new Date().toISOString(),
        })
      else await finish(checkId, 'answered', storedDetail(msg('server.api.forwardingCheck.answeredFirst')))
      return status(reached ? 'no_assistant' : 'answered')
    }
    const result = failureStatus(first)
    // LiveKit's and the carrier's own words stay in the log; the business sees the result and our text.
    console.warn(`forwarding check ${checkId}: ${first.sipStatus ?? ''} ${first.message}`.trim().slice(0, 500))
    await finish(
      checkId,
      result ?? 'not_checked',
      result ? null : storedDetail(msg('server.api.forwardingCheck.notPlaced')),
    )
    return status('not_checked')
  } catch (e) {
    console.warn(`forwarding check ${checkId} failed: ${e instanceof Error ? e.message : String(e)}`)
    await finish(checkId, 'not_checked', storedDetail(msg('server.api.forwardingCheck.notPlaced')))
    return 'not_checked'
  } finally {
    done = true
    await line.dialer.hangUp(room).catch(() => {})
  }
}

// ─── The actions ──────────────────────────────────────────────────────────────────────────────────────────

type Queue = (tx: Tx, checkId: string) => Promise<void>

/** In how many hours (at least one) a limit counted over the last 24 hours frees up again, from the oldest check it counted. */
const hoursUntilFree = (oldestMs: number, nowMs: number) =>
  Math.max(1, Math.ceil((oldestMs + 24 * 3600_000 - nowMs) / 3600_000))

/** When that is, as a sentence in a reader's words (English by default). */
export const tryAgain = (oldestMs: number, nowMs: number, reader?: Reader): string =>
  sayIn({ key: msg('server.api.forwardingCheck.tryAgain'), params: { hours: hoursUntilFree(oldestMs, nowMs) } }, reader)

/** Checks on the whole install in a day: `FORWARDING_CHECKS_PER_DAY`, else the default. */
export function installCheckCap(env: Env = process.env): number {
  const n = Number(env.FORWARDING_CHECKS_PER_DAY)
  return Number.isInteger(n) && n >= 0 && env.FORWARDING_CHECKS_PER_DAY !== '' ? n : FORWARDING_CHECKS_PER_INSTALL_DAY
}

/**
 * Line lookups already made, by workspace and number, for a day: the line of a business number rarely changes. Kept
 * per workspace, so a fast answer never tells one workspace that another looked the number up.
 */
const LOOKUP_CACHE_MS = 24 * 3600_000
const LOOKUP_CACHE_SIZE = 1000
const lookups = new Map<string, { data: LineLookupData; at: number }>()

function cachedLookup(key: string, nowMs: number): LineLookupData | null {
  const hit = lookups.get(key)
  if (!hit) return null
  if (nowMs - hit.at <= LOOKUP_CACHE_MS) return hit.data
  lookups.delete(key)
  return null
}

function rememberLookup(key: string, data: LineLookupData, nowMs: number) {
  if (lookups.size >= LOOKUP_CACHE_SIZE) lookups.delete(lookups.keys().next().value!)
  lookups.set(key, { data, at: nowMs })
}

/**
 * Counts a lookup against the daily limits (the workspace's and the install's) and records it, under one lock so two
 * at once never both slip under them. Its own short transaction: the action runs outside one, and the carrier's
 * answer is not waited for inside it.
 */
async function reserveLookup(workspaceId: string, e164: string, nowMs: number) {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOOKUP_LOCK}))`)
    const dayAgo = new Date(nowMs - 24 * 3600_000).toISOString()
    const [counts] = await tx
      .select({
        install: count(),
        workspace: sql<number>`count(*) filter (where ${line_lookups.workspace_id} = ${workspaceId})`.mapWith(Number),
      })
      .from(line_lookups)
      .where(gte(line_lookups.looked_up_at, dayAgo))
    if ((counts?.workspace ?? 0) >= LINE_LOOKUPS_PER_WORKSPACE_DAY)
      throw refused(msg('server.api.forwardingCheck.tooManyLookupsToday'))
    if ((counts?.install ?? 0) >= LINE_LOOKUPS_PER_INSTALL_DAY)
      throw refused(msg('server.api.forwardingCheck.lookupsPaused'))
    await tx.insert(line_lookups).values({
      id: `llk_${crypto.randomUUID().replaceAll('-', '')}`,
      workspace_id: workspaceId,
      number: e164,
      looked_up_at: new Date(nowMs).toISOString(),
    })
  })
}

/** Forgets the cached lookups (tests). */
export const clearLineLookups = () => lookups.clear()

/** The forwarding check's handlers; `queue` puts the check's job in the action's transaction (jobs.ts). */
export function forwardingCheckHandlers(queue: Queue, env: Env = process.env): Record<string, Handler> {
  return {
    // Read-only in the registry: runs outside a transaction, so the request to the carrier holds none open.
    'phoneNumber.lookupLine': async ({ tx, actor, telephony, now }, input: { number: string }) => {
      if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
      const nowMs = Date.parse(now)
      const key = `${actor.workspaceId}:${input.number}`
      const cached = cachedLookup(key, nowMs)
      if (cached) return { rows: {}, data: cached }
      if (!allowLookup(actor.workspaceId)) throw refused(msg('server.api.forwardingCheck.tooManyLookups'))
      await reserveLookup(actor.workspaceId, input.number, nowMs)
      const provider = telephony ?? (await telephonyForWorkspace(tx, actor.workspaceId)).provider
      try {
        const found = await provider.lookupNumber(input.number)
        const data: LineLookupData = {
          lineType: found.lineType,
          carrier: found.carrier,
          // A guide of the business line's own country first (a carrier name can exist in several countries).
          carrierId: forwardingGuideForCarrier(found.carrier, phoneCountry(input.number))?.id ?? null,
          // `dev` answers the same made-up carrier for every number.
          simulated: provider.name === 'dev',
        }
        rememberLookup(key, data, nowMs)
        return { rows: {}, data }
      } catch (e) {
        if (!(e instanceof TelephonyError)) throw e
        console.warn(`line lookup failed: ${e.message}`)
        throw refused(msg('server.api.forwardingCheck.lookupFailed'))
      }
    },

    'phoneNumber.checkForwarding': async (
      { tx, actor, now },
      input: { phoneNumberId: string; businessNumber?: string },
    ) => {
      if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
      if (actor.workspaceDisabled) throw new Reject(english.t('server.api.workspaceDisabled'))
      const workspaceId = actor.workspaceId
      const [number] = await tx
        .select()
        .from(phone_numbers)
        .where(and(eq(phone_numbers.id, input.phoneNumberId), eq(phone_numbers.workspace_id, workspaceId)))
      if (!number) throw new Reject(english.t('server.api.phoneNumberNotFound'))
      if (!FORWARDING_MODES.has(number.mode)) throw new Reject(english.t('server.api.forwardingCheck.onlyForwarded'))
      const [lastChecked] =
        input.businessNumber || number.forwarded_from
          ? []
          : await tx
              .select({ businessNumber: forwarding_checks.business_number })
              .from(forwarding_checks)
              .where(
                and(eq(forwarding_checks.workspace_id, workspaceId), eq(forwarding_checks.phone_number_id, number.id)),
              )
              .orderBy(desc(forwarding_checks.started_at))
              .limit(1)
      const businessNumber = input.businessNumber ?? number.forwarded_from ?? lastChecked?.businessNumber
      if (!businessNumber) throw refused(msg('server.api.forwardingCheck.enterNumber'))
      // The saved number is checked like a typed one: it may come from before these rules.
      if (!isCheckableBusinessNumber(businessNumber)) throw refused(msg('server.api.forwardingCheck.enterLandline'))
      // The destination policy, like a transfer. The check line is the install's, so the install's own ceiling: the
      // countries of the install-account numbers plus the install's list, never a workspace's own-account countries.
      // A workspace whose numbers are all in its own account can check a line in those countries (its business is
      // usually where its numbers are); the check's own limits keep the cost small (per hour, day and number, 40 s).
      const refusal = outboundNumberProblem(businessNumber, await installDestinations(tx), 'check')
      if (refusal) throw new Reject(refusal.message)
      // Never a Linedesk number (any workspace's). Another workspace's saved business number is no reason to refuse:
      // a check saves it from a caller ID, which can be faked, so it must never lock the number's real owner out.
      const [taken] = await tx
        .select({ e164: phone_numbers.e164 })
        .from(phone_numbers)
        .where(eq(phone_numbers.e164, businessNumber))
      if (taken) throw refused(msg('server.api.forwardingCheck.linedeskNumber'))
      if (businessNumber === (await configuredCheckNumber(tx)))
        throw refused(msg('server.api.forwardingCheck.checkNumber'))
      const [workspace] = await tx
        .select({ disabledAt: organization.disabledAt })
        .from(organization)
        .where(eq(organization.id, workspaceId))
      if (workspace?.disabledAt) throw new Reject(english.t('server.api.workspaceDisabled'))
      // One lock for the whole install: the limits count across workspaces, and two starts never both slip under them.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${START_LOCK}))`)
      const nowMs = Date.parse(now)
      const dayAgo = new Date(nowMs - 24 * 3600_000).toISOString()
      const today = await tx
        .select({
          workspaceId: forwarding_checks.workspace_id,
          businessNumber: forwarding_checks.business_number,
          status: forwarding_checks.status,
          startedAt: forwarding_checks.started_at,
          dialedAt: forwarding_checks.dialed_at,
        })
        .from(forwarding_checks)
        .where(
          and(
            gte(forwarding_checks.started_at, dayAgo),
            or(eq(forwarding_checks.workspace_id, workspaceId), eq(forwarding_checks.business_number, businessNumber)),
          ),
        )
        .orderBy(forwarding_checks.started_at)
      // A call to the number counts: a check that dialled, or one about to (refused and expired ones called nobody).
      const called = (c: (typeof today)[number]) =>
        c.dialedAt !== null || (c.status === 'dialing' && nowMs - Date.parse(c.startedAt) <= MAX_QUEUE_MS + 10_000)
      const ours = today.filter(c => c.workspaceId === workspaceId)
      if (ours.some(c => c.status === 'dialing' && nowMs - Date.parse(c.startedAt) <= STALE_MS))
        throw refused(msg('server.api.forwardingCheck.alreadyRunning'))
      const lastHour = ours.filter(c => Date.parse(c.startedAt) >= nowMs - 3600_000).length
      if (lastHour >= FORWARDING_CHECKS_PER_HOUR || ours.length >= FORWARDING_CHECKS_PER_DAY)
        throw refused(msg('server.api.forwardingCheck.tooManyChecks'))
      const lastByNumber = new Map(ours.map(c => [c.businessNumber, c.startedAt]))
      if (!lastByNumber.has(businessNumber) && lastByNumber.size >= FORWARDING_NUMBERS_PER_WORKSPACE_DAY)
        throw refused(msg('server.api.forwardingCheck.twoNumbers'), {
          tryAgain: reader => tryAgain(Math.min(...[...lastByNumber.values()].map(Date.parse)), nowMs, reader),
        })
      // Calls to one business number in a day. The workspace it forwards to (forwarded_from) and the first workspace
      // to call it today each have their own quota; every other workspace shares one. So nobody can call a stranger's
      // number more than a few times a day, and nobody can use up the quota of the number's own business.
      const toNumber = today.filter(c => c.businessNumber === businessNumber && called(c))
      const first = toNumber[0]?.workspaceId
      const owner = number.forwarded_from === businessNumber
      const pool =
        owner || first === undefined || first === workspaceId
          ? toNumber.filter(c => c.workspaceId === workspaceId)
          : toNumber.filter(c => c.workspaceId !== first)
      if (pool.length >= FORWARDING_CHECKS_PER_NUMBER_DAY)
        throw refused(msg('server.api.forwardingCheck.severalTimes'), {
          tryAgain: reader => tryAgain(Date.parse(pool[0]!.startedAt), nowMs, reader),
        })
      const [installToday] = await tx
        .select({ n: count(), oldest: sql<string | null>`min(${forwarding_checks.started_at})` })
        .from(forwarding_checks)
        .where(
          and(
            gte(forwarding_checks.started_at, dayAgo),
            sql`(${forwarding_checks.dialed_at} is not null or (${forwarding_checks.status} = 'dialing' and ${forwarding_checks.started_at} > ${new Date(nowMs - MAX_QUEUE_MS - 10_000).toISOString()}))`,
          ),
        )
      if ((installToday?.n ?? 0) >= installCheckCap(env))
        throw refused(msg('server.api.forwardingCheck.paused'), {
          tryAgain: reader => tryAgain(Date.parse(installToday?.oldest ?? now), nowMs, reader),
        })
      const [check] = await tx
        .insert(forwarding_checks)
        .values({
          id: `fwc_${crypto.randomUUID().replaceAll('-', '')}`,
          workspace_id: workspaceId,
          phone_number_id: number.id,
          business_number: businessNumber,
          linedesk_number: number.e164,
          created_by: actor.actorId,
          started_at: now,
        })
        .returning()
      await queue(tx, check!.id)
      return { rows: {}, data: checkView(check!, nowMs, wordsOf(actor)) }
    },

    'phoneNumber.forwardingCheck': async ({ tx, actor, now }, input: { phoneNumberId: string }) => {
      if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
      const [check] = await tx
        .select()
        .from(forwarding_checks)
        .where(
          and(
            eq(forwarding_checks.workspace_id, actor.workspaceId),
            eq(forwarding_checks.phone_number_id, input.phoneNumberId),
          ),
        )
        .orderBy(desc(forwarding_checks.started_at))
        .limit(1)
      // Whether "Check forwarding" can run here (and is simulated), so the web app never offers one that cannot.
      const { available, simulated } = await forwardingCheckAvailability(tx, env)
      const view = check ? checkView(check, Date.parse(now), wordsOf(actor)) : null
      return { rows: {}, data: { check: view, available, simulated } }
    },
  }
}
