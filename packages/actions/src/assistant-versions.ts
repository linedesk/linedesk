// Versions of an assistant's call settings (Settings › Assistant › History). Every save that changes what
// callers get is stored as a whole copy (a snapshot): who saved it, when, and what changed in a few words.
// Save is live; an older version comes back by restoring it, which is saved as a new version.
import type { Assistant, AssistantCalendar } from '@linedesk/db/types'
import { z } from 'zod'
import { AI_DISCLOSURE_LABELS, BEHAVIOURS, behaviourOn, COMMUNICATION_STYLE_LABELS } from './assistant-prompt.ts'
import { defineAction } from './define.ts'
import { LANGUAGES, type Language, languageNames, mainLanguageOf, otherLanguagesOf } from './languages.ts'
import { silenceClosingOf, silenceReminderOf, TALKING_SPEED_LABELS } from './settings.ts'

/** The assistant's columns a version keeps: everything that changes a call. */
export const VERSIONED_FIELDS = [
  'name', 'greeting', 'greeting_outside', 'ai_disclosure', 'communication_style', 'behaviours',
  'business_profile', 'transfers', 'voice', 'languages',
  'silence_first_gap_s', 'silence_reminders', 'silence_hang_up_s', 'max_call_minutes', 'silence_reminder', 'silence_closing', 'record_calls', 'talking_speed',
] as const satisfies readonly (keyof Assistant)[]
export type VersionedField = (typeof VERSIONED_FIELDS)[number]

/** A calendar the assistant books into, as a version keeps it; matched to a linked one by account and calendar id. */
export type VersionCalendar = Pick<AssistantCalendar, 'connection_id' | 'external_id' | 'name' | 'instruction' | 'enabled' | 'is_default'>
export type AssistantSnapshot = Pick<Assistant, VersionedField> & { calendars: VersionCalendar[] }

export function snapshotOf(a: Assistant, calendars: readonly AssistantCalendar[]): AssistantSnapshot {
  const fields = Object.fromEntries(VERSIONED_FIELDS.map(k => [k, a[k] ?? null])) as Pick<Assistant, VersionedField>
  const kept = calendars
    .map(c => ({ connection_id: c.connection_id, external_id: c.external_id, name: c.name, instruction: c.instruction, enabled: c.enabled, is_default: c.is_default }))
    .sort((x, y) => `${x.connection_id}/${x.external_id}`.localeCompare(`${y.connection_id}/${y.external_id}`))
  return { ...fields, calendars: kept }
}

/** A saved version's settings without keys of fields that were removed since (e.g. `emergency_note`, `keypad_menu`, `greeting_known_caller`, `call_rules`). */
export function storedSnapshot(settings: unknown): AssistantSnapshot {
  const stored = settings as Record<string, unknown>
  const fields = Object.fromEntries(VERSIONED_FIELDS.filter(k => k in stored).map(k => [k, stored[k]]))
  return { ...fields, calendars: stored.calendars ?? [] } as AssistantSnapshot
}

/** JSON with object keys sorted: Postgres keeps jsonb keys in its own order, so plain JSON is no comparison. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const lines = (...parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join('\n')
const onOff = (on: boolean) => (on ? 'On' : 'Off')

/** One part of the settings as a person reads it: the History panel compares these texts line by line. */
export type VersionPart = { id: string; label: string; text: (s: AssistantSnapshot) => string }

