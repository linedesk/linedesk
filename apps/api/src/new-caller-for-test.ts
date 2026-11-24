// The phone-to-phone call test's "new caller" (call.newCallerForTest, LIN-531): the test dials from one fixed number,
// whose earlier test calls would reach the assistant as the caller's history. Before it dials, the test asks that its
// next call be answered as one from a new caller; call.start claims that once. Kept in instance_settings, one row per
// test number and business number, overwritten by the next run.
import { NEW_CALLER_FOR_TEST_MS } from '@linedesk/actions'
import { instance_settings, type Tx } from '@linedesk/db'
import { and, eq, like, lt } from 'drizzle-orm'

const PREFIX = 'call_test.new_caller:'
const keyOf = (from: string, to: string) => `${PREFIX}${from}>${to}`

/** Marks the next call from `from` to `to` (both E.164) within NEW_CALLER_FOR_TEST_MS as a new caller's; the value is the expiry. */
export async function expectNewCallerForTest(tx: Tx, { from, to, now }: { from: string; to: string; now: string }) {
  const value = new Date(Date.parse(now) + NEW_CALLER_FOR_TEST_MS).toISOString()
  // Marks no call claimed (a test that never got through) go with the next run.
  await tx
    .delete(instance_settings)
    .where(and(like(instance_settings.key, `${PREFIX}%`), lt(instance_settings.value, now)))
  await tx
    .insert(instance_settings)
    .values({ key: keyOf(from, to), value, updated_at: now })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now } })
}

/** Whether this call is the call test's new caller; claims the mark, so only one call is. */
export async function claimNewCallerForTest(tx: Tx, { from, to, now }: { from: string; to: string; now: string }) {
  const [mark] = await tx
    .delete(instance_settings)
    .where(eq(instance_settings.key, keyOf(from, to)))
    .returning({ value: instance_settings.value })
  return !!mark && Date.parse(mark.value) > Date.parse(now)
}
