import { z } from 'zod'
import { defineAction } from './define.ts'

// API keys of a workspace, for its own integrations: Bearer on /v1/actions/<name>, the read
// endpoints and MCP. The key is in the result of apiKey.create once and never again.

/** Every key starts with this, so a leaked one is easy to find (secret scanners, logs). */
export const API_KEY_PREFIX = 'ld_'

export const apiKeyRole = z.enum(['member', 'admin'])

export const apiKeyCreate = defineAction({
  name: 'apiKey.create',
  description: 'Create an API key for the workspace, with a member\'s or an admin\'s permissions. The key is returned once.',
  input: z.object({ name: z.string().trim().min(1).max(60), role: apiKeyRole.default('member') }),
  permission: 'settings:write',
  secretResult: true,
})

/** `data` of apiKey.create: `key` is shown once. */
export type ApiKeyCreated = { apiKeyId: string; key: string; prefix: string }

export const apiKeyList = defineAction({
  name: 'apiKey.list',
  description: "The workspace's API keys: name, role, the key's first characters, when it was created and last used. Never the key.",
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})

export type ApiKeySummary = {
  id: string; name: string; prefix: string; role: 'member' | 'admin'; created_by: string; created_at: string
  last_used_at: string | null; revoked_at: string | null
  /** Made while an instance admin was signed in as `created_by` (support access): the list says so. */
  created_during_support: boolean
  /** That admin's name (else their address), for "Created by … during support access"; null otherwise or once the account is gone. */
  created_during_support_by: string | null
}
export type ApiKeyListData = { keys: ApiKeySummary[] }

export const apiKeyRevoke = defineAction({
  name: 'apiKey.revoke',
  description: 'Revoke an API key: it stops working at once.',
  input: z.object({ apiKeyId: z.string().min(1) }),
  permission: 'settings:write',
})
