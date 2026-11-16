import type { AppErrorCode } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * Connected apps (docs/crm-sync.md): business tools a workspace connects by OAuth, so every finished
 * phone call goes to them. Same list as APP_IDS in @linedesk/connectors (the API checks they match).
 */
export const connectableApps = ['hubspot'] as const
export type ConnectableApp = (typeof connectableApps)[number]
const app = z.enum(connectableApps)

/**
 * Why connecting or disconnecting an app did not work: the `reason` of the OAuth callback's redirect and the `code`
 * of the actions' rejections. The page words each one (an unknown code gets the generic text), so no server text
 * reaches the page and nobody can put their own text into the redirect.
 */
export const appConnectErrors = [
  'denied',
  'signed_out',
  'expired',
  'not_yours',
  'scope',
  'no_grant',
  'not_set_up',
  'no_secrets_key',
  'not_connected',
  'failed',
] as const
export type AppConnectError = (typeof appConnectErrors)[number]
export const isAppConnectError = (value: unknown): value is AppConnectError =>
  (appConnectErrors as readonly unknown[]).includes(value)

export const appConnectStart = defineAction({
  name: 'app.connectStart',
  description: "Start connecting an app (HubSpot) to the workspace. Returns the URL of the app's consent page.",
  input: z.object({ app }),
  permission: 'settings:write',
})

/** `data` of app.connectStart. */
export type AppConnectStartData = { url: string }

export const appConnectFinish = defineAction({
  name: 'app.connectFinish',
  description: 'Finish connecting an app with the code it sent back. Run by the OAuth callback route.',
  input: z.object({ app, state: z.string().min(16).max(200), code: z.string().min(1).max(4000) }),
  permission: 'settings:write',
  sensitive: ['code', 'state'],
})

export const appDisconnect = defineAction({
  name: 'app.disconnect',
  description:
    'Disconnect an app: removes its tokens and links, withdraws the grant at the app, and stops sending calls to it.',
  input: z.object({ app }),
  permission: 'settings:write',
})

/** `data` of app.disconnect. revoked: the app confirmed it withdrew the grant. */
export type AppDisconnectData = { revoked: boolean }

/**
 * What Linedesk does in a connected app: switches a member turns on or off per connection (Integrations › HubSpot).
 * All on by default, so a connection behaves as before they existed; a connection stores only those changed.
 * - log_calls: every finished phone call goes to the app. Off: no call is sent (nor queued).
 * - create_contacts: a caller with no contact in the app gets one. Off: such a call is skipped (`no_contact`);
 *   callers who have a contact still get the call.
 * - fill_fields: empty fields of the caller's contact are filled from Linedesk. Off: an existing contact is never
 *   changed (a new one still gets the caller's name, number, email and company).
 */
export const appSettingIds = ['log_calls', 'create_contacts', 'fill_fields'] as const
export type AppSettingId = (typeof appSettingIds)[number]

/** The switches each app has, in the order the page shows them. */
export const APP_SETTINGS: Record<ConnectableApp, readonly AppSettingId[]> = {
  hubspot: ['log_calls', 'create_contacts', 'fill_fields'],
}

/** Whether a switch is on for a connection: its own choice, else on. */
export const appSettingOn = (stored: Readonly<Record<string, boolean>> | null | undefined, id: AppSettingId): boolean =>
  stored?.[id] ?? true

export const appUpdateSettings = defineAction({
  name: 'app.updateSettings',
  description:
    "Turn what Linedesk does in a connected app on or off. `id`: the connection (app_connections). `settings`: the switches to set, each true or false; a switch left out keeps its value. log_calls: send every finished phone call to the app; create_contacts: add a caller with no contact in the app as a new contact (off: such a call is skipped); fill_fields: fill empty fields of the caller's contact (off: an existing contact is never changed). All are on until changed.",
  input: z.object({
    id: z.string().min(1).max(100),
    settings: z
      .object({ log_calls: z.boolean(), create_contacts: z.boolean(), fill_fields: z.boolean() })
      .partial()
      .strict(),
  }),
  permission: 'settings:write',
  // Optimistic in the browser (the page sends every switch, so the row is whole); the handler checks the app has
  // these switches and merges them into what is stored.
  patch: {
    table: 'app_connections',
    id: input => input.id,
    set: input => ({ settings: input.settings as Record<string, boolean> }),
  },
})

export const appPushes = defineAction({
  name: 'app.pushes',
  description: 'The last calls sent to a connected app, newest first, with their state and the last failure.',
  input: z.object({ app, limit: z.number().int().min(1).max(50).default(20) }),
  permission: 'settings:write',
  readOnly: true,
})

/** One call sent (or being sent) to an app. */
export type AppPush = {
  id: string
  callId: string
  /** The caller as Linedesk shows them: the contact's name, else the number. */
  caller: string
  /** `sending` shows as pending: it is being sent now. `skipped`: the connection's settings said not to send it. */
  status: 'pending' | 'sending' | 'done' | 'failed' | 'skipped'
  attempts: number
  /** Why it failed, is being retried or was skipped; the page words it. */
  error: AppErrorCode | null
  createdAt: string
  finishedAt: string | null
}

/** `data` of app.pushes. */
export type AppPushesData = { pushes: AppPush[] }
