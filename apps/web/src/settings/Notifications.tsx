// Settings, Notifications: your own new-call notifications (email per call, browser notifications
// while Linedesk is open, push notifications on this device while it is closed) and, for owners and
// admins, the defaults for teammates who never changed theirs.
import type { NotificationChannels, NotificationSettingsData } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { currentSubscription, pushSupport, subscribeThisBrowser, thisDeviceId } from '../push.ts'
import {
  browserNotificationsSupported,
  setNotificationSettings,
  useNotificationQuery,
} from '../shell/useCallNotifications.ts'
import { useRun } from '../store.tsx'
import { useCanAssign } from '../team/members.ts'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { Section, SwitchRow } from './fields.tsx'

type Channel = keyof NotificationChannels

/** What the browser allows: asks once when browser notifications are turned on. */
async function browserAllows(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!browserNotificationsSupported()) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  return (await Notification.requestPermission()) === 'granted' ? 'granted' : 'denied'
}

const blockedText = 'Blocked by the browser. Allow notifications for this site, then try again.'

/** Why push cannot be turned on here, or null when it can. */
function pushBlocker(publicKey: string | null): string | null {
  const support = pushSupport()
  if (support === 'ios-needs-install')
    return 'On iPhone and iPad, add Linedesk to your Home Screen first (Share, Add to Home Screen), then open it from there.'
  if (support === 'unsupported') return 'This browser cannot receive push notifications.'
  if (!publicKey) return 'Not set up on this server yet (VAPID keys, see the operator notes).'
  return null
}

/** Whether this browser gets pushes in this workspace: its device id is among the member's. */
function useThisDevice(devices: readonly string[]) {
  // Read once; subscribing here sets it (setId).
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void thisDeviceId()
      .catch(() => null)
      .then(found => live && setId(found))
    return () => {
      live = false
    }
  }, [])
  return { id, on: id !== null && devices.includes(id), setId }
}

export function Notifications({ toast }: { toast: (text: string) => void }) {
  const run = useRun()
  const canAssign = useCanAssign()
  const query = useNotificationQuery()
  const settings = query.data ?? null
  const error = settings ? null : query.error
  const [browserNote, setBrowserNote] = useState<string | null>(null)
  const [pushNote, setPushNote] = useState<string | null>(null)
  const device = useThisDevice(settings?.push.devices ?? [])
  useEffect(() => {
    if (!browserNotificationsSupported()) setBrowserNote('This browser cannot show notifications.')
    else if (Notification.permission === 'denied' && settings?.effective.browser) setBrowserNote(blockedText)
  }, [settings?.effective.browser])

  if (error)
    return (
      <Section id="st-notify" title="Notifications">
        <LoadProblem what="Notification settings" message={error} onRetry={() => void query.reload()} />
      </Section>
    )
  if (!settings)
    return (
      <Section id="st-notify" title="Notifications">
        <SkeletonRows label="Loading notification settings" rows={2} />
      </Section>
    )

  /** Applies at once on this page and in the browser-notification hook; the server gets it through the outbox. */
  function change(next: NotificationSettingsData) {
    setNotificationSettings(next)
  }

  async function setOwn(channel: Channel, on: boolean) {
    if (!settings) return
    if (channel === 'browser' && on) {
      const allowed = await browserAllows()
      if (allowed !== 'granted')
        return setBrowserNote(allowed === 'unsupported' ? 'This browser cannot show notifications.' : blockedText)
      setBrowserNote(null)
    }
    change({
      ...settings,
      own: { ...settings.own, [channel]: on },
      effective: { ...settings.effective, [channel]: on },
    })
    void run('notifications.update', { [channel]: on })
  }

  function setDefault(channel: Channel, on: boolean) {
    if (!settings) return
    const defaults = { ...settings.defaults, [channel]: on }
    const effective = { ...settings.effective, [channel]: settings.own[channel] ?? on }
    change({ ...settings, defaults, effective })
    void run('notifications.setDefaults', { [channel]: on })
    toast('Team defaults saved.')
  }

  async function setPush(on: boolean) {
    if (!settings?.push.publicKey) return
    if (!on) {
      const subscription = await currentSubscription()
      change({ ...settings, push: { ...settings.push, devices: settings.push.devices.filter(d => d !== device.id) } })
      if (subscription) void run('push.unsubscribe', { endpoint: subscription.endpoint })
      return
    }
    try {
      // Registering with the browser's push service can take a while the first time.
      setPushNote('Turning on…')
      const subscription = await subscribeThisBrowser(settings.push.publicKey)
      if (subscription === 'denied') return setPushNote(blockedText)
      setPushNote(null)
      const id = await thisDeviceId()
      if (id) {
        device.setId(id)
        change({
          ...settings,
          push: { ...settings.push, devices: [...settings.push.devices.filter(d => d !== id), id] },
        })
      }
      void run('push.subscribe', subscription)
    } catch (e) {
      setPushNote(`Push could not be turned on: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function setPushSummary(on: boolean) {
    if (!settings) return
    change({ ...settings, push: { ...settings.push, summary: on } })
    void run('notifications.update', { pushSummary: on })
  }

  function setAssignedEmail(on: boolean) {
    if (!settings) return
    change({ ...settings, assignedEmail: on })
    void run('notifications.update', { assignedEmail: on })
  }

  const blocker = pushBlocker(settings.push.publicKey)
  const followsDefault = (channel: Channel) => (settings.own[channel] === null ? 'Team default' : undefined)
  return (
    <>
      <Section id="st-notify" title="Notifications" description="Only for you.">
        <div className="st-swlist">
          <SwitchRow
            title="Email for every call"
            aside={followsDefault('email')}
            on={settings.effective.email}
            onChange={on => void setOwn('email', on)}
          />
          <SwitchRow
            title="Browser notifications"
            description={browserNote ?? undefined}
            aside={followsDefault('browser')}
            on={settings.effective.browser && !browserNote}
            onChange={on => void setOwn('browser', on)}
            disabled={!browserNotificationsSupported()}
          />
          <SwitchRow
            title="Push notifications on this device"
            description={blocker ?? pushNote ?? 'New calls, urgent ones first, even when Linedesk is closed.'}
            on={device.on && !blocker}
            onChange={on => void setPush(on)}
            disabled={blocker !== null}
          />
          {device.on && !blocker && (
            <SwitchRow
              title="Say what the call was about"
              description="Adds one line to each push. It shows on your lock screen."
              on={settings.push.summary}
              onChange={setPushSummary}
            />
          )}
          {canAssign && (
            <SwitchRow
              title="Email me when a call is assigned to me"
              description="When a teammate assigns you a call. Never for calls you take yourself."
              on={settings.assignedEmail}
              onChange={setAssignedEmail}
            />
          )}
        </div>
      </Section>
      {settings.canEditDefaults && (
        <Section id="st-notify-defaults" title="Team defaults" description="For teammates without their own.">
          <div className="st-swlist">
            <SwitchRow
              title="Email for every call"
              on={settings.defaults.email}
              onChange={on => setDefault('email', on)}
            />
            <SwitchRow
              title="Browser notifications"
              on={settings.defaults.browser}
              onChange={on => setDefault('browser', on)}
            />
          </div>
        </Section>
      )}
    </>
  )
}
