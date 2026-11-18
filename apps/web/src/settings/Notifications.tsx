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
import { sectionHash } from '../ui/SettingsLayout.tsx'
import { FollowsLine, Section, SkeletonSwitchRows, SwitchRow } from './fields.tsx'
import { permissionText, useNotificationPermission } from './notificationPermission.ts'
import { T, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { i18n } from '../i18n/index.tsx'
import { useSupportAccess } from '../supportAccess.ts'

/** Your own notifications, linked from the team defaults (Workspace settings › Team). */
export const OWN_NOTIFICATIONS_HASH = '#account/notifications'

const blockedText = () => i18n().t('account.notify.blocked')

/** Why push cannot be turned on here, or null when it can. */
export function pushBlocker(publicKey: string | null): string | null {
  const support = pushSupport()
  if (support === 'ios-needs-install') return i18n().t('account.notify.iosInstall', { brand: brandName() })
  if (support === 'unsupported') return i18n().t('account.notify.pushUnsupported')
  if (!publicKey) return i18n().t('account.notify.pushNotSetUp')
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
    if (subscription === 'denied') return { id: null, note: blockedText() }
    const id = await thisDeviceId()
    if (id)
      setNotificationSettings({
        ...settings,
        push: { ...settings.push, devices: [...settings.push.devices.filter(d => d !== id), id] },
      })
    void run('push.subscribe', subscription)
    return { id, note: null }
  } catch (e) {
    return {
      id: null,
      note: i18n().t('account.notify.pushFailed', { reason: e instanceof Error ? e.message : String(e) }),
    }
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
  const t = useT()
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
    setBusyNote(t('account.notify.turningOn'))
    const result = await turnOnPush(settings, run)
    setBusyNote(result.note)
    if (result.id) device.setId(result.id)
  }

  const fallback =
    pushSupport() === 'supported'
      ? t('account.notify.whileOpenNoPush', { brand: brandName() })
      : t('account.notify.whileOpenNoBrowser', { brand: brandName() })
  const note = unavailable
    ? permissionText(permission)
    : (busyNote ?? (viaPush ? t('account.notify.push', { brand: brandName() }) : fallback))
  return { on, disabled: unavailable, note, set, pushOn: viaPush && on, id: device.id }
}

/** `workspaceName`: the workspace these settings are for; each workspace has its own. */
export function Notifications({ workspaceName }: { workspaceName: string }) {
  const t = useT()
  const query = useNotificationQuery()
  const settings = query.data ?? null
  const error = settings ? null : query.error
  const description = t('account.notify.description', { workspace: workspaceName })
  if (settings) return <OwnNotifications settings={settings} description={description} />
  return (
    <Section id="st-notify" title={t('account.nav.notifications.label')} description={description}>
      <Loading
        what={t('account.notify.what')}
        loading
        error={error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonSwitchRows rows={2} />}
      >
        {null}
      </Loading>
    </Section>
  )
}

/** The settings a member keeps per workspace that NotificationSwitches changes. */
export type NotificationChange = {
  /** null: back to the team default. */
  email?: boolean | null
  assignedEmail?: boolean
  setupEmails?: boolean
  pushSummary?: boolean
}

