// What every server handler gets and how it says no. Its own file so that handler modules can
// share it without importing each other.
import type { ActionResult } from '@linedesk/actions'
import type { Tx } from '@linedesk/db'
import type { TelephonyProvider } from '@linedesk/telephony'
import type { CalendarServices } from './calendar-connections.ts'
import type { Actor } from './context.ts'
import type { RecordingStore } from './recording-store.ts'

/** A business-rule rejection: the command is final, clients must not retry it. */
export class Reject extends Error {}

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
}
// biome-ignore lint/suspicious/noExplicitAny: the registry has validated the input against the action's schema
export type Handler = (ctx: HandlerCtx, input: any) => Promise<Omit<ActionResult, 'ok'>>
