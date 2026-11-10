// What the bar at the bottom says about unsent changes. Nothing while online with an empty outbox.
export type SyncState = { online: boolean; pending: number }

export function syncStatusText({ online, pending }: SyncState): string | null {
  if (!online) return pending ? `Offline · ${pending} ${pending === 1 ? 'change' : 'changes'} waiting` : 'Offline · changes will sync when you are back'
  return pending ? `Back online · syncing ${pending}…` : null
}
