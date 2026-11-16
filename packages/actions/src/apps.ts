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
  /** `sending` shows as pending: it is being sent now. */
  status: 'pending' | 'sending' | 'done' | 'failed'
  attempts: number
  /** Why it failed or is being retried; the page words it. */
  error: AppErrorCode | null
  createdAt: string
  finishedAt: string | null
}

/** `data` of app.pushes. */
export type AppPushesData = { pushes: AppPush[] }
