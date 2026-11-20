// A person's profile picture (Account settings › Profile): shown wherever they appear (assignee chips and the assign
// picker, Workspace settings › Team, Server admin › Users). Stored like the workspace icon (workspace-icon.ts): a PNG
// of at most LOGO_SIZE square and LOGO_MAX_BYTES, made in the browser from any image (PNG, JPEG, WebP, SVG), so an SVG
// is drawn to pixels before it leaves the browser and the server only ever stores and serves a checked PNG. Without one
// the initials show. It belongs to the account, not to a workspace: every workspace the person is in shows the same
// picture (workspace_members.avatar_version).
import { msg } from '@linedesk/i18n'
import { z } from 'zod'
import { LOGO_MAX_BYTES } from './branding.ts'
import { defineAction } from './define.ts'

const AVATAR_PREFIX = 'data:image/png;base64,'

/** Where a person's picture is served; `version` changes with every new picture, so it is cached for good. */
export const avatarPath = (userId: string, version: string) =>
  `/v1/avatars/${encodeURIComponent(userId)}.png?v=${encodeURIComponent(version)}`

/** The picture's address from a version (workspace_members.avatar_version); null without a picture. */
export const avatarUrlOf = (userId: string, version: string | null | undefined) =>
  version ? avatarPath(userId, version) : null

/** What account.setAvatar answers with, and what /v1/me carries: the picture's address, null without one. */
export type UserAvatarData = { avatarUrl: string | null }

// Account actions, not workspace settings: every member may change their own picture, so the permission is one
// every team role has (as starPrompt.answer). The voice agent has none of them; an impersonating admin is refused
// by run-action (impersonation-guard.ts allows only inbox triage).
export const accountSetAvatar = defineAction({
  name: 'account.setAvatar',
  description:
    'Set your own profile picture, shown wherever you appear (assigned calls, the team list): `avatar` is a PNG as a data URL ("data:image/png;base64,…"), at most 512×512 pixels and 512 KB; square works best. Answers with `avatarUrl`.',
  input: z.object({
    avatar: z
      .string()
      .startsWith(AVATAR_PREFIX, msg('server.input.pictureNotPng'))
      .max(AVATAR_PREFIX.length + Math.ceil(LOGO_MAX_BYTES / 3) * 4),
  }),
  permission: 'call:read',
  // Not a secret, but up to half a megabyte: the command log notes that a picture was sent, not the image.
  sensitive: ['avatar'],
})

export const accountRemoveAvatar = defineAction({
  name: 'account.removeAvatar',
  description: 'Remove your own profile picture: your initials show again.',
  input: z.object({}),
  permission: 'call:read',
})
