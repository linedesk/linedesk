// Server side of a call's details (packages/actions/src/call-details.ts): the workspace's custom fields,
// their values on calls, what call.finish keeps of the summary's extraction, and the CSV export.
import {
  type CallExportData, coerceCustomValue, customFieldProblem, type CustomFieldUpsert, customValueText, EXPORT_MAX_CALLS, isE164,
  type LeadInput, MAX_CUSTOM_FIELDS, tagLabels, withoutNulls,
} from '@linedesk/actions'
import { addDays, zonedTimeToInstant } from '@linedesk/calendar'
import { calls, custom_fields, type Tx, workspace_settings } from '@linedesk/db'
import type { Call, CallTag, CustomField, CustomValue, CustomValues } from '@linedesk/db/types'
import { and, asc, desc, eq, gte, isNull, lt } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const DEFAULT_TIME_ZONE = 'America/New_York'

const workspaceOf = (actor: { workspaceId: string | null }) => {
  if (!actor.workspaceId) throw new Reject('no workspace')
  return actor.workspaceId
}

/** The workspace's custom fields in the order Settings shows them. */
export const customFieldsOf = (tx: Tx, workspaceId: string) =>
  tx.select().from(custom_fields).where(eq(custom_fields.workspace_id, workspaceId)).orderBy(asc(custom_fields.position), asc(custom_fields.created_at))

/** Values that fit their field, coerced; values of unknown fields and ones that do not fit are dropped (from the summary) or refused (from a person). */
export function checkedValues(fields: CustomField[], values: Record<string, CustomValue>, onProblem: (problem: string) => void): CustomValues {
  const byId = new Map(fields.map(f => [f.id, f]))
  const checked: CustomValues = {}
  for (const [id, value] of Object.entries(values)) {
    const field = byId.get(id)
    if (!field) {
      onProblem(`there is no custom field ${id}`)
      continue
    }
    const result = coerceCustomValue(field, value)
    if ('problem' in result) onProblem(result.problem)
    else checked[id] = result.value
  }
  return checked
}

type FinishInput = { callerName?: string; lead?: LeadInput; tag?: CallTag; customValues?: Record<string, CustomValue> }

/**
 * What call.finish writes of the lead, the tag and the custom values: what the team already set wins
 * (a repeated finish never overwrites an edit), then what the agent found. A phone call's callback
 * number is its caller ID unless the caller gave another one.
 */
export async function finishedDetails(tx: Tx, call: Call, input: FinishInput) {
  const lead = input.lead ?? {}
  const keep = (current: string | null, found: string | null | undefined) => current ?? (found?.trim() || null)
  const callerId = call.source === 'phone' && isE164(call.from_number) ? call.from_number : null
  const found = input.customValues ? checkedValues(await customFieldsOf(tx, call.workspace_id), input.customValues, () => {}) : {}
  return {
    caller_name: keep(call.caller_name, lead.callerName ?? input.callerName),
    callback_number: keep(call.callback_number, lead.callbackNumber) ?? callerId,
    address: keep(call.address, lead.address),
    job_type: keep(call.job_type, lead.jobType),
    tag: call.tag ?? input.tag ?? null,
    custom_values: { ...found, ...call.custom_values },
  }
}

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

