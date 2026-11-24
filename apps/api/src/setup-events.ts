// Setup milestones per workspace (setup_events): where a business stops on its way to its first real call.
// Only the first time counts. A call from the business's own phones (calls.from_own_number) is the owner
// trying it out, not a real caller, so it never counts as one.
import { type SetupEventKind, setup_events, transcript_segments, type Tx } from '@linedesk/db'
import type { Call } from '@linedesk/db/types'
import { type AnyColumn, type SQL, sql } from 'drizzle-orm'
import type { db } from './db.ts'

/** A transaction, or the pool for writes outside one (creating a workspace). */
type Db = Tx | typeof db

export async function recordSetupEvent(tx: Db, workspaceId: string, event: SetupEventKind, at: string) {
  await tx.insert(setup_events).values({ workspace_id: workspaceId, event, at }).onConflictDoNothing()
}

/**
 * Whether `from` is one of the business's own phones: a number one of its assistants puts calls through to,
 * or one of its Linedesk numbers. One query (phone_numbers by its unique e164, assistants by workspace).
 */
export async function isOwnNumber(tx: Db, workspaceId: string, from: string): Promise<boolean> {
  const contact = JSON.stringify([{ number: from }])
  const { rows } = await tx.execute<{ own: boolean }>(sql`select
    exists (select 1 from phone_numbers where e164 = ${from} and workspace_id = ${workspaceId})
    or exists (select 1 from assistants where workspace_id = ${workspaceId} and transfers @> ${contact}::jsonb) as own`)
  return rows[0]?.own === true
}

/** Outcomes where the assistant did something for the caller: a business that got one is live. */
export const HANDLED: ReadonlySet<Call['outcome']> = new Set<Call['outcome']>([
  'booked',
  'rescheduled',
  'cancelled',
  'callback',
  'message',
  'answered',
  'transferred',
])

type CallFacts = Pick<Call, 'id' | 'workspace_id' | 'source' | 'from_own_number' | 'outcome' | 'started_at'>

/**
 * SQL: the assistant said something in the call `callId` (a transcript line by `agent`). A test call it could not answer
 * (providers not set up: a missed call) has none. The one rule for "heard the assistant" (LIN-236): the milestone
 * here and the test call step of the setup MCP (setup-mcp.ts).
 */
export const assistantSpokeIn = (callId: AnyColumn | SQL) =>
  sql<boolean>`exists (select 1 from ${transcript_segments} where ${transcript_segments.call_id} = ${callId} and ${transcript_segments.speaker} = 'agent')`

/** Whether the assistant said something in this call (assistantSpokeIn). */
export async function assistantSpoke(tx: Db, callId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ spoke: boolean }>(sql`select ${assistantSpokeIn(sql`${callId}`)} as spoke`)
  return rows[0]?.spoke === true
}

/**
 * A real caller's call just came in (call.start): the first one is the first real call. Spam doesn't count, and only
 * source 'phone' does: test, sample and simulated calls never tick a milestone (isRealCall, @linedesk/actions).
 */
export async function recordCallStarted(tx: Db, call: CallFacts, spam: boolean) {
  if (call.source !== 'phone' || call.from_own_number || spam) return
  await recordSetupEvent(tx, call.workspace_id, 'first_real_call', call.started_at)
}

/**
 * A call ended (call.finish): a test call the assistant spoke in means the owner heard it; a handled real call means
 * the business is live.
 */
export async function recordCallFinished(tx: Db, call: CallFacts, at: string) {
  if (call.source === 'test') {
    if (await assistantSpoke(tx, call.id)) await recordSetupEvent(tx, call.workspace_id, 'assistant_heard', at)
    return
  }
  if (call.source !== 'phone' || call.from_own_number || !HANDLED.has(call.outcome)) return
  await recordSetupEvent(tx, call.workspace_id, 'activated', at)
}

/** Where onboarding moved to (onboarding.setStep): leaving the first step means the business was found. */
export async function recordOnboardingStep(tx: Db, workspaceId: string, step: string, at: string) {
  if (step === 'done') await recordSetupEvent(tx, workspaceId, 'onboarding_done', at)
  if (step === 'skipped') await recordSetupEvent(tx, workspaceId, 'onboarding_skipped', at)
  if (step !== 'business' && step !== 'skipped') await recordSetupEvent(tx, workspaceId, 'business_found', at)
}

/** A new workspace (sign-up or provisioned): not essential, so a failure is logged and never undoes the workspace. */
export async function recordSignup(pool: typeof db, workspaceId: string) {
  await recordSetupEvent(pool, workspaceId, 'signup', new Date().toISOString()).catch(err =>
    console.error('setup event signup failed', err),
  )
}
