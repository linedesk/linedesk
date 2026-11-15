// What the bar at the bottom says about unsent changes. Nothing while online with an empty outbox.
import { i18n } from '../i18n/index.tsx'
export type SyncState = { online: boolean; pending: number }

export function syncStatusText({ online, pending }: SyncState): string | null {
  const { t } = i18n()
  if (online) return pending ? t('shell.sync.syncing', { count: pending }) : null
  return pending ? t('shell.sync.offlineCount', { count: pending }) : t('shell.sync.offline')
}