/** The export as CSV: one row per call, a column per custom field (current ones only). */
export function callsCsv(rows: Call[], fields: CustomField[], timeZone: string): string {
  const header = [
    'Started', 'Duration (s)', 'From', 'Caller name', 'Callback number', 'Address', 'Job type', 'Urgency', 'Outcome', 'Tag',
    ...fields.map(f => f.label), 'Title', 'Summary', 'Next steps', 'Call ID',
  ]
  const lines = rows.map(c => csvRow([
    localStamp(c.started_at, timeZone), c.duration_sec, c.from_number, c.caller_name, c.callback_number, c.address, c.job_type,
    c.urgency, c.outcome, c.tag ? tagLabels[c.tag] : null,
    ...fields.map(f => customValueText(c.custom_values[f.id])), c.title, c.summary,
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

export const callDetailsHandlers: Record<string, Handler> = {
  'customField.upsert': async ({ tx, actor }, input: CustomFieldUpsert) => {
    const workspace_id = workspaceOf(actor)
    const problem = customFieldProblem(input)
    if (problem) throw new Reject(problem)
    const existing = await customFieldsOf(tx, workspace_id)
    const sameLabel = existing.find(f => f.label.toLowerCase() === input.label.toLowerCase() && f.id !== input.fieldId)
    if (sameLabel) throw new Reject(`There is already a field called ${sameLabel.label}`)
    const values = {
      label: input.label, type: input.type, options: input.type === 'choice' ? (input.options ?? []) : [],
      ...(input.askCaller !== undefined && { ask_caller: input.askCaller }),
      ...(input.instruction !== undefined && { instruction: input.instruction || null }),
    }
    if (!input.fieldId) {
      if (existing.length >= MAX_CUSTOM_FIELDS) throw new Reject(`A workspace can have at most ${MAX_CUSTOM_FIELDS} custom fields`)
      const position = Math.max(-1, ...existing.map(f => f.position)) + 1
      const rows = await tx.insert(custom_fields).values({ id: newId('cf'), workspace_id, position, ...values }).returning()
      return { rows: { custom_fields: rows }, data: { fieldId: rows[0]!.id } }
    }
    const rows = await tx.update(custom_fields).set(values)
      .where(and(eq(custom_fields.id, input.fieldId), eq(custom_fields.workspace_id, workspace_id))).returning()
    if (!rows[0]) throw new Reject('custom field not found')
    return { rows: { custom_fields: rows }, data: { fieldId: rows[0].id } }
  },

  'customField.delete': async ({ tx, actor }, input: { fieldId: string }) => {
    const workspace_id = workspaceOf(actor)
    const deleted = await tx.delete(custom_fields)
      .where(and(eq(custom_fields.id, input.fieldId), eq(custom_fields.workspace_id, workspace_id))).returning({ id: custom_fields.id })
    if (!deleted[0]) throw new Reject('custom field not found')
    return { rows: {}, deleted: { custom_fields: [input.fieldId] } }
  },

  'customField.list': async ({ tx, actor }) => {
    const fields = await customFieldsOf(tx, workspaceOf(actor))
    return {
      rows: {},
      data: { fields: fields.map(f => ({ id: f.id, label: f.label, type: f.type, options: f.options, ask_caller: f.ask_caller, instruction: f.instruction })) },
    }
  },

  // The patch's replace, as a merge: values not named stay. Each value must fit its field.
  'call.setCustomValues': async ({ tx, actor }, input: { callId: string; values: Record<string, CustomValue | null> }) => {
    const workspace_id = workspaceOf(actor)
    const [call] = await tx.select().from(calls).where(and(eq(calls.id, input.callId), eq(calls.workspace_id, workspace_id)))
    if (!call) throw new Reject('calls row not found')
    const problems: string[] = []
    const set = checkedValues(await customFieldsOf(tx, workspace_id), withoutNulls(input.values), p => problems.push(p))
    if (problems.length) throw new Reject(problems.join('; '))
    const cleared = new Set(Object.entries(input.values).filter(([, v]) => v === null).map(([id]) => id))
    const kept = Object.fromEntries(Object.entries(call.custom_values).filter(([id]) => !cleared.has(id)))
    const rows = await tx.update(calls).set({ custom_values: { ...kept, ...set } }).where(eq(calls.id, call.id)).returning()
    return { rows: { calls: rows } }
  },

  'call.export': async ({ tx, actor }, input: { from: string; to: string }) => {
    const workspace_id = workspaceOf(actor)
    const timeZone = await timeZoneOf(tx, workspace_id)
    const start = new Date(zonedTimeToInstant(input.from, '00:00', timeZone)).toISOString()
    const end = new Date(zonedTimeToInstant(addDays(input.to, 1), '00:00', timeZone)).toISOString()
    const rows = await tx.select().from(calls)
      .where(and(eq(calls.workspace_id, workspace_id), isNull(calls.deleted_at), gte(calls.started_at, start), lt(calls.started_at, end)))
      .orderBy(desc(calls.started_at)).limit(EXPORT_MAX_CALLS + 1)
    const truncated = rows.length > EXPORT_MAX_CALLS
    const exported = rows.slice(0, EXPORT_MAX_CALLS)
    const data: CallExportData = {
      csv: callsCsv(exported, await customFieldsOf(tx, workspace_id), timeZone),
      count: exported.length, truncated, filename: `calls-${input.from}-to-${input.to}.csv`,
    }
    return { rows: {}, data }
  },
}
