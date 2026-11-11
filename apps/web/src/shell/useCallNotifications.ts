// Browser notifications for finished calls while Linedesk is open (Notification API, no push
// service). Only when the tab is in the background, only for calls that finished after the app
// opened, never for test calls or spam. Clicking one opens the call.
import type { NotificationSettingsData } from '@linedesk/actions'
import type { Call } from '@linedesk/db/types'
import { useEffect, useRef } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { onPushOpensCall } from '../push.ts'
import { readAction } from '../settings/settings-api.ts'
import { useRows } from '../store.tsx'
import { callHash } from './useRoute.ts'

// The member's settings, shared by this hook and Settings, Notifications (which updates them on
// change): the last known at once (also across page loads), checked again in the background.
const NOTIFICATIONS = 'notifications'
const loadNotificationSettings = () => readAction<NotificationSettingsData>('notifications.get')
export const useNotificationQuery = () => useQuery(NOTIFICATIONS, loadNotificationSettings, { persist: true })
export const useNotificationSettings = () => useNotificationQuery().data ?? null
/** Applies a change at once, here and on the settings page; the server gets it through the outbox. */
export const setNotificationSettings = (next: NotificationSettingsData) =>
  setQueryData(NOTIFICATIONS, next, { persist: true })

export const browserNotificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window

/**
 * Calls that just finished: completed now, not completed (or not there) before, and ended after
 * `sinceMs` (the first sync of a fresh browser brings old calls too: they are history, not news).
 */
export function newlyFinished(
  calls: readonly Call[],
  before: ReadonlyMap<string, Call['status']>,
  sinceMs: number,
): Call[] {
  return calls.filter(
    c =>
      c.status === 'completed' &&
      before.get(c.id) !== 'completed' &&
      Date.parse(c.ended_at ?? '') >= sinceMs &&
      !c.deleted_at &&
      c.source !== 'test' &&
      c.outcome !== 'spam',
  )
}

/** Clock differences between server and browser. */
const SLACK_MS = 60_000

function show(call: Call, callerName: (call: Call) => string) {
  const notification = new Notification(`${call.urgency === 'urgent' ? 'Urgent: ' : ''}${call.title || 'New call'}`, {
    body: [callerName(call), call.summary].filter(Boolean).join(' · '),
    tag: `call-${call.id}`, // one notification per call, even with several tabs open
  })
  notification.onclick = () => {
    window.focus()
    window.location.hash = callHash(call.id)
    notification.close()
  }
}

export function useCallNotifications(callerName: (call: Call) => string) {
  const calls = useRows('calls')
  const prefs = useNotificationSettings()
  const seen = useRef<Map<string, Call['status']>>(new Map())
  const since = useRef(Date.now() - SLACK_MS)
  const name = useRef(callerName)
  name.current = callerName

  // A click on a push notification (service worker) opens its call here.
  useEffect(
    () =>
      onPushOpensCall(id => {
        window.location.hash = callHash(id)
      }),
    [],
  )

  useEffect(() => {
    const before = seen.current
    seen.current = new Map(calls.map(c => [c.id, c.status]))
    if (!prefs?.effective.browser || !browserNotificationsSupported() || Notification.permission !== 'granted') return
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    for (const call of newlyFinished(calls, before, since.current)) show(call, name.current)
  }, [calls, prefs])
}
