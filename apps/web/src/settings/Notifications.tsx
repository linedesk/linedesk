// Settings, Notifications: your own new-call notifications (email per call, browser notifications
// while Linedesk is open) and, for owners and admins, the defaults for teammates who never changed theirs.
import type { NotificationChannels, NotificationSettingsData } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import {
  browserNotificationsSupported,
  setNotificationSettings,
  useNotificationQuery,
} from '../shell/useCallNotifications.ts'
import { useRun } from '../store.tsx'
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

const blockedText = 'Blocked by the browser. Allow notifications for this site, then turn this on again.'

export function Notifications({ toast }: { toast: (text: string) => void }) {
  const run = useRun()
  const query = useNotificationQuery()
  const settings = query.data ?? null
  const error = settings ? null : query.error
  const [browserNote, setBrowserNote] = useState<string | null>(null)
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

  const followsDefault = (channel: Channel) => (settings.own[channel] === null ? 'Team default' : undefined)
  return (
    <>
      <Section id="st-notify" title="Notifications" description="Only for you. Each teammate sets their own.">
        <div className="st-swlist">
          <SwitchRow
            title="Email for every call"
            description="The summary and a link, when a call ends."
            aside={followsDefault('email')}
            on={settings.effective.email}
            onChange={on => void setOwn('email', on)}
          />
          <SwitchRow
            title="Browser notifications"
            description={browserNote ?? 'While Linedesk is open in a background tab.'}
            aside={followsDefault('browser')}
            on={settings.effective.browser && !browserNote}
            onChange={on => void setOwn('browser', on)}
            disabled={!browserNotificationsSupported()}
          />
        </div>
      </Section>
      {settings.canEditDefaults && (
        <Section
          id="st-notify-defaults"
          title="Team defaults"
          description="For teammates who haven't changed their own."
        >
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
