// Account settings › Notifications: your own new-call notifications in this workspace (email per call, and one switch for
// notifications on this device: push where the browser and server can, else while Linedesk is open). The device
// switch asks for the browser's permission itself. NotificationDefaults: for owners and admins, the email default for
// teammates who never changed theirs (at the end of Workspace settings › Team).
import type { NotificationSettingsData } from '@linedesk/actions'
import { type ReactNode, useEffect, useState } from 'react'
import { brandName } from '../brand.ts'
import { currentSubscription, pushSupport, subscribeThisBrowser, thisDeviceId } from '../push.ts'
import {
  browserNotificationsSupported,
  setNotificationSettings,
  useNotificationQuery,
} from '../shell/useCallNotifications.ts'
import { useRun } from '../store.tsx'
import { useCanAssign } from '../team/members.ts'
import { changedByLabel } from '../team/team-model.ts'
import { useWorkspaces } from '../shell/WorkspaceSwitcher.tsx'
import { Loading } from '../ui/LoadStates.tsx'
import { Section, SkeletonSwitchRows, SwitchRow } from './fields.tsx'
import { permissionText, useNotificationPermission } from './notificationPermission.ts'

/** Your own notifications, linked from the team defaults (Workspace settings › Team). */
export const OWN_NOTIFICATIONS_HASH = '#account/notifications'

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

/** `workspaceName`: the workspace these settings are for; each workspace has its own. */
export function Notifications({ workspaceName }: { workspaceName: string }) {
  const query = useNotificationQuery()
  const settings = query.data ?? null
  const error = settings ? null : query.error
  const description = `In ${workspaceName}: email, and this device.`

  return (
    <Section id="st-notify" title="Notifications" description={description}>
      <Loading
        what="Notification settings"
        loading={!settings}
        error={error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonSwitchRows rows={2} />}
      >
        {settings && <OwnNotifications settings={settings} />}
      </Loading>
    </Section>
  )
}

/** The settings a member keeps per workspace that NotificationSwitches changes. */
export type NotificationChange = { email?: boolean; assignedEmail?: boolean; setupEmails?: boolean; pushSummary?: boolean }

/** `settings` with `change` applied, as the page shows it before the server answers. */
export function withChange(settings: NotificationSettingsData, change: NotificationChange): NotificationSettingsData {
  const { email, assignedEmail, setupEmails, pushSummary } = change
  return {
    ...settings,
    ...(email === undefined
      ? {}
      : { own: { ...settings.own, email }, effective: { ...settings.effective, email } }),
    ...(assignedEmail === undefined ? {} : { assignedEmail }),
    ...(setupEmails === undefined ? {} : { setupEmails }),
    ...(pushSummary === undefined ? {} : { push: { ...settings.push, summary: pushSummary } }),
  }
}

/**
 * The switches of a member's notifications in one workspace: their own page (Account settings › Notifications) and an
 * owner's or admin's Edit dialog (Workspace settings › Team) show the same ones. `device`: the switch for this
 * device, only on the member's own page (it needs this browser's permission). `pushOn`: pushes reach the member
 * somewhere, so the one-line summary applies. `them`: the wording for someone else's settings.
 */
export function NotificationSwitches({
  settings,
  canAssign,
  pushOn,
  device,
  them,
  pushSummaryOffOnly,
  onChange,
}: {
  settings: NotificationSettingsData
  canAssign: boolean
  pushOn: boolean
  device?: ReactNode
  them?: boolean
  /** The push summary can only be turned off (someone else's: what a call was about is theirs to put on a lock screen). */
  pushSummaryOffOnly?: boolean
  onChange: (change: NotificationChange) => void
}) {
  return (
    <div className="st-swlist">
      <SwitchRow
        title="Email for every call"
        aside={settings.own.email === null ? 'Team default' : undefined}
        on={settings.effective.email}
        onChange={email => onChange({ email })}
      />
      {canAssign && (
        <SwitchRow
          title={them ? 'Email when a call is assigned to them' : 'Email me when a call is assigned to me'}
          description={
            them
              ? 'When a teammate assigns them a call. Never for calls they take themselves.'
              : 'When a teammate assigns you a call. Never for calls you take yourself.'
          }
          on={settings.assignedEmail}
          onChange={assignedEmail => onChange({ assignedEmail })}
        />
      )}
      {settings.setupEmails !== null && (
        <SwitchRow
          title="Setup emails"
          description={`A few emails while ${them ? 'the' : 'your'} workspace gets set up, and a summary of its first week.`}
          on={settings.setupEmails}
          onChange={setupEmails => onChange({ setupEmails })}
        />
      )}
      {device}
      {pushOn && (
        <SwitchRow
          nested={!!device}
          title={them ? 'Push notifications say what the call was about' : 'Include what the call was about'}
          description={
            them
              ? 'Adds one line about the call to the notifications on their devices. It can show on a lock screen, so only they can turn it on.'
              : 'Adds one line about the call to these notifications. It can show on your lock screen.'
          }
          on={settings.push.summary}
          onChange={pushSummary => onChange({ pushSummary })}
          disabled={pushSummaryOffOnly && !settings.push.summary}
        />
      )}
    </div>
  )
}

function OwnNotifications({ settings }: { settings: NotificationSettingsData }) {
  const run = useRun()
  const canAssign = useCanAssign()
  const device = useDeviceNotifications(settings)
  // Someone in several workspaces changes another's notifications there.
  const several = (useWorkspaces()?.length ?? 1) > 1

  /** Applies at once on this page and in the browser-notification hook; the server gets it through the outbox. */
  function change(next: NotificationChange) {
    setNotificationSettings({ ...withChange(settings, next), changedBy: null })
    void run('notifications.update', next)
  }

  return (
    <>
      <NotificationSwitches
        settings={settings}
        canAssign={canAssign}
        pushOn={device.pushOn}
        onChange={change}
        device={
          <SwitchRow
            title="Notifications on this device"
            description={device.note}
            on={device.on}
            onChange={on => void device.set(on)}
            disabled={device.disabled}
            dimmed={device.disabled}
          />
        }
      />
      {settings.changedBy && <p className="help">{changedByLabel(settings.changedBy)}</p>}
      {several && <p className="help">Each workspace has its own. Switch workspace to change another's.</p>}
    </>
  )
}

/** Owners and admins: the email default for teammates who never changed theirs. Nothing for everyone else. */
export function NotificationDefaults({ toast }: { toast: (text: string) => void }) {
  const run = useRun()
  const settings = useNotificationQuery().data ?? null
  if (!settings?.canEditDefaults) return null

  function setDefaultEmail(current: NotificationSettingsData, on: boolean) {
    const defaults = { ...current.defaults, email: on }
    const effective = { ...current.effective, email: current.own.email ?? on }
    setNotificationSettings({ ...current, defaults, effective })
    void run('notifications.setDefaults', { email: on })
    toast('Team defaults saved.')
  }

  return (
    <Section id="st-notify-defaults" title="Team defaults" description="Notifications for teammates without their own.">
      <div className="st-swlist">
        <SwitchRow
          title="Email for every call"
          on={settings.defaults.email}
          onChange={on => setDefaultEmail(settings, on)}
        />
      </div>
      <p className="help">
        Your own notifications: <a href={OWN_NOTIFICATIONS_HASH}>Account settings › Notifications</a>
      </p>
    </Section>
  )
}
