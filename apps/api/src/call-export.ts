// Server side of call.export (packages/actions/src/call-export.ts): the calls of a date range as CSV.
import { type CallExportData, EXPORT_MAX_CALLS } from '@linedesk/actions'
import { addDays, zonedTimeToInstant } from '@linedesk/calendar'
import { calls, contacts, type Tx, workspace_settings } from '@linedesk/db'
import type { Call } from '@linedesk/db/types'
import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

const DEFAULT_TIME_ZONE = 'America/New_York'

// --- CSV ---------------------------------------------------------------------------------------

/** One CSV cell: quoted when needed; text a spreadsheet would run as a formula gets a leading apostrophe. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  // "+1 503…" and "-12" stay numbers; "=HYPERLINK(…)", "@SUM", "+cmd|…" do not run.
  if (/^[=@\t\r]/.test(text) || /^[+-](?![\d\s().]*$)/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const csvRow = (cells: (string | number | null | undefined)[]) => cells.map(csvCell).join(',')

const localStamp = (iso: string, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/** A call as the export lists it: with its contact's name. */
export type ExportedCall = Call & { callerName: string | null }

/** The export as CSV: one row per call. */
export function callsCsv(rows: ExportedCall[], timeZone: string): string {
  const header = ['Started', 'Duration (s)', 'From', 'Caller', 'Urgency', 'Outcome', 'Title', 'Summary', 'Next steps', 'Call ID']
  const lines = rows.map(c => csvRow([
    localStamp(c.started_at, timeZone), c.duration_sec, c.from_number, c.callerName, c.urgency, c.outcome, c.title, c.summary,
    c.action_items.map(item => item.text).join('; '), c.id,
  ]))
  // A byte order mark, so Excel opens the UTF-8 file with the right characters.
  return `﻿${[csvRow(header), ...lines].join('\r\n')}\r\n`
}

async function timeZoneOf(tx: Tx, workspaceId: string) {
  const [settings] = await tx.select({ timezone: workspace_settings.timezone }).from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  return settings?.timezone ?? DEFAULT_TIME_ZONE
}

// --- Handlers ----------------------------------------------------------------------------------

export const callExportHandlers: Record<string, Handler> = {
  'call.export': async ({ tx, actor }, input: { from: string; to: string }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspace_id = actor.workspaceId
    const timeZone = await timeZoneOf(tx, workspace_id)
    const start = new Date(zonedTimeToInstant(input.from, '00:00', timeZone)).toISOString()
    const end = new Date(zonedTimeToInstant(addDays(input.to, 1), '00:00', timeZone)).toISOString()
    const found = await tx.select({ call: calls, callerName: contacts.name }).from(calls)
      .leftJoin(contacts, eq(contacts.id, calls.contact_id))
      .where(and(eq(calls.workspace_id, workspace_id), isNull(calls.deleted_at), gte(calls.started_at, start), lt(calls.started_at, end)))
      .orderBy(desc(calls.started_at)).limit(EXPORT_MAX_CALLS + 1)
    const rows = found.map(r => ({ ...r.call, callerName: r.callerName }))
    const truncated = rows.length > EXPORT_MAX_CALLS
    const exported = rows.slice(0, EXPORT_MAX_CALLS)
    const data: CallExportData = {
      csv: callsCsv(exported, timeZone),
      count: exported.length, truncated, filename: `calls-${input.from}-to-${input.to}.csv`,
    }
    return { rows: {}, data }
  },
}
