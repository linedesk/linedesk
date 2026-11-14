// Several tabs of one workspace share one local database. Exactly one of them, the leader,
// talks to the server (sends the outbox, runs read sync); the others hand it their commands
// and get rows and results back over a channel. So a workspace uses the same few connections
// however many tabs are open, and no command is sent twice.
import type { ActionResult } from '@linedesk/actions'
import type { TableName } from '@linedesk/db/types'
import type { WorkspaceRefusal, WorkspaceState } from './refusal.ts'

/** `seq` orders commands: strictly increasing within a tab, roughly by time across tabs (older stored commands have none). */
export type Command = { id: string; name: string; input: unknown; at: string; seq?: number }
type Row = { id: string; version: number }

export type TabMessage =
  | { type: 'added'; command: Command }
  | { type: 'settled'; id: string; rows?: ActionResult['rows']; error?: string }
  | { type: 'upsert'; table: TableName; rows: Row[] }
  | { type: 'replace'; table: TableName; rows: Row[] }
  | { type: 'remove'; table: TableName; ids: string[] }
  | { type: 'online'; online: boolean }
  /** The leader's read sync has caught up with the server for this table once. */
  | { type: 'synced'; table: TableName }
  /** The server refuses this workspace to this browser session: no tab of it sends or reads any more. */
  | { type: 'refused'; refusal: WorkspaceRefusal }
  /** The leader's read sync has not reached the server for a while (down), or reaches it again. */
  | { type: 'read-sync'; down: boolean }
  /** The leader heard from the server whether the workspace is disabled. */
  | { type: 'workspace-state'; state: WorkspaceState }
  /** A tab asks the leader to read these tables (all when absent) again now. */
  | { type: 'refresh'; id: string; tables?: TableName[] }
  /** The leader has read the tables of that request up to date; their rows were posted before this. */
  | { type: 'refreshed'; id: string }
  /** A tab checks that the leader still answers (a frozen or hung tab keeps the lead without doing anything). */
  | { type: 'ping'; id: string }
  /** The leader answers at once, with the tables its read sync has caught up with. */
  | { type: 'pong'; id: string; synced: TableName[] }

export interface TabLink {
  /**
   * `lead` is called when this tab becomes the one that talks to the server (at once if it is alone).
   * `lost` when another tab took the lead from it (`takeLead`); it waits for the lead again after that.
   */
  whenLeading(lead: () => void, lost?: () => void): void
  /** The leader does not answer: take the lead from it (a frozen tab would hold it forever). */
  takeLead(): void
  /** To every other tab of the workspace. */
  post(message: TabMessage): void
  onMessage(handler: (message: TabMessage) => void): void
  close(): void
}

/** A tab on its own: environments without Web Locks or BroadcastChannel. */
const soloLink = (): TabLink => ({
  whenLeading: lead => lead(),
  takeLead: () => {},
  post: () => {},
  onMessage: () => {},
  close: () => {},
})

/** Leader by Web Lock (the next tab takes over when the leader closes), messages by BroadcastChannel. */
export function browserTabLink(name: string): TabLink {
  const locks = globalThis.navigator?.locks
  if (!locks || typeof BroadcastChannel === 'undefined') return soloLink()
  const channel = new BroadcastChannel(name)
  let waiting = new AbortController()
  let closed = false
  let release: (() => void) | undefined
  let onLead: (() => void) | undefined
  let onLost: (() => void) | undefined
  /** Asks for the lock; held until close(): the promise given to request() stays pending while this tab leads. */
  function request(options: LockOptions) {
    let held = false
    locks
      .request(
        name,
        options,
        () =>
          new Promise<void>(resolve => {
            held = true
            release = resolve
            onLead?.()
          }),
      )
      .catch(() => {
        // Not held: it stopped waiting (closed, or this tab took the lock instead). Held: another tab took it.
        if (!held || closed) return
        release = undefined
        onLost?.()
        queue()
      })
  }
  function queue() {
    waiting = new AbortController()
    request({ signal: waiting.signal })
  }
  return {
    whenLeading(lead, lost) {
      onLead = lead
      onLost = lost
      queue()
    },
    takeLead() {
      if (closed || release) return
      waiting.abort()
      request({ steal: true })
    },
    post: message => channel.postMessage(message),
    onMessage(handler) {
      channel.onmessage = e => handler(e.data as TabMessage)
    },
    close() {
      closed = true
      waiting.abort()
      release?.()
      channel.close()
    },
  }
}

/** In-memory stand-in for tests: links made from one hub behave like tabs of one browser. */
export function memoryTabHub() {
  type Member = { lead?: () => void; lost?: () => void; handler?: (m: TabMessage) => void; frozen?: boolean }
  const members: Member[] = []
  let leader: Member | undefined
  const elect = () => {
    if (leader) return
    leader = members.find(m => m.lead)
    leader?.lead?.()
  }
  return {
    /** A tab of this browser; `freeze` makes it stop answering while it keeps the lead (a frozen background tab). */
    link(): TabLink & { freeze(): void } {
      const me: Member = {}
      members.push(me)
      return {
        whenLeading(lead, lost) {
          me.lead = lead
          me.lost = lost
          elect()
        },
        takeLead() {
          if (leader === me || !members.includes(me)) return
          const previous = leader
          leader = me
          previous?.lost?.()
          me.lead?.()
        },
        post(message) {
          if (me.frozen) return
          for (const m of members)
            if (m !== me && !m.frozen) queueMicrotask(() => m.handler?.(structuredClone(message)))
        },
        onMessage(handler) {
          me.handler = handler
        },
        close() {
          members.splice(members.indexOf(me), 1)
          if (leader === me) {
            leader = undefined
            elect()
          }
        },
        freeze() {
          me.frozen = true
        },
      }
    },
  }
}
