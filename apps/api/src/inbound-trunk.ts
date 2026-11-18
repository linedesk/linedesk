// The numbers LiveKit's inbound trunk ("linedesk-inbound", made once per install by the agent's setup-sip) accepts
// calls to: exactly the connected numbers (phone_numbers, every workspace and carrier account). LiveKit refuses a
// call to any other number, so the API writes the list
// - after phoneNumber.setup and phoneNumber.release commit (the number takes calls when the command answers),
// - when it starts and every SYNC_EVERY_MS, so a write that failed (LiveKit down, a deploy) or a number that went
//   another way (a workspace deleted) is put right, and a failed write is tried again after RETRY_MS.
// Only the numbers: the trunk's allowed source addresses (the carriers' signaling addresses), the SIP headers it
// passes and the call length stay setup-sip's. Without the trunk nothing is written (setup-sip makes it). The list
// is never written empty: LiveKit would leave it as it is (`set`) or accept every number (`clear`).
// Writes never overlap: one at a time in a process (a request while one runs makes one more run after it) and
// under an advisory lock across processes (old and new API during a deploy); each reads the numbers under the
// lock, so the last write carries every committed change.
import { phone_numbers } from '@linedesk/db'
import { asc, sql } from 'drizzle-orm'
import { db } from './db.ts'
import { livekitSip } from './transfer-trunk.ts'

/** The trunk's name, as in apps/agent/src/sip-trunks.ts (INBOUND_TRUNK_NAME). */
export const INBOUND_TRUNK_NAME = 'linedesk-inbound'
export const SYNC_EVERY_MS = 5 * 60_000
/** Waits before the next tries after a failed write; then the periodic sync. */
export const RETRY_MS = [15_000, 60_000]

type Env = Record<string, string | undefined>
export type InboundSyncDeps = { env?: Env; fetch?: typeof fetch }

export type InboundSyncResult =
  | { status: 'off' | 'missing' | 'no-numbers' | 'unchanged' }
  | { status: 'updated'; added: string[]; removed: string[] }

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(n => b.includes(n))

/** Writes the connected numbers to the inbound trunk once. Throws when LiveKit or the database fails. */
export async function syncInboundTrunk(deps: InboundSyncDeps = {}): Promise<InboundSyncResult> {
  const sip = livekitSip(deps.env, deps.fetch)
  if (!sip) return { status: 'off' }
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`livekit-trunk:${INBOUND_TRUNK_NAME}`}))`)
    const rows = await tx
      .selectDistinct({ e164: phone_numbers.e164 })
      .from(phone_numbers)
      .orderBy(asc(phone_numbers.e164))
    const numbers = rows.map(row => row.e164)
    const trunks = (await sip.inboundTrunks()).filter(trunk => trunk.name === INBOUND_TRUNK_NAME)
    if (!trunks.length) return { status: 'missing' }
    if (!numbers.length) return { status: 'no-numbers' }
    const added = new Set<string>()
    const removed = new Set<string>()
    for (const trunk of trunks) {
      const current = trunk.numbers ?? []
      if (sameSet(current, numbers)) continue
      await sip.setInboundNumbers(trunk.sipTrunkId, numbers)
      for (const n of numbers) if (!current.includes(n)) added.add(n)
      for (const n of current) if (!numbers.includes(n)) removed.add(n)
    }
    if (!added.size && !removed.size) return { status: 'unchanged' }
    return { status: 'updated', added: [...added], removed: [...removed] }
  })
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** What a sync leaves in the log; a state that stays (no trunk, no numbers) is logged once, not every few minutes. */
let lastNotice: string | null = null
function report(result: InboundSyncResult) {
  let notice: string | null = null
  if (result.status === 'missing')
    notice = `WARNING inbound trunk: LiveKit has no "${INBOUND_TRUNK_NAME}" trunk, so no call reaches an assistant; run setup-sip once`
  else if (result.status === 'no-numbers')
    notice = `inbound trunk: no number is connected; "${INBOUND_TRUNK_NAME}" keeps the numbers it has`
  else if (result.status === 'updated') {
    const parts = [
      result.added.length ? `added ${result.added.join(', ')}` : '',
      result.removed.length ? `removed ${result.removed.join(', ')}` : '',
    ]
    console.log(`inbound trunk "${INBOUND_TRUNK_NAME}": ${parts.filter(Boolean).join('; ')}`)
  }
  if (notice && notice !== lastNotice) console.warn(notice)
  lastNotice = notice
}

let waiting: Promise<InboundSyncResult | null> | null = null
let chain: Promise<unknown> = Promise.resolve()
let failures = 0
let retry: ReturnType<typeof setTimeout> | null = null

/**
 * Asks for a sync that starts after this call: joins the one waiting to start, else queues one behind the one
 * running. Never throws: a failure is logged (ALERT) and tried again after RETRY_MS. Resolves with the result,
 * null when it failed.
 */
export function requestInboundTrunkSync(deps: InboundSyncDeps = {}): Promise<InboundSyncResult | null> {
  if (waiting) return waiting
  const run = chain.then(async () => {
    waiting = null
    try {
      const result = await syncInboundTrunk(deps)
      failures = 0
      report(result)
      return result
    } catch (e) {
      console.error(`ALERT inbound trunk: the numbers of "${INBOUND_TRUNK_NAME}" were not updated: ${message(e)}`)
      const wait = RETRY_MS[failures++]
      if (wait !== undefined && !retry) {
        retry = setTimeout(() => {
          retry = null
          void requestInboundTrunkSync(deps)
        }, wait)
        retry.unref()
      }
      return null
    }
  })
  waiting = run
  chain = run
  return run
}

/** At the API's start: a sync now and every SYNC_EVERY_MS. Returns a stop function. */
export function startInboundTrunkSync(deps: InboundSyncDeps = {}) {
  void requestInboundTrunkSync(deps)
  const timer = setInterval(() => void requestInboundTrunkSync(deps), SYNC_EVERY_MS)
  timer.unref()
  return () => clearInterval(timer)
}