export const VERSION_PARTS: readonly VersionPart[] = [
  { id: 'name', label: 'Name', text: s => s.name },
  { id: 'greeting', label: 'Greeting', text: s => s.greeting },
  { id: 'greeting_outside', label: 'Greeting outside business hours', text: s => s.greeting_outside || 'Same as during hours' },
  { id: 'ai_disclosure', label: 'Says it is an AI', text: s => AI_DISCLOSURE_LABELS[s.ai_disclosure] ?? s.ai_disclosure },
  { id: 'communication_style', label: 'Style', text: s => COMMUNICATION_STYLE_LABELS[s.communication_style] ?? s.communication_style },
  { id: 'behaviours', label: 'Checklist', text: s => BEHAVIOURS.map(b => `${onOff(behaviourOn(s.behaviours, b.id))}: ${b.label}`).join('\n') },
  {
    id: 'about',
    label: 'About the business',
    text: ({ business_profile: p }) =>
      lines(p.instructions, !p.instructions?.trim() && lines(p.description, p.service_area && `Service area: ${p.service_area}`, p.address && `Address: ${p.address}`, p.hours && `Hours: ${p.hours}`)) || 'Empty',
  },
  {
    id: 'transfers',
    label: 'Transfer contacts',
    text: s =>
      (s.transfers ?? [])
        .map(c => [c.name, c.number ?? 'no number', c.condition, c.hours_only && 'only while open', `rings ${c.ring_seconds} s`, `if no answer: ${NO_ANSWER[c.if_no_answer] ?? c.if_no_answer}`, !c.enabled && 'off'].filter(Boolean).join(' · '))
        .join('\n') || 'None',
  },
  { id: 'voice', label: 'Voice', text: s => `${s.voice.provider}${s.voice.voice_id ? ` · ${s.voice.voice_id}` : ' · default voice'}` },
  {
    id: 'languages',
    label: 'Languages',
    text: ({ languages: l }) => {
      const main = LANGUAGES[mainLanguageOf(l) as Language]
      if (l?.mode === 'any') return `${main} and every language it speaks`
      const others = otherLanguagesOf(l)
      return others.length ? `${main}, also ${languageNames(others)}` : `${main} only`
    },
  },
  {
    id: 'silence',
    label: 'Silence on the line',
    text: s => lines(`Asks every ${s.silence_first_gap_s} s, ${s.silence_reminders} times`, `Asks: ${silenceReminderOf(s.silence_reminder)}`),
  },
  {
    id: 'hang_up',
    label: 'Hanging up',
    text: s => lines(`After ${s.silence_hang_up_s ?? 'the default'} s of silence`, `Longest call: ${s.max_call_minutes ?? 'the default'} min`, `Says: ${silenceClosingOf(s.silence_closing)}`),
  },
  { id: 'talking_speed', label: 'Talking speed', text: s => TALKING_SPEED_LABELS[s.talking_speed] ?? 'Normal' },
  { id: 'record_calls', label: 'Recording', text: s => (s.record_calls ? 'Calls are recorded' : 'Calls are not recorded') },
  {
    id: 'calendars',
    label: 'Booking calendars',
    text: s =>
      (s.calendars ?? []).map(c => [c.name, c.is_default && 'default', c.instruction, !c.enabled && 'off'].filter(Boolean).join(' · ')).join('\n') || 'None',
  },
]

const NO_ANSWER: Record<string, string> = { message_urgent: 'urgent message', message: 'message', next: 'next contact' }

/** The parts that differ between two versions, in the order of the settings. */
export const changedParts = (before: AssistantSnapshot, after: AssistantSnapshot): VersionPart[] =>
  VERSION_PARTS.filter(p => p.text(before) !== p.text(after))

/** What a new version changed, in a few words: "Greeting, FAQs and Transfer contacts". */
export function versionSummary(before: AssistantSnapshot | null, after: AssistantSnapshot, restoredFrom?: number | null): string {
  if (restoredFrom) return `Restored version ${restoredFrom}`
  if (!before) return 'Settings as they were'
  const labels = changedParts(before, after).map(p => p.label)
  if (!labels.length) return 'No visible change'
  const shown = labels.length > 3 ? [...labels.slice(0, 3), `${labels.length - 3} more`] : labels
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** A line of a comparison: in both, only in the version (removed since), or only now (added since). */
export type DiffLine = { kind: 'same' | 'old' | 'new'; text: string }

/** Line by line, longest common subsequence: what a version had that is gone now, and what is new. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: 'old', text: a[i++]! })
    else out.push({ kind: 'new', text: b[j++]! })
  }
  return out
}

const assistantId = z.string().min(1)
const versionNumber = z.number().int().min(1)

export const assistantVersions = defineAction({
  name: 'assistant.versions',
  description: "List the assistant's saved versions, newest first: number, when, who, what changed. `current` is the version calls use now.",
  input: z.object({ assistantId }),
  permission: 'settings:write',
  readOnly: true,
})
/** One row of the History list. `by`: the user's name (or email); null when Linedesk wrote it. */
export type AssistantVersionItem = { number: number; summary: string; created_at: string; by: string | null; restored_from: number | null }
/** `data` of `assistant.versions`. */
export type AssistantVersionsData = { versions: AssistantVersionItem[]; current: number | null }

export const assistantVersion = defineAction({
  name: 'assistant.version',
  description: 'One saved version of the assistant with its settings, to compare with now.',
  input: z.object({ assistantId, number: versionNumber }),
  permission: 'settings:write',
  readOnly: true,
})
/** `data` of `assistant.version`. */
export type AssistantVersionData = { version: AssistantVersionItem & { settings: AssistantSnapshot } }

export const assistantRestoreVersion = defineAction({
  name: 'assistant.restoreVersion',
  description:
    "Bring back an earlier version of the assistant's settings; it is saved as a new version, so this can be undone the same way. Calendars of the version that are no longer connected are left out (named in `missingCalendars`); calendars added since are switched off.",
  input: z.object({ assistantId, number: versionNumber }),
  permission: 'settings:write',
})
/** `data` of `assistant.restoreVersion`: the new version's number and the calendars it could not bring back. */
export type AssistantRestoreData = { number: number; missingCalendars: string[] }
