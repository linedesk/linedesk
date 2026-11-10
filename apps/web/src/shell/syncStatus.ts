// What the bar at the bottom says about unsent changes. Nothing while online with an empty outbox.
export type SyncState = { online: boolean; pending: number }

const BACK = "will sync when you're back online"

export function syncStatusText({ online, pending }: SyncState): string | null {
  if (online) return pending ? `Back online · syncing ${pending}…` : null
  return pending ? `Offline · ${pending} ${pending === 1 ? 'change' : 'changes'} ${BACK}` : `Offline · your changes ${BACK}`
}
