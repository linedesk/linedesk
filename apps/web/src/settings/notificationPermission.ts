// Whether this browser may show notifications: the one permission behind the device switch in Settings ›
// Notifications and the onboarding notify step, which ask for it when turned on.
import { useEffect, useState } from 'react'
import { brandName } from '../brand.ts'
import { pushSupport } from '../push.ts'
import { browserNotificationsSupported } from '../shell/useCallNotifications.ts'

export type NotificationPermissionState = 'granted' | 'default' | 'denied' | 'unsupported' | 'ios-needs-install'

const read = (): NotificationPermissionState => {
  if (pushSupport() === 'ios-needs-install') return 'ios-needs-install'
  return browserNotificationsSupported() ? Notification.permission : 'unsupported'
}

/** What the permission means here, or why it cannot be given. */
export function permissionText(state: NotificationPermissionState): string {
  switch (state) {
    case 'granted':
      return 'This browser may show notifications.'
    case 'default':
      return 'Your browser asks once when you turn notifications on.'
    case 'denied':
      return 'Blocked by the browser. Allow notifications for this site in the browser’s site settings, then reload the page.'
    case 'unsupported':
      return 'This browser cannot show notifications.'
    case 'ios-needs-install':
      return `On iPhone and iPad, add ${brandName()} to your Home Screen first (Share, Add to Home Screen), then open it from there.`
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
