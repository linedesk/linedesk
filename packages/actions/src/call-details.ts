// What a call is about as data: the lead fields (who called, how to reach them, where, what job, how
// urgent), one tag, and the workspace's own custom fields. Filled after the call from the summary and
// the assistant's tools, edited by the team, exported as CSV and sent in webhooks.
import { type CallTag, callTags, type CustomField, type CustomValue, customFieldTypes } from '@linedesk/db/types'
import { z } from 'zod'
import { defineAction, type PatchSpec } from './define.ts'

export { callTags, customFieldTypes }

/** How each tag reads in the inbox, the call view and the CSV. */
export const tagLabels: Record<CallTag, string> = {
  new_lead: 'New lead',
  existing_customer: 'Existing customer',
  booked: 'Booked',
  message: 'Message',
  transferred: 'Transferred',
  wrong_number: 'Wrong number',
  spam: 'Spam',
}
export const callTag = z.enum(callTags)

/** A workspace has at most this many custom fields: each one makes calls longer when the assistant asks it. */
export const MAX_CUSTOM_FIELDS = 10
export const MAX_CHOICES = 12
const LEAD_TEXT_MAX = 200

const leadText = z.string().trim().max(LEAD_TEXT_MAX).nullable().optional()

/** The lead fields as the voice agent and the API take them; null clears one. */
export const leadInput = z.object({
  callerName: leadText,
  callbackNumber: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  jobType: leadText,
})
export type LeadInput = z.infer<typeof leadInput>

const callId = z.object({ callId: z.string().min(1) })
const emptyToNull = (value: string | null | undefined) => (value === undefined ? undefined : value?.trim() || null)

const updateLeadInput = callId.extend({ ...leadInput.shape, urgency: z.enum(['urgent', 'normal', 'low']).optional() })
export const callUpdateLead = defineAction({
  name: 'call.updateLead',
  description:
    "Correct a call's lead details: the caller's name, the number to call back, the address, the job type and the urgency. Fields left out stay as they are; null clears one.",
  input: updateLeadInput,
  permission: 'call:write',
  public: true,
  patch: {
    table: 'calls',
    id: i => i.callId,
    set: i => {
      const set: Record<string, unknown> = {}
      const text = {
        caller_name: i.callerName,
        callback_number: i.callbackNumber,
        address: i.address,
        job_type: i.jobType,
      }
      for (const [column, value] of Object.entries(text)) if (value !== undefined) set[column] = emptyToNull(value)
      if (i.urgency) set.urgency = i.urgency
      return set
    },
  } satisfies PatchSpec<z.infer<typeof updateLeadInput>, 'calls'>,
})

const setTagInput = callId.extend({ tag: callTag.nullable() })
export const callSetTag = defineAction({
  name: 'call.setTag',
  description: `Tag a call with what kind of call it was (${callTags.join(', ')}), or remove the tag with null.`,
  input: setTagInput,
  permission: 'call:write',
  public: true,
  patch: { table: 'calls', id: i => i.callId, set: i => ({ tag: i.tag }) } satisfies PatchSpec<
    z.infer<typeof setTagInput>,
    'calls'
  >,
})

const customValue = z.union([z.string().trim().max(LEAD_TEXT_MAX), z.number().finite(), z.boolean()])
const setCustomValuesInput = callId.extend({ values: z.record(z.string().min(1), customValue.nullable()) })
/**
 * The browser sends every value of the call, so the optimistic replace matches; the server merges, so
 * an API caller can send just the fields it changes.
 */
export const callSetCustomValues = defineAction({
  name: 'call.setCustomValues',
  description:
    "Set the values of the workspace's custom fields on a call, by field id (see customField.list). Fields left out keep their value; null clears one. Text and choice fields take text, number fields a number, yes/no fields true or false.",
  input: setCustomValuesInput,
  permission: 'call:write',
  public: true,
  patch: {
    table: 'calls',
    id: i => i.callId,
    set: i => ({ custom_values: withoutNulls(i.values) }),
  } satisfies PatchSpec<z.infer<typeof setCustomValuesInput>, 'calls'>,
})

