// Settings › Notifications: your own new-call notifications (email per call, browser notifications
// while Linedesk is open, push notifications in this browser while it is closed) and, for owners and
// admins, the defaults for teammates who never changed theirs. Browser and push notifications need the browser's
// permission: its own row asks for it, and the two toggles stay greyed until it is given.
import type { NotificationChannels, NotificationSettingsData } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { brandName } from '../brand.ts'
import { currentSubscription, pushSupport, subscribeThisBrowser, thisDeviceId } from '../push.ts'
import { setNotificationSettings, useNotificationQuery } from '../shell/useCallNotifications.ts'
import { useRun } from '../store.tsx'
import { useCanAssign } from '../team/members.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { Section, SwitchRow } from './fields.tsx'
import {
  type NotificationPermissionState,
  permissionText,
  useNotificationPermission,
} from './notificationPermission.ts'

type Channel = keyof NotificationChannels

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

/** Whether this browser may show notifications (AllowNotificationsRow asks). */
export const notificationsAllowed = (permission: NotificationPermissionState) => permission === 'granted'

/**
 * The browser's permission, the one thing behind browser and push notifications: Allow asks once, then a tick.
 * Settings › Notifications and the onboarding notify step show the same row.
 */
export function AllowNotificationsRow({ className }: { className?: string }) {
  const [permission, askPermission] = useNotificationPermission()
  const [asking, setAsking] = useState(false)
  async function allow() {
    setAsking(true)
    await askPermission()
    setAsking(false)
  }
  return (
    <div className={className ? `swrow ${className}` : 'swrow'}>
      <div>
        <b>Allow push notifications in this browser</b>
        <span className="help">{permissionText(permission)}</span>
      </div>
      {permission === 'granted' ? (
        <span className="swrow-ok">
          <Icon name="check" size={14} />
          Allowed
        </span>
      ) : (
        permission === 'default' && (
          <Button size="sm" busy={asking} onClick={() => void allow()}>
            Allow
          </Button>
        )
      )}
    </div>
  )
}

export function Notifications({ toast }: { toast: (text: string) => void }) {
  const run = useRun()
  const canAssign = useCanAssign()
  const query = useNotificationQuery()
  const settings = query.data ?? null
  const error = settings ? null : query.error
  const [pushNote, setPushNote] = useState<string | null>(null)
  const device = useThisDevice(settings?.push.devices ?? [])
  const [permission] = useNotificationPermission()
  const allowed = notificationsAllowed(permission)

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

  function setOwn(channel: Channel, on: boolean) {
    if (!settings) return
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
    if (!on) return turnOffPush(settings, device.id, run)
    // Registering with the browser's push service can take a while the first time.
    setPushNote('Turning on…')
    const result = await turnOnPush(settings, run)
    setPushNote(result.note)
    if (result.id) device.setId(result.id)
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

  function setSetupEmails(on: boolean) {
    if (!settings) return
    change({ ...settings, setupEmails: on })
    void run('notifications.update', { setupEmails: on })
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
            onChange={on => setOwn('email', on)}
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
            title="Browser notifications"
            description={`While ${brandName()} is open.`}
            aside={followsDefault('browser')}
            on={settings.effective.browser && allowed}
            onChange={on => setOwn('browser', on)}
            disabled={!allowed}
            dimmed={!allowed}
          />
          <SwitchRow
            title="Push notifications"
            description={
              (allowed && blocker) || pushNote || `New calls, urgent ones first, even when ${brandName()} is closed.`
            }
            on={device.on && allowed && !blocker}
            onChange={on => void setPush(on)}
            disabled={!allowed || blocker !== null}
            dimmed={!allowed}
          />
          {device.on && allowed && !blocker && (
            <SwitchRow
              title="Say what the call was about"
              description="Adds one line to each push. It shows on your lock screen."
              on={settings.push.summary}
              onChange={setPushSummary}
            />
          )}
          {!allowed && (
            <p className="help st-notify-hint">
              Browser and push notifications only work once this browser allows notifications.
            </p>
          )}
          <AllowNotificationsRow />
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
