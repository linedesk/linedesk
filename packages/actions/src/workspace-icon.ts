// The workspace's icon (Workspace settings › General): a logo or image shown on the workspace button, in the
// workspace menu and switcher, and as the browser-tab icon while the workspace is open. Without one the initial
// letter of the name shows. Stored like the install logo of Server admin › Branding (branding.ts): a PNG of at most
// LOGO_SIZE square and LOGO_MAX_BYTES, made in the browser from any image (PNG, JPEG, WebP, SVG), so an SVG is
// drawn to pixels before it leaves the browser and the server only ever stores and serves a checked PNG.
import { msg } from '@linedesk/i18n'
import { z } from 'zod'
import { LOGO_MAX_BYTES } from './branding.ts'
import { defineAction } from './define.ts'

const ICON_PREFIX = 'data:image/png;base64,'

/** What workspace.setIcon answers with, and what the workspace lists carry: the icon's address, null without one. */
export type WorkspaceIconData = { iconUrl: string | null }

export const workspaceSetIcon = defineAction({
  name: 'workspace.setIcon',
  description:
    'Set the workspace icon (the logo on the workspace button, in the workspace menu and as the browser-tab icon): `icon` is a PNG as a data URL ("data:image/png;base64,…"), at most 512×512 pixels and 512 KB; square works best. Convert other formats (JPEG, WebP, SVG) to PNG first. Answers with `iconUrl`.',
  input: z.object({
    icon: z
      .string()
      .startsWith(ICON_PREFIX, msg('server.input.iconNotPng'))
      .max(ICON_PREFIX.length + Math.ceil(LOGO_MAX_BYTES / 3) * 4),
  }),
  permission: 'settings:write',
  // Not a secret, but up to half a megabyte: the command log notes that an icon was sent, not the image.
  sensitive: ['icon'],
})

export const workspaceRemoveIcon = defineAction({
  name: 'workspace.removeIcon',
  description: 'Remove the workspace icon: the workspace button and menu show the initial of its name again.',
  input: z.object({}),
  permission: 'settings:write',
})
