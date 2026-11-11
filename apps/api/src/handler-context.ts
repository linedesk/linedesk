// What every server handler gets and how it says no. Its own file so that handler modules can
// share it without importing each other.
import type { ActionResult } from '@linedesk/actions'
import type { Tx } from '@linedesk/db'
import type { TelephonyProvider } from '@linedesk/telephony'
import type { CalendarServices } from './calendar-connections.ts'
import type { Actor } from './context.ts'
import type { RecordingStore } from './recording-store.ts'

/** A business-rule rejection: the command is final, clients must not retry it. Answered 409 (a conflict with the data's state). */
export class Reject extends Error {}

/**
 * A rejection because of who asks, not of the data's state: a rule only an owner passes, something
 * not possible while signed in as another user or with an API key. Answered 403 with `code: 'forbidden'`.
 */
export class Forbidden extends Reject {}

/** Reverses something a handler did outside the database; resolves to a short note on what it did. */
export type Undo = () => Promise<string>

/**
 * `telephony`, `recordings` and `calendars` override what is in effect (tests). `onRollback` registers an undo
 * that runs if the action's transaction does not commit, for whatever reason.
 */
export type HandlerCtx = {
  tx: Tx
  actor: Actor
  now: string
  telephony?: TelephonyProvider
  recordings?: RecordingStore
  calendars?: CalendarServices
  onRollback?: (undo: Undo) => void
  /** What the action's preparer returned (see Preparer). */
  prepared?: unknown
}

/**
 * Work an action does outside the database before its transaction, such as a slow provider call
 * that must not hold a transaction open. Runs after validation and permission checks; a Reject
 * refuses the command, and undos registered here run if the transaction then does not commit.
 * The handler gets the result as `ctx.prepared`.
 */
export type Preparer = (
  ctx: { actor: Actor; now: string; onRollback: (undo: Undo) => void },
  // biome-ignore lint/suspicious/noExplicitAny: the registry has validated the input against the action's schema
  input: any,
) => Promise<unknown>
// biome-ignore lint/suspicious/noExplicitAny: the registry has validated the input against the action's schema
export type Handler = (ctx: HandlerCtx, input: any) => Promise<Omit<ActionResult, 'ok'>>
