// The CSV export of a date range of calls (apps/api/src/call-export.ts).
import { z } from 'zod'
import { defineAction } from './define.ts'

/** The longest date range one export covers, and the most calls it holds. */
export const EXPORT_MAX_DAYS = 366
export const EXPORT_MAX_CALLS = 10_000
const day = z.iso.date()
const exportInput = z
  .object({
    from: day.describe('First day, YYYY-MM-DD, in the business time zone.'),
    to: day.describe('Last day, YYYY-MM-DD, in the business time zone (included).'),
  })
  .refine(i => i.from <= i.to, { message: 'The first day comes before the last', path: ['to'] })
  .refine(i => (Date.parse(i.to) - Date.parse(i.from)) / 86_400_000 < EXPORT_MAX_DAYS, {
    message: `An export covers at most ${EXPORT_MAX_DAYS} days`,
    path: ['to'],
  })
export const callExport = defineAction({
  name: 'call.export',
  description: `The calls of a date range as CSV: time, caller, number, urgency, outcome, title, summary and next steps. Owners and admins; at most ${EXPORT_MAX_CALLS} calls (\`truncated\` says when there were more).`,
  input: exportInput,
  permission: 'call:export',
  public: true,
  readOnly: true,
})
/** `data` of call.export. */
export type CallExportData = { csv: string; count: number; truncated: boolean; filename: string }
