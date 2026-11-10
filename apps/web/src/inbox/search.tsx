// Search (/) covers every call: caller, number, title, summary and transcript text.
import type { Call, Contact, TranscriptSegment } from '@callfront/db/types'
import type { ReactNode } from 'react'
import { callTitle, formatPhone } from '../inbox-model.ts'

export type SearchHit = { field: string; text: string; atMs?: number }

type Searchable = { call: Call; contact?: Contact; segments: TranscriptSegment[]; assistantName: string }

function speakerName(s: TranscriptSegment, callerLabel: string, assistantName: string): string {
  return s.speaker === 'caller' ? callerLabel : s.speaker === 'agent' ? assistantName : s.speaker === 'human' ? 'Team' : 'Event'
}

function textsOf({ call, contact, segments, assistantName }: Searchable): SearchHit[] {
  const caller = contact?.name || formatPhone(call.from_number)
  return [
    { field: 'Summary', text: call.summary ?? '' },
    { field: 'Topic', text: callTitle(call) },
    ...segments.map(s => ({ field: speakerName(s, caller, assistantName), text: s.text, atMs: s.at_ms })),
  ]
}

const has = (text: string, q: string) => text.toLowerCase().includes(q)
const normalize = (query: string) => query.trim().toLowerCase()

/** The first place the query appears in the call's content, or null. */
export function searchHit(item: Searchable, query: string): SearchHit | null {
  const q = normalize(query)
  return textsOf(item).find(t => has(t.text, q)) ?? null
}

export function matchesSearch(item: Searchable, query: string): boolean {
  const { call, contact } = item
  const who = [contact?.name, contact?.company, call.from_number, formatPhone(call.from_number)].filter(Boolean).join(' ')
  return has(who, normalize(query)) || searchHit(item, query) !== null
}

/** Wrap the first match in <mark>; with `max`, trim the text around the match. */
export function highlight(text: string, query: string | null, max?: number): ReactNode {
  const clip = (t: string) => (max && t.length > max ? `${t.slice(0, max)}…` : t)
  const q = query?.trim()
  if (!q) return clip(text)
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return clip(text)
  const from = max && text.length > max ? Math.max(0, i - Math.round(max * 0.3)) : 0
  const to = max && text.length > max ? Math.min(text.length, from + max) : text.length
  return <>{from > 0 ? '…' : ''}{text.slice(from, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length, to)}{to < text.length ? '…' : ''}</>
}
