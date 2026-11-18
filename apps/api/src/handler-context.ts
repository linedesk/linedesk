// What every server handler gets and how it says no. Its own file so that handler modules can
// share it without importing each other.
import type { ActionResult } from '@linedesk/actions'
import { type MessageKey, type MessageValues, SOURCE, type Translator } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import type { TelephonyProvider } from '@linedesk/telephony'
import type { AppServices } from './app-connections.ts'
import type { CalendarServices } from './calendar-connections.ts'
import type { Actor } from './context.ts'
import type { RecordingStore } from './recording-store.ts'

/**
 * Text for people as a key and its params (docs/translations.md, "Server-side text"): written in the reader's language
 * when it is sent, in English for logs, the command log and alerts.
 */
export type Said = { key: MessageKey; params?: SaidParams }
/** A param is a value, or words written when the reader is known (a list of language names in their language). */
export type SaidParams = Record<string, MessageValues[string] | ((reader: Reader) => string)>
/** The words of one reader: `getT(locale)`. */
export type Reader = Pick<Translator, 't' | 'format' | 'locale'>

/** A key and its params, written when the reader is known: `said('server.api.providerTest.connected')`. */
export const said = (key: MessageKey, params?: SaidParams): Said => (params ? { key, params } : { key })

/** A said text in a reader's words (English by default). */
export function sayIn(said: Said, reader: Reader = getT(SOURCE)): string {
  const params = said.params
    ? Object.fromEntries(
        Object.entries(said.params).map(([name, value]) => [name, typeof value === 'function' ? value(reader) : value]),
      )
    : undefined
  return reader.t(said.key, params)
}

/**
 * The words of whoever asks: a member's own language in the web app (their choice, else what Automatic resolved to,
 * else the browser's), an API client's Accept-Language, else English (the voice agent, the CLI).
 */
export const wordsOf = (actor: Pick<Actor, 'locale'> | null | undefined): Reader => getT(actor?.locale ?? SOURCE)

/**
 * A business-rule rejection: the command is final, clients must not retry it. Answered 409 (a conflict with the data's state).
 * `code`: a fixed code the page words itself (i18n) instead of showing the message, sent with the rejection. Clients
 * match the code, never the message. A rejection made with `Reject.t(key, params)` (or a `Said`) answers in the
 * caller's language (rejectionText); `message` is its English, for logs and the command log.
 */
export class Reject extends Error {
  readonly code: string | undefined
  readonly said: Said | undefined
  /**
   * A stable code the command log keeps with the rejection (`result.reason`, run-action.ts), whatever its words or
   * class: what the audit log finds a kind of refusal by (LEVEL_RAISE_REFUSED). Never part of the caller's answer.
   */
  reason: string | undefined
  constructor(message?: string | Said, code?: string) {
    super(typeof message === 'object' ? sayIn(message) : message)
    this.said = typeof message === 'object' ? message : undefined
    this.code = code
  }

  /** A rejection written for people, from the catalogs: `throw Reject.t('server.api.noWorkspace')`. */
  static t<T extends typeof Reject>(this: T, key: MessageKey, params?: SaidParams, code?: string): InstanceType<T> {
    return new this({ key, params }, code) as InstanceType<T>
  }
}

/** The `reason` of a refused raise of an assistant's call quality (refuseLevelRaise), an edit or a version restore. */
export const LEVEL_RAISE_REFUSED = 'level_raise'

/** A rejection's text in these words: its key in that language, else its message as it was written. */
export const rejectionText = (e: Reject, reader: Reader) => (e.said ? sayIn(e.said, reader) : e.message)

/** What a synced table's row is called in an error: `call not found`, not `calls row not found`. */
const ROW_NOUN: Record<string, string> = { assistant_calendars: 'calendar', webhook_endpoints: 'webhook' }
export const notFound = (table: string) => new Reject(`${ROW_NOUN[table] ?? table.replace(/s$/, '')} not found`)

/**
 * A rejection because of who asks, not of the data's state: a rule only an owner passes, something
 * not possible while signed in as another user or with an API key. Answered 403 with `code: 'forbidden'`.
 */
export class Forbidden extends Reject {}

/**
 * A rejection that names nothing: the thing asked for is not the caller's or does not exist, and the answer must not
 * say which (a Checkout session of another bill). Answered 404 with `code: 'not_found'`.
 */
export class NotFound extends Reject {}

/** Serialises the writes that count things on one call (messages, bookings), until the transaction ends. */
export const lockCall = (tx: Tx, callId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`call:${callId}`}))`)

/** Reverses something a handler did outside the database; resolves to a short note on what it did. */
export type Undo = () => Promise<string>

/**
 * `telephony`, `recordings`, `calendars` and `apps` override what is in effect (tests). `onRollback` registers an undo
 * that runs if the action's transaction does not commit, for whatever reason. `onCommit` registers work that runs
 * once it has committed, before the answer goes out (a failure there is logged, the action stays done).
 */
export type HandlerCtx = {
  tx: Tx
  actor: Actor
  now: string
  telephony?: TelephonyProvider
  recordings?: RecordingStore
  calendars?: CalendarServices
  apps?: AppServices
  onRollback?: (undo: Undo) => void
  onCommit?: (work: () => Promise<void>) => void
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
  // `commandId`: the command's id (the client's idempotency key), the same on a retry of the same command.
  ctx: { actor: Actor; now: string; onRollback: (undo: Undo) => void; commandId: string },
  // biome-ignore lint/suspicious/noExplicitAny: the registry has validated the input against the action's schema
  input: any,
) => Promise<unknown>
// biome-ignore lint/suspicious/noExplicitAny: the registry has validated the input against the action's schema
export type Handler = (ctx: HandlerCtx, input: any) => Promise<Omit<ActionResult, 'ok'>>
