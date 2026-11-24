// Only server admins create workspaces (apps/api/src/workspace-creation.ts): their way to create one for a business and
// give it an owner (Server admin › Workspaces › New workspace), or one of their own (the app's New workspace,
// POST /v1/workspaces, and the setup MCP's workspace_create). The one path for every new workspace. Self-serve creation
// comes with billing (postponed).
import { z } from 'zod'
import { defineAction } from './define.ts'
import { workspaceName } from './settings.ts'
import { countryHintSchema, workspaceCountrySchema } from './workspace-locale.ts'

/**
 * A server admin creates a workspace for a business with its assistant and settings, and gives it an owner: an
 * existing account with a confirmed address becomes its owner at once; a new address (an account is made for it) or
 * an unconfirmed one gets an owner invitation and becomes the owner once they confirm it, like Add user. The admin
 * does not join the workspace. Without `owner` the admin makes one of their own: they become its owner at once (no
 * invitation) and it becomes their active workspace.
 */
export const workspaceCreate = defineAction({
  name: 'workspace.create',
  description:
    'Create a workspace for a business with its assistant, and give it an owner by email. An existing account with a confirmed address becomes the owner at once; anyone else gets an email and becomes the owner once they confirm their address (name: for a new account). You do not join it. Without owner, you become its owner and it becomes your active workspace. country: where the business is (ISO 3166-1 alpha-2, e.g. US or DE); it sets the defaults for phone numbers, holidays and the call language. Without it the country is worked out (Automatic).',
  input: z.object({
    name: workspaceName,
    timeZone: z.string().max(64).optional(),
    /** Where the business is; saved as set. Left out: Automatic (workspace-locale.ts). */
    country: workspaceCountrySchema.optional(),
    /**
     * What the app prefilled the country with and where that came from (countryHintOf); saved as the workspace's
     * country hint. Left out: worked out from the time zone (and, through POST /v1/workspaces, the sign-up location).
     */
    countryHint: countryHintSchema.optional(),
    owner: z
      .object({
        email: z.email().max(254),
        name: z.string().trim().min(1).max(80).optional(),
      })
      .optional(),
  }),
  permission: 'instance:admin',
})
/** What `workspace.create` did. `owner.joined`: `added` is the owner now; `invited` becomes it with the emailed link. */
export type WorkspaceCreateData = {
  workspace: { id: string; name: string }
  owner: { userId: string; email: string; existing: boolean; joined: 'added' | 'invited' }
}
