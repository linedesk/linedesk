// Connect from the catalog line itself: one click on Connect opens the provider's sign-in (or, for a calendar that
// connects with a key, the key form), never the detail view first. The detail view is for what is connected: the
// callback brings the browser back there (#integrations/<app>, the mailbox page, the assistant's booking).
import {
  type AppConnectStartData,
  type ConnectableApp,
  type ConnectStartData,
  connectableApps,
  type MailConnectStartData,
} from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useEffect, useState } from 'react'
import { refreshOnReturn } from '../refreshOnReturn.ts'
import { useCalendarConnectWays } from '../settings/calendar-providers.ts'
import { isPasswordProvider, type KeyProviderId, type ProviderId } from '../settings/calendarModel.ts'
import { KeyConnectDialog } from '../settings/KeyConnect.tsx'
import { callAction } from '../settings/settings-api.ts'
import { connectErrorKey } from './ConnectedApp.tsx'
import { type IntegrationId, MAIL_CARD_PROVIDER, mailConnectErrorKey, nameKey } from './catalog.ts'
import { markFromIntegrations } from './fromIntegrations.tsx'

const CALENDARS: readonly ProviderId[] = ['google', 'microsoft', 'caldav', 'calcom', 'calendly']
/** Where the assistant's calendars are picked once an account is connected (the booking settings). */
const BOOKING = '#assistant/booking'

const isApp = (id: IntegrationId): id is ConnectableApp => (connectableApps as readonly string[]).includes(id)
const isMail = (id: IntegrationId): id is keyof typeof MAIL_CARD_PROVIDER => id in MAIL_CARD_PROVIDER
const isCalendar = (id: IntegrationId): id is ProviderId => (CALENDARS as readonly string[]).includes(id)

/** The `code` an action's rejection carries (settings-api.ts), which the page words itself. */
const codeOf = (e: unknown) => (e as { code?: unknown }).code

export type DirectConnect = {
  /** Whether a click on Connect starts the connect here (an app, a mailbox, a calendar). */
  can: (id: IntegrationId) => boolean
  start: (id: IntegrationId) => void
  /** The line whose sign-in is opening: its button shows it and every Connect waits. */
  opening: IntegrationId | null
  /** The key form of a calendar that connects with a key, while it is open. */
  dialog: ReactNode
}

export function useDirectConnect(canEdit: boolean, toast: (text: string) => void): DirectConnect {
  const t = useT()
  const ways = useCalendarConnectWays(canEdit)
  const [opening, setOpening] = useState<IntegrationId | null>(null)
  const [askKey, setAskKey] = useState<KeyProviderId | null>(null)
  // Back from the sign-in with the browser's Back button: the page comes from the back/forward cache with the button
  // still "Opening …". Start fresh.
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setOpening(null)
    }
    window.addEventListener('pageshow', reset)
    return () => window.removeEventListener('pageshow', reset)
  }, [])

  /** Asks the API for the sign-in address and goes there; the tables it writes show as loading on return. */
  async function open(
    id: IntegrationId,
    url: () => Promise<{ url: string }>,
    tables: Parameters<typeof refreshOnReturn>[0],
    fail: (e: unknown) => string,
  ) {
    setOpening(id)
    try {
      const target = (await url()).url
      refreshOnReturn(tables)
      window.location.assign(target)
    } catch (e) {
      toast(fail(e))
      setOpening(null)
    }
  }

  function start(id: IntegrationId) {
    if (opening) return
    if (isApp(id))
      return void open(
        id,
        () => callAction<AppConnectStartData>('app.connectStart', { app: id }),
        ['app_connections'],
        e => t(connectErrorKey(id, codeOf(e)), { name: t(nameKey(id)) }),
      )
    if (isMail(id)) {
      const provider = MAIL_CARD_PROVIDER[id]
      return void open(
        id,
        () => callAction<MailConnectStartData>('mail.connectStart', { provider }),
        ['mail_connections'],
        e => t(mailConnectErrorKey(codeOf(e)), { provider: t(nameKey(id)) }),
      )
    }
    if (isCalendar(id)) {
      if (isPasswordProvider(id) && ways?.ways[id] !== 'oauth') return setAskKey(id)
      // The sign-in comes back to the booking page: it shows the way back here.
      markFromIntegrations()
      return void open(
        id,
        () => callAction<ConnectStartData>('calendar.connectStart', { provider: id }),
        ['calendar_connections', 'assistant_calendars'],
        e => (e as Error).message,
      )
    }
  }

  const dialog = askKey && (
    <KeyConnectDialog
      provider={askKey}
      onClose={() => setAskKey(null)}
      onConnected={() => {
        setAskKey(null)
        toast(t('settings.calendar.connected'))
        markFromIntegrations()
        window.location.hash = BOOKING
      }}
    />
  )
  const can = (id: IntegrationId) =>
    canEdit && (isApp(id) || isMail(id) || (isCalendar(id) && (ways?.providers.includes(id) ?? false)))
  return { can, start, opening, dialog }
}
