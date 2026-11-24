// The CSV export of a date range of calls (apps/api/src/call-export.ts).
import { msg } from '@linedesk/i18n'
import { z } from 'zod'
import { defineAction } from './define.ts'

/** The longest date range one export covers (ten years: Insights exports everything since the first call), and the most calls it holds. */
export const EXPORT_MAX_DAYS = 3660
export const EXPORT_MAX_CALLS = 10_000
const day = z.iso.date()
const exportInput = z
  .object({
    from: day.describe('First day, YYYY-MM-DD, in the business time zone.'),
    to: day.describe('Last day, YYYY-MM-DD, in the business time zone (included).'),
    format: z
      .enum(['csv', 'table'])
      .default('csv')
      .describe('csv: the file as text (default); table: the same header and cells as lists, for a spreadsheet.'),
  })
  .refine(i => i.from <= i.to, { message: msg('server.input.firstDayBeforeLast'), path: ['to'] })
  .refine(i => (Date.parse(i.to) - Date.parse(i.from)) / 86_400_000 < EXPORT_MAX_DAYS, {
    message: msg('server.input.exportTooLong'),
    params: { days: EXPORT_MAX_DAYS },
    path: ['to'],
  })
export const callExport = defineAction({
  name: 'call.export',
  description: `The calls of a date range as CSV (or, with format table, as header and rows): time, caller, number, urgency, outcome, title, summary and next steps. Owners and admins; at most ${EXPORT_MAX_CALLS} calls (\`truncated\` says when there were more).`,
  input: exportInput,
  permission: 'call:export',
  public: true,
  readOnly: true,
})
/** One cell of the table: text, a number, or empty. */
export type ExportCell = string | number | null
/** `data` of call.export: `csv` for the csv format, `table` for the table format. */
export type CallExportData = {
  csv?: string
  table?: { header: string[]; rows: ExportCell[][] }
  count: number
  truncated: boolean
  /** The file name without its extension's choice: `.csv` for csv; replace it for another format. */
  filename: string
}
