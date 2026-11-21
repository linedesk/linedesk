// Whether Linedesk's Telnyx voice profiles have the spend limits (TELNYX_MAX_DESTINATION_RATE, TELNYX_DAILY_SPEND_LIMIT):
// one instance_settings row per profile whose limits could not be confirmed (key `telnyx.spendCaps:<profile name>`,
// value JSON with the problem and when), written by the startup sync and the set-ups (outbound-policy.ts,
// transfer-trunk.ts, forwarding-check.ts). A confirmation deletes the row. Server admin › Settings › Calls warns while one exists.
import { instance_settings, type Tx } from '@linedesk/db'
import { and, eq, like, notInArray } from 'drizzle-orm'
import { db } from './db.ts'

const PREFIX = 'telnyx.spendCaps:'
/**
 * Stands for every workspace's own-account profile when the list of those workspaces could not be read: the warning
 * shows, and the next sync that reads the list removes it (pruneSpendCaps).
 */
export const WORKSPACE_PROFILES = 'linedesk-outbound-<workspace id>'

export type UnconfirmedSpendCaps = { profile: string; problem: string; at: string }

/**
 * Records the result for one profile: `problem` null when Telnyx confirmed both limits (or the profile does not exist,
 * so nothing uncapped is in use), else what went wrong. Its own short write, outside any caller's transaction, so a
 * rolled-back set-up still leaves the warning. Never throws: the record is a warning, not a gate.
 */
export async function recordSpendCaps(profile: string, problem: string | null, now = new Date().toISOString()) {
  const key = `${PREFIX}${profile}`
  try {
    if (problem === null) {
      await db.delete(instance_settings).where(eq(instance_settings.key, key))
      return
    }
    const value = JSON.stringify({ problem: problem.slice(0, 500), at: now })
    await db
      .insert(instance_settings)
      .values({ key, value, updated_at: now })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now } })
  } catch (e) {
    console.error(`outbound: could not record the spend limits of "${profile}": ${e instanceof Error ? e.message : e}`)
  }
}

/** Drops the records of profiles Linedesk no longer manages (a workspace that left Telnyx), all but `keep`. */
export async function pruneSpendCaps(keep: string[]) {
  const keys = keep.map(profile => `${PREFIX}${profile}`)
  try {
    await db
      .delete(instance_settings)
      .where(
        keys.length
          ? and(like(instance_settings.key, `${PREFIX}%`), notInArray(instance_settings.key, keys))
          : like(instance_settings.key, `${PREFIX}%`),
      )
  } catch (e) {
    console.error(`outbound: could not prune the spend limit records: ${e instanceof Error ? e.message : e}`)
  }
}

/** The profiles whose spend limits are not confirmed, oldest first (Server admin › Settings › Calls). */
export async function unconfirmedSpendCaps(tx: Tx): Promise<UnconfirmedSpendCaps[]> {
  const rows = await tx
    .select()
    .from(instance_settings)
    .where(like(instance_settings.key, `${PREFIX}%`))
  return rows
    .flatMap(row => {
      const profile = row.key.slice(PREFIX.length)
      let parsed: { problem?: string; at?: string }
      try {
        parsed = JSON.parse(row.value)
      } catch {
        // A row this file did not write: skipped (the next confirmation or prune removes it), never the whole view.
        console.error(`outbound: the spend limit record of "${profile}" is not valid JSON; skipped`)
        return []
      }
      return [{ profile, problem: parsed?.problem ?? '', at: parsed?.at ?? row.updated_at }]
    })
    .sort((a, b) => a.at.localeCompare(b.at))
}
