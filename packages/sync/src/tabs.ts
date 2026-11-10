// Several tabs of one workspace share one local database. Exactly one of them, the leader,
// talks to the server (sends the outbox, runs read sync); the others hand it their commands
// and get rows and results back over a channel. So a workspace uses the same few connections
// however many tabs are open, and no command is sent twice.
import type { ActionResult } from '@callfront/actions'
import type { TableName } from '@callfront/db/types'

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

export interface TabLink {
  /** `lead` is called once, when this tab becomes the one that talks to the server (at once if it is alone). */
  whenLeading(lead: () => void): void
  /** To every other tab of the workspace. */
  post(message: TabMessage): void
  onMessage(handler: (message: TabMessage) => void): void
  close(): void
}

/** A tab on its own: environments without Web Locks or BroadcastChannel. */
const soloLink = (): TabLink => ({ whenLeading: lead => lead(), post: () => {}, onMessage: () => {}, close: () => {} })

/** Leader by Web Lock (the next tab takes over when the leader closes), messages by BroadcastChannel. */
export function browserTabLink(name: string): TabLink {
  const locks = globalThis.navigator?.locks
  if (!locks || typeof BroadcastChannel === 'undefined') return soloLink()
  const channel = new BroadcastChannel(name)
  const waiting = new AbortController()
  let release: (() => void) | undefined
  return {
    whenLeading(lead) {
      // The lock is held until close(): the promise returned to request() stays pending while this tab leads.
      locks.request(name, { signal: waiting.signal }, () => new Promise<void>(resolve => { release = resolve; lead() })).catch(() => {})
    },
    post: message => channel.postMessage(message),
    onMessage(handler) { channel.onmessage = e => handler(e.data as TabMessage) },
    close() { waiting.abort(); release?.(); channel.close() },
  }
}

/** In-memory stand-in for tests: links made from one hub behave like tabs of one browser. */
export function memoryTabHub() {
  type Member = { lead?: () => void; handler?: (m: TabMessage) => void }
  const members: Member[] = []
  let leader: Member | undefined
  const elect = () => {
    if (leader) return
    leader = members.find(m => m.lead)
    leader?.lead?.()
  }
  return {
    link(): TabLink {
      const me: Member = {}
      members.push(me)
      return {
        whenLeading(lead) { me.lead = lead; elect() },
        post(message) { for (const m of members) if (m !== me) queueMicrotask(() => m.handler?.(structuredClone(message))) },
        onMessage(handler) { me.handler = handler },
        close() {
          members.splice(members.indexOf(me), 1)
          if (leader === me) { leader = undefined; elect() }
        },
      }
    },
  }
}
