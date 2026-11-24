import { tableNames } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction } from './define.ts'

// The rows the web app reads through read sync (Electric), for the CLI, MCP clients and scripts with a personal key
// (LIN-339): the same tables, the same workspace filter and the same rules (deleted calls left out, webhook endpoints
// only for those who change settings). Paged by id.

export const RECORDS_MAX_LIMIT = 500

export const recordsList = defineAction({
  name: 'records.list',
  description:
    "Rows of one of the workspace's tables, as the web app reads them, ordered by id: pass `after` (the last id you got) for the next page. Narrow with `id` or `callId` (for transcript_segments, call_events and bookings).",
  input: z.object({
    table: z.enum(tableNames),
    id: z.string().min(1).optional(),
    callId: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(RECORDS_MAX_LIMIT).default(100),
  }),
  permission: 'call:read',
  readOnly: true,
})

export type RecordsListData = { rows: Record<string, unknown>[]; next: string | null }
