// Whether this browser may show notifications: the one permission behind the device switch in Settings ›
// Notifications and the onboarding notify step, which ask for it when turned on.
import { useEffect, useState } from 'react'
import { brandName } from '../brand.ts'
import { pushSupport } from '../push.ts'
import { browserNotificationsSupported } from '../shell/useCallNotifications.ts'
import { i18n } from '../i18n/index.tsx'

export type NotificationPermissionState = 'granted' | 'default' | 'denied' | 'unsupported' | 'ios-needs-install'

const read = (): NotificationPermissionState => {
  if (pushSupport() === 'ios-needs-install') return 'ios-needs-install'
  return browserNotificationsSupported() ? Notification.permission : 'unsupported'
}

/** What the permission means here, or why it cannot be given. */
export function permissionText(state: NotificationPermissionState): string {
  const { t } = i18n()
  switch (state) {
    case 'granted':
      return t('account.notify.permission.granted')
    case 'default':
      return t('account.notify.permission.default')
    case 'denied':
      return t('account.notify.permission.denied')
    case 'unsupported':
      return t('account.notify.permission.unsupported')
    case 'ios-needs-install':
      return t('account.notify.iosInstall', { brand: brandName() })
  }
}

/** Every mounted user of the permission: one answer from the browser updates all of them at once. */
const listeners = new Set<() => void>()
const announce = () => {
  for (const listener of listeners) listener()
}

/** The permission, kept current (the browser's own setting can change it), and `ask`: the browser's one prompt. */
export function useNotificationPermission(): [NotificationPermissionState, () => Promise<void>] {
  const [state, setState] = useState(read)
  useEffect(() => {
    const update = () => setState(read())
    listeners.add(update)
    let status: PermissionStatus | null = null
    let live = true
    void navigator.permissions
      ?.query({ name: 'notifications' })
      .then(found => {
        if (!live) return
        status = found
        found.onchange = announce
      })
      .catch(() => {})
    // Changed in the browser's site settings while the tab was in the background.
    window.addEventListener('focus', update)
    return () => {
      live = false
      listeners.delete(update)
      if (status) status.onchange = null
      window.removeEventListener('focus', update)
    }
  }, [])
  const ask = async () => {
    if (browserNotificationsSupported()) await Notification.requestPermission().catch(() => {})
    announce()
  }
  return [state, ask]
}