/** `settings` with `change` applied, as the page shows it before the server answers. */
export function withChange(settings: NotificationSettingsData, change: NotificationChange): NotificationSettingsData {
  const { email, assignedEmail, setupEmails, pushSummary } = change
  return {
    ...settings,
    ...(email === undefined
      ? {}
      : {
          own: { ...settings.own, email },
          effective: { ...settings.effective, email: email ?? settings.defaults.email },
        }),
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
  teamLink,
  onChange,
}: {
  settings: NotificationSettingsData
  canAssign: boolean
  pushOn: boolean
  device?: ReactNode
  them?: boolean
  /** The push summary can only be turned off (someone else's: what a call was about is theirs to put on a lock screen). */
  pushSummaryOffOnly?: boolean
  /** Where the team default is set, when the viewer can open it there (owners and admins, not inside the Team page). */
  teamLink?: string | null
  onChange: (change: NotificationChange) => void
}) {
  const t = useT()
  return (
    <div className="st-swlist">
      <SwitchRow
        title={t('account.notify.emailEveryCall')}
        note={
          <FollowsLine
            inline
            source={{ kind: 'team' }}
            follows={settings.own.email === null}
            sourceDefault={settings.defaults.email ? 'on' : 'off'}
            link={teamLink}
            onReset={() => onChange({ email: null })}
          />
        }
        on={settings.effective.email}
        onChange={email => onChange({ email })}
      />
      {canAssign && (
        <SwitchRow
          title={them ? t('account.notify.assignedThem') : t('account.notify.assignedMe')}
          description={them ? t('account.notify.assignedThemDescription') : t('account.notify.assignedMeDescription')}
          on={settings.assignedEmail}
          onChange={assignedEmail => onChange({ assignedEmail })}
        />
      )}
      {settings.setupEmails !== null && (
        <SwitchRow
          title={t('account.notify.setupEmails')}
          description={them ? t('account.notify.setupEmailsThem') : t('account.notify.setupEmailsMe')}
          on={settings.setupEmails}
          onChange={setupEmails => onChange({ setupEmails })}
        />
      )}
      {device}
      {pushOn && (
        <SwitchRow
          nested={!!device}
          title={them ? t('account.notify.summaryThem') : t('account.notify.summaryMe')}
          description={them ? t('account.notify.summaryThemDescription') : t('account.notify.summaryMeDescription')}
          on={settings.push.summary}
          onChange={pushSummary => onChange({ pushSummary })}
          disabled={pushSummaryOffOnly && !settings.push.summary}
        />
      )}
    </div>
  )
}

function OwnNotifications({ settings, description }: { settings: NotificationSettingsData; description: string }) {
  const t = useT()
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
      {/* No sentence above the switches repeating what they say (UI cleanup S8): the switches are the summary. */}
      <Section id="st-notify" title={t('account.nav.notifications.label')} description={description}>
        <NotificationSwitches
          settings={settings}
          teamLink={settings.canEditDefaults ? sectionHash('workspace', 'team') : null}
          canAssign={canAssign}
          pushOn={device.pushOn}
          onChange={change}
          device={
            <SwitchRow
              title={t('account.notify.thisDevice')}
              description={device.note}
              on={device.on}
              onChange={on => void device.set(on)}
              disabled={device.disabled}
              dimmed={device.disabled}
            />
          }
        />
        {settings.changedBy && <p className="help">{changedByLabel(settings.changedBy)}</p>}
        {several && <p className="help">{t('account.notify.perWorkspace')}</p>}
      </Section>
    </>
  )
}

/** Owners and admins: the email default for teammates who never changed theirs. Nothing for everyone else. */
export function NotificationDefaults({ toast }: { toast: (text: string) => void }) {
  const t = useT()
  const run = useRun()
  const settings = useNotificationQuery().data ?? null
  // The team's defaults are the workspace's settings: not changed during support access.
  const supportAccess = useSupportAccess()
  if (!settings?.canEditDefaults || supportAccess) return null

  function setDefaultEmail(current: NotificationSettingsData, on: boolean) {
    const defaults = { ...current.defaults, email: on }
    const effective = { ...current.effective, email: current.own.email ?? on }
    setNotificationSettings({ ...current, defaults, effective })
    void run('notifications.setDefaults', { email: on })
    toast(t('account.notify.defaultsSaved'))
  }

  return (
    <Section
      id="st-notify-defaults"
      title={t('account.notify.defaults')}
      description={t('account.notify.defaultsDescription')}
    >
      <div className="st-swlist">
        <SwitchRow
          title={t('account.notify.emailEveryCall')}
          on={settings.defaults.email}
          onChange={on => setDefaultEmail(settings, on)}
        />
      </div>
      <p className="help">
        <T k="account.notify.ownLink" values={{ link: appLink(OWN_NOTIFICATIONS_HASH) }} />
      </p>
    </Section>
  )
}
