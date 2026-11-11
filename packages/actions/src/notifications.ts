// New-call notifications: an email per finished call (summary and a link) and a browser
// notification while the app is open. Each member sets their own; the workspace's defaults apply
// to members who never changed theirs. Stored in tables that are not synced, so no patch.
import { z } from 'zod'
import { defineAction } from './define.ts'

export type NotificationChannels = { email: boolean; browser: boolean }

/**
 * Web Push for the caller: `publicKey` is the server's VAPID key (null: push is not set up on this
 * install), `devices` the ids (pushDeviceId) of the browsers that get pushes in this workspace,
 * `summary` whether a push says what the call was about.
 */
export type PushSettings = { publicKey: string | null; devices: string[]; summary: boolean }

/** `data` of `notifications.get`: what applies to the caller, their own choices (null: the default), and the defaults. */
export type NotificationSettingsData = {
  effective: NotificationChannels
  own: { email: boolean | null; browser: boolean | null }
  defaults: NotificationChannels
  canEditDefaults: boolean
  push: PushSettings
  /** An email when a teammate assigns a call to you (on unless you turned it off). */
  assignedEmail: boolean
}

/** Until a workspace sets its own defaults: email and browser notifications are on. */
export const DEFAULT_NOTIFICATIONS: NotificationChannels = { email: true, browser: true }

export const notificationsGet = defineAction({
  name: 'notifications.get',
  description:
    'Read your new-call notification settings in this workspace (email per call, browser notifications) and the workspace defaults.',
  input: z.object({}),
  permission: 'call:read',
  readOnly: true,
})

// Every member may change their own settings (call:read is what every member role has); the
// handler only ever writes the caller's own row.
export const notificationsUpdate = defineAction({
  name: 'notifications.update',
  description: 'Change your own new-call notifications in this workspace. null goes back to the workspace default.',
  input: z.object({
    email: z.boolean().nullable().optional(),
    browser: z.boolean().nullable().optional(),
    /** Push notifications say what the call was about (one line), not only who called. */
    pushSummary: z.boolean().optional(),
    /** An email when a teammate assigns a call to you. */
    assignedEmail: z.boolean().optional(),
  }),
  permission: 'call:read',
})

export const notificationsSetDefaults = defineAction({
  name: 'notifications.setDefaults',
  description: "Set the workspace's default new-call notifications, for members who have not changed their own.",
  input: z.object({ email: z.boolean().optional(), browser: z.boolean().optional() }),
  permission: 'settings:write',
})

// Web Push (push notifications while Linedesk is closed). A browser's subscription is an endpoint at
// its push service plus two keys; whoever has them can send to that browser, so they are `sensitive`
// (never stored in the command log) and never returned. The browser recognises its own by pushDeviceId.
/** The browsers' push services (Chrome/Edge via FCM, Firefox, Safari, legacy Edge/Windows). */
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com']
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com']

/**
 * Whether a push endpoint goes to a known push service: https on the default port, no user info,
 * and the parsed hostname equal to one of PUSH_HOSTS or ending in one of the suffixes. Anything else
 * would let a member make the server send requests to an address of their choosing.
 */
export function isPushServiceUrl(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))
}

const pushEndpoint = z
  .string()
  .max(2048)
  .refine(isPushServiceUrl, 'not a push service endpoint (FCM, Mozilla, Apple or Windows push over https)')

export const pushSubscribe = defineAction({
  name: 'push.subscribe',
  description: 'Get push notifications for new calls in this workspace on this browser.',
  input: z.object({
    endpoint: pushEndpoint,
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(128) }),
  }),
  permission: 'call:read',
  sensitive: ['endpoint', 'keys'],
})

export const pushUnsubscribe = defineAction({
  name: 'push.unsubscribe',
  description:
    'Stop push notifications on this browser: in this workspace, or with `everywhere` in all of yours (sign-out).',
  input: z.object({ endpoint: pushEndpoint, everywhere: z.boolean().optional() }),
  permission: 'call:read',
  sensitive: ['endpoint'],
})

/** A browser's id among the caller's push devices: the start of the endpoint's SHA-256, so the endpoint itself never goes back. */
export async function pushDeviceId(endpoint: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('')
}
