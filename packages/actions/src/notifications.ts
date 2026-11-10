// New-call notifications: an email per finished call (summary and a link) and a browser
// notification while the app is open. Each member sets their own; the workspace's defaults apply
// to members who never changed theirs. Stored in tables that are not synced, so no patch.
import { z } from 'zod'
import { defineAction } from './define.ts'

export type NotificationChannels = { email: boolean; browser: boolean }

/** `data` of `notifications.get`: what applies to the caller, their own choices (null: the default), and the defaults. */
export type NotificationSettingsData = {
  effective: NotificationChannels
  own: { email: boolean | null; browser: boolean | null }
  defaults: NotificationChannels
  canEditDefaults: boolean
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
  input: z.object({ email: z.boolean().nullable().optional(), browser: z.boolean().nullable().optional() }),
  permission: 'call:read',
})

export const notificationsSetDefaults = defineAction({
  name: 'notifications.setDefaults',
  description: "Set the workspace's default new-call notifications, for members who have not changed their own.",
  input: z.object({ email: z.boolean().optional(), browser: z.boolean().optional() }),
  permission: 'settings:write',
})