export const withoutNulls = (values: Record<string, CustomValue | null>): Record<string, CustomValue> =>
  Object.fromEntries(Object.entries(values).filter((entry): entry is [string, CustomValue] => entry[1] !== null))

/**
 * The value as the field stores it, or a reason it does not fit. Lenient with what a language model or
 * a form sends: "42" for a number, "yes" for yes/no, a choice in other letter case.
 */
export function coerceCustomValue(
  field: Pick<CustomField, 'label' | 'type' | 'options'>,
  value: CustomValue,
): { value: CustomValue } | { problem: string } {
  const text = typeof value === 'string' ? value.trim() : String(value)
  if (field.type === 'text')
    return text ? { value: text.slice(0, LEAD_TEXT_MAX) } : { problem: `${field.label} is empty` }
  if (field.type === 'number') {
    const n = typeof value === 'number' ? value : Number(text.replace(/[,$\s]/g, ''))
    return text && Number.isFinite(n) ? { value: n } : { problem: `${field.label} takes a number` }
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return { value }
    if (/^(yes|y|true)$/i.test(text)) return { value: true }
    if (/^(no|n|false)$/i.test(text)) return { value: false }
    return { problem: `${field.label} takes yes or no` }
  }
  const choice = field.options.find(o => o.toLowerCase() === text.toLowerCase())
  return choice ? { value: choice } : { problem: `${field.label} takes one of: ${field.options.join(', ')}` }
}

/** A value as people read it (the call view, the CSV, a webhook's `display`). */
export const customValueText = (value: CustomValue | undefined) =>
  value === undefined ? '' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)

/** A custom field as call.start gives it to the voice agent. */
export type CallCustomField = Pick<CustomField, 'id' | 'label' | 'type' | 'options' | 'ask_caller' | 'instruction'>

// Settings: the workspace's custom fields.
const fieldLabel = z.string().trim().min(1).max(60)
const upsertInput = z.object({
  fieldId: z.string().min(1).optional(),
  label: fieldLabel,
  type: z.enum(customFieldTypes),
  options: z.array(z.string().trim().min(1).max(60)).max(MAX_CHOICES).optional(),
  askCaller: z.boolean().optional(),
  instruction: z.string().trim().max(300).nullable().optional(),
})
export type CustomFieldUpsert = z.infer<typeof upsertInput>
export const customFieldUpsert = defineAction({
  name: 'customField.upsert',
  description: `Add a custom field to the workspace's calls, or change one when its id is given. At most ${MAX_CUSTOM_FIELDS}. A choice field needs at least two options. With askCaller the assistant asks every caller for it.`,
  input: upsertInput,
  permission: 'settings:write',
})
export const customFieldDelete = defineAction({
  name: 'customField.delete',
  description: 'Remove a custom field. Calls keep their values, but they are no longer shown or exported.',
  input: z.object({ fieldId: z.string().min(1) }),
  permission: 'settings:write',
})
export const customFieldList = defineAction({
  name: 'customField.list',
  description:
    "The workspace's custom fields, in order: id, label, type, options, and whether the assistant asks callers for it.",
  input: z.object({}),
  permission: 'call:read',
  public: true,
  readOnly: true,
})

/** What a choice field's options must look like, or why not. */
export function customFieldProblem(input: Pick<CustomFieldUpsert, 'type' | 'options'>): string | null {
  const options = input.options ?? []
  if (input.type !== 'choice') return options.length ? 'Only a choice field has options' : null
  if (options.length < 2) return 'A choice field needs at least two options'
  const unique = new Set(options.map(o => o.toLowerCase()))
  return unique.size === options.length ? null : 'Each option can appear only once'
}

// Export.
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
  description: `The calls of a date range as CSV: time, caller, number, outcome, tag, lead details, custom fields, title and summary. Owners and admins; at most ${EXPORT_MAX_CALLS} calls (\`truncated\` says when there were more).`,
  input: exportInput,
  permission: 'call:export',
  public: true,
  readOnly: true,
})
/** `data` of call.export. */
export type CallExportData = { csv: string; count: number; truncated: boolean; filename: string }
