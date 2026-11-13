// Settings › Notifications: your own new-call notifications (email per call, and one switch for notifications on
// this device: push where the browser and server can, else while Linedesk is open) and, for owners and admins, the
// email default for teammates who never changed theirs. The device switch asks for the browser's permission itself.
import type { NotificationSettingsData } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { brandName } from '../brand.ts'
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
import { permissionText, useNotificationPermission } from './notificationPermission.ts'

const blockedText = 'Blocked by the browser. Allow notifications for this site, then try again.'

/** Why push cannot be turned on here, or null when it can. */
export function pushBlocker(publicKey: string | null): string | null {
  const support = pushSupport()
  if (support === 'ios-needs-install')
    return `On iPhone and iPad, add ${brandName()} to your Home Screen first (Share, Add to Home Screen), then open it from there.`
  if (support === 'unsupported') return 'This browser cannot receive push notifications.'
  if (!publicKey) return 'Not set up on this server yet (VAPID keys, see the operator notes).'
  return null
}

/** Whether this browser gets pushes in this workspace: its device id is among the member's. */
export function useThisDevice(devices: readonly string[]) {
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

/**
 * Asks the browser for permission and subscribes it for pushes in this workspace (push.subscribe through the
 * outbox); the settings show the device at once. `note`: why it did not work, null when it did.
 */
export async function turnOnPush(
  settings: NotificationSettingsData,
  run: (name: string, input: object) => unknown,
): Promise<{ id: string | null; note: string | null }> {
  if (!settings.push.publicKey) return { id: null, note: pushBlocker(null) }
  try {
    const subscription = await subscribeThisBrowser(settings.push.publicKey)
    if (subscription === 'denied') return { id: null, note: blockedText }
    const id = await thisDeviceId()
    if (id)
      setNotificationSettings({
        ...settings,
        push: { ...settings.push, devices: [...settings.push.devices.filter(d => d !== id), id] },
      })
    void run('push.subscribe', subscription)
    return { id, note: null }
  } catch (e) {
    return { id: null, note: `Push could not be turned on: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Stops pushes to this browser in this workspace; the settings drop the device at once. */
export async function turnOffPush(
  settings: NotificationSettingsData,
  deviceId: string | null,
  run: (name: string, input: object) => unknown,
) {
  const subscription = await currentSubscription()
  setNotificationSettings({
    ...settings,
    push: { ...settings.push, devices: settings.push.devices.filter(d => d !== deviceId) },
  })
  if (subscription) void run('push.unsubscribe', { endpoint: subscription.endpoint })
}

/** Sets the member's own in-tab setting (the fallback where push cannot work); applies at once, saved through the outbox. */
function setOwnBrowser(settings: NotificationSettingsData, on: boolean, run: (name: string, input: object) => unknown) {
  setNotificationSettings({
    ...settings,
    own: { ...settings.own, browser: on },
    effective: { ...settings.effective, browser: on },
  })
  void run('notifications.update', { browser: on })
}

/**
 * One switch for "notify me about new calls on this device". Where push works, on means this browser is subscribed
 * (notifications even when Linedesk is closed); where it cannot (no VAPID keys, a browser without push), it falls
 * back to notifications while Linedesk is open (the member's `browser` setting). Turning it on asks the browser for
 * permission itself; `note` says what the switch does here, or why it cannot be turned on.
 */
export function useDeviceNotifications(settings: NotificationSettingsData) {
  const run = useRun()
  const device = useThisDevice(settings.push.devices)
  const [permission, askPermission] = useNotificationPermission()
  const [busyNote, setBusyNote] = useState<string | null>(null)
  const viaPush = pushBlocker(settings.push.publicKey) === null
  const granted = permission === 'granted'
  const on = granted && (viaPush ? device.on : settings.effective.browser)
  const unavailable = permission === 'denied' || permission === 'unsupported' || permission === 'ios-needs-install'

  async function set(next: boolean) {
    setBusyNote(null)
    if (!next) {
      if (viaPush) await turnOffPush(settings, device.id, run)
      else setOwnBrowser(settings, false, run)
      return
    }
    await askPermission()
    if (!browserNotificationsSupported() || Notification.permission !== 'granted') return
    if (!viaPush) return setOwnBrowser(settings, true, run)
    // Registering with the browser's push service can take a while the first time.
    setBusyNote('Turning on…')
    const result = await turnOnPush(settings, run)
    setBusyNote(result.note)
    if (result.id) device.setId(result.id)
  }

  const fallback =
    pushSupport() === 'supported'
      ? `New calls while ${brandName()} is open. Notifications when it is closed are not set up on this server yet.`
      : `New calls while ${brandName()} is open. This browser cannot show them when it is closed.`
  const note = unavailable
    ? permissionText(permission)
    : (busyNote ?? (viaPush ? `New calls, urgent ones first, even when ${brandName()} is closed.` : fallback))
  return { on, disabled: unavailable, note, set, pushOn: viaPush && on }
}

export function Notifications({ toast }: { toast: (text: string) => void }) {
  const query = useNotificationQuery()
  const settings = query.data ?? null
  const error = settings ? null : query.error

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
  return <NotificationSettings settings={settings} toast={toast} />
}

function NotificationSettings({
  settings,
  toast,
}: {
  settings: NotificationSettingsData
  toast: (text: string) => void
}) {
  const run = useRun()
  const canAssign = useCanAssign()
  const device = useDeviceNotifications(settings)

  /** Applies at once on this page and in the browser-notification hook; the server gets it through the outbox. */
  function change(next: NotificationSettingsData) {
    setNotificationSettings(next)
  }

  function setOwnEmail(on: boolean) {
    change({
      ...settings,
      own: { ...settings.own, email: on },
      effective: { ...settings.effective, email: on },
    })
    void run('notifications.update', { email: on })
  }

  function setDefaultEmail(on: boolean) {
    const defaults = { ...settings.defaults, email: on }
    const effective = { ...settings.effective, email: settings.own.email ?? on }
    change({ ...settings, defaults, effective })
    void run('notifications.setDefaults', { email: on })
    toast('Team defaults saved.')
  }

  function setPushSummary(on: boolean) {
    change({ ...settings, push: { ...settings.push, summary: on } })
    void run('notifications.update', { pushSummary: on })
  }

  function setAssignedEmail(on: boolean) {
    change({ ...settings, assignedEmail: on })
    void run('notifications.update', { assignedEmail: on })
  }

  function setSetupEmails(on: boolean) {
    change({ ...settings, setupEmails: on })
    void run('notifications.update', { setupEmails: on })
  }

  return (
    <>
      <Section id="st-notify" title="Notifications" description="Only for you.">
        <div className="st-swlist">
          <SwitchRow
            title="Email for every call"
            aside={settings.own.email === null ? 'Team default' : undefined}
            on={settings.effective.email}
            onChange={setOwnEmail}
          />
          {canAssign && (
            <SwitchRow
              title="Email me when a call is assigned to me"
              description="When a teammate assigns you a call. Never for calls you take yourself."
              on={settings.assignedEmail}
              onChange={setAssignedEmail}
            />
          )}
          {settings.setupEmails !== null && (
            <SwitchRow
              title="Setup emails"
              description="A few emails while your workspace gets set up, and a summary of its first week."
              on={settings.setupEmails}
              onChange={setSetupEmails}
            />
          )}
          <SwitchRow
            title="Notifications on this device"
            description={device.note}
            on={device.on}
            onChange={on => void device.set(on)}
            disabled={device.disabled}
            dimmed={device.disabled}
          />
          {device.pushOn && (
            <SwitchRow
              title="Say what the call was about"
              description="Adds one line to each notification. It shows on your lock screen."
              on={settings.push.summary}
              onChange={setPushSummary}
            />
          )}
        </div>
      </Section>
      {settings.canEditDefaults && (
        <Section id="st-notify-defaults" title="Team defaults" description="For teammates without their own.">
          <div className="st-swlist">
            <SwitchRow title="Email for every call" on={settings.defaults.email} onChange={setDefaultEmail} />
          </div>
        </Section>
      )}
    </>
  )
}
