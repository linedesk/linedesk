import { z } from 'zod'
import { defineAction } from './define.ts'

// Personal API keys (LIN-339, decision 2026-11-16): a key a person makes for themselves, for the `linedesk` CLI, MCP
// clients and scripts. It acts exactly as its maker does today: every workspace they belong to (x-workspace-id picks
// one), with their role there, and instance:admin when they are an instance admin and made the key in a session that
// passed the passkey check. The key is in the result of personalKey.create once and never again.

/** Every personal key starts with this, so a leaked one is easy to find (secret scanners, logs). */
export const PERSONAL_KEY_PREFIX = 'ldp_'

export const personalKeyCreate = defineAction({
  name: 'personalKey.create',
  description:
    'Create a personal API key for yourself: it can do what you can, in every workspace you belong to. The key is returned once.',
  input: z.object({ name: z.string().trim().min(1).max(60) }),
  permission: 'account:own',
  secretResult: true,
})

/** `data` of personalKey.create: `key` is shown once. */
export type PersonalKeyCreated = { personalKeyId: string; key: string; prefix: string }

export const personalKeyList = defineAction({
  name: 'personalKey.list',
  description: 'Your personal API keys: name, the first characters, when each was made and last used. Never the key.',
  input: z.object({}),
  permission: 'account:own',
  readOnly: true,
})

export type PersonalKeySummary = {
  id: string
  name: string
  prefix: string
  /** Made after the passkey check: carries Server admin while its maker is an instance admin. */
  passkey_confirmed: boolean
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}
export type PersonalKeyListData = { keys: PersonalKeySummary[] }

export const personalKeyRevoke = defineAction({
  name: 'personalKey.revoke',
  description: 'Revoke one of your personal API keys: it stops working at once.',
  input: z.object({ personalKeyId: z.string().min(1) }),
  permission: 'account:own',
})

/**
 * Actions that cannot be undone and are not public (so not marked `destructive`, which is for the public API): over a
 * personal key the CLI asks before each of these too (GET /v1/me/actions says destructive). MCP marks every write.
 */
export const IRREVERSIBLE_ACTIONS: ReadonlySet<string> = new Set([
  'workspace.delete',
  'workspace.deleteOwn',
  'user.disable',
  'instanceAdmin.revoke',
  'team.transferOwnership',
  'team.removeMember',
  'team.leave',
  'membership.remove',
  'phoneNumber.release',
  'assistant.delete',
  'webhook.delete',
  'calendar.disconnect',
  'appointmentType.delete',
])
