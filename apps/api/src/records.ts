// records.list (LIN-339): the rows the web app reads through read sync, for personal keys (the CLI, MCP clients,
// scripts). The same tables and the same filter as GET /v1/shape (shapeFilter): the caller's workspace only, deleted
// calls left out, webhook endpoints only for those who change settings.
import { type RecordsListData, RECORDS_MAX_LIMIT } from '@linedesk/actions'
import { syncedTables } from '@linedesk/db'
import type { TableName } from '@linedesk/db/types'
import { and, asc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { type Handler, Reject } from './handler-context.ts'

/** Which rows of a table a member receives: their workspace's; webhook URLs (they can carry a token) only for owners and admins. */
export function shapeFilter(table: TableName, permissions: readonly string[]) {
  if (table === 'calls') return 'workspace_id = $1 AND deleted_at IS NULL'
  if (table === 'webhook_endpoints' && !permissions.includes('settings:write')) return 'workspace_id = $1 AND false'
  return 'workspace_id = $1'
}

/** shapeFilter as a query condition (kept in step with it by records.test.ts). */
function rowFilter(table: TableName, actor: Actor & { workspaceId: string }): SQL | undefined {
  const t = syncedTables[table] as unknown as Record<string, never>
  const inWorkspace = eq(t.workspace_id!, actor.workspaceId)
  if (table === 'calls') return and(inWorkspace, isNull(t.deleted_at!))
  if (table === 'webhook_endpoints' && !actor.permissions.includes('settings:write')) return sql`false`
  return inWorkspace
}

/** Tables whose rows belong to one call: `callId` narrows them. */
const PER_CALL: ReadonlySet<TableName> = new Set(['transcript_segments', 'call_events', 'bookings'])

/**
 * What a key from OAuth sign-in (a connector directory's AI client) may read: the bookings and what the booking tools
 * take (appointment types, the assistant's calendars). Calls and contacts it reads with their own tools; webhook URLs
 * (they can carry a token) and the rest stay with the app and keys made there (security review, LIN-126).
 */
export const OAUTH_RECORD_TABLES: ReadonlySet<TableName> = new Set([
  'bookings',
  'appointment_types',
  'assistant_calendars',
  'calendar_connections',
  'assistants',
])

type Input = { table: TableName; id?: string; callId?: string; after?: string; limit: number }

export const recordHandlers: Record<string, Handler> = {
  'records.list': async ({ tx, actor }, input: Input) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    if (actor.oauthKey && !OAUTH_RECORD_TABLES.has(input.table))
      throw new Reject(`over OAuth only ${[...OAUTH_RECORD_TABLES].join(', ')}`)
    if (input.callId && !PER_CALL.has(input.table)) throw new Reject(`callId only narrows ${[...PER_CALL].join(', ')}`)
    const t = syncedTables[input.table] as unknown as Record<string, never>
    const limit = Math.min(input.limit, RECORDS_MAX_LIMIT)
    const rows = (await tx
      .select()
      .from(syncedTables[input.table] as never)
      .where(
        and(
          rowFilter(input.table, { ...actor, workspaceId: actor.workspaceId }),
          input.id ? eq(t.id!, input.id) : undefined,
          input.callId ? eq(t.call_id!, input.callId) : undefined,
          input.after ? gt(t.id!, input.after) : undefined,
        ),
      )
      .orderBy(asc(t.id!))
      .limit(limit + 1)) as Record<string, unknown>[]
    const page = rows.slice(0, limit)
    const data: RecordsListData = { rows: page, next: rows.length > limit ? String(page.at(-1)!.id) : null }
    return { rows: {}, data }
  },
}
