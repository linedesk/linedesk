// Settings, Notifications: your own new-call notifications (email per call, browser notifications
// while Linedesk is open) and, for owners and admins, the defaults for teammates who never changed theirs.
import type { NotificationChannels, NotificationSettingsData } from '@callfront/actions'
import { useEffect, useState } from 'react'
import {
  browserNotificationsSupported,
  notificationSettings,
  useNotificationSettings,
} from '../shell/useCallNotifications.ts'
import { useRun } from '../store.tsx'
import { Section, SwitchRow } from './fields.tsx'

type Channel = keyof NotificationChannels

/** What the browser allows: asks once when browser notifications are turned on. */
async function browserAllows(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!browserNotificationsSupported()) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  return (await Notification.requestPermission()) === 'granted' ? 'granted' : 'denied'
}

const blockedText =
  'Your browser blocks notifications for this site. Allow them in the site settings, then turn this on again.'

export function Notifications({ toast }: { toast: (text: string) => void }) {
  const run = useRun()
  const settings = useNotificationSettings()
  const [error, setError] = useState<string | null>(null)
  const [browserNote, setBrowserNote] = useState<string | null>(null)
  useEffect(() => {
    notificationSettings.load().catch((e: Error) => setError(e.message))
  }, [])
  useEffect(() => {
    if (!browserNotificationsSupported()) setBrowserNote('This browser cannot show notifications.')
    else if (Notification.permission === 'denied' && settings?.effective.browser) setBrowserNote(blockedText)
  }, [settings?.effective.browser])

  if (error)
    return (
      <Section id="st-notify" title="Notifications" description="New calls by email and in the browser.">
        <p className="help" role="alert">
          {error}
        </p>
      </Section>
    )
  if (!settings)
    return (
      <Section id="st-notify" title="Notifications" description="New calls by email and in the browser.">
        <p className="help">Loading…</p>
      </Section>
    )

  /** Applies at once on this page and in the browser-notification hook; the server gets it through the outbox. */
  function change(next: NotificationSettingsData) {
    notificationSettings.set(next)
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
    toast('Defaults saved. They apply to teammates who have not changed their own.')
  }

  const followsDefault = (channel: Channel) => (settings.own[channel] === null ? ' Workspace default.' : '')
  return (
    <Section id="st-notify" title="Notifications" description="For you. Each teammate sets their own.">
      <div className="st-swlist">
        <SwitchRow
          title="Email for every call"
          description={`One email when a call ends, with the summary and a link to the call.${followsDefault('email')}`}
          on={settings.effective.email}
          onChange={on => void setOwn('email', on)}
        />
        <SwitchRow
          title="Browser notifications"
          description={
            browserNote ??
            `While Linedesk is open in a tab in the background, a notification when a call ends.${followsDefault('browser')}`
          }
          on={settings.effective.browser && !browserNote}
          onChange={on => void setOwn('browser', on)}
          disabled={!browserNotificationsSupported()}
        />
      </div>
      {settings.canEditDefaults && (
        <div className="st-pt st-defaults">
          <b>Defaults for the team</b>
          <p className="help">For new teammates and everyone who has not changed their own.</p>
          <div className="st-swlist">
            <SwitchRow
              title="Email for every call"
              description="One email per call with the summary."
              on={settings.defaults.email}
              onChange={on => setDefault('email', on)}
            />
            <SwitchRow
              title="Browser notifications"
              description="While Linedesk is open in a background tab."
              on={settings.defaults.browser}
              onChange={on => setDefault('browser', on)}
            />
          </div>
        </div>
      )}
    </Section>
  )
}
